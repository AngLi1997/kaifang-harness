---
description: "随 Web 应用发布的开方内置插件包索引。"
kind: "package-group"
---

# kaifang/ — 开方内置插件

[English](README.md) | 中文

## 摘要

所有开方专属的内置插件都放在本分组中，每个包一个目录。Web bundle 默认挂载这些包，用户无需安装即可使用。

## 目录

- [包](#packages)
- [新增包](#add-a-package)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [client-ui-archive-tools](client-ui-archive-tools/README.zh.md) | 侧边栏档案工具目录、点击引用与 `@` 选取 | — |

-----

<a id="add-a-package"></a>
## 新增包

包放在 `packages/kaifang/<role>/`，命名为 `@deepseek-ai/dsh-kaifang-<role>`；浏览器插件使用 `client-ui-` 职责前缀。按照[新增包清单](../../docs/cookbook/adding-a-package.zh.md)创建，在根 `tsconfig.base.json` 的 paths 以及 `tsconfig.host.json` 或 `tsconfig.client.json` 聚合中注册，再把它加入 [Web bundle](../bundle/web-app/cordis.patch.yml) 和上表。

-----

<a id="related-documentation"></a>
## 相关文档

- [Web 客户端](../../docs/subsystems/web-client.zh.md) — 浏览器插件组合、插槽与服务。
- [Web bundle](../bundle/web-app/README.zh.md) — 挂载这些包的默认插件集。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
