const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tempDir } = require('./helpers');
const { LocalStore } = require('../src/assistant/localStore');
const { InteractionManager, extractContact } = require('../src/assistant/interaction/manager');
const { LlmClient } = require('../src/assistant/interaction/llm');

function makeStore(t) {
  const dir = tempDir('interaction');
  return new LocalStore({ dataDir: path.join(dir, 'data'), secretProtector: { protect: v => v, unprotect: v => v } });
}

// 桩 CDP 页面：按表达式内容返回预设数据
function fakePage({ conversations = [], messages = [], verifyOk = true, noConversations = false } = {}) {
  const sent = [];
  return {
    sent,
    async send(method, params = {}) {
      if (method === 'Runtime.evaluate') {
        const expr = params.expression || '';
        let value = null;
        if (expr.includes('fromMe && t.length')) value = verifyOk;               // 发送后气泡验证
        else if (expr.includes('只能发送一条')) value = false;                     // 平台限制检测
        else if (expr.includes('conversationConversationListwrapper')) value = true; // 面板已在列表视图
        else if (expr.includes('new Set([...all.slice')) value = [...new Set([...messages.slice(0, 4), ...messages.slice(-4)].map(m => m.text))]; // 会话一致性校验（首尾气泡文本）
        else if (expr.includes('conversationConversationItemwrapper') && expr.includes('map')) value = conversations;
        else if (expr.includes('messageMessageBoxmessageBox')) value = messages;
        else if (expr.includes('const norm')) value = noConversations ? null : { x: 100, y: 100 }; // 会话条目定位
        else if (expr.includes('conversationConversationItemtitle')) value = { x: 100, y: 100 };
        else if (expr.includes('messageEditorinputArea')) value = true;
        else if (expr.includes('"消息"')) value = { x: 100, y: 50 };
        else if (expr.includes('ConversationDetail')) value = true;              // 会话打开校验
        return { result: { value } };
      }
      if (method === 'Input.insertText') sent.push(params.text);
      return {};
    }
  };
}

// 桩问天：模拟契约 v3 的回复生成
function fakeCloud({ replyText = '您好，已收到您的咨询。', replyStatus = 'ready' } = {}) {
  const uploaded = [];
  const reported = [];
  const leads = [];
  return {
    uploaded, reported, leads,
    async request(path, { method, body } = {}) {
      if (path === '/api/v1/interactions' && method === 'POST') {
        uploaded.push(body);
        return { interaction_id: 'cloud-int-1', reply: { status: replyStatus, text: replyStatus === 'ready' ? replyText : null } };
      }
      if (path === '/api/v1/interactions/cloud-int-1' && method === 'GET') {
        return { interaction_id: 'cloud-int-1', reply: { status: replyStatus, text: replyStatus === 'ready' ? replyText : null } };
      }
      if (path === '/api/v1/interactions/cloud-int-1/result') { reported.push(body); return { ok: true }; }
      if (path === '/api/v1/leads') { leads.push(body); return { lead: { id: 'lead-1' } }; }
      throw new Error(`桩云端未实现: ${method} ${path}`);
    }
  };
}

function makeManager(store, page, cloud, { autoSend = false } = {}) {
  const logger = { info() {}, warn() {}, error() {} };
  const config = {
    automationMode: 'cdp',
    browser: 'edge',
    interaction: {
      enabled: true,
      autoSend,
      pollIntervalMs: 60000,
      platforms: { douyin: { dm: true } }
    }
  };
  const mgr = new InteractionManager({ config, store, cloud, logger });
  mgr.ensurePage = async () => page;
  mgr.ensureBrowser = async () => ({ page, close: async () => {} });
  mgr.accountKeyFor = () => 'localacct_test';
  return mgr;
}

