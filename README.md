# 千匠问天 Windows 发布助手（测试版）

这是根据工作区提示词实现的本地可运行测试版本。当前云端连接状态为：**仅模拟对接**。真实千匠问天源码、数据库、部署权限和四个平台真实账号均未提供，因此未宣称完成真实发布验证。

## 当前能力

- 本地模拟后端，含两个互相隔离的模拟业务用户。
- 浏览器测试控制台，支持绑定设备、账号元数据同步、上传素材、创建任务、查看进度。
- Windows 桌面助手核心服务，使用本机 SQLite 记录恢复状态。
- PowerShell/WPF 桌面界面，可绑定设备、管理账号、查看任务、处理人工接管。
- 当前 Windows 用户范围 DPAPI 加解密模块。
- 四个平台的适配器接口与可配置浏览器 CDP 实现；默认自动化模式为 `simulated`，真实平台选择器未经验证。
- 单元测试和模拟服务集成测试。

## 快速启动

要求：Windows 11 x64、Node.js 24+。本测试版无第三方 npm 依赖。

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

## 重要限制

- 默认 `submitMode=hold_before_submit`，所有任务停在最终提交前。
- 默认 `automationMode=simulated`，不会操作真实平台页面；切换为 `cdp` 后仍需使用明确授权的测试账号验证选择器。
- 未访问参考 GitHub 仓库，未复用其代码；详见 `docs/上游版本记录.md`。
- 未签名测试包，不包含自动更新能力。
- 平台 Cookie、设备秘密不会写入日志或上传云端。

更多文档见 `docs/`。