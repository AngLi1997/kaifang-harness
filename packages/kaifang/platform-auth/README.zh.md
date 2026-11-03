---
description: "通过 KaifangMeta IAM 为共享 Web Host 的多位用户登录，PKCE 令牌仅保存在 Host，并按身份选择 Peer。"
kind: "package-reference"
---

# @deepseek-ai/dsh-kaifang-platform-auth

[English](README.md) | 中文

## 概要

让一个 Web Host 服务多个 KaifangMeta 平台账号。Host 执行带 PKCE 的 OAuth 授权码流程，通过 `ctx.credentials` 保存每个浏览器登录会话的访问令牌和刷新令牌；Connection Admission Provider 按 HttpOnly 登录 Cookie 选择用户 Peer，同时保护 HTTP RPC 与 Gateway WebSocket。Remote access policy 按 `tenant_id + sub` 控制会话和工作区资源。

## 目录

- [使用方式](#use-this-package)
- [实现说明](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
<a id="使用方式"></a>
## 使用方式

Web bundle 默认挂载此 Host 插件。为共享 Web Host 配置以下环境变量：

| 变量 | 含义 |
|---|---|
| `DSH_KAIFANG_IAM_ISSUER` | IAM issuer，例如 `https://meta.example/kaifang-meta/iam` |
| `DSH_KAIFANG_CLIENT_ID` | 注册的公共客户端，默认 `kaifang-harness` |
| `DSH_KAIFANG_REDIRECT_URI` | 共享 Host 的精确回调地址，路径以 `/kaifang/auth/callback` 结尾 |
| `DSH_KAIFANG_AUDIENCE` | 平台 API audience，默认 `kaifang-meta-platform` |
| `DSH_KAIFANG_WORKSPACE_ROOT` | 用户工作区根目录；每个用户写入独立的不透明身份分区子目录 |

客户端需登记 `authorization_code`、`refresh_token`、共享 Host 的一个精确回调地址和 `model:invoke` scope。除 loopback 开发外，回调地址必须使用 HTTPS。Host credential store 仅服务进程可访问。

生产部署使用 Harness 独立 HTTPS 域名；OAuth 路由位于 `/kaifang/auth/*`，登录后返回应用根路径 `/`，Host RPC 位于 `/api`，因此登录 Cookie 使用该独立域名的根路径。浏览器插件会在启动和连接重置时检查 `/kaifang/auth/status`，并将未登录用户跳转到 `/kaifang/auth/entry`。未配置 IAM 时，插件只允许 loopback 开发；对外监听会启动失败。

<a id="understand-the-implementation"></a>
## 实现说明

Host 创建 state 与 PKCE verifier，将浏览器转到 IAM；回调时由 Host 服务端换取授权码，检查由已配置 issuer 返回的签名令牌声明，再读取 `/userinfo`。刷新令牌以 `grant` credential 保存，并在访问令牌过期前续期。浏览器只获得账号资料和 DSH Host 自身的 HttpOnly Cookie。

Admission Provider 位于 Connection admission 内，因此 `/api` 请求和 Gateway WebSocket 升级会按登录 Cookie 选择对应的 `kaifang-user` Peer。登录、回调、状态、取消和退出路由使用 Connection 的 Host/Origin 信任检查，但在平台登录前保持可访问。

Remote access 的 `global` 资源只开放启动、列表/搜索、模型目录、只读模型提供方目录、只读设置描述和用户根目录内的目录浏览。会话与工作区变更仍需匹配用户绑定；工作区创建、默认目录初始化和 Session 创建会在 Host 代码中再次限制到本人目录。

Host 提供 `ctx.kaifangPlatformAuth`；Host 集成必须传入当前 Peer 的 `sub` 与 `tid`，才能读取该用户的身份或访问令牌。访问令牌过期或退出后，该接口不再返回令牌。

<a id="model-experience"></a>
## 模型体验

登录后，Host 为当前租户和用户注册独立模型路由，通过 KaifangMeta 获取已启用的对话与视觉模型；新会话默认选第一个可用模型，模型请求再经 Meta 后端代理。设置 → 模型会通过当前 Peer 的 Session 模型目录展示该账号获准使用的模型，并支持手动刷新。模型密钥不会进入浏览器，Meta 会在每次调用时重新检查模型权限。

#### KV Cache effect

无。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **一个共享 Host 服务多位用户**：无需配置 `expectedSub`；IAM 只登记一次固定回调。会话 ID 按身份加前缀，工作区持久化归属并放在每用户目录下。
- **会话时长由 IAM 刷新策略控制**：账号停用或刷新会话吊销后，Host 会在下次续期时清除准入。
- **工作区目录不等同于操作系统沙箱**：终端或文件工具若能执行任意主机命令，部署方仍须为用户 Agent 配置 OS 容器/沙箱。
- **模型目录每 10 秒刷新一次**：模型被撤权或停用后可能短暂显示；下一次调用会由 Meta 拒绝。
