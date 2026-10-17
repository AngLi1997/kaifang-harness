/**
 * Durable knowledge base definitions in `<dataRoot>/bases.json`. The file is
 * user data: an invalid file fails loading rather than being replaced.
 */

import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { KnowledgeBaseDefinition, KnowledgeBaseId } from './types.ts'

/** Current definition file format version. */
export const KNOWLEDGE_BASES_FILE_VERSION = 1

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function definition(value: unknown, index: number): KnowledgeBaseDefinition {
  if (!isRecord(value)) throw new Error(`bases[${index}] must be an object`)
  const { id, name, directories, createdAt, updatedAt } = value
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(id)) throw new Error(`bases[${index}].id must be an identifier`)
  if (typeof name !== 'string' || name.trim() === '') throw new Error(`bases[${index}].name must be a non-empty string`)
  if (!Array.isArray(directories) || !directories.every(item => typeof item === 'string')) {
    throw new Error(`bases[${index}].directories must be a string array`)
  }
  if (typeof createdAt !== 'number' || typeof updatedAt !== 'number') throw new Error(`bases[${index}] timestamps must be numbers`)
  return { id: id as KnowledgeBaseId, name, directories: [...directories], createdAt, updatedAt }
}

/**
 * Read definitions.
 * @param path - definition file path.
 * @returns definitions in stored order; empty when the file does not exist.
 * @throws when the file exists but is not a valid version-1 definition file.
 */
export async function readBases(path: string): Promise<KnowledgeBaseDefinition[]> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed) || parsed['version'] !== KNOWLEDGE_BASES_FILE_VERSION || !Array.isArray(parsed['bases'])) {
    throw new Error(`${path} is not a version ${KNOWLEDGE_BASES_FILE_VERSION} knowledge base file`)
  }
  const bases = (parsed['bases'] as unknown[]).map(definition)
  if (new Set(bases.map(base => base.id)).size !== bases.length) throw new Error(`${path} repeats a knowledge base id`)
  return bases
}

/**
 * Replace the definition file.
 * @param path - definition file path.
 * @param bases - complete definitions in order.
 */
export async function writeBases(path: string, bases: readonly KnowledgeBaseDefinition[]): Promise<void> {
  const body = JSON.stringify({ version: KNOWLEDGE_BASES_FILE_VERSION, bases }, null, 2)
  await writeFileAtomic(path, `${body}\n`, { mode: 0o600, dirMode: 0o700 })
}
