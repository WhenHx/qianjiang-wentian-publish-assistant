const fs = require('node:fs');
const dns = require('node:dns').promises;
const net = require('node:net');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { HttpError } = require('./errors');

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0;
}

function isPrivateIPv6(ip) {
  const normalized = ip.toLowerCase();
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80') || normalized.startsWith('::ffff:127.');
}

function isPrivateAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return true;
}

async function validateRemoteUrl(input, { allowLoopback = false, maxRedirectsChecked = true } = {}) {
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
  if (net.isIP(host)) addresses = [{ address: host }];
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
  if (maxRedirectsChecked) url.hash = '';
  return url;
}

async function resolveCheckedRedirects(startUrl, options) {
  let current = await validateRemoteUrl(startUrl, options);
  for (let redirectCount = 0; redirectCount <= 5; redirectCount++) {
    const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(options.timeoutMs || 30000) });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, finalUrl: current };
    const location = response.headers.get('location');
    response.body?.cancel().catch(() => {});
    if (!location) throw new HttpError(502, 'invalid_redirect', '重定向缺少 Location');
    current = await validateRemoteUrl(new URL(location, current).toString(), options);
  }
  throw new HttpError(400, 'too_many_redirects', '素材 URL 重定向次数过多');
}

async function downloadChecked(inputUrl, destinationPath, {
  allowLoopback = false,
  maxBytes = 512 * 1024 * 1024,
  allowedContentTypePrefixes = ['video/', 'application/octet-stream'],
  expectedSha256,
  timeoutMs = 60000
} = {}) {
  const { response } = await resolveCheckedRedirects(inputUrl, { allowLoopback, timeoutMs });
  if (!response.ok) {
    response.body?.cancel().catch(() => {});
    throw new HttpError(502, 'download_failed', `素材下载失败：HTTP ${response.status}`);
  }
  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (allowedContentTypePrefixes.length && !allowedContentTypePrefixes.some(prefix => contentType.startsWith(prefix))) {
    response.body?.cancel().catch(() => {});
    throw new HttpError(415, 'unsupported_material_type', `素材类型不允许：${contentType || 'unknown'}`);
  }
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > maxBytes) {
    response.body?.cancel().catch(() => {});
    throw new HttpError(413, 'material_too_large', '素材超过大小限制');
  }

  const hash = crypto.createHash('sha256');
  let total = 0;
  const counter = new Readable({
    read() {}
  });
  const source = Readable.fromWeb(response.body);
  source.on('data', chunk => {
    total += chunk.length;
    hash.update(chunk);
    if (total > maxBytes) {
      source.destroy(new HttpError(413, 'material_too_large', '素材超过大小限制'));
    }
    counter.push(chunk);
  });
  source.on('end', () => counter.push(null));
  source.on('error', error => counter.destroy(error));

  await pipeline(counter, fs.createWriteStream(destinationPath, { mode: 0o600 }));
  const sha256 = hash.digest('hex');
  if (expectedSha256 && expectedSha256.toLowerCase() !== sha256) {
    fs.rmSync(destinationPath, { force: true });
    throw new HttpError(422, 'material_integrity_failed', '素材完整性校验失败');
  }
  return { bytes: total, sha256, contentType };
}

module.exports = { validateRemoteUrl, resolveCheckedRedirects, downloadChecked, isPrivateAddress };