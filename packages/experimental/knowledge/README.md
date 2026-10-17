---
description: "Local knowledge bases that index Host folders and added files for BM25 and optional vector search."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-knowledge

English | [中文](README.zh.md)

## Summary

`ctx.knowledge` keeps named knowledge bases, each a set of Host folders plus an upload folder, and indexes them into one SQLite file per base for search. It needs no database server: `node:sqlite` with an FTS5 `trigram` table serves BM25, and optional vectors live in the same file. The same service exposes the `knowledge` Remote namespace for browser management and `@` mentions.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Enable the [knowledge bundle](../knowledge-bundle/README.md), or mount this service with `dataRoot` set to a Host directory. `bases.json` there stores definitions; `bases/<id>/index.sqlite` stores each index and `bases/<id>/files/` stores added files. Deleting a base removes those two; the chosen folders are never modified.

Indexing reads Markdown, plain text, code, CSV, JSON, YAML, XML, HTML, PDF text layers, and DOCX, PPTX, and XLSX text. Hidden entries, symbolic links, `excludedDirectories`, and files larger than `maxFileBytes` are skipped. Directory changes re-index after `watchDebounceMs` while `watch` is on; only files whose size or modification time changed are re-read, and unchanged extracted text keeps its chunks.

`retrieval` selects the ranking signals:

| `retrieval` | Signals | Fits |
|---|---|---|
| `bm25` (default) | FTS5 BM25 over trigrams, plus substring scan for one- and two-character terms | every device |
| `hybrid` | BM25 fused with cosine similarity by reciprocal rank | when better recall justifies vector cost |

`embedder` selects how `hybrid` vectorizes. `hashed-ngram` (default) runs in-process with no model file: it hashes CJK character unigrams and bigrams plus Latin words and their trigrams, so it costs about as much as tokenization and suits low-end devices. `openai-compatible` calls `POST <baseUrl>/embeddings`, such as a local Ollama or llama.cpp server, and sends chunk text to that endpoint. `vectorize: on-demand` (default) vectorizes only BM25 candidates at query time and keeps their vectors; `eager` vectorizes every chunk after indexing. Vectors are stored as int8 and ranked by an in-memory scan.

`indexYieldMs` pauses after every file and directory, and `concurrentIndexJobs` bounds parallel bases, so indexing on slow devices leaves the Host responsive. Searches during indexing return what is already indexed and report each base's phase.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

One queue runs index jobs; a change during a job marks the base dirty and re-runs it afterwards. A job scans, removes vanished files, re-reads changed files, prunes unreferenced vectors, and in `eager` mode embeds missing vectors in `embedBatchSize` batches. Chunk vectors are keyed by chunk-text hash and embedder id, so renamed or moved text keeps its vector and a different embedder ignores old ones. The index schema uses a monotonic `PRAGMA user_version`; another version rebuilds the derived index from the source files.

`follow()` streams the complete catalog on each change, at most every 250 ms during indexing. Remote failures use the `knowledge/*` codes declared in `src/index.ts`. Uploads accept only indexed extensions, canonical base64, and at most `maxUploadBytes`; `deleteUpload` deletes only files inside the base's upload folder. `@[name](dsh-knowledge:id)` is the mention grammar; `./mention` formats and parses it, and the catalog carries each base's canonical mention.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [knowledge_search tool](../tool-knowledge/README.md)
- [Knowledge base page](../client-ui-knowledge/README.md)

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the [knowledge_search tool](../tool-knowledge/README.md#model-experience), which returns indexed passages.

#### KV Cache effect

No direct effect; tool results own the passages that enter requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Scanned PDF pages without a text layer produce no text; OCR is not provided.
- Vector ranking scans every stored vector in memory, which suits personal bases up to roughly a hundred thousand chunks; larger bases need an approximate-nearest-neighbour index.
- No model-file embedder ships; `hashed-ngram` ranks lexical similarity, and semantic vectors require an `openai-compatible` endpoint.
- Indexing runs on the Host event loop between yields rather than in a worker, so very large single files still block it while they are parsed.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
