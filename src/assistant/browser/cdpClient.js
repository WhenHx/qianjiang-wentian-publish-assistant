const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { sleep } = require('../../common/retry');

const BROWSER_PATHS = {
  edge: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ],
  chrome: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ]
};

function findBrowser(name = 'edge') {
  const candidates = BROWSER_PATHS[name] || BROWSER_PATHS.edge;
  const found = candidates.find(item => fs.existsSync(item));
  if (!found) throw new Error(`未找到受支持浏览器：${name}`);
  return found;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

class CdpConnection {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  connect() {
    if (this.ws) return this.ready;
    this.ws = new WebSocket(this.wsUrl);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message || 'CDP 调用失败'} (${message.error.code})`));
        else resolve(message.result || {});
      } else if (message.method) {
        for (const listener of this.listeners.get(message.method) || []) listener(message.params || {});
      }
    });
    this.ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP 连接已关闭'));
      this.pending.clear();
    });
    return this.ready;
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }

  off(method, listener) {
    const list = this.listeners.get(method);
    if (!list) return;
    const index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
  }

  async send(method, params = {}, timeoutMs = 30000) {
    await this.connect();
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); }
      });
    });
    this.ws.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  close() {
    try { this.ws?.close(); } catch {}
  }
}

class ManagedBrowser {
  constructor({ browserName = 'edge', profileDir, logger }) {
    this.browserName = browserName;
    this.profileDir = profileDir;
    this.logger = logger;
    this.process = null;
    this.port = null;
    this.page = null;
  }

  async launch(url = 'about:blank') {
    fs.mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
    this.port = await freePort();
    const executable = findBrowser(this.browserName);
    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-popup-blocking',
      '--disable-background-networking',
      url
    ];
    this.process = spawn(executable, args, { stdio: 'ignore', windowsHide: false });
    this.process.on('exit', code => this.logger?.warn('浏览器进程已退出', { code }));
    const versionUrl = await this.waitForDevTools();
    const targets = await this.waitForPageTarget();
    this.page = new CdpConnection(targets.webSocketDebuggerUrl);
    await this.page.connect();
    await this.page.send('Page.enable');
    await this.page.send('Runtime.enable');
    await this.page.send('Network.enable');
    return { versionUrl, targetId: targets.id };
  }

  async waitForDevTools() {
    const versionUrl = `http://127.0.0.1:${this.port}/json/version`;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(versionUrl, { signal: AbortSignal.timeout(1000) });
        if (response.ok) return versionUrl;
      } catch {}
      await sleep(250);
    }
    throw new Error('浏览器调试端口启动超时');
  }

  async waitForPageTarget() {
    const listUrl = `http://127.0.0.1:${this.port}/json/list`;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(listUrl, { signal: AbortSignal.timeout(1000) });
        if (response.ok) {
          const targets = await response.json();
          const page = targets.find(item => item.type === 'page');
          if (page) return page;
        }
      } catch {}
      await sleep(250);
    }
    throw new Error('未找到浏览器页面目标');
  }

  // 新建独立标签页并返回页面级 CDP 连接（互动模块的私信/评论各占一个标签页，互不导航干扰）
  async newTab(url = 'about:blank') {
    const version = await (await fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(5000) })).json();
    const browserWs = new CdpConnection(version.webSocketDebuggerUrl);
    await browserWs.connect();
    const { targetId } = await browserWs.send('Target.createTarget', { url });
    await browserWs.close();
    const listUrl = `http://127.0.0.1:${this.port}/json/list`;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const targets = await (await fetch(listUrl, { signal: AbortSignal.timeout(2000) })).json();
      const t = targets.find(x => x.id === targetId);
      if (t) {
        const page = new CdpConnection(t.webSocketDebuggerUrl);
        await page.connect();
        await page.send('Page.enable');
        await page.send('Runtime.enable');
        return page;
      }
      await sleep(300);
    }
    throw new Error('新建标签页失败');
  }

  async waitForReady({ timeoutMs = 15000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.evaluate('document.readyState').catch(() => '');
      if (state === 'complete') {
        await sleep(500);
        return;
      }
      await sleep(300);
    }
    throw new Error('页面加载超时');
  }

  frameWrap(expression, frame) {
    if (!frame) return expression;
    return `(function(){ const __f = window.document.querySelector(${JSON.stringify(frame)}); if (!__f || !__f.contentDocument) throw new Error(${JSON.stringify(`frame_not_found: ${frame}`)}); const document = __f.contentDocument; return (${expression}); })()`;
  }

  async navigate(url, { timeoutMs = 15000 } = {}) {
    const loaded = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`页面加载超时：${url}`)), timeoutMs);
      this.page.on('Page.loadEventFired', () => { clearTimeout(timer); resolve(); });
    });
    await this.page.send('Page.navigate', { url });
    await loaded;
    await this.waitForReady({ timeoutMs: 5000 }).catch(() => {});
  }

  async evaluate(expression, { awaitPromise = false, timeoutMs = 30000 } = {}) {
    const result = await this.page.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true }, timeoutMs);
    if (result.exceptionDetails) throw new Error(`页面脚本执行失败：${result.exceptionDetails.text || 'unknown'}`);
    return result.result?.value;
  }

  async waitForSelector(selector, timeoutMs = 15000, frame = null) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = await this.evaluate(this.frameWrap(`Boolean(document.querySelector(${JSON.stringify(selector)}))`, frame)).catch(() => false);
      if (found) return true;
      await sleep(300);
    }
    throw new Error(`等待页面元素超时：${selector}`);
  }

  async setFileInput(selector, filePath, frame = null) {
    if (frame) {
      await this.page.send('DOM.enable').catch(() => {});
      const handle = await this.page.send('Runtime.evaluate', {
        expression: this.frameWrap(`document.querySelector(${JSON.stringify(selector)})`, frame),
        returnByValue: false
      });
      if (handle.exceptionDetails) throw new Error(`定位文件上传控件失败：${handle.exceptionDetails.text || '页面脚本异常'}（frame: ${frame}）`);
      const obj = handle.result;
      if (!obj || obj.subtype !== 'node') throw new Error(`未找到文件上传控件：${selector}（frame: ${frame}）`);
      await this.page.send('DOM.setFileInputFiles', { files: [filePath], objectId: obj.objectId });
      return;
    }
    const doc = await this.page.send('DOM.getDocument', { depth: -1, pierce: true });
    const node = await this.page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    if (!node.nodeId) throw new Error(`未找到文件上传控件：${selector}`);
    await this.page.send('DOM.setFileInputFiles', { files: [filePath], nodeId: node.nodeId });
  }

  async click(selector, frame = null) {
    await this.waitForSelector(selector, 10000, frame);
    await this.evaluate(this.frameWrap(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollIntoView({block:'center'}); el.click(); return true; })()`, frame));
  }

  async clickReal(selector, frame = null, at = null) {
    await this.waitForSelector(selector, 10000, frame);
    await this.evaluate(this.frameWrap(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el) el.scrollIntoView({ block: 'end', behavior: 'instant' });
      return true;
    })()`, frame));
    await sleep(600);
    const rect = await this.evaluate(frame
      ? `(() => {
      const __f = document.querySelector(${JSON.stringify(frame)});
      if (!__f || !__f.contentDocument) return null;
      const el = __f.contentDocument.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const fr = __f.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { x: r.x + fr.x, y: r.y + fr.y, width: r.width, height: r.height };
    })()`
      : this.frameWrap(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`, frame));
    if (!rect) throw new Error(`未找到可点击元素：${selector}`);
    const [rx, ry] = Array.isArray(at) && at.length === 2 ? at : [0.5, 0.5];
    const x = rect.x + rect.width * rx;
    const y = rect.y + rect.height * ry;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
  }

  async setValue(selector, value, frame = null) {
    await this.waitForSelector(selector, 10000, frame);
    return this.evaluate(this.frameWrap(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      const value = ${JSON.stringify(value)};
      if (el.isContentEditable) {
        el.innerText = value;
      } else {
        const win = el.ownerDocument.defaultView;
        const proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      const actual = el.isContentEditable ? el.innerText : el.value;
      return actual === value;
    })()`, frame));
  }

  async bodyText(frame = null) {
    return this.evaluate(this.frameWrap('document.body ? document.body.innerText : ""', frame), { timeoutMs: 10000 }).catch(() => '');
  }

  async currentUrl() { return this.evaluate('location.href'); }

  async saveCookies() {
    const result = await this.page.send('Network.getAllCookies').catch(() => ({ cookies: [] }));
    return { cookies: result.cookies || [], saved_at: new Date().toISOString() };
  }

  async screenshotBase64() {
    const result = await this.page.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
    return result?.data || null;
  }

  // 监听 URL 命中 patterns（子串匹配）的 JSON 响应，用于捕获发布接口返回的作品标识
  startResponseCapture(patterns, { maxEntries = 50, maxBodyChars = 8192 } = {}) {
    const captured = [];
    const inFlight = new Set();
    const meta = new Map();
    const matched = url => patterns.some(pattern => url.includes(pattern));
    const onResponse = params => {
      const { requestId, response } = params;
      if (!response || !matched(response.url || '')) return;
      meta.set(requestId, { url: response.url, status: response.status, mime: response.mimeType || '' });
    };
    const onFinished = params => {
      const info = meta.get(params.requestId);
      meta.delete(params.requestId);
      if (!info || !/json/i.test(info.mime)) return;
      const fetchBody = this.page.send('Network.getResponseBody', { requestId: params.requestId }, 10000)
        .then(body => {
          if (captured.length >= maxEntries) return;
          captured.push({ url: info.url, status: info.status, body: (body.body || '').slice(0, maxBodyChars), captured_at: new Date().toISOString() });
        })
        .catch(() => {});
      inFlight.add(fetchBody);
      fetchBody.finally(() => inFlight.delete(fetchBody));
    };
    this.page.on('Network.responseReceived', onResponse);
    this.page.on('Network.loadingFinished', onFinished);
    return {
      list: () => captured.slice(),
      stop: async ({ waitMs = 3000 } = {}) => {
        this.page.off('Network.responseReceived', onResponse);
        this.page.off('Network.loadingFinished', onFinished);
        const deadline = Date.now() + waitMs;
        while (inFlight.size && Date.now() < deadline) await sleep(100);
      }
    };
  }

  async close() {
    try { await this.page?.send('Browser.close', {}, 3000); } catch {}
    try { this.page?.close(); } catch {}
    if (this.process && !this.process.killed) {
      try { this.process.kill(); } catch {}
    }
  }
}

module.exports = { ManagedBrowser, findBrowser };