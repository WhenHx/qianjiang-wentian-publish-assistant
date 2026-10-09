const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startMockBackend, api, bindDevice, syncAccount, uploadMaterial, createTask, tempDir } = require('./helpers');
const { AssistantApp } = require('../src/assistant/main');
const { AssistantWorker } = require('../src/assistant/worker');
const { ConfigurableCdpAdapter } = require('../src/assistant/platforms/configurableCdpAdapter');

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

async function readyToSubmitTask(baseUrl, userToken, deviceToken, deviceId, key) {
  const account = await syncAccount(baseUrl, deviceToken);
  const material = await uploadMaterial(baseUrl, userToken);
  const task = await createTask(baseUrl, userToken, { deviceId, accountId: account.account_id, materialId: material.id, key: key || `rts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
  const claim = (await api(baseUrl, '/api/v1/tasks/claim', { token: deviceToken, method: 'POST', body: {} })).data.task;
  await api(baseUrl, `/api/v1/tasks/${task.id}/progress`, { token: deviceToken, method: 'POST', body: { attempt_id: claim.attempt_id, status: 'downloading', progress: 20 } });
  await api(baseUrl, `/api/v1/tasks/${task.id}/progress`, { token: deviceToken, method: 'POST', body: { attempt_id: claim.attempt_id, status: 'uploading', progress: 50 } });
  const ready = await api(baseUrl, `/api/v1/tasks/${task.id}/progress`, { token: deviceToken, method: 'POST', body: { attempt_id: claim.attempt_id, status: 'ready_to_submit', progress: 90 } });
  assert.equal(ready.status, 200);
  await api(baseUrl, `/api/v1/tasks/${task.id}/submission-intent`, { token: deviceToken, method: 'POST', body: { attempt_id: claim.attempt_id, content_version: claim.content_version, account_id: claim.account_id } });
  return { task, claim };
}

test('F03：状态机禁止回退，提交授权每个 attempt 仅一次', async t => {
  const { baseUrl, app } = await startMockBackend(t);
  const bound = await bindDevice(baseUrl, USER_A);
  const { task, claim } = await readyToSubmitTask(baseUrl, USER_A, bound.deviceToken, bound.deviceId);

  const backward = await api(baseUrl, `/api/v1/tasks/${task.id}/progress`, { token: bound.deviceToken, method: 'POST', body: { attempt_id: claim.attempt_id, status: 'downloading', progress: 10 } });
  assert.equal(backward.status, 409);
  assert.equal(backward.data.error.code, 'invalid_transition');

  const auth = await api(baseUrl, `/api/v1/tasks/${task.id}/submit-authorization`, { token: bound.deviceToken, method: 'POST', body: { attempt_id: claim.attempt_id, content_version: claim.content_version } });
  assert.equal(auth.status, 200);

  const regress = await api(baseUrl, `/api/v1/tasks/${task.id}/progress`, { token: bound.deviceToken, method: 'POST', body: { attempt_id: claim.attempt_id, status: 'ready_to_submit', progress: 90 } });
  assert.equal(regress.status, 409);
  assert.equal(regress.data.error.code, 'invalid_transition');

  const authAgain = await api(baseUrl, `/api/v1/tasks/${task.id}/submit-authorization`, { token: bound.deviceToken, method: 'POST', body: { attempt_id: claim.attempt_id, content_version: claim.content_version } });
  assert.equal(authAgain.status, 409);
  assert.equal(authAgain.data.error.code, 'submit_already_authorized');

  app.store.db.prepare(`UPDATE tasks SET submit_token_expires_at=? WHERE id=?`).run('2000-01-01T00:00:00.000Z', task.id);
  const authAfterExpiry = await api(baseUrl, `/api/v1/tasks/${task.id}/submit-authorization`, { token: bound.deviceToken, method: 'POST', body: { attempt_id: claim.attempt_id, content_version: claim.content_version } });
  assert.equal(authAfterExpiry.status, 409);
  assert.equal(authAfterExpiry.data.error.code, 'submit_already_authorized');
});

test('F04：终态不可被设备结果覆盖，幂等键绑定原结果内容', async t => {
  const { baseUrl } = await startMockBackend(t);
  const bound = await bindDevice(baseUrl, USER_A);
  const { task, claim } = await readyToSubmitTask(baseUrl, USER_A, bound.deviceToken, bound.deviceId);

  const prematureSubmitted = await api(baseUrl, `/api/v1/tasks/${task.id}/result`, { token: bound.deviceToken, method: 'POST', body: { attempt_id: claim.attempt_id, report_key: 'r-early', outcome: 'submitted', evidence: { fake: true } } });
  assert.equal(prematureSubmitted.status, 409);
  assert.equal(prematureSubmitted.data.error.code, 'submit_token_invalid');

  const auth = await api(baseUrl, `/api/v1/tasks/${task.id}/submit-authorization`, { token: bound.deviceToken, method: 'POST', body: { attempt_id: claim.attempt_id, content_version: claim.content_version } });
  const unknown = await api(baseUrl, `/api/v1/tasks/${task.id}/result`, { token: bound.deviceToken, method: 'POST', body: { attempt_id: claim.attempt_id, report_key: 'r-1', outcome: 'outcome_unknown', submit_token: auth.data.submit_token, evidence: { reason: 'timeout' } } });
  assert.equal(unknown.status, 201);

  const conflict = await api(baseUrl, `/api/v1/tasks/${task.id}/result`, { token: bound.deviceToken, method: 'POST', body: { attempt_id: claim.attempt_id, report_key: 'r-1', outcome: 'submitted', submit_token: auth.data.submit_token, evidence: { reason: 'timeout' } } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error.code, 'report_conflict');

  const overwrite = await api(baseUrl, `/api/v1/tasks/${task.id}/result`, { token: bound.deviceToken, method: 'POST', body: { attempt_id: claim.attempt_id, report_key: 'r-2', outcome: 'submitted', evidence: { late: true } } });
  assert.equal(overwrite.status, 409);
  assert.equal(overwrite.data.error.code, 'task_terminal');

  const idempotent = await api(baseUrl, `/api/v1/tasks/${task.id}/result`, { token: bound.deviceToken, method: 'POST', body: { attempt_id: claim.attempt_id, report_key: 'r-1', outcome: 'outcome_unknown', submit_token: auth.data.submit_token, evidence: { reason: 'timeout' } } });
  assert.equal(idempotent.status, 200);
  assert.equal(idempotent.data.duplicate, true);

  const final = await api(baseUrl, `/api/v1/tasks/${task.id}`, { token: USER_A });
  assert.equal(final.data.task.status, 'outcome_unknown');
});

test('F08：生产/CDP 模式配置未加密存储开关时拒绝启动', async t => {
  const dir = tempDir('f08');
  const base = {
    mode: 'production',
    serviceUrl: 'https://cloud.example.com',
    dataDir: path.join(dir, 'data'),
    downloadDir: path.join(dir, 'downloads'),
    logDir: path.join(dir, 'logs'),
    automationMode: 'cdp',
    allowInsecureSecretStorage: true
  };
  assert.throws(() => new AssistantApp(base), /禁止未加密秘密存储/);
  const allowed = new AssistantApp({ ...base, mode: 'simulation', automationMode: 'simulated', serviceUrl: 'http://127.0.0.1:9', localApiPort: 0 });
  assert.ok(allowed);
});

function stubBrowser({ text = '', cookies = [], identityText = '' }) {
  return {
    bodyText: async () => text,
    saveCookies: async () => ({ cookies, saved_at: new Date().toISOString() }),
    currentUrl: async () => 'https://creator.douyin.com/',
    evaluate: async expression => (expression.includes('querySelector') ? identityText : null)
  };
}

test('F02：任意 Cookie 不再视为登录，身份读不到返回 null', async () => {
  const account = { account_key: 'localacct_x1', platform: 'douyin', nickname: '本机昵称', platform_identity: 'identity-A', profile_dir: 'x' };
  const adapter = new ConfigurableCdpAdapter({ platform: 'douyin', account, browserName: 'edge', logger: null });

  adapter.browser = stubBrowser({ text: '访问统计 匿名页面', cookies: [{ name: 'ttwid', value: 'anon' }], identityText: '' });
  const state = await adapter.checkLoginStateReadOnly();
  assert.equal(state.loggedIn, false);
  const identity = await adapter.checkIdentity();
  assert.equal(identity.identity, null);

  adapter.browser = stubBrowser({ text: '发布视频 内容管理 创作者服务中心', cookies: [], identityText: 'identity-A' });
  const loggedIn = await adapter.checkLoginStateReadOnly();
  assert.equal(loggedIn.loggedIn, true);
  assert.equal((await adapter.checkIdentity()).identity, 'identity-A');
});

test('F02：worker 身份读不到或不匹配时阻止执行，无基线时需人工确认', async () => {
  const store = { updateAccountStatus: () => { throw new Error('执行路径不得写入身份基线'); } };
  const worker = new AssistantWorker({ config: {}, store, cloud: null, logger: null });
  const task = { id: 'task_x' };

  const unreadable = await worker.verifyIdentity(task, { account_key: 'a1', platform_identity: 'identity-A', status: 'logged_in' }, { checkIdentity: async () => ({ identity: null }) });
  assert.equal(unreadable.verified, false);
  assert.equal(unreadable.code, 'identity_unverifiable');

  const mismatch = await worker.verifyIdentity(task, { account_key: 'a1', platform_identity: 'identity-A', status: 'logged_in' }, { checkIdentity: async () => ({ identity: 'identity-B' }) });
  assert.equal(mismatch.verified, false);
  assert.equal(mismatch.code, 'identity_mismatch');

  const noBaseline = await worker.verifyIdentity(task, { account_key: 'a2', platform_identity: null, status: 'logged_in' }, { checkIdentity: async () => ({ identity: 'identity-C' }) });
  assert.equal(noBaseline.verified, false);
  assert.equal(noBaseline.code, 'identity_baseline_missing');

  const match = await worker.verifyIdentity(task, { account_key: 'a2', platform_identity: 'identity-C', status: 'logged_in' }, { checkIdentity: async () => ({ identity: 'identity-C' }) });
  assert.equal(match.verified, true);
});

test('F02：只读登录检查在浏览器未启动时不打开窗口', async () => {
  const account = { account_key: 'localacct_x2', platform: 'douyin', nickname: '只读测试', platform_identity: null, profile_dir: 'x' };
  const adapter = new ConfigurableCdpAdapter({ platform: 'douyin', account, browserName: 'edge', logger: null });
  const state = await adapter.checkLoginStateReadOnly();
  assert.equal(state.loggedIn, false);
  assert.equal(state.reason, 'browser_not_started');
  assert.equal(adapter.browser, null);
});

test('F04：幂等键内容比较与键序无关，非法令牌类型返回 409 而非 500', async t => {
  const { baseUrl } = await startMockBackend(t);
  const bound = await bindDevice(baseUrl, USER_A);
  const { task, claim } = await readyToSubmitTask(baseUrl, USER_A, bound.deviceToken, bound.deviceId);
  const auth = await api(baseUrl, `/api/v1/tasks/${task.id}/submit-authorization`, { token: bound.deviceToken, method: 'POST', body: { attempt_id: claim.attempt_id, content_version: claim.content_version } });

  const first = await api(baseUrl, `/api/v1/tasks/${task.id}/result`, { token: bound.deviceToken, method: 'POST', body: { attempt_id: claim.attempt_id, report_key: 'rk-1', outcome: 'submitted', submit_token: auth.data.submit_token, evidence: { a: 1, b: { c: 2, d: 3 } } } });
  assert.equal(first.status, 201);
  const reordered = await api(baseUrl, `/api/v1/tasks/${task.id}/result`, { token: bound.deviceToken, method: 'POST', body: { attempt_id: claim.attempt_id, report_key: 'rk-1', outcome: 'submitted', evidence: { b: { d: 3, c: 2 }, a: 1 } } });
  assert.equal(reordered.status, 200);
  assert.equal(reordered.data.duplicate, true);

  const badTokenSetup = await readyToSubmitTask(baseUrl, USER_A, bound.deviceToken, bound.deviceId, 'f04-badtoken');
  const auth2 = await api(baseUrl, `/api/v1/tasks/${badTokenSetup.task.id}/submit-authorization`, { token: bound.deviceToken, method: 'POST', body: { attempt_id: badTokenSetup.claim.attempt_id, content_version: badTokenSetup.claim.content_version } });
  const badToken = await api(baseUrl, `/api/v1/tasks/${badTokenSetup.task.id}/result`, { token: bound.deviceToken, method: 'POST', body: { attempt_id: badTokenSetup.claim.attempt_id, report_key: 'rk-bad', outcome: 'submitted', submit_token: { evil: true }, evidence: {} } });
  assert.equal(badToken.status, 409);
  assert.equal(badToken.data.error.code, 'submit_token_invalid');
});

test('F01：换绑业务用户后本机账号、任务与云端同步按主体隔离', async t => {
  const { baseUrl } = await startMockBackend(t);
  const dir = tempDir('assistant-f01');
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
    heartbeatIntervalMs: 60000,
    browser: 'edge',
    allowInsecureSecretStorage: true,
    rootDir: dir
  });
  await app.start();
  t.after(() => app.stop());
  const localBase = `http://127.0.0.1:${app.server.address().port}`;

  async function bindAs(userToken) {
    const created = await localApi(localBase, app.localToken, '/local/v1/bindings', { method: 'POST', body: { device_name: 'F01测试设备' } });
    assert.equal(created.status, 201);
    const confirmed = await api(baseUrl, `/api/v1/bindings/${created.data.binding_id}/confirm`, { token: userToken, method: 'POST', body: { code: created.data.code } });
    assert.equal(confirmed.status, 200);
    const polled = await localApi(localBase, app.localToken, '/local/v1/bindings/poll', { method: 'POST', body: {} });
    assert.equal(polled.data.status, 'approved');
    return polled.data;
  }

  const unboundCreate = await localApi(localBase, app.localToken, '/local/v1/accounts', { method: 'POST', body: { platform: 'douyin', nickname: '未绑定账号' } });
  assert.equal(unboundCreate.status, 409);

  await bindAs(USER_A);
  const account = await localApi(localBase, app.localToken, '/local/v1/accounts', { method: 'POST', body: { platform: 'douyin', nickname: 'A的抖音号' } });
  assert.equal(account.status, 201);
  assert.equal((await api(baseUrl, '/api/v1/accounts', { token: USER_A })).data.accounts.length, 1);
  const profileDir = account.data.account.profile_dir;

  const unbind = await localApi(localBase, app.localToken, '/local/v1/binding', { method: 'DELETE' });
  assert.equal(unbind.status, 200);

  await bindAs(USER_B);
  const accountsAsB = await localApi(localBase, app.localToken, '/local/v1/accounts', { method: 'GET' });
  assert.equal(accountsAsB.data.accounts.length, 0);
  assert.equal((await api(baseUrl, '/api/v1/accounts', { token: USER_B })).data.accounts.length, 0);

  const tasksAsB = await localApi(localBase, app.localToken, '/local/v1/tasks', { method: 'GET' });
  assert.equal(tasksAsB.data.tasks.length, 0);

  const crossAccess = await localApi(localBase, app.localToken, `/local/v1/accounts/${account.data.account.account_key}/check`, { method: 'POST', body: {} });
  assert.equal(crossAccess.status, 404);

  const crossDelete = await localApi(localBase, app.localToken, `/local/v1/accounts/${account.data.account.account_key}`, { method: 'DELETE' });
  assert.equal(crossDelete.status, 404);

  await localApi(localBase, app.localToken, '/local/v1/binding', { method: 'DELETE' });
  await bindAs(USER_A);
  const accountsBackAsA = await localApi(localBase, app.localToken, '/local/v1/accounts', { method: 'GET' });
  assert.equal(accountsBackAsA.data.accounts.length, 1);
  assert.equal(accountsBackAsA.data.accounts[0].profile_dir, profileDir);
});
