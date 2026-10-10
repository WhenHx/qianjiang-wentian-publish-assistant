const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AssistantWorker } = require('../src/assistant/worker');
const { ConfigurableCdpAdapter } = require('../src/assistant/platforms/configurableCdpAdapter');

function adapterWithBrowser(browser, platform = 'douyin') {
  const account = { account_key: 'localacct_t1', platform, nickname: '测试', platform_identity: 'identity-A', profile_dir: 'x' };
  const adapter = new ConfigurableCdpAdapter({ platform, account, browserName: 'edge', logger: null });
  adapter.browser = browser;
  return adapter;
}

test('F05：上传未完成或失败时不进入待提交', async () => {
  // 就绪条件满足
  const ready = adapterWithBrowser({
    bodyText: async () => '预览视频 内容管理',
    evaluate: async () => true
  });
  assert.deepEqual((await ready.waitForUploadComplete({ timeoutMs: 500, pollMs: 50 })).ready, true);

  // 失败特征
  const failing = adapterWithBrowser({
    bodyText: async () => '预览视频 上传失败 请重试',
    evaluate: async () => true
  });
  const failResult = await failing.waitForUploadComplete({ timeoutMs: 500, pollMs: 50 });
  assert.equal(failResult.ready, false);
  assert.equal(failResult.failure, '上传失败');

  // 一直忙碌 → 超时（用视频号配置：保留默认忙碌特征）
  const busy = adapterWithBrowser({
    bodyText: async () => '上传中 45%',
    evaluate: async () => false
  }, 'shipinhao');
  const busyResult = await busy.waitForUploadComplete({ timeoutMs: 300, pollMs: 50 });
  assert.equal(busyResult.ready, false);
});

test('F11：恶意 task.id 被拒绝，下载路径不越界', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qjw-f11-'));
  const worker = new AssistantWorker({ config: { downloadDir: dir }, store: null, cloud: null, logger: null });
  await assert.rejects(
    () => worker.downloadMaterial({ id: '../escaped', material_filename: 'x.mp4', material_download_url: 'http://127.0.0.1:1/x' }),
    /不安全字符/
  );
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('F06：验证类接管自动检测恢复，无需人工点继续', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmpVideo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qjw-watch-')), 'v.mp4');
  fs.writeFileSync(tmpVideo, 'fake');

  let loginChecks = 0;
  const adapter = {
    requiredFields: ['description'],
    checkLoginStateReadOnly: async () => { loginChecks += 1; return loginChecks < 3 ? { loggedIn: false } : { loggedIn: true }; },
    detectVerification: async () => null,
    prepareTask: async () => ({ prepared: true }),
    uploadVideo: async () => ({ uploaded: true }),
    waitForUploadComplete: async () => ({ ready: true }),
    fillFields: async () => ({ filled: { description: true } }),
    close: async () => {}
  };
  const store = {
    updateLocalTask: () => {},
    getLocalTask: () => ({ local_video_path: tmpVideo }),
    listLocalTasks: () => []
  };
  const cloud = {
    renewLease: async () => ({}),
    progress: async () => ({}),
    saveSubmissionIntent: async () => ({})
  };
  const worker = new AssistantWorker({ config: { verificationWatchIntervalMs: 30, verificationWatchTimeoutMs: 5000 }, store, cloud, logger: { info() {}, warn() {}, error() {} } });
  const task = { id: 'task_watch1', attempt_id: 'attempt_1', platform: 'douyin', title: 't', description: 'd', topics: [], content_version: 'cv', account_id: 'acct' };
  worker.holdTask(task, adapter, 'login_or_verification', { type: 'login_required', message: '未登录' });

  const deadline = Date.now() + 3000;
  const hold = worker.heldTasks.get(task.id);
  while (hold.stage !== 'hold_before_submit' && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  assert.equal(hold.stage, 'hold_before_submit');
  assert.ok(loginChecks >= 3);
  clearInterval(hold.leaseTimer);
  clearInterval(hold.watchTimer);
});

test('F10：回传失败入 outbox，重放成功后清空', async () => {
  const { LocalStore } = require('../src/assistant/localStore');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qjw-outbox-'));
  const store = new LocalStore({ dataDir: dir, secretProtector: { protect: v => `x:${v}`, unprotect: v => v.slice(2) } });

  let failFirst = true;
  const cloud = {
    reportResult: async () => { if (failFirst) { failFirst = false; const e = new Error('network down'); throw e; } return {}; }
  };
  const worker = new AssistantWorker({ config: {}, store, cloud, logger: { info() {}, warn() {}, error() {} } });
  const task = { id: 'task_ob1', attempt_id: 'attempt_1' };
  store.saveBinding({ deviceId: 'dev1', deviceToken: 'tok', serviceUrl: 'http://127.0.0.1', subjectKey: 's' });
  worker.store.saveLocalTask({ id: task.id, platform: 'douyin', status: 'submitting', progress: 95 });

  await worker.reportSafely(task, 'outcome_unknown', { reason: 'x' }, { message: 'x' }, 'submit_token_x');
  assert.equal(store.listOutbox().length, 1);
  assert.equal(store.listOutbox()[0].submitToken, 'submit_token_x');

  await worker.replayOutbox();
  assert.equal(store.listOutbox().length, 0);
});
