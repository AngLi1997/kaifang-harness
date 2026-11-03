---
kind: upgrade-guide
description: "Desktop replaces the KaifangLab login bridge with a shared Web Host authenticated by Platform IAM."
---

# Desktop 改用共享 Web Host 平台 IAM 认证

[English](guide.md) | 中文

## 变更

Desktop 不再使用原生 KaifangLab 登录桥，也不再读取已保存的 KaifangLab 凭据。Welcome 中填写平台根地址后，Desktop 打开平台公开的 `/harness` 路由，再跳转到平台配置的共享 Web Host。Host 通过平台 IAM 认证，为 `kaifang-harness` 显示 OAuth 确认页，并在服务端保存 token。使用同一平台身份（`tenant_id + sub`）登录时，Web 与 Desktop 共用工作区、Session 记录及实时 Session 事件。本地 `$DSH_HOME` Session 仍保留在本地，不会导入共享 Host。

## 迁移

1. 使用 [`kaifang-platform-auth`](../../../../packages/kaifang/platform-auth/README.zh.md) 配置共享 Host，并在平台 `VITE_HARNESS_WEB_URL` 中设置 Host 入口。在 Desktop Welcome → 设置中输入平台根地址并保存到本机；Desktop 不会读取同级 KaifangMeta 仓库的 `.env`，也没有构建时默认值。开发环境允许使用 loopback HTTP。Desktop 启动时会删除 `desktop/kaifang-session.json` 和 `desktop/system-connection.json`。Web 客户端加载时也会清除旧的 `dsh.kaifang.session` 与 `dsh.kaifang.callback` localStorage 项；无需转换旧凭据。
2. 在 Web 与 Desktop 使用同一平台身份（`tenant_id + sub`）登录。要继续使用本地 Session，请从应用菜单选择“打开本地工作区”，或在 Welcome 中选择“使用本地工作区”；这些 Session 不会出现在共享 Host 中。
3. 确认两端显示相同的工作区和 Session，再发送消息并确认两端都能看到流式响应。共享 Web Host 窗口不提供文件拖放等原生 Desktop 集成。
