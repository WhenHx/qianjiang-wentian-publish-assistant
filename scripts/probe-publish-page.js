// 探测发布页的输入框与按钮结构
// 用法: node scripts/probe-publish-page.js <cdp-port> <url包含串>
const { requirePort, connect } = require('./cdp-probe-helper');

async function main() {
  const port = requirePort(process.argv);
  const urlIncludes = process.argv[3] || '';
  if (!urlIncludes) { console.error('需要 url 包含串以避免探错页面'); process.exit(1); }
  const { evaluate, close } = await connect(port, urlIncludes);

  console.log(JSON.stringify(await evaluate(`(() => {
    const inputs = [...document.querySelectorAll('input, textarea, [contenteditable=true]')].map(el => ({
      tag: el.tagName.toLowerCase(),
      type: el.type || '',
      placeholder: el.placeholder || '',
      cls: String(el.className || '').slice(0, 60),
      text: (el.value ?? el.innerText ?? '').slice(0, 40)
    }));
    const buttons = [...document.querySelectorAll('button')].map(b => ({
      text: (b.innerText || '').trim().slice(0, 20),
      disabled: b.disabled,
      cls: String(b.className || '').slice(0, 60)
    })).filter(b => /发布|提交|发表|声明|知道/.test(b.text));
    const customEls = [...document.querySelectorAll('*')].filter(el => el.tagName.includes('-')).map(el => el.tagName.toLowerCase()).slice(0, 10);
    return { url: location.href, inputs, buttons, customEls };
  })()`), null, 2));
  close();
  process.exit(0);
}

main().catch(e => { console.error('ERR', e.message); process.exit(1); });
