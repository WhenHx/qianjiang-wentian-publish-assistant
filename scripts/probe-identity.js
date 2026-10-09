// 一次性校准探针：读取登录后的抖音创作者中心页面结构，寻找稳定身份元素
const port = process.argv[2];

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('no page target');
  console.log('page:', page.url);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, msg => msg.error ? rej(new Error(msg.error.message)) : res(msg.result));
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result?.value;
  };

  console.log('title:', await evaluate('document.title'));
  console.log('readyState:', await evaluate('document.readyState'));

  const info = await evaluate(`(() => {
    const out = {};
    out.bodyTextSample = (document.body?.innerText || '').slice(0, 400);
    out.indicators = ['发布视频','内容管理','创作者服务中心','发布作品','上传视频'].map(s => ({ s, hit: (document.body?.innerText || '').includes(s) }));
    out.dataE2e = [...document.querySelectorAll('[data-e2e]')].slice(0, 40).map(el => el.getAttribute('data-e2e'));
    out.avatarImgs = [...document.querySelectorAll('img')].filter(i => /avatar|head|profile|user/i.test(i.className + ' ' + i.src)).slice(0, 5).map(i => ({ cls: i.className.slice(0, 60), alt: i.alt }));
    out.classCandidates = [...document.querySelectorAll('[class]')].map(el => el.className).filter(c => typeof c === 'string' && /nick|user[-_]?name|account|avatar|unique/i.test(c)).slice(0, 20);
    return out;
  })()`);
  console.log(JSON.stringify(info, null, 2));
  ws.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
