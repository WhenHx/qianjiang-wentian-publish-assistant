// 视频号评论回复按钮状态诊断：逐步带日志，防挂起（每步 15 秒硬超时）
// 用法: node scripts/diag-sph-comment.js
const { connect } = require('./cdp-probe-helper');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => { console.log(new Date().toISOString().slice(11, 19), ...a); };

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`步骤超时: ${label}`)), ms))
  ]);
}

async function main() {
  const cdp = await withTimeout(connect('9302'), 15000, '连接');
  log('已连接');
  const ev = (expr) => cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }, 15000).then(r => r.result?.result?.value);
  const docExpr = `[...document.querySelectorAll('iframe')].map(f => { try { return f.contentDocument; } catch(e) { return null; } }).find(x => x && x.body)`;

  log('1. 打开有评论作品...');
  const wn = await withTimeout(ev(`(() => {
    const doc = ${docExpr};
    if (!doc) return 'no-doc';
    const items = [...doc.querySelectorAll('.comment-feed-wrap')];
    const target = items.find(w => { const t = ((w.querySelector('.feed-comment-total') || {}).innerText || '').trim(); return parseInt(t, 10) > 0; });
    if (!target) return 'no-work';
    target.click();
    return 'clicked';
  })()`), 15000, '打开作品');
  log('  ->', wn);
  await sleep(5000);

  log('2. 点回复...');
  const opened = await withTimeout(ev(`(() => {
    const doc = ${docExpr};
    if (!doc) return 'no-doc';
    const item = [...doc.querySelectorAll('.comment-item')].find(i => (i.innerText || '').includes('訢'));
    if (!item) return 'no-item';
    const btn = [...item.querySelectorAll('*')].find(e => (e.innerText || '').trim() === '回复');
    if (!btn) return 'no-btn';
    btn.click();
    return 'clicked';
  })()`), 15000, '点回复');
  log('  ->', opened);
  await sleep(3000);

  log('3. 填内容（事件方式）...');
  const filled = await withTimeout(ev(`(() => {
    const doc = ${docExpr};
    const ta = doc && doc.querySelector('textarea.create-input');
    if (!ta) return 'no-textarea';
    ta.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '测试回复内容');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return ta.value;
  })()`), 15000, '填内容');
  log('  ->', JSON.stringify(filled));
  await sleep(1500);

  log('4. 按钮状态...');
  const st = await withTimeout(ev(`(() => {
    const doc = ${docExpr};
    if (!doc) return 'no-doc';
    return [...doc.querySelectorAll('button')].filter(b => (b.innerText || '').trim() === '评论').map(b => ({ disabled: b.disabled, cls: (b.className || '').slice(0, 70) }));
  })()`), 15000, '按钮状态');
  log('  ->', JSON.stringify(st));
  cdp.close();
  log('完成');
  process.exit(0);
}

main().catch(e => { console.error('失败:', e.message); process.exit(1); });
