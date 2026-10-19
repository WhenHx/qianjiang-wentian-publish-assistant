// 稳定性 soak 测试：以真实子进程拉起 mock-backend + assistant，
// 覆盖连续任务、并发互斥、心跳与内存采样，结果写入 acceptance/。
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const USER_TOKEN = 'sim-user-a-token';
const BACKEND_PORT = 18880;
const ASSISTANT_PORT = 18881;
const SEQ_TASKS = 10;
const PAR_TASKS = 3;
const IDLE_SECONDS = 60;
const ACTIVE_STATUSES = new Set(['claimed', 'downloading', 'uploading', 'ready_to_submit', 'submitting']);

const lines = [];
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  lines.push(line);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function api(baseUrl, apiPath, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${baseUrl}${apiPath}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function waitFor(predicate, timeoutMs, intervalMs = 200, label = '条件') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await Promise.resolve().then(predicate).catch(() => null);
    if (v) return v;
    await sleep(intervalMs);
  }
  throw new Error(`等待超时：${label}`);
}

function getRssMb(pid) {
  return new Promise(resolve => {
    execFile('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64`], { timeout: 10000 }, (err, stdout) => {
      const n = parseInt(stdout, 10);
      resolve(err || !n ? null : Math.round(n / 1048576));
    });
  });
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qjw-soak-'));
  log(`工作目录：${dir}`);

  const backendCfg = path.join(dir, 'backend.json');
  fs.writeFileSync(backendCfg, JSON.stringify({
    mode: 'simulation', host: '127.0.0.1', port: BACKEND_PORT,
    databasePath: path.join(dir, 'mock.db'), storageDir: path.join(dir, 'materials'),
    publicBaseUrl: `http://127.0.0.1:${BACKEND_PORT}`,
    allowLoopbackMaterialUrls: true, seedDemoData: true
  }));
  const assistantCfg = path.join(dir, 'assistant.json');
  fs.writeFileSync(assistantCfg, JSON.stringify({
    mode: 'simulation', serviceUrl: `http://127.0.0.1:${BACKEND_PORT}`,
    allowLoopbackMaterialUrls: true,
    dataDir: path.join(dir, 'assistant-data'), downloadDir: path.join(dir, 'downloads'), logDir: path.join(dir, 'logs'),
    localApiHost: '127.0.0.1', localApiPort: ASSISTANT_PORT,
    browser: 'edge', automationMode: 'simulated', submitMode: 'auto',
    pollIntervalMs: 500, heartbeatIntervalMs: 2000, rootDir: dir
  }));

  const backend = spawn(process.execPath, [path.join(ROOT, 'src/mock-backend/server.js'), '--config', backendCfg], { stdio: ['ignore', 'pipe', 'pipe'] });
  const assistant = spawn(process.execPath, [path.join(ROOT, 'src/assistant/main.js'), '--config', assistantCfg], { stdio: ['ignore', 'pipe', 'pipe'] });
  let backendErr = '', assistantErr = '';
  backend.stderr.on('data', d => { backendErr += d; });
  assistant.stderr.on('data', d => { assistantErr += d; });
  const cleanup = code => { backend.kill(); assistant.kill(); if (code !== undefined) process.exitCode = code; };
  process.on('SIGINT', () => cleanup(130));

  const backendBase = `http://127.0.0.1:${BACKEND_PORT}`;
  const localBase = `http://127.0.0.1:${ASSISTANT_PORT}`;
  const results = { pass: [], fail: [] };
  const check = (name, ok, detail = '') => {
    (ok ? results.pass : results.fail).push(name);
    log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  try {
    await waitFor(async () => (await api(backendBase, '/api/v1/videos', { token: USER_TOKEN })).status === 200, 15000, 300, 'mock-backend 就绪');
    log('mock-backend 已就绪');

    // 等助手写出 local_api_token
    const dbPath = path.join(dir, 'assistant-data', 'assistant.db');
    const localToken = await waitFor(() => {
      if (!fs.existsSync(dbPath)) return null;
      try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        const row = db.prepare('SELECT value FROM settings WHERE key=?').get('local_api_token');
        db.close();
        return row ? row.value : null;
      } catch { return null; }
    }, 15000, 300, 'assistant 本地令牌');
    await waitFor(async () => (await api(localBase, '/local/v1/status', { token: localToken })).status === 200, 15000, 300, 'assistant 本地接口');
    log('assistant 已就绪');

    // 内存采样（全程）
    let sampling = true;
    const rssSamples = [];
    const sampler = (async () => {
      while (sampling) {
        const rss = await getRssMb(assistant.pid);
        if (rss !== null) rssSamples.push(rss);
        await sleep(5000);
      }
    })();

    // 绑定 + 账号
    const created = await api(localBase, '/local/v1/bindings', { token: localToken, method: 'POST', body: { device_name: 'soak 测试设备' } });
    check('绑定申请创建', created.status === 200 || created.status === 201, JSON.stringify(created.data));
    const confirmed = await api(backendBase, `/api/v1/bindings/${created.data.binding_id}/confirm`, { token: USER_TOKEN, method: 'POST', body: { code: created.data.code } });
    check('云端确认绑定', confirmed.status === 200);
    const polled = await api(localBase, '/local/v1/bindings/poll', { token: localToken, method: 'POST', body: {} });
    check('设备凭证下发', polled.data && polled.data.status === 'approved');
    const deviceId = polled.data.device_id;
    const account = await api(localBase, '/local/v1/accounts', { token: localToken, method: 'POST', body: { platform: 'douyin', nickname: 'soak 抖音号' } });
    const accountKey = account.data.account.account_key;
    await api(localBase, `/local/v1/accounts/${accountKey}/check`, { token: localToken, method: 'POST', body: {} });
    const cloudAccountId = (await api(backendBase, '/api/v1/accounts', { token: USER_TOKEN })).data.accounts[0].id;
    const video = (await api(backendBase, '/api/v1/videos', { token: USER_TOKEN })).data.videos[0];

    const createPublishTask = i => api(backendBase, '/api/v1/publish-tasks', {
      token: USER_TOKEN, method: 'POST', body: {
        video_id: video.id, video_version: video.version, platform: 'douyin',
        account_id: cloudAccountId, device_id: deviceId,
        title: `soak 任务 ${i}`, description: '稳定性测试', topics: ['soak'],
        execution_mode: 'desktop_assistant', idempotency_key: `soak-${Date.now()}-${i}`
      }
    });
    const waitTask = async (taskId, timeoutMs) => waitFor(async () => {
      const r = await api(backendBase, `/api/v1/tasks/${taskId}`, { token: USER_TOKEN });
      return r.data && r.data.task.status === 'submitted' ? r.data.task : null;
    }, timeoutMs, 300, `任务 ${taskId} 到 submitted`);

    // 阶段 A：连续 10 个任务
    log(`阶段 A：连续 ${SEQ_TASKS} 个任务`);
    const durations = [];
    let seqOk = 0;
    for (let i = 1; i <= SEQ_TASKS; i++) {
      const t0 = Date.now();
      const c = await createPublishTask(`a${i}`);
      if (c.status !== 201) { check(`连续任务 #${i} 创建`, false, JSON.stringify(c.data)); continue; }
      try {
        const done = await waitTask(c.data.task.id, 30000);
        durations.push(Date.now() - t0);
        if (done.progress === 100 && done.result.outcome === 'submitted') seqOk++;
      } catch (e) { check(`连续任务 #${i} 完成`, false, e.message); }
    }
    check(`连续任务 ${SEQ_TASKS} 个全部 submitted`, seqOk === SEQ_TASKS, `成功 ${seqOk}/${SEQ_TASKS}，耗时 ${JSON.stringify(durations)}`);

    // 阶段 B：并发 3 任务互斥采样
    log(`阶段 B：并发 ${PAR_TASKS} 个任务，采样互斥`);
    const createdBatch = [];
    for (let i = 1; i <= PAR_TASKS; i++) createdBatch.push((await createPublishTask(`b${i}`)).data.task.id);
    let maxActive = 0;
    const states = {};
    const pollStates = (async () => {
      let remaining = new Set(createdBatch);
      while (remaining.size) {
        for (const id of [...remaining]) {
          const r = await api(backendBase, `/api/v1/tasks/${id}`, { token: USER_TOKEN });
          const st = r.data.task.status;
          states[id] = st;
          if (st === 'submitted' || st === 'failed' || st === 'outcome_unknown') remaining.delete(id);
        }
        maxActive = Math.max(maxActive, Object.values(states).filter(s => ACTIVE_STATUSES.has(s)).length);
        await sleep(150);
      }
    })();
    await Promise.all(createdBatch.map(id => waitTask(id, 60000)));
    await pollStates;
    check('并发任务互斥（同时执行 ≤1）', maxActive <= 1, `同时活跃最大 ${maxActive}`);
    check(`并发 ${PAR_TASKS} 个任务全部 submitted`, Object.values(states).every(s => s === 'submitted'), JSON.stringify(states));

    // 阶段 C：挂机 60 秒，观察心跳
    log(`阶段 C：挂机 ${IDLE_SECONDS} 秒观察心跳`);
    const devBefore = (await api(backendBase, '/api/v1/devices', { token: USER_TOKEN })).data.devices[0];
    const seen = new Set([devBefore.last_seen_at]);
    const hbWatch = (async () => {
      for (let i = 0; i < IDLE_SECONDS; i++) {
        await sleep(1000);
        const d = (await api(backendBase, '/api/v1/devices', { token: USER_TOKEN })).data.devices[0];
        seen.add(d.last_seen_at);
      }
    })();
    await hbWatch;
    check('挂机期间心跳持续推进', seen.size >= 5, `不同 last_seen_at 数量 ${seen.size}`);

    // 汇总
    sampling = false;
    await sampler;
    const min = Math.min(...rssSamples), max = Math.max(...rssSamples);
    const growth = max - rssSamples[0];
    check('内存采样有效', rssSamples.length >= 5, `样本 ${rssSamples.length} 个`);
    check('内存无明显泄漏（峰值-首样本 < 100MB）', growth < 100, `RSS 首样本 ${rssSamples[0]}MB 最低 ${min}MB 峰值 ${max}MB`);
    log(`RSS 序列：${rssSamples.join(', ')}`);

    const st = (await api(localBase, '/local/v1/status', { token: localToken })).data;
    log(`最终状态：${JSON.stringify(st)}`);
    check('助手 stderr 无异常', !/unhandled|Uncaught|AssertionError/i.test(assistantErr));
  } catch (e) {
    check('soak 主流程', false, e.message);
    if (backendErr) log(`backend stderr 尾部：${backendErr.slice(-800)}`);
    if (assistantErr) log(`assistant stderr 尾部：${assistantErr.slice(-800)}`);
  } finally {
    cleanup();
  }

  log(`汇总：通过 ${results.pass.length} 项，失败 ${results.fail.length} 项`);
  const outFile = path.join(ROOT, 'acceptance', `稳定性测试输出-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.txt`);
  fs.writeFileSync(outFile, lines.join('\n') + '\n');
  console.log(`结果已写入 ${outFile}`);
  if (results.fail.length) process.exitCode = 1;
}

main();
