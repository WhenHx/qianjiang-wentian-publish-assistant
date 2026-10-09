const { badRequest } = require('./errors');

const PLATFORMS = new Set(['douyin', 'shipinhao', 'kuaishou', 'xiaohongshu']);

function requireString(value, field, { min = 1, max = 4000, pattern } = {}) {
  if (typeof value !== 'string') throw badRequest('invalid_field', `${field} 必须是字符串`);
  const trimmed = value.trim();
  if (trimmed.length < min) throw badRequest('invalid_field', `${field} 不能为空`);
  if (trimmed.length > max) throw badRequest('invalid_field', `${field} 超过长度限制`);
  if (pattern && !pattern.test(trimmed)) throw badRequest('invalid_field', `${field} 格式不正确`);
  return trimmed;
}

function optionalString(value, field, options = {}) {
  if (value === undefined || value === null || value === '') return '';
  return requireString(value, field, { min: 0, ...options });
}

function requirePlatform(value) {
  const platform = requireString(value, 'platform', { max: 40 }).toLowerCase();
  if (!PLATFORMS.has(platform)) throw badRequest('unsupported_platform', `不支持的平台：${platform}`);
  return platform;
}

function requireBoolean(value, field, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'boolean') throw badRequest('invalid_field', `${field} 必须是布尔值`);
  return value;
}

function requireTopics(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw badRequest('invalid_field', 'topics 必须是数组');
  return value.slice(0, 20).map((item, index) => requireString(item, `topics[${index}]`, { max: 80 }).replace(/^#/, ''));
}

function requireIsoDate(value, field) {
  const text = requireString(value, field, { max: 80 });
  if (Number.isNaN(Date.parse(text))) throw badRequest('invalid_field', `${field} 不是有效时间`);
  return new Date(text).toISOString();
}

module.exports = { PLATFORMS, requireString, optionalString, requirePlatform, requireBoolean, requireTopics, requireIsoDate };