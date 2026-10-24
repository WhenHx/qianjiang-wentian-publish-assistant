# 千匠问天 Windows 发布助手

千匠问天的本机执行端：在用户本机已登录的浏览器里，对抖音、视频号、小红书执行视频发布与互动接待（评论/私信），把真实结果回传问天。

## 当前能力

- **发布闭环**：问天/控制台下发任务 → 助手真实发布 → 结果回传。抖音、视频号、小红书已真机发布验证通过（真实账号、真实视频、真实发布成功）；快手因账号被封未验证。
- **互动接待**：读取平台评论/私信 → 上行问天 → 问天生成回复 → 助手发送 → 结果回传。抖音私信、视频号私信、视频号评论、抖音评论均已全链路真机验证通过。
- **留微线索**：识别客户主动留下的手机号/微信号，连同渠道来源（不丢失、不覆盖）、原始消息、互动关联上行问天。
- **设备绑定/账号隔离/租约/幂等/中断恢复**：详见 `docs/接口契约-v1.md`、`docs/接口契约-v2.md`、`docs/接口契约-v3.md`。
- **微信机器人**（`services/wechat-bot/`）：私聊 LLM 自动回复、自动通过好友申请、主动加好友、建群/拉人、管理指令，全部基于免费版 wxauto4 的 UIA 层自研实现（微信 4.1.15 实测）。
- 模拟后端 + 浏览器测试控制台 + WPF 桌面界面 + 托盘常驻。

## 快速启动

要求：Windows 11 x64、Node.js 24+。无第三方 npm 依赖。

```powershell
npm test
npm run dev
```

`npm run dev` 会启动：

- 模拟后端和测试控制台：<http://127.0.0.1:8780/console>
- 助手核心本地接口：<http://127.0.0.1:8781>
- WPF 桌面界面（需手动确认窗口是否打开）

也可以分窗口运行：

```powershell
npm run start:mock
npm run start:assistant
npm run start:desktop
```

微信机器人（需 Python 3.12 + 已登录的微信 PC 端）：

```powershell
cd services/wechat-bot
.\.venv\Scripts\python.exe bot.py
```

## 互动接待（评论/私信回复）

- 默认 `autoSend: false`：检测到的评论/私信先进入本地待发送队列，人工确认后才真实发送。
- 回复内容由问天（或模拟后端）生成，助手不本地生成客户回复（本地 LLM 仅为显式降级开关，默认关）。
- 抖音评论检测依赖内置组件 [DouYin_Spider](https://github.com/cv-cat/DouYin_Spider)（已 vendor 在 `services/douyin-spider/`，仅读取路径，cookie 从已登录浏览器自动导出）。该组件为第三方开源项目，版权归原作者所有，按其声明仅供学习与技术研究使用。首次使用前需在 `services/douyin-spider/` 下建 Python 3.12 虚拟环境并安装依赖（见 `services/douyin-spider/requirements.txt`）。
- 本地接口：`GET /local/v1/interactions`（队列）、`POST /local/v1/interactions/:id/send`（确认发送）、`POST /local/v1/interactions/:id/discard`（作废）。

## 重要限制

- 默认 `submitMode=hold_before_submit`，发布任务停在最终提交前，需人工确认。
- 互动接待默认人工确认发送（`autoSend: false`）。
- 小红书互动需专业号认证；快手账号被封未验证。
- 未签名测试包，不包含自动更新能力。
- 平台 Cookie、设备秘密不会写入日志或上传云端。

更多文档见 `docs/`（平台适配状态、接口契约、验收记录、使用说明、故障排查）。
