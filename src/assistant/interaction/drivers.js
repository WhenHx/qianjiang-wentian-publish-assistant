// 互动回复的页面驱动：在已登录平台页面上读取私信/评论并发送回复。
// 选择器来自 2026-10 真机校准（见 acceptance/探测-私信入口/）：
// - 抖音私信：完整校准（会话列表/气泡/输入框）
// - 抖音评论：发送链路已校准；评论条目「回复」按钮待真实评论数据校准
// - 视频号：评论作品列表已校准（wujie iframe 穿透）；私信会话/评论条目待真实数据校准
// 未校准路径一律安全失败（抛错由上层记日志），不会误操作。
const { sleep } = require('../../common/retry');

async function evaluate(page, expression) {
  const r = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`页面脚本异常: ${JSON.stringify(r.exceptionDetails).slice(0, 200)}`);
  return r.result?.value;
}

async function clickAt(page, x, y) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await sleep(80);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(80);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function clickText(page, text, { maxY = 99999 } = {}) {
  const pos = await evaluate(page, `(() => {
    const el = [...document.querySelectorAll('li,div,span,p,a')].find(e => {
      const t = (e.innerText || '').trim();
      if (t !== ${JSON.stringify(text)}) return false;
      const r = e.getBoundingClientRect();
      return r.y < ${maxY} && r.width > 0;
    });
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!pos) throw new Error(`找不到可点击文本: ${text}`);
  await clickAt(page, pos.x, pos.y);
}

// 名字元素可能连带时间文本（"WhenHx\n09/16" 或 "WhenHx刚刚"），剥掉尾部时间
function normalizeName(text) {
  return (text || '').split('\n')[0]
    .replace(/(刚刚|昨天|今[天日]|\d+分钟前|\d+小时前|\d+天前|周[一二三四五六日]|\d{2}\/\d{2}|\d{1,2}:\d{2}|\d{4}\/\d{2}\/\d{2})+$/u, '')
    .trim();
}

// ---------- 抖音私信（2026-10-19 真机校准） ----------

class DouyinDmDriver {
  constructor(page) {
    this.page = page;
  }

  async openPanel() {
    await this.page.send('Page.navigate', { url: 'https://www.douyin.com/' });
    await sleep(6000);
    await clickText(this.page, '消息', { maxY: 60 });
    await sleep(4000);
    // 归一到会话列表视图：若停在聊天视图，点左上角返回箭头；若面板没开，再点一次「消息」
    for (let i = 0; i < 3; i++) {
      const hasList = await evaluate(this.page, `!!document.querySelector('[class*=conversationConversationListwrapper]')`);
      if (hasList) return;
      const inChat = await evaluate(this.page, `!!document.querySelector('[contenteditable=true][class*=messageEditorinputArea]')`);
      if (inChat) {
        // 返回箭头是聊天面板左上角的 svg；限定在右侧面板区域内，排除页面左上角的抖音 logo
        const back = await evaluate(this.page, `(() => {
          const minX = window.innerWidth - 480;
          const svgs = [...document.querySelectorAll('svg')].filter(e => { const r = e.getBoundingClientRect(); return r.y < 110 && r.x > minX && r.width > 0 && r.width < 50; });
          if (!svgs.length) return null;
          svgs.sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x);
          const r = svgs[0].getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        })()`);
        if (back) await clickAt(this.page, back.x, back.y);
        await sleep(2500);
      } else {
        await clickText(this.page, '消息', { maxY: 60 });
        await sleep(3000);
      }
    }
    throw new Error('消息面板未能进入会话列表视图');
  }

  async listConversations() {
    // 列表渲染可能滞后于面板打开，最多等 10 秒；条目必须有可见尺寸（面板关闭时 rect 为 0）
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const list = (await evaluate(this.page, `[...document.querySelectorAll('[class*=conversationConversationItemwrapper]')]
        .map(w => {
          const r = w.getBoundingClientRect();
          return {
            name: (w.querySelector('[class*=conversationConversationItemtitle]') || {}).innerText || '',
            preview: (w.querySelector('[class*=ConversationItemHinttextBox]') || {}).innerText || '',
            time: (w.querySelector('[class*=ConversationItemTagNextToTitletimeStr]') || {}).innerText || '',
            w: r.width, h: r.height
          };
        })
        .filter(c => c.name.trim() && c.w > 0)`)) || [];
      if (list.length) return list.map(c => ({ name: normalizeName(c.name), preview: c.preview, time: c.time }));
      await sleep(1000);
    }
    return [];
  }

  async openConversation(name) {
    // 列表渲染可能滞后，定位条目最多等 10 秒；条目必须有可见尺寸
    let pos = null;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !pos) {
      pos = await evaluate(this.page, `(() => {
        const items = [...document.querySelectorAll('[class*=conversationConversationItemwrapper]')];
        const norm = t => (t || '').split('\\n')[0].replace(/(刚刚|昨天|今[天日]|\\d+分钟前|\\d+小时前|\\d+天前|周[一二三四五六日]|\\d{2}\\/\\d{2}|\\d{1,2}:\\d{2}|\\d{4}\\/\\d{2}\\/\\d{2})+$/u, '').trim();
        const item = items.find(w => {
          const r = w.getBoundingClientRect();
          if (r.width === 0) return false;
          return norm((w.querySelector('[class*=conversationConversationItemtitle]') || {}).innerText || '') === ${JSON.stringify(name)};
        });
        if (!item) return null;
        const r = item.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (!pos) await sleep(1000);
    }
    if (!pos) throw new Error(`会话不存在: ${name}`);
    // 点击可能不生效（MMUI 自绘列表），点开以输入框出现为准，最多重试 2 次
    for (let attempt = 0; attempt < 2; attempt++) {
      await clickAt(this.page, pos.x, pos.y);
      await sleep(5000);
      const opened = await evaluate(this.page, `!!document.querySelector('[contenteditable=true][class*=messageEditorinputArea]')`);
      if (opened) return;
    }
    throw new Error(`会话点击未生效: ${name}`);
  }

  // 会话一致性校验：聊天区最近几条气泡应包含列表预览的消息（预览可能截断），否则说明开错了会话
  // 气泡渲染可能较慢，最多等 12 秒
  async verifyConversation(preview) {
    const core = (preview || '').replace(/[…\s]+$/u, '').trim();
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const recent = await this.readRecentTexts(4);
      if (recent.length) {
        if (!core || core.startsWith('[')) return true; // 非文本预览无法校验，放行
        return recent.some(t => t.startsWith(core.slice(0, 12)) || core.startsWith(t.slice(0, 12)));
      }
      await sleep(1500);
    }
    throw new Error('会话打开校验失败：聊天区无消息');
  }

  // 读取气泡文本（首尾各 n 条，DOM 顺序不稳定）
  async readRecentTexts(n = 4) {
    return (await evaluate(this.page, `(() => {
      const all = [...document.querySelectorAll('[class*=TextMessageTextpureText]')].map(b => (b.innerText || '').trim()).filter(Boolean);
      return [...new Set([...all.slice(0, ${n}), ...all.slice(-${n})])];
    })()`)) || [];
  }

  async readMessages() {
    return (await evaluate(this.page, `[...document.querySelectorAll('[class*=messageMessageBoxmessageBox]')]
      .map(b => ({
        fromMe: /isFromMe/.test((b.className || '').toString()) || !!b.querySelector('[class*=isFromMe]'),
        text: ((b.querySelector('[class*=TextMessageTextpureText]') || {}).innerText || '').trim()
      }))
      .filter(m => m.text)`)) || [];
  }

  async sendMessage(text) {
    const has = await evaluate(this.page, `!!document.querySelector('[contenteditable=true][class*=messageEditorinputArea]')`);
    if (!has) throw new Error('找不到私信输入框（会话可能未打开）');
    await evaluate(this.page, `document.querySelector('[contenteditable=true][class*=messageEditorinputArea]').focus()`);
    await sleep(300);
    await this.page.send('Input.insertText', { text });
    await sleep(500);
    // 回车发送
    await this.page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await this.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(2500);
    // 发送验证：最近两条气泡（DOM 顺序不稳定，首尾各查）存在已方且内容匹配的即视为发出
    const verified = await evaluate(this.page, `(() => {
      const boxes = [...document.querySelectorAll('[class*=messageMessageBoxmessageBox]')];
      if (!boxes.length) return false;
      const cands = [...new Set([...boxes.slice(0, 2), ...boxes.slice(-2)])];
      return cands.some(last => {
        const fromMe = /isFromMe/.test((last.className || '').toString()) || !!last.querySelector('[class*=isFromMe]');
        const t = ((last.querySelector('[class*=TextMessageTextpureText]') || {}).innerText || '').trim();
        return fromMe && t.length > 0 && ${JSON.stringify(text)}.slice(0, 20).startsWith(t.slice(0, 10));
      });
    })()`);
    if (!verified) {
      // 清掉输入框里可能残留的文字，避免下次误发
      try {
        await evaluate(this.page, `(() => { const i = document.querySelector('[contenteditable=true][class*=messageEditorinputArea]'); if (i) { i.focus(); i.innerHTML = ''; } })()`);
      } catch {}
      throw new Error('发送验证失败：最后一条气泡不是刚发送的内容，按未发出处理');
    }
  }
}

