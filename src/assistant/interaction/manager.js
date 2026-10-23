// 互动接待管理器：读取平台私信/评论 → 上传问天 → 问天生成回复 → 助手发送 → 结果回传。
// 客户回复一律由问天生成（契约 v3）；本地 LLM 仅在 interaction.llm.fallbackEnabled=true 时作为显式降级。
// 默认 autoSend=false：拿到回复只进待发送队列，由本地 API 人工确认后真实发送。
// 浏览器驱动通过 ensureBrowser 注入，测试可替换为桩。
const crypto = require('node:crypto');
const { ManagedBrowser } = require('../browser/cdpClient');
const { LlmClient } = require('./llm');
const { DouyinDmDriver, ShipinhaoDriver, DouyinCommentDriver } = require('./drivers');
const { randomId } = require('../../common/ids');
const { sleep } = require('../../common/retry');

const CHANNEL_NAMES = { douyin: '抖音', shipinhao: '视频号', xiaohongshu: '小红书' };

// 留微识别：手机号或微信号
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/;
const WECHAT_RE = /(?:微信|vx|wx|V信|威信|微|加V|\+V)\s*[:：号]?\s*([A-Za-z][A-Za-z0-9_-]{5,19})/i;
const ADDME_RE = /加我\s*([A-Za-z][A-Za-z0-9_-]{4,19})\s*$/;

function extractContact(text) {
  const phone = PHONE_RE.exec(text);
  if (phone) return { type: 'phone', value: phone[0] };
  const wx = WECHAT_RE.exec(text);
  if (wx) return { type: 'wechat', value: wx[1] };
  const addme = ADDME_RE.exec(text.trim());
  if (addme) return { type: 'wechat', value: addme[1] };
  return null;
}

function dedupHash(platform, kind, peer, text) {
  return crypto.createHash('sha256').update(`${platform}|${kind}|${peer}|${text}`).digest('hex').slice(0, 32);
}

class InteractionManager {
  constructor({ config, store, cloud, logger }) {
    this.config = config;
    this.store = store;
    this.cloud = cloud;
    this.logger = logger;
    this.interactionCfg = config.interaction || {};
    this.fallbackLlm = this.interactionCfg.llm && this.interactionCfg.llm.fallbackEnabled === true
      ? new LlmClient(this.interactionCfg.llm) : null;
    this.browsers = new Map();
    this.running = false;
    this._timer = null;
  }

  get enabled() {
    return this.interactionCfg.enabled === true && this.config.automationMode === 'cdp';
  }

