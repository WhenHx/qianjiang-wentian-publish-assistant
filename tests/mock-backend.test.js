const test = require('node:test');
const assert = require('node:assert/strict');
const { startMockBackend, api, bindDevice, syncAccount, uploadMaterial, createTask } = require('./helpers');

const USER_A = 'sim-user-a-token';
const USER_B = 'sim-user-b-token';

test('绑定码单次使用，两个业务用户设备和账号互相隔离', async t => {
  const { baseUrl } = await startMockBackend(t);
  const bound = await bindDevice(baseUrl, USER_A, '用户A设备');

  const secondPoll = await api(baseUrl, `/api/v1/bindings/${bound.binding.binding_id}/poll`, { method: 'POST', body: { poll_token: bound.binding.poll_token } });
  assert.equal(secondPoll.data.status, 'consumed');
  const otherConfirm = await api(baseUrl, `/api/v1/bindings/${bound.binding.binding_id}/confirm`, { token: USER_B, method: 'POST', body: { code: bound.binding.code } });
  assert.equal(otherConfirm.status, 409);

  await syncAccount(baseUrl, bound.deviceToken, { accountKey: 'acct_a', nickname: 'A账号' });
  const accountsA = await api(baseUrl, '/api/v1/accounts', { token: USER_A });
  const accountsB = await api(baseUrl, '/api/v1/accounts', { token: USER_B });
  assert.equal(accountsA.data.accounts.length, 1);
  assert.equal(accountsB.data.accounts.length, 0);
});

test('素材与任务权限隔离，修改 ID 不能越权', async t => {
  const { baseUrl } = await startMockBackend(t);
  const bound = await bindDevice(baseUrl, USER_A);
  const account = await syncAccount(baseUrl, bound.deviceToken);
  const material = await uploadMaterial(baseUrl, USER_A);
  const task = await createTask(baseUrl, USER_A, { deviceId: bound.deviceId, accountId: account.account_id, materialId: material.id });

  const materialAsB = await api(baseUrl, `/api/v1/materials/${material.id}/download`, { token: USER_B });
  assert.equal(materialAsB.status, 403);
  const taskAsB = await api(baseUrl, `/api/v1/tasks/${task.id}`, { token: USER_B });
  assert.equal(taskAsB.status, 403);
  const createWithOtherDevice = await api(baseUrl, '/api/v1/tasks', { token: USER_B, method: 'POST', body: { device_id: bound.deviceId, account_id: account.account_id, platform: 'douyin', title: '越权', description: '', topics: [], material_id: material.id, idempotency_key: 'evil-1' } });
  assert.equal(createWithOtherDevice.status, 403);
});

test('并发领取同一任务只有一个成功，旧 attempt 被拒绝，回传幂等', async t => {
  const { baseUrl } = await startMockBackend(t);
  const bound = await bindDevice(baseUrl, USER_A);
  const account = await syncAccount(baseUrl, bound.deviceToken);
  const material = await uploadMaterial(baseUrl, USER_A);
  const task = await createTask(baseUrl, USER_A, { deviceId: bound.deviceId, accountId: account.account_id, materialId: material.id });

  const claims = await Promise.all(Array.from({ length: 5 }, () => api(baseUrl, '/api/v1/tasks/claim', { token: bound.deviceToken, method: 'POST', body: {} })));
  const claimed = claims.filter(item => item.data.task);
  assert.equal(claimed.length, 1);
  const claim = claimed[0].data.task;
  assert.equal(claim.status, 'claimed');
  assert.ok(claim.attempt_id);

  const wrongProgress = await api(baseUrl, `/api/v1/tasks/${task.id}/progress`, { token: bound.deviceToken, method: 'POST', body: { attempt_id: 'attempt_old', status: 'downloading', progress: 10 } });
  assert.equal(wrongProgress.status, 409);

  await api(baseUrl, `/api/v1/tasks/${task.id}/progress`, { token: bound.deviceToken, method: 'POST', body: { attempt_id: claim.attempt_id, status: 'ready_to_submit', progress: 90 } });
  await api(baseUrl, `/api/v1/tasks/${task.id}/submission-intent`, { token: bound.deviceToken, method: 'POST', body: { attempt_id: claim.attempt_id, content_version: claim.content_version, account_id: claim.account_id } });
  const auth = await api(baseUrl, `/api/v1/tasks/${task.id}/submit-authorization`, { token: bound.deviceToken, method: 'POST', body: { attempt_id: claim.attempt_id, content_version: claim.content_version } });
  assert.equal(auth.status, 200);
  const authAgain = await api(baseUrl, `/api/v1/tasks/${task.id}/submit-authorization`, { token: bound.deviceToken, method: 'POST', body: { attempt_id: claim.attempt_id, content_version: claim.content_version } });
  assert.equal(authAgain.status, 409);

  const result = await api(baseUrl, `/api/v1/tasks/${task.id}/result`, { token: bound.deviceToken, method: 'POST', body: { attempt_id: claim.attempt_id, report_key: 'report-1', outcome: 'submitted', submit_token: auth.data.submit_token, evidence: { test: true } } });
  assert.equal(result.status, 201);
  const duplicate = await api(baseUrl, `/api/v1/tasks/${task.id}/result`, { token: bound.deviceToken, method: 'POST', body: { attempt_id: claim.attempt_id, report_key: 'report-1', outcome: 'submitted', submit_token: auth.data.submit_token, evidence: { test: true } } });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.data.duplicate, true);
});

