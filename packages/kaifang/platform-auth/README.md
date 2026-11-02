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

The Web bundle mounts this Host plugin. Set these environment variables on the shared Web Host:

| Variable | Meaning |
|---|---|
| `DSH_KAIFANG_IAM_ISSUER` | IAM issuer, such as `https://meta.example/kaifang-meta/iam` |
| `DSH_KAIFANG_CLIENT_ID` | Registered public client; defaults to `kaifang-harness` |
| `DSH_KAIFANG_REDIRECT_URI` | The shared Host's exact registered callback URI, ending in `/kaifang/auth/callback` |
| `DSH_KAIFANG_AUDIENCE` | Platform API audience; defaults to `kaifang-meta-platform` |
| `DSH_KAIFANG_WORKSPACE_ROOT` | Parent directory for opaque per-user workspace partitions |

The client registration must allow `authorization_code` and `refresh_token`, one exact shared callback URI, and the `model:invoke` scope. The callback URL must use HTTPS outside loopback development. Keep the Host credential store accessible only to the service process.

Production uses a dedicated HTTPS hostname for Harness. OAuth routes live under `/kaifang/auth/*`, successful sign-in returns to `/`, and Host RPC stays at `/api`; the login cookie therefore uses that hostname's root path. When IAM is not configured, the plugin permits loopback development only; an exposed listener fails to start. The account overlay starts login in a new tab and checks the Host status route until OAuth returns.

## Understand the implementation

The Host creates state and a PKCE verifier, redirects the browser to IAM, exchanges the callback code server-side, validates the signed-token claims returned over the configured issuer connection, and reads `/userinfo`. It stores the refresh token as a `grant` credential and renews it before access-token expiry. The browser receives only the account profile and an HttpOnly DSH Host cookie.

The admission provider runs inside Connection admission, so it selects the correct `kaifang-user` Peer for both `/api` requests and Gateway WebSocket upgrades. The login, callback, status, cancel, and logout routes use Connection's Host/Origin trust fence but remain reachable before platform sign-in.

The `global` Remote access resource allows only startup, list/search, model-catalog, read-only model-provider directories, read-only settings descriptions, and directory browsing under the signed-in user's root. Session and workspace mutations still require user-bound resources; workspace creation, default initialization, and Session creation are confined again in Host code.

The Host provides `ctx.kaifangPlatformAuth`; Host integrations pass the current Peer's `sub` and `tid` to read that user's identity or access token. It returns no token after expiry or sign-out.

## Model Experience

After sign-in, the Host registers a model route for the current tenant and user. It lists enabled chat and vision models through KaifangMeta, defaults new Sessions to the first available model, and sends model requests back through Meta's server-side proxy. Settings → Models shows the models returned by the current Peer's Session catalog and provides a manual refresh. Provider keys never enter the browser. Model permission is checked again by Meta for every request.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- **One shared Host serves multiple users** — there is no `expectedSub`; IAM registers one exact callback. Session IDs are namespaced and workspaces persist their user ownership.
- **Session lifetime follows IAM refresh policy** — disabling the account or revoking the refresh session clears Host admission on the next renewal.
- **Workspace paths are not an OS sandbox** — terminal or file tools that can execute arbitrary host commands still require per-user OS containers/sandboxing.
- **Model catalog refreshes every 10 seconds** — a revoked or disabled model can remain visible briefly; Meta rejects its next invocation.
