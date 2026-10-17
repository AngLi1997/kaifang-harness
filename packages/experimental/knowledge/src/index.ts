/**
 * Local knowledge bases (`ctx.knowledge`): named sets of Host directories plus
 * an upload directory, each indexed into its own SQLite file for BM25 search
 * and optional vector ranking. Indexing is incremental by file size and
 * modification time, runs one bounded job queue that yields between files,
 * and follows directory changes through `fs.watch`. The same service exposes
 * the `knowledge` Remote namespace for browser management and `@` mentions.
 * @module @deepseek-ai/dsh-experimental-knowledge
 */

import { createHash, randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { access, mkdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { readBases, writeBases } from './bases.ts'
import { chunkParts } from './chunk.ts'
import { ConfigSchema, validateConfig, type Config } from './config.ts'
import {
  createHashedNgramEmbedder, createOpenAiCompatibleEmbedder, quantize, similarity,
  type KnowledgeEmbedder, type QuantizedVector,
} from './embedding.ts'
import { extractText } from './extract.ts'
import { fuseRanks, type RankedList } from './fusion.ts'
import { formatKnowledgeMention } from './mention.ts'
import { matchExpression, queryTerms } from './query.ts'
import { scanRoots } from './scan.ts'
import { KnowledgeIndexStore, type ChunkRow, type FileRow } from './store-sqlite.ts'
import type {
  KnowledgeBaseDefinition, KnowledgeBaseId, KnowledgeBaseInput, KnowledgeBaseSummary, KnowledgeBaseUpdate, KnowledgeCatalog,
  KnowledgeFileEntry, KnowledgeFilePage, KnowledgeIndexStatus, KnowledgeMentionCandidate, KnowledgeSearchHit, KnowledgeSearchRequest,
  KnowledgeSearchResult, KnowledgeUploadRequest,
} from './types.ts'

export type * from './types.ts'
export type { Config, ConfigInput, EmbedderConfig, VectorizeStrategy } from './config.ts'
export { DEFAULT_EXCLUDED_DIRECTORIES, DEFAULT_EXTENSIONS } from './config.ts'
export { KNOWLEDGE_MENTION_SCHEME, formatKnowledgeMention, parseKnowledgeMentions } from './mention.ts'
export type { KnowledgeMention } from './mention.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Local knowledge base service. */
    knowledge: KnowledgeRuntime
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No knowledge base carries the id. */
    'knowledge/not-found': { readonly id: string }
    /** A name, file name, or request field is invalid. */
    'knowledge/invalid-input': { readonly field: string }
    /** Another knowledge base already uses the name. */
    'knowledge/duplicate-name': { readonly name: string }
    /** A directory is not absolute, does not exist, or is not a directory. */
    'knowledge/invalid-directory': { readonly path: string }
    /** An uploaded file's extension is not indexed or it exceeds the upload limit. */
    'knowledge/unsupported-file': { readonly fileName: string }
  }
}

/** Longest knowledge base name in UTF-16 code units. */
const MAX_NAME_LENGTH = 64

/** Minimum interval between progress notifications to observers, in milliseconds. */
const PROGRESS_INTERVAL_MS = 250

/** Mutable state of one knowledge base. */
interface BaseState {
  definition: KnowledgeBaseDefinition
  readonly directory: string
  readonly uploadDirectory: string
  status: KnowledgeIndexStatus
  store: Promise<KnowledgeIndexStore> | undefined
  job: { readonly controller: AbortController; readonly done: Promise<void> } | undefined
  queued: boolean
  dirty: boolean
  watchers: FSWatcher[]
  debounce: ReturnType<typeof setTimeout> | undefined
  /** Stored vectors of the configured embedder; cleared when the index changes. */
  vectorCache: Map<string, QuantizedVector> | undefined
  removed: boolean
}

function initialStatus(): KnowledgeIndexStatus {
  return {
    phase: 'pending', totalFiles: 0, indexedFiles: 0, failedFiles: 0, chunkCount: 0, vectorCount: 0,
    watching: false, missingDirectories: [], fileLimitReached: false,
  }
}

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    // A path that cannot be accessed is treated as free; the exclusive write below still refuses a race.
    return false
  }
}