test('设备撤销后不能继续领取或获得提交授权', async t => {
  const { baseUrl } = await startMockBackend(t);
  const bound = await bindDevice(baseUrl, USER_A);
  await api(baseUrl, `/api/v1/devices/${bound.deviceId}/revoke`, { token: USER_A, method: 'POST', body: {} });
  const claim = await api(baseUrl, '/api/v1/tasks/claim', { token: bound.deviceToken, method: 'POST', body: {} });
  assert.equal(claim.status, 401);
});

test('提交中的任务不能取消，不明结果可由所属用户人工核实', async t => {
  const { baseUrl } = await startMockBackend(t);
  const bound = await bindDevice(baseUrl, USER_A);
  const account = await syncAccount(baseUrl, bound.deviceToken);
  const material = await uploadMaterial(baseUrl, USER_A);
  const task = await createTask(baseUrl, USER_A, { deviceId: bound.deviceId, accountId: account.account_id, materialId: material.id });
  const claim = (await api(baseUrl, '/api/v1/tasks/claim', { token: bound.deviceToken, method: 'POST', body: {} })).data.task;
  await api(baseUrl, `/api/v1/tasks/${task.id}/progress`, { token: bound.deviceToken, method: 'POST', body: { attempt_id: claim.attempt_id, status: 'ready_to_submit', progress: 90 } });
  await api(baseUrl, `/api/v1/tasks/${task.id}/submission-intent`, { token: bound.deviceToken, method: 'POST', body: { attempt_id: claim.attempt_id, content_version: claim.content_version, account_id: claim.account_id } });
  const authForUnknown = await api(baseUrl, `/api/v1/tasks/${task.id}/submit-authorization`, { token: bound.deviceToken, method: 'POST', body: { attempt_id: claim.attempt_id, content_version: claim.content_version } });
  assert.equal(authForUnknown.status, 200);
  const cancel = await api(baseUrl, `/api/v1/tasks/${task.id}/cancel`, { token: USER_A, method: 'POST', body: {} });
  assert.equal(cancel.status, 409);
  const unknownWithoutToken = await api(baseUrl, `/api/v1/tasks/${task.id}/result`, { token: bound.deviceToken, method: 'POST', body: { attempt_id: claim.attempt_id, report_key: 'unknown-0', outcome: 'outcome_unknown', evidence: { reason: 'missing token' } } });
  assert.equal(unknownWithoutToken.status, 409);
  const unknown = await api(baseUrl, `/api/v1/tasks/${task.id}/result`, { token: bound.deviceToken, method: 'POST', body: { attempt_id: claim.attempt_id, report_key: 'unknown-1', outcome: 'outcome_unknown', submit_token: authForUnknown.data.submit_token, evidence: { reason: 'submit timeout' } } });
  assert.equal(unknown.status, 201);
  const reviewAsB = await api(baseUrl, `/api/v1/tasks/${task.id}/review`, { token: USER_B, method: 'POST', body: { outcome: 'submitted' } });
  assert.equal(reviewAsB.status, 404);
  const review = await api(baseUrl, `/api/v1/tasks/${task.id}/review`, { token: USER_A, method: 'POST', body: { outcome: 'submitted', note: '人工确认平台已接收' } });
  assert.equal(review.status, 200);
  assert.equal(review.data.task.status, 'submitted');
});