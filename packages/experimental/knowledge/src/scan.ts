/**
 * Recursive discovery of indexable files. Hidden entries, excluded directory
 * names, and symbolic links are skipped, so a link cannot pull a directory
 * outside the configured roots or create a cycle.
 */

import { opendir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'

/** One discovered file. */
export interface ScannedFile {
  /** Containing root. */
  readonly root: string
  /** Size in bytes. */
  readonly size: number
  /** Modification time in Unix epoch milliseconds. */
  readonly mtimeMs: number
}

/** Discovery filters. */
export interface ScanOptions {
  /** Lowercase extensions with a leading dot. */
  readonly extensions: ReadonlySet<string>
  /** Directory base names never entered. */
  readonly excludedDirectories: ReadonlySet<string>
  /** Largest file indexed, in bytes. */
  readonly maxFileBytes: number
  /** Maximum files collected across all roots. */
  readonly maxFiles: number
}

/** Result of one scan. */
export interface ScanResult {
  /** Files keyed by absolute path. */
  readonly files: Map<string, ScannedFile>
  /** Roots that are missing or not directories. */
  readonly missing: string[]
  /** Whether collection stopped at `maxFiles`. */
  readonly limitReached: boolean
}

/**
 * Collect indexable files under every root.
 * @param roots - absolute directories in priority order.
 * @param options - filters and limits.
 * @param signal - cancellation.
 * @param yieldTurn - called between directories so the event loop keeps serving requests.
 * @returns discovered files, missing roots, and the limit flag.
 */
export async function scanRoots(
  roots: readonly string[],
  options: ScanOptions,
  signal: AbortSignal,
  yieldTurn: () => Promise<void>,
): Promise<ScanResult> {
  const files = new Map<string, ScannedFile>()
  const missing: string[] = []
  let limitReached = false
  for (const root of roots) {
    try {
      if (!(await stat(root)).isDirectory()) {
        missing.push(root)
        continue
      }
    } catch {
      // A root that cannot be stat'ed is reported as missing; the scan continues with the others.
      missing.push(root)
      continue
    }
    const pending = [root]
    while (pending.length > 0 && !limitReached) {
      signal.throwIfAborted()
      const directory = pending.pop() as string
      let handle
      try {
        handle = await opendir(directory)
      } catch {
        // An unreadable subdirectory is skipped; its files stay out of the index.
        continue
      }
      for await (const entry of handle) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
        const path = join(directory, entry.name)
        if (entry.isDirectory()) {
          if (!options.excludedDirectories.has(entry.name)) pending.push(path)
          continue
        }
        if (!entry.isFile() || !options.extensions.has(extname(entry.name).toLowerCase()) || files.has(path)) continue
        let info
        try {
          info = await stat(path)
        } catch {
          // The file vanished between listing and stat; the next scan reconciles it.
          continue
        }
        if (info.size > options.maxFileBytes) continue
        if (files.size >= options.maxFiles) {
          limitReached = true
          break
        }
        files.set(path, { root, size: info.size, mtimeMs: Math.trunc(info.mtimeMs) })
      }
      await yieldTurn()
    }
  }
  return { files, missing, limitReached }
}
