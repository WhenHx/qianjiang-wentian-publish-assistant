const test = require('node:test');
const assert = require('node:assert/strict');
const { protectText, unprotectText, isAvailable } = require('../src/common/dpapi');

test('Windows 当前用户范围 DPAPI 真实往返', t => {
  if (!isAvailable()) return t.skip('当前沙箱用户配置未加载，DPAPI CurrentUser 不可用');
  const secret = `设备秘密-${Date.now()}-cookie-like-value`;
  const protectedText = protectText(secret);
  assert.notEqual(protectedText, secret);
  assert.equal(unprotectText(protectedText), secret);
  assert.equal(isAvailable(), true);
});