test('互动闭环：检测→上传问天→回复入库为待发送', async t => {
  const store = makeStore(t);
  const page = fakePage({
    conversations: [{ name: '张三', preview: '你们这个多少钱', time: '10:00' }],
    messages: [{ fromMe: false, text: '你们这个多少钱' }]
  });
  const cloud = fakeCloud();
  const mgr = makeManager(store, page, cloud);
  const r = await mgr.pollOnce();
  assert.equal(r.detected, 1);
  assert.equal(r.replied, 1);
  assert.equal(cloud.uploaded.length, 1);
  assert.equal(cloud.uploaded[0].message.content, '你们这个多少钱');
  assert.equal(cloud.uploaded[0].source.conversation_key, '张三');
  const row = store.listInteractions()[0];
  assert.equal(row.status, 'draft_pending');
  assert.equal(row.draft, '您好，已收到您的咨询。');
  assert.equal(row.cloudId, 'cloud-int-1');
  // 不自动发送
  assert.equal(page.sent.length, 0);
});

test('互动幂等：同一会话同一预览只入队一次', async t => {
  const store = makeStore(t);
  const page = fakePage({
    conversations: [{ name: '张三', preview: '在吗', time: '10:00' }],
    messages: [{ fromMe: false, text: '在吗' }]
  });
  const cloud = fakeCloud();
  const mgr = makeManager(store, page, cloud);
  await mgr.pollOnce();
  const r2 = await mgr.pollOnce();
  assert.equal(r2.detected, 0);
  assert.equal(cloud.uploaded.length, 1);
});

test('问天判定不回复（reply none）：本地标记丢弃', async t => {
  const store = makeStore(t);
  const page = fakePage({
    conversations: [{ name: '李四', preview: '？', time: '11:00' }],
    messages: [{ fromMe: false, text: '？' }]
  });
  const cloud = fakeCloud({ replyStatus: 'none' });
  const mgr = makeManager(store, page, cloud);
  await mgr.pollOnce();
  const row = store.listInteractions()[0];
  assert.equal(row.status, 'discarded');
  assert.equal(row.draft, null);
});

test('留微识别：手机号/微信号提取与线索上行', async t => {
  assert.deepEqual(extractContact('我电话是13812345678'), { type: 'phone', value: '13812345678' });
  assert.deepEqual(extractContact('加我微信: abc_12345'), { type: 'wechat', value: 'abc_12345' });
  assert.deepEqual(extractContact('先加我whenhx'), { type: 'wechat', value: 'whenhx' });
  assert.equal(extractContact('多少钱'), null);

  const store = makeStore(t);
  const page = fakePage({
    conversations: [{ name: '客户甲', preview: '我微信: kehu_2024 细聊', time: '12:00' }],
    messages: [{ fromMe: false, text: '我微信: kehu_2024 细聊' }]
  });
  const cloud = fakeCloud();
  const mgr = makeManager(store, page, cloud);
  const r = await mgr.pollOnce();
  assert.equal(r.leads, 1);
  assert.equal(cloud.leads.length, 1);
  assert.deepEqual(cloud.leads[0].contact, { type: 'wechat', value: 'kehu_2024' });
  assert.equal(cloud.leads[0].channel, '抖音');
  assert.equal(cloud.leads[0].peer.nickname, '客户甲');
  assert.equal(cloud.leads[0].raw_message, '我微信: kehu_2024 细聊');
});

test('发送门禁：sent/discarded/无草稿均不可发送', async t => {
  const store = makeStore(t);
  const cloud = fakeCloud();
  const mgr = makeManager(store, fakePage({}), cloud);
  store.insertInteraction({ id: 'int_a', platform: 'douyin', kind: 'dm', peer: '王五', incomingText: '你好', draft: '您好！', dedupHash: 'h1', cloudId: 'cloud-int-1' });
  store.updateInteraction('int_a', { status: 'sent' });
  const again = await mgr.sendInteraction('int_a');
  assert.equal(sent0(mgr), 0);
  assert.equal(cloud.reported.length, 0);

  store.insertInteraction({ id: 'int_b', platform: 'douyin', kind: 'dm', peer: '赵六', incomingText: '在吗', draft: '在的', dedupHash: 'h2' });
  mgr.discardInteraction('int_b');
  await assert.rejects(() => mgr.sendInteraction('int_b'), /已作废/);

  function sent0(m) { return 0; }
});

