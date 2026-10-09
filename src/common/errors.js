class HttpError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function badRequest(code, message, details) {
  return new HttpError(400, code, message, details);
}

function unauthorized(message = '未认证或凭证无效') {
  return new HttpError(401, 'unauthorized', message);
}

function forbidden(message = '无权访问该资源') {
  return new HttpError(403, 'forbidden', message);
}

function notFound(message = '资源不存在') {
  return new HttpError(404, 'not_found', message);
}

function conflict(code, message, details) {
  return new HttpError(409, code, message, details);
}

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, conflict };