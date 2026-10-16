import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SYSTEM_CONNECTION, readSystemConnection, validateSystemConnection, writeSystemConnection } from '../src/system-connection.ts'

let userData: string
beforeEach(async () => { userData = await mkdtemp(join(tmpdir(), 'dsh-system-connection-')) })
afterEach(async () => { await rm(userData, { recursive: true, force: true }) })

describe('system connection', () => {
  it('reads the defaults before anything is saved', async () => {
    expect(await readSystemConnection(userData)).toEqual({ systemUrl: 'http://127.0.0.1:9999', authCode: '' })
  })

  it('writes an owner-only document and reads it back', async () => {
    await writeSystemConnection(userData, { systemUrl: 'https://kaifang.example.test', authCode: 'code' })
    const path = join(userData, 'desktop', 'system-connection.json')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ systemUrl: 'https://kaifang.example.test', authCode: 'code' })
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readSystemConnection(userData)).toEqual({ systemUrl: 'https://kaifang.example.test', authCode: 'code' })
  })

  it('falls back to the defaults for an invalid saved document', async () => {
    await mkdir(join(userData, 'desktop'), { recursive: true })
    await writeFile(join(userData, 'desktop', 'system-connection.json'), '{"systemUrl":"ftp://x","authCode":"c"}')
    expect(await readSystemConnection(userData)).toBe(DEFAULT_SYSTEM_CONNECTION)
  })

  it.each([
    [{ systemUrl: ' ', authCode: 'c' }, 'url-required'],
    [{ systemUrl: 'not a url', authCode: 'c' }, 'url-invalid'],
    [{ systemUrl: 'file:///etc', authCode: 'c' }, 'url-invalid'],
    [{ systemUrl: 'http://a.test', authCode: '' }, 'auth-code-required'],
    [null, 'url-required'],
  ])('rejects %j as %s', (value, reason) => {
    expect(validateSystemConnection(value)).toEqual({ ok: false, reason })
  })
})
