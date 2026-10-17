/** Scanning skips subdirectories that cannot be opened and files that vanish before stat. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const failing = new Set<string>()
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    opendir: (path: string) => failing.has(path) ? Promise.reject(new Error('EACCES')) : actual.opendir(path),
    stat: (path: string) => failing.has(path) ? Promise.reject(new Error('ENOENT')) : actual.stat(path),
  }
})

const { scanRoots } = await import('../src/scan.ts')
const dirs: string[] = []
afterEach(async () => {
  failing.clear()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

it('skips an unreadable subdirectory and a file that disappears', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-scan-'))
  dirs.push(root)
  await mkdir(join(root, 'locked'))
  await writeFile(join(root, 'locked', 'a.md'), 'a')
  await writeFile(join(root, 'gone.md'), 'b')
  await writeFile(join(root, 'kept.md'), 'c')
  failing.add(join(root, 'locked'))
  failing.add(join(root, 'gone.md'))
  const result = await scanRoots([root], {
    extensions: new Set(['.md']), excludedDirectories: new Set(), maxFileBytes: 10, maxFiles: 10,
  }, new AbortController().signal, async () => {})
  expect([...result.files.keys()]).toEqual([join(root, 'kept.md')])
})
