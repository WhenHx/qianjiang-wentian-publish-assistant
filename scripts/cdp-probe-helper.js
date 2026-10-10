// CDP 探针共享工具：目标发现、连接、带超时的调用、表达式求值、截图
const fs = require('node:fs');

function requirePort(argv) {
  const port = argv[2];
  if (!port || !/^\d+$/.test(port)) {
    console.error('用法: node <probe>.js <cdp-port> [url包含串]');
    process.exit(1);
  }
  return port;
}

async function listTargets(port) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    return await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: ac.signal })).json();
  } finally {
    clearTimeout(timer);
  }
}

async function connect(port, urlIncludes = '') {
  const targets = await listTargets(port);
  const pages = targets.filter(t => t.type === 'page');
  console.log('候选页面:', pages.map(p => p.url.slice(0, 80)).join(' | '));
  const page = urlIncludes ? pages.find(t => t.url.includes(urlIncludes)) : pages[0];
  if (!page) throw new Error(`未找到页面目标（url 包含 "${urlIncludes}"）`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; setTimeout(() => rej(new Error('WebSocket 连接超时')), 5000); });
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}, timeoutMs = 10000) => Promise.race([
    new Promise(res => { const i = ++nextId; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); }),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`CDP 调用超时: ${method}`)), timeoutMs))
  ]);
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (r.error) throw new Error(`CDP 错误: ${r.error.message}`);
    if (r.result?.exceptionDetails) throw new Error(`页面脚本异常: ${JSON.stringify(r.result.exceptionDetails).slice(0, 200)}`);
    return r.result?.result?.value;
  };
  const screenshot = async file => {
    const r = await send('Page.captureScreenshot', { format: 'png' }, 15000);
    if (r.error) throw new Error(`截图失败: ${r.error.message}`);
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    console.log('已保存截图:', file);
  };
  const close = () => { try { ws.close(); } catch {} };
  return { page, send, evaluate, screenshot, close };
}

module.exports = { requirePort, connect, listTargets };
