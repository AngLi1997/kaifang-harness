# Agent Note: Keep both Desktop hosts connected for the signed-in account

Status: proposed

English | [中文](2026-11-04-desktop-dual-host-connections.zh.md)

## Problem

On Desktop, choosing a workspace or session on the other side of the sidebar replaces the only live Host connection. The footer shows 重新连接中 (`connection.connecting`) until that generation is ready. A signed-in reader needs the local Host and the shared Host connected together. A signed-out reader needs the local Host. Cloud workspaces belonging to different accounts stay separate.

Desktop already draws both sections when a stored platform session can attach to the shared Host. [Dual-plane boot](../../../../apps/desktop/src/host-plane.ts) still selects one active Host. [`applyActivePlane`](../../../../apps/desktop/src/main.ts) points `hostUrl`, `hostCookie`, and `ownsHost` at that Host. The other Host answers only unary HTTP under `/__dsh_sidecar__`. The renderer polls that prefix every 8 seconds for `workspace/listSnapshot`, `session/list`, and `session/modelCatalog`. The [workspace README](../../../../packages/client/ui-workspace/README.md) describes the inactive list as a read-only snapshot.

Opening a session on the inactive section ([`openSidecarSession`](../../../../packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx)) and adding a directory there ([`openAdd`](../../../../packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx)) call `setActivePlane`. The main process swaps the endpoints and emits `hostPlaneChanged`. The renderer writes the new `streamBaseUrl` and calls [`ConnectionController.reconnect`](../../../../packages/client/connection/src/client/connection.ts), which aborts the current generation. Every `hostPlaneChanged` delivery runs that reconnect, including a republish that left the active Host unchanged. After the swap, the client waits until the new catalog lists the session, then opens it. One `sessions` catalog and one `workspaces` follow stream ride that generation, so the previous Host's live state is gone until the swap reverses.

Sign-in stores the platform session, attaches the shared Host, and reloads the application document. Sign-out clears that session, drops the shared-Host cookie, and reloads the document when a workspace window is open. Both reloads restart the local connection as well. The shared Host already limits each `kaifang-user` Peer to workspaces whose `ownerId` is [`platformUserKey`](../../../../packages/kaifang/platform-auth/src/identity.ts) of `tenant_id` and `sub`, and to session ids with the `user-${ownerId}-session-` prefix. The Desktop client keeps one cloud cookie and one in-memory sidecar snapshot, with no account key. A document reload discards that snapshot today. Two long-lived connections would keep showing the previous account until the cloud generation is cleared.

No active Agent Note owns this Desktop connection choice.

## Proposal

Login state chooses which Hosts stay connected. A sidebar click chooses the focused `(plane, sessionId)` and leaves those connections running.

### Stable endpoints

The Desktop main process keeps two endpoints for as long as the renderer runs. The local endpoint is the embedded Host and its cookie. The cloud endpoint exists after a platform session is stored and device-ticket attach succeeds, and it carries that account's ticket cookie. [`resolveDesktopHostForward`](../../../../apps/desktop/src/web-document.ts) sends each plane's session, workspace, and model requests to that plane's cookie. Plugin and Desktop-owned settings requests stay on the local Host, which `isDesktopOwnedHostPath` already selects when `ownsHost` is false. `hostPlaneSet` stops changing cookies and stream URLs. The renderer receives both stream origins at boot. The cloud origin is absent while the cloud endpoint is absent.

### One runtime per Host

Each connected Host gets its own connection generation, `workspace/follow` stream, session catalog, and model catalog. The conversation, composer, model choice, tools, terminal, and file reads use the focused session's runtime. Adding a directory on the cloud section calls `workspace/create` on the cloud runtime. The sidebar sections read those follow streams. The 8-second sidecar poll and the wait for the swapped catalog both retire. Settings, plugins, and layout stay one shell instance. The Web app stays one Host. A cloud generation that stays lost marks the cloud section disconnected and leaves the local generation running.

Session identity in the client is `(plane, sessionId)`. Each runtime keeps its own id map, so the same session id string on two Hosts cannot overwrite one row.

### Login decides membership

A successful sign-in adds the cloud endpoint and starts its generation. The local shell stays loaded. Sign-out drops the cloud cookie, aborts the cloud generation, and clears that account's cloud snapshots. The local generation keeps its id. Shared-Host attach failure clears the cloud endpoint the same way and shows the existing unreachable-Host notice. A later `hostPlaneChanged` delivery updates endpoint presence. A generation whose URL is unchanged stays up.

### Account isolation

The cloud runtime's identity is `platformUserKey(tenant_id, sub)`. Sign-out and a change of that key dispose the cloud generation, drop its ticket cookie, and clear its workspace, session, and model snapshots before the next account attaches. The local runtime has no account key. Its workspaces remain available across account changes. The two catalogs stay separate, and a session stays on the Host that owns it. The shared Host policy remains the authority for which workspaces and sessions a Peer can see. A device-ticket Peer may register an existing absolute directory outside the Web partition root; that workspace still stores the same `ownerId`.

### Implementation order

1. Keep both endpoints and route each request by plane. Clicks may still reconnect in this step. The endpoints no longer swap.
2. Add the second runtime and focus `(plane, sessionId)`. Remove `setActivePlane` from session open and add-directory. A section click leaves both generations running.
3. Attach the cloud generation on sign-in. Dispose it on sign-out or account change. Leave the local document loaded.
4. Render both sidebar sections from their follow streams and remove the sidecar poll.

## Alternatives considered

**Drop the reconnect call and keep swapping `streamBaseUrl`.** The open WebSocket stays on the previous Host, so the next turn still uses that Host's cookie. Reaching the other Host still replaces the only generation, and the footer still shows reconnecting.

**Keep one generation and only refresh the inactive catalog.** The sidebar can list both sides, and opening the inactive side still aborts the generation that carries the conversation. The 8-second snapshot cannot deliver a live turn.

**Run a second copy of the whole client for the cloud Host.** Settings, plugins, and layout would each exist twice. The second copy needs to cover the connection generation, workspace follow, session catalog, and model catalog. Shell services stay one instance.

**Key local workspaces by account.** Cloud isolation is the requirement. The embedded Host skips platform admission when `ELECTRON_RUN_AS_NODE` is set, and its workspaces stay available for every account on that machine.

## Acceptance criteria

- With a stored platform session and a reachable shared Host, both generations stay connected. Opening a session or adding a directory on either section keeps the connection state off `connecting`, and the footer does not show 重新连接中.
- With no platform session, only the local generation runs, and the sidebar has no cloud section.
- Sign-out aborts the cloud generation, drops its cookie, and preserves the local generation id.
- After account B replaces account A, account A's cloud workspaces and sessions are absent before account B's baseline arrives. A's session cannot be opened on B's cloud runtime.
- A tool or file read in a focused cloud session uses the cloud cookie and that account's `ownerId`.
- The Web app keeps its single-Host session and workspace behavior.

## Risks

Tool, terminal, and file calls on a focused cloud session can still reach the local Host when a caller keeps using the shell-wide transport. The acceptance check is a cloud-session turn that reads a workspace file and observes the cloud cookie and `ownerId`.

Two follow streams hold two catalogs in memory. That cost is what keeps the unfocused Host connected.

Moving sign-in and sign-out off `navigateMain` can leave a stale boot transport when the cloud endpoint appears before the renderer learns the new origin. The cloud generation starts after the renderer has that origin and cookie.

A device-ticket workspace outside the partition root stays account-scoped on the Host. Merging the two client catalogs would show the other Host's rows in the wrong section while the policy still filters correctly.
