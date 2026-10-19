const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PlatformAdapter } = require('./base');
const { ManagedBrowser } = require('../browser/cdpClient');
const { sleep } = require('../../common/retry');

function loadSelectors() {
  return JSON.parse(fs.readFileSync(path.resolve('config/platform-selectors.json'), 'utf8'));
}

function splitSelectors(selector) {
  return String(selector || '').split(',').map(item => item.trim()).filter(item => item && !item.includes(':has-text'));
}

class ConfigurableCdpAdapter extends PlatformAdapter {
  constructor(context) {
    super(context);
    this.selectors = loadSelectors()[context.platform];
    if (!this.selectors) throw new Error(`缺少平台选择器配置：${context.platform}`);
    this.frame = this.selectors.frame || null;
    this.browser = null;
  }

  async ensureBrowser(url) {
    if (!this.browser) {
      this.browser = new ManagedBrowser({ browserName: this.context.browserName || 'edge', profileDir: this.context.account.profile_dir, logger: this.context.logger });
      await this.browser.launch(url || this.selectors.loginUrl);
      await this.browser.waitForReady().catch(() => {});
    } else if (url) {
      await this.browser.navigate(url);
    }
    return this.browser;
  }

  async login() {
    await this.ensureBrowser(this.selectors.loginUrl);
    return { status: 'needs_manual', message: '已打开独立平台登录窗口，请在窗口中完成登录或验证，然后回到助手点击“检查登录状态”。' };
  }

