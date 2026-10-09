const fs = require('node:fs');
const path = require('node:path');
const { openDatabase, migrate, immediateTransaction } = require('../common/sqlite');
const { randomId, sha256Buffer, hmac } = require('../common/ids');
const { nowIso, addMs } = require('../common/time');

const TERMINAL_STATUSES = new Set(['submitted', 'outcome_unknown', 'failed', 'cancelled']);

// 单调执行阶段：只允许同级刷新或前进，禁止回退
const PHASE_RANK = { claimed: 1, downloading: 2, uploading: 3, ready_to_submit: 4 };

function isAllowedProgressTransition(from, to) {
  if (TERMINAL_STATUSES.has(from) || from === 'submitting') return false;
  if (to === 'needs_user_action') return from in PHASE_RANK || from === 'needs_user_action';
  if (!(to in PHASE_RANK)) return false;
  if (from === 'needs_user_action') return to === 'uploading' || to === 'ready_to_submit';
  return PHASE_RANK[to] >= PHASE_RANK[from];
}

function json(value) { return JSON.stringify(value ?? null); }
function parseJson(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

class MockBackendStore {
  constructor({ databasePath, storageDir, publicBaseUrl }) {
    this.db = openDatabase(databasePath);
    this.storageDir = storageDir || path.join(path.dirname(databasePath), 'materials');
    this.publicBaseUrl = publicBaseUrl;
    this.secret = process.env.MOCK_BACKEND_SECRET || randomId('mocksecret', 24);
    fs.mkdirSync(this.storageDir, { recursive: true });
    migrate(this.db, [{ version: 1, up: db => this.createSchema(db) }]);
  }

  createSchema(db) {
    db.exec(`
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  login_name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  token_hash TEXT NOT NULL UNIQUE,
  assistant_version TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_devices_user ON devices(user_id, status);
CREATE TABLE binding_codes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  poll_token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','consumed','expired')),
  device_id TEXT REFERENCES devices(id),
  requested_device_name TEXT NOT NULL,
  pending_device_token TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_at TEXT
);
CREATE TABLE platform_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  platform TEXT NOT NULL,
  account_key TEXT NOT NULL,
  nickname TEXT NOT NULL,
  platform_identity TEXT,
  status TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  last_check_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, device_id, platform, account_key)
);
CREATE INDEX idx_platform_accounts_user ON platform_accounts(user_id, platform);
CREATE TABLE materials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_materials_user ON materials(user_id);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  account_id TEXT NOT NULL REFERENCES platform_accounts(id),
  platform TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  topics_json TEXT NOT NULL,
  cover_ref TEXT,
  material_id TEXT NOT NULL REFERENCES materials(id),
  content_version TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','claimed','downloading','uploading','ready_to_submit','submitting','submitted','needs_user_action','outcome_unknown','failed','cancelled')),
  progress INTEGER NOT NULL DEFAULT 0,
  attempt_id TEXT,
  lease_expires_at TEXT,
  submission_intent_at TEXT,
  submission_intent_hash TEXT,
  submit_token_hash TEXT,
  submit_token_expires_at TEXT,
  submit_authorized_at TEXT,
  result_json TEXT,
  error_json TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(user_id, idempotency_key)
);
CREATE INDEX idx_tasks_claim ON tasks(device_id, status, created_at);
CREATE INDEX idx_tasks_user ON tasks(user_id, created_at);
CREATE TABLE task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  actor TEXT NOT NULL,
  event TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_task_events_task ON task_events(task_id, created_at);
CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  attempt_id TEXT NOT NULL,
  report_key TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(task_id, attempt_id, report_key)
);
`);
  }

  seedDemoData() {
    const now = nowIso();
    const users = [
      { id: 'user_demo_a', login: 'demo-a', name: '模拟用户 A', token: 'sim-user-a-token' },
      { id: 'user_demo_b', login: 'demo-b', name: '模拟用户 B', token: 'sim-user-b-token' }
    ];
    for (const user of users) {
      this.db.prepare(`INSERT INTO users (id, login_name, display_name, token_hash, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(login_name) DO UPDATE SET display_name=excluded.display_name`)
        .run(user.id, user.login, user.name, sha256Buffer(Buffer.from(user.token)), now);
    }
    return users.map(({ token, ...rest }) => rest);
  }

  getUserByToken(token) {
    if (!token) return null;
    return this.db.prepare('SELECT * FROM users WHERE token_hash = ?').get(sha256Buffer(Buffer.from(token)));
  }

  createBinding({ deviceName, assistantVersion }) {
    const id = randomId('bind');
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const pollToken = randomId('poll', 24);
    const expiresAt = addMs(10 * 60 * 1000);
    this.db.prepare(`INSERT INTO binding_codes (id, code, poll_token_hash, status, requested_device_name, expires_at, created_at)
      VALUES (?, ?, ?, 'pending', ?, ?, ?)`)
      .run(id, code, sha256Buffer(Buffer.from(pollToken)), deviceName, expiresAt, nowIso());
    return { id, code, pollToken, expiresAt, confirmPath: `/console?binding_id=${encodeURIComponent(id)}` };
  }

  getBinding(id) { return this.db.prepare('SELECT * FROM binding_codes WHERE id = ?').get(id); }

  confirmBinding({ bindingId, code, userId }) {
    return immediateTransaction(this.db, () => {
      const binding = this.getBinding(bindingId);
      if (!binding) return { ok: false, status: 404, code: 'binding_not_found', message: '绑定申请不存在' };
      if (binding.status !== 'pending') return { ok: false, status: 409, code: 'binding_not_pending', message: '绑定码已使用或失效' };
      if (Date.parse(binding.expires_at) <= Date.now()) {
        this.db.prepare(`UPDATE binding_codes SET status='expired' WHERE id=?`).run(bindingId);
        return { ok: false, status: 410, code: 'binding_expired', message: '绑定码已过期' };
      }
      if (binding.attempts >= 5) return { ok: false, status: 429, code: 'too_many_attempts', message: '绑定码尝试次数过多' };
      if (binding.code !== String(code || '').trim()) {
        this.db.prepare('UPDATE binding_codes SET attempts = attempts + 1 WHERE id = ?').run(bindingId);
        return { ok: false, status: 403, code: 'binding_code_mismatch', message: '绑定码不正确' };
      }
      const deviceId = randomId('dev');
      const deviceToken = randomId('devtoken', 32);
      this.db.prepare(`INSERT INTO devices (id, user_id, name, status, token_hash, created_at)
        VALUES (?, ?, ?, 'active', ?, ?)`)
        .run(deviceId, userId, binding.requested_device_name, sha256Buffer(Buffer.from(deviceToken)), nowIso());
      this.db.prepare(`UPDATE binding_codes SET status='approved', device_id=?, pending_device_token=?, approved_at=? WHERE id=?`)
        .run(deviceId, deviceToken, nowIso(), bindingId);
      return { ok: true, deviceId };
    });
  }

  consumeBindingToken({ bindingId, pollToken }) {
    return immediateTransaction(this.db, () => {
      const binding = this.getBinding(bindingId);
      if (!binding) return { status: 'not_found' };
      if (binding.poll_token_hash !== sha256Buffer(Buffer.from(pollToken || ''))) return { status: 'unauthorized' };
      if (binding.status === 'pending') return { status: Date.parse(binding.expires_at) <= Date.now() ? 'expired' : 'pending' };
      if (binding.status !== 'approved') return { status: binding.status };
      const deviceToken = binding.pending_device_token;
      this.db.prepare(`UPDATE binding_codes SET status='consumed', pending_device_token=NULL WHERE id=?`).run(bindingId);
      const device = this.db.prepare('SELECT user_id FROM devices WHERE id=?').get(binding.device_id);
      return { status: 'approved', deviceId: binding.device_id, deviceToken, userId: device ? device.user_id : null };
    });
  }

  getDeviceByToken(token) {
    if (!token) return null;
    return this.db.prepare(`SELECT * FROM devices WHERE token_hash = ? AND status='active'`).get(sha256Buffer(Buffer.from(token)));
  }

  listDevices(userId) {
    return this.db.prepare('SELECT id,user_id,name,status,assistant_version,last_seen_at,created_at,revoked_at FROM devices WHERE user_id=? ORDER BY created_at DESC').all(userId);
  }

  revokeDevice({ deviceId, userId }) {
    const result = this.db.prepare(`UPDATE devices SET status='revoked', revoked_at=? WHERE id=? AND user_id=? AND status='active'`).run(nowIso(), deviceId, userId);
    return result.changes > 0;
  }

  heartbeat({ deviceId, assistantVersion }) {
    this.db.prepare('UPDATE devices SET last_seen_at=?, assistant_version=COALESCE(?, assistant_version) WHERE id=?').run(nowIso(), assistantVersion || null, deviceId);
  }

  syncAccounts({ device, accounts }) {
    const now = nowIso();
    const mapped = [];
    return immediateTransaction(this.db, () => {
      for (const account of accounts) {
        const existing = this.db.prepare(`SELECT * FROM platform_accounts WHERE user_id=? AND device_id=? AND platform=? AND account_key=?`)
          .get(device.user_id, device.id, account.platform, account.account_key);
        if (existing) {
          this.db.prepare(`UPDATE platform_accounts SET nickname=?, platform_identity=?, status=?, capabilities_json=?, last_check_at=?, updated_at=? WHERE id=?`)
            .run(account.nickname, account.platform_identity || null, account.status || 'unknown', json(account.capabilities || {}), account.last_check_at || now, now, existing.id);
          mapped.push({ account_key: account.account_key, account_id: existing.id });
        } else {
          const id = randomId('acct');
          this.db.prepare(`INSERT INTO platform_accounts (id,user_id,device_id,platform,account_key,nickname,platform_identity,status,capabilities_json,last_check_at,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(id, device.user_id, device.id, account.platform, account.account_key, account.nickname, account.platform_identity || null, account.status || 'unknown', json(account.capabilities || {}), account.last_check_at || now, now, now);
          mapped.push({ account_key: account.account_key, account_id: id });
        }
      }
      return mapped;
    });
  }

  listAccounts(userId) {
    return this.db.prepare('SELECT * FROM platform_accounts WHERE user_id=? ORDER BY platform,nickname').all(userId)
      .map(row => ({ ...row, capabilities: parseJson(row.capabilities_json, {}), capabilities_json: undefined }));
  }

  createMaterial({ userId, filename, contentType, buffer }) {
    const id = randomId('mat');
    const sha256 = sha256Buffer(buffer);
    const userDir = path.join(this.storageDir, userId);
    fs.mkdirSync(userDir, { recursive: true });
    const filePath = path.join(userDir, `${id}.bin`);
    fs.writeFileSync(filePath, buffer, { mode: 0o600 });
    this.db.prepare(`INSERT INTO materials (id,user_id,filename,content_type,bytes,sha256,storage_path,created_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, userId, filename, contentType, buffer.length, sha256, filePath, nowIso());
    return this.getMaterial(id);
  }

  getMaterial(id) { return this.db.prepare('SELECT * FROM materials WHERE id=?').get(id); }
  listMaterials(userId) { return this.db.prepare('SELECT id,user_id,filename,content_type,bytes,sha256,created_at FROM materials WHERE user_id=? ORDER BY created_at DESC').all(userId); }

  materialAccessToken(material, expiresInMs = 10 * 60 * 1000) {
    const expires = String(Date.now() + expiresInMs);
    return `${material.id}.${expires}.${hmac(this.secret, `${material.id}.${material.user_id}.${expires}`)}`;
  }

  verifyMaterialAccessToken(material, token) {
    const parts = String(token || '').split('.');
    if (parts.length < 3) return false;
    const [id, expires, sig] = [parts[0], parts[1], parts.slice(2).join('.')];
    if (id !== material.id || Number(expires) <= Date.now()) return false;
    return hmac(this.secret, `${material.id}.${material.user_id}.${expires}`) === sig;
  }

  materialDownloadUrl(material) {
    return `${this.publicBaseUrl}/api/v1/materials/${encodeURIComponent(material.id)}/download?access_token=${encodeURIComponent(this.materialAccessToken(material))}`;
  }

  createTask({ userId, deviceId, accountId, platform, title, description, topics, coverRef, materialId, idempotencyKey }) {
    const existing = this.db.prepare('SELECT * FROM tasks WHERE user_id=? AND idempotency_key=?').get(userId, idempotencyKey);
    if (existing) return { task: this.decorateTask(existing), created: false };
    const id = randomId('task');
    const now = nowIso();
    const contentVersion = sha256Buffer(Buffer.from(JSON.stringify({ title, description, topics, coverRef, materialId, accountId, platform })));
    this.db.prepare(`INSERT INTO tasks (id,user_id,device_id,account_id,platform,title,description,topics_json,cover_ref,material_id,content_version,idempotency_key,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'queued', ?, ?)`)
      .run(id, userId, deviceId, accountId, platform, title, description, json(topics), coverRef || null, materialId, contentVersion, idempotencyKey, now, now);
    this.addTaskEvent(id, 'user', 'created', { content_version: contentVersion });
    return { task: this.decorateTask(this.getTask(id)), created: true };
  }

  getTask(id) { return this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id); }

  decorateTask(row) {
    if (!row) return null;
    return {
      ...row,
      topics: parseJson(row.topics_json, []),
      result: parseJson(row.result_json, null),
      error: parseJson(row.error_json, null),
      topics_json: undefined,
      result_json: undefined,
      error_json: undefined
    };
  }

  listTasksForUser(userId, status) {
    const rows = status
      ? this.db.prepare('SELECT * FROM tasks WHERE user_id=? AND status=? ORDER BY created_at DESC').all(userId, status)
      : this.db.prepare('SELECT * FROM tasks WHERE user_id=? ORDER BY created_at DESC').all(userId);
    return rows.map(row => this.decorateTask(row));
  }

  listTasksForDevice(deviceId) {
    return this.db.prepare('SELECT * FROM tasks WHERE device_id=? ORDER BY created_at DESC').all(deviceId).map(row => this.decorateTask(row));
  }

  claimTask(device) {
    return immediateTransaction(this.db, () => {
      const row = this.db.prepare(`SELECT * FROM tasks
        WHERE device_id=? AND user_id=? AND status='queued' AND cancel_requested=0
        ORDER BY created_at ASC LIMIT 1`).get(device.id, device.user_id);
      if (!row) return null;
      const attemptId = randomId('attempt', 16);
      const lease = addMs(60 * 1000);
      const changed = this.db.prepare(`UPDATE tasks SET status='claimed', attempt_id=?, lease_expires_at=?, progress=5, updated_at=?
        WHERE id=? AND status='queued'`).run(attemptId, lease, nowIso(), row.id);
      if (changed.changes !== 1) return null;
      const claimed = this.getTask(row.id);
      const material = this.getMaterial(row.material_id);
      this.addTaskEvent(row.id, 'device', 'claimed', { attempt_id: attemptId });
      const decorated = this.decorateTask(claimed);
      decorated.material_download_url = this.materialDownloadUrl(material);
      decorated.material_sha256 = material.sha256;
      decorated.material_filename = material.filename;
      decorated.material_content_type = material.content_type;
      return decorated;
    });
  }

  requireTaskForDevice(taskId, device, attemptId) {
    const task = this.getTask(taskId);
    if (!task || task.user_id !== device.user_id || task.device_id !== device.id) return { error: 'not_found' };
    if (attemptId && task.attempt_id !== attemptId) return { error: 'attempt_mismatch', task };
    return { task };
  }

  renewLease({ taskId, device, attemptId, manualHold = false }) {
    const { task, error } = this.requireTaskForDevice(taskId, device, attemptId);
    if (error) return { ok: false, code: error };
    if (TERMINAL_STATUSES.has(task.status)) return { ok: false, code: 'task_terminal' };
    const lease = addMs(manualHold ? 15 * 60 * 1000 : 60 * 1000);
    this.db.prepare('UPDATE tasks SET lease_expires_at=?, updated_at=? WHERE id=?').run(lease, nowIso(), taskId);
    this.addTaskEvent(taskId, 'device', 'lease_renewed', { attempt_id: attemptId, manual_hold: manualHold });
    return { ok: true, lease_expires_at: lease };
  }

  updateProgress({ taskId, device, attemptId, status, progress, message, error }) {
    const { task, error: lookupError } = this.requireTaskForDevice(taskId, device, attemptId);
    if (lookupError) return { ok: false, code: lookupError };
    if (TERMINAL_STATUSES.has(task.status)) return { ok: false, code: 'task_terminal' };
    if (!isAllowedProgressTransition(task.status, status)) {
      return { ok: false, code: 'invalid_transition', message: `不允许的状态转换：${task.status} -> ${status}` };
    }
    this.db.prepare('UPDATE tasks SET status=?, progress=?, error_json=?, updated_at=? WHERE id=?')
      .run(status, Math.max(0, Math.min(100, Number(progress) || 0)), json(error || null), nowIso(), taskId);
    this.addTaskEvent(taskId, 'device', 'progress', { attempt_id: attemptId, status, progress, message });
    return { ok: true, task: this.decorateTask(this.getTask(taskId)) };
  }

  saveSubmissionIntent({ taskId, device, attemptId, contentVersion, accountId }) {
    const { task, error } = this.requireTaskForDevice(taskId, device, attemptId);
    if (error) return { ok: false, code: error };
    if (!['ready_to_submit', 'uploading'].includes(task.status)) return { ok: false, code: 'invalid_state' };
    if (task.content_version !== contentVersion || task.account_id !== accountId) return { ok: false, code: 'content_mismatch' };
    this.db.prepare('UPDATE tasks SET submission_intent_at=?, submission_intent_hash=?, updated_at=? WHERE id=?')
      .run(nowIso(), sha256Buffer(Buffer.from(JSON.stringify({ taskId, attemptId, contentVersion, accountId }))), nowIso(), taskId);
    this.addTaskEvent(taskId, 'device', 'submission_intent_saved', { attempt_id: attemptId });
    return { ok: true };
  }

  authorizeSubmit({ taskId, device, attemptId, contentVersion }) {
    return immediateTransaction(this.db, () => {
      const { task, error } = this.requireTaskForDevice(taskId, device, attemptId);
      if (error) return { ok: false, status: 404, code: error, message: '任务或执行实例无效' };
      if (task.cancel_requested) return { ok: false, status: 409, code: 'task_cancelled', message: '任务已取消' };
      if (task.content_version !== contentVersion) return { ok: false, status: 409, code: 'content_mismatch', message: '任务内容版本已变化' };
      if (!task.submission_intent_at) return { ok: false, status: 409, code: 'submission_intent_missing', message: '尚未保存提交意图' };
      if (Date.parse(task.lease_expires_at || 0) <= Date.now()) return { ok: false, status: 409, code: 'lease_expired', message: '任务租约已过期' };
      if (task.submit_authorized_at) {
        return { ok: false, status: 409, code: 'submit_already_authorized', message: '提交授权已发放；每个执行实例仅授权一次，授权过期或中断后不得再次发布，请走结果核实' };
      }
      if (task.status !== 'ready_to_submit') return { ok: false, status: 409, code: 'invalid_state', message: `当前状态不允许提交：${task.status}` };
      const submitToken = randomId('submit', 24);
      const expires = addMs(30 * 1000);
      this.db.prepare(`UPDATE tasks SET status='submitting', submit_token_hash=?, submit_token_expires_at=?, submit_authorized_at=?, updated_at=? WHERE id=?`)
        .run(sha256Buffer(Buffer.from(submitToken)), expires, nowIso(), nowIso(), taskId);
      this.addTaskEvent(taskId, 'device', 'submit_authorized', { attempt_id: attemptId });
      return { ok: true, submitToken, submitTokenExpiresAt: expires };
    });
  }

  verifySubmitToken(task, submitToken) {
    if (!task.submit_token_hash || !submitToken) return false;
    if (Date.parse(task.submit_token_expires_at || 0) <= Date.now()) return false;
    return task.submit_token_hash === sha256Buffer(Buffer.from(submitToken));
  }

  reportResult({ taskId, device, attemptId, reportKey, outcome, evidence, error, submitToken }) {
    return immediateTransaction(this.db, () => {
      const { task, error: lookupError } = this.requireTaskForDevice(taskId, device, attemptId);
      if (lookupError) return { ok: false, status: lookupError === 'attempt_mismatch' ? 409 : 404, code: lookupError, message: '任务归属或执行实例不匹配' };
      const statusMap = { submitted: 'submitted', failed: 'failed', outcome_unknown: 'outcome_unknown', cancelled: 'cancelled' };
      const status = statusMap[outcome];
      if (!status) return { ok: false, status: 400, code: 'invalid_outcome', message: '结果类型无效' };
      const result = {
        outcome,
        evidence: evidence || {},
        error: error || null,
        reported_at: nowIso(),
        note: outcome === 'submitted' ? '平台已接收或适配器确认提交，不等于公开发布成功' : undefined
      };
      const existing = this.db.prepare('SELECT * FROM reports WHERE task_id=? AND attempt_id=? AND report_key=?').get(taskId, attemptId, reportKey);
      if (existing) {
        const original = parseJson(existing.result_json, {});
        if (original.outcome !== outcome || JSON.stringify(original.evidence || {}) !== JSON.stringify(result.evidence) || JSON.stringify(original.error || null) !== JSON.stringify(result.error)) {
          return { ok: false, status: 409, code: 'report_conflict', message: '相同 report_key 的结果内容与首次上报不一致' };
        }
        return { ok: true, duplicate: true, report: existing };
      }
      if (TERMINAL_STATUSES.has(task.status)) {
        return { ok: false, status: 409, code: 'task_terminal', message: '任务已进入终态，设备结果不能覆盖；结果变更只能走人工核实流程' };
      }
      if (outcome === 'submitted') {
        if (task.status !== 'submitting' || !this.verifySubmitToken(task, submitToken)) {
          return { ok: false, status: 409, code: 'submit_token_invalid', message: '提交授权无效、已过期或任务不在提交阶段' };
        }
      } else if (task.status === 'submitting' && task.submit_token_hash) {
        const tokenValid = this.verifySubmitToken(task, submitToken);
        const tokenExpired = Date.parse(task.submit_token_expires_at || 0) <= Date.now();
        if (!tokenValid && !tokenExpired) {
          return { ok: false, status: 409, code: 'submit_token_invalid', message: '提交阶段上报结果需要有效提交令牌；客户端中断恢复请等待令牌过期后重试' };
        }
      }
      this.db.prepare('INSERT INTO reports (id,task_id,attempt_id,report_key,result_json,created_at) VALUES (?,?,?,?,?,?)')
        .run(randomId('report'), taskId, attemptId, reportKey, json(result), nowIso());
      this.db.prepare('UPDATE tasks SET status=?, progress=?, result_json=?, error_json=?, updated_at=?, completed_at=? WHERE id=?')
        .run(status, outcome === 'submitted' ? 100 : task.progress, json(result), json(error || null), nowIso(), nowIso(), taskId);
      this.addTaskEvent(taskId, 'device', 'result_reported', { attempt_id: attemptId, outcome });
      return { ok: true, duplicate: false, task: this.decorateTask(this.getTask(taskId)) };
    });
  }

  cancelTask({ taskId, userId }) {
    const task = this.getTask(taskId);
    if (!task || task.user_id !== userId) return { ok: false, status: 404, code: 'not_found', message: '任务不存在' };
    if (TERMINAL_STATUSES.has(task.status)) return { ok: false, status: 409, code: 'task_terminal', message: '任务已结束' };
    if (task.status === 'submitting') return { ok: false, status: 409, code: 'already_submitting', message: '任务已进入提交阶段，不能取消，请走结果核实' };
    this.db.prepare(`UPDATE tasks SET cancel_requested=1,status='cancelled',updated_at=?,completed_at=? WHERE id=?`).run(nowIso(), nowIso(), taskId);
    this.addTaskEvent(taskId, 'user', 'cancelled', {});
    return { ok: true, task: this.decorateTask(this.getTask(taskId)) };
  }

  reviewUnknownTask({ taskId, userId, outcome, note }) {
    const task = this.getTask(taskId);
    if (!task || task.user_id !== userId) return { ok: false, status: 404, code: 'not_found', message: '任务不存在' };
    if (task.status !== 'outcome_unknown') return { ok: false, status: 409, code: 'invalid_state', message: '仅结果待核实任务可人工确认' };
    const finalStatus = outcome === 'submitted' ? 'submitted' : 'failed';
    const result = { ...(parseJson(task.result_json, {}) || {}), reviewed: true, review_note: note || '', reviewed_at: nowIso() };
    this.db.prepare('UPDATE tasks SET status=?, result_json=?, updated_at=? WHERE id=?').run(finalStatus, json(result), nowIso(), taskId);
    this.addTaskEvent(taskId, 'user', 'outcome_reviewed', { outcome: finalStatus });
    return { ok: true, task: this.decorateTask(this.getTask(taskId)) };
  }

  listTaskEvents(taskId, userId) {
    const task = this.getTask(taskId);
    if (!task || task.user_id !== userId) return null;
    return this.db.prepare('SELECT * FROM task_events WHERE task_id=? ORDER BY created_at ASC').all(taskId)
      .map(row => ({ ...row, data: parseJson(row.data_json, {}), data_json: undefined }));
  }

  addTaskEvent(taskId, actor, event, data) {
    this.db.prepare('INSERT INTO task_events (id,task_id,actor,event,data_json,created_at) VALUES (?,?,?,?,?,?)')
      .run(randomId('evt'), taskId, actor, event, json(data || {}), nowIso());
  }
}

module.exports = { MockBackendStore, TERMINAL_STATUSES };