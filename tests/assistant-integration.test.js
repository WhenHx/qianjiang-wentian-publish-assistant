const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startMockBackend, api, uploadMaterial, waitFor, tempDir } = require('./helpers');
const { AssistantApp } = require('../src/assistant/main');

const USER_A = 'sim-user-a-token';

async function localApi(baseUrl, token, path, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  return { status: response.status, data };
}

test('模拟后端 + 助手核心完成端到端任务，默认停在提交前并可单次提交', async t => {
  const { baseUrl } = await startMockBackend(t);
  const dir = tempDir('assistant');
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
    heartbeatIntervalMs: 1000,
    browser: 'edge',
    allowInsecureSecretStorage: true,
    rootDir: dir
  });
  await app.start();
  t.after(() => app.stop());
  const address = app.server.address();
  const localBase = `http://127.0.0.1:${address.port}`;

  const binding = await localApi(localBase, app.localToken, '/local/v1/bindings', { method: 'POST', body: { device_name: '集成测试设备' } });
  assert.equal(binding.status, 201);
  const confirmed = await api(baseUrl, `/api/v1/bindings/${binding.data.binding_id}/confirm`, { token: USER_A, method: 'POST', body: { code: binding.data.code } });
  assert.equal(confirmed.status, 200);
  const polled = await localApi(localBase, app.localToken, '/local/v1/bindings/poll', { method: 'POST', body: {} });
  assert.equal(polled.data.status, 'approved');

  const account = await localApi(localBase, app.localToken, '/local/v1/accounts', { method: 'POST', body: { platform: 'douyin', nickname: '集成测试抖音号' } });
  assert.equal(account.status, 201);
  const check = await localApi(localBase, app.localToken, `/local/v1/accounts/${account.data.account.account_key}/check`, { method: 'POST', body: {} });
  assert.equal(check.status, 200);
  assert.equal(check.data.loggedIn, true);
  const cloudAccounts = await api(baseUrl, '/api/v1/accounts', { token: USER_A });
  assert.equal(cloudAccounts.data.accounts.length, 1);
  const material = await uploadMaterial(baseUrl, USER_A, 'integration.mp4', Buffer.from('integration fake video'));
  const taskResult = await api(baseUrl, '/api/v1/tasks', { token: USER_A, method: 'POST', body: {
    device_id: polled.data.device_id,
    account_id: cloudAccounts.data.accounts[0].id,
    platform: 'douyin',
    title: '集成测试标题',
    description: '集成测试描述',
    topics: ['集成', '测试'],
    material_id: material.id,
    idempotency_key: `integration-${Date.now()}`
  }});
  assert.equal(taskResult.status, 201);
  const taskId = taskResult.data.task.id;

  const readyTask = await waitFor(async () => {
    const result = await api(baseUrl, `/api/v1/tasks/${taskId}`, { token: USER_A });
    return result.data.task.status === 'ready_to_submit' ? result.data.task : null;
  });
  assert.equal(readyTask.progress, 90);
  assert.ok(readyTask.submission_intent_at);

  const secondMaterial = await uploadMaterial(baseUrl, USER_A, 'integration-2.mp4', Buffer.from('second fake video'));
  const secondTaskResult = await api(baseUrl, '/api/v1/tasks', { token: USER_A, method: 'POST', body: {
    device_id: polled.data.device_id,
    account_id: cloudAccounts.data.accounts[0].id,
    platform: 'douyin',
    title: '第二个任务',
    description: '验证同设备互斥',
    topics: ['互斥'],
    material_id: secondMaterial.id,
    idempotency_key: `integration-second-${Date.now()}`
  }});
  assert.equal(secondTaskResult.status, 201);
  await new Promise(resolve => setTimeout(resolve, 500));
  const secondWhileHeld = await api(baseUrl, `/api/v1/tasks/${secondTaskResult.data.task.id}`, { token: USER_A });
  assert.equal(secondWhileHeld.data.task.status, 'queued');

  const submit = await localApi(localBase, app.localToken, `/local/v1/tasks/${taskId}/submit`, { method: 'POST', body: {} });
  assert.equal(submit.status, 200);
  const finalTask = await waitFor(async () => {
    const result = await api(baseUrl, `/api/v1/tasks/${taskId}`, { token: USER_A });
    return result.data.task.status === 'submitted' ? result.data.task : null;
  });
  assert.equal(finalTask.progress, 100);
  assert.match(finalTask.result.note, /不等于公开发布成功/);
  const secondReady = await waitFor(async () => {
    const result = await api(baseUrl, `/api/v1/tasks/${secondTaskResult.data.task.id}`, { token: USER_A });
    return result.data.task.status === 'ready_to_submit' ? result.data.task : null;
  });
  assert.equal(secondReady.progress, 90);
  await app.worker.cancelTask(secondReady.id);
});