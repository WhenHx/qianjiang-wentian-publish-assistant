const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startMockBackend, api, tempDir, waitFor } = require('./helpers');
const { AssistantApp } = require('../src/assistant/main');

const USER_A = 'sim-user-a-token';
const USER_B = 'sim-user-b-token';

async function localApi(baseUrl, token, apiPath, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${apiPath}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  return { status: response.status, data };
}

async function bindAssistant(t, baseUrl, { submitMode = 'auto' } = {}) {
  const dir = tempDir('assistant-wt');
  const app = new AssistantApp({
    mode: 'simulation',
    serviceUrl: baseUrl,
    allowLoopbackMaterialUrls: true,
    dataDir: path.join(dir, 'assistant-data'),
    downloadDir: path.join(dir, 'downloads'),
    logDir: path.join(dir, 'logs'),
    localApiHost: '127.0.0.1',
    localApiPort: 0,
    automationMode: 'simulated',
    submitMode,
    pollIntervalMs: 100,
    heartbeatIntervalMs: 60000,
    browser: 'edge',
    allowInsecureSecretStorage: true,
    rootDir: dir
  });
  await app.start();
  t.after(() => app.stop());
  const localBase = `http://127.0.0.1:${app.server.address().port}`;
  const created = await localApi(localBase, app.localToken, '/local/v1/bindings', { method: 'POST', body: { device_name: '问天闭环测试设备' } });
  await api(baseUrl, `/api/v1/bindings/${created.data.binding_id}/confirm`, { token: USER_A, method: 'POST', body: { code: created.data.code } });
  const polled = await localApi(localBase, app.localToken, '/local/v1/bindings/poll', { method: 'POST', body: {} });
  assert.equal(polled.data.status, 'approved');
  const account = await localApi(localBase, app.localToken, '/local/v1/accounts', { method: 'POST', body: { platform: 'douyin', nickname: '闭环测试抖音号' } });
  await localApi(localBase, app.localToken, `/local/v1/accounts/${account.data.account.account_key}/check`, { method: 'POST', body: {} });
  return { app, localBase, deviceId: polled.data.device_id };
}

test('问天接口：视频详情、发布任务、幂等与越权', async t => {
  const { baseUrl } = await startMockBackend(t);
  const { app } = await bindAssistant(t, baseUrl);
  const cloudAccounts = (await api(baseUrl, '/api/v1/accounts', { token: USER_A })).data.accounts;

  const videos = await api(baseUrl, '/api/v1/videos', { token: USER_A });
  assert.equal(videos.status, 200);
  assert.ok(videos.data.videos.length >= 1);
  const video = videos.data.videos[0];
  assert.equal(video.status, 'ready');

  const detail = await api(baseUrl, `/api/v1/videos/${video.id}`, { token: USER_A });
  assert.equal(detail.status, 200);
  const detailAsB = await api(baseUrl, `/api/v1/videos/${video.id}`, { token: USER_B });
  assert.equal(detailAsB.status, 404);

  const payload = {
    video_id: video.id,
    video_version: video.version,
    platform: 'douyin',
    account_id: cloudAccounts[0].id,
    device_id: (await api(baseUrl, '/api/v1/devices', { token: USER_A })).data.devices[0].id,
    title: '闭环测试标题',
    description: '闭环测试描述',
    topics: ['闭环'],
    execution_mode: 'desktop_assistant',
    idempotency_key: `pub-${Date.now()}`
  };
  const created = await api(baseUrl, '/api/v1/publish-tasks', { token: USER_A, method: 'POST', body: payload });
  assert.equal(created.status, 201);
  assert.equal(created.data.task.execution_mode, 'desktop_assistant');
  assert.equal(created.data.task.video_id, video.id);

  const replay = await api(baseUrl, '/api/v1/publish-tasks', { token: USER_A, method: 'POST', body: payload });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.idempotent_replay, true);
  assert.equal(replay.data.task.id, created.data.task.id);

  const badVersion = await api(baseUrl, '/api/v1/publish-tasks', { token: USER_A, method: 'POST', body: { ...payload, video_version: 'v999', idempotency_key: `pub-bad-${Date.now()}` } });
  assert.equal(badVersion.status, 409);

  const asB = await api(baseUrl, '/api/v1/publish-tasks', { token: USER_B, method: 'POST', body: { ...payload, idempotency_key: `pub-b-${Date.now()}` } });
  assert.equal(asB.status, 403);
});

test('问天闭环：网页确认发布后助手自动下载执行提交，全程无桌面操作', async t => {
  const { baseUrl } = await startMockBackend(t);
  const { deviceId } = await bindAssistant(t, baseUrl, { submitMode: 'auto' });
  const cloudAccounts = (await api(baseUrl, '/api/v1/accounts', { token: USER_A })).data.accounts;
  const video = (await api(baseUrl, '/api/v1/videos', { token: USER_A })).data.videos[0];

  const created = await api(baseUrl, '/api/v1/publish-tasks', { token: USER_A, method: 'POST', body: {
    video_id: video.id, video_version: video.version, platform: 'douyin',
    account_id: cloudAccounts[0].id, device_id: deviceId,
    title: '自动闭环测试', description: '自动闭环描述', topics: ['自动'],
    execution_mode: 'desktop_assistant', idempotency_key: `auto-${Date.now()}`
  }});
  assert.equal(created.status, 201);
  const taskId = created.data.task.id;

  const done = await waitFor(async () => {
    const result = await api(baseUrl, `/api/v1/tasks/${taskId}`, { token: USER_A });
    return result.data.task.status === 'submitted' ? result.data.task : null;
  }, 15000);
  assert.equal(done.progress, 100);
  assert.equal(done.result.outcome, 'submitted');
});

