# Local knowledge bases

English | [中文](knowledge.zh.md)

Experimental local knowledge bases have three roles: the [knowledge service](../../packages/experimental/knowledge/README.md) stores definitions, indexes files, and searches; the [knowledge_search tool](../../packages/experimental/tool-knowledge/README.md) lets the model search; and the [knowledge base page](../../packages/experimental/client-ui-knowledge/README.md) manages bases and inserts `@` mentions. The [optional bundle](../../packages/experimental/knowledge-bundle/README.md) composes them.

## Definitions and index status

`KnowledgeBaseId` brands a base. `KnowledgeBaseDefinition` holds its unique name and absolute Host directories; `KnowledgeBaseInput` and `KnowledgeBaseUpdate` carry the fields `create` and `update` validate. `KnowledgeBaseSummary` adds the canonical mention, the upload directory, and `KnowledgeIndexStatus`, whose `KnowledgeIndexPhase` moves from `pending` through `scanning`, `indexing`, and `embedding` to `ready` or `error`. `KnowledgeCatalog` lists every base with the configured `KnowledgeRetrievalMode`, embedder id, upload limit, and indexed extensions; the browser follows it as a stream.

`KnowledgeFilePage` lists `KnowledgeFileEntry` rows with their `KnowledgeFileState`. `KnowledgeUploadRequest` copies one browser file into a base's upload directory.

## Retrieval

`KnowledgeSearchRequest` names the query, the bases, and a hit limit that the service clamps. BM25 reads an FTS5 `trigram` table: CJK runs become overlapping trigrams, Latin words stay whole, and one- or two-character terms use substring scans. In `hybrid` mode, vector similarity is a second ranked list; reciprocal-rank fusion merges the lists because their scores are not comparable. `KnowledgeSearchResult` returns `KnowledgeSearchHit` rows with path, heading, first line, bounded text, fused score, and contributing `KnowledgeMatchSignal` values, plus each `KnowledgeSearchedBase` with its phase at search time.

## Mentions

`@[name](dsh-knowledge:id)` references a base in prompt text. `KnowledgeMentionCandidate` carries that text for the `@` menu, and the catalog carries it for each base. The mention reaches the model as ordinary user text; the tool's prompt section tells the model to search the mentioned bases, and each search result is a logged tool result.

## Design rationale

Indexes are derived data in single SQLite files so that no database server is installed; the source folders stay authoritative and a schema change rebuilds the index. BM25 is the default because it runs on every device; vectors are opt-in and default to an in-process hashed n-gram embedder that needs no model file.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