  async start() {
    if (!this.enabled || this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        await this.pollOnce();
      } catch (e) {
        this.logger.warn('互动轮询失败', { error: e.message });
      }
      this._timer = setTimeout(loop, this.interactionCfg.pollIntervalMs || 30000);
    };
    this._timer = setTimeout(loop, 3000);
    this.logger.info('互动回复模块已启动', { autoSend: !!this.interactionCfg.autoSend });
  }

  async stop() {
    this.running = false;
    if (this._timer) clearTimeout(this._timer);
    for (const b of this.browsers.values()) await b.close().catch(() => {});
    this.browsers.clear();
  }

  async ensureBrowser(platform) {
    if (this.browsers.has(platform)) return this.browsers.get(platform);
    const account = this.store.listAccounts().find(a => a.platform === platform && a.status === 'logged_in');
    if (!account) throw new Error(`没有已登录的 ${platform} 账号`);
    const browser = new ManagedBrowser({
      browserName: this.config.browser || 'edge',
      profileDir: account.profile_dir,
      logger: this.logger
    });
    await browser.launch('about:blank');
    this.browsers.set(platform, browser);
    return browser;
  }

  accountKeyFor(platform) {
    const account = this.store.listAccounts().find(a => a.platform === platform && a.status === 'logged_in');
    return account ? account.account_key : 'unknown';
  }

  async pollOnce() {
    const platforms = this.interactionCfg.platforms || {};
    const results = { detected: 0, replied: 0, sent: 0, leads: 0, errors: [] };
    await this.retryPendingUploads(results);
    for (const [platform, kinds] of Object.entries(platforms)) {
      if (kinds.dm) {
        try {
          const r = await this.pollDm(platform);
          for (const k of Object.keys(results)) if (typeof r[k] === 'number') results[k] += r[k];
        } catch (e) {
          results.errors.push(`${platform}/dm: ${e.message}`);
          this.logger.warn('私信轮询失败', { platform, error: e.message });
        }
      }
      if (kinds.comment) {
        try {
          await this.pollComments(platform);
        } catch (e) {
          results.errors.push(`${platform}/comment: ${e.message}`);
          this.logger.warn('评论轮询失败', { platform, error: e.message });
        }
      }
    }
    return results;
  }

  async pollDm(platform) {
    const browser = await this.ensureBrowser(platform);
    let driver;
    let conversations;
    if (platform === 'douyin') {
      driver = new DouyinDmDriver(browser.page);
      await driver.openPanel();
      conversations = await driver.listConversations();
    } else if (platform === 'shipinhao') {
      driver = new ShipinhaoDriver(browser.page);
      await driver.openDmPage();
      conversations = await driver.listConversations();
    } else {
      return { detected: 0, replied: 0, sent: 0, leads: 0 };
    }
    const results = { detected: 0, replied: 0, sent: 0, leads: 0 };
    for (const convo of conversations) {
      // 预览去重（轻量）：预览没变说明没有新动静，跳过；预览变了才开会话细看
      const previewKey = dedupHash(platform, 'dm', convo.name, `preview:${convo.preview}`);
      if (this.store.getSetting(`int_seen_${previewKey}`, null)) continue;
      await driver.openConversation(convo.name);
      if (platform === 'douyin' && !(await driver.verifyConversation(convo.preview))) {
        this.logger.warn('会话内容与列表预览不一致，疑似开错会话，跳过', { peer: convo.name });
        continue;
      }
      const messages = await driver.readMessages();
      const previewCore = (convo.preview || '').replace(/[…\s]+$/u, '').trim();
      this.store.setSetting(`int_seen_${previewKey}`, '1');
      // 来信选择：DOM 最新在前。最新的未记录来信做回复；所有未记录来信都过留微识别
      const incomings = messages.filter(m => !m.fromMe);
      const unrecorded = incomings.filter(m => !this.store.getInteractionByHash(dedupHash(platform, 'dm', convo.name, m.text)));
      for (const m of unrecorded) {
        const lead = await this.maybeCreateLead({ platform, peer: convo.name, incoming: m, hash: dedupHash(platform, 'dm', convo.name, m.text) });
        if (lead) results.leads += 1;
      }
      let incoming = unrecorded.find(m => previewCore && (m.text.startsWith(previewCore.slice(0, 12)) || previewCore.startsWith(m.text.slice(0, 12))));
      if (!incoming) incoming = unrecorded[0];
      if (!incoming) continue;
      // 内容级去重：同一客户同一条来信只入队一次（不受已方回复改变预览的影响）
      const hash = dedupHash(platform, 'dm', convo.name, incoming.text);
      results.detected += 1;
      const row = await this.uploadAndDraft({ platform, kind: 'dm', peer: convo.name, incoming, messages, hash, conversationKey: convo.name });
      if (row && row.draft) results.replied += 1;
      if (row && row.draft && this.interactionCfg.autoSend) {
        await driver.sendMessage(row.draft);
        await this.reportResult(row, 'sent', { sent_text: row.draft });
        results.sent += 1;
      }
    }
    return results;
  }

  async pollComments(platform) {
    const browser = await this.ensureBrowser(platform);
    if (platform === 'douyin') {
      const driver = new DouyinCommentDriver(browser.page);
      await driver.openCommentPage();
      await driver.listComments();
      // 评论条目结构待真实评论数据校准
    } else if (platform === 'shipinhao') {
      const driver = new ShipinhaoDriver(browser.page);
      await driver.openCommentPage();
      await driver.listCommentWorks();
    }
  }

  // 上行失败（cloudId 为空）的记录每轮重试，不丢消息
  async retryPendingUploads(results) {
    const pending = this.store.listInteractions().filter(i => !i.cloudId && i.status === 'draft_pending' && !i.draft);
    for (const row of pending) {
      try {
        const resp = await this.cloud.request('/api/v1/interactions', {
          method: 'POST',
          body: {
            platform: row.platform,
            account_key: this.accountKeyFor(row.platform),
            kind: row.kind,
            peer: { platform_uid: null, nickname: row.peer },
            message: { external_id: null, direction: 'in', content: row.incomingText, sent_at: row.createdAt },
            context: (row.context || []).map(m => ({ direction: m.fromMe ? 'out' : 'in', content: m.text })),
            source: { kind: row.kind, conversation_key: row.peer, work_id: null },
            idempotency_key: `int-${row.dedupHash}`
          }
        });
        this.store.updateInteraction(row.id, { cloudId: resp.interaction_id });
        const reply = resp.reply || {};
        if (reply.status === 'ready' && reply.text) {
          this.store.updateInteraction(row.id, { draft: reply.text });
          results.replied += 1;
        } else if (reply.status === 'none') {
          this.store.updateInteraction(row.id, { status: 'discarded' });
        }
      } catch (e) {
        this.logger.warn('互动补传失败', { id: row.id, error: e.message });
      }
    }
  }

  // 上传问天拿回复（契约 v3）；回复 pending 时短轮询一次；问天不答且开启降级才用本地 LLM
  async uploadAndDraft({ platform, kind, peer, incoming, messages, hash, conversationKey }) {
    const row = this.store.insertInteraction({
      id: randomId('int'),
      platform, kind, peer,
      incomingText: incoming.text,
      context: messages.slice(-6),
      dedupHash: hash
    });
    if (!row) return null;
    const local = this.store.getInteractionByHash(hash);
    try {
      const resp = await this.cloud.request('/api/v1/interactions', {
        method: 'POST',
        body: {
          platform,
          account_key: this.accountKeyFor(platform),
          kind,
          peer: { platform_uid: null, nickname: peer },
          message: { external_id: null, direction: 'in', content: incoming.text, sent_at: new Date().toISOString() },
          context: messages.slice(-6).map(m => ({ direction: m.fromMe ? 'out' : 'in', content: m.text })),
          source: { kind, conversation_key: conversationKey, work_id: null },
          idempotency_key: `int-${hash}`
        }
      });
      this.store.updateInteraction(local.id, { cloudId: resp.interaction_id });
      let reply = resp.reply || {};
      if (reply.status === 'pending') {
        await sleep(5000);
        const got = await this.cloud.request(`/api/v1/interactions/${resp.interaction_id}`);
        reply = got.reply || {};
      }
      if (reply.status === 'ready' && reply.text) {
        this.store.updateInteraction(local.id, { draft: reply.text });
      } else if (reply.status === 'none') {
        this.store.updateInteraction(local.id, { status: 'discarded' });
      }
    } catch (e) {
      this.logger.warn('问天互动上行失败', { peer, error: e.message });
      if (this.fallbackLlm && this.fallbackLlm.ready) {
        try {
          const text = await this.fallbackLlm.chat(messages.slice(-6).map(m => ({ role: m.fromMe ? 'assistant' : 'user', content: m.text })));
          if (text) this.store.updateInteraction(local.id, { draft: text });
        } catch (e2) {
          this.logger.warn('本地降级起草失败', { peer, error: e2.message });
        }
      }
    }
    return this.store.getInteractionByHash(hash);
  }

  async maybeCreateLead({ platform, peer, incoming, hash }) {
    const contact = extractContact(incoming.text);
    if (!contact) return null;
    try {
      const resp = await this.cloud.request('/api/v1/leads', {
        method: 'POST',
        body: {
          platform,
          account_key: this.accountKeyFor(platform),
          peer: { platform_uid: null, nickname: peer },
          channel: CHANNEL_NAMES[platform] || platform,
          contact,
          raw_message: incoming.text,
          source: { kind: 'dm', conversation_key: peer, interaction_id: null, work_id: null },
          captured_at: new Date().toISOString(),
          idempotency_key: `lead-${hash}`
        }
      });
      this.logger.info('留微线索已上行', { platform, peer, type: contact.type });
      return resp.lead;
    } catch (e) {
      this.logger.warn('线索上行失败', { platform, peer, error: e.message });
      return null;
    }
  }

  async reportResult(localRow, outcome, evidence, error) {
    if (localRow.cloudId) {
      try {
        await this.cloud.request(`/api/v1/interactions/${localRow.cloudId}/result`, {
          method: 'POST',
          body: { outcome, evidence: evidence || {}, error: error || null }
        });
      } catch (e) {
        this.logger.warn('互动结果回传失败', { id: localRow.id, error: e.message });
      }
    }
    if (outcome === 'sent') this.store.updateInteraction(localRow.id, { status: 'sent' });
    else if (outcome === 'failed') this.store.updateInteraction(localRow.id, { status: 'failed', error });
  }

  async sendInteraction(id) {
    const row = this.store.getInteraction(id);
    if (!row) throw new Error('互动记录不存在');
    if (row.status === 'sent') return row;
    if (row.status === 'discarded') throw new Error('记录已作废，不能发送');
    if (!row.draft) throw new Error('没有可发送的回复内容');
    const browser = await this.ensureBrowser(row.platform);
    try {
      if (row.platform === 'douyin' && row.kind === 'dm') {
        const driver = new DouyinDmDriver(browser.page);
        await driver.openPanel();
        await driver.openConversation(row.peer);
        const lastKnown = [...(row.context || [])].reverse().find(m => m.text);
        if (lastKnown && !(await driver.verifyConversation(lastKnown.text))) {
          throw new Error(`会话一致性校验失败，疑似开错会话：${row.peer}`);
        }
        await driver.sendMessage(row.draft);
      } else if (row.platform === 'shipinhao' && row.kind === 'dm') {
        const driver = new ShipinhaoDriver(browser.page);
        await driver.openDmPage();
        await driver.openConversation(row.peer);
        await driver.sendMessage(row.draft);
      } else {
        throw new Error(`${row.platform}/${row.kind} 的发送路径待校准`);
      }
      await this.reportResult(row, 'sent', { sent_text: row.draft });
      return this.store.getInteraction(id);
    } catch (e) {
      this.logger.warn('互动发送失败', { id, peer: row.peer, error: e.message });
      // 定位类错误（没找到会话/输入框）说明根本没发出，不回传终态、本地保持可重试；
      // 只有真正执行过发送动作的失败（如气泡验证失败、平台拦截）才回传 failed 终态
      if (/会话不存在|输入框|未生效|未弹出|未就绪/.test(e.message)) {
        this.store.updateInteraction(id, { error: { message: e.message } });
      } else {
        await this.reportResult(row, 'failed', null, { message: e.message });
      }
      throw e;
    }
  }

  discardInteraction(id) {
    const row = this.store.getInteraction(id);
    if (!row) throw new Error('互动记录不存在');
    if (row.status === 'sent') throw new Error('已发送的记录不能作废');
    const updated = this.store.updateInteraction(id, { status: 'discarded' });
    this.reportResult(updated, 'discarded', null, null).catch(() => {});
    return updated;
  }
}

module.exports = { InteractionManager, extractContact };
