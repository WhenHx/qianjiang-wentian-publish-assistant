// 页面结构探针：连接已登录的 CDP 端口，导航到目标 URL，
// 提取包含关键词的可交互元素（链接/按钮/菜单项），截图存档。
// 用法: node scripts/probe-page.js <port> <url> [关键词,逗号分隔]
const path = require('node:path');
const fs = require('node:fs');
const { connect } = require('./cdp-probe-helper');

const OUT = path.join(__dirname, '..', 'acceptance', '探测-私信入口');

async function main() {
  const [port, url, kwArg] = process.argv.slice(2);
  if (!port || !url) {
    console.error('用法: node scripts/probe-page.js <port> <url> [关键词,逗号分隔]');
    process.exit(1);
  }
  const keywords = kwArg ? kwArg.split(',') : ['私信', '消息', '评论', '回复', '互动'];
  fs.mkdirSync(OUT, { recursive: true });

  const cdp = await connect(port);
  await cdp.send('Page.navigate', { url });
  await new Promise(r => setTimeout(r, 8000));

  const info = await cdp.evaluate(`(() => {
    const kws = ${JSON.stringify(keywords)};
    const els = [...document.querySelectorAll('a,button,[role=button],[role=menuitem],li,span,div')]
      .filter(e => {
        const t = (e.innerText || '').trim();
        return t && t.length < 30 && kws.some(k => t.includes(k)) && e.children.length < 4;
      })
      .map(e => ({ tag: e.tagName, text: (e.innerText || '').trim().slice(0, 25), cls: (e.className || '').toString().slice(0, 60) }));
    const uniq = [];
    const seen = new Set();
    for (const e of els) { const k = e.text + '|' + e.cls; if (!seen.has(k)) { seen.add(k); uniq.push(e); } }
    return { title: document.title, url: location.href, elements: uniq.slice(0, 40) };
  })()`);
  console.log('标题:', info.title, '| URL:', info.url);
  for (const e of info.elements) console.log(`  [${e.tag}] "${e.text}" cls=${e.cls}`);
  const name = url.replace(/[^a-z0-9]/gi, '_').slice(0, 60);
  await cdp.screenshot(path.join(OUT, `page-${name}.png`));
  cdp.close();
}

main().catch(e => { console.error('探测失败:', e.message); process.exit(1); });
