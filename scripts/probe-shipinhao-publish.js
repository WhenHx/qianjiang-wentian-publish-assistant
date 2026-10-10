// 微前端/iframe 平台探针：检查 frame 内的表单结构
// 用法: node scripts/probe-shipinhao-publish.js <cdp-port> <url包含串> [frame选择器]
const { requirePort, connect } = require('./cdp-probe-helper');

async function main() {
  const port = requirePort(process.argv);
  const urlIncludes = process.argv[3] || 'channels.weixin.qq.com';
  const frameSelector = process.argv[4] || 'iframe[name=content]';
  const { evaluate, close } = await connect(port, urlIncludes);

  console.log(JSON.stringify(await evaluate(`(() => {
    const f = document.querySelector(${JSON.stringify(frameSelector)});
    if (!f) return { frame: false };
    if (!f.contentDocument) return { frame: true, blocked: true };
    const doc = f.contentDocument;
    return {
      frame: true,
      fileInputs: [...doc.querySelectorAll('input[type=file]')].map(i => ({ cls: String(i.className||'').slice(0,60), accept: i.accept || '' })),
      inputs: [...doc.querySelectorAll('input[type=text], input:not([type])')].map(i => ({ ph: i.placeholder || '', cls: String(i.className||'').slice(0,50) })).slice(0, 10),
      editables: [...doc.querySelectorAll('[contenteditable=true]')].map(e => String(e.className||'').slice(0,50)),
      text: (doc.body.innerText || '').slice(0, 250)
    };
  })()`), null, 2));
  close();
  process.exit(0);
}

main().catch(e => { console.error('ERR', e.message); process.exit(1); });
