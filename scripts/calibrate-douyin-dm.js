// 抖音私信面板校准脚本：打开消息面板 → 枚举会话 → 打开首个会话 → 读消息气泡与输入框结构
// 用法: node scripts/calibrate-douyin-dm.js <cdp-port>
const path = require('node:path');
const { connect } = require('./cdp-probe-helper');

const OUT = path.join(__dirname, '..', 'acceptance', '探测-私信入口');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function clickAt(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await sleep(80);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(80);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function findTextPos(cdp, text, { maxY = 99999, minX = 0 } = {}) {
  return cdp.evaluate(`(() => {
    const el = [...document.querySelectorAll('li,div,span,p')].find(e => {
      const t = (e.innerText || '').trim();
      if (t !== ${JSON.stringify(text)}) return false;
      const r = e.getBoundingClientRect();
      return r.y < ${maxY} && r.x >= ${minX} && r.width > 0;
    });
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
}

async function main() {
  const port = process.argv[2] || '9301';
  const cdp = await connect(port);

  // 确保窗口够宽
  const win = await cdp.send('Browser.getWindowForTarget', {});
  await cdp.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { left: 50, top: 30, width: 1500, height: 950 } });
  await sleep(1500);

  // 1. 打开消息面板
  let pos = await findTextPos(cdp, '消息', { maxY: 60 });
  console.log('消息按钮:', JSON.stringify(pos));
  if (!pos) throw new Error('找不到消息按钮');
  await clickAt(cdp, pos.x, pos.y);
  await sleep(4000);

  // 2. 枚举会话列表（语义类名 conversationConversationItem*）
  const convos = await cdp.evaluate(`[...document.querySelectorAll('[class*=conversationConversationItemwrapper]')]
    .map(e => {
      const r = e.getBoundingClientRect();
      return { text: (e.innerText || '').replace(/\\s+/g, ' ').slice(0, 80), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width) };
    })`);
  console.log('会话数:', convos.length);
  convos.forEach(c => console.log('  ', JSON.stringify(c)));
  if (!convos.length) throw new Error('会话列表为空（面板可能没打开）');

  // 3. 打开第一个会话
  await clickAt(cdp, convos[0].x, convos[0].y);
  await sleep(5000);

  // 4. 读聊天区结构
  const chat = await cdp.evaluate(`(() => {
    const ce = document.querySelector('[contenteditable=true]');
    // 消息气泡：面板区域内包含文本的叶子元素
    const all = [...document.querySelectorAll('*')];
    const texts = all.filter(e => e.children.length === 0 && (e.innerText || '').trim().length > 1 && e.getBoundingClientRect().x > 500)
      .slice(-15)
      .map(e => ({ cls: (e.className || '').toString().slice(0, 60), text: (e.innerText || '').trim().slice(0, 30) }));
    return {
      input: ce ? { tag: ce.tagName, cls: (ce.className || '').toString().slice(0, 70), rect: ce.getBoundingClientRect().toJSON() } : null,
      texts
    };
  })()`);
  console.log('输入框:', JSON.stringify(chat.input));
  console.log('聊天区文本元素:');
  chat.texts.forEach(t => console.log('  ', t.cls, '|', t.text));

  await cdp.screenshot(path.join(OUT, 'douyin-dm-calibrated.png'));
  cdp.close();
}

main().catch(e => { console.error('校准失败:', e.message); process.exit(1); });
