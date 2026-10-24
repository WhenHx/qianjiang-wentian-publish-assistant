// 捕获抖音评论发布请求的完整凭据（ticket/ts_sign/dtrait 等写接口强校验参数）
// 用法: node scripts/capture-comment-publish.js <cdp-port> <输出文件> [持续秒数]
// 开着本探针，然后走一次 UI 回复评论（任意一条），抓到后立即落盘退出。
const fs = require('node:fs');
const { connect } = require('./cdp-probe-helper');

const port = process.argv[2];
const outFile = process.argv[3] || 'runtime/comment-publish-capture.json';
const durationSec = Number(process.argv[4] || 120);

if (!port) {
  console.error('用法: node scripts/capture-comment-publish.js <cdp-port> <输出文件> [持续秒数]');
  process.exit(1);
}

const PATTERN = /comment\/publish/;

async function main() {
  const cdp = await connect(port);
  await cdp.send('Network.enable');
  console.log('已挂载网络监听，等待评论发布请求...');

  const requests = new Map();
  const deadline = Date.now() + durationSec * 1000;

  const ws = cdp; // probe helper 的 cdp 对象没有事件接口，直接用原生 ws 不行——换：直接连原始 websocket
  // probe helper 不支持事件监听，这里改为轮询 performance 日志不可行；直接用原生 WebSocket 重连
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find(t => t.type === 'page' && t.url.includes('www.douyin.com/video/')) || targets.find(t => t.type === 'page' && t.url.includes('douyin'));
  const ws2 = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws2.onopen = res; ws2.onerror = rej; });
  await new Promise(res => {
    ws2.send(JSON.stringify({ id: 1, method: 'Network.enable' }));
    ws2.onmessage = () => res();
  });

  ws2.onmessage = async ev => {
    const m = JSON.parse(ev.data);
    if (m.method !== 'Network.requestWillBeSent') return;
    const { requestId, request } = m.params;
    if (!PATTERN.test(request.url)) return;
    const record = {
      at: new Date().toISOString(),
      url: request.url,
      method: request.method,
      headers: request.headers,
      postData: request.postData || null
    };
    fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
    console.log('抓到评论发布请求:', request.url.slice(0, 100));
    console.log('凭据已写入', outFile);
    ws2.close();
    process.exit(0);
  };

  setTimeout(() => {
    console.log('超时未抓到，退出');
    process.exit(2);
  }, durationSec * 1000);
}

main().catch(e => { console.error(e.message); process.exit(1); });
