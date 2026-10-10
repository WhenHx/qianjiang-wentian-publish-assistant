class PlatformAdapter {
  constructor(context) { this.context = context; }
  async login() { throw new Error('not implemented'); }
  async checkIdentity() { throw new Error('not implemented'); }
  async checkLoginState() { throw new Error('not implemented'); }
  async checkLoginStateReadOnly() { throw new Error('not implemented'); }
  async prepareTask() { throw new Error('not implemented'); }
  async uploadVideo() { throw new Error('not implemented'); }
  async waitForUploadComplete() { throw new Error('not implemented'); }
  async fillFields() { throw new Error('not implemented'); }
  async detectVerification() { throw new Error('not implemented'); }
  async submitOnce() { throw new Error('not implemented'); }
  async verifyResult() { throw new Error('not implemented'); }
  async close() {}
}
module.exports = { PlatformAdapter };