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
    expect(await readSystemConnection(userData)).toEqual({ systemUrl: 'http://127.0.0.1:9999', webUrl: 'http://localhost:5173', authCode: '' })
  })

  it('writes an owner-only document and reads it back', async () => {
    const connection = { systemUrl: 'https://kaifang.example.test', webUrl: 'https://lab.example.test', authCode: 'code' }
    await writeSystemConnection(userData, connection)
    const path = join(userData, 'desktop', 'system-connection.json')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(connection)
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readSystemConnection(userData)).toEqual(connection)
  })

  it('gives a document saved before the Web URL existed the default Web URL', async () => {
    await mkdir(join(userData, 'desktop'), { recursive: true })
    await writeFile(join(userData, 'desktop', 'system-connection.json'), '{"systemUrl":"http://a.test","authCode":"c"}')
    expect(await readSystemConnection(userData)).toEqual({ systemUrl: 'http://a.test', webUrl: 'http://localhost:5173', authCode: 'c' })
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
    [{ systemUrl: 'http://a.test', webUrl: ' ', authCode: 'c' }, 'web-url-required'],
    [{ systemUrl: 'http://a.test', webUrl: 'ftp://x', authCode: 'c' }, 'web-url-invalid'],
    [null, 'url-required'],
  ])('rejects %j as %s', (value, reason) => {
    expect(validateSystemConnection(value)).toEqual({ ok: false, reason })
  })
})
