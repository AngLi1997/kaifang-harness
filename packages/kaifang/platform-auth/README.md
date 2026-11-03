---
description: "Shared multi-user Web Host sign-in through KaifangMeta IAM, with server-held PKCE tokens and identity-specific Peers."
kind: "package-reference"
---

# @deepseek-ai/dsh-kaifang-platform-auth

English | [中文](README.zh.md)

## Summary

Authenticates multiple KaifangMeta accounts on one shared Web Host. The Host runs OAuth authorization code with PKCE, stores each browser session's access and refresh tokens through `ctx.credentials`, and keeps tokens out of the browser. A Connection admission provider selects an identity-specific Peer for HTTP RPC and Gateway WebSocket traffic; a Remote access policy scopes workspace and session resources by `tenant_id + sub`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The Web bundle mounts this Host plugin and supplies its OAuth settings in its [Cordis patch](../../bundle/web-app/cordis.patch.yml). The plugin accepts these options:

| Field | Default | Meaning |
|---|---|---|
| `issuer` | Empty | OIDC issuer URL |
| `clientId` | `kaifang-harness` | Registered public IAM client |
| `redirectUri` | Empty | Shared Host callback URI; its local-development values are used as the host-alias template |
| `audience` | `kaifang-meta-platform` | Platform API audience |
| `requiredScopes` | `['model:invoke']` | Scopes the user must grant |
| `refreshSkewSeconds` | `60` | Refresh access tokens this many seconds before expiry |
| `requestTimeoutMs` | `10000` | Timeout for one IAM request, in milliseconds |

The client registration must allow `authorization_code`, `refresh_token`, an exact loopback callback template ending in `/kaifang/auth/callback`, and the `model:invoke` scope. Production accepts exact callback URIs. Local Harness development reuses that template's scheme, port, path, and query while using the current localhost, loopback, or private-IP hostname for browser authorization and callback. Callback URLs must use HTTPS outside local development. Keep the Host credential store accessible only to the service process.

The Web bundle's checked-in `issuer` and `redirectUri` target local KaifangMeta development. Adjust the patch values for another deployment; see the [Web bundle deployment guidance](../../bundle/web-app/README.md#public-deployments).

Production uses a dedicated HTTPS hostname for Harness. OAuth routes live under `/kaifang/auth/*`, successful sign-in returns to `/`, and Host RPC stays at `/api`; the login cookie therefore uses that hostname's root path. The browser plugin checks `/kaifang/auth/status` on startup and connection reset, then redirects unauthenticated users to `/kaifang/auth/entry`. When IAM is not configured, the plugin permits loopback development only; an exposed listener fails to start. To access the local Web Host by LAN IP, run `pnpm run dev:web -- --host <local-interface-IP>`; the listener binds one concrete address and rejects wildcards.

## Understand the implementation

The Host creates state and a PKCE verifier, redirects the browser to IAM, exchanges the callback code server-side, validates the signed-token claims returned over the configured issuer connection, and reads `/userinfo`. For local aliases, the browser authorization URL and callback use the current host while the token retains the configured canonical issuer. It stores the refresh token as a `grant` credential and renews it before access-token expiry. The browser receives only the account profile and an HttpOnly DSH Host cookie; local same-site development uses a Lax cookie, while cross-site iframe callbacks use `SameSite=None; Secure; Partitioned` and remain partitioned by top-level site.

The admission provider runs inside Connection admission, so it selects the correct `kaifang-user` Peer for both `/api` requests and Gateway WebSocket upgrades. Browser clients present the Host login cookie; Desktop presents either that cookie after `POST /kaifang/auth/device` (device ticket: Platform access + refresh tokens → Host session cookie) or a matching `Authorization: Bearer` access token for an already-admitted session. Desktop cold start with a stored usable platform session performs that device-ticket exchange before the shell loads so the native client attaches as Remote Client without a logout→login cycle. The login, callback, device, status, cancel, and logout routes use Connection's Host/Origin trust fence but remain reachable before platform sign-in.

The `global` Remote access resource allows only startup, list/search, model-catalog, read-only model-provider directories, read-only settings descriptions, and directory browsing under the signed-in user's root. Session and workspace mutations still require user-bound resources; workspace creation, default initialization, and Session creation are confined again in Host code. The shared-Host `kaifang-user` Peer allowlist (`peer-roles.ts`) includes `workspace/deleteSession` for soft-delete (distinct from archive) so Web and Desktop Remote Clients can hide Sessions without wiping logs.

The Host provides `ctx.kaifangPlatformAuth`; Host integrations pass the current Peer's `sub` and `tid` to read that user's identity or access token. It returns no token after expiry or sign-out.

## Model Experience

After sign-in, the Host registers a model route for the current tenant and user. It lists enabled chat and vision models through KaifangMeta, defaults new Sessions to the first available model, and sends model requests back through Meta's server-side proxy. Settings → Models shows the models returned by the current Peer's Session catalog and provides a manual refresh. Provider keys never enter the browser. Model permission is checked again by Meta for every request.

The Desktop profile sends platform-model requests to Meta's `harness.chat` capability proxy. Web Host sessions use the AI model proxy. Models configured directly in DSH keep their native providers.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- **One shared Host serves multiple users** — there is no `expectedSub`; IAM registers one exact callback. Session IDs are namespaced and workspaces persist their user ownership.
- **Session lifetime follows IAM refresh policy** — disabling the account or revoking the refresh session clears Host admission on the next renewal.
- **Workspace paths are not an OS sandbox** — terminal or file tools that can execute arbitrary host commands still require per-user OS containers/sandboxing.
- **Model catalog refreshes every 10 seconds** — a revoked or disabled model can remain visible briefly; Meta rejects its next invocation.
