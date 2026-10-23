const test = require('node:test');
const assert = require('node:assert/strict');
const { startMockBackend, api, bindDevice } = require('./helpers');

const USER_A = 'sim-user-a-token';

async function setup(t) {
  const { baseUrl } = await startMockBackend(t);
  const { deviceToken } = await bindDevice(baseUrl, USER_A, '互动契约测试设备');
  return { baseUrl, deviceToken };
}

function interactionBody(key) {
  return {
    platform: 'douyin',
    account_key: 'localacct_test',
    kind: 'dm',
    peer: { platform_uid: null, nickname: '客户甲' },
    message: { external_id: null, direction: 'in', content: '你们的产品多少钱', sent_at: new Date().toISOString() },
    context: [],
    source: { kind: 'dm', conversation_key: '客户甲', work_id: null },
    idempotency_key: key
  };
}

test('契约v3：互动上行获得回复，幂等重放，结果回传终态幂等', async t => {
  const { baseUrl, deviceToken } = await setup(t);
  const created = await api(baseUrl, '/api/v1/interactions', { token: deviceToken, method: 'POST', body: interactionBody('int-k1') });
  assert.equal(created.status, 201);
  assert.equal(created.data.reply.status, 'ready');
  assert.ok(created.data.reply.text);

  const replay = await api(baseUrl, '/api/v1/interactions', { token: deviceToken, method: 'POST', body: interactionBody('int-k1') });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.idempotent_replay, true);
  assert.equal(replay.data.interaction_id, created.data.interaction_id);

  const id = created.data.interaction_id;
  const got = await api(baseUrl, `/api/v1/interactions/${id}`, { token: deviceToken });
  assert.equal(got.data.reply.status, 'ready');

  const r1 = await api(baseUrl, `/api/v1/interactions/${id}/result`, { token: deviceToken, method: 'POST', body: { outcome: 'sent', evidence: { sent_text: '回复内容' } } });
  assert.equal(r1.status, 200);
  const r2 = await api(baseUrl, `/api/v1/interactions/${id}/result`, { token: deviceToken, method: 'POST', body: { outcome: 'failed' } });
  assert.equal(r2.status, 200);
  assert.equal(r2.data.already_reported, true);
  assert.equal(r2.data.outcome, 'sent'); // 终态不被覆盖

  // 业务用户可在控制台看到互动与结果
  const list = await api(baseUrl, '/api/v1/interactions', { token: USER_A });
  assert.equal(list.status, 200);
  const row = list.data.interactions.find(i => i.id === id);
  assert.equal(row.outcome, 'sent');
  assert.equal(row.peer_nickname, '客户甲');
});

test('契约v3：无意义消息问天不回复（reply none）', async t => {
  const { baseUrl, deviceToken } = await setup(t);
  const body = interactionBody('int-k2');
  body.message.content = '？';
  const created = await api(baseUrl, '/api/v1/interactions', { token: deviceToken, method: 'POST', body });
  assert.equal(created.status, 201);
  assert.equal(created.data.reply.status, 'none');
});

test('契约v3：他人设备的互动不可读不可回传', async t => {
  const { baseUrl, deviceToken } = await setup(t);
  const created = await api(baseUrl, '/api/v1/interactions', { token: deviceToken, method: 'POST', body: interactionBody('int-k3') });
  const { deviceToken: otherToken } = await bindDevice(baseUrl, 'sim-user-b-token', '他人设备');
  const got = await api(baseUrl, `/api/v1/interactions/${created.data.interaction_id}`, { token: otherToken });
  assert.equal(got.status, 404);
  const report = await api(baseUrl, `/api/v1/interactions/${created.data.interaction_id}/result`, { token: otherToken, method: 'POST', body: { outcome: 'sent' } });
  assert.equal(report.status, 404);
});

test('契约v3：留微线索上行、幂等、渠道来源保留、用户可查', async t => {
  const { baseUrl, deviceToken } = await setup(t);
  const leadBody = {
    platform: 'xiaohongshu',
    account_key: 'localacct_xhs',
    peer: { platform_uid: null, nickname: '小林' },
    channel: '小红书',
    contact: { type: 'wechat', value: 'xiaolin_2026' },
    raw_message: '加我微信: xiaolin_2026… 我微信是 xiaolin_2026',
    source: { kind: 'comment', conversation_key: null, interaction_id: 'int_x', work_id: 'note_1' },
    captured_at: new Date().toISOString(),
    idempotency_key: 'lead-k1'
  };
  const created = await api(baseUrl, '/api/v1/leads', { token: deviceToken, method: 'POST', body: leadBody });
  assert.equal(created.status, 201);
  assert.equal(created.data.lead.channel, '小红书');
  assert.equal(created.data.lead.contact.value, 'xiaolin_2026');
  assert.equal(created.data.lead.source.interaction_id, 'int_x');

  const replay = await api(baseUrl, '/api/v1/leads', { token: deviceToken, method: 'POST', body: leadBody });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.idempotent_replay, true);

  const list = await api(baseUrl, '/api/v1/leads', { token: USER_A });
  assert.equal(list.data.leads.length, 1);
  const other = await api(baseUrl, '/api/v1/leads', { token: 'sim-user-b-token' });
  assert.equal(other.data.leads.length, 0);
});
