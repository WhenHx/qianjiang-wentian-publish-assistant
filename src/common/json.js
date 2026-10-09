const { HttpError } = require('./errors');

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new HttpError(413, 'payload_too_large', '请求体超过大小限制');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid_json', '请求体不是有效 JSON');
  }
}

async function readRawBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (maxBytes && total > maxBytes) throw new HttpError(413, 'payload_too_large', '请求体超过大小限制');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendJson(res, statusCode, value, headers = {}) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers
  });
  res.end(body);
}

function sendError(res, error) {
  const status = error instanceof HttpError ? error.statusCode : 500;
  const code = error instanceof HttpError ? error.code : 'internal_error';
  const message = error instanceof HttpError ? error.message : '服务器内部错误';
  sendJson(res, status, {
    error: {
      code,
      message,
      details: error instanceof HttpError ? error.details : undefined
    }
  });
}

module.exports = { readJsonBody, readRawBody, sendJson, sendError };