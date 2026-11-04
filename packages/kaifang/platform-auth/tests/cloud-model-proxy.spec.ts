import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { PLATFORM_MODEL_CONTEXT_WINDOW, KaifangPlatformModelAdapter } from '../src/model-provider.ts'
import {
  CloudModelProxyAdapter, decodeCloudModel, encodeCloudModel, listCloudCatalog, parseProxiedModel, readDesktopProxyTarget,
} from '../src/cloud-model-proxy.ts'

it('encodes a web catalog model without putting a base URL in the id', () => {
  const id = encodeCloudModel('openai', 'qwen3.5-9b')
  expect(id).not.toContain('http')
  expect(decodeCloudModel(id)).toEqual({ provider: 'openai', model: 'qwen3.5-9b' })
  expect(decodeCloudModel('not-encoded')).toBeUndefined()
})

it('refuses image blocks and accepts a text call aimed at the web provider', () => {
  expect(parseProxiedModel({
    provider: 'openai',
    model: 'qwen3.5-9b',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  }).ok).toBe(true)
  const media = parseProxiedModel({
    provider: 'openai',
    model: 'qwen3.5-9b',
    messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a' } }] }],
  })
  expect(media).toEqual({ ok: false, reason: 'media' })
})

it('reads the stored web origin and access token', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'dsh-cloud-proxy-'))
  await mkdir(join(userData, 'desktop'))
  await writeFile(join(userData, 'desktop', 'cloud-host.json'), JSON.stringify({ origin: 'http://127.0.0.1:3080' }))
  await writeFile(join(userData, 'desktop', 'platform-session.json'), JSON.stringify({
    accessToken: 'ticket', expiresAt: Date.now() + 60_000,
  }))
  await expect(readDesktopProxyTarget(userData)).resolves.toEqual({
    origin: 'http://127.0.0.1:3080', accessToken: 'ticket',
  })
})

it('posts the decoded model to the web host and does not call a model base URL', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'dsh-cloud-proxy-'))
  await mkdir(join(userData, 'desktop'))
  await writeFile(join(userData, 'desktop', 'cloud-host.json'), JSON.stringify({ origin: 'http://127.0.0.1:3080' }))
  await writeFile(join(userData, 'desktop', 'platform-session.json'), JSON.stringify({
    accessToken: 'ticket', expiresAt: Date.now() + 60_000,
  }))
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(
    `${JSON.stringify({ type: 'finish', reason: 'stop' })}\n`,
    { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
  ))
  vi.stubGlobal('fetch', fetchMock)
  const adapter = new CloudModelProxyAdapter(userData)
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'dsh-cloud-proxy',
    model: encodeCloudModel('openai', 'qwen3.5-9b'),
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  })) chunks.push(chunk)
  expect(chunks).toEqual([{ type: 'finish', reason: 'stop' }])
  const [url, init] = fetchMock.mock.calls[0]!
  expect(String(url)).toBe('http://127.0.0.1:3080/api/dsh/model-proxy')
  expect(String(url)).not.toContain('openai.com')
  const body = JSON.parse(String(init?.body)) as { provider: string; model: string }
  expect(body).toMatchObject({ provider: 'openai', model: 'qwen3.5-9b' })
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ticket')
  vi.unstubAllGlobals()
})

