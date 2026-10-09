const fs = require('node:fs');

const LOCAL = 'http://127.0.0.1:8781';
const CLOUD = 'http://127.0.0.1:8780';
const USER_TOKEN = 'sim-user-a-token';

async function api(base, path, { token, method = 'GET', body, rawBody, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  if (rawBody !== undefined) payload = rawBody;
  const res = await fetch(`${base}${path}`, { method, headers: h, body: payload });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function main() {
  const runtime = JSON.parse(fs.readFileSync('runtime/assistant-data/runtime.json', 'utf8'));
  const localToken = runtime.token;

  const status = await api(LOCAL, '/local/v1/status', { token: localToken });
  let deviceId = status.device_id;
  if (!status.bound) {
    const binding = await api(LOCAL, '/local/v1/bindings', { token: localToken, method: 'POST', body: { device_name: require('node:os').hostname() } });
    console.log('binding created:', binding.binding_id);
    await api(CLOUD, `/api/v1/bindings/${binding.binding_id}/confirm`, { token: USER_TOKEN, method: 'POST', body: { code: binding.code } });
    const polled = await api(LOCAL, '/local/v1/bindings/poll', { token: localToken, method: 'POST', body: {} });
    console.log('binding polled:', polled.status);
    deviceId = polled.device_id;
  } else {
    console.log('already bound:', deviceId);
  }

  let accounts = (await api(LOCAL, '/local/v1/accounts', { token: localToken })).accounts;
  if (accounts.length === 0) {
    await api(LOCAL, '/local/v1/accounts', { token: localToken, method: 'POST', body: { platform: 'douyin', nickname: '演示抖音账号' } });
    accounts = (await api(LOCAL, '/local/v1/accounts', { token: localToken })).accounts;
  }
  console.log('local accounts:', accounts.length);

  const cloudAccounts = (await api(CLOUD, '/api/v1/accounts', { token: USER_TOKEN })).accounts;
  console.log('cloud accounts:', cloudAccounts.map(a => `${a.id}:${a.platform}:${a.nickname}`).join(', '));
  const accountId = cloudAccounts[0].id;

  const video = fs.readFileSync('assets/sample-video.mp4');
  const material = await api(CLOUD, '/api/v1/materials', { token: USER_TOKEN, method: 'POST', rawBody: video, headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'sample-video.mp4' } });
  console.log('material:', material.material ? material.material.id : material.id);

  const materialId = material.material ? material.material.id : material.id;
  const task = await api(CLOUD, '/api/v1/tasks', {
    token: USER_TOKEN, method: 'POST',
    body: { device_id: deviceId, account_id: accountId, platform: 'douyin', title: '验收演示任务', description: '用于验收截图的演示任务', topics: ['验收', '演示'], material_id: materialId, idempotency_key: `acceptance-${Date.now()}` }
  });
  console.log('task:', task.task ? task.task.id : task.id);

  for (let i = 0; i < 30; i++) {
    const tasks = (await api(LOCAL, '/local/v1/tasks', { token: localToken })).tasks;
    if (tasks.length > 0) { console.log('local tasks:', tasks.map(t => `${t.task_id}:${t.status}:${t.progress}%`).join(', ')); if (tasks[0].status === 'ready_to_submit') break; }
    await new Promise(r => setTimeout(r, 1000));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
