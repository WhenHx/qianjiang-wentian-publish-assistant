// 视频号发表入口探针：找到发布按钮，点击，观察跳转与文件输入框
const port = process.argv[2];

async function main() {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 8000);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: ac.signal })).json();
  const page = targets.find(t => t.type === 'page' && t.url.includes('channels.weixin.qq.com'));
  if (!page) throw new Error('no shipinhao page');
  console.log('page:', page.url);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; setTimeout(() => rej(new Error('ws timeout')), 5000); });
  let id = 0; const pending = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}, timeoutMs = 10000) => Promise.race([
    new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('cdp timeout: ' + method)), timeoutMs))
  ]);
  const ev2 = async e => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 200));
    return r.result?.result?.value;
  };

  // 找发布入口
  const entry = await ev2(`(() => {
    const els = [...document.querySelectorAll('*')].filter(el => el.children.length === 0 && /^(发表动态|发表视频|发表)$/.test((el.textContent||'').trim()));
    return els.map(el => ({ tag: el.tagName, text: el.textContent.trim(), cls: (el.className||'').slice(0,60) }));
  })()`);
  console.log('entries:', JSON.stringify(entry));

  if (entry && entry.length) {
    await ev2(`(() => {
      const els = [...document.querySelectorAll('*')].filter(el => el.children.length === 0 && /^(发表动态|发表视频|发表)$/.test((el.textContent||'').trim()));
      const el = els[0];
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    })()`);
    await new Promise(r => setTimeout(r, 5000));
    const after = await ev2(`(() => ({
      url: location.href,
      fileInputs: [...document.querySelectorAll('input[type=file]')].map(i => ({ cls: (i.className||'').slice(0,60), accept: i.accept })),
      text: document.body.textContent.replace(/\\s+/g,' ').slice(0, 250)
    }))()`);
    console.log('after click:', JSON.stringify(after, null, 2));
  }
  ws.close();
  process.exit(0);
}

main().catch(e => { console.error('ERR', e.message); process.exit(1); });
