const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { MockBackendStore } = require('./store');
const { readJsonBody, readRawBody, sendJson, sendError } = require('../common/json');
const { unauthorized, forbidden, notFound, badRequest, HttpError } = require('../common/errors');
const { requireString, optionalString, requirePlatform, requireTopics, requireBoolean } = require('../common/validation');
const { safeFileName } = require('../common/paths');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') args.config = argv[++i];
  }
  return args;
}

function loadConfig(filePath) {
  const resolved = path.resolve(filePath || 'config/mock-backend.development.json');
  const config = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  return { ...config, configPath: resolved, rootDir: path.dirname(path.dirname(resolved)) };
}

function bearerToken(req) {
  const value = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match ? match[1].trim() : null;
}

function publicUser(user) {
  return { id: user.id, login_name: user.login_name, display_name: user.display_name };
}

class MockBackendServer {
  constructor(config) {
    this.config = config;
    const databasePath = path.resolve(config.databasePath || 'runtime/mock-backend.db');
    this.store = new MockBackendStore({
      databasePath,
      storageDir: path.resolve(config.storageDir || path.join(path.dirname(databasePath), 'materials')),
      publicBaseUrl: config.publicBaseUrl || `http://${config.host || '127.0.0.1'}:${config.port || 8780}`
    });
    if (config.seedDemoData !== false) this.demoUsers = this.store.seedDemoData();
    this.consoleDir = path.resolve(__dirname, '../mock-console');
    this.capabilities = JSON.parse(fs.readFileSync(path.resolve('config/platform-capabilities.json'), 'utf8'));
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  start() {
    return new Promise(resolve => {
      this.server.listen(this.config.port ?? 8780, this.config.host ?? '127.0.0.1', () => {
        const address = this.server.address();
        if (!this.config.publicBaseUrl) this.store.publicBaseUrl = `http://${address.address}:${address.port}`;
        resolve(address);
      });
    });
  }

  stop() {
    return new Promise(resolve => this.server.close(resolve));
  }

  requireUser(req) {
    const user = this.store.getUserByToken(bearerToken(req));
    if (!user) throw unauthorized('业务用户凭证无效');
    return user;
  }

  requireDevice(req) {
    const device = this.store.getDeviceByToken(bearerToken(req));
    if (!device) throw unauthorized('设备凭证无效或设备已撤销');
    return device;
  }

  requireUserOrDevice(req) {
    const token = bearerToken(req);
    const user = this.store.getUserByToken(token);
    if (user) return { type: 'user', user };
    const device = this.store.getDeviceByToken(token);
    if (device) return { type: 'device', device };
    throw unauthorized();
  }

  async handle(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;
      res.setHeader('x-content-type-options', 'nosniff');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,authorization,x-file-name' });
        res.end();
        return;
      }

      if (pathname === '/health') return sendJson(res, 200, { ok: true, mode: this.config.mode || 'simulation', now: new Date().toISOString() });
      if (pathname === '/' || pathname === '/console' || pathname.startsWith('/console/')) return this.serveConsole(pathname, res);
      if (pathname === '/api/v1/platform-capabilities' && req.method === 'GET') return sendJson(res, 200, this.capabilities);

      if (pathname === '/api/v1/bindings' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const deviceName = requireString(body.device_name, 'device_name', { max: 120 });
        const assistantVersion = optionalString(body.assistant_version, 'assistant_version', { max: 80 });
        const binding = this.store.createBinding({ deviceName, assistantVersion });
        return sendJson(res, 201, {
          binding_id: binding.id,
          code: binding.code,
          poll_token: binding.pollToken,
          expires_at: binding.expiresAt,
          confirm_url: `${this.store.publicBaseUrl}${binding.confirmPath}`
        });
      }

      let match = pathname.match(/^\/api\/v1\/bindings\/([^/]+)\/confirm$/);
      if (match && req.method === 'POST') {
        const user = this.requireUser(req);
        const body = await readJsonBody(req);
        const result = this.store.confirmBinding({ bindingId: decodeURIComponent(match[1]), code: requireString(body.code, 'code', { max: 20 }), userId: user.id });
        if (!result.ok) return sendJson(res, result.status, { error: { code: result.code, message: result.message } });
        return sendJson(res, 200, { ok: true, device_id: result.deviceId });
      }

      match = pathname.match(/^\/api\/v1\/bindings\/([^/]+)\/poll$/);
      if (match && req.method === 'POST') {
        const body = await readJsonBody(req);
        const result = this.store.consumeBindingToken({ bindingId: decodeURIComponent(match[1]), pollToken: requireString(body.poll_token, 'poll_token', { max: 200 }) });
        if (result.status === 'unauthorized') throw unauthorized('绑定轮询凭证无效');
        if (result.status === 'not_found') throw notFound('绑定申请不存在');
        if (result.status === 'approved') return sendJson(res, 200, { status: 'approved', device_id: result.deviceId, device_token: result.deviceToken });
        return sendJson(res, 200, { status: result.status });
      }

      if (pathname === '/api/v1/devices/heartbeat' && req.method === 'POST') {
        const device = this.requireDevice(req);
        const body = await readJsonBody(req);
        this.store.heartbeat({ deviceId: device.id, assistantVersion: optionalString(body.assistant_version, 'assistant_version', { max: 80 }) });
        return sendJson(res, 200, { ok: true, server_time: new Date().toISOString() });
      }

      if (pathname === '/api/v1/devices' && req.method === 'GET') {
        const user = this.requireUser(req);
        return sendJson(res, 200, { devices: this.store.listDevices(user.id) });
      }

      match = pathname.match(/^\/api\/v1\/devices\/([^/]+)\/revoke$/);
      if (match && req.method === 'POST') {
        const user = this.requireUser(req);
        const ok = this.store.revokeDevice({ deviceId: decodeURIComponent(match[1]), userId: user.id });
        if (!ok) throw notFound('设备不存在或已撤销');
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/v1/accounts/sync' && req.method === 'POST') {
        const device = this.requireDevice(req);
        const body = await readJsonBody(req, 512 * 1024);
        if (!Array.isArray(body.accounts)) throw badRequest('invalid_field', 'accounts 必须是数组');
        const accounts = body.accounts.slice(0, 100).map((item, index) => ({
          account_key: requireString(item.account_key, `accounts[${index}].account_key`, { max: 160, pattern: /^[A-Za-z0-9_-]+$/ }),
          platform: requirePlatform(item.platform),
          nickname: requireString(item.nickname, `accounts[${index}].nickname`, { max: 120 }),
          platform_identity: optionalString(item.platform_identity, `accounts[${index}].platform_identity`, { max: 160 }),
          status: optionalString(item.status, `accounts[${index}].status`, { max: 40 }) || 'unknown',
          capabilities: item.capabilities && typeof item.capabilities === 'object' ? item.capabilities : {},
          last_check_at: optionalString(item.last_check_at, `accounts[${index}].last_check_at`, { max: 80 })
        }));
        const mapped = this.store.syncAccounts({ device, accounts });
        return sendJson(res, 200, { accounts: mapped });
      }

      if (pathname === '/api/v1/accounts' && req.method === 'GET') {
        const user = this.requireUser(req);
        return sendJson(res, 200, { accounts: this.store.listAccounts(user.id) });
      }

      if (pathname === '/api/v1/materials' && req.method === 'POST') {
        const user = this.requireUser(req);
        const contentType = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].toLowerCase();
        if (!['video/mp4', 'video/quicktime', 'application/octet-stream'].includes(contentType)) {
          throw new HttpError(415, 'unsupported_material_type', '测试素材仅允许 video/mp4、video/quicktime 或 application/octet-stream');
        }
        const buffer = await readRawBody(req, 256 * 1024 * 1024);
        if (!buffer.length) throw badRequest('empty_material', '素材内容为空');
        const filename = safeFileName(req.headers['x-file-name'] || 'test-video.mp4', 'test-video.mp4');
        const material = this.store.createMaterial({ userId: user.id, filename, contentType, buffer });
        return sendJson(res, 201, { material: { ...material, storage_path: undefined } });
      }