it('reports a context window for a cloud model so a local session can switch to it', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'dsh-cloud-proxy-'))
  await mkdir(join(userData, 'desktop'))
  await writeFile(join(userData, 'desktop', 'cloud-host.json'), JSON.stringify({ origin: 'http://127.0.0.1:3080' }))
  await writeFile(join(userData, 'desktop', 'platform-session.json'), JSON.stringify({
    accessToken: 'ticket', expiresAt: Date.now() + 60_000,
  }))
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    groups: [{ id: 'kaifang-meta', name: 'Kaifang', models: [
      { id: '4', name: 'qwen', contextWindow: 32_768 },
      { id: '5', name: 'plain' },
      { id: '6', name: 'zero', contextWindow: 0 },
      { id: '7', name: 'fraction', contextWindow: 1.5 },
    ] }],
  }), { status: 200 })))
  const adapter = new CloudModelProxyAdapter(userData)
  const disclosed = await adapter.resolveModel('dsh-cloud-proxy', encodeCloudModel('kaifang-meta', '4'))
  const missing = await adapter.resolveModel('dsh-cloud-proxy', encodeCloudModel('kaifang-meta', '5'))
  const zero = await adapter.resolveModel('dsh-cloud-proxy', encodeCloudModel('kaifang-meta', '6'))
  const fraction = await adapter.resolveModel('dsh-cloud-proxy', encodeCloudModel('kaifang-meta', '7'))
  expect(disclosed.context).toEqual({ contextWindow: 32_768 })
  expect(missing.context).toEqual({ contextWindow: PLATFORM_MODEL_CONTEXT_WINDOW })
  expect(zero.context).toEqual({ contextWindow: PLATFORM_MODEL_CONTEXT_WINDOW })
  expect(fraction.context).toEqual({ contextWindow: PLATFORM_MODEL_CONTEXT_WINDOW })
  vi.unstubAllGlobals()
})

it('copies adapter context windows into the desktop catalog and keeps a model when metadata fails', async () => {
  const catalog = await listCloudCatalog({
    listProviders: () => [
      { id: 'broken', name: 'Broken' },
      { id: 'empty', name: 'Empty' },
      { id: 'kaifang-meta', name: 'Kaifang' },
      { id: 'dsh-cloud-proxy', name: 'Cloud' },
    ],
    listModels: async (provider) => {
      if (provider === 'broken') throw new Error('down')
      if (provider === 'kaifang-meta') return [
        { id: '4', name: 'qwen' },
        { id: '5', name: 'plain' },
        { id: '7', name: 'bare' },
      ]
      return []
    },
    resolveModelInfo: async (_provider, model) => {
      if (model === '5') throw new Error('offline')
      if (model === '7') return {}
      return { context: { contextWindow: 32_768 } }
    },
  })
  expect(catalog).toEqual([{
    id: 'kaifang-meta',
    name: 'Kaifang',
    models: [
      { id: '4', name: 'qwen', contextWindow: 32_768 },
      { id: '5', name: 'plain' },
      { id: '7', name: 'bare' },
    ],
  }])
})

it('uses a disclosed platform context window and falls back when the catalog omits one', async () => {
  const ctx = new Context()
  const adapter = new KaifangPlatformModelAdapter(ctx, 'https://example.test/iam', () => 'token', false)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    data: [
      null,
      'skip',
      ['nope'],
      { name: 'missing-id', model_type: 'chat' },
      { id: 'x', name: 'bad', model_type: 'chat' },
      { id: '8', model_type: 'chat' },
      { id: '9', name: 'embed', model_type: 'embedding' },
      { id: '4', name: 'qwen', model_type: 'chat', context_window: 32_768 },
      { id: '5', name: 'zero', model_type: 'chat', context_window: 0 },
      { id: '6', name: 'plain', model_type: 'chat' },
      { id: '7', name: 'fraction', model_type: 'chat', context_window: 1.5 },
    ],
  }), { status: 200 })))
  await expect(adapter.resolveModel('kaifang', '4')).resolves.toMatchObject({ context: { contextWindow: 32_768 } })
  await expect(adapter.resolveModel('kaifang', '5')).resolves.toMatchObject({
    context: { contextWindow: PLATFORM_MODEL_CONTEXT_WINDOW },
  })
  await expect(adapter.resolveModel('kaifang', '6')).resolves.toMatchObject({
    context: { contextWindow: PLATFORM_MODEL_CONTEXT_WINDOW },
  })
  vi.unstubAllGlobals()
  await ctx.fiber.dispose()
})
