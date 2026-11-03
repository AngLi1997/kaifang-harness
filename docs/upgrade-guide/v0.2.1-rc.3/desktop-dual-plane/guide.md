# Desktop dual-plane (local / cloud)

When Platform login succeeds and the shared Host is reachable, Desktop shows **This device** and **Cloud** sections in the sidebar and model menu: merged visibility, separate storage. The default active plane is local; opening a cross-plane session switches the active Host. On disconnect, Toast “Cloud disconnected” (「云端已断开」) and degrade to local only (no empty cloud shell).

## Behavior

- The active plane owns `/api` and the Gateway; the inactive plane is polled through `/__dsh_sidecar__` unary RPCs (`workspace/listSnapshot`, `session/list`, `session/modelCatalog`).
- Mutations stay on the active Host.
- The model menu has two sections; only the current session Host’s models are selectable.
- Signed-out or unreachable shared Host: local-only (scheme A visible failure still applies).

## Code

- `apps/desktop/src/host-plane.ts`, `main.ts` protocol/boot/IPC
- `packages/client/ui-workspace/src/client/host-planes/`
- `packages/api/workspace-controller` `listSnapshot`

- The Hero workspace picker uses the same local/cloud sections; new chats default to the local default workspace.
