const fs = require('node:fs');
const path = require('node:path');
const { randomId, assertSafeId } = require('../common/ids');
const { safeFileName } = require('../common/paths');
const { downloadChecked } = require('../common/urlSafety');
const { HttpError } = require('../common/errors');
const { sleep } = require('../common/retry');
const { createPlatformAdapter } = require('./platforms');

function isLikelyVideoFile(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    return head.slice(4, 8).toString('latin1') === 'ftyp';
  } finally {
    fs.closeSync(fd);
  }
}

class AssistantWorker {
  constructor({ config, store, cloud, logger }) {
    this.config = config;
    this.store = store;
    this.cloud = cloud;
    this.logger = logger;
    this.running = false;
    this.busy = false;
    this.stopped = false;
    this.heldTasks = new Map();
    this.currentTaskId = null;
    this.paused = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.recoverInterruptedTasks().catch(error => this.logger.error('恢复检查失败', { error: error.message }));
    this.loop().catch(error => this.logger.error('工作循环异常退出', { error: error.message }));
  }

  stop() {
    this.stopped = true;
    this.running = false;
  }

  async stopAndDrain({ timeoutMs = 90000 } = {}) {
    this.stop();
    const deadline = Date.now() + timeoutMs;
    while (this.busy && Date.now() < deadline) await sleep(200);
    if (this.busy) return false;
    for (const hold of this.heldTasks.values()) {
      clearInterval(hold.leaseTimer);
      clearInterval(hold.watchTimer);
      await hold.adapter.close().catch(() => {});
      this.store.updateLocalTask(hold.task.id, { last_error: { message: '绑定变更，本地接管已关闭', code: 'binding_change' } });
    }
    this.heldTasks.clear();
    return true;
  }

  async loop() {
    while (!this.stopped) {
      try {
        if (!this.busy) await this.runOnce();
      } catch (error) {
        this.logger.error('任务循环失败', { error: error.message, code: error.code });
      }
      await sleep(this.config.pollIntervalMs || 3000);
    }
  }

  status() {
    return {
      running: this.running,
      busy: this.busy,
      paused: this.paused,
      current_task_id: this.currentTaskId,
      held_tasks: [...this.heldTasks.keys()]
    };
  }

  async runOnce() {
    if (this.paused) return;
    if (this.heldTasks.size > 0) return;
    const binding = this.store.getBinding();
    if (!binding) return;
    this.busy = true;
    try {
      const result = await this.cloud.claimTask();
      if (!result.task) return;
      this.currentTaskId = result.task.id;
      await this.handleTask(result.task);
    } finally {
      this.busy = false;
      this.currentTaskId = null;
    }
  }

  async closeAdapter(adapter) {
    if (!adapter || adapter.borrowedFromLogin) return;
    try { await adapter.close(); } catch {}
  }

  findLocalAccountForCloudTask(task) {
    const account = this.store.listAccounts().find(item => item.cloud_account_id === task.account_id);
    if (!account) throw new Error(`云端账号 ${task.account_id} 未同步到本机，请先刷新账号`);
    if (account.platform !== task.platform) throw new Error(`账号平台不匹配：本机 ${account.platform} / 任务 ${task.platform}`);
    return account;
  }

