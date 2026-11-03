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

Web bundle 默认挂载此 Host 插件，并在其 [Cordis patch](../../bundle/web-app/cordis.patch.yml) 中提供 OAuth 配置。插件接受以下选项：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `issuer` | 空 | OIDC issuer 地址 |
| `clientId` | `kaifang-harness` | 已登记的公共 IAM 客户端 |
| `redirectUri` | 空 | 共享 Host 的回调地址；本地开发时作为主机别名模板 |
| `audience` | `kaifang-meta-platform` | 平台 API audience |
| `requiredScopes` | `['model:invoke']` | 用户必须授予的 scope |
| `refreshSkewSeconds` | `60` | 提前多少秒刷新 access token |
| `requestTimeoutMs` | `10000` | 单次 IAM 请求超时，单位毫秒 |

客户端需登记 `authorization_code`、`refresh_token`、一个以 `/kaifang/auth/callback` 结尾的 loopback 精确回调模板，以及 `model:invoke` scope。生产环境只接受精确登记的回调地址；本地 Harness 开发复用该模板的 scheme、port、path 和 query，并把当前 localhost、loopback 或私有 IP 主机名用于浏览器授权和回调。除本地开发外，回调地址必须使用 HTTPS。Host credential store 仅服务进程可访问。

Web bundle 当前写入源码的 `issuer` 和 `redirectUri` 面向本地 KaifangMeta 开发。部署到其他环境时，应调整 patch 中的值；参见 [Web bundle 部署说明](../../bundle/web-app/README.zh.md#public-deployments)。

生产部署使用 Harness 独立 HTTPS 域名；OAuth 路由位于 `/kaifang/auth/*`，登录后返回应用根路径 `/`，Host RPC 位于 `/api`，因此登录 Cookie 使用该独立域名的根路径。浏览器插件会在启动和连接重置时检查 `/kaifang/auth/status`，并将未登录用户跳转到 `/kaifang/auth/entry`。未配置 IAM 时，插件只允许 loopback 开发；对外监听会启动失败。访问局域网 IP 时，需运行 `pnpm run dev:web -- --host <本机网卡IP>` 并绑定该具体地址；监听器不接受通配地址。

<a id="understand-the-implementation"></a>
## 实现说明

Host 创建 state 与 PKCE verifier，将浏览器转到 IAM；本地授权 URL 与回调沿用当前主机名，Token issuer 仍使用配置值。回调时由 Host 服务端换取授权码，检查由已配置 issuer 返回的签名令牌声明，再读取 `/userinfo`。刷新令牌以 `grant` credential 保存，并在访问令牌过期前续期。浏览器只获得账号资料和 DSH Host 自身的 HttpOnly Cookie；本地同站开发用 Lax Cookie，跨站嵌入用 `SameSite=None; Secure; Partitioned`，并按顶层站点隔离。

Admission Provider 位于 Connection admission 内，因此 `/api` 请求和 Gateway WebSocket 升级会按登录 Cookie（或 Desktop device ticket / 已准入会话的 Bearer）选择对应的 `kaifang-user` Peer。 Desktop 在已保存可用平台会话时于进入工作区前自动走 device ticket，以 Remote Client 挂共享 Host，无需先退出再登录。登录、回调、device、状态、取消和退出路由使用 Connection 的 Host/Origin 信任检查，但在平台登录前保持可访问。

Remote access 的 `global` 资源只开放启动、列表/搜索、模型目录、只读模型提供方目录、只读设置描述和用户根目录内的目录浏览。会话与工作区变更仍需匹配用户绑定。Host 代码将浏览器 OAuth Peer 的工作区创建、默认目录初始化和 Session 创建限制在本人分区内；Desktop device ticket Peer 的 `kaifang-user` principal 带有 `admission: 'device'`，因而 `workspace/create` 可采用分区外、本机 Host 上已存在的绝对目录（browse 与默认初始化仍受分区约束）。共享 Host 的 `kaifang-user` Peer 允许列表（`peer-roles.ts`）包含 `workspace/deleteSession`（软删除，与归档彼此独立），以便 Web 与 Desktop Remote Client 隐藏会话而不擦除日志。

Host 提供 `ctx.kaifangPlatformAuth`；Host 集成必须传入当前 Peer 的 `sub` 与 `tid`，才能读取该用户的身份或访问令牌。访问令牌过期或退出后，该接口不再返回令牌。

<a id="model-experience"></a>
## 模型体验

登录后，Host 为当前租户和用户注册独立模型路由，通过 KaifangMeta 获取已启用的对话与视觉模型；新会话默认选第一个可用模型，模型请求再经 Meta 后端代理。设置 → 模型会通过当前 Peer 的 Session 模型目录展示该账号获准使用的模型，并支持手动刷新。模型密钥不会进入浏览器，Meta 会在每次调用时重新检查模型权限。

Desktop profile 的平台模型通过 Meta 的 `harness.chat` capability 代理调用；Web Host 会话使用 AI 模型代理。直接在 DSH 中配置的模型仍使用各自的原生 provider。

#### KV Cache effect

无。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **一个共享 Host 服务多位用户**：无需配置 `expectedSub`；IAM 只登记一次固定回调。会话 ID 按身份加前缀，工作区持久化归属并放在每用户目录下。
- **会话时长由 IAM 刷新策略控制**：账号停用或刷新会话吊销后，Host 会在下次续期时清除准入。
- **工作区目录不等同于操作系统沙箱**：终端或文件工具若能执行任意主机命令，部署方仍须为用户 Agent 配置 OS 容器/沙箱。
- **模型目录每 10 秒刷新一次**：模型被撤权或停用后可能短暂显示；下一次调用会由 Meta 拒绝。
