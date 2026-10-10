const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { LocalStore, subjectKeyFor, legacySubjectKeyFor } = require('./localStore');
const { CloudClient } = require('./cloudClient');
const { AssistantWorker } = require('./worker');
const { Logger, redact } = require('../common/log');
const { readJsonBody, sendJson, sendError } = require('../common/json');
const { unauthorized, notFound, badRequest, forbidden, conflict } = require('../common/errors');
const { requireString, requirePlatform } = require('../common/validation');
const { randomId } = require('../common/ids');
const { isAvailable: dpapiAvailable } = require('../common/dpapi');
const { createPlatformAdapter, capabilities } = require('./platforms');

const VERSION = require('../../package.json').version;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--config') args.config = argv[++i];
  return args;
}

function loadConfig(filePath) {
  const resolved = path.resolve(filePath || 'config/assistant.development.json');
  const raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const root = path.dirname(path.dirname(resolved));
  const resolveMaybe = value => value && !path.isAbsolute(value) ? path.join(root, value) : value;
  return { ...raw, configPath: resolved, rootDir: root, dataDir: resolveMaybe(raw.dataDir), downloadDir: resolveMaybe(raw.downloadDir), logDir: resolveMaybe(raw.logDir) };
}

class AssistantApp {
  constructor(config) {
    this.config = config;
    this.logger = new Logger({ dir: config.logDir, name: 'assistant' });
    const dpapiReady = dpapiAvailable();
    this.dpapiReady = dpapiReady;
    const simulationContext = config.mode === 'simulation' && config.automationMode === 'simulated';
    if (config.allowInsecureSecretStorage === true && !simulationContext) {
      throw new Error('allowInsecureSecretStorage 仅允许在 simulation + simulated 模式下使用；生产或真实平台（cdp）模式禁止未加密秘密存储，拒绝启动');
    }
    const simulationFallback = simulationContext && !dpapiReady;
    const useInsecureProtector = simulationContext && (config.allowInsecureSecretStorage === true || simulationFallback);
    if (useInsecureProtector) this.logger.warn('当前使用未加密秘密存储（insecure-dev）；仅限 simulation + simulated 开发降级，禁止用于真实平台账号');
    const secretProtector = useInsecureProtector
      ? {
          protect: value => `insecure-dev:${Buffer.from(String(value), 'utf8').toString('base64')}`,
          unprotect: value => Buffer.from(String(value).replace(/^insecure-dev:/, ''), 'base64').toString('utf8')
        }
      : undefined;
    this.store = new LocalStore({ dataDir: config.dataDir, secretProtector });
    this.localToken = this.store.getSetting('local_api_token') || randomId('local', 24);
    this.store.setSetting('local_api_token', this.localToken);
    this.cloud = new CloudClient({
      serviceUrl: config.serviceUrl,
      deviceTokenProvider: () => this.store.getBinding(),
      logger: this.logger
    });
    this.worker = new AssistantWorker({ config, store: this.store, cloud: this.cloud, logger: this.logger });
    this.openLoginBrowsers = new Map();
    this.worker.loginBrowsers = this.openLoginBrowsers;
    this.pendingBinding = null;
    this.heartbeatTimer = null;
    this.subjectMismatch = false;
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  acquireInstanceLock() {
    const lockPath = path.join(this.config.dataDir, 'assistant.lock');
    if (fs.existsSync(lockPath)) {
      try {
        const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (lock.pid && lock.pid !== process.pid) {
          try {
            process.kill(lock.pid, 0);
            throw new Error(`同一数据目录已有助手实例在运行（PID ${lock.pid}），禁止多实例并发执行`);
          } catch (error) {
            if (error.code !== 'ESRCH') throw error;
          }
        }
      } catch (error) {
        if (error instanceof SyntaxError) {
          fs.rmSync(lockPath, { force: true });
        } else {
          throw error;
        }
      }
    }
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }), { encoding: 'utf8', mode: 0o600 });
    this.lockPath = lockPath;
    process.on('exit', () => { try { fs.rmSync(lockPath, { force: true }); } catch {} });
  }

  async start() {
    this.acquireInstanceLock();
    const port = this.config.localApiPort ?? 8781;
    const host = this.config.localApiHost ?? '127.0.0.1';
    await new Promise(resolve => this.server.listen(port, host, resolve));
    fs.writeFileSync(path.join(this.config.dataDir, 'runtime.json'), JSON.stringify({
      port: this.server.address().port,
      host,
      token: this.localToken,
      mode: this.config.mode,
      started_at: new Date().toISOString()
    }, null, 2), { encoding: 'utf8', mode: 0o600 });
    if (this.store.getBinding()) {
      this.worker.start();
      this.startHeartbeat();
    }
    this.logger.info('助手核心已启动', { mode: this.config.mode, service: this.config.serviceUrl });
  }

  stop() {
    clearInterval(this.heartbeatTimer);
    this.worker.stop();
    this.server.close();
    if (this.lockPath) { try { fs.rmSync(this.lockPath, { force: true }); } catch {} }
  }

  startHeartbeat() {
    clearInterval(this.heartbeatTimer);
    const beat = async () => {
      try {
        const result = await this.cloud.heartbeat(VERSION);
        const subjectOk = this.reconcileSubject(result?.user_id);
        if (!subjectOk) return;
        await this.syncAccounts();
      } catch (error) {
        this.logger.warn('心跳或账号同步失败', { error: error.message, code: error.code });
      }
    };
    beat();
    this.heartbeatTimer = setInterval(beat, this.config.heartbeatIntervalMs || 30000);
  }

  reconcileSubject(userId) {
    if (!userId) return true;
    const binding = this.store.getBinding();
    if (!binding) return true;
    const expected = subjectKeyFor(this.config.serviceUrl, userId);
    if (!binding.subjectKey) {
      const adopted = this.store.transact(() => {
        this.store.setBindingSubject(expected);
        return this.store.adoptSubjectForLegacyRows(expected);
      });
      this.logger.info('已回填绑定业务主体', { subject_key: expected, adopted_accounts: adopted.accounts, adopted_tasks: adopted.tasks });
    } else if (binding.subjectKey !== expected) {
      const legacyKey = legacySubjectKeyFor(this.config.serviceUrl, userId);
      if (legacyKey && binding.subjectKey === legacyKey) {
        this.store.setBindingSubject(expected);
        this.logger.info('主体键已迁移到规范化 URL 形式', { subject_key: expected });
        return true;
      }
      if (!this.subjectMismatch) {
        this.subjectMismatch = true;
        this.logger.error('云端业务主体与本地绑定主体不一致，已停止任务执行；请解绑后重新绑定', { expected, actual: binding.subjectKey });
        this.worker.stop();
      }
      return false;
    }
    return true;
  }

  async quiesceForBindingChange() {
    const drained = await this.worker.stopAndDrain({ timeoutMs: 90000 });
    if (!drained) {
      this.worker.start();
      throw conflict('worker_busy', '仍有任务正在执行，无法安全切换绑定；请等待任务结束后再试');
    }
    if (this.openLoginBrowsers) {
      for (const adapter of this.openLoginBrowsers.values()) await adapter.close().catch(() => {});
      this.openLoginBrowsers.clear();
    }
    clearInterval(this.heartbeatTimer);
  }

  async syncAccounts() {
    if (!this.store.getBinding()) return { accounts: [] };
    const accounts = this.store.listAccounts().map(account => ({
      account_key: account.account_key,
      platform: account.platform,
      nickname: account.nickname,
      platform_identity: account.platform_identity,
      status: account.status,
      capabilities: account.capabilities,
      last_check_at: account.last_check_at
    }));
    const result = await this.cloud.syncAccounts(accounts);
    for (const mapping of result.accounts || []) this.store.updateAccountCloudId(mapping.account_key, mapping.account_id);
    return result;
  }

  requireLocalAuth(req) {
    if ((req.headers.authorization || '') !== `Bearer ${this.localToken}`) throw unauthorized('本地接口凭证无效');
  }

  async handle(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;
      this.requireLocalAuth(req);

      if (pathname === '/local/v1/status' && req.method === 'GET') {
        const binding = this.store.getBinding();
        return sendJson(res, 200, {
          version: VERSION,
          mode: this.config.mode,
          simulation: this.config.mode === 'simulation',
          submit_mode: this.config.submitMode || 'hold_before_submit',
          service_url: this.config.serviceUrl,
          bound: Boolean(binding),
          device_id: binding?.deviceId,
          bound_at: binding?.boundAt,
          dpapi_available: this.dpapiReady,
          worker: this.worker.status(),
          pending_binding: this.pendingBinding ? { binding_id: this.pendingBinding.binding_id, code: this.pendingBinding.code, expires_at: this.pendingBinding.expires_at } : null,
          hostname: os.hostname()
        });
      }

      if (pathname === '/local/v1/capabilities' && req.method === 'GET') return sendJson(res, 200, capabilities());

      if (pathname === '/local/v1/bindings' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const deviceName = requireString(body.device_name || os.hostname(), 'device_name', { max: 120 });
        this.pendingBinding = await this.cloud.createBinding({ deviceName, assistantVersion: VERSION });
        return sendJson(res, 201, this.pendingBinding);
      }

      if (pathname === '/local/v1/bindings/poll' && req.method === 'POST') {
        if (!this.pendingBinding) throw badRequest('no_pending_binding', '没有待确认绑定');
        const result = await this.cloud.pollBinding(this.pendingBinding.binding_id, this.pendingBinding.poll_token);
        if (result.status === 'approved') {
          const subjectKey = subjectKeyFor(this.config.serviceUrl, result.user_id);
          if (this.store.getBinding()) {
            await this.quiesceForBindingChange();
            this.store.clearBinding();
          }
          this.store.saveBinding({ deviceId: result.device_id, deviceToken: result.device_token, serviceUrl: this.config.serviceUrl, subjectKey });
          this.pendingBinding = null;
          this.subjectMismatch = false;
          this.worker.start();
          this.startHeartbeat();
        }
        return sendJson(res, 200, result);
      }

      if (pathname === '/local/v1/binding' && req.method === 'DELETE') {
        await this.quiesceForBindingChange();
        this.store.clearBinding();
        return sendJson(res, 200, { ok: true, note: '已清除本机绑定并停止任务执行；云端撤销需在业务控制台操作。旧主体账号数据保留但与新绑定隔离。' });
      }

      if (pathname === '/local/v1/accounts' && req.method === 'GET') return sendJson(res, 200, { accounts: this.store.listAccounts() });

      if (pathname === '/local/v1/accounts' && req.method === 'POST') {
        const binding = this.store.getBinding();
        if (!binding) throw conflict('not_bound', '设备尚未绑定，不能添加平台账号');
        const body = await readJsonBody(req);
        const platform = requirePlatform(body.platform);
        const account = this.store.createAccount({
          platform,
          nickname: requireString(body.nickname, 'nickname', { max: 120 }),
          capabilities: capabilities().platforms[platform] || {},
          subjectKey: binding.subjectKey
        });
        const sync = await this.syncAccounts().catch(error => ({ sync_error: error.message }));
        return sendJson(res, 201, { account, sync });
      }

      let match = pathname.match(/^\/local\/v1\/accounts\/([^/]+)\/login$/);
      if (match && req.method === 'POST') {
        const account = this.requireAccount(decodeURIComponent(match[1]));
        const adapter = createPlatformAdapter(account.platform, { automationMode: this.config.automationMode, browserName: this.config.browser, account, logger: this.logger });
        const result = await adapter.login();
        if (adapter.browser) this.openLoginBrowsers = this.openLoginBrowsers || new Map();
        if (adapter.browser) this.openLoginBrowsers.set(account.account_key, adapter);
        return sendJson(res, 200, result);
      }

      match = pathname.match(/^\/local\/v1\/accounts\/([^/]+)\/check$/);
      if (match && req.method === 'POST') {
        const account = this.requireAccount(decodeURIComponent(match[1]));
        const adapter = this.openLoginBrowsers?.get(account.account_key) || createPlatformAdapter(account.platform, { automationMode: this.config.automationMode, browserName: this.config.browser, account, logger: this.logger });
        const result = await adapter.checkLoginState();
        if (result.state) this.store.saveAccountState(account.account_key, result.state);
        this.store.updateAccountStatus(account.account_key, { status: result.loggedIn ? 'logged_in' : 'login_required', platformIdentity: result.identity?.identity, lastCheckAt: new Date().toISOString() });
        await this.syncAccounts().catch(error => this.logger.warn('账号同步失败', { error: error.message }));
        return sendJson(res, 200, result);
      }

      match = pathname.match(/^\/local\/v1\/accounts\/([^/]+)$/);
      if (match && req.method === 'DELETE') {
        const key = decodeURIComponent(match[1]);
        this.requireAccount(key);
        const adapter = this.openLoginBrowsers?.get(key);
        await adapter?.close().catch(() => {});
        this.store.deleteAccount(key);
        await this.syncAccounts().catch(() => {});
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/local/v1/accounts/sync' && req.method === 'POST') return sendJson(res, 200, await this.syncAccounts());

      if (pathname === '/local/v1/tasks' && req.method === 'GET') return sendJson(res, 200, { tasks: this.store.listLocalTasks(), held_tasks: [...this.worker.heldTasks.keys()] });

      match = pathname.match(/^\/local\/v1\/tasks\/([^/]+)\/continue$/);
      if (match && req.method === 'POST') return sendJson(res, 200, await this.worker.continueTask(decodeURIComponent(match[1])));

      match = pathname.match(/^\/local\/v1\/tasks\/([^/]+)\/submit$/);
      if (match && req.method === 'POST') return sendJson(res, 200, await this.worker.submitHeldTask(decodeURIComponent(match[1])));

      match = pathname.match(/^\/local\/v1\/tasks\/([^/]+)\/cancel-local$/);
      if (match && req.method === 'POST') {
        this.requireLocalTask(decodeURIComponent(match[1]));
        return sendJson(res, 200, await this.worker.cancelTask(decodeURIComponent(match[1])));
      }

      if (pathname === '/local/v1/worker/pause' && req.method === 'POST') {
        this.worker.paused = true;
        return sendJson(res, 200, { ok: true, paused: true });
      }

      if (pathname === '/local/v1/worker/resume' && req.method === 'POST') {
        this.worker.paused = false;
        return sendJson(res, 200, { ok: true, paused: false });
      }

      if (pathname === '/local/v1/settings' && req.method === 'GET') {
        return sendJson(res, 200, { mode: this.config.mode, service_url: this.config.serviceUrl, automation_mode: this.config.automationMode, submit_mode: this.config.submitMode, browser: this.config.browser, startup_enabled: false });
      }

      if (pathname === '/local/v1/logs/export' && req.method === 'GET') {
        const files = fs.existsSync(this.config.logDir) ? fs.readdirSync(this.config.logDir).filter(name => name.endsWith('.jsonl')).sort() : [];
        const lines = files.flatMap(name => fs.readFileSync(path.join(this.config.logDir, name), 'utf8').split(/\r?\n/).filter(Boolean).slice(-200));
        return sendJson(res, 200, { redacted: true, lines: redact(lines) });
      }

      if (pathname === '/local/v1/cache/clear' && req.method === 'POST') {
        const dir = path.resolve(this.config.downloadDir);
        const root = path.resolve(this.config.rootDir);
        if (!dir.startsWith(root + path.sep) && !dir.startsWith(path.resolve(this.config.dataDir) + path.sep)) throw forbidden('拒绝清理工作区外缓存目录');
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        return sendJson(res, 200, { ok: true });
      }

      throw notFound('本地接口不存在');
    } catch (error) {
      sendError(res, error);
    }
  }

  requireAccount(accountKey) {
    const account = this.store.getAccount(accountKey);
    const binding = this.store.getBinding();
    if (!account || !binding || (account.subject_key || null) !== (binding.subjectKey || null)) throw notFound('平台账号不存在');
    return account;
  }

  requireLocalTask(taskId) {
    const local = this.store.getLocalTask(taskId);
    const binding = this.store.getBinding();
    if (!local || !binding || (local.subject_key || null) !== (binding.subjectKey || null)) throw notFound('本地任务不存在');
    return local;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.config);
  const app = new AssistantApp(config);
  await app.start();
  console.log(`[助手核心] listening at http://${config.localApiHost || '127.0.0.1'}:${config.localApiPort || 8781}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { AssistantApp, loadConfig };