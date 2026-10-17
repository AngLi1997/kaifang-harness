/**
 * Public local knowledge base records, index status, search requests, and
 * results. The module has no runtime imports, so generated Remote clients and
 * browser plugins consume it without Host code.
 * @module @deepseek-ai/dsh-experimental-knowledge/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque identity of one local knowledge base. */
export type KnowledgeBaseId = Branded<'KnowledgeBaseId'>

/** Retrieval mode applied to every search. `bm25` reads only the full-text index; `hybrid` also ranks by vectors. */
export type KnowledgeRetrievalMode = 'bm25' | 'hybrid'

/** Stored definition of one knowledge base. */
export interface KnowledgeBaseDefinition {
  /** Stable identity used by mentions and tools. */
  id: KnowledgeBaseId
  /** User-facing unique name. */
  name: string
  /** Absolute Host directories indexed recursively, in user order. */
  directories: string[]
  /** Creation time in Unix epoch milliseconds. */
  createdAt: number
  /** Last definition change in Unix epoch milliseconds. */
  updatedAt: number
}

/** Indexing lifecycle of one knowledge base. */
export type KnowledgeIndexPhase = 'pending' | 'scanning' | 'indexing' | 'embedding' | 'ready' | 'error'

/** Index progress and size of one knowledge base. */
export interface KnowledgeIndexStatus {
  /** Current lifecycle phase. */
  phase: KnowledgeIndexPhase
  /** Supported files found by the latest scan. */
  totalFiles: number
  /** Files whose text is in the index. */
  indexedFiles: number
  /** Files whose extraction failed in the latest pass. */
  failedFiles: number
  /** Indexed text chunks. */
  chunkCount: number
  /** Chunks that carry a vector for the configured embedder. */
  vectorCount: number
  /** Completion time of the latest full pass, in Unix epoch milliseconds. */
  indexedAt?: number
  /** Failure that stopped the latest pass. */
  error?: string
  /** Whether directory changes trigger incremental indexing. */
  watching: boolean
  /** Configured directories that do not exist or are not directories. */
  missingDirectories: string[]
  /** Whether the latest scan stopped at the configured per-base file limit. */
  fileLimitReached: boolean
}

/** One knowledge base as configuration and browser surfaces read it. */
export interface KnowledgeBaseSummary extends KnowledgeBaseDefinition {
  /** Canonical `@[name](dsh-knowledge:id)` text that references this base. */
  mention: string
  /** Host directory that receives files added through the browser. */
  uploadDirectory: string
  /** Current index status. */
  status: KnowledgeIndexStatus
}

/** Complete browser-facing snapshot of every knowledge base and the retrieval configuration. */
export interface KnowledgeCatalog {
  /** Knowledge bases in creation order. */
  bases: KnowledgeBaseSummary[]
  /** Configured retrieval mode. */
  retrieval: KnowledgeRetrievalMode
  /** Id of the configured embedder; absent in `bm25` mode. */
  embedder?: string
  /** Largest file accepted by one upload, in bytes. */
  maxUploadBytes: number
  /** File extensions the indexer reads, lowercase with a leading dot. */
  extensions: string[]
}

/** Fields of a new knowledge base. */
export interface KnowledgeBaseInput {
  /** User-facing unique name. */
  name: string
  /** Absolute Host directories; may be empty when the base holds only uploaded files. */
  directories: string[]
}

/** Replacement fields of an existing knowledge base. */
export interface KnowledgeBaseUpdate extends KnowledgeBaseInput {
  /** Knowledge base to change. */
  id: KnowledgeBaseId
}

/** One browser file copied into a knowledge base's upload directory. */
export interface KnowledgeUploadRequest {
  /** Receiving knowledge base. */
  id: KnowledgeBaseId
  /** Original file name; the Host keeps only its base name. */
  fileName: string
  /** File bytes in canonical base64. */
  contentBase64: string
}

/** Index state of one file. */
export type KnowledgeFileState = 'pending' | 'indexed' | 'failed'

/** One file known to a knowledge base index. */
export interface KnowledgeFileEntry {
  /** Absolute Host path. */
  path: string
  /** Configured directory or upload directory that contains the file. */
  root: string
  /** Size in bytes at the latest scan. */
  size: number
  /** Modification time at the latest scan, in Unix epoch milliseconds. */
  mtimeMs: number
  /** Index state. */
  state: KnowledgeFileState
  /** Indexed chunks. */
  chunks: number
  /** Whether the file lives in the upload directory and can be removed from the browser. */
  uploaded: boolean
  /** Extraction failure. */
  error?: string
}

/** One page of indexed files. */
export interface KnowledgeFilePage {
  /** Files sorted by path. */
  files: KnowledgeFileEntry[]
  /** Whether more files exist than the configured listing limit returned. */
  truncated: boolean
}

/** One search over selected knowledge bases. */
export interface KnowledgeSearchRequest {
  /** Natural-language or keyword query. */
  query: string
  /** Bases to search; empty searches every knowledge base. */
  knowledgeBaseIds: KnowledgeBaseId[]
  /** Maximum hits; the Host clamps it to the configured bound. */
  limit: number
}

/** Ranking signal that contributed a hit. */
export type KnowledgeMatchSignal = 'bm25' | 'vector'

/** One retrieved chunk. */
export interface KnowledgeSearchHit {
  /** Owning knowledge base. */
  knowledgeBaseId: KnowledgeBaseId
  /** Owning knowledge base name at search time. */
  knowledgeBaseName: string
  /** Absolute Host path of the source file. */
  path: string
  /** Nearest Markdown heading or document part. */
  heading?: string
  /** One-based first line of the chunk in the extracted text. */
  lineStart: number
  /** Chunk text, bounded by the configured hit length. */
  text: string
  /** Fused reciprocal-rank score; higher ranks first. */
  score: number
  /** Signals that ranked this chunk. */
  matchedBy: KnowledgeMatchSignal[]
}

/** One searched knowledge base and its index phase at search time. */
export interface KnowledgeSearchedBase {
  /** Searched base. */
  id: KnowledgeBaseId
  /** Name at search time. */
  name: string
  /** Index phase at search time; anything but `ready` may return partial results. */
  phase: KnowledgeIndexPhase
}

/** Ranked hits of one search. */
export interface KnowledgeSearchResult {
  /** Hits in rank order. */
  hits: KnowledgeSearchHit[]
  /** Bases the search read. */
  searched: KnowledgeSearchedBase[]
  /** Retrieval mode applied. */
  mode: KnowledgeRetrievalMode
}

/** One `@` menu candidate carrying the canonical prompt mention. */
export interface KnowledgeMentionCandidate {
  /** Referenced base. */
  id: KnowledgeBaseId
  /** User-facing name. */
  name: string
  /** Indexed files. */
  indexedFiles: number
  /** Index phase. */
  phase: KnowledgeIndexPhase
  /** Canonical `@[name](dsh-knowledge:id)` text inserted into the draft. */
  mention: string
}
