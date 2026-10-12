"""聊天记录同步到业务平台（预留接口，默认关闭）。

契约（与发布助手同一风格：版本化路径、Bearer 鉴权、幂等键）：

POST {base_url}/api/v1/chat-records
Authorization: Bearer <token>
{
  "records": [
    {
      "source": "wechat_pc",
      "account_id": "微信账号ID",
      "chat": "对方备注名",
      "msg_id": "消息哈希",
      "direction": "in | out",
      "type": "text",
      "content": "内容",
      "sent_at": "ISO8601",
      "idempotency_key": "消息哈希"
    }
  ]
}

- msg 哈希跨窗口稳定，作为幂等键，重复推送由服务端去重
- 本地队列批量上报，失败保留重试，不阻塞回复主流程
"""
import json
import logging
import threading
import time
from pathlib import Path

import requests

logger = logging.getLogger("wechat-llm-bot.sync")


class ChatSyncClient:
    def __init__(self, cfg):
        self.enabled = bool(cfg.get("enabled"))
        self.base_url = (cfg.get("base_url") or "").rstrip("/")
        self.token = cfg.get("token") or ""
        self.account_id = cfg.get("account_id") or ""
        self.batch_size = int(cfg.get("batch_size") or 20)
        self.flush_interval = float(cfg.get("flush_interval_seconds") or 10)
        self.queue = []
        self.lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None

    def start(self):
        if not self.enabled:
            logger.info("聊天记录同步未启用（sync.enabled=false）")
            return
        if not self.base_url or not self.token:
            logger.error("sync 已启用但缺少 base_url/token，同步不生效")
            return
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        logger.info("聊天记录同步已启用 -> %s", self.base_url)

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3)
        self.flush()

    def push(self, *, chat, msg_id, direction, content, msg_type="text", sent_at=None):
        if not self.enabled:
            return
        record = {
            "source": "wechat_pc",
            "account_id": self.account_id,
            "chat": chat,
            "msg_id": msg_id,
            "direction": direction,
            "type": msg_type,
            "content": content,
            "sent_at": sent_at or time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
            "idempotency_key": msg_id,
        }
        with self.lock:
            self.queue.append(record)
            if len(self.queue) >= self.batch_size:
                self._flush_locked()

    def _loop(self):
        while not self._stop.wait(self.flush_interval):
            self.flush()

    def flush(self):
        with self.lock:
            self._flush_locked()

    def _flush_locked(self):
        if not self.queue:
            return
        batch = self.queue[: self.batch_size]
        try:
            resp = requests.post(
                f"{self.base_url}/api/v1/chat-records",
                headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
                json={"records": batch},
                timeout=30,
            )
            resp.raise_for_status()
            self.queue = self.queue[len(batch):]
            logger.info("已同步 %d 条聊天记录", len(batch))
        except Exception as e:
            logger.warning("同步失败，保留队列下次重试: %s", e)
