# 微信 LLM 私信自动回复机器人

独立项目（与发布助手解耦，跑稳后再整合）。基于 wxauto4-plus 监听私聊，调用 OpenAI 兼容接口生成回复。

## 环境

- Windows + 微信 PC 客户端（已登录）
- Python **3.12** x64（硬性要求，与 wxautox4 二进制绑定）
- `pip install ../wxauto4-plus`（本地包）+ `requests`

## 使用

```bash
python -m venv .venv
.venv\Scripts\activate
pip install ../wxauto4-plus requests
copy config.example.json config.json   # 填入 API Key 和监听对象
python bot.py
```

## 运行要求

- 微信 PC 版已登录，且**主窗口必须保持显示状态**（可以被其他窗口完全遮挡，但不能最小化——最小化后微信停止渲染，UIA 读不到新消息）
- 回复消息时会短暂激活聊天窗口（粘贴文本需要），属正常现象

## 配置（config.json）

- `llm.base_url` / `api_key` / `model`：OpenAI 兼容接口（默认 Moonshot/Kimi）
- `llm.system_prompt`：机器人人设
- `bot.listen_chats`：要监听的私聊备注名列表（必填）
- `bot.min_interval_seconds`：同一会话回复节流
- `bot.max_reply_length`：回复长度上限
- `bot.trigger_prefix`：非空时只回复带前缀的消息
- `bot.blocklist`：永不回复的对象

## 聊天记录同步（预留接口，默认关闭）

每条私聊新消息（含机器人回复）都会进入同步队列。对接千匠问天时打开：

```json
"sync": {
  "enabled": true,
  "base_url": "https://问天接口地址",
  "token": "业务侧发的接入令牌",
  "account_id": "微信账号ID",
  "batch_size": 20,
  "flush_interval_seconds": 10
}
```

接口契约（`POST {base_url}/api/v1/chat-records`，Bearer 鉴权）：

```json
{ "records": [ { "source": "wechat_pc", "account_id": "...", "chat": "对方备注", "msg_id": "消息哈希", "direction": "in|out", "type": "text", "content": "...", "sent_at": "ISO8601", "idempotency_key": "消息哈希" } ] }
```

- 消息哈希跨窗口稳定，作为幂等键，服务端去重
- 本地批量队列，失败保留重试，不阻塞回复主流程
- 仅同步私聊文本；群聊不涉及

## 安全说明

- API Key 只存本机 config.json，不外传
- 只回复私聊文本消息，不碰群聊（msg.attr != friend 直接跳过）
- 微信自动化有风控风险，建议小号测试
