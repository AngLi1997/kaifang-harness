# 本地知识库

[English](knowledge.md) | 中文

实验性本地知识库分为三个角色：[知识库服务](../../packages/experimental/knowledge/README.zh.md)保存定义、为文件建立索引并执行检索；[knowledge_search 工具](../../packages/experimental/tool-knowledge/README.zh.md)让模型检索；[知识库页面](../../packages/experimental/client-ui-knowledge/README.zh.md)管理知识库并插入 `@` 引用。[可选组合包](../../packages/experimental/knowledge-bundle/README.zh.md)把它们组合在一起。

## 定义与索引状态

`KnowledgeBaseId` 标识一个知识库。`KnowledgeBaseDefinition` 保存其唯一名称和宿主绝对目录；`KnowledgeBaseInput` 与 `KnowledgeBaseUpdate` 承载 `create` 和 `update` 校验的字段。`KnowledgeBaseSummary` 另含规范引用文本、上传目录和 `KnowledgeIndexStatus`，其 `KnowledgeIndexPhase` 从 `pending` 经 `scanning`、`indexing`、`embedding` 进入 `ready` 或 `error`。`KnowledgeCatalog` 列出全部知识库以及配置的 `KnowledgeRetrievalMode`、嵌入器 id、上传上限和受支持的扩展名；浏览器以流的方式订阅它。

`KnowledgeFilePage` 列出带 `KnowledgeFileState` 的 `KnowledgeFileEntry`。`KnowledgeUploadRequest` 把一个浏览器文件复制到知识库的上传目录。

## 检索

`KnowledgeSearchRequest` 指定查询、知识库和由服务收紧的命中上限。BM25 读取 FTS5 `trigram` 表：中日韩字符串拆成相互重叠的三字片段，拉丁单词保持完整，一到两个字符的词使用子串扫描。`hybrid` 模式下，向量相似度构成第二个排序列表；由于各列表的分数不可比较，使用倒数排名融合合并。`KnowledgeSearchResult` 返回带路径、标题、起始行、截断文本、融合分数和 `KnowledgeMatchSignal` 的 `KnowledgeSearchHit`，以及检索时各知识库所处阶段的 `KnowledgeSearchedBase`。

## 引用

`@[name](dsh-knowledge:id)` 在提示文本中引用一个知识库。`KnowledgeMentionCandidate` 为 `@` 菜单携带这段文本，目录也为每个知识库携带它。引用作为普通用户文本到达模型；工具的提示词段落要求模型检索被引用的知识库，每次检索结果都是已记录的工具结果。

## 设计理由

索引作为派生数据存放在单个 SQLite 文件中，因此不需要安装数据库服务；源文件夹始终是权威来源，schema 变化时重建索引。BM25 是默认方式，因为它在任何设备上都能运行；向量需要显式开启，默认使用不需要模型文件的进程内哈希 n-gram 嵌入器。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxknowledge--knowledgeruntime"></a>

### `ctx.knowledge` — `KnowledgeRuntime`

Local knowledge base registry, indexer, and retriever.

```ts cordis-catalog
/**
 * Snapshot every knowledge base.
 * @returns definitions with index status, in creation order.
 */
list(): KnowledgeBaseSummary[]

/**
 * Read the browser-facing catalog.
 * @returns bases and retrieval configuration.
 */
@Remote catalog(): KnowledgeCatalog

/**
 * Follow the catalog: the current snapshot, then one snapshot per change, at most every 250 ms during indexing.
 * @param signal - observation lifetime.
 * @returns complete catalog snapshots.
 */
@Remote({ mode: 'stream' }) async *follow(signal: AbortSignal): AsyncIterable<KnowledgeCatalog>

/**
 * Create a knowledge base and start indexing it.
 * @param input - name and directories.
 * @returns the new base.
 */
@Remote async create(input: KnowledgeBaseInput): Promise<KnowledgeBaseSummary>

/**
 * Rename a knowledge base or replace its directories; a directory change re-indexes it.
 * @param update - id and replacement fields.
 * @returns the updated base.
 */
@Remote async update(update: KnowledgeBaseUpdate): Promise<KnowledgeBaseSummary>

/**
 * Delete a knowledge base, its index, and its uploaded files. Configured directories are untouched.
 * @param id - base to delete.
 */
@Remote('delete') async remove(id: KnowledgeBaseId): Promise<void>

/**
 * Re-scan a knowledge base now.
 * @param id - base to re-index.
 */
@Remote reindex(id: KnowledgeBaseId): void

/**
 * List indexed files of a knowledge base.
 * @param id - base to list.
 * @returns files sorted by path, bounded by the configured listing limit.
 */
@Remote async files(id: KnowledgeBaseId): Promise<KnowledgeFilePage>

/**
 * Copy one browser file into a knowledge base's upload directory and index it.
 * @param request - target base, file name, and base64 content.
 * @returns the stored file, pending indexing.
 */
@Remote async upload(request: KnowledgeUploadRequest): Promise<KnowledgeFileEntry>

/**
 * Delete an uploaded file and drop it from the index.
 * @param id - owning base.
 * @param path - absolute path inside the base's upload directory.
 */
@Remote async deleteUpload(id: KnowledgeBaseId, path: string): Promise<void>

/**
 * Search knowledge bases. Bases that are still indexing return what is indexed so far.
 * @param request - query, bases, and hit limit.
 * @param signal - cancellation.
 * @returns ranked hits and the searched bases.
 */
@Remote async search(request: KnowledgeSearchRequest, signal: AbortSignal): Promise<KnowledgeSearchResult>

/**
 * List `@` menu candidates whose name contains the query.
 * @param query - case-insensitive name substring; empty lists every base.
 * @param signal - caller cancellation.
 * @returns candidates with canonical mentions, bounded by the configured limit.
 */
@Remote candidates(query: string, signal: AbortSignal): KnowledgeMentionCandidate[]
```

Source: [`packages/experimental/knowledge/src/index.ts`](../../packages/experimental/knowledge/src/index.ts)
<!-- END GENERATED cordis-surface -->
