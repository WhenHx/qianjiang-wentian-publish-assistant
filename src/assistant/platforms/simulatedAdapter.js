const { PlatformAdapter } = require('./base');

class SimulatedPlatformAdapter extends PlatformAdapter {
  async login() {
    return { status: 'needs_manual', message: '模拟模式：不会打开真实平台；请在桌面端点击“模拟标记已登录”。' };
  }

  async checkIdentity() {
    return { platform: this.context.platform, identity: `simulated-${this.context.account.account_key}`, nickname: this.context.account.nickname };
  }

  async checkLoginState() {
    return { loggedIn: true, identity: await this.checkIdentity(), state: { simulated: true, account_key: this.context.account.account_key } };
  }

  async checkLoginStateReadOnly() {
    return this.checkLoginState();
  }

  async prepareTask() { return { prepared: true, simulated: true }; }
  async uploadVideo(videoPath) { return { uploaded: true, simulated: true, video_path: videoPath }; }
  async fillFields(fields) { return { filled: true, simulated: true, fields: { title: fields.title, topics: fields.topics } }; }
  async detectVerification() { return null; }

  async submitOnce() {
    return { accepted: true, simulated: true, evidence: { simulated_submit: true } };
  }

  async verifyResult() {
    return { outcome: 'submitted', evidence: { simulated_result: true, platform_status: 'accepted' } };
  }
}

module.exports = { SimulatedPlatformAdapter };