// ---------- 视频号私信/评论（wujie iframe，会话/评论条目待真实数据校准） ----------

const SPH_IFRAME_PIERCE = `(function findDoc() {
  for (const f of document.querySelectorAll('iframe')) {
    try { if (f.contentDocument && f.contentDocument.body) return f.contentDocument; } catch (e) {}
  }
  return null;
})()`;

class ShipinhaoDriver {
  constructor(page) {
    this.page = page;
  }

  async openDmPage() {
    await this.page.send('Page.navigate', { url: 'https://channels.weixin.qq.com/platform/private_msg' });
    await sleep(8000);
  }

  async openCommentPage() {
    await this.page.send('Page.navigate', { url: 'https://channels.weixin.qq.com/platform/interaction/comment' });
    await sleep(8000);
  }

  // iframe 文档定位
  async _doc() {
    return SPH_IFRAME_PIERCE;
  }

  // 读取两个 tab（私信 + 打招呼消息）的会话列表
  async listConversations() {
    const all = [];
    for (const tab of ['私信', '打招呼消息']) {
      const switched = await evaluate(this.page, `(() => {
        const doc = ${SPH_IFRAME_PIERCE};
        if (!doc) return false;
        const t = [...doc.querySelectorAll('.weui-desktop-tab__nav, .tab-title')].find(e => (e.innerText || '').trim() === ${JSON.stringify(tab)});
        if (t) { t.click(); return true; }
        return false;
      })()`);
      if (!switched) continue;
      await sleep(3000);
      const items = (await evaluate(this.page, `(() => {
        const doc = ${SPH_IFRAME_PIERCE};
        if (!doc) return [];
        return [...doc.querySelectorAll('.session-wrap')].map(s => ({
          name: ((s.querySelector('.feed-title .name') || {}).innerText || '').trim(),
          preview: (s.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
          time: ''
        })).filter(c => c.name);
      })()`)) || [];
      for (const c of items) all.push({ ...c, tab });
    }
    return all;
  }