      if (pathname === '/api/v1/materials' && req.method === 'GET') {
        const user = this.requireUser(req);
        return sendJson(res, 200, { materials: this.store.listMaterials(user.id) });
      }

      match = pathname.match(/^\/api\/v1\/materials\/([^/]+)\/download$/);
      if (match && req.method === 'GET') {
        const material = this.store.getMaterial(decodeURIComponent(match[1]));
        if (!material) throw notFound('素材不存在');
        const token = bearerToken(req);
        const user = token ? this.store.getUserByToken(token) : null;
        const authorizedByUser = user && user.id === material.user_id;
        const authorizedBySignedUrl = this.store.verifyMaterialAccessToken(material, url.searchParams.get('access_token'));
        if (!authorizedByUser && !authorizedBySignedUrl) throw forbidden('素材访问未授权');
        res.writeHead(200, {
          'content-type': material.content_type,
          'content-length': material.bytes,
          'content-disposition': `attachment; filename="${encodeURIComponent(material.filename)}"`,
          'x-content-sha256': material.sha256,
          'cache-control': 'no-store'
        });
        return fs.createReadStream(material.storage_path).pipe(res);
      }

      if (pathname === '/api/v1/tasks' && req.method === 'POST') {
        const user = this.requireUser(req);
        const body = await readJsonBody(req, 1024 * 1024);
        const deviceId = requireString(body.device_id, 'device_id', { max: 160 });
        const accountId = requireString(body.account_id, 'account_id', { max: 160 });
        const platform = requirePlatform(body.platform);
        const title = requireString(body.title, 'title', { max: 120 });
        const description = optionalString(body.description, 'description', { max: 3000 });
        const topics = requireTopics(body.topics);
        const coverRef = optionalString(body.cover_ref, 'cover_ref', { max: 300 });
        const materialId = requireString(body.material_id, 'material_id', { max: 160 });
        const idempotencyKey = requireString(body.idempotency_key, 'idempotency_key', { max: 160, pattern: /^[A-Za-z0-9_.:-]+$/ });
        const device = this.store.listDevices(user.id).find(item => item.id === deviceId && item.status === 'active');
        if (!device) throw forbidden('设备不存在、已撤销或不属于当前用户');
        const account = this.store.listAccounts(user.id).find(item => item.id === accountId);
        if (!account || account.device_id !== deviceId || account.platform !== platform) throw forbidden('平台账号不存在、设备不匹配或平台不一致');
        const material = this.store.getMaterial(materialId);
        if (!material || material.user_id !== user.id) throw forbidden('素材不存在或不属于当前用户');
        const result = this.store.createTask({ userId: user.id, deviceId, accountId, platform, title, description, topics, coverRef, materialId, idempotencyKey });
        return sendJson(res, result.created ? 201 : 200, { task: result.task, idempotent_replay: !result.created });
      }

