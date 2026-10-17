/**
 * One knowledge base's derived index in a single `node:sqlite` file: file
 * fingerprints, text chunks, an FTS5 `trigram` table for BM25, and int8
 * vectors keyed by chunk-text hash and embedder id. The schema is versioned
 * with a monotonic `PRAGMA user_version`; any other version is derived data
 * and is rebuilt from the source files.
 */

import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { TextChunk } from './chunk.ts'
import type { QuantizedVector } from './embedding.ts'
import { likePattern } from './query.ts'
import type { KnowledgeFileState } from './types.ts'

/** Current index schema version. */
export const KNOWLEDGE_INDEX_SCHEMA_VERSION = 1

const SCHEMA = `
CREATE TABLE files(
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  root TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  content_hash TEXT,
  state TEXT NOT NULL,
  error TEXT,
  chunks INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE chunks(
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL,
  ord INTEGER NOT NULL,
  heading TEXT,
  line_start INTEGER NOT NULL,
  text TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX chunks_file ON chunks(file_id);
CREATE INDEX chunks_hash ON chunks(hash);
CREATE VIRTUAL TABLE chunks_fts USING fts5(text, heading, tokenize = 'trigram');
CREATE TABLE vectors(
  hash TEXT NOT NULL,
  model TEXT NOT NULL,
  scale REAL NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY(hash, model)
);
`

/** One stored file fingerprint. */
export interface FileRow {
  readonly id: number
  readonly path: string
  readonly root: string
  readonly size: number
  readonly mtimeMs: number
  readonly contentHash: string | null
  readonly state: KnowledgeFileState
  readonly error: string | null
  readonly chunks: number
}

/** One stored chunk with its file path. */
export interface ChunkRow {
  readonly id: number
  readonly path: string
  readonly heading: string | null
  readonly lineStart: number
  readonly text: string
  readonly hash: string
}

/** Aggregate counts of one index. */
export interface IndexCounts {
  readonly totalFiles: number
  readonly indexedFiles: number
  readonly failedFiles: number
  readonly chunkCount: number
  readonly vectorCount: number
}

/** One ranked chunk id from a lexical signal. */
export type LexicalHit = {
  readonly id: number
  readonly hash: string
}

type RawFileRow = {
  id: number
  path: string
  root: string
  size: number
  mtime_ms: number
  content_hash: string | null
  state: KnowledgeFileState
  error: string | null
  chunks: number
}

function fileRow(row: RawFileRow): FileRow {
  return {
    id: row.id, path: row.path, root: row.root, size: row.size, mtimeMs: row.mtime_ms,
    contentHash: row.content_hash, state: row.state, error: row.error, chunks: row.chunks,
  }
}

/** Synchronous accessor over one open index file. */
export class KnowledgeIndexStore {
  private constructor(private readonly db: DatabaseSync) {}