  async openConversation(name) {
    // 会话可能在「私信」或「打招呼消息」tab，两个都找
    for (const tab of ['私信', '打招呼消息']) {
      await evaluate(this.page, `(() => {
        const doc = ${SPH_IFRAME_PIERCE};
        if (!doc) return;
        const t = [...doc.querySelectorAll('.weui-desktop-tab__nav, .tab-title')].find(e => (e.innerText || '').trim() === ${JSON.stringify(tab)});
        if (t) t.click();
      })()`);
      await sleep(2500);
      const clicked = await evaluate(this.page, `(() => {
        const doc = ${SPH_IFRAME_PIERCE};
        if (!doc) return false;
        const item = [...doc.querySelectorAll('.session-wrap')].find(s => ((s.querySelector('.feed-title .name') || {}).innerText || '').trim() === ${JSON.stringify(name)});
        if (!item) return false;
        item.click();
        return true;
      })()`);
      if (clicked) {
        await sleep(4000);
        return;
      }
    }
    throw new Error(`会话不存在: ${name}`);
  }

  async readMessages() {
    return (await evaluate(this.page, `(() => {
      const doc = ${SPH_IFRAME_PIERCE};
      if (!doc) return [];
      return [...doc.querySelectorAll('.bubble')].map(b => ({
        fromMe: (b.className || '').toString().includes('bubble-right'),
        text: ((b.querySelector('.message-plain') || b).innerText || '').trim()
      })).filter(m => m.text);
    })()`)) || [];
  }

