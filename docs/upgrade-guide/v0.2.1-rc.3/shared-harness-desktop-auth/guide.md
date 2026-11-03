---
kind: upgrade-guide
description: "Desktop replaces the KaifangLab login bridge with a shared Web Host authenticated by Platform IAM."
---

# Desktop replaces the KaifangLab login bridge

English | [中文](guide.zh.md)

## Change

Desktop no longer uses its native KaifangLab login bridge or saved KaifangLab credentials. Enter the Platform origin in Welcome; Desktop opens its public `/harness` route, which redirects to the configured Web Host. The Host authenticates through Platform IAM, shows an OAuth confirmation for `kaifang-harness`, and keeps OAuth tokens server-side. Web and Desktop share workspace and Session records, including live Session events, when signed in as the same Platform identity (`tenant_id + sub`). Local `$DSH_HOME` Sessions remain local and are not imported into the shared Host.

## Migration

1. Configure the shared Host with [`kaifang-platform-auth`](../../../../packages/kaifang/platform-auth/README.md) and set Platform `VITE_HARNESS_WEB_URL` to its entry URL. Enter the Platform origin in Desktop Welcome → Settings and save it locally; Desktop does not read a sibling KaifangMeta `.env` or use a build-time default. Loopback HTTP is accepted for development. Desktop removes `desktop/kaifang-session.json` and `desktop/system-connection.json` at startup. The Web client also clears the old `dsh.kaifang.session` and `dsh.kaifang.callback` localStorage keys when it loads; no credential conversion is needed.
2. Sign into the same Platform identity (`tenant_id + sub`) in the Web client and Desktop. To keep using local Sessions, choose **Open local workspace** from the application menu or **Use local workspace** in Welcome; they do not appear in the shared Host.
3. Confirm both clients show the same workspace and Session, then send a message and verify that its streamed response appears in both. Native Desktop integrations, including file drag, are unavailable in the shared Web Host window.
