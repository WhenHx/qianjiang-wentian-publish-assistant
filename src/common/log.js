const fs = require('node:fs');
const path = require('node:path');

const SENSITIVE_KEY_RE = /(token|secret|password|passwd|cookie|authorization|credential|session|submit)/i;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;

function redact(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.replace(BEARER_RE, 'Bearer <redacted>');
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY_RE.test(key)) out[key] = '<redacted>';
      else out[key] = redact(item);
    }
    return out;
  }
  return value;
}

class Logger {
  constructor({ dir, name = 'assistant' }) {
    this.dir = dir;
    this.name = name;
    if (dir) fs.mkdirSync(dir, { recursive: true });
  }

  filePath() {
    const day = new Date().toISOString().slice(0, 10);
    return path.join(this.dir, `${this.name}-${day}.jsonl`);
  }

  write(level, message, fields = {}) {
    const entry = { ts: new Date().toISOString(), level, message, ...redact(fields) };
    const line = JSON.stringify(entry);
    if (this.dir) fs.appendFileSync(this.filePath(), line + '\n', 'utf8');
    const consoleLine = `[${entry.ts}] ${level.toUpperCase()} ${message}`;
    if (level === 'error') console.error(consoleLine, fields && Object.keys(fields).length ? redact(fields) : '');
    else console.log(consoleLine, fields && Object.keys(fields).length ? redact(fields) : '');
  }

  info(message, fields) { this.write('info', message, fields); }
  warn(message, fields) { this.write('warn', message, fields); }
  error(message, fields) { this.write('error', message, fields); }
}

module.exports = { Logger, redact };