test('下载授权刷新：任务执行中可刷新，终态拒绝刷新', async t => {
  const { baseUrl } = await startMockBackend(t);
  const { app, deviceId } = await bindAssistant(t, baseUrl);
  const cloudAccounts = (await api(baseUrl, '/api/v1/accounts', { token: USER_A })).data.accounts;
  const video = (await api(baseUrl, '/api/v1/videos', { token: USER_A })).data.videos[0];
  const created = await api(baseUrl, '/api/v1/publish-tasks', { token: USER_A, method: 'POST', body: {
    video_id: video.id, video_version: video.version, platform: 'douyin',
    account_id: cloudAccounts[0].id, device_id: deviceId,
    title: '刷新测试', description: '', topics: [],
    execution_mode: 'desktop_assistant', idempotency_key: `refresh-${Date.now()}`
  }});
  assert.equal(created.status, 201);
  const taskId = created.data.task.id;

  const deviceToken = app.store.getBinding().deviceToken;
  const claim = await api(baseUrl, '/api/v1/tasks/claim', { token: deviceToken, method: 'POST', body: {} });
  const claimed = claim.data.task;
  assert.ok(claimed);
  assert.ok(claimed.material);
  assert.ok(claimed.material.download_url);
  assert.match(claimed.material.sha256, /^[0-9a-f]{64}$/);
  assert.ok(claimed.material.size_bytes > 0);

  const refreshed = await api(baseUrl, `/api/v1/tasks/${taskId}/material-download`, { token: deviceToken, method: 'POST', body: { attempt_id: claimed.attempt_id } });
  assert.equal(refreshed.status, 200);
  assert.ok(refreshed.data.material.download_url);
  const download = await fetch(refreshed.data.material.download_url);
  assert.equal(download.status, 200);

  const unknown = await api(baseUrl, `/api/v1/tasks/${taskId}/result`, { token: deviceToken, method: 'POST', body: { attempt_id: claimed.attempt_id, report_key: 'r-x', outcome: 'failed', evidence: {}, error: { message: '测试终止' } } });
  assert.equal(unknown.status, 201);
  const afterTerminal = await api(baseUrl, `/api/v1/tasks/${taskId}/material-download`, { token: deviceToken, method: 'POST', body: { attempt_id: claimed.attempt_id } });
  assert.equal(afterTerminal.status, 409);
});

test('设备命令队列：白名单、归属、助手执行与确认', async t => {
  const { baseUrl } = await startMockBackend(t);
  const dir = tempDir('assistant-cmd');
  const app = new AssistantApp({
    mode: 'simulation',
    serviceUrl: baseUrl,
    allowLoopbackMaterialUrls: true,
    dataDir: path.join(dir, 'assistant-data'),
    downloadDir: path.join(dir, 'downloads'),
    logDir: path.join(dir, 'logs'),
    localApiHost: '127.0.0.1',
    localApiPort: 0,
    automationMode: 'simulated',
    submitMode: 'hold_before_submit',
    pollIntervalMs: 100,
    heartbeatIntervalMs: 200,
    browser: 'edge',
    allowInsecureSecretStorage: true,
    rootDir: dir
  });
  await app.start();
  t.after(() => app.stop());
  const localBase = `http://127.0.0.1:${app.server.address().port}`;
  const created = await localApi(localBase, app.localToken, '/local/v1/bindings', { method: 'POST', body: { device_name: '命令测试设备' } });
  await api(baseUrl, `/api/v1/bindings/${created.data.binding_id}/confirm`, { token: USER_A, method: 'POST', body: { code: created.data.code } });
  const polled = await localApi(localBase, app.localToken, '/local/v1/bindings/poll', { method: 'POST', body: {} });
  const deviceId = polled.data.device_id;
  const account = await localApi(localBase, app.localToken, '/local/v1/accounts', { method: 'POST', body: { platform: 'douyin', nickname: '命令测试账号' } });
  const accountKey = account.data.account.account_key;

  const badType = await api(baseUrl, `/api/v1/devices/${deviceId}/commands`, { token: USER_A, method: 'POST', body: { type: 'run_shell', payload: {} } });
  assert.equal(badType.status, 400);
  const asB = await api(baseUrl, `/api/v1/devices/${deviceId}/commands`, { token: USER_B, method: 'POST', body: { type: 'open_login', payload: {} } });
  assert.equal(asB.status, 403);

  const cmd = await api(baseUrl, `/api/v1/devices/${deviceId}/commands`, { token: USER_A, method: 'POST', body: { type: 'recheck_account', payload: { account_key: accountKey } } });
  assert.equal(cmd.status, 201);

  const deviceToken = app.store.getBinding().deviceToken;
  await waitFor(async () => {
    const pending = await api(baseUrl, '/api/v1/devices/commands', { token: deviceToken });
    return pending.data.commands.length === 0 ? true : null;
  }, 8000);
});
