const test = require('node:test');
const assert = require('node:assert/strict');
const { redact } = require('../src/common/log');
const { requireTopics, requirePlatform } = require('../src/common/validation');

test('日志脱敏覆盖 token、cookie、password 和 Authorization', () => {
  const value = redact({ device_token: 'abc', cookie: 'sid=1', nested: { password: 'x' }, message: 'Authorization: Bearer abc.def' });
  assert.equal(value.device_token, '<redacted>');
  assert.equal(value.cookie, '<redacted>');
  assert.equal(value.nested.password, '<redacted>');
  assert.equal(value.message, 'Authorization: Bearer <redacted>');
});

test('平台和话题输入校验', () => {
  assert.equal(requirePlatform('douyin'), 'douyin');
  assert.throws(() => requirePlatform('unknown'));
  assert.deepEqual(requireTopics(['#测试', '发布']), ['测试', '发布']);
});