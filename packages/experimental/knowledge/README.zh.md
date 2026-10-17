---
description: "为宿主文件夹和添加的文件建立索引的本地知识库，支持 BM25 与可选向量检索。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-knowledge

[English](README.md) | 中文

## 概述

`ctx.knowledge` 保存具名知识库，每个知识库由一组宿主文件夹和一个上传文件夹组成，并为每个知识库建立一个 SQLite 索引文件用于检索。它不需要数据库服务：`node:sqlite` 的 FTS5 `trigram` 表提供 BM25，可选向量也存放在同一文件中。同一服务还提供 `knowledge` Remote 命名空间，供浏览器管理知识库和使用 `@` 引用。

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

启用[知识库组合包](../knowledge-bundle/README.zh.md)，或挂载本服务并把 `dataRoot` 设为一个宿主目录。其中 `bases.json` 保存定义，`bases/<id>/index.sqlite` 保存各知识库索引，`bases/<id>/files/` 保存添加的文件。删除知识库会删除这两项，所选文件夹不会被修改。

索引读取 Markdown、纯文本、代码、CSV、JSON、YAML、XML、HTML、PDF 文本层，以及 DOCX、PPTX、XLSX 中的文字。隐藏条目、符号链接、`excludedDirectories` 和超过 `maxFileBytes` 的文件会被跳过。`watch` 开启时，目录变化在 `watchDebounceMs` 后触发重新索引；只重新读取大小或修改时间变化的文件，提取文本未变的文件保留原有片段。

`retrieval` 选择排序信号：

| `retrieval` | 信号 | 适用 |
|---|---|---|
| `bm25`（默认） | 基于 trigram 的 FTS5 BM25，一到两个字符的词用子串扫描 | 所有设备 |
| `hybrid` | BM25 与余弦相似度按倒数排名融合 | 召回提升值得向量开销时 |

`embedder` 选择 `hybrid` 的向量化方式。`hashed-ngram`（默认）在进程内运行，不需要模型文件：它对中日韩字符的单字和双字、拉丁单词及其三字符片段做哈希，开销与分词相当，适合低性能设备。`openai-compatible` 调用 `POST <baseUrl>/embeddings`，例如本地 Ollama 或 llama.cpp 服务，会把片段文本发送到该地址。`vectorize: on-demand`（默认）只在查询时为 BM25 候选计算并保存向量；`eager` 在索引后为全部片段计算向量。向量以 int8 存储，并在内存中全量扫描排序。

`indexYieldMs` 在每个文件和目录之后让出执行，`concurrentIndexJobs` 限制同时索引的知识库数，使低性能设备上的宿主在索引期间保持响应。索引进行中的检索返回已索引的内容，并报告各知识库所处阶段。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者信息 — 点击展开</summary>

一个队列运行索引任务；任务进行中发生变化时，知识库被标记为待更新，任务结束后再运行一次。任务依次扫描、移除已消失的文件、重新读取变化的文件、清理无引用的向量，并在 `eager` 模式下按 `embedBatchSize` 分批补齐向量。片段向量以片段文本哈希和嵌入器 id 为键，因此改名或移动的文本保留向量，更换嵌入器后旧向量不再使用。索引 schema 使用单调的 `PRAGMA user_version`；版本不同时根据源文件重建派生索引。

`follow()` 在每次变化时推送完整目录，索引期间最多每 250 ms 一次。Remote 失败使用 `src/index.ts` 中声明的 `knowledge/*` 码。上传只接受受支持的扩展名、规范 base64 且不超过 `maxUploadBytes`；`deleteUpload` 只删除知识库上传文件夹内的文件。`@[name](dsh-knowledge:id)` 是引用语法；`./mention` 负责格式化和解析，目录为每个知识库附带规范引用文本。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [knowledge_search 工具](../tool-knowledge/README.zh.md)
- [知识库页面](../client-ui-knowledge/README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过返回已索引片段的 [knowledge_search 工具](../tool-knowledge/README.zh.md#model-experience)。

#### KV 缓存影响

没有直接影响；进入请求的片段由工具结果承载。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 没有文本层的扫描版 PDF 页面不产生文本；不提供 OCR。
- 向量排序在内存中扫描全部已存向量，适合约十万片段以内的个人知识库；更大的知识库需要近似最近邻索引。
- 不内置基于模型文件的嵌入器；`hashed-ngram` 只反映字面相似度，语义向量需要 `openai-compatible` 服务。
- 索引在宿主事件循环中分段执行而非在 worker 中运行，解析单个超大文件时仍会阻塞事件循环。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者信息 — 点击展开</summary>

无。

</details>
