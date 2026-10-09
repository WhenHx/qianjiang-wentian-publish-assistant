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

  async navigate(url) {
    await this.page.send('Page.navigate', { url });
  }

  async evaluate(expression, { awaitPromise = false, timeoutMs = 30000 } = {}) {
    const result = await this.page.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true }, timeoutMs);
    if (result.exceptionDetails) throw new Error(`页面脚本执行失败：${result.exceptionDetails.text || 'unknown'}`);
    return result.result?.value;
  }

  async waitForSelector(selector, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = await this.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`).catch(() => false);
      if (found) return true;
      await sleep(300);
    }
    throw new Error(`等待页面元素超时：${selector}`);
  }

  async setFileInput(selector, filePath) {
    const doc = await this.page.send('DOM.getDocument', { depth: -1, pierce: true });
    const node = await this.page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    if (!node.nodeId) throw new Error(`未找到文件上传控件：${selector}`);
    await this.page.send('DOM.setFileInputFiles', { files: [filePath], nodeId: node.nodeId });
  }

  async click(selector) {
    await this.waitForSelector(selector, 10000);
    await this.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollIntoView({block:'center'}); el.click(); return true; })()`);
  }

  async setValue(selector, value) {
    await this.waitForSelector(selector, 10000);
    return this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      const value = ${JSON.stringify(value)};
      if (el.isContentEditable) { el.innerText = value; } else { el.value = value; }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
  }

  async bodyText() {
    return this.evaluate('document.body ? document.body.innerText : ""', { timeoutMs: 10000 }).catch(() => '');
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

  async close() {
    try { await this.page?.send('Browser.close', {}, 3000); } catch {}
    try { this.page?.close(); } catch {}
    if (this.process && !this.process.killed) {
      try { this.process.kill(); } catch {}
    }
  }
}

module.exports = { ManagedBrowser, findBrowser };