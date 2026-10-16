---
kind: upgrade-guide
description: "Web 应用启动时显示 KaifangLab 登录页，所有登录入口改为登录 KaifangLab，不再登录 DeepSeek Platform。"
---

# Web 应用需要登录 KaifangLab

[English](guide.md) | 中文

## 变更

在 v0.2.1-alpha.4 中，Web 应用直接打开工作区，侧栏账号按钮、账号设置和模型引导登录的是 DeepSeek Platform。下一版本中，`@deepseek-ai/dsh-web-app` 组合包在 `ui-settings-account` 条目上设置 `kaifangSignIn: true`：账号登录前，Web 应用用 KaifangLab 登录页覆盖工作区，所有登录入口都登录 KaifangLab。桌面端原本就通过欢迎窗口登录，现在所有登录入口都转到该窗口。Web 用户以及组合了 Web 应用组合包的部署受影响。

## 迁移

1. 打开 Web 应用，在登录页选择设置，填写 KaifangLab 系统 URL、认证页面 URL 和授权码。一键登录要求通过 `127.0.0.1` 或 `localhost` 打开 Web 应用；账号密码登录要求 KaifangLab 服务端通过 CORS 允许 Web 应用的源。
2. 如需保留原有行为，添加把该选项设为 false 的 overlay 或 home patch：

   ```yaml
   - id: ui-settings-account
     config:
       kaifangSignIn: false
   ```

3. 重新加载 Web 应用确认：选项为 true 时，登录前显示登录页，登录后侧栏账号按钮显示 KaifangLab 昵称；选项为 false 时直接打开工作区。
