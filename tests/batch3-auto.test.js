const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AssistantWorker } = require('../src/assistant/worker');
const { ConfigurableCdpAdapter } = require('../src/assistant/platforms/configurableCdpAdapter');

function adapterWithBrowser(browser) {
  const account = { account_key: 'localacct_t1', platform: 'douyin', nickname: '测试', platform_identity: 'identity-A', profile_dir: 'x' };
  const adapter = new ConfigurableCdpAdapter({ platform: 'douyin', account, browserName: 'edge', logger: null });
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

  // 一直忙碌 → 超时
  const busy = adapterWithBrowser({
    bodyText: async () => '上传中 45%',
    evaluate: async () => true
  });
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
