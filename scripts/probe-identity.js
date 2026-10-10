// 校准探针：读取已登录平台页面的身份元素与登录指示器
// 用法: node scripts/probe-identity.js <cdp-port> <url包含串> [平台]
const { requirePort, connect } = require('./cdp-probe-helper');

async function main() {
  const port = requirePort(process.argv);
  const urlIncludes = process.argv[3] || '';
  const platform = process.argv[4] || '';
  const { evaluate, close } = await connect(port, urlIncludes);

  let indicators = [];
  if (platform) {
    try {
      const cfg = JSON.parse(require('node:fs').readFileSync(require('node:path').resolve('config/platform-selectors.json'), 'utf8'));
      indicators = cfg[platform]?.loggedInIndicators || [];
    } catch {}
  }

  console.log('title:', await evaluate('document.title'));
  console.log('readyState:', await evaluate('document.readyState'));
  console.log(JSON.stringify(await evaluate(`(() => {
    const out = {};
    out.bodyTextSample = (document.body?.innerText || '').slice(0, 400);
    out.indicators = ${JSON.stringify(indicators)}.map(s => ({ s, hit: (document.body?.innerText || '').includes(s) }));
    out.dataE2e = [...document.querySelectorAll('[data-e2e]')].slice(0, 40).map(el => el.getAttribute('data-e2e'));
    out.avatarImgs = [...document.querySelectorAll('img')].filter(i => /avatar|head|profile|user/i.test(i.className + ' ' + i.src)).slice(0, 5).map(i => ({ cls: i.className.slice(0, 60), alt: i.alt }));
    out.classCandidates = [...document.querySelectorAll('[class]')].map(el => el.className).filter(c => typeof c === 'string' && /nick|user[-_]?name|account|avatar|unique/i.test(c)).slice(0, 20);
    return out;
  })()`), null, 2));
  close();
  process.exit(0);
}

main().catch(e => { console.error('ERR', e.message); process.exit(1); });
