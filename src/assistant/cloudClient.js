const { HttpError } = require('../common/errors');

class CloudClient {
  constructor({ serviceUrl, deviceTokenProvider, logger, timeoutMs = 15000 }) {
    this.serviceUrl = String(serviceUrl || '').replace(/\/$/, '');
    this.deviceTokenProvider = deviceTokenProvider;
    this.logger = logger;
    this.timeoutMs = timeoutMs;
  }

  async request(path, { method = 'GET', body, deviceAuth = true, headers = {} } = {}) {
    const requestHeaders = { ...headers };
    if (body !== undefined) requestHeaders['content-type'] = 'application/json';
    if (deviceAuth) {
      const binding = this.deviceTokenProvider();
      if (!binding) throw new HttpError(401, 'not_bound', '设备尚未绑定');
      requestHeaders.authorization = `Bearer ${binding.deviceToken}`;
    }
    const response = await fetch(`${this.serviceUrl}${path}`, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!response.ok) {
      const code = data?.error?.code || 'cloud_request_failed';
      const message = data?.error?.message || `云端请求失败 HTTP ${response.status}`;
      throw new HttpError(response.status, code, message, data?.error?.details);
    }
    return data;
  }

  createBinding({ deviceName, assistantVersion }) {
    return this.request('/api/v1/bindings', { method: 'POST', deviceAuth: false, body: { device_name: deviceName, assistant_version: assistantVersion } });
  }

  pollBinding(bindingId, pollToken) {
    return this.request(`/api/v1/bindings/${encodeURIComponent(bindingId)}/poll`, { method: 'POST', deviceAuth: false, body: { poll_token: pollToken } });
  }

  heartbeat(assistantVersion) { return this.request('/api/v1/devices/heartbeat', { method: 'POST', body: { assistant_version: assistantVersion } }); }
  syncAccounts(accounts) { return this.request('/api/v1/accounts/sync', { method: 'POST', body: { accounts } }); }
  claimTask() { return this.request('/api/v1/tasks/claim', { method: 'POST', body: {} }); }
  renewLease(taskId, attemptId, manualHold = false) { return this.request(`/api/v1/tasks/${encodeURIComponent(taskId)}/lease`, { method: 'POST', body: { attempt_id: attemptId, manual_hold: manualHold } }); }
  progress(taskId, attemptId, status, progress, message, error) { return this.request(`/api/v1/tasks/${encodeURIComponent(taskId)}/progress`, { method: 'POST', body: { attempt_id: attemptId, status, progress, message, error } }); }
  saveSubmissionIntent(taskId, attemptId, contentVersion, accountId) { return this.request(`/api/v1/tasks/${encodeURIComponent(taskId)}/submission-intent`, { method: 'POST', body: { attempt_id: attemptId, content_version: contentVersion, account_id: accountId } }); }
  authorizeSubmit(taskId, attemptId, contentVersion) { return this.request(`/api/v1/tasks/${encodeURIComponent(taskId)}/submit-authorization`, { method: 'POST', body: { attempt_id: attemptId, content_version: contentVersion } }); }
  reportResult(taskId, attemptId, reportKey, outcome, evidence, error, submitToken) {
    return this.request(`/api/v1/tasks/${encodeURIComponent(taskId)}/result`, { method: 'POST', body: { attempt_id: attemptId, report_key: reportKey, outcome, evidence, error, submit_token: submitToken } });
  }
}

module.exports = { CloudClient };