  async sendMessage(text) {
    const has = await evaluate(this.page, `(() => { const doc = ${SPH_IFRAME_PIERCE}; return !!(doc && doc.querySelector('textarea.edit_area')); })()`);
    if (!has) throw new Error('找不到私信输入框（会话可能未打开）');
    await evaluate(this.page, `(() => { const doc = ${SPH_IFRAME_PIERCE}; const t = doc.querySelector('textarea.edit_area'); t.focus(); })()`);
    await sleep(300);
    await this.page.send('Input.insertText', { text });
    await sleep(500);
    // 视频号输入框：Enter 发送
    await this.page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await this.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(2500);
    // 发送验证：最后一条右侧气泡内容与发送内容一致
    const verified = await evaluate(this.page, `(() => {
      const doc = ${SPH_IFRAME_PIERCE};
      if (!doc) return false;
      const mine = [...doc.querySelectorAll('.bubble-right')];
      if (!mine.length) return false;
      const last = ((mine[mine.length - 1].querySelector('.message-plain') || mine[mine.length - 1]).innerText || '').trim();
      return last.length > 0 && ${JSON.stringify(text)}.slice(0, 20).startsWith(last.slice(0, 10));
    })()`);
    if (!verified) {
      try {
        await evaluate(this.page, `(() => { const doc = ${SPH_IFRAME_PIERCE}; const t = doc.querySelector('textarea.edit_area'); if (t) { t.focus(); t.value = ''; } })()`);
      } catch {}
      throw new Error('发送验证失败：最新已方气泡与发送内容不符，按未发出处理');
    }
  }

  async listCommentWorks() {
    return (await evaluate(this.page, `(() => {
      const doc = ${SPH_IFRAME_PIERCE};
      if (!doc) return [];
      return [...doc.querySelectorAll('.comment-feed-wrap')].map(w => ({
        name: ((w.querySelector('.feed-info') || {}).innerText || '').trim().slice(0, 60),
        time: ((w.querySelector('.feed-time') || {}).innerText || '').trim(),
        unread: ((w.querySelector('.unread-comment-number') || {}).innerText || '').trim(),
        total: ((w.querySelector('.feed-comment-total') || {}).innerText || '').trim()
      })).filter(w => w.name);
    })()`)) || [];
  }

  // 打开有评论的作品（评论数 > 0 优先）
  // 打开有评论的作品（评论数 > 0 优先），返回作品标识（发布时间，稳定）；没有则 false
  async openWorkWithComments() {
    return (await evaluate(this.page, `(() => {
      const doc = ${SPH_IFRAME_PIERCE};
      if (!doc) return false;
      const items = [...doc.querySelectorAll('.comment-feed-wrap')];
      const target = items.find(w => { const t = ((w.querySelector('.feed-comment-total') || {}).innerText || '').trim(); return parseInt(t, 10) > 0; });
      if (!target) return false;
      target.click();
      // 作品名会带评论数后缀（"2026/10/21 18:07\\n1"），去掉数字尾巴保持稳定
      const raw = ((target.querySelector('.feed-info') || {}).innerText || '').trim();
      return raw.replace(/\\n\\d+$/u, '').slice(0, 60) || true;
    })()`)) || false;
  }

