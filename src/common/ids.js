const crypto = require('node:crypto');

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;

function randomId(prefix = 'id', bytes = 16) {
  return `${prefix}_${crypto.randomBytes(bytes).toString('base64url')}`;
}

function uuid() {
  return crypto.randomUUID();
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function hmac(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function timingSafeEqualString(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function assertSafeId(value, field = 'id') {
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value)) {
    const err = new Error(`${field} 含有不安全字符`);
    err.code = 'unsafe_id';
    throw err;
  }
  return value;
}

module.exports = { randomId, uuid, sha256Buffer, hmac, timingSafeEqualString, assertSafeId, SAFE_ID_RE };