  /**
   * Open or create an index file, rebuilding it when its schema version differs.
   * @param path - database file path, or `:memory:`.
   * @returns the open index.
   */
  static async open(path: string): Promise<KnowledgeIndexStore> {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path)
    try {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF;')
      const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
      if (version !== KNOWLEDGE_INDEX_SCHEMA_VERSION) {
        const tables = db.prepare(`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'chunks_fts_%'`).all() as { name: string }[]
        for (const { name } of tables) db.exec(`DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}"`)
        db.exec(SCHEMA)
        db.exec(`PRAGMA user_version = ${KNOWLEDGE_INDEX_SCHEMA_VERSION}`)
      }
    } catch (error) {
      db.close()
      throw error
    }
    return new KnowledgeIndexStore(db)
  }

  /** Close the database file. */
  close(): void {
    if (this.db.isOpen) this.db.close()
  }

  /**
   * Read every stored file fingerprint.
   * @returns rows keyed by path.
   */
  files(): Map<string, FileRow> {
    const rows = this.db.prepare('SELECT * FROM files').all() as RawFileRow[]
    return new Map(rows.map(row => [row.path, fileRow(row)]))
  }

  /**
   * List stored files by path.
   * @param limit - maximum rows.
   * @returns rows sorted by path.
   */
  listFiles(limit: number): FileRow[] {
    return (this.db.prepare('SELECT * FROM files ORDER BY path LIMIT ?').all(limit) as RawFileRow[]).map(fileRow)
  }

  /**
   * Insert or update a file fingerprint in the pending state.
   * @param path - absolute file path.
   * @param root - containing configured or upload directory.
   * @param size - size in bytes.
   * @param mtimeMs - modification time.
   * @returns the file row id.
   */
  upsertPending(path: string, root: string, size: number, mtimeMs: number): number {
    const row = this.db.prepare(`
      INSERT INTO files(path, root, size, mtime_ms, state) VALUES (?, ?, ?, ?, 'pending')
      ON CONFLICT(path) DO UPDATE SET root = excluded.root, size = excluded.size, mtime_ms = excluded.mtime_ms, state = 'pending', error = NULL
      RETURNING id`).get(path, root, size, Math.trunc(mtimeMs)) as { id: number }
    return row.id
  }

  /**
   * Mark a file indexed without rewriting chunks because its text is unchanged.
   * @param id - file row id.
   */
  markUnchanged(id: number): void {
    this.db.prepare(`
      UPDATE files SET state = 'indexed', error = NULL WHERE id = ?`).run(id)
  }

  /**
   * Replace a file's chunks and full-text rows in one transaction.
   * @param id - file row id.
   * @param contentHash - hash of the complete extracted text.
   * @param chunks - new chunks with their text hashes.
   */
  replaceChunks(id: number, contentHash: string, chunks: readonly (TextChunk & { hash: string })[]): void {
    this.transaction(() => {
      this.deleteChunks(id)
      const insertChunk = this.db.prepare('INSERT INTO chunks(file_id, ord, heading, line_start, text, hash) VALUES (?, ?, ?, ?, ?, ?)')
      const insertText = this.db.prepare('INSERT INTO chunks_fts(rowid, text, heading) VALUES (?, ?, ?)')
      for (const [ord, chunk] of chunks.entries()) {
        const { lastInsertRowid } = insertChunk.run(id, ord, chunk.heading ?? null, chunk.lineStart, chunk.text, chunk.hash)
        insertText.run(lastInsertRowid, chunk.text, chunk.heading ?? '')
      }
      this.db.prepare(`
        UPDATE files SET state = 'indexed', error = NULL, content_hash = ?, chunks = ? WHERE id = ?`).run(contentHash, chunks.length, id)
    })
  }

  /**
   * Record an extraction failure and drop the file's previous chunks.
   * @param id - file row id.
   * @param error - failure message.
   */
  markFailed(id: number, error: string): void {
    this.transaction(() => {
      this.deleteChunks(id)
      this.db.prepare(`
        UPDATE files SET state = 'failed', error = ?, content_hash = NULL, chunks = 0 WHERE id = ?`).run(error, id)
    })
  }

  /**
   * Remove files and their chunks.
   * @param ids - file row ids.
   */
  removeFiles(ids: readonly number[]): void {
    if (ids.length === 0) return
    this.transaction(() => {
      for (const id of ids) {
        this.deleteChunks(id)
        this.db.prepare('DELETE FROM files WHERE id = ?').run(id)
      }
    })
  }

  /** Delete vectors that no chunk references. */
  pruneVectors(): void {
    this.db.exec('DELETE FROM vectors WHERE hash NOT IN (SELECT hash FROM chunks)')
  }

  /**
   * Count files, chunks, and vectors.
   * @param model - embedder id whose vectors are counted, or undefined for none.
   * @returns aggregate counts.
   */
  counts(model: string | undefined): IndexCounts {
    const files = this.db.prepare(`
      SELECT COUNT(*) AS total, SUM(state = 'indexed') AS indexed, SUM(state = 'failed') AS failed FROM files`).get() as { total: number; indexed: number | null; failed: number | null }
    const { chunks } = this.db.prepare('SELECT COUNT(*) AS chunks FROM chunks').get() as { chunks: number }
    const vectors = model === undefined
      ? 0
      : (this.db.prepare('SELECT COUNT(*) AS n FROM chunks c JOIN vectors v ON v.hash = c.hash AND v.model = ?').get(model) as { n: number }).n
    return {
      totalFiles: files.total, indexedFiles: files.indexed ?? 0, failedFiles: files.failed ?? 0, chunkCount: chunks, vectorCount: vectors,
    }
  }

  /**
   * Rank chunks by FTS5 BM25.
   * @param expression - FTS5 MATCH expression.
   * @param limit - maximum hits.
   * @returns chunk ids, best first.
   */
  bm25(expression: string, limit: number): LexicalHit[] {
    return this.db.prepare(`
      SELECT f.rowid AS id, c.hash AS hash FROM chunks_fts f JOIN chunks c ON c.id = f.rowid
      WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts, 1.0, 0.5) LIMIT ?`).all(expression, limit) as LexicalHit[]
  }

  /**
   * Rank chunks by how many short terms they contain, by substring scan.
   * @param terms - one- and two-character terms.
   * @param limit - maximum hits.
   * @returns chunk ids, most matched terms first.
   */
  substring(terms: readonly string[], limit: number): LexicalHit[] {
    if (terms.length === 0) return []
    const score = terms.map(() => '(c.text LIKE ? ESCAPE \'\\\')').join(' + ')
    const params: SQLInputValue[] = [...terms.map(likePattern), limit]
    return this.db.prepare(`
      SELECT id, hash FROM (SELECT c.id AS id, c.hash AS hash, ${score} AS matched FROM chunks c)
      WHERE matched > 0 ORDER BY matched DESC, id LIMIT ?`).all(...params) as LexicalHit[]
  }

  /**
   * Read chunks with their file paths.
   * @param ids - chunk ids.
   * @returns rows keyed by chunk id.
   */
  chunks(ids: readonly number[]): Map<number, ChunkRow> {
    const result = new Map<number, ChunkRow>()
    const statement = this.db.prepare(`
      SELECT c.id AS id, f.path AS path, c.heading AS heading, c.line_start AS lineStart, c.text AS text, c.hash AS hash
      FROM chunks c JOIN files f ON f.id = c.file_id WHERE c.id = ?`)
    for (const id of ids) {
      const row = statement.get(id) as ChunkRow | undefined
      if (row !== undefined) result.set(id, row)
    }
    return result
  }

  /**
   * Distinct chunk texts that lack a vector for the embedder.
   * @param model - embedder id.
   * @param limit - maximum rows.
   * @returns hash and text pairs.
   */
  missingVectors(model: string, limit: number): { hash: string; text: string }[] {
    return this.db.prepare(`
      SELECT c.hash AS hash, MIN(c.text) AS text FROM chunks c
      LEFT JOIN vectors v ON v.hash = c.hash AND v.model = ? WHERE v.hash IS NULL GROUP BY c.hash LIMIT ?`).all(model, limit) as { hash: string; text: string }[]
  }

  /**
   * Read stored vectors.
   * @param model - embedder id.
   * @param hashes - chunk-text hashes, or undefined for every stored vector of the embedder.
   * @returns vectors keyed by hash.
   */
  vectors(model: string, hashes?: readonly string[]): Map<string, QuantizedVector> {
    const result = new Map<string, QuantizedVector>()
    const add = (row: { hash: string; scale: number; data: Uint8Array }): void => {
      result.set(row.hash, { scale: row.scale, data: new Int8Array(row.data.buffer, row.data.byteOffset, row.data.byteLength) })
    }
    if (hashes === undefined) {
      for (const row of this.db.prepare(`
        SELECT v.hash AS hash, v.scale AS scale, v.data AS data FROM vectors v
        WHERE v.model = ? AND v.hash IN (SELECT hash FROM chunks)`).all(model) as { hash: string; scale: number; data: Uint8Array }[]) add(row)
      return result
    }
    const statement = this.db.prepare('SELECT hash, scale, data FROM vectors WHERE model = ? AND hash = ?')
    for (const hash of hashes) {
      const row = statement.get(model, hash) as { hash: string; scale: number; data: Uint8Array } | undefined
      if (row !== undefined) add(row)
    }
    return result
  }

  /**
   * Chunk ids that carry the given text hashes.
   * @param hashes - chunk-text hashes in rank order.
   * @returns chunk ids grouped in hash order, ascending within one hash.
   */
  chunkIdsByHash(hashes: readonly string[]): number[] {
    const statement = this.db.prepare('SELECT id FROM chunks WHERE hash = ? ORDER BY id')
    return hashes.flatMap(hash => (statement.all(hash) as { id: number }[]).map(row => row.id))
  }

  /**
   * Store vectors.
   * @param model - embedder id.
   * @param entries - hash and vector pairs.
   */
  putVectors(model: string, entries: readonly { hash: string; vector: QuantizedVector }[]): void {
    if (entries.length === 0) return
    this.transaction(() => {
      const statement = this.db.prepare('INSERT OR REPLACE INTO vectors(hash, model, scale, data) VALUES (?, ?, ?, ?)')
      for (const { hash, vector } of entries) {
        statement.run(hash, model, vector.scale, new Uint8Array(vector.data.buffer, vector.data.byteOffset, vector.data.byteLength))
      }
    })
  }

  private deleteChunks(fileId: number): void {
    this.db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE file_id = ?)').run(fileId)
    this.db.prepare('DELETE FROM chunks WHERE file_id = ?').run(fileId)
  }

  private transaction(work: () => void): void {
    this.db.exec('BEGIN')
    try {
      work()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