  async handleTask(task) {
    const localAccount = this.findLocalAccountForCloudTask(task);
    this.store.saveLocalTask({ ...task, account_key: localAccount.account_key });
    const borrowed = this.loginBrowsers?.get(localAccount.account_key);
    const adapter = borrowed || createPlatformAdapter(task.platform, {
      automationMode: this.config.automationMode,
      browserName: this.config.browser,
      account: localAccount,
      logger: this.logger
    });
    if (borrowed) adapter.borrowedFromLogin = true;
    clearInterval(this.execLeaseTimer);
    this.execLeaseTimer = setInterval(() => {
      this.cloud.renewLease(task.id, task.attempt_id, false).catch(error => this.logger.warn('执行期间续租失败', { task_id: task.id, error: error.message }));
    }, 30000);
    let submitToken = null;
    try {
      await this.progress(task, 'downloading', 10, '开始下载授权素材');
      const videoPath = await this.downloadMaterial(task);
      this.store.updateLocalTask(task.id, { local_video_path: videoPath, status: 'downloading', progress: 20 });

      await this.progress(task, 'uploading', 25, '检查平台登录状态');
      const login = await adapter.checkLoginState();
      if (login.state) this.store.saveAccountState(localAccount.account_key, login.state);
      if (login.needsUserAction || !login.loggedIn) {
        return this.holdTask(task, adapter, 'login_or_verification', login.verification || { type: 'login_required', message: '平台未登录或登录已失效' });
      }
      const identityCheck = await this.verifyIdentity(localAccount, adapter);
      if (!identityCheck.verified) return this.holdTask(task, adapter, identityCheck.code, { type: 'identity_check', message: identityCheck.message });

      await this.progress(task, 'uploading', 35, '打开平台发布页面');
      const prepared = await adapter.prepareTask(task);
      if (prepared.verification) return this.holdTask(task, adapter, 'verification_before_upload', prepared.verification);

      await this.progress(task, 'uploading', 50, '上传视频');
      await adapter.uploadVideo(videoPath);
      const uploadReady = await adapter.waitForUploadComplete();
      if (!uploadReady.ready) {
        return this.holdTask(task, adapter, 'upload_incomplete', { type: 'upload_incomplete', message: `平台上传/转码未完成或失败：${uploadReady.failure || ''} ${uploadReady.message || ''}`.trim() });
      }
      const verificationAfterUpload = await adapter.detectVerification();
      if (verificationAfterUpload) return this.holdTask(task, adapter, 'verification_after_upload', verificationAfterUpload);

      await this.progress(task, 'uploading', 70, '填写标题、描述和话题');
      const fillResult = await adapter.fillFields({ title: task.title, description: task.description, topics: task.topics || [] });
      const required = adapter.requiredFields || ['description'];
      const missing = required.filter(field => !fillResult.filled || !fillResult.filled[field]);
      if (missing.length) {
        return this.holdTask(task, adapter, 'fields_incomplete', { type: 'fields_incomplete', message: `必填字段未填写或未读回成功：${missing.join('、')}` });
      }
      const verificationAfterFill = await adapter.detectVerification();
      if (verificationAfterFill) return this.holdTask(task, adapter, 'verification_after_fill', verificationAfterFill);

      await this.progress(task, 'ready_to_submit', 90, '上传和填写完成，等待提交授权');
      await this.cloud.saveSubmissionIntent(task.id, task.attempt_id, task.content_version, task.account_id);
      this.store.updateLocalTask(task.id, {
        status: 'ready_to_submit',
        progress: 90,
        submit_intent: { saved_at: new Date().toISOString(), content_version: task.content_version, account_id: task.account_id }
      });

      if ((this.config.submitMode || 'hold_before_submit') === 'hold_before_submit') {
        return this.holdTask(task, adapter, 'hold_before_submit', { type: 'submit_hold', message: '开发测试默认停在最终提交前；确认后可在桌面端执行一次提交。' }, { keepStatus: 'ready_to_submit' });
      }
      return await this.executeSubmit(task, adapter);
    } catch (error) {
      this.logger.error('任务执行失败', { task_id: task.id, error: error.message });
      clearInterval(this.execLeaseTimer);
      await this.closeAdapter(adapter);
      await this.reportSafely(task, 'failed', {}, { message: error.message, code: error.code || 'worker_failed' }, submitToken);
      this.store.updateLocalTask(task.id, { status: 'failed', last_error: { message: error.message, code: error.code || 'worker_failed' } });
      return { outcome: 'failed', error };
    }
  }

  async verifyIdentity(localAccount, adapter) {
    const identity = await (adapter.recheckIdentity ? adapter.recheckIdentity() : adapter.checkIdentity());
    if (!identity || !identity.identity) {
      return { verified: false, code: 'identity_unverifiable', message: '无法从平台页面读取当前账号身份，已阻止继续执行；请人工核对浏览器中登录的账号' };
    }
    if (!localAccount.platform_identity) {
      return { verified: false, code: 'identity_baseline_missing', message: '本机账号尚无身份基线，已阻止自动执行；请在账号页人工登录后点击“检查登录状态”确认身份' };
    }
    if (localAccount.platform_identity !== identity.identity) {
      return { verified: false, code: 'identity_mismatch', message: `平台身份不匹配：本机账号基线 ${localAccount.platform_identity} / 当前页面 ${identity.identity}` };
    }
    return { verified: true, identity };
  }

