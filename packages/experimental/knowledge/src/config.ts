/** Validated configuration of the local knowledge base service. */

import z from '@deepseek-ai/schemastery'
import type { KnowledgeRetrievalMode } from './types.ts'

/** Embedder selection for `hybrid` retrieval. */
export type EmbedderConfig =
  | {
    /** In-process hashed n-gram vectors; needs no model file or network. */
    provider: 'hashed-ngram'
    /** Vector length. */
    dimensions: number
  }
  | {
    /** An OpenAI-compatible `/embeddings` endpoint that receives chunk text. */
    provider: 'openai-compatible'
    /** Endpoint base URL, such as `http://127.0.0.1:11434/v1`. */
    baseUrl: string
    /** Model name. */
    model: string
    /** Texts per request. */
    batchSize: number
    /** Per-request timeout in milliseconds. */
    timeoutMs: number
  }

/** When chunk vectors are computed in `hybrid` mode. */
export type VectorizeStrategy = 'eager' | 'on-demand'

/** Service configuration. */
export interface Config {
  /** Directory holding `bases.json`, each base's index, and uploaded files. */
  dataRoot: string
  /** Retrieval mode for every search. */
  retrieval: KnowledgeRetrievalMode
  /** Embedder used in `hybrid` mode. */
  embedder: EmbedderConfig
  /** `eager` vectorizes every chunk after indexing; `on-demand` vectorizes BM25 candidates at query time and keeps them. */
  vectorize: VectorizeStrategy
  /** Lowercase extensions with a leading dot that the indexer reads. */
  extensions: string[]
  /** Directory base names never entered. Hidden directories are always skipped. */
  excludedDirectories: string[]
  /** Largest indexed file in bytes. */
  maxFileBytes: number
  /** Maximum files indexed per knowledge base. */
  maxFilesPerBase: number
  /** Largest file accepted by one browser upload, in bytes. */
  maxUploadBytes: number
  /** Target maximum characters per chunk. */
  chunkChars: number
  /** Trailing characters repeated at the start of the next chunk in the same section. */
  chunkOverlapChars: number
  /** Whether directory changes trigger incremental indexing. */
  watch: boolean
  /** Quiet period after the last directory change before indexing starts, in milliseconds. */
  watchDebounceMs: number
  /** Pause after each indexed file and scanned directory, in milliseconds; zero only yields to pending I/O. */
  indexYieldMs: number
  /** Chunks embedded per batch during eager vectorization. */
  embedBatchSize: number
  /** Knowledge bases indexed at the same time. */
  concurrentIndexJobs: number
  /** Candidates each ranking signal contributes before fusion. */
  candidatePool: number
  /** Upper bound on hits of one search. */
  maxSearchLimit: number
  /** Upper bound on query terms. */
  maxQueryTerms: number
  /** Minimum cosine similarity for a vector candidate. */
  minVectorSimilarity: number
  /** Reciprocal-rank fusion damping constant. */
  fusionK: number
  /** Characters of chunk text returned per hit. */
  maxHitChars: number
  /** `@` menu candidates per query. */
  candidateLimit: number
  /** Files returned by one file listing. */
  maxListedFiles: number
}

/** Config as written in cordis.yml: every field except `dataRoot` has a default. */
export type ConfigInput = Partial<Config> & Pick<Config, 'dataRoot'>

/** Extensions indexed by default. */
export const DEFAULT_EXTENSIONS = [
  '.md', '.markdown', '.txt', '.text', '.rst', '.adoc', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml', '.html', '.htm', '.log',
  '.pdf', '.docx', '.pptx', '.xlsx',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.cs', '.rb', '.php',
  '.sh', '.sql', '.kt', '.swift', '.vue',
]

/** Directory names skipped by default. */
export const DEFAULT_EXCLUDED_DIRECTORIES = ['node_modules', 'dist', 'build', 'out', 'target', 'vendor', '__pycache__', 'venv']

const EmbedderSchema: z<EmbedderConfig> = z.union([
  z.object({
    provider: z.const('hashed-ngram').required(),
    dimensions: z.natural().min(16).max(4096).default(256),
  }),
  z.object({
    provider: z.const('openai-compatible').required(),
    baseUrl: z.string().required(),
    model: z.string().required(),
    batchSize: z.natural().min(1).default(16),
    timeoutMs: z.natural().min(1).default(30_000),
  }),
])

/** Config schema with defaults sized for low-end devices. */
export const ConfigSchema: z<ConfigInput, Config> = z.object({
  dataRoot: z.string().required(),
  retrieval: z.union(['bm25', 'hybrid']).default('bm25'),
  embedder: EmbedderSchema.default({ provider: 'hashed-ngram', dimensions: 256 }),
  vectorize: z.union(['eager', 'on-demand']).default('on-demand'),
  extensions: z.array(z.string()).default(DEFAULT_EXTENSIONS),
  excludedDirectories: z.array(z.string()).default(DEFAULT_EXCLUDED_DIRECTORIES),
  maxFileBytes: z.natural().min(1).default(20 * 1024 * 1024),
  maxFilesPerBase: z.natural().min(1).default(20_000),
  maxUploadBytes: z.natural().min(1).default(25 * 1024 * 1024),
  chunkChars: z.natural().min(100).default(800),
  chunkOverlapChars: z.natural().default(120),
  watch: z.boolean().default(true),
  watchDebounceMs: z.natural().default(1500),
  indexYieldMs: z.natural().default(0),
  embedBatchSize: z.natural().min(1).default(32),
  concurrentIndexJobs: z.natural().min(1).default(1),
  candidatePool: z.natural().min(1).default(50),
  maxSearchLimit: z.natural().min(1).default(20),
  maxQueryTerms: z.natural().min(1).default(48),
  minVectorSimilarity: z.number().min(-1).max(1).default(0.2),
  fusionK: z.natural().min(1).default(60),
  maxHitChars: z.natural().min(100).default(1500),
  candidateLimit: z.natural().min(1).default(20),
  maxListedFiles: z.natural().min(1).default(2000),
})

/**
 * Reject combinations the schema cannot express.
 * @param config - schema-validated config.
 * @returns the same config.
 * @throws when an extension lacks its leading dot or the overlap is not smaller than the chunk.
 */
export function validateConfig(config: Config): Config {
  const invalid = config.extensions.find(extension => !/^\.[a-z0-9]+$/u.test(extension))
  if (invalid !== undefined) throw new Error(`knowledge: extension ${JSON.stringify(invalid)} must be lowercase with a leading dot`)
  if (config.chunkOverlapChars >= config.chunkChars) throw new Error('knowledge: chunkOverlapChars must be smaller than chunkChars')
  if (config.embedder.provider === 'openai-compatible') {
    try {
      new URL(config.embedder.baseUrl)
    } catch (error) {
      throw new Error(`knowledge: embedder.baseUrl ${JSON.stringify(config.embedder.baseUrl)} is not a URL`, { cause: error })
    }
  }
  return config
}