  // 按名字打开作品（发送时定位用）
  async openWorkByName(name) {
    return (await evaluate(this.page, `(() => {
      const doc = ${SPH_IFRAME_PIERCE};
      if (!doc) return false;
      const items = [...doc.querySelectorAll('.comment-feed-wrap')];
      const target = items.find(w => ((w.querySelector('.feed-info') || {}).innerText || '').trim().replace(/\\n\\d+$/u, '').includes(${JSON.stringify(name.slice(0, 20))}));
      if (!target) return false;
      target.click();
      return true;
    })()`)) || false;
  }

  async listComments() {
    // 条目叶子文本顺序：名字、时间(yyyy/MM/dd)、内容、操作词（点赞/回复/删除…），以时间锚定内容
    // 排除作者自己的回复（带「作者」标记的条目）
    return (await evaluate(this.page, `(() => {
      const doc = ${SPH_IFRAME_PIERCE};
      if (!doc) return [];
      return [...doc.querySelectorAll('.comment-item')].map(item => {
        const texts = [...item.querySelectorAll('*')].filter(e => e.children.length === 0 && (e.innerText || '').trim()).map(e => (e.innerText || '').trim());
        const isAuthorReply = texts.includes('作者');
        const timeIdx = texts.findIndex(t => /^\\d{4}\\/\\d{2}\\/\\d{2}/.test(t));
        const name = texts[0] || '';
        const text = timeIdx > 0 && texts[timeIdx + 1] ? texts[timeIdx + 1] : '';
        return { name, text, time: timeIdx > 0 ? texts[timeIdx] : '', isAuthorReply };
      }).filter(c => c.name && c.text && !c.isAuthorReply);
    })()`)) || [];
  }

