# Agent Note: 已登录时 Desktop 同时保持本地与云端 Host 连接

Status: proposed

[English](2026-11-04-desktop-dual-host-connections.md) | 中文

## 问题

在 Desktop 上，选择侧栏另一侧的工作区或会话会替换唯一的活动 Host 连接。底栏显示重新连接中（`connection.connecting`），直到新的一代连接就绪。已登录的读者需要本地 Host 与共享 Host 同时连着。未登录的读者需要本地 Host。不同账号的云端工作区彼此分开。

已保存的平台会话能够挂上共享 Host 时，Desktop 已经同时画出两段。[双数据面启动](../../../../apps/desktop/src/host-plane.ts) 仍然只选一个活动 Host。[`applyActivePlane`](../../../../apps/desktop/src/main.ts) 把 `hostUrl`、`hostCookie` 和 `ownsHost` 指向该 Host。另一台 Host 只回答 `/__dsh_sidecar__` 下的一元 HTTP。渲染进程每 8 秒轮询该前缀上的 `workspace/listSnapshot`、`session/list` 和 `session/modelCatalog`。[工作区 README](../../../../packages/client/ui-workspace/README.zh.md) 把非活动列表描述为只读快照。

在非活动段打开会话（[`openSidecarSession`](../../../../packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx)）和在那里新建目录（[`openAdd`](../../../../packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx)）都会调用 `setActivePlane`。主进程对调两端点并发出 `hostPlaneChanged`。渲染进程写入新的 `streamBaseUrl`，并调用 [`ConnectionController.reconnect`](../../../../packages/client/connection/src/client/connection.ts)，中止当前一代。每一次 `hostPlaneChanged` 投递都会执行这次重连，包括活动 Host 没有变化的再次发布。对调之后，客户端等到新目录列出该会话再打开。一个 `sessions` 目录和一条 `workspaces` follow 流都挂在这一代上，因此在对调回来之前，前一台 Host 的实时状态已经不在。

登录会保存平台会话、挂上共享 Host，并重载应用文档。退出会清除该会话、丢掉共享 Host cookie，并在工作区窗口已打开时重载文档。两次重载都会一并重启本地连接。共享 Host 已经把每个 `kaifang-user` Peer 限制在 `ownerId` 等于 `tenant_id` 与 `sub` 的 [`platformUserKey`](../../../../packages/kaifang/platform-auth/src/identity.ts) 的工作区，以及 id 带 `user-${ownerId}-session-` 前缀的会话。Desktop 客户端只保留一张云端 cookie 和一份内存中的 sidecar 快照，没有账号键。文档重载目前会丢掉这份快照。两条长期连接会一直显示上一个账号，直到云端一代被清掉。

没有活动的 Agent Note 负责 Desktop 的这个连接选择。

## 提案

登录态决定哪些 Host 保持连接。侧栏点击选定焦点 `(plane, sessionId)`，并让这些连接继续运行。

### 稳定端点

Desktop 主进程在渲染进程运行期间保持两个端点。本地端点是内嵌 Host 及其 cookie。平台会话已保存且 device ticket 挂载成功后，云端端点存在，并携带该账号的 ticket cookie。[`resolveDesktopHostForward`](../../../../apps/desktop/src/web-document.ts) 把每一面的会话、工作区和模型请求送到该面的 cookie。插件和 Desktop 自有的设置请求留在本地 Host 上；`ownsHost` 为 false 时，`isDesktopOwnedHostPath` 已经这样选择。`hostPlaneSet` 不再改 cookie 和流 URL。渲染进程在启动时收到两个流 origin。云端端点不存在时，云端 origin 也不存在。

### 每个 Host 一份运行时

每台已连接的 Host 拥有自己的连接世代、`workspace/follow` 流、会话目录和模型目录。对话、输入框、模型选择、工具、终端和文件读取使用焦点会话的运行时。在云端段新建目录时，对云端运行时调用 `workspace/create`。侧栏两段读取各自的 follow 流。8 秒 sidecar 轮询和对调后等待目录的步骤都退出。设置、插件和布局保持壳层上的一个实例。Web 应用保持一台 Host。云端世代持续丢失时，云端段标为断开，本地世代继续运行。

