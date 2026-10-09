// 探测发布页的标题输入框与发布按钮结构
const port = process.argv[2];

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find(t => t.type === 'page' && t.url.includes('creator.douyin.com'));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;

  const out = await evaluate(`(() => {
    const inputs = [...document.querySelectorAll('input, textarea, [contenteditable=true]')].map(el => ({
      tag: el.tagName.toLowerCase(),
      type: el.type || '',
      placeholder: el.placeholder || '',
      cls: (el.className || '').slice(0, 60),
      text: (el.value ?? el.innerText ?? '').slice(0, 40)
    }));
    const buttons = [...document.querySelectorAll('button')].map(b => ({
      text: (b.innerText || '').trim().slice(0, 20),
      disabled: b.disabled,
      cls: (b.className || '').slice(0, 60)
    })).filter(b => /发布|提交|发表|声明|知道/.test(b.text));
    return { inputs, buttons };
  })()`);
  console.log(JSON.stringify(out, null, 2));
  ws.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
