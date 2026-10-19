// 一次性真机观测探针：挂载到指定 profile 的 Edge 调试端口，捕获发布期间的网络响应
// 用法：node scripts/probe-network-capture.js <profileDir关键字> <输出文件> [持续秒数]
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const { sleep } = require('../src/common/retry');

const profileKey = process.argv[2];
const outFile = process.argv[3] || 'runtime/network-capture.jsonl';
const durationSec = Number(process.argv[4] || 300);
if (!profileKey) {
  console.error('usage: node scripts/probe-network-capture.js <profileDir关键字> <输出文件> [持续秒数]');
  process.exit(1);
}

const BODY_URL_PATTERN = /aweme|create|publish|item|post|media|upload/i;

function findDebugPort() {
  const out = execSync(
    'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name=\'msedge.exe\'\\" | Select-Object -ExpandProperty CommandLine"',
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
  );
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes(profileKey)) continue;
    const m = line.match(/--remote-debugging-port=(\d+)/);
    if (m) return Number(m[1]);
  }
  return null;
}

async function main() {
  const deadline = Date.now() + durationSec * 1000;
  const out = fs.createWriteStream(outFile, { flags: 'a' });
  const log = record => out.write(JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n');

  let port = null;
  while (Date.now() < deadline) {
    port = findDebugPort();
    if (port) break;
    await sleep(1000);
  }
  if (!port) {
    log({ event: 'no_browser', profileKey });
    out.end();
    console.error('未找到目标浏览器调试端口');
    process.exit(2);
  }
  log({ event: 'attached_port', port });

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find(t => t.type === 'page' && t.url.includes('douyin')) || targets.find(t => t.type === 'page');
  if (!page) throw new Error('no page target');
  log({ event: 'attached_page', url: page.url });

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout ' + method)); }, 10000);
    pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const responses = new Map(); // requestId -> meta
  ws.addEventListener('message', async event => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result || {});
      return;
    }
    if (msg.method === 'Network.responseReceived') {
      const { requestId, response } = msg.params;
      responses.set(requestId, { url: response.url, status: response.status, mime: response.mimeType });
      if (BODY_URL_PATTERN.test(response.url) && /json/i.test(response.mimeType || '')) {
        log({ event: 'api_response_seen', requestId, url: response.url, status: response.status });
      }
    } else if (msg.method === 'Network.loadingFinished') {
      const { requestId } = msg.params;
      const meta = responses.get(requestId);
      responses.delete(requestId);
      if (!meta || !BODY_URL_PATTERN.test(meta.url) || !/json/i.test(meta.mime || '')) return;
      try {
        const body = await send('Network.getResponseBody', { requestId });
        const text = (body.body || '').slice(0, 4000);
        log({ event: 'api_response_body', url: meta.url, status: meta.status, body: text });
      } catch (e) {
        log({ event: 'api_response_body_failed', url: meta.url, error: String(e.message || e) });
      }
    }
  });

  await send('Network.enable');
  log({ event: 'network_enabled' });

  while (Date.now() < deadline) await sleep(1000);
  log({ event: 'capture_done' });
  out.end();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
