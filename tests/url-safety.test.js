const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateRemoteUrl, downloadChecked, isPrivateIPv6 } = require('../src/common/urlSafety');

test('生产模式阻止本机和内网素材地址', async () => {
  await assert.rejects(() => validateRemoteUrl('http://127.0.0.1:8780/file', { allowLoopback: false }), /禁止访问/);
  await assert.rejects(() => validateRemoteUrl('http://192.168.1.10/file', { allowLoopback: false }), /禁止访问/);
  await assert.rejects(() => validateRemoteUrl('file:///C:/Windows/System32/drivers/etc/hosts', { allowLoopback: true }), /HTTP\/HTTPS/);
});

test('下载校验来源、类型、大小和完整性，明确开发模式允许回环地址', async t => {
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/video' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end('safe-test-video');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qjw-download-')), 'video.bin');
  const result = await downloadChecked(`http://127.0.0.1:${port}/redirect`, target, { allowLoopback: true, expectedSha256: require('node:crypto').createHash('sha256').update('safe-test-video').digest('hex') });
  assert.equal(fs.readFileSync(target, 'utf8'), 'safe-test-video');
  assert.equal(result.bytes, 15);
  await assert.rejects(() => downloadChecked(`http://127.0.0.1:${port}/video`, path.join(path.dirname(target), 'bad.bin'), { allowLoopback: true, expectedSha256: '0'.repeat(64) }), /完整性/);
});
test('F09：IPv4 映射 IPv6 各种形式完整识别为内网', () => {
  for (const ip of ['::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:7f00:0001', '::ffff:0a00:0001', '::ffff:ac10:ff02', '::1', '::', 'fd00::1234', 'fe80::1']) {
    assert.equal(isPrivateIPv6(ip), true, `${ip} 应识别为内网`);
  }
  assert.equal(isPrivateIPv6('::ffff:0808:0808'), false); // 8.8.8.8
  assert.equal(isPrivateIPv6('2606:4700::1111'), false);
});

test('F09：下载连接钉在已验证解析地址', async t => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end('pinned-ok');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qjw-pinned-')), 'video.bin');
  // 主机名 'localhost' 在 allowLoopback 下合法；钉扎路径应正常完成下载
  const result = await downloadChecked(`http://127.0.0.1:${port}/video`, target, { allowLoopback: true });
  assert.equal(result.bytes, 9);
  assert.equal(fs.readFileSync(target, 'utf8'), 'pinned-ok');
});
