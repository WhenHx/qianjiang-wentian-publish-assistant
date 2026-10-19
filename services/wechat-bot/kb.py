"""知识库检索（预留接口，默认关闭）。

回复前用用户消息检索知识库，命中内容注入 LLM 上下文。默认关闭，不影响主流程。

契约（与发布助手同一风格：版本化路径、Bearer 鉴权）：

POST {base_url}/api/v1/kb/search
Authorization: Bearer <token>
{
  "query": "用户消息原文",
  "top_k": 5,
  "account_id": "微信账号ID"
}

响应：
{
  "results": [
    { "title": "文档标题", "content": "命中的片段内容", "score": 0.83 }
  ]
}

- score 低于 min_score 的结果被丢弃
- 检索失败/超时返回空列表，只记日志，不阻塞回复
"""
import logging

import requests

logger = logging.getLogger("wechat-llm-bot.kb")


class KnowledgeBaseClient:
    def __init__(self, cfg):
        self.enabled = bool(cfg.get("enabled"))
        self.base_url = (cfg.get("base_url") or "").rstrip("/")
        self.token = cfg.get("token") or ""
        self.account_id = cfg.get("account_id") or ""
        self.top_k = int(cfg.get("top_k") or 5)
        self.min_score = float(cfg.get("min_score") or 0)
        self.timeout = float(cfg.get("timeout_seconds") or 10)
        if self.enabled and (not self.base_url or not self.token):
            logger.error("kb 已启用但缺少 base_url/token，知识库检索不生效")
            self.enabled = False

    def search(self, query):
        """返回命中片段文本列表；未启用或失败时返回空列表。"""
        if not self.enabled or not (query or "").strip():
            return []
        try:
            resp = requests.post(
                f"{self.base_url}/api/v1/kb/search",
                headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
                json={"query": query, "top_k": self.top_k, "account_id": self.account_id},
                timeout=self.timeout,
            )
            resp.raise_for_status()
            results = resp.json().get("results") or []
            hits = [r["content"] for r in results if r.get("content") and float(r.get("score") or 0) >= self.min_score]
            if hits:
                logger.info("知识库命中 %d 条: %s", len(hits), query[:20])
            return hits
        except Exception as e:
            logger.warning("知识库检索失败，按未命中处理: %s", e)
            return []