  async downloadMaterial(task, { allowExisting = false } = {}) {
    assertSafeId(task.id, 'task_id');
    const dir = path.resolve(this.config.downloadDir || path.join(this.config.dataDir, 'downloads'));
    fs.mkdirSync(dir, { recursive: true });
    const material = task.material || {
      material_id: task.material_id || task.id,
      download_url: task.material_download_url,
      filename: task.material_filename,
      content_type: task.material_content_type,
      size_bytes: null,
      sha256: task.material_sha256 || null
    };
    const keyParts = [String(material.material_id || task.id)];
    if (task.video_version) keyParts.push(String(task.video_version));
    const cacheKey = keyParts.map(part => part.replace(/[^A-Za-z0-9_-]/g, '_')).filter(Boolean).join('-');
    const filename = safeFileName(material.filename || 'video.mp4');
    const destination = path.resolve(dir, `${cacheKey}-${filename}`);
    if (!destination.startsWith(dir + path.sep)) throw new Error('素材下载路径越界');
    if (fs.existsSync(destination)) {
      const stat = fs.statSync(destination);
      const sizeOk = material.size_bytes == null || stat.size === material.size_bytes;
      if (sizeOk) {
        this.logger.info('素材命中本机缓存', { task_id: task.id, material_id: material.material_id });
        return destination;
      }
      fs.rmSync(destination, { force: true });
    }

    let downloadUrl = material.download_url;
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const tmpPath = `${destination}.tmp-${randomId('dl', 6)}`;
      try {
        const result = await downloadChecked(downloadUrl, tmpPath, {
          allowLoopback: Boolean(this.config.allowLoopbackMaterialUrls),
          expectedSha256: material.sha256 || undefined,
          expectedBytes: material.size_bytes ?? undefined,
          allowedContentTypePrefixes: ['video/', 'application/octet-stream']
        });
        if ((result.contentType || '').startsWith('video/') && !isLikelyVideoFile(tmpPath)) {
          fs.rmSync(tmpPath, { force: true });
          throw new HttpError(422, 'material_not_a_video', '素材内容不是有效视频编码');
        }
        fs.renameSync(tmpPath, destination);
        this.logger.info('素材下载完成', { task_id: task.id, bytes: result.bytes, sha256: result.sha256 });
        return destination;
      } catch (error) {
        fs.rmSync(tmpPath, { force: true });
        lastError = error;
        const status = error.statusCode || 0;
        const canRefresh = [401, 403, 410].includes(status) && task.attempt_id && task.id;
        if (canRefresh && attempt === 0) {
          this.logger.warn('素材下载授权失效，申请刷新', { task_id: task.id, status });
          const refreshed = await this.cloud.refreshMaterialDownload(task.id, task.attempt_id);
          downloadUrl = refreshed.material.download_url;
          continue;
        }
        if ((status === 429 || status >= 500) && attempt === 0) {
          await sleep(3000);
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  async progress(task, status, progress, message, error) {
    await this.cloud.progress(task.id, task.attempt_id, status, progress, message, error);
    this.store.updateLocalTask(task.id, { status, progress, last_error: error || null });
  }

  holdTask(task, adapter, stage, reason, { keepStatus } = {}) {
    clearInterval(this.execLeaseTimer);
    if (this.stopped) {
      this.closeAdapter(adapter).catch(() => {});
      this.store.updateLocalTask(task.id, { last_error: { message: '助手正在停止，任务未挂起接管', code: 'worker_stopped' } });
      this.busy = false;
      this.currentTaskId = null;
      return { outcome: 'aborted', reason };
    }
    const hold = { task, adapter, stage, reason, held_at: new Date().toISOString(), leaseTimer: null, watchTimer: null, resuming: false };
    hold.leaseTimer = setInterval(() => {
      this.cloud.renewLease(task.id, task.attempt_id, true).catch(error => this.logger.warn('接管期间续租失败', { task_id: task.id, error: error.message }));
    }, 30000);
    if (stage !== 'hold_before_submit') hold.watchTimer = this.startVerificationWatch(hold);
    this.heldTasks.set(task.id, hold);
    const status = keepStatus || 'needs_user_action';
    this.cloud.progress(task.id, task.attempt_id, status, keepStatus ? 90 : task.progress || 60, reason.message || '需要人工处理', reason)
      .catch(error => this.logger.warn('上报接管状态失败', { task_id: task.id, error: error.message }));
    this.store.updateLocalTask(task.id, { status, progress: keepStatus ? 90 : (task.progress || 60), last_error: reason });
    this.busy = false;
    this.currentTaskId = null;
    return { outcome: 'held', reason };
  }

  startVerificationWatch(hold) {
    const interval = this.config.verificationWatchIntervalMs || 15000;
    const maxWait = this.config.verificationWatchTimeoutMs || 30 * 60 * 1000;
    let strikes = 0;
    return setInterval(async () => {
      if (this.stopped || hold.resuming || hold.stage === 'hold_before_submit') return;
      if (Date.now() - Date.parse(hold.held_at) > maxWait) {
        await this.failHeldTask(hold.task.id, '平台验证/登录等待超时', 'verification_timeout');
        return;
      }
      const { task, adapter } = hold;
      try {
        const login = await adapter.checkLoginStateReadOnly();
        if (login.reason === 'browser_not_started') {
          strikes += 1;
          if (strikes >= 4) await this.failHeldTask(task.id, '浏览器已被关闭，无法继续', 'browser_closed');
          return;
        }
        if (await adapter.detectVerification()) return;
        if (!login.loggedIn) return;
        hold.resuming = true;
        this.logger.info('检测到平台验证已完成，自动恢复任务', { task_id: task.id });
        try {
          await this.continueTask(task.id, { fromWatch: true });
        } catch (error) {
          if (error.code === 'task_terminal' || error.code === 'not_found' || /task_terminal|not_found/.test(error.message)) {
            this.dropHeldTask(task.id, '云端任务已终止，放弃本地接管');
            return;
          }
          this.logger.warn('自动恢复失败，等待下次检测', { task_id: task.id, error: error.message });
        } finally {
          if (this.heldTasks.has(task.id)) hold.resuming = false;
        }
      } catch (error) {
        strikes += 1;
        this.logger.warn('接管监视检查失败', { task_id: task.id, error: error.message, strikes });
        if (strikes >= 8) await this.failHeldTask(task.id, `接管监视持续失败：${error.message}`, 'watch_failed');
      }
    }, interval);
  }

  async failHeldTask(taskId, message, code) {
    const hold = this.heldTasks.get(taskId);
    if (!hold) return;
    clearInterval(hold.leaseTimer);
    clearInterval(hold.watchTimer);
    await this.closeAdapter(hold.adapter);
    this.heldTasks.delete(taskId);
    await this.reportSafely(hold.task, 'failed', {}, { message, code }, null);
    this.store.updateLocalTask(taskId, { status: 'failed', last_error: { message, code } });
  }

  async dropHeldTask(taskId, message) {
    const hold = this.heldTasks.get(taskId);
    if (!hold) return;
    clearInterval(hold.leaseTimer);
    clearInterval(hold.watchTimer);
    await this.closeAdapter(hold.adapter);
    this.heldTasks.delete(taskId);
    this.store.updateLocalTask(taskId, { status: 'cancelled', last_error: { message, code: 'cloud_terminal' } });
  }

  async continueTask(taskId, { fromWatch = false } = {}) {
    const hold = this.heldTasks.get(taskId);
    if (!hold) throw new Error('任务不在人工接管或待提交保持状态');
    if (hold.resuming && !fromWatch) throw new Error('任务正在自动恢复中，请稍候');
    const { task, adapter } = hold;
    const stage = hold.stage;
    this.busy = true;
    this.currentTaskId = taskId;
    try {
      const login = await adapter.checkLoginStateReadOnly();
      if (login.reason === 'browser_not_started') throw new Error('浏览器未运行，无法只读恢复；请重新打开登录窗口');
      if (login.needsUserAction || !login.loggedIn) throw new Error('平台登录或验证仍未完成');
      const verification = await adapter.detectVerification();
      if (verification) throw new Error(verification.message || '仍存在平台验证');
      if (stage === 'hold_before_submit') return await this.submitHeldTask(taskId);

      const local = this.store.getLocalTask(task.id);
      const videoPath = local?.local_video_path;
      if (!videoPath || !fs.existsSync(videoPath)) throw new Error('本地素材缓存不存在，无法从原阶段恢复');
      if (stage === 'login_or_verification' || stage === 'verification_before_upload' || stage === 'upload_incomplete') {
        const prepared = await adapter.prepareTask(task);
        if (prepared.verification) throw new Error(prepared.verification.message || '仍存在平台验证');
        await this.progress(task, 'uploading', 50, '人工处理完成，从上传视频阶段恢复');
        await adapter.uploadVideo(videoPath);
        const uploadReady = await adapter.waitForUploadComplete();
        if (!uploadReady.ready) throw new Error(`恢复后上传未完成：${uploadReady.failure || uploadReady.message || ''}`);
      }
      if (stage === 'login_or_verification' || stage === 'verification_before_upload' || stage === 'verification_after_upload' || stage === 'upload_incomplete' || stage === 'fields_incomplete') {
        await this.progress(task, 'uploading', 70, '人工处理完成，从填写字段阶段恢复');
        const fillResult = await adapter.fillFields({ title: task.title, description: task.description, topics: task.topics || [] });
        const required = adapter.requiredFields || ['description'];
        const missing = required.filter(field => !fillResult.filled || !fillResult.filled[field]);
        if (missing.length) throw new Error(`恢复后必填字段读回失败：${missing.join('、')}`);
      }
      const verificationAfterResume = await adapter.detectVerification();
      if (verificationAfterResume) throw new Error(verificationAfterResume.message || '仍存在平台验证');
      await this.progress(task, 'ready_to_submit', 90, '人工处理完成，重新检查通过，等待最终提交');
      await this.cloud.saveSubmissionIntent(task.id, task.attempt_id, task.content_version, task.account_id);
      this.store.updateLocalTask(task.id, { submit_intent: { saved_at: new Date().toISOString(), content_version: task.content_version, account_id: task.account_id } });
      clearInterval(hold.watchTimer);
      hold.stage = 'hold_before_submit';
      if ((this.config.submitMode || 'hold_before_submit') !== 'hold_before_submit') {
        return await this.submitHeldTask(taskId);
      }
      return { ok: true, stage: 'hold_before_submit' };
    } finally {
      this.busy = false;
      this.currentTaskId = null;
    }
  }

  async submitHeldTask(taskId) {
    const hold = this.heldTasks.get(taskId);
    if (!hold) throw new Error('任务不在待提交状态');
    const { task, adapter } = hold;
    this.busy = true;
    this.currentTaskId = taskId;
    try {
      await this.cloud.renewLease(task.id, task.attempt_id, false);
      await this.cloud.saveSubmissionIntent(task.id, task.attempt_id, task.content_version, task.account_id);
      const result = await this.executeSubmit(task, adapter);
      if (result.outcome === 'held') return result;
      clearInterval(hold.leaseTimer);
      this.heldTasks.delete(taskId);
      return result;
    } finally {
      this.busy = false;
      this.currentTaskId = null;
    }
  }

  async executeSubmit(task, adapter) {
    clearInterval(this.execLeaseTimer);
    let submitToken = null;
    try {
      const local = this.store.getLocalTask(task.id);
      const localAccount = local && local.account_key ? this.store.getAccount(local.account_key) : null;
      if (localAccount) {
        const recheck = await this.verifyIdentity(localAccount, adapter);
        if (!recheck.verified) {
          if (this.heldTasks.has(task.id)) {
            const reason = { code: recheck.code, message: `提交前身份核验未通过：${recheck.message}` };
            this.store.updateLocalTask(task.id, { last_error: reason });
            const hold = this.heldTasks.get(task.id);
            if (hold) hold.reason = reason;
            return { outcome: 'held', reason };
          }
          throw new Error(`提交前身份核验未通过：${recheck.message}`);
        }
      }
      const authorization = await this.cloud.authorizeSubmit(task.id, task.attempt_id, task.content_version);
      submitToken = authorization.submit_token;
      this.store.updateLocalTask(task.id, { status: 'submitting', progress: 95, report_key: randomId('report', 12) });
      const submitEvidence = await adapter.submitOnce();
      const result = await adapter.verifyResult();
      await this.reportSafely(task, result.outcome, { submit: submitEvidence, ...(result.evidence || {}) }, result.outcome === 'failed' ? { message: '平台返回失败特征' } : null, submitToken);
      await this.closeAdapter(adapter);
      return result;
    } catch (error) {
      if (submitToken) {
        await this.reportSafely(task, 'outcome_unknown', { reason: '提交后发生异常，不能自动二次提交', error: error.message }, { message: error.message }, submitToken);
        await this.closeAdapter(adapter);
        return { outcome: 'outcome_unknown', error: error.message };
      }
      await this.reportSafely(task, 'failed', { reason: '提交授权或提交前检查失败', error: error.message }, { message: error.message }, null);
      await this.closeAdapter(adapter);
      return { outcome: 'failed', error: error.message };
    }
  }

  async reportSafely(task, outcome, evidence, error, submitToken) {
    const reportKey = this.store.getLocalTask(task.id)?.report_key || randomId('report', 12);
    this.store.updateLocalTask(task.id, { report_key: reportKey });
    try {
      await this.cloud.reportResult(task.id, task.attempt_id, reportKey, outcome, evidence, error, submitToken);
    } catch (reportError) {
      this.logger.error('结果回传失败，已进入待回传队列，启动时重放', { task_id: task.id, error: reportError.message });
      this.store.addOutbox({ taskId: task.id, attemptId: task.attempt_id, reportKey, outcome, evidence, error, submitToken });
    }
    this.store.updateLocalTask(task.id, { status: outcome, progress: outcome === 'submitted' ? 100 : (this.store.getLocalTask(task.id)?.progress || 0), last_error: error || null });
  }

  async replayOutbox() {
    for (const item of this.store.listOutbox()) {
      try {
        await this.cloud.reportResult(item.taskId, item.attemptId, item.reportKey, item.outcome, item.evidence, item.error, item.submitToken);
        this.store.removeOutbox(item.id);
        this.logger.info('待回传结果重放成功', { task_id: item.taskId, outcome: item.outcome });
      } catch (error) {
        if (error.statusCode >= 400 && error.statusCode < 500) {
          this.logger.warn('待回传结果被服务端拒绝，丢弃', { task_id: item.taskId, code: error.code });
          this.store.removeOutbox(item.id);
        } else {
          this.logger.warn('待回传结果重放失败，下次启动再试', { task_id: item.taskId, error: error.message });
          break;
        }
      }
    }
  }

  async cancelTask(taskId) {
    const hold = this.heldTasks.get(taskId);
    if (hold) {
      clearInterval(hold.leaseTimer);
      clearInterval(hold.watchTimer);
      await this.closeAdapter(hold.adapter);
      this.heldTasks.delete(taskId);
    }
    this.store.updateLocalTask(taskId, { status: 'cancelled' });
    return { ok: true };
  }

  async recoverInterruptedTasks() {
    this.busy = true;
    try {
      await this.replayOutbox();
      for (const local of this.store.listLocalTasks()) {
        if (local.status === 'submitting') {
          this.logger.warn('发现中断的提交任务，进入结果待核实', { task_id: local.task_id });
          if (local.attempt_id && local.report_key) {
            await this.cloud.reportResult(local.task_id, local.attempt_id, local.report_key, 'outcome_unknown', { reason: '客户端在提交阶段中断，不能自动二次提交' }, null, null).catch(() => {});
          }
          this.store.updateLocalTask(local.task_id, { status: 'outcome_unknown', last_error: { message: '提交阶段中断，需人工核实' } });
        } else if (local.status === 'ready_to_submit') {
          this.logger.warn('发现待提交任务，查询云端状态并尝试恢复', { task_id: local.task_id });
          await this.recoverReadyToSubmit(local).catch(error => {
            this.logger.error('待提交任务恢复失败', { task_id: local.task_id, error: error.message });
            this.store.updateLocalTask(local.task_id, { last_error: { message: `恢复失败：${error.message}`, code: 'recovery_failed' } });
          });
        }
      }
    } finally {
      this.busy = false;
    }
  }

  async recoverReadyToSubmit(local) {
    try {
      const cloudTask = await this.cloud.getTask(local.task_id);
      const cloudStatus = cloudTask?.task?.status;
      if (cloudStatus && ['cancelled', 'submitted', 'failed', 'outcome_unknown'].includes(cloudStatus)) {
        this.store.updateLocalTask(local.task_id, { status: cloudStatus === 'cancelled' ? 'cancelled' : cloudStatus, last_error: { message: '云端任务已终态，无需恢复', code: 'cloud_terminal' } });
        this.logger.info('待提交任务云端已终态，跳过恢复', { task_id: local.task_id, cloud_status: cloudStatus });
        return;
      }
    } catch {
      this.logger.warn('云端任务状态查询失败，暂停恢复该任务', { task_id: local.task_id });
      return;
    }
    const task = { ...local.payload, id: local.task_id, attempt_id: local.attempt_id, status: 'ready_to_submit', progress: 90 };
    const account = this.store.getAccount(local.account_key);
    if (!account) throw new Error('本地账号不存在，无法恢复');
    const adapter = createPlatformAdapter(local.platform, {
      automationMode: this.config.automationMode,
      browserName: this.config.browser,
      account,
      logger: this.logger
    });
    const login = await adapter.checkLoginState();
    if (login.needsUserAction || !login.loggedIn) {
      return this.holdTask(task, adapter, 'login_or_verification', login.verification || { type: 'login_required', message: '恢复时平台未登录' });
    }
    const identityCheck = await this.verifyIdentity(account, adapter);
    if (!identityCheck.verified) return this.holdTask(task, adapter, identityCheck.code, { type: 'identity_check', message: identityCheck.message });

    let videoPath = local.local_video_path;
    if (!videoPath || !fs.existsSync(videoPath)) {
      videoPath = await this.downloadMaterial({ ...local.payload, id: local.task_id }, { allowExisting: true });
    }
    const prepared = await adapter.prepareTask(task);
    if (prepared.verification) return this.holdTask(task, adapter, 'verification_before_upload', prepared.verification);
    await adapter.uploadVideo(videoPath);
    const uploadReady = await adapter.waitForUploadComplete();
    if (!uploadReady.ready) return this.holdTask(task, adapter, 'upload_incomplete', { type: 'upload_incomplete', message: '恢复后上传未完成' });
    const fillResult = await adapter.fillFields({ title: task.title, description: task.description, topics: task.topics || [] });
    const required = adapter.requiredFields || ['description'];
    const missing = required.filter(field => !fillResult.filled || !fillResult.filled[field]);
    if (missing.length) return this.holdTask(task, adapter, 'fields_incomplete', { type: 'fields_incomplete', message: `恢复后字段读回失败：${missing.join('、')}` });
    await this.cloud.saveSubmissionIntent(task.id, task.attempt_id, task.content_version, task.account_id);
    this.cloud.progress(task.id, task.attempt_id, 'ready_to_submit', 90, '助手重启后已恢复待提交状态', null).catch(() => {});
    if ((this.config.submitMode || 'hold_before_submit') !== 'hold_before_submit') {
      this.logger.info('重启恢复后按自动模式直接提交', { task_id: task.id });
      return await this.executeSubmit(task, adapter);
    }
    return this.holdTask(task, adapter, 'hold_before_submit', { type: 'submit_hold', message: '助手重启后已恢复，确认后可提交' }, { keepStatus: 'ready_to_submit' });
  }
}

module.exports = { AssistantWorker };