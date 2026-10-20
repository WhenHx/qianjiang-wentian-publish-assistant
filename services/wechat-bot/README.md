# 微信 LLM 私信自动回复机器人

独立项目（与发布助手解耦，跑稳后再整合）。基于免费版 wxauto4 监听私聊，调用 OpenAI 兼容接口生成回复。好友/建群/拉人等扩展功能为基于其 UIA 层的自研实现。

## 环境

- Windows + 微信 PC 客户端（已登录，4.1.x 实测）
- Python **3.12** x64
- `pip install wxauto4==41.1.7 requests`

## 使用

```bash
python -m venv .venv
.venv\Scripts\activate
pip install wxauto4==41.1.7 requests
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

## 知识库检索（预留接口，默认关闭）

回复前用用户消息检索知识库，命中片段注入 LLM 上下文（不写入会话历史，只对当轮生效）。对接千匠问天时打开：

```json
"kb": {
  "enabled": true,
  "base_url": "https://问天接口地址",
  "token": "业务侧发的接入令牌",
  "account_id": "微信账号ID",
  "top_k": 5,
  "min_score": 0,
  "timeout_seconds": 10
}
```

接口契约（`POST {base_url}/api/v1/kb/search`，Bearer 鉴权）：

```json
请求：{ "query": "用户消息原文", "top_k": 5, "account_id": "..." }
响应：{ "results": [ { "title": "...", "content": "命中的片段", "score": 0.83 } ] }
```

- score 低于 min_score 的结果被丢弃
- 检索失败/超时按未命中处理，只记日志，不阻塞回复

## 管理指令（在文件传输助手里发）

`bot.admin_chats` 指定的管理会话（默认文件传输助手）中，**自己发送**的文本按指令优先处理，不走 LLM：

```
帮助                     指令列表
建群 联系人1 联系人2 …    发起群聊（真实生效）
拉人 群名 联系人1 …       拉人入群（真实生效）
加好友 微信号 [验证语]    发送好友申请（受每日上限约束）
好友申请                 查看待处理的好友申请（只读）
```

执行结果会回复在同一会话。识别不了的文本仍由 LLM 正常回复。

## 好友管理

基于免费版 wxauto4 的 UIA 层自研实现（微信 4.1.13 起实测）。

- **自动通过好友申请**：每 `poll_interval_seconds` 轮询通讯录「新的朋友」，无「已添加/已过期」后缀的视为待处理，点击后按「通过验证/接受」按钮通过，可发欢迎语（固定模板或 LLM 生成），通过的好友自动加入回复监听列表（`add_to_listen`）
- **主动加好友**：「快捷操作」→「添加朋友」窗口 → 搜索微信号/手机号（剪贴板粘贴输入）→「添加到通讯录」→ 填验证语发送。`add_requests` 列表在启动时处理一次，每项 `{ "keywords": "微信号/手机号", "addmsg": "验证语", "remark": "备注", "tags": ["标签"] }`；每日上限 `daily_add_limit`，计数落盘 `friend_state.json` 跨重启生效；搜索无结果/已是好友会安全返回不动作
- 待校准项（首次真实触发前可能不动作，属安全方向失败，日志会有提示）：自动通过的「通过验证」按钮及确认弹窗、真实用户卡片的「添加到通讯录」按钮与申请弹窗。`tags`/权限设置在免费路径上暂不生效

```json
"friend": {
  "enabled": true,
  "auto_accept": true,
  "accept_remark_template": "",
  "accept_tags": [],
  "accept_permission": "朋友圈",
  "welcome_message": "",
  "welcome_use_llm": false,
  "add_to_listen": true,
  "poll_interval_seconds": 30,
  "daily_add_limit": 5,
  "add_requests": []
}
```

注意：主动加好友风控最严，`daily_add_limit` 建议保持个位数。

## 群聊管理（group.py，微信 4.1.15 实测）

基于免费版 wxauto4 的 UIA 层自研实现。命令行使用：

```bash
python group.py create 阿闯 訢              # 建群（真实生效，成员会收到通知）
python group.py create --dry 阿闯 訢        # dry-run：勾选后取消，不建群
python group.py add 群名 联系人1 联系人2     # 拉人入群（真实生效）
python group.py add --dry 群名 联系人1      # dry-run：到选择器为止
```

- 建群路径：会话页「快捷操作」→「发起群聊」→ 选择器搜索勾选 →「完成」
- 拉人路径：群聊窗口「聊天信息」→ 成员网格末尾空格位 →「添加群成员」选择器
- MMUI 自绘控件不响应 UIA Invoke，全程真实鼠标点击（执行时会移动光标）
- 联系人/群名必须与会话列表中的名称完全一致；找不到会取消而不是乱点

## 安全说明

- API Key 只存本机 config.json，不外传
- 只回复私聊文本消息，不碰群聊（msg.attr != friend 直接跳过）
- 微信自动化有风控风险，建议小号测试