      if (pathname === '/api/v1/tasks/claim' && req.method === 'POST') {
        const device = this.requireDevice(req);
        const task = this.store.claimTask(device);
        return sendJson(res, 200, { task });
      }

      if (pathname === '/api/v1/tasks' && req.method === 'GET') {
        const principal = this.requireUserOrDevice(req);
        const status = url.searchParams.get('status') || undefined;
        const tasks = principal.type === 'user' ? this.store.listTasksForUser(principal.user.id, status) : this.store.listTasksForDevice(principal.device.id);
        return sendJson(res, 200, { tasks });
      }

      if (pathname === '/api/v1/tasks/needs-review' && req.method === 'GET') {
        const user = this.requireUser(req);
        return sendJson(res, 200, { tasks: this.store.listTasksForUser(user.id, 'outcome_unknown') });
      }

      match = pathname.match(/^\/api\/v1\/tasks\/([^/]+)$/);
      if (match && req.method === 'GET') {
        const principal = this.requireUserOrDevice(req);
        const task = this.store.getTask(decodeURIComponent(match[1]));
        if (!task) throw notFound('任务不存在');
        if (principal.type === 'user' && task.user_id !== principal.user.id) throw forbidden();
        if (principal.type === 'device' && (task.device_id !== principal.device.id || task.user_id !== principal.device.user_id)) throw forbidden();
        return sendJson(res, 200, { task: this.store.decorateTask(task) });
      }

