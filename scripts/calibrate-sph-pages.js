// 视频号评论/私信页结构校准
// 用法: node scripts/calibrate-sph-pages.js <cdp-port>
const path = require('node:path');
const { connect } = require('./cdp-probe-helper');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const EVAL_COMMENT = `(() => {
  const find = (root) => [...root.querySelectorAll('*')].find(e => e.children.length === 0 && /\\d{4}\\/\\d{2}\\/\\d{2}/.test(e.innerText || ''));
  const chainOf = (dateEl) => {
    const chain = [];
    let el = dateEl;
    for (let i = 0; i < 6 && el && el.tagName !== 'BODY'; i++) {
      chain.push(el.tagName + '.' + (el.className || '').toString().slice(0, 60));
      el = el.parentElement;
    }
    return chain;
  };
  let dateEl = find(document);
  let inIframe = false;
  if (!dateEl) {
    for (const f of document.querySelectorAll('iframe')) {
      try {
        if (f.contentDocument && (f.contentDocument.body || {}).innerText) {
          dateEl = find(f.contentDocument);
          if (dateEl) { inIframe = true; break; }
        }
      } catch (e) {}
    }
  }
  const count = (document.body.innerText || '').match(/共\\d+个/);
  return { dateFound: !!dateEl, inIframe, chain: dateEl ? chainOf(dateEl) : [], count: count && count[0] };
})()`;

const EVAL_DM = `(() => {
  const body = (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 300);
  const tabs = [...document.querySelectorAll('*')]
    .filter(e => e.children.length === 0 && ['私信', '打招呼消息'].includes((e.innerText || '').trim()))
    .map(e => ({ cls: (e.className || '').toString().slice(0, 60), text: (e.innerText || '').trim() }));
  const lists = [...document.querySelectorAll('[class*=list],[class*=List],[class*=chat],[class*=Chat],[class*=msg],[class*=Msg]')]
    .slice(0, 12).map(e => (e.className || '').toString().slice(0, 65));
  return { body, tabs, lists };
})()`;

async function main() {
  const port = process.argv[2] || '9302';
  const cdp = await connect(port);

  console.log('=== 评论管理页 ===');
  await cdp.send('Page.navigate', { url: 'https://channels.weixin.qq.com/platform/interaction/comment' });
  await sleep(10000);
  const c = await cdp.evaluate(EVAL_COMMENT);
  console.log(JSON.stringify(c, null, 1));
  await cdp.screenshot(path.join(__dirname, '..', 'acceptance', '探测-私信入口', 'sph-comment-cal.png'));

  console.log('=== 私信管理页 ===');
  await cdp.send('Page.navigate', { url: 'https://channels.weixin.qq.com/platform/private_msg' });
  await sleep(10000);
  const d = await cdp.evaluate(EVAL_DM);
  console.log('正文:', d.body);
  console.log('tabs:', JSON.stringify(d.tabs));
  console.log('列表类:', d.lists.join(' ; '));
  await cdp.screenshot(path.join(__dirname, '..', 'acceptance', '探测-私信入口', 'sph-dm-cal.png'));
  cdp.close();
}

main().catch(e => { console.error('校准失败:', e.message); process.exit(1); });
