const fs = require('node:fs');
const path = require('node:path');
const { openDatabase, migrate, immediateTransaction } = require('../common/sqlite');
const { randomId, assertSafeId, sha256Buffer } = require('../common/ids');
const { nowIso } = require('../common/time');
const { protectText, unprotectText } = require('../common/dpapi');
const { newAccountProfileDir } = require('../common/paths');

function json(value) { return JSON.stringify(value ?? null); }
function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function subjectKeyFor(serviceUrl, userId) {
  if (!userId) return null;
  let normalized = String(serviceUrl || '').trim();
  try {
    const url = new URL(normalized);
    normalized = `${url.protocol}//${url.hostname.toLowerCase()}${url.port === '' ? '' : `:${url.port}`}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    normalized = normalized.toLowerCase().replace(/\/+$/, '');
  }
  return sha256Buffer(Buffer.from(`${normalized}|${userId}`)).slice(0, 24);
}

function legacySubjectKeyFor(serviceUrl, userId) {
  if (!userId) return null;
  return sha256Buffer(Buffer.from(`${serviceUrl}|${userId}`)).slice(0, 24);
}

class LocalStore {
  constructor({ dataDir, secretProtector }) {
    this.secretProtector = secretProtector || { protect: protectText, unprotect: unprotectText };
    this.dataDir = path.resolve(dataDir);
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.profilesDir = path.join(this.dataDir, 'profiles');
    fs.mkdirSync(this.profilesDir, { recursive: true, mode: 0o700 });
    this.db = openDatabase(path.join(this.dataDir, 'assistant.db'));
    migrate(this.db, [
      { version: 1, up: db => this.createSchema(db) },
      { version: 2, up: db => this.migrateSubjectKeys(db) },
      { version: 3, up: db => this.migrateOutbox(db) },
      { version: 4, up: db => this.migrateInteractions(db) },
      { version: 5, up: db => this.migrateInteractionCloudId(db) },
      { version: 6, up: db => { db.exec(`ALTER TABLE interactions ADD COLUMN extra_json TEXT NOT NULL DEFAULT '{}'`); } }
    ]);
  }

  migrateInteractionCloudId(db) {
    db.exec(`ALTER TABLE interactions ADD COLUMN cloud_id TEXT;`);
  }

  migrateInteractions(db) {
    db.exec(`
CREATE TABLE interactions (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  kind TEXT NOT NULL,
  peer TEXT NOT NULL,
  incoming_text TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '[]',
  draft TEXT,
  status TEXT NOT NULL CHECK(status IN ('draft_pending','sent','discarded','failed')),
  dedup_hash TEXT NOT NULL UNIQUE,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_interactions_status ON interactions(status);
`);
  }

  insertInteraction({ id, platform, kind, peer, incomingText, context = [], draft = null, dedupHash, cloudId = null, extra = {} }) {
    const now = nowIso();
    this.db.prepare(`INSERT INTO interactions (id,platform,kind,peer,incoming_text,context_json,draft,status,dedup_hash,cloud_id,extra_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'draft_pending',?,?,?,?,?)
      ON CONFLICT(dedup_hash) DO NOTHING`)
      .run(id, platform, kind, peer, incomingText, json(context), draft, dedupHash, cloudId, json(extra), now, now);
    return this.db.prepare('SELECT * FROM interactions WHERE dedup_hash=?').get(dedupHash);
  }

  getInteraction(id) {
    const row = this.db.prepare('SELECT * FROM interactions WHERE id=?').get(id);
    return row ? this.toInteraction(row) : null;
  }

  getInteractionByHash(dedupHash) {
    const row = this.db.prepare('SELECT * FROM interactions WHERE dedup_hash=?').get(dedupHash);
    return row ? this.toInteraction(row) : null;
  }

  listInteractions({ status } = {}) {
    const rows = status
      ? this.db.prepare('SELECT * FROM interactions WHERE status=? ORDER BY created_at DESC LIMIT 200').all(status)
      : this.db.prepare('SELECT * FROM interactions ORDER BY created_at DESC LIMIT 200').all();
    return rows.map(row => this.toInteraction(row));
  }

  updateInteraction(id, { draft, status, error, cloudId }) {
    const row = this.db.prepare('SELECT * FROM interactions WHERE id=?').get(id);
    if (!row) return null;
    this.db.prepare('UPDATE interactions SET draft=?, status=?, error_json=?, cloud_id=?, updated_at=? WHERE id=?')
      .run(draft !== undefined ? draft : row.draft, status || row.status, error !== undefined ? json(error) : row.error_json, cloudId !== undefined ? cloudId : row.cloud_id, nowIso(), id);
    return this.getInteraction(id);
  }

  toInteraction(row) {
    return {
      id: row.id,
      platform: row.platform,
      kind: row.kind,
      peer: row.peer,
      incomingText: row.incoming_text,
      context: parseJson(row.context_json, []),
      draft: row.draft,
      status: row.status,
      dedupHash: row.dedup_hash,
      cloudId: row.cloud_id || null,
      extra: parseJson(row.extra_json, {}),
      error: parseJson(row.error_json, null),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  migrateOutbox(db) {
    db.exec(`
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  report_key TEXT NOT NULL,
  outcome TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  error_json TEXT,
  submit_token_protected TEXT,
  created_at TEXT NOT NULL
);
`);
  }

  createSchema(db) {
    db.exec(`
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE binding (
  id INTEGER PRIMARY KEY CHECK(id=1),
  device_id TEXT NOT NULL,
  device_token_protected TEXT NOT NULL,
  service_url TEXT NOT NULL,
  bound_at TEXT NOT NULL
);
CREATE TABLE accounts (
  account_key TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  nickname TEXT NOT NULL,
  platform_identity TEXT,
  status TEXT NOT NULL,
  profile_dir TEXT NOT NULL UNIQUE,
  state_protected TEXT,
  cloud_account_id TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  last_check_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE local_tasks (
  task_id TEXT PRIMARY KEY,
  account_key TEXT NOT NULL,
  platform TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  attempt_id TEXT,
  payload_json TEXT NOT NULL,
  local_video_path TEXT,
  submit_intent_json TEXT,
  report_key TEXT,
  last_error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE locks (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);
  }

  migrateSubjectKeys(db) {
    db.exec(`
ALTER TABLE binding ADD COLUMN subject_key TEXT;
ALTER TABLE accounts ADD COLUMN subject_key TEXT;
ALTER TABLE local_tasks ADD COLUMN subject_key TEXT;
`);
  }

  setSetting(key, value) {
    this.db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
  }

  transact(fn) { return immediateTransaction(this.db, fn); }

  addOutbox({ taskId, attemptId, reportKey, outcome, evidence, error, submitToken }) {
    this.db.prepare(`INSERT INTO outbox (task_id,attempt_id,report_key,outcome,evidence_json,error_json,submit_token_protected,created_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(taskId, attemptId, reportKey, outcome, json(evidence || {}), error ? json(error) : null, submitToken ? this.secretProtector.protect(submitToken) : null, nowIso());
  }

  listOutbox() {
    return this.db.prepare('SELECT * FROM outbox ORDER BY id ASC').all().map(row => ({
      id: row.id,
      taskId: row.task_id,
      attemptId: row.attempt_id,
      reportKey: row.report_key,
      outcome: row.outcome,
      evidence: parseJson(row.evidence_json, {}),
      error: parseJson(row.error_json, null),
      submitToken: row.submit_token_protected ? this.secretProtector.unprotect(row.submit_token_protected) : null,
      createdAt: row.created_at
    }));
  }

  removeOutbox(id) { this.db.prepare('DELETE FROM outbox WHERE id=?').run(id); }
  getSetting(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? row.value : fallback;
  }

  saveBinding({ deviceId, deviceToken, serviceUrl, subjectKey = null }) {
    const protectedToken = this.secretProtector.protect(deviceToken);
    this.db.prepare(`INSERT INTO binding (id,device_id,device_token_protected,service_url,bound_at,subject_key)
      VALUES (1,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET device_id=excluded.device_id, device_token_protected=excluded.device_token_protected, service_url=excluded.service_url, bound_at=excluded.bound_at, subject_key=excluded.subject_key`)
      .run(deviceId, protectedToken, serviceUrl, nowIso(), subjectKey);
  }

  getBinding() {
    const row = this.db.prepare('SELECT * FROM binding WHERE id=1').get();
    if (!row) return null;
    return { deviceId: row.device_id, deviceToken: this.secretProtector.unprotect(row.device_token_protected), serviceUrl: row.service_url, boundAt: row.bound_at, subjectKey: row.subject_key || null };
  }

  setBindingSubject(subjectKey) {
    this.db.prepare('UPDATE binding SET subject_key=? WHERE id=1').run(subjectKey);
  }

  clearBinding() { this.db.prepare('DELETE FROM binding WHERE id=1').run(); }

  adoptSubjectForLegacyRows(subjectKey) {
    if (!subjectKey) return { accounts: 0, tasks: 0 };
    const accounts = this.db.prepare('UPDATE accounts SET subject_key=? WHERE subject_key IS NULL').run(subjectKey).changes;
    const tasks = this.db.prepare('UPDATE local_tasks SET subject_key=? WHERE subject_key IS NULL').run(subjectKey).changes;
    return { accounts, tasks };
  }

  currentSubjectKey() {
    const row = this.db.prepare('SELECT subject_key FROM binding WHERE id=1').get();
    return row ? row.subject_key || null : null;
  }

  createAccount({ platform, nickname, capabilities = {}, subjectKey = null }) {
    const accountKey = randomId('localacct', 12);
    assertSafeId(accountKey, 'account_key');
    const { dir } = newAccountProfileDir(this.profilesDir);
    const now = nowIso();
    this.db.prepare(`INSERT INTO accounts (account_key,platform,nickname,status,profile_dir,capabilities_json,created_at,updated_at,subject_key)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(accountKey, platform, nickname, 'created', dir, json(capabilities), now, now, subjectKey);
    return this.getAccount(accountKey);
  }

  upsertAccount({ accountKey, platform, nickname, status, platformIdentity, capabilities, subjectKey = null }) {
    const now = nowIso();
    const existing = this.getAccount(accountKey);
    if (existing) {
      this.db.prepare('UPDATE accounts SET platform=?, nickname=?, status=?, platform_identity=?, capabilities_json=?, updated_at=? WHERE account_key=?')
        .run(platform, nickname, status || existing.status, platformIdentity || null, json(capabilities || {}), now, accountKey);
    } else {
      const { dir } = newAccountProfileDir(this.profilesDir);
      this.db.prepare(`INSERT INTO accounts (account_key,platform,nickname,status,platform_identity,profile_dir,capabilities_json,created_at,updated_at,subject_key)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(accountKey, platform, nickname, status || 'created', platformIdentity || null, dir, json(capabilities || {}), now, now, subjectKey);
    }
    return this.getAccount(accountKey);
  }

  decorateAccount(row) {
    if (!row) return null;
    return { ...row, capabilities: parseJson(row.capabilities_json, {}), capabilities_json: undefined, state_saved: Boolean(row.state_protected), state_protected: undefined };
  }

  listAccounts(subjectKey) {
    const binding = this.getBinding();
    if (!binding) return [];
    const key = subjectKey === undefined ? binding.subjectKey : subjectKey;
    const rows = key === null || key === undefined
      ? this.db.prepare('SELECT * FROM accounts WHERE subject_key IS NULL ORDER BY platform,nickname').all()
      : this.db.prepare('SELECT * FROM accounts WHERE subject_key=? ORDER BY platform,nickname').all(key);
    return rows.map(row => this.decorateAccount(row));
  }

  getAccount(accountKey) { return this.decorateAccount(this.db.prepare('SELECT * FROM accounts WHERE account_key=?').get(accountKey)); }

  updateAccountCloudId(accountKey, cloudAccountId) {
    this.db.prepare('UPDATE accounts SET cloud_account_id=?, updated_at=? WHERE account_key=?').run(cloudAccountId, nowIso(), accountKey);
  }

  updateAccountStatus(accountKey, { status, platformIdentity, lastCheckAt }) {
    this.db.prepare('UPDATE accounts SET status=?, platform_identity=COALESCE(?,platform_identity), last_check_at=?, updated_at=? WHERE account_key=?')
      .run(status, platformIdentity || null, lastCheckAt || nowIso(), nowIso(), accountKey);
  }

  saveAccountState(accountKey, state) {
    this.db.prepare('UPDATE accounts SET state_protected=?, status=?, last_check_at=?, updated_at=? WHERE account_key=?')
      .run(this.secretProtector.protect(JSON.stringify(state)), 'logged_in', nowIso(), nowIso(), accountKey);
  }

  readAccountState(accountKey) {
    const row = this.db.prepare('SELECT state_protected FROM accounts WHERE account_key=?').get(accountKey);
    if (!row || !row.state_protected) return null;
    return JSON.parse(this.secretProtector.unprotect(row.state_protected));
  }

  deleteAccount(accountKey) {
    const row = this.db.prepare('SELECT profile_dir FROM accounts WHERE account_key=?').get(accountKey);
    this.db.prepare('DELETE FROM accounts WHERE account_key=?').run(accountKey);
    if (row && row.profile_dir) {
      const root = path.resolve(this.profilesDir);
      const target = path.resolve(row.profile_dir);
      if (target.startsWith(root + path.sep)) fs.rmSync(target, { recursive: true, force: true });
    }
  }

  saveLocalTask(task) {
    const now = nowIso();
    this.db.prepare(`INSERT INTO local_tasks (task_id,account_key,platform,status,progress,attempt_id,payload_json,created_at,updated_at,subject_key)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(task_id) DO UPDATE SET status=excluded.status, progress=excluded.progress, attempt_id=excluded.attempt_id, payload_json=excluded.payload_json, updated_at=excluded.updated_at, subject_key=excluded.subject_key`)
      .run(task.id, task.account_key || '', task.platform, task.status, task.progress || 0, task.attempt_id || null, json(task), now, now, task.subject_key || this.currentSubjectKey());
  }

  updateLocalTask(taskId, patch) {
    const current = this.getLocalTask(taskId);
    if (!current) return null;
    const merged = { ...current, ...patch, updated_at: nowIso() };
    this.db.prepare(`UPDATE local_tasks SET status=?, progress=?, attempt_id=?, local_video_path=?, submit_intent_json=?, report_key=?, last_error_json=?, updated_at=? WHERE task_id=?`)
      .run(merged.status, merged.progress || 0, merged.attempt_id || null, merged.local_video_path || null, json(merged.submit_intent || null), merged.report_key || null, json(merged.last_error || null), nowIso(), taskId);
    return this.getLocalTask(taskId);
  }

  getLocalTask(taskId) {
    const row = this.db.prepare('SELECT * FROM local_tasks WHERE task_id=?').get(taskId);
    return this.decorateLocalTask(row);
  }

  listLocalTasks(subjectKey) {
    const binding = this.getBinding();
    if (!binding) return [];
    const key = subjectKey === undefined ? binding.subjectKey : subjectKey;
    const rows = key === null || key === undefined
      ? this.db.prepare('SELECT * FROM local_tasks WHERE subject_key IS NULL ORDER BY created_at DESC').all()
      : this.db.prepare('SELECT * FROM local_tasks WHERE subject_key=? ORDER BY created_at DESC').all(key);
    return rows.map(row => this.decorateLocalTask(row));
  }

  decorateLocalTask(row) {
    if (!row) return null;
    return {
      ...row,
      payload: parseJson(row.payload_json, {}),
      submit_intent: parseJson(row.submit_intent_json, null),
      last_error: parseJson(row.last_error_json, null),
      payload_json: undefined,
      submit_intent_json: undefined,
      last_error_json: undefined
    };
  }
}

module.exports = { LocalStore, subjectKeyFor, legacySubjectKeyFor };
