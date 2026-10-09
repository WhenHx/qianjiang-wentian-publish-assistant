const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MockBackendServer } = require('../src/mock-backend/server');

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qjw-${name}-`));
}

async function startMockBackend(t, overrides = {}) {
  const dir = tempDir('backend');
  const app = new MockBackendServer({
    mode: 'simulation',
    host: '127.0.0.1',
    port: 0,
    databasePath: path.join(dir, 'mock.db'),
    storageDir: path.join(dir, 'materials'),
    seedDemoData: true,
    ...overrides
  });
  const address = await app.start();
  const baseUrl = `http://${address.address}:${address.port}`;
  t.after(async () => app.stop());
  return { app, baseUrl, dir };
}

async function api(baseUrl, path, { token, method = 'GET', body, rawBody, headers = {} } = {}) {
  const finalHeaders = { ...headers };
  if (token) finalHeaders.authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { finalHeaders['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  if (rawBody !== undefined) payload = rawBody;
  const response = await fetch(`${baseUrl}${path}`, { method, headers: finalHeaders, body: payload });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('json') ? await response.json() : await response.text();
  return { status: response.status, data };
}

async function bindDevice(baseUrl, userToken, deviceName = '测试设备') {
  const created = await api(baseUrl, '/api/v1/bindings', { method: 'POST', body: { device_name: deviceName } });
  if (created.status !== 201) throw new Error(`create binding failed: ${JSON.stringify(created.data)}`);
  const confirmed = await api(baseUrl, `/api/v1/bindings/${created.data.binding_id}/confirm`, { token: userToken, method: 'POST', body: { code: created.data.code } });
  if (confirmed.status !== 200) throw new Error(`confirm binding failed: ${JSON.stringify(confirmed.data)}`);
  const polled = await api(baseUrl, `/api/v1/bindings/${created.data.binding_id}/poll`, { method: 'POST', body: { poll_token: created.data.poll_token } });
  if (polled.status !== 200 || polled.data.status !== 'approved') throw new Error(`poll binding failed: ${JSON.stringify(polled.data)}`);
  return { binding: created.data, deviceId: polled.data.device_id, deviceToken: polled.data.device_token };
}

async function syncAccount(baseUrl, deviceToken, { accountKey = 'localacct_test', platform = 'douyin', nickname = '测试账号' } = {}) {
  const result = await api(baseUrl, '/api/v1/accounts/sync', {
    token: deviceToken,
    method: 'POST',
    body: { accounts: [{ account_key: accountKey, platform, nickname, status: 'logged_in', platform_identity: `identity-${accountKey}` }] }
  });
  if (result.status !== 200) throw new Error(JSON.stringify(result.data));
  return result.data.accounts[0];
}

async function uploadMaterial(baseUrl, userToken, filename = 'test.mp4', content = Buffer.from('fake video')) {
  const result = await api(baseUrl, '/api/v1/materials', {
    token: userToken,
    method: 'POST',
    rawBody: content,
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': filename }
  });
  if (result.status !== 201) throw new Error(JSON.stringify(result.data));
  return result.data.material;
}

async function createTask(baseUrl, userToken, { deviceId, accountId, materialId, title = '测试任务', key = `test-${Date.now()}` }) {
  const result = await api(baseUrl, '/api/v1/tasks', {
    token: userToken,
    method: 'POST',
    body: { device_id: deviceId, account_id: accountId, platform: 'douyin', title, description: '测试描述', topics: ['测试'], material_id: materialId, idempotency_key: key }
  });
  if (![200, 201].includes(result.status)) throw new Error(JSON.stringify(result.data));
  return result.data.task;
}

async function waitFor(predicate, timeoutMs = 10000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error('等待条件超时');
}

module.exports = { tempDir, startMockBackend, api, bindDevice, syncAccount, uploadMaterial, createTask, waitFor };