function isInside(path: string, directory: string): boolean {
  const rel = relative(directory, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Local knowledge base registry, indexer, and retriever. */
export class KnowledgeRuntime extends TypertRemoteService {
  static inject = ['typert']
  static Config: typeof ConfigSchema = ConfigSchema

  private readonly config: Config
  private readonly embedder: KnowledgeEmbedder | undefined
  private readonly extensions: ReadonlySet<string>
  private readonly bases = new Map<KnowledgeBaseId, BaseState>()
  private readonly queue: BaseState[] = []
  private readonly observers = new Set<() => void>()
  private running = 0
  private persisting: Promise<void> = Promise.resolve()
  private notifyTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(ctx: Context, config: Config) {
    super(ctx, 'knowledge', { namespace: 'knowledge' })
    this.config = validateConfig(config)
    this.extensions = new Set(config.extensions)
    this.embedder = config.retrieval === 'bm25'
      ? undefined
      : config.embedder.provider === 'hashed-ngram'
        ? createHashedNgramEmbedder(config.embedder.dimensions)
        : createOpenAiCompatibleEmbedder(config.embedder)
    ctx.effect(() => async () => { await this.shutdown() }, 'knowledge: shutdown')
  }

  /** Load definitions and start watching and indexing every base. */
  protected async [Service.init](): Promise<void> {
    const definitions = await readBases(this.basesFile())
    for (const definition of definitions) this.adopt(definition)
    for (const state of this.bases.values()) {
      this.startWatching(state)
      this.schedule(state)
    }
  }

  /**
   * Snapshot every knowledge base.
   * @returns definitions with index status, in creation order.
   */
  list(): KnowledgeBaseSummary[] {
    return [...this.bases.values()].map(state => this.summary(state))
  }

  /**
   * Read the browser-facing catalog.
   * @returns bases and retrieval configuration.
   */
  @Remote
  catalog(): KnowledgeCatalog {
    return {
      bases: this.list(),
      retrieval: this.config.retrieval,
      ...this.embedder === undefined ? {} : { embedder: this.embedder.id },
      maxUploadBytes: this.config.maxUploadBytes,
      extensions: [...this.config.extensions],
    }
  }

  /**
   * Follow the catalog: the current snapshot, then one snapshot per change, at most every 250 ms during indexing.
   * @param signal - observation lifetime.
   * @returns complete catalog snapshots.
   */
  @Remote({ mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<KnowledgeCatalog> {
    let changed = true
    let wake: (() => void) | undefined
    const observer = (): void => {
      changed = true
      wake?.()
    }
    const onAbort = (): void => { wake?.() }
    this.observers.add(observer)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (!signal.aborted && !this.disposed) {
        if (changed) {
          changed = false
          yield this.catalog()
          continue
        }
        await new Promise<void>((resolve) => { wake = resolve })
        wake = undefined
      }
    } finally {
      this.observers.delete(observer)
      signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Create a knowledge base and start indexing it.
   * @param input - name and directories.
   * @returns the new base.
   */
  @Remote
  async create(input: KnowledgeBaseInput): Promise<KnowledgeBaseSummary> {
    const name = this.validateName(input.name, undefined)
    const directories = await this.validateDirectories(input.directories)
    const now = Date.now()
    const definition: KnowledgeBaseDefinition = {
      id: `kb_${randomUUID().replaceAll('-', '').slice(0, 12)}` as KnowledgeBaseId,
      name, directories, createdAt: now, updatedAt: now,
    }
    const state = this.adopt(definition)
    try {
      await this.persist()
    } catch (error) {
      this.bases.delete(definition.id)
      throw error
    }
    this.startWatching(state)
    this.schedule(state)
    this.notify()
    return this.summary(state)
  }

  /**
   * Rename a knowledge base or replace its directories; a directory change re-indexes it.
   * @param update - id and replacement fields.
   * @returns the updated base.
   */
  @Remote
  async update(update: KnowledgeBaseUpdate): Promise<KnowledgeBaseSummary> {
    const state = this.require(update.id)
    const name = this.validateName(update.name, update.id)
    const directories = await this.validateDirectories(update.directories)
    const previous = state.definition
    const moved = directories.join('\n') !== previous.directories.join('\n')
    state.definition = { ...previous, name, directories, updatedAt: Date.now() }
    try {
      await this.persist()
    } catch (error) {
      state.definition = previous
      throw error
    }
    if (moved) {
      this.stopWatching(state)
      this.startWatching(state)
      this.schedule(state)
    }
    this.notify()
    return this.summary(state)
  }

  /**
   * Delete a knowledge base, its index, and its uploaded files. Configured directories are untouched.
   * @param id - base to delete.
   */
  @Remote('delete')
  async remove(id: KnowledgeBaseId): Promise<void> {
    const state = this.require(id)
    this.bases.delete(id)
    try {
      await this.persist()
    } catch (error) {
      this.bases.set(id, state)
      throw error
    }
    state.removed = true
    await this.release(state)
    await rm(state.directory, { recursive: true, force: true })
    this.notify()
  }

  /**
   * Re-scan a knowledge base now.
   * @param id - base to re-index.
   */
  @Remote
  reindex(id: KnowledgeBaseId): void {
    this.schedule(this.require(id))
  }

  /**
   * List indexed files of a knowledge base.
   * @param id - base to list.
   * @returns files sorted by path, bounded by the configured listing limit.
   */
  @Remote
  async files(id: KnowledgeBaseId): Promise<KnowledgeFilePage> {
    const state = this.require(id)
    const rows = (await this.storeOf(state)).listFiles(this.config.maxListedFiles + 1)
    return {
      files: rows.slice(0, this.config.maxListedFiles).map(row => this.fileEntry(state, row)),
      truncated: rows.length > this.config.maxListedFiles,
    }
  }

  /**
   * Copy one browser file into a knowledge base's upload directory and index it.
   * @param request - target base, file name, and base64 content.
   * @returns the stored file, pending indexing.
   */
  @Remote
  async upload(request: KnowledgeUploadRequest): Promise<KnowledgeFileEntry> {
    const state = this.require(request.id)
    const fileName = basename(request.fileName.replace(/\\/gu, '/')).replace(/[\u0000-\u001f]/gu, '').trim()
    if (fileName === '' || fileName.startsWith('.')) {
      throw new RemoteError('knowledge/invalid-input', 'File name is empty or hidden', { field: 'fileName' })
    }
    const extension = extname(fileName).toLowerCase()
    const encoded = request.contentBase64
    if (!this.extensions.has(extension) || encoded.length > Math.ceil(this.config.maxUploadBytes / 3) * 4) {
      throw new RemoteError('knowledge/unsupported-file', `${fileName} is not an indexed file type or exceeds the upload limit`, { fileName })
    }
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.toString('base64') !== encoded) {
      throw new RemoteError('knowledge/invalid-input', 'File content is not canonical base64', { field: 'contentBase64' })
    }
    if (bytes.length > this.config.maxUploadBytes) {
      throw new RemoteError('knowledge/unsupported-file', `${fileName} exceeds the upload limit`, { fileName })
    }
    await mkdir(state.uploadDirectory, { recursive: true })
    const stem = fileName.slice(0, fileName.length - extension.length)
    let path = join(state.uploadDirectory, fileName)
    for (let suffix = 1; await exists(path); suffix += 1) path = join(state.uploadDirectory, `${stem} (${suffix})${extension}`)
    // A concurrent writer that takes the same free name makes this write fail rather than overwrite.
    await writeFile(path, bytes, { flag: 'wx' })
    this.schedule(state)
    const info = await stat(path)
    return {
      path, root: state.uploadDirectory, size: info.size, mtimeMs: Math.trunc(info.mtimeMs),
      state: 'pending', chunks: 0, uploaded: true,
    }
  }

  /**
   * Delete an uploaded file and drop it from the index.
   * @param id - owning base.
   * @param path - absolute path inside the base's upload directory.
   */
  @Remote
  async deleteUpload(id: KnowledgeBaseId, path: string): Promise<void> {
    const state = this.require(id)
    const target = resolve(path)
    if (!isInside(target, state.uploadDirectory)) {
      throw new RemoteError('knowledge/invalid-input', 'Only uploaded files can be deleted', { field: 'path' })
    }
    await unlink(target)
    this.schedule(state)
  }

  /**
   * Search knowledge bases. Bases that are still indexing return what is indexed so far.
   * @param request - query, bases, and hit limit.
   * @param signal - cancellation.
   * @returns ranked hits and the searched bases.
   */
  @Remote
  async search(request: KnowledgeSearchRequest, signal: AbortSignal): Promise<KnowledgeSearchResult> {
    const states = request.knowledgeBaseIds.length === 0
      ? [...this.bases.values()]
      : [...new Set(request.knowledgeBaseIds)].map(id => this.require(id))
    const limit = Math.max(1, Math.min(Math.trunc(request.limit), this.config.maxSearchLimit))
    const searched = states.map(state => ({ id: state.definition.id, name: state.definition.name, phase: state.status.phase }))
    const query = request.query.trim()
    if (query === '') throw new RemoteError('knowledge/invalid-input', 'Query is empty', { field: 'query' })
    const terms = queryTerms(query, this.config.maxQueryTerms)
    const expression = matchExpression(terms.indexed)
    const queryVector = this.embedder === undefined
      ? undefined
      : quantize((await this.embedder.embed([query], signal))[0] as Float32Array)
    const lists: RankedList[] = []
    const keyed = new Map<string, { state: BaseState; chunkId: number }>()
    const key = (state: BaseState, chunkId: number): string => {
      const value = `${state.definition.id}:${chunkId}`
      keyed.set(value, { state, chunkId })
      return value
    }
    for (const state of states) {
      signal.throwIfAborted()
      const store = await this.storeOf(state)
      const lexical = [
        ...expression === undefined ? [] : [store.bm25(expression, this.config.candidatePool)],
        store.substring(terms.short, this.config.candidatePool),
      ]
      for (const hits of lexical) lists.push({ signal: 'bm25', keys: hits.map(hit => key(state, hit.id)) })
      if (queryVector !== undefined && this.embedder !== undefined) {
        const candidates = lexical.flat()
        const ranked = await this.rankVectors(state, store, this.embedder, queryVector, candidates, signal)
        lists.push({ signal: 'vector', keys: ranked.map(chunkId => key(state, chunkId)) })
      }
    }
    const fused = fuseRanks(lists, this.config.fusionK).slice(0, limit)
      .map(item => ({ ...item, ...keyed.get(item.key) as { state: BaseState; chunkId: number } }))
    const rows = new Map<BaseState, Map<number, ChunkRow>>()
    for (const state of new Set(fused.map(item => item.state))) {
      const ids = fused.filter(item => item.state === state).map(item => item.chunkId)
      rows.set(state, (await this.storeOf(state)).chunks(ids))
    }
    const hits: KnowledgeSearchHit[] = fused.flatMap((item) => {
      const { state, chunkId } = item
      const row = rows.get(state)?.get(chunkId)
      /* v8 ignore next -- indexing can delete a ranked chunk while the query vector is computed; the hit is then dropped */
      if (row === undefined) return []
      const text = row.text.length > this.config.maxHitChars ? `${row.text.slice(0, this.config.maxHitChars)}…` : row.text
      return [{
        knowledgeBaseId: state.definition.id,
        knowledgeBaseName: state.definition.name,
        path: row.path,
        ...row.heading === null || row.heading === '' ? {} : { heading: row.heading },
        lineStart: row.lineStart,
        text,
        score: item.score,
        matchedBy: item.signals,
      }]
    })
    return { hits, searched, mode: this.config.retrieval }
  }

  /**
   * List `@` menu candidates whose name contains the query.
   * @param query - case-insensitive name substring; empty lists every base.
   * @param signal - caller cancellation.
   * @returns candidates with canonical mentions, bounded by the configured limit.
   */
  @Remote
  candidates(query: string, signal: AbortSignal): KnowledgeMentionCandidate[] {
    signal.throwIfAborted()
    const needle = query.trim().toLocaleLowerCase()
    return [...this.bases.values()]
      .filter(state => needle === '' || state.definition.name.toLocaleLowerCase().includes(needle))
      .slice(0, this.config.candidateLimit)
      .map(state => ({
        id: state.definition.id,
        name: state.definition.name,
        indexedFiles: state.status.indexedFiles,
        phase: state.status.phase,
        mention: formatKnowledgeMention(state.definition.id, state.definition.name),
      }))
  }

  private basesFile(): string {
    return join(this.config.dataRoot, 'bases.json')
  }

  private adopt(definition: KnowledgeBaseDefinition): BaseState {
    const directory = join(this.config.dataRoot, 'bases', definition.id)
    const state: BaseState = {
      definition, directory, uploadDirectory: join(directory, 'files'), status: initialStatus(),
      store: undefined, job: undefined, queued: false, dirty: false, watchers: [], debounce: undefined,
      vectorCache: undefined, removed: false,
    }
    this.bases.set(definition.id, state)
    return state
  }

  private require(id: KnowledgeBaseId): BaseState {
    const state = this.bases.get(id)
    if (state === undefined) throw new RemoteError('knowledge/not-found', `No knowledge base ${JSON.stringify(id)}`, { id })
    return state
  }

  private summary(state: BaseState): KnowledgeBaseSummary {
    return {
      ...state.definition,
      directories: [...state.definition.directories],
      mention: formatKnowledgeMention(state.definition.id, state.definition.name),
      uploadDirectory: state.uploadDirectory,
      status: { ...state.status, missingDirectories: [...state.status.missingDirectories] },
    }
  }

  private fileEntry(state: BaseState, row: FileRow): KnowledgeFileEntry {
    return {
      path: row.path, root: row.root, size: row.size, mtimeMs: row.mtimeMs, state: row.state, chunks: row.chunks,
      uploaded: isInside(row.path, state.uploadDirectory),
      ...row.error === null ? {} : { error: row.error },
    }
  }

  private validateName(raw: string, self: KnowledgeBaseId | undefined): string {
    const name = raw.trim()
    if (name === '' || name.length > MAX_NAME_LENGTH || /[\r\n]/u.test(name)) {
      throw new RemoteError('knowledge/invalid-input', `Name must be 1 to ${MAX_NAME_LENGTH} characters on one line`, { field: 'name' })
    }
    const folded = name.toLocaleLowerCase()
    for (const state of this.bases.values()) {
      if (state.definition.id !== self && state.definition.name.toLocaleLowerCase() === folded) {
        throw new RemoteError('knowledge/duplicate-name', `A knowledge base named ${JSON.stringify(name)} already exists`, { name })
      }
    }
    return name
  }

  private async validateDirectories(raw: readonly string[]): Promise<string[]> {
    const directories: string[] = []
    for (const entry of raw) {
      const path = entry.trim()
      if (!isAbsolute(path)) throw new RemoteError('knowledge/invalid-directory', `${path} is not an absolute path`, { path })
      const normalized = resolve(path)
      let directory = false
      try {
        directory = (await stat(normalized)).isDirectory()
      } catch {
        // A path that cannot be stat'ed is rejected below as not a directory.
      }
      if (!directory) throw new RemoteError('knowledge/invalid-directory', `${normalized} is not a directory`, { path: normalized })
      if (normalized === resolve(this.config.dataRoot) || isInside(normalized, resolve(this.config.dataRoot))) {
        throw new RemoteError('knowledge/invalid-directory', `${normalized} is inside the knowledge data directory`, { path: normalized })
      }
      if (!directories.includes(normalized)) directories.push(normalized)
    }
    return directories
  }

  private async persist(): Promise<void> {
    const definitions = [...this.bases.values()].map(state => state.definition)
    const write = this.persisting.then(() => writeBases(this.basesFile(), definitions))
    this.persisting = write.catch(() => {
      // The failure is reported to the caller that awaited `write`; later writes still run.
    })
    await write
  }

  private storeOf(state: BaseState): Promise<KnowledgeIndexStore> {
    if (state.store === undefined) {
      state.store = (async () => {
        await mkdir(state.directory, { recursive: true, mode: 0o700 })
        return await KnowledgeIndexStore.open(join(state.directory, 'index.sqlite'))
      })()
      state.store.catch(() => { state.store = undefined })
    }
    return state.store
  }

  private notify(): void {
    if (this.notifyTimer !== undefined) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined
      for (const observer of this.observers) observer()
    }, 0)
  }

  private progress(state: BaseState, store: KnowledgeIndexStore, last: { at: number }): void {
    const now = Date.now()
    if (now - last.at < PROGRESS_INTERVAL_MS) return
    last.at = now
    this.refreshCounts(state, store)
    this.notify()
  }

  private refreshCounts(state: BaseState, store: KnowledgeIndexStore): void {
    const counts = store.counts(this.embedder?.id)
    state.status = { ...state.status, ...counts }
  }

  private yieldTurn(): Promise<void> {
    const delay = this.config.indexYieldMs
    return new Promise(resolve => delay === 0 ? setImmediate(resolve) : setTimeout(resolve, delay))
  }

  private schedule(state: BaseState): void {
    if (this.disposed || state.removed) return
    if (state.job !== undefined) {
      state.dirty = true
      return
    }
    if (state.queued) return
    state.queued = true
    this.queue.push(state)
    this.pump()
  }

  private pump(): void {
    while (this.running < this.config.concurrentIndexJobs && this.queue.length > 0) {
      const state = this.queue.shift() as BaseState
      state.queued = false
      if (state.removed) continue
      const controller = new AbortController()
      this.running += 1
      const done = this.runIndex(state, controller.signal).finally(() => {
        this.running -= 1
        state.job = undefined
        if (state.dirty) {
          state.dirty = false
          this.schedule(state)
        }
        this.pump()
      })
      state.job = { controller, done }
    }
  }

  private async runIndex(state: BaseState, signal: AbortSignal): Promise<void> {
    const last = { at: 0 }
    try {
      state.status = { ...state.status, phase: 'scanning' }
      delete state.status.error
      this.notify()
      const store = await this.storeOf(state)
      await mkdir(state.uploadDirectory, { recursive: true })
      const scan = await scanRoots([...state.definition.directories, state.uploadDirectory], {
        extensions: this.extensions,
        excludedDirectories: new Set(this.config.excludedDirectories),
        maxFileBytes: this.config.maxFileBytes,
        maxFiles: this.config.maxFilesPerBase,
      }, signal, () => this.yieldTurn())
      const existing = store.files()
      const removed = [...existing.values()].filter(row => !scan.files.has(row.path)).map(row => row.id)
      store.removeFiles(removed)
      const changed = [...scan.files.entries()].filter(([path, file]) => {
        const row = existing.get(path)
        return row === undefined || row.state === 'pending' || row.size !== file.size || row.mtimeMs !== file.mtimeMs || row.root !== file.root
      })
      if (removed.length > 0 || changed.length > 0) state.vectorCache = undefined
      state.status = {
        ...state.status, phase: 'indexing', missingDirectories: scan.missing.filter(path => path !== state.uploadDirectory),
        fileLimitReached: scan.limitReached,
      }
      this.refreshCounts(state, store)
      this.notify()
      for (const [path, file] of changed) {
        signal.throwIfAborted()
        await this.indexFile(store, path, file.root, file.size, file.mtimeMs, existing.get(path)?.contentHash ?? null)
        this.progress(state, store, last)
        await this.yieldTurn()
      }
      if (removed.length > 0 || changed.length > 0) store.pruneVectors()
      if (this.embedder !== undefined && this.config.vectorize === 'eager') {
        state.status = { ...state.status, phase: 'embedding' }
        this.notify()
        await this.embedMissing(state, store, this.embedder, signal, last)
      }
      this.refreshCounts(state, store)
      state.status = { ...state.status, phase: 'ready', indexedAt: Date.now() }
    } catch (error) {
      if (signal.aborted) return
      state.status = { ...state.status, phase: 'error', error: errorMessage(error) }
    } finally {
      this.notify()
    }
  }

  private async indexFile(
    store: KnowledgeIndexStore, path: string, root: string, size: number, mtimeMs: number, previousHash: string | null,
  ): Promise<void> {
    const id = store.upsertPending(path, root, size, mtimeMs)
    let parts
    try {
      parts = await extractText(path)
    } catch (error) {
      store.markFailed(id, errorMessage(error))
      return
    }
    const contentHash = sha1(parts.map(part => `${part.label ?? ''}\u0000${part.text}`).join('\u0001'))
    if (contentHash === previousHash) {
      store.markUnchanged(id)
      return
    }
    const chunks = chunkParts(parts, { chunkChars: this.config.chunkChars, overlapChars: this.config.chunkOverlapChars })
    store.replaceChunks(id, contentHash, chunks.map(chunk => ({ ...chunk, hash: sha1(chunk.text) })))
  }

  private async embedMissing(
    state: BaseState, store: KnowledgeIndexStore, embedder: KnowledgeEmbedder, signal: AbortSignal, last: { at: number },
  ): Promise<void> {
    for (;;) {
      signal.throwIfAborted()
      const missing = store.missingVectors(embedder.id, this.config.embedBatchSize)
      if (missing.length === 0) return
      const vectors = await embedder.embed(missing.map(item => item.text), signal)
      store.putVectors(embedder.id, missing.map((item, index) => ({ hash: item.hash, vector: quantize(vectors[index] as Float32Array) })))
      state.vectorCache = undefined
      this.progress(state, store, last)
      await this.yieldTurn()
    }
  }

  /**
   * Rank chunks by vector similarity. Eager mode scans every stored vector; on-demand mode also
   * vectorizes lexical candidates that have none and stores the result for later searches.
   */
  private async rankVectors(
    state: BaseState, store: KnowledgeIndexStore, embedder: KnowledgeEmbedder, query: QuantizedVector,
    candidates: readonly { id: number; hash: string }[], signal: AbortSignal,
  ): Promise<number[]> {
    state.vectorCache ??= store.vectors(embedder.id)
    const cache = state.vectorCache
    if (this.config.vectorize === 'on-demand') {
      const missing = [...new Set(candidates.map(candidate => candidate.hash))].filter(hash => !cache.has(hash))
      if (missing.length > 0) {
        const texts = store.chunks(candidates.filter(candidate => missing.includes(candidate.hash)).map(candidate => candidate.id))
        const byHash = new Map([...texts.values()].map(row => [row.hash, row.text]))
        const vectors = await embedder.embed([...byHash.values()], signal)
        const entries = [...byHash.keys()].map((hash, index) => ({ hash, vector: quantize(vectors[index] as Float32Array) }))
        store.putVectors(embedder.id, entries)
        for (const { hash, vector } of entries) cache.set(hash, vector)
      }
    }
    const scored = [...cache.entries()]
      .map(([hash, vector]) => ({ hash, score: similarity(query, vector) }))
      .filter(item => item.score >= this.config.minVectorSimilarity)
      .sort((left, right) => right.score - left.score)
      .slice(0, this.config.candidatePool)
    return store.chunkIdsByHash(scored.map(item => item.hash))
  }

  private startWatching(state: BaseState): void {
    if (!this.config.watch) return
    for (const root of [...state.definition.directories, state.uploadDirectory]) {
      try {
        const watcher = watch(root, { recursive: true, persistent: false }, (_event, file) => {
          if (typeof file === 'string' && file.split(sep).some(part => part.startsWith('.'))) return
          clearTimeout(state.debounce)
          state.debounce = setTimeout(() => {
            state.debounce = undefined
            this.schedule(state)
          }, this.config.watchDebounceMs)
        })
        watcher.on('error', () => {
          watcher.close()
          state.watchers = state.watchers.filter(item => item !== watcher)
          state.status = { ...state.status, watching: state.watchers.length > 0 }
          this.notify()
        })
        state.watchers.push(watcher)
      } catch {
        // A root that cannot be watched (missing, or unsupported by the platform) is still indexed by explicit scans.
      }
    }
    state.status = { ...state.status, watching: state.watchers.length > 0 }
  }

  private stopWatching(state: BaseState): void {
    clearTimeout(state.debounce)
    state.debounce = undefined
    for (const watcher of state.watchers) watcher.close()
    state.watchers = []
    state.status = { ...state.status, watching: false }
  }

  private async release(state: BaseState): Promise<void> {
    this.stopWatching(state)
    const job = state.job
    if (job !== undefined) {
      job.controller.abort()
      await job.done
    }
    const store = state.store
    state.store = undefined
    // storeOf() resets a failed open before any release reads it, so a held promise resolves.
    if (store !== undefined) (await store).close()
  }

  private async shutdown(): Promise<void> {
    this.disposed = true
    clearTimeout(this.notifyTimer)
    for (const observer of this.observers) observer()
    this.queue.length = 0
    await Promise.all([...this.bases.values()].map(state => this.release(state)))
    await this.persisting
  }
}

export default KnowledgeRuntime
