// 互动回复模块的 LLM 客户端：OpenAI 兼容接口
// apiKey 支持 "${ENV:变量名}" 从环境变量读取，避免密钥写入入库的配置文件
class LlmClient {
  constructor({ baseUrl, apiKey, model, systemPrompt, timeoutMs = 60000 }) {
    this.baseUrl = (baseUrl || '').replace(/\/$/, '');
    const m = /^\$\{ENV:([A-Z0-9_]+)\}$/.exec(apiKey || '');
    this.apiKey = m ? (process.env[m[1]] || '') : (apiKey || '');
    this.model = model;
    this.systemPrompt = systemPrompt || '';
    this.timeoutMs = timeoutMs;
  }

  get ready() {
    return Boolean(this.baseUrl && this.apiKey && this.model);
  }

  async chat(messages) {
    if (!this.ready) throw new Error('LLM 未配置完整（baseUrl/apiKey/model）');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const resp = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [...(this.systemPrompt ? [{ role: 'system', content: this.systemPrompt }] : []), ...messages],
          temperature: 0.7
        }),
        signal: ac.signal
      });
      if (!resp.ok) throw new Error(`LLM 接口 ${resp.status}`);
      const data = await resp.json();
      return (data.choices?.[0]?.message?.content || '').trim();
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { LlmClient };