  async replyComment(peer, text) {
    // 点开目标评论的回复框
    const opened = await evaluate(this.page, `(() => {
      const doc = ${SPH_IFRAME_PIERCE};
      if (!doc) return false;
      const item = [...doc.querySelectorAll('.comment-item')].find(i => (i.innerText || '').includes(${JSON.stringify(peer)}));
      if (!item) return false;
      const btn = [...item.querySelectorAll('*')].find(e => (e.innerText || '').trim() === '回复');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    if (!opened) throw new Error(`找不到评论或回复入口: ${peer}`);
    // 回复框可能因重复点击被关掉；确认打开，最多补点一次
    let boxOpen = false;
    for (let i = 0; i < 2; i++) {
      await sleep(2500);
      boxOpen = await evaluate(this.page, `(() => {
        const doc = ${SPH_IFRAME_PIERCE};
        const ta = doc && doc.querySelector('textarea.create-input');
        return !!(ta && (ta.placeholder || '').includes(${JSON.stringify(peer)}));
      })()`);
      if (boxOpen) break;
      await evaluate(this.page, `(() => {
        const doc = ${SPH_IFRAME_PIERCE};
        if (!doc) return;
        const item = [...doc.querySelectorAll('.comment-item')].find(i2 => (i2.innerText || '').includes(${JSON.stringify(peer)}));
        const btn = item && [...item.querySelectorAll('*')].find(e => (e.innerText || '').trim() === '回复');
        if (btn) btn.click();
      })()`);
    }
    if (!boxOpen) throw new Error(`回复框未打开或目标校验失败：预期回复 ${peer}`);
    // 事件方式填充（React 受控输入，CDP insertText 可能不触发按钮启用）
    await evaluate(this.page, `(() => {
      const doc = ${SPH_IFRAME_PIERCE};
      const ta = doc.querySelector('textarea.create-input');
      ta.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    // 发送按钮是 div.tag-wrap 或 button，文字「评论」，可能不止一个；取回复框容器内可用的那个
    const sendExpr = `(() => {
      const doc = ${SPH_IFRAME_PIERCE};
      if (!doc) return false;
      const ta = doc.querySelector('textarea.create-input');
      if (!ta) return false;
      let scope = ta;
      for (let i = 0; i < 6 && scope.parentElement; i++) scope = scope.parentElement;
      const cands = [...scope.querySelectorAll('button, [class*=btn], [class*=tag-wrap]')]
        .filter(b => (b.innerText || '').trim() === '评论');
      const btn = cands.find(b => !b.disabled && !/disabled/.test((b.className || '').toString()));
      if (!btn) return false;
      btn.click();
      return true;
    })()`;
    let sent = false;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      sent = await evaluate(this.page, sendExpr);
      if (sent) break;
      await sleep(500);
    }
    if (!sent) throw new Error('「评论」发送按钮不可用');
    await sleep(3000);
    // 发送验证：评论区应出现刚发送的内容
    const verified = await evaluate(this.page, `(() => {
      const doc = ${SPH_IFRAME_PIERCE};
      if (!doc) return false;
      return [...doc.querySelectorAll('.comment-item, .comment-reply-list *')].some(e => (e.innerText || '').trim().startsWith(${JSON.stringify(text.slice(0, 10))}));
    })()`);
    if (!verified) throw new Error('回复验证失败：评论区未出现刚发送的内容');
  }
}

class DouyinCommentDriver {
  constructor(page) {
    this.page = page;
  }

  async openCommentPage() {
    await this.page.send('Page.navigate', { url: 'https://creator.douyin.com/creator-micro/interactive/comment' });
    await sleep(8000);
  }

  // 当前选中作品名（评论区顶部的作品卡）
  async currentWorkName() {
    return (await evaluate(this.page, `(() => {
      const el = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && /\\d{4}年\\d{2}月\\d{2}日/.test(e.innerText || ''));
      return el ? (el.innerText || '').trim() : null;
    })()`)) || null;
  }

  async listComments() {
    // 评论条目：username-* 作者 + comment-content-text 内容 + time-* 时间
    return (await evaluate(this.page, `(() => {
      const items = [...document.querySelectorAll('[class*=comment-content-text]')];
      return items.map(content => {
        let item = content;
        for (let i = 0; i < 6 && item.parentElement; i++) {
          item = item.parentElement;
          if (item.querySelector('[class*=username-]')) break;
        }
        return {
          name: ((item.querySelector('[class*=username-]') || {}).innerText || '').trim(),
          text: (content.innerText || '').trim(),
          time: ((item.querySelector('[class*=time-]') || {}).innerText || '').trim()
        };
      }).filter(c => c.name && c.text);
    })()`)) || [];
  }

  async replyComment(peer, text) {
    // 评论列表异步加载，定位目标评论最多等 12 秒
    let opened = false;
    const findDeadline = Date.now() + 12000;
    while (Date.now() < findDeadline && !opened) {
      opened = await evaluate(this.page, `(() => {
        const items = [...document.querySelectorAll('[class*=comment-content-text]')];
        const content = items.find(c => {
          let item = c;
          for (let i = 0; i < 6 && item.parentElement; i++) {
            item = item.parentElement;
            if (item.querySelector('[class*=username-]')) break;
          }
          return ((item.querySelector('[class*=username-]') || {}).innerText || '').trim() === ${JSON.stringify(peer)};
        });
        if (!content) return false;
        let item = content;
        for (let i = 0; i < 6 && item.parentElement; i++) {
          item = item.parentElement;
          if ([...item.querySelectorAll('[class*=item-]')].some(e => (e.innerText || '').trim() === '回复')) break;
        }
        const btn = [...item.querySelectorAll('[class*=item-], span, div')].find(e => (e.innerText || '').trim() === '回复' && e.children.length < 3);
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
      if (!opened) await sleep(1500);
    }
    if (!opened) throw new Error(`找不到评论或回复入口: ${peer}`);
    // 等回复框出现并校验目标（「回复 {peer}:」）
    let boxReady = false;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      boxReady = await evaluate(this.page, `(() => {
        const tas = [...document.querySelectorAll('textarea')];
        return tas.some(ta => {
          let c = ta;
          for (let i = 0; i < 5 && c.parentElement; i++) c = c.parentElement;
          return (c.innerText || '').includes(${JSON.stringify(`回复 ${peer}`)});
        });
      })()`);
      if (boxReady) break;
      await sleep(500);
    }
    if (!boxReady) throw new Error(`回复框未打开或目标校验失败：预期回复 ${peer}`);
    // 事件方式填充回复框（条目内的 textarea）
    await evaluate(this.page, `(() => {
      const tas = [...document.querySelectorAll('textarea')];
      const ta = tas.find(t => {
        let c = t;
        for (let i = 0; i < 5 && c.parentElement; i++) c = c.parentElement;
        return (c.innerText || '').includes(${JSON.stringify(`回复 ${peer}`)});
      });
      if (!ta) return;
      ta.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(800);
    // 点回复框容器内的「发送」
    const sent = await evaluate(this.page, `(() => {
      const tas = [...document.querySelectorAll('textarea')];
      const ta = tas.find(t => {
        let c = t;
        for (let i = 0; i < 5 && c.parentElement; i++) c = c.parentElement;
        return (c.innerText || '').includes(${JSON.stringify(`回复 ${peer}`)});
      });
      if (!ta) return false;
      let c = ta;
      for (let i = 0; i < 5 && c.parentElement; i++) c = c.parentElement;
      const btn = [...c.querySelectorAll('button')].find(b => (b.innerText || '').trim() === '发送' && !b.disabled);
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    if (!sent) throw new Error('「发送」按钮不可用');
    await sleep(3000);
    // 验证：评论区出现刚发送的内容
    const verified = await evaluate(this.page, `(document.body.innerText || '').includes(${JSON.stringify(text.slice(0, 15))})`);
    if (!verified) throw new Error('回复验证失败：评论区未出现刚发送的内容');
  }

  // 视频页回复（真机验证通过的路径）：导航到视频页 → 滚动到评论 → 点回复 → 填充 → 回车 → 验证
  async replyOnVideoPage(videoUrl, peer, commentText, text) {
    await this.page.send('Page.navigate', { url: videoUrl });
    await sleep(9000);
    // 滚动到目标评论
    const found = await evaluate(this.page, `(() => {
      const el = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && (e.innerText || '').trim() === ${JSON.stringify(commentText.slice(0, 30))});
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      return true;
    })()`);
    if (!found) throw new Error(`视频页找不到评论: ${commentText.slice(0, 20)}`);
    await sleep(2500);
    // 点该评论的「回复」（真实鼠标）
    const pos = await evaluate(this.page, `(() => {
      const el = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && (e.innerText || '').trim() === ${JSON.stringify(commentText.slice(0, 30))});
      if (!el) return null;
      let item = el;
      for (let i = 0; i < 8 && item.parentElement; i++) { item = item.parentElement; if ((item.innerText || '').includes('回复')) break; }
      const btn = [...item.querySelectorAll('*')].find(e => (e.innerText || '').trim() === '回复' && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().width < 80);
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!pos) throw new Error('找不到评论的「回复」按钮');
    await clickAt(this.page, pos.x, pos.y);
    await sleep(3000);
    // 校验回复框（回复@{peer}）
    const boxOk = await evaluate(this.page, `(document.body.innerText || '').includes(${JSON.stringify(`回复@${peer}`)})`);
    if (!boxOk) throw new Error(`回复框未打开或目标校验失败：预期回复 ${peer}`);
    // 点进输入框填充（Draft.js contenteditable）
    const inputPos = await evaluate(this.page, `(() => {
      const el = [...document.querySelectorAll('[contenteditable=true]')].find(e => {
        let c = e;
        for (let i = 0; i < 6 && c.parentElement; i++) c = c.parentElement;
        return (c.innerText || '').includes(${JSON.stringify(`回复@${peer}`)});
      });
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + 100), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!inputPos) throw new Error('找不到回复输入框');
    await clickAt(this.page, inputPos.x, inputPos.y);
    await sleep(500);
    await this.page.send('Input.insertText', { text });
    await sleep(800);
    await this.page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await this.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(4000);
    // 验证：评论区出现刚发送的内容
    const verified = await evaluate(this.page, `(document.body.innerText || '').includes(${JSON.stringify(text.slice(0, 15))})`);
    if (!verified) throw new Error('回复验证失败：评论区未出现刚发送的内容');
  }
}

module.exports = { DouyinDmDriver, ShipinhaoDriver, DouyinCommentDriver, evaluate, clickAt, clickText };