  async checkIdentity({ timeoutMs = 5000, pollMs = 500 } = {}) {
    const browser = await this.ensureBrowser();
    const selectors = this.selectors.identitySelectors || [];
    let identity = null;
    const deadline = Date.now() + timeoutMs;
    do {
      for (const selector of selectors) {
        let text = '';
        if (selector.startsWith('text:')) {
          const body = await browser.bodyText();
          const needle = selector.slice(5);
          const line = body.split(/\r?\n/).map(l => l.trim()).find(l => l.includes(needle));
          text = line || '';
        } else {
          text = await browser.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.textContent || '').trim() : ''; })()`).catch(() => '');
          if (!text && this.frame) {
            text = await browser.evaluate(browser.frameWrap(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.textContent || '').trim() : ''; })()`, this.frame)).catch(() => '');
          }
        }
        if (text) { identity = text.slice(0, 80); break; }
      }
      if (!identity) await sleep(pollMs);
    } while (!identity && Date.now() < deadline);
    if (identity) {
      this.verifiedSession = { identity, marker: await this.sessionMarker(), verified_at: new Date().toISOString() };
    }
    return {
      platform: this.context.platform,
      identity,
      url: await browser.currentUrl().catch(() => '')
    };
  }

  async sessionMarker() {
    const state = await this.browser.saveCookies();
    const relevant = (state.cookies || [])
      .filter(c => /session|sid|uid|passport|token/i.test(c.name))
      .map(c => `${c.name}=${c.value}`)
      .sort();
    if (relevant.length === 0) return null;
    return crypto.createHash('sha256').update(relevant.join(';')).digest('hex');
  }

  async recheckIdentity() {
    const direct = await this.checkIdentity();
    if (direct.identity) return { ...direct, direct: true };
    if (this.verifiedSession && this.verifiedSession.marker && this.browser) {
      const marker = await this.sessionMarker();
      if (marker && marker === this.verifiedSession.marker) {
        return { platform: this.context.platform, identity: this.verifiedSession.identity, direct: false, via: 'session_marker', url: await this.browser.currentUrl().catch(() => '') };
      }
    }
    return { ...direct, identity: null };
  }

  async checkLoginState() {
    return this.checkLoginStateInternal({ navigateToLogin: true });
  }

  async checkLoginStateReadOnly() {
    return this.checkLoginStateInternal({ navigateToLogin: false });
  }

  async pageText(browser) {
    const main = await browser.bodyText();
    if (!this.frame) return main;
    const inner = await browser.bodyText(this.frame);
    return `${main}\n${inner}`;
  }

  async waitForContent({ timeoutMs = 10000, pollMs = 500 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let text = '';
    while (Date.now() < deadline) {
      text = await this.pageText(this.browser);
      const indicator = (this.selectors.loggedInIndicators || []).find(item => text.includes(item));
      if (indicator) return { text, indicator };
      if ((this.selectors.verificationPatterns || []).find(item => text.includes(item))) return { text, indicator: null };
      await sleep(pollMs);
    }
    return { text, indicator: null };
  }

  async checkLoginStateInternal({ navigateToLogin }) {
    if (!navigateToLogin && !this.browser) {
      return { loggedIn: false, readOnly: true, reason: 'browser_not_started', checked_at: new Date().toISOString() };
    }
    const browser = await this.ensureBrowser(navigateToLogin ? this.selectors.loginUrl : undefined);
    const { indicator } = await this.waitForContent();
    const verification = await this.detectVerification();
    if (verification) return { loggedIn: false, needsUserAction: true, verification };
    const state = await browser.saveCookies();
    return {
      loggedIn: Boolean(indicator),
      identity: await this.checkIdentity(),
      state,
      verifiedSelector: Boolean(indicator),
      cookieCount: (state.cookies || []).length,
      checked_at: new Date().toISOString()
    };
  }

  async prepareTask() {
    await this.ensureBrowser(this.selectors.uploadUrl);
    const verification = await this.detectVerification();
    if (verification) return { prepared: false, verification };
    return { prepared: true, url: await this.browser.currentUrl() };
  }

  async uploadVideo(videoPath) {
    const browser = await this.ensureBrowser();
    const selector = splitSelectors(this.selectors.fileInput)[0] || 'input[type=file]';
    await browser.waitForSelector(selector, 20000, this.frame);
    await browser.setFileInput(selector, videoPath, this.frame);
    return { uploaded: true, selector };
  }

  async fillFields(fields) {
    const browser = await this.ensureBrowser();
    const filled = {};
    for (const selector of splitSelectors(this.selectors.titleInput)) {
      if (await browser.setValue(selector, fields.title, this.frame).catch(() => false)) { filled.title = selector; break; }
    }
    const description = [fields.description, ...(fields.topics || []).map(item => `#${item}`)].filter(Boolean).join('\n');
    for (const selector of splitSelectors(this.selectors.descriptionInput)) {
      if (await browser.setValue(selector, description, this.frame).catch(() => false)) { filled.description = selector; break; }
    }
    return { filled, unverified: true };
  }

  get requiredFields() { return this.selectors.requiredFields || ['description']; }

  async waitForUploadComplete({ timeoutMs = 180000, pollMs = 2000 } = {}) {
    const browser = await this.ensureBrowser();
    const readySelectors = this.selectors.uploadReadySelectors || [];
    const readyPatterns = this.selectors.uploadReadyPatterns || [];
    const busyPatterns = this.selectors.uploadBusyPatterns || ['上传中', '转码中'];
    const failurePatterns = this.selectors.uploadFailurePatterns || ['上传失败', '转码失败'];
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const text = await this.pageText(browser);
      const failure = failurePatterns.find(item => text.includes(item));
      if (failure) return { ready: false, failure };
      let selectorsReady = readySelectors.length > 0;
      for (const selector of readySelectors) {
        const expr = `Boolean(document.querySelector(${JSON.stringify(selector)}))`;
        const found = await browser.evaluate(this.frame ? browser.frameWrap(expr, this.frame) : expr).catch(() => false);
        if (!found) { selectorsReady = false; break; }
      }
      const patternsReady = readyPatterns.length > 0 && readyPatterns.every(item => text.includes(item));
      const readyConfigured = (readySelectors.length > 0 && selectorsReady) || patternsReady;
      const busy = busyPatterns.find(item => text.includes(item));
      if (readyConfigured && !busy) return { ready: true };
      await sleep(pollMs);
    }
    return { ready: false, failure: 'timeout', message: '等待上传/转码完成超时' };
  }

  async detectVerification() {
    const browser = await this.ensureBrowser();
    const text = await this.pageText(browser);
    const pattern = (this.selectors.verificationPatterns || []).find(item => text.includes(item));
    if (pattern) {
      return { type: 'platform_verification', pattern, message: `页面出现可能的验证/登录提示：${pattern}` };
    }
    return null;
  }

  async submitOnce() {
    const browser = await this.ensureBrowser();
    this.lastSubmitUrl = await browser.currentUrl().catch(() => '');
    const apiPatterns = this.selectors.publishApiPatterns || [];
    if (apiPatterns.length && typeof browser.startResponseCapture === 'function') {
      this.publishCapture = browser.startResponseCapture(apiPatterns);
    }
    const dismissible = ['我知道了', '知道了', '跳过', '以后再说'];
    await browser.evaluate(browser.frameWrap(`(() => {
      for (const text of ${JSON.stringify(dismissible)}) {
        const el = [...document.querySelectorAll('button,[role=button],div[class*=button],div[class*=btn]')].find(item => (item.innerText || '').trim() === text);
        if (el) el.click();
      }
      return true;
    })()`, this.frame)).catch(() => {});
    await sleep(500);
    const candidates = String(this.selectors.submitButton || '').split(',').map(item => item.trim()).filter(Boolean);
    for (const candidate of candidates) {
      const hasText = candidate.match(/^button:has-text\(['"](.+)['"]\)$/);
      let clicked = false;
      try {
        if (hasText) {
          clicked = await browser.evaluate(browser.frameWrap(`(() => {
            const target = ${JSON.stringify(hasText[1])};
            const match = item => (item.innerText || '').trim() === target && !item.disabled && !String(item.className || '').includes('disabled');
            let el = [...document.querySelectorAll('button,[role=button]')].find(match);
            if (!el) el = [...document.querySelectorAll('div[class*=button],div[class*=btn],a[role=button]')].find(match);
            if (el) {
              const innerButton = [...el.querySelectorAll('button')].find(match);
              if (innerButton) el = innerButton;
            }
            if (!el) return false;
            el.scrollIntoView({ block: 'center' });
            el.click();
            return true;
          })()`, this.frame));
        } else {
          const found = await browser.evaluate(browser.frameWrap(`(() => {
            const el = document.querySelector(${JSON.stringify(candidate)});
            if (!el || el.disabled || String(el.className || '').includes('disabled') || el.getAttribute('submit-disabled') === 'true') return false;
            return true;
          })()`, this.frame));
          if (found) {
            await browser.clickReal(candidate, this.frame, this.selectors.submitClickAt);
            clicked = true;
          }
        }
      } catch {
        clicked = false;
      }
      if (clicked) {
        await this.handlePostSubmitDialogs();
        return { clicked: true, selector: candidate, clicked_at: new Date().toISOString() };
      }
    }
    throw new Error(`未找到可点击的最终提交按钮（已按配置选择器逐一尝试：${candidates.join(' | ') || '无配置'}）`);
  }

  async handlePostSubmitDialogs() {
    const actions = this.selectors.postSubmitDialogActions || [];
    if (!actions.length) return;
    const browser = await this.ensureBrowser();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await sleep(800);
      for (const action of actions) {
        const handled = await browser.evaluate(browser.frameWrap(`(() => {
          const els = [...document.querySelectorAll('button,[role=button],div[class*=button],div[class*=btn]')];
          const dialog = document.body.innerText.includes(${JSON.stringify(action.text)});
          if (!dialog) return 'absent';
          const btn = els.find(item => (item.innerText || '').trim() === ${JSON.stringify(action.click)});
          if (!btn) return 'no-button';
          btn.click();
          return 'clicked';
        })()`, this.frame)).catch(() => 'error');
        if (handled === 'clicked') {
          this.context.logger?.info('提交后弹窗已处理', { dialog: action.text, clicked: action.click });
          await sleep(800);
        } else if (handled === 'no-button') {
          this.context.logger?.warn('提交后弹窗出现但未找到处理按钮', { dialog: action.text, expected: action.click });
        }
      }
      const anyPresent = await browser.evaluate(browser.frameWrap(`(() => ${JSON.stringify(actions.map(a => a.text))}.some(t => document.body.innerText.includes(t)))()`, this.frame)).catch(() => false);
      if (!anyPresent) return;
    }
  }

  async evidenceExtra() {
    if (this.selectors.evidenceScreenshot !== true) return {};
    const screenshot = await this.browser.screenshotBase64().catch(() => null);
    return screenshot ? { screenshot_png_base64: screenshot } : {};
  }

  async capturePlatformResult({ waitMs = 8000, pollMs = 500 } = {}) {
    const capture = this.publishCapture;
    this.publishCapture = null;
    if (!capture) return {};
    try {
      const idFields = this.selectors.resultIdFields || ['item_id', 'aweme_id', 'note_id', 'feed_id'];
      const extract = () => {
        for (const entry of capture.list()) {
          let json = null;
          try { json = JSON.parse(entry.body); } catch { continue; }
          if (!json || typeof json !== 'object') continue;
          const statusCode = json.status_code ?? json.statusCode ?? json.BaseResp?.StatusCode;
          if (statusCode !== undefined && Number(statusCode) !== 0) continue;
          for (const field of idFields) {
            const value = json[field];
            if ((typeof value === 'string' || typeof value === 'number') && String(value)) {
              return {
                platform_item_id: String(value),
                platform_item_id_field: field,
                publish_api: entry.url.split('?')[0],
                publish_api_status: entry.status
              };
            }
          }
        }
        return null;
      };
      const deadline = Date.now() + waitMs;
      let found = extract();
      while (!found && Date.now() < deadline) {
        await sleep(pollMs);
        found = extract();
      }
      if (!found) return { platform_item_id: null, platform_item_id_note: '发布接口响应中未捕获作品标识' };
      return found;
    } finally {
      await capture.stop().catch(() => {});
    }
  }

  async verifyResult({ timeoutMs = 45000, pollMs = 1000 } = {}) {
    const browser = await this.ensureBrowser();
    const startUrl = this.lastSubmitUrl || '';
    const successUrls = this.selectors.postSubmitSuccessUrls || [];
    const deadline = Date.now() + timeoutMs;
    let result = null;
    while (Date.now() < deadline && !result) {
      const url = await browser.currentUrl().catch(() => '');
      const text = await this.pageText(browser);
      const failure = (this.selectors.failurePatterns || []).find(item => text.includes(item));
      if (failure) result = { outcome: 'failed', evidence: { failure_pattern: failure, url, ...(await this.evidenceExtra()) } };
      if (!result) {
        const success = (this.selectors.successPatterns || []).find(item => text.includes(item));
        if (success) result = { outcome: 'submitted', evidence: { success_pattern: success, platform_status: 'accepted_or_reviewing', url, ...(await this.evidenceExtra()) } };
      }
      if (!result) {
        const redirected = url && successUrls.some(pattern => url.includes(pattern)) && (!startUrl || url !== startUrl);
        if (redirected) result = { outcome: 'submitted', evidence: { redirect: url, platform_status: 'redirected_to_manage', ...(await this.evidenceExtra()) } };
      }
      if (!result) await sleep(pollMs);
    }
    if (!result) {
      const url = await browser.currentUrl().catch(() => '');
      result = { outcome: 'outcome_unknown', evidence: { reason: '等待平台结果超时，未识别成功或失败特征', url, ...(await this.evidenceExtra()) } };
    }
    result.evidence = { ...result.evidence, ...(await this.capturePlatformResult()) };
    return result;
  }

  async close() { await this.browser?.close(); }
}

module.exports = { ConfigurableCdpAdapter };