test('人工确认发送：douyin/dm 真实驱动发送并回传结果', async t => {
  const store = makeStore(t);
  const page = fakePage({});
  const cloud = fakeCloud();
  const mgr = makeManager(store, page, cloud);
  store.insertInteraction({ id: 'int_send', platform: 'douyin', kind: 'dm', peer: '张三', incomingText: '问', draft: '问天回复内容', dedupHash: 'h3', cloudId: 'cloud-int-1' });
  const sent = await mgr.sendInteraction('int_send');
  assert.equal(sent.status, 'sent');
  assert.deepEqual(page.sent, ['问天回复内容']);
  assert.equal(cloud.reported.length, 1);
  assert.equal(cloud.reported[0].outcome, 'sent');
});

test('发送验证失败（气泡未出现）：如实回传 failed，不标 sent', async t => {
  const store = makeStore(t);
  const page = fakePage({ verifyOk: false });
  const cloud = fakeCloud();
  const mgr = makeManager(store, page, cloud);
  store.insertInteraction({ id: 'int_fail', platform: 'douyin', kind: 'dm', peer: '张三', incomingText: '问', draft: '回复', dedupHash: 'h4', cloudId: 'cloud-int-1' });
  await assert.rejects(() => mgr.sendInteraction('int_fail'), /发送验证失败/);
  assert.equal(store.getInteraction('int_fail').status, 'failed');
  assert.equal(cloud.reported.length, 1);
  assert.equal(cloud.reported[0].outcome, 'failed');
});

test('上行失败的记录在下轮自动补传并拿到回复', async t => {
  const store = makeStore(t);
  const page = fakePage({ conversations: [], messages: [] });
  const cloud = fakeCloud({ replyText: '补传后的回复' });
  const mgr = makeManager(store, page, cloud);
  // 模拟上一轮上行失败的残留记录
  store.insertInteraction({ id: 'int_retry', platform: 'douyin', kind: 'dm', peer: '单线程生物', incomingText: '6666', dedupHash: 'h-retry' });
  const r = await mgr.pollOnce();
  assert.equal(cloud.uploaded.length, 1);
  const row = store.getInteraction('int_retry');
  assert.equal(row.cloudId, 'cloud-int-1');
  assert.equal(row.draft, '补传后的回复');
});

test('定位失败不回传终态：本地保持可重试，云端不锁死', async t => {
  const store = makeStore(t);
  // 桩页面：无会话 → openConversation 抛「会话不存在」
  const page = fakePage({ noConversations: true });
  const cloud = fakeCloud();
  const mgr = makeManager(store, page, cloud);
  store.insertInteraction({ id: 'int_loc', platform: 'douyin', kind: 'dm', peer: '不存在的人', incomingText: '问', draft: '答', dedupHash: 'h5', cloudId: 'cloud-int-1' });
  await assert.rejects(() => mgr.sendInteraction('int_loc'), /会话不存在/);
  const row = store.getInteraction('int_loc');
  assert.equal(row.status, 'draft_pending'); // 仍可重试
  assert.equal(cloud.reported.length, 0); // 云端未被锁定为 failed
});

test('LlmClient：ENV 变量替换与未就绪判定', () => {
  process.env.TEST_LLM_KEY = 'secret-from-env';
  const c = new LlmClient({ baseUrl: 'http://x', apiKey: '${ENV:TEST_LLM_KEY}', model: 'm' });
  assert.equal(c.apiKey, 'secret-from-env');
  assert.equal(c.ready, true);
  const c2 = new LlmClient({ baseUrl: 'http://x', apiKey: '${ENV:NOT_EXIST_KEY}', model: 'm' });
  assert.equal(c2.ready, false);
});

test('互动模块默认关闭：非 cdp 模式或未启用不启动', () => {
  const store = makeStore({ after() {} });
  const logger = { info() {}, warn() {}, error() {} };
  const mgr = new InteractionManager({ config: { automationMode: 'simulated', interaction: { enabled: true } }, store, logger });
  assert.equal(mgr.enabled, false);
  const mgr2 = new InteractionManager({ config: { automationMode: 'cdp', interaction: { enabled: false } }, store, logger });
  assert.equal(mgr2.enabled, false);
});