客户端里的会话身份是 `(plane, sessionId)`。每个运行时保留自己的 id 表，因此两台 Host 上相同的会话 id 字符串不会覆盖同一行。

### 登录态决定连接成员

登录成功后追加云端端点并启动其世代。本地壳层保持已加载。退出丢掉云端 cookie、中止云端世代，并清除该账号的云端快照。本地世代保持自己的 id。共享 Host 挂载失败时以同样方式清除云端端点，并显示现有的 Host 不可达提示。之后的 `hostPlaneChanged` 投递更新端点是否存在。URL 未变的世代保持连接。

### 账号隔离

云端运行时的身份是 `platformUserKey(tenant_id, sub)`。退出以及该键发生变化时，先释放云端世代、丢掉其 ticket cookie，并清除其工作区、会话和模型快照，然后再挂接下一个账号。本地运行时没有账号键。它的工作区在换账号后仍然可用。两份目录保持分开，会话留在拥有它的 Host 上。共享 Host 策略仍然是 Peer 能看见哪些工作区和会话的权威。device ticket Peer 可以登记 Web 分区根以外已经存在的绝对目录；该工作区仍然写入同一个 `ownerId`。

### 实现顺序

1. 保持两个端点，并按面路由每个请求。这一步里点击仍可能重连。两端点不再对调。
2. 增加第二份运行时和焦点 `(plane, sessionId)`。从打开会话和新建目录中去掉 `setActivePlane`。点击某一段时，两个世代都继续运行。
3. 登录时挂上云端世代。退出或换账号时释放它。本地文档保持加载。
4. 两段侧栏都从各自的 follow 流渲染，并去掉 sidecar 轮询。

## 考虑过的替代方案

**去掉重连调用，同时继续对调 `streamBaseUrl`。** 已打开的 WebSocket 留在前一台 Host 上，因此下一轮仍然使用那台 Host 的 cookie。要到达另一台 Host，仍然得替换唯一的世代，底栏仍然显示重新连接中。

**保持一个世代，只刷新非活动目录。** 侧栏可以列出两侧，打开非活动侧仍然会中止承载对话的那一代。8 秒快照无法投递实时轮次。

**为云端 Host 再跑一整份客户端。** 设置、插件和布局会各有两份。第二份需要覆盖连接世代、workspace follow、会话目录和模型目录。壳层服务保持一个实例。

**按账号给本地工作区加键。** 需要隔离的是云端。`ELECTRON_RUN_AS_NODE` 已设置时，内嵌 Host 跳过平台准入，它的工作区对该机器上的每个账号都可用。

## 验收标准

- 已保存平台会话且共享 Host 可达时，两个世代都保持连接。在任一段打开会话或新建目录时，连接状态保持在 `connecting` 之外，底栏不显示重新连接中。
- 没有平台会话时，只有本地世代在运行，侧栏没有云端段。
- 退出中止云端世代、丢掉其 cookie，并保留本地世代的 id。
- 账号 B 替换账号 A 之后，在 B 的基线到达之前，A 的云端工作区和会话已经不在。A 的会话不能在 B 的云端运行时上打开。
- 焦点云端会话中的工具或文件读取使用云端 cookie 和该账号的 `ownerId`。
- Web 应用保持其单 Host 的会话与工作区行为。

## 风险

焦点云端会话上的工具、终端和文件调用，在调用方仍使用壳层范围的传输时，仍然可能到达本地 Host。验收检查是一次读取工作区文件的云端会话轮次，并观察到云端 cookie 和 `ownerId`。

两条 follow 流在内存中各持有一份目录。这份开销用来让未聚焦的 Host 保持连接。

登录和退出不再走 `navigateMain` 时，如果云端端点先出现、渲染进程尚未得知新 origin，启动传输会过期。云端世代在渲染进程拿到该 origin 和 cookie 之后才启动。

分区根以外的 device ticket 工作区在 Host 上仍然按账号限定。合并两份客户端目录会把另一台 Host 的行显示到错误的段里，而策略本身仍然过滤正确。
