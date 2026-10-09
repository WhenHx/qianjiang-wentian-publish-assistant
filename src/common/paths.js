const fs = require('node:fs');
const path = require('node:path');
const { randomId, assertSafeId } = require('./ids');

function resolveInside(root, ...parts) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...parts);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    const error = new Error('路径越界');
    error.code = 'path_traversal';
    throw error;
  }
  return resolved;
}

function safeJoin(root, ...parts) {
  for (const part of parts) {
    if (typeof part !== 'string' || part.length === 0 || part.includes('..') || part.includes('/') || part.includes('\\')) {
      const error = new Error('路径片段不安全');
      error.code = 'unsafe_path';
      throw error;
    }
  }
  return resolveInside(root, ...parts);
}

function safeFileName(name, fallback = 'file.bin') {
  const base = path.basename(String(name || '')).replace(/[<>:"|?*\x00-\x1F]/g, '_').slice(0, 120);
  return base || fallback;
}

function newAccountProfileDir(root) {
  const id = randomId('acctprofile', 12);
  assertSafeId(id, 'profile_id');
  const dir = safeJoin(root, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { id, dir };
}

module.exports = { resolveInside, safeJoin, safeFileName, newAccountProfileDir };