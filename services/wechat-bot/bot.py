"""微信私信 LLM 自动回复机器人（独立项目，跑稳后再与发布助手整合）"""
import json
import os
import sys
import time
import logging
from pathlib import Path

import requests

logger = logging.getLogger("wechat-llm-bot")


def load_config():
    cfg_path = Path(__file__).parent / "config.json"
    if not cfg_path.exists():
        example = Path(__file__).parent / "config.example.json"
        cfg_path.write_bytes(example.read_bytes())
        print(f"已生成 {cfg_path}，请先填入 LLM API Key 再运行")
        sys.exit(1)
    return json.loads(cfg_path.read_text(encoding="utf-8"))


class LlmClient:
    def __init__(self, cfg):
        self.base_url = cfg["base_url"].rstrip("/")
        self.api_key = cfg["api_key"]
        self.model = cfg["model"]
        self.system_prompt = cfg.get("system_prompt", "")

    def chat(self, history):
        resp = requests.post(
            f"{self.base_url}/chat/completions",
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
            json={
                "model": self.model,
                "messages": ([{"role": "system", "content": self.system_prompt}] if self.system_prompt else []) + history,
                "temperature": 0.7,
            },
            timeout=60,
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"].strip()


class ReplyBot:
    def __init__(self, config, sync=None):
        self.cfg = config
        self.bot_cfg = config["bot"]
        self.llm = LlmClient(config["llm"])
        self.sync = sync
        self.histories = {}
        self.last_reply_at = {}
        self.handled_hashes = set()
        self.synced_hashes = set()
        self.recent_replies = []

    def on_observed(self, msg, chat):
        """每条新消息先入同步队列（不论是否需要回复）。"""
        if not self.sync or msg.hash in self.synced_hashes:
            return
        if str(msg.type).lower() != "text" or not (msg.content or "").strip():
            return
        self.synced_hashes.add(msg.hash)
        if len(self.synced_hashes) > 10000:
            self.synced_hashes = set(list(self.synced_hashes)[-5000:])
        direction = "out" if msg.attr == "self" else "in"
        self.sync.push(chat=chat.who, msg_id=msg.hash, direction=direction, content=msg.content)

    def should_reply(self, msg, chat) -> bool:
        allow_self = chat.who in (self.bot_cfg.get("allow_self_chats") or [])
        if msg.attr != "friend" and not allow_self:
            return False
        if str(msg.type).lower() != "text":
            return False
        if not msg.content or not msg.content.strip():
            return False
        if msg.hash in self.handled_hashes:
            return False
        if msg.content in self.recent_replies:
            return False
        blocklist = self.bot_cfg.get("blocklist", [])
        if chat.who in blocklist:
            return False
        prefix = self.bot_cfg.get("trigger_prefix", "")
        if prefix and not msg.content.startswith(prefix):
            return False
        last = self.last_reply_at.get(chat.who, 0)
        if time.time() - last < self.bot_cfg.get("min_interval_seconds", 2):
            return False
        return True

    def on_message(self, msg, chat):
        try:
            ok = self.should_reply(msg, chat)
            logger.info("评估消息: who=%s type=%s attr=%s content=%s -> %s", chat.who, msg.type, msg.attr, (msg.content or '')[:20], '回复' if ok else '跳过')
            if not ok:
                return
            self.handled_hashes.add(msg.hash)
            if len(self.handled_hashes) > 5000:
                self.handled_hashes = set(list(self.handled_hashes)[-2500:])
            who = chat.who
            history = self.histories.setdefault(who, [])
            history.append({"role": "user", "content": msg.content})
            reply = self.llm.chat(history[-self.bot_cfg.get("history_messages", 6) * 2:])
            reply = reply[: self.bot_cfg.get("max_reply_length", 200)]
            history.append({"role": "assistant", "content": reply})
            self.recent_replies.append(reply)
            if len(self.recent_replies) > 100:
                self.recent_replies = self.recent_replies[-50:]
            chat.SendMsg(reply)
            if self.sync:
                self.sync.push(chat=who, msg_id=f"bot-{time.time()}-{hash(reply) & 0xffffffff:x}", direction="out", content=reply)
            self.last_reply_at[who] = time.time()
            logger.info("回复 %s: %s", who, reply[:50])
        except Exception as e:
            logger.exception("处理消息失败: %s", e)


def find_session(wx, who):
    for s in wx.GetSession():
        if s.info.get('name') == who:
            return s
    return None


class MainChat:
    """主窗口会话包装：读取/发送前先切换会话。"""

    def __init__(self, wx, who):
        self.wx = wx
        self.who = who

    def GetAllMessage(self):
        self.wx.ChatWith(self.who)
        time.sleep(0.3)
        return self.wx.GetAllMessage()

    def SendMsg(self, text):
        self.wx.ChatWith(self.who)
        time.sleep(0.5)
        self.wx.SendMsg(text)


def open_sub(wx, who):
    """主窗口模式：切到会话并返回 MainChat 包装。"""
    wx.ChatWith(who)
    return MainChat(wx, who)


def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.StreamHandler(), logging.FileHandler(Path(__file__).parent / "bot.log", encoding="utf-8")],
    )
    config = load_config()

    from wxauto4 import WeChat
    from sync import ChatSyncClient

    wx = WeChat(ads=False)
    sync = ChatSyncClient(config.get("sync", {}))
    sync.start()
    bot = ReplyBot(config, sync)

    listen = config["bot"].get("listen_chats") or []
    if not listen:
        print("请先在 config.json 的 bot.listen_chats 里配置要监听的私聊对象（微信备注名）")
        sys.exit(1)

    interval = config["bot"].get("poll_interval_seconds", 2)
    subs = {}
    for who in listen:
        sub = open_sub(wx, who)
        if not sub:
            logger.error("找不到会话：%s", who)
            continue
        subs[who] = sub
        for m in sub.GetAllMessage():
            bot.handled_hashes.add(m.hash)
        logger.info("监听私聊: %s（已有消息 %d 条，不回溯）", who, len(sub.GetAllMessage()))
    if not subs:
        logger.error("没有可监听的会话，退出")
        sys.exit(1)

    logger.info("机器人已启动（轮询 %ss），Ctrl+C 退出", interval)
    try:
        last_preview = {}
        for who in listen:
            s = find_session(wx, who)
            last_preview[who] = s.info.get('content', '') if s else ''
        while True:
            for who in listen:
                try:
                    s = find_session(wx, who)
                    if not s:
                        continue
                    preview = s.info.get('content', '')
                    has_new = s.info.get('isnew') or (s.info.get('new_count') or 0) > 0
                    if not has_new and preview == last_preview.get(who, None):
                        continue
                    last_preview[who] = preview
                    logger.info("会话 %s 有新动静，读取消息", who)
                    chat = MainChat(wx, who)
                    msgs = chat.GetAllMessage()
                    for msg in msgs:
                        bot.on_observed(msg, chat)
                        if msg.hash not in bot.handled_hashes:
                            bot.on_message(msg, chat)
                except Exception as e:
                    logger.warning("会话 %s 读取失败: %s", who, e)
            time.sleep(interval)
    except KeyboardInterrupt:
        sync.stop()
        logger.info("已停止")


if __name__ == "__main__":
    main()
