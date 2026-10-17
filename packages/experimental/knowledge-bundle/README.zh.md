---
description: "在插件页启用本地知识库、knowledge_search 工具和 @ 引用。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-knowledge-bundle

[English](README.md) | 中文

## 概述

此可选组合包组合[知识库服务](../knowledge/README.zh.md)、[knowledge_search 工具](../tool-knowledge/README.zh.md)和[知识库页面](../client-ui-knowledge/README.zh.md)。随附的 profile 默认不启用它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Web 侧边栏打开“插件”，启用“本地知识库”。侧边栏随即出现“本地知识库”入口；在其中用文件夹或添加的文件新建知识库，然后在对话中用 `@` 引用它，或点击“在知识库中提问”。组合包默认使用 BM25 检索；在 profile 的 `cordis.patch.yml` 中为 `knowledge` 行设置 `retrieval: hybrid` 即可加入向量。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者信息 — 点击展开</summary>

静态 `cordis.patch.yml` 添加 `knowledge`、`tool-knowledge` 和 `ui-knowledge` 三行，数据存放在 `dshHomePath('knowledge')` 下。停用组合包会移除这些行；已保存的定义、索引和添加的文件仍保留在磁盘上。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [知识库服务](../knowledge/README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过本组合包挂载的 [knowledge_search 工具](../tool-knowledge/README.zh.md#model-experience)。

#### KV 缓存影响

启用组合包会加入一个固定提示词段落和一个工具 schema，使请求前缀改变一次。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 组合包图标尚待设计师评审。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者信息 — 点击展开</summary>

无。

</details>
