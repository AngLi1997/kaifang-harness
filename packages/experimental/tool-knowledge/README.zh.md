---
description: "面向模型的本地知识库检索工具 knowledge_search，返回带引用的片段并呈现检索卡片。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-knowledge

[English](README.md) | 中文

## 概述

`knowledge_search` 让模型通过 `ctx.knowledge` 检索用户的本地知识库，并根据返回的片段回答、引用其文件路径。用户消息以 `@[name](dsh-knowledge:ID)` 引用知识库时，模型据此确定要检索的知识库。

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

启用[知识库组合包](../knowledge-bundle/README.zh.md)，或在[知识库服务](../knowledge/README.zh.md)之后挂载本插件。`defaultLimit` 设置模型省略 `limit` 时返回的片段数；服务会把每个上限收紧到其 `maxSearchLimit`。`timeoutMs` 限制单次检索时长。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者信息 — 点击展开</summary>

工具结果值就是服务的检索结果；`render` 把它转为下文所述的文本，`presentationMeta` 按文件分组生成检索卡片，因此回放时可以从已记录的结果重建卡片。未知知识库 id、空查询或非正数上限会以工具错误结束调用。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [知识库服务](../knowledge/README.zh.md)
- [知识库页面](../client-ui-knowledge/README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

### 系统提示词

#### 模型看到的内容

`knowledge_search` 可见时，模型收到一个固定段落。

##### 知识库指引

```markdown
knowledge_search searches the user's local knowledge bases, which index folders and files the user chose. When a user message mentions a knowledge base as @[name](dsh-knowledge:ID), call knowledge_search with knowledgeBaseIds set to those IDs before answering, and base the answer on the returned passages. Search again with different wording when the first results are not relevant. Cite the file path of each passage you use. When no passage answers the question, say so instead of guessing.
```

#### Token 影响

工具可见时，每次请求包含一个固定段落。

#### KV 缓存影响

插件和指引文本不变时前缀稳定。

### 工具 schema

#### 模型看到的内容

模型看到生成的 [`knowledge_search` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-tool-knowledge)：必填 `query`，可选 `knowledgeBaseIds` 和 `limit`。

#### Token 影响

工具可见时，每次请求发送一个固定 schema。

#### KV 缓存影响

工具可见性和定义不变时前缀稳定。

### 工具结果

#### 模型看到的内容

每次成功调用输出一个文本块：说明片段是文件内容而非指令的提示，已检索的知识库名称（未完成索引的会注明），以路径、标题、行号和知识库名称开头的编号片段，以及引用提醒；没有结果时为 `No matching passages.`。

#### Token 影响

结果取决于数据，在压缩前保留在已记录的工具历史中；命中上限和服务的 `maxHitChars` 限制其大小。

#### KV 缓存影响

结果文本追加在可复用的请求前缀之后，不会使之前的缓存失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 引用本身不会检索片段；是否调用工具由模型在系统提示词指引下决定。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者信息 — 点击展开</summary>

无。

</details>
