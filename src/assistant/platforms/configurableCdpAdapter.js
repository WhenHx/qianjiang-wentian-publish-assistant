const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PlatformAdapter } = require('./base');
const { ManagedBrowser } = require('../browser/cdpClient');

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

  async checkIdentity() {
    const browser = await this.ensureBrowser();
    const selectors = this.selectors.identitySelectors || [];
    let identity = null;
    for (const selector of selectors) {
      const text = await browser.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.textContent || '').trim() : ''; })()`).catch(() => '');
      if (text) { identity = text.slice(0, 80); break; }
    }
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
    return crypto.createHash('sha256').update(relevant.join(';')).digest('hex');
  }

  async recheckIdentity() {
    const direct = await this.checkIdentity();
    if (direct.identity) return { ...direct, direct: true };
    if (this.verifiedSession && this.browser) {
      const marker = await this.sessionMarker();
      if (marker === this.verifiedSession.marker) {
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

  async checkLoginStateInternal({ navigateToLogin }) {
    if (!navigateToLogin && !this.browser) {
      return { loggedIn: false, readOnly: true, reason: 'browser_not_started', checked_at: new Date().toISOString() };
    }
    const browser = await this.ensureBrowser(navigateToLogin ? this.selectors.loginUrl : undefined);
    const text = await browser.bodyText();
    const verification = await this.detectVerification();
    if (verification) return { loggedIn: false, needsUserAction: true, verification };
    const indicator = (this.selectors.loggedInIndicators || []).find(item => text.includes(item));
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
    await browser.setFileInput(selector, videoPath);
    return { uploaded: true, selector };
  }

  async fillFields(fields) {
    const browser = await this.ensureBrowser();
    const filled = {};
    for (const selector of splitSelectors(this.selectors.titleInput)) {
      if (await browser.setValue(selector, fields.title).catch(() => false)) { filled.title = selector; break; }
    }
    const description = [fields.description, ...(fields.topics || []).map(item => `#${item}`)].filter(Boolean).join('\n');
    for (const selector of splitSelectors(this.selectors.descriptionInput)) {
      if (await browser.setValue(selector, description).catch(() => false)) { filled.description = selector; break; }
    }
    return { filled, unverified: true };
  }

  async detectVerification() {
    const browser = await this.ensureBrowser();
    const text = await browser.bodyText();
    const pattern = (this.selectors.verificationPatterns || []).find(item => text.includes(item));
    if (pattern) {
      return { type: 'platform_verification', pattern, message: `页面出现可能的验证/登录提示：${pattern}` };
    }
    return null;
  }

  async submitOnce() {
    const browser = await this.ensureBrowser();
    const candidates = String(this.selectors.submitButton || '').split(',').map(item => item.trim()).filter(Boolean);
    for (const candidate of candidates) {
      const hasText = candidate.match(/^button:has-text\(['"](.+)['"]\)$/);
      let clicked;
      if (hasText) {
        clicked = await browser.evaluate(`(() => {
          const target = ${JSON.stringify(hasText[1])};
          const el = [...document.querySelectorAll('button,[role=button]')].find(item => (item.innerText || '').trim() === target && !item.disabled);
          if (!el) return false;
          el.scrollIntoView({ block: 'center' });
          el.click();
          return true;
        })()`);
      } else {
        clicked = await browser.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(candidate)});
          if (!el || el.disabled) return false;
          el.scrollIntoView({ block: 'center' });
          el.click();
          return true;
        })()`);
      }
      if (clicked) return { clicked: true, selector: candidate, clicked_at: new Date().toISOString() };
    }
    throw new Error(`未找到可点击的最终提交按钮（已按配置选择器逐一尝试：${candidates.join(' | ') || '无配置'}）`);
  }

  async verifyResult() {
    const browser = await this.ensureBrowser();
    const text = await browser.bodyText();
    const success = (this.selectors.successPatterns || []).find(item => text.includes(item));
    const failure = (this.selectors.failurePatterns || []).find(item => text.includes(item));
    const screenshot = await browser.screenshotBase64();
    if (failure) return { outcome: 'failed', evidence: { failure_pattern: failure, screenshot_png_base64: screenshot } };
    if (success) return { outcome: 'submitted', evidence: { success_pattern: success, platform_status: 'accepted_or_reviewing', screenshot_png_base64: screenshot } };
    return { outcome: 'outcome_unknown', evidence: { reason: '未识别到平台成功或失败特征', screenshot_png_base64: screenshot } };
  }

  async close() { await this.browser?.close(); }
}

module.exports = { ConfigurableCdpAdapter };