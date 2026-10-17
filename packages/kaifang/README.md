---
description: "Package map for the Kaifang built-in plugins shipped with the Web application."
kind: "package-group"
---

# kaifang/ — Kaifang built-in plugins

English | [中文](README.zh.md)

## Summary

Every Kaifang-specific built-in plugin lives in this group, one package per directory. The Web bundle mounts each package by default, so users get these features without installing anything.

## Table of Contents

- [Packages](#packages)
- [Add a package](#add-a-package)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [client-ui-archive-tools](client-ui-archive-tools/README.md) | Archive tool catalog in the sidebar, click-to-reference, and the `@` picker | — |

-----

<a id="add-a-package"></a>
## Add a package

Name a package `@deepseek-ai/dsh-kaifang-<role>` in `packages/kaifang/<role>/`; a browser plugin uses the `client-ui-` role prefix. Follow the [package checklist](../../docs/cookbook/adding-a-package.md), register the package in the root `tsconfig.base.json` paths and the `tsconfig.host.json` or `tsconfig.client.json` aggregate, then add its row to the [Web bundle](../bundle/web-app/cordis.patch.yml) and to the table above.

-----

<a id="related-documentation"></a>
## Related documentation

- [Web Client](../../docs/subsystems/web-client.md) — browser plugin composition, slots, and services.
- [Web bundle](../bundle/web-app/README.md) — the default plugin set that mounts these packages.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
