const fs = require('node:fs');
const dns = require('node:dns').promises;
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { HttpError } = require('./errors');

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0;
}

function expandIPv6Groups(ip) {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '');
  const v4Match = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/);
  let hex = normalized;
  if (v4Match) {
    const nums = v4Match[1].split('.').map(Number);
    const g = [((nums[0] << 8) | nums[1]).toString(16), ((nums[2] << 8) | nums[3]).toString(16)];
    hex = normalized.slice(0, normalized.length - v4Match[1].length) + g.join(':');
  }
  const halves = hex.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  const groups = halves.length === 2 ? [...left, ...Array(missing).fill('0'), ...right] : left;
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map(g => parseInt(g, 16));
}

function isPrivateIPv6(ip) {
  const groups = expandIPv6Groups(ip);
  if (!groups) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true; // :: / ::1
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    const v4 = `${(g6 >> 8) & 255}.${g6 & 255}.${(g7 >> 8) & 255}.${g7 & 255}`;
    return isPrivateIPv4(v4); // IPv4 映射（含 ::ffff:7f00:1 十六进制形式）
  }
  return false;
}

function isPrivateAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return true;
}

async function validateRemoteUrl(input, { allowLoopback = false } = {}) {
  let url;
  try { url = new URL(input); }
  catch { throw new HttpError(400, 'invalid_url', '素材 URL 无效'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(400, 'invalid_url_scheme', '素材 URL 仅允许 HTTP/HTTPS');
  if (url.username || url.password) throw new HttpError(400, 'invalid_url_auth', '素材 URL 不允许包含用户名或密码');

  const host = url.hostname.toLowerCase();
  if (!allowLoopback && ['localhost', 'localhost.localdomain'].includes(host)) {
    throw new HttpError(400, 'forbidden_url_host', '生产模式禁止访问本机地址');
  }

  let addresses = [];
  if (net.isIP(host)) addresses = [{ address: host, family: net.isIP(host) }];
  else {
    try { addresses = await dns.lookup(host, { all: true, verbatim: true }); }
    catch { throw new HttpError(400, 'url_dns_failed', '素材 URL 域名解析失败'); }
  }
  if (!addresses.length) throw new HttpError(400, 'url_dns_failed', '素材 URL 域名解析失败');
  for (const item of addresses) {
    if (!allowLoopback && isPrivateAddress(item.address)) {
      throw new HttpError(400, 'forbidden_url_address', '生产模式禁止访问内网或本机地址');
    }
  }
  url.hash = '';
  return { url, addresses };
}

function pinnedRequest({ url, address, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      timeout: timeoutMs,
      lookup: (hostname, options, cb) => {
        if (options && options.all) cb(null, [address]);
        else cb(null, address.address, address.family || net.isIP(address.address));
      }
    }, resolve);
    req.on('timeout', () => req.destroy(new HttpError(504, 'download_timeout', '素材下载超时')));
    req.on('error', reject);
    req.end();
  });
}

async function resolveCheckedRedirects(startUrl, { allowLoopback = false, timeoutMs = 30000 } = {}) {
  let current = startUrl;
  for (let redirectCount = 0; redirectCount <= 5; redirectCount++) {
    const { url, addresses } = await validateRemoteUrl(current, { allowLoopback });
    const response = await pinnedRequest({ url, address: addresses[0], timeoutMs });
    if (![301, 302, 303, 307, 308].includes(response.statusCode)) return { response, finalUrl: url };
    const location = response.headers.location;
    response.destroy();
    if (!location) throw new HttpError(502, 'invalid_redirect', '重定向缺少 Location');
    current = new URL(location, url).toString();
  }
  throw new HttpError(400, 'too_many_redirects', '素材 URL 重定向次数过多');
}

async function downloadChecked(inputUrl, destinationPath, {
  allowLoopback = false,
  maxBytes = 512 * 1024 * 1024,
  allowedContentTypePrefixes = ['video/', 'application/octet-stream'],
  expectedSha256,
  expectedBytes,
  timeoutMs = 60000
} = {}) {
  const { response } = await resolveCheckedRedirects(inputUrl, { allowLoopback, timeoutMs });
  if (response.statusCode === 401 || response.statusCode === 403 || response.statusCode === 404 || response.statusCode === 410 || response.statusCode === 429) {
    response.destroy();
    throw new HttpError(response.statusCode, 'material_download_denied', `素材下载被拒绝：HTTP ${response.statusCode}`);
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    response.destroy();
    throw new HttpError(response.statusCode >= 500 ? response.statusCode : 502, 'download_failed', `素材下载失败：HTTP ${response.statusCode}`);
  }
  const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (allowedContentTypePrefixes.length && !allowedContentTypePrefixes.some(prefix => contentType.startsWith(prefix))) {
    response.destroy();
    throw new HttpError(415, 'unsupported_material_type', `素材类型不允许：${contentType || 'unknown'}`);
  }
  const contentLength = Number(response.headers['content-length'] || 0);
  if (contentLength > maxBytes) {
    response.destroy();
    throw new HttpError(413, 'material_too_large', '素材超过大小限制');
  }

  const hash = crypto.createHash('sha256');
  let total = 0;
  response.on('data', chunk => {
    total += chunk.length;
    hash.update(chunk);
    if (total > maxBytes) response.destroy(new HttpError(413, 'material_too_large', '素材超过大小限制'));
  });
  await pipeline(response, fs.createWriteStream(destinationPath, { mode: 0o600 }));
  const sha256 = hash.digest('hex');
  const failed = (code, message) => {
    fs.rmSync(destinationPath, { force: true });
    throw new HttpError(422, code, message);
  };
  if (expectedSha256 && expectedSha256.toLowerCase() !== sha256) failed('material_integrity_failed', '素材完整性校验失败');
  if (expectedBytes != null && total !== expectedBytes) failed('material_size_mismatch', `素材大小不符：期望 ${expectedBytes} 实际 ${total}`);
  return { bytes: total, sha256, contentType };
}

module.exports = { validateRemoteUrl, resolveCheckedRedirects, downloadChecked, isPrivateAddress, isPrivateIPv6, expandIPv6Groups };
