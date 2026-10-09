const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { safeJoin, resolveInside, safeFileName, newAccountProfileDir } = require('../src/common/paths');

test('恶意昵称和路径字段不能目录穿越', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qjw-path-'));
  assert.throws(() => safeJoin(root, '..', 'evil'), /不安全/);
  assert.throws(() => safeJoin(root, 'a/b'), /不安全/);
  assert.throws(() => resolveInside(root, '..', 'evil'), /越界/);
  assert.equal(safeFileName('..\\..\\bad<>name.mp4'), 'bad__name.mp4');
  const profile = newAccountProfileDir(root);
  assert.ok(profile.dir.startsWith(path.resolve(root) + path.sep));
});