      match = pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/lease$/);
      if (match && req.method === 'POST') {
        const device = this.requireDevice(req);
        const body = await readJsonBody(req);
        const result = this.store.renewLease({ taskId: decodeURIComponent(match[1]), device, attemptId: requireString(body.attempt_id, 'attempt_id', { max: 160 }), manualHold: requireBoolean(body.manual_hold, 'manual_hold') });
        if (!result.ok) return this.sendStoreError(res, result);
        return sendJson(res, 200, result);
      }

      match = pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/progress$/);
      if (match && req.method === 'POST') {
        const device = this.requireDevice(req);
        const body = await readJsonBody(req);
        const result = this.store.updateProgress({
          taskId: decodeURIComponent(match[1]),
          device,
          attemptId: requireString(body.attempt_id, 'attempt_id', { max: 160 }),
          status: requireString(body.status, 'status', { max: 40 }),
          progress: body.progress,
          message: optionalString(body.message, 'message', { max: 500 }),
          error: body.error
        });
        if (!result.ok) return this.sendStoreError(res, result);
        return sendJson(res, 200, result);
      }

      match = pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/submission-intent$/);
      if (match && req.method === 'POST') {
        const device = this.requireDevice(req);
        const body = await readJsonBody(req);
        const result = this.store.saveSubmissionIntent({
          taskId: decodeURIComponent(match[1]),
          device,
          attemptId: requireString(body.attempt_id, 'attempt_id', { max: 160 }),
          contentVersion: requireString(body.content_version, 'content_version', { max: 128 }),
          accountId: requireString(body.account_id, 'account_id', { max: 160 })
        });
        if (!result.ok) return this.sendStoreError(res, result);
        return sendJson(res, 200, result);
      }

      match = pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/submit-authorization$/);
      if (match && req.method === 'POST') {
        const device = this.requireDevice(req);
        const body = await readJsonBody(req);
        const result = this.store.authorizeSubmit({
          taskId: decodeURIComponent(match[1]),
          device,
          attemptId: requireString(body.attempt_id, 'attempt_id', { max: 160 }),
          contentVersion: requireString(body.content_version, 'content_version', { max: 128 })
        });
        if (!result.ok) return sendJson(res, result.status || 409, { error: { code: result.code, message: result.message } });
        return sendJson(res, 200, { submit_token: result.submitToken, expires_at: result.submitTokenExpiresAt });
      }

      match = pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/result$/);
      if (match && req.method === 'POST') {
        const device = this.requireDevice(req);
        const body = await readJsonBody(req);
        const result = this.store.reportResult({
          taskId: decodeURIComponent(match[1]),
          device,
          attemptId: requireString(body.attempt_id, 'attempt_id', { max: 160 }),
          reportKey: requireString(body.report_key, 'report_key', { max: 160, pattern: /^[A-Za-z0-9_.:-]+$/ }),
          outcome: requireString(body.outcome, 'outcome', { max: 40 }),
          evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
          error: body.error,
          submitToken: body.submit_token
        });
        if (!result.ok) return sendJson(res, result.status || 409, { error: { code: result.code, message: result.message } });
        return sendJson(res, result.duplicate ? 200 : 201, result);
      }

      match = pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/cancel$/);
      if (match && req.method === 'POST') {
        const user = this.requireUser(req);
        const result = this.store.cancelTask({ taskId: decodeURIComponent(match[1]), userId: user.id });
        if (!result.ok) return sendJson(res, result.status || 409, { error: { code: result.code, message: result.message } });
        return sendJson(res, 200, result);
      }

      match = pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/review$/);
      if (match && req.method === 'POST') {
        const user = this.requireUser(req);
        const body = await readJsonBody(req);
        const result = this.store.reviewUnknownTask({
          taskId: decodeURIComponent(match[1]),
          userId: user.id,
          outcome: requireString(body.outcome, 'outcome', { max: 40 }),
          note: optionalString(body.note, 'note', { max: 1000 })
        });
        if (!result.ok) return sendJson(res, result.status || 409, { error: { code: result.code, message: result.message } });
        return sendJson(res, 200, result);
      }

      match = pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/events$/);
      if (match && req.method === 'GET') {
        const user = this.requireUser(req);
        const events = this.store.listTaskEvents(decodeURIComponent(match[1]), user.id);
        if (!events) throw notFound('任务不存在');
        return sendJson(res, 200, { events });
      }

      throw notFound('接口不存在');
    } catch (error) {
      sendError(res, error);
    }
  }

  sendStoreError(res, result) {
    const status = result.code === 'not_found' ? 404 : result.code === 'attempt_mismatch' ? 409 : 409;
    return sendJson(res, status, { error: { code: result.code, message: `请求被拒绝：${result.code}` } });
  }

  serveConsole(pathname, res) {
    const map = {
      '/': 'index.html',
      '/console': 'index.html',
      '/console/index.html': 'index.html',
      '/console/app.js': 'app.js',
      '/console/style.css': 'style.css'
    };
    const name = map[pathname];
    if (!name) throw notFound('控制台资源不存在');
    const file = path.join(this.consoleDir, name);
    const type = name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.config);
  const app = new MockBackendServer(config);
  await app.start();
  console.log(`[模拟后端] ${config.mode || 'simulation'} listening at http://${config.host || '127.0.0.1'}:${config.port || 8780}/console`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { MockBackendServer, loadConfig };