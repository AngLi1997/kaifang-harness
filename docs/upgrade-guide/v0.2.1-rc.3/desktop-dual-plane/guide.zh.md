# Desktop 双平面（本机 / 云端）

登录且共享 Host 可到达时，Desktop 侧栏与模型菜单分区展示 **本机** 与 **云端**：合并可见、不合并存储。默认活动平面为本机；跨平面打开会话会切换活动 Host。断线后 Toast「云端已断开」，降级为仅本机（不保留仅本机）。

## 行为摘要

- 活动平面承担 `/api` 与 Gateway；非活动平面经 `/__dsh_sidecar__` 一元 RPC（`workspace/listSnapshot`、`session/list`、`session/modelCatalog`）刷新侧栏与模型菜单第二段。
- 操作归边：新建工作区/会话、归档等走当前活动 Host。
- 模型菜单两段；可选性跟随当前会话所在 Host（非活动平面模型禁用展示）。
- 未登录或共享 Host 不可达：仅本机（方案 A 可见失败提示仍适用）。

## 相关代码

- `apps/desktop/src/host-plane.ts`、`main.ts` protocol/boot/IPC
- `packages/client/ui-workspace/src/client/host-planes/`
- `packages/api/workspace-controller` `listSnapshot`

- Hero 工作区选择器同样分「本机 / 云端」两段；新对话默认落在本机默认工作区。
