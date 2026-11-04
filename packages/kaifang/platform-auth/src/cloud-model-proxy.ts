/** Desktop local sessions call cloud catalog models through the signed-in Web Host. */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ServerResponse } from 'node:http'
import { once } from 'node:events'
import { attributionHeaders, LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { PLATFORM_MODEL_CONTEXT_WINDOW } from './model-provider.ts'
import type { GenerateOptions, RequestMessage, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'

/** Provider id the Desktop Host registers for Web Host catalog models. */
export const CLOUD_PROXY_PROVIDER = 'dsh-cloud-proxy'

/** Web Host route that runs one model call. Desktop posts here; it does not open the model base URL. */
export const MODEL_PROXY_PATH = '/api/dsh/model-proxy'

const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool'])

interface ProxyLlm {
  listProviders(): readonly { id: string; name: string }[]
  listModels(provider: string): Promise<readonly { id: string; name: string }[]>
  resolveModelInfo(provider: string, model: string): Promise<{ context?: { contextWindow: number } }>
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** One signed-in Web Host the Desktop adapter can call. */
export interface DesktopProxyTarget {
  readonly origin: string
  readonly accessToken: string
}

/**
 * Encode a Web Host provider and model so one Desktop route can name either.
 * @param provider - provider id from the Web Host catalog.
 * @param model - model id from that provider.
 * @returns the Desktop model id.
 */
export function encodeCloudModel(provider: string, model: string): string {
  return `${encodeURIComponent(provider)}/${encodeURIComponent(model)}`
}

/**
 * Split a Desktop cloud-model id into the Web Host provider and model.
 * @param id - value produced by {@link encodeCloudModel}.
 * @returns the pair, or undefined when the id is not that encoding.
 */
export function decodeCloudModel(id: string): { provider: string; model: string } | undefined {
  const slash = id.indexOf('/')
  if (slash <= 0 || slash === id.length - 1) return undefined
  try {
    const provider = decodeURIComponent(id.slice(0, slash))
    const model = decodeURIComponent(id.slice(slash + 1))
    if (provider === '' || model === '') return undefined
    return { provider, model }
  } catch (error) {
    if (error instanceof URIError) return undefined
    throw error
  }
}

/**
 * List models the Web Host can run, skipping this proxy route so a Desktop Host cannot recurse.
 * @param llm - Web Host model registry.
 * @returns provider groups with display names.
 */
export async function listCloudCatalog(llm: Pick<ProxyLlm, 'listProviders' | 'listModels' | 'resolveModelInfo'>): Promise<readonly {
  id: string
  name: string
  models: readonly { id: string; name: string; contextWindow?: number }[]
}[]> {
  const groups = []
  for (const provider of llm.listProviders()) {
    if (provider.id === CLOUD_PROXY_PROVIDER) continue
    let models: readonly { id: string; name: string }[]
    try { models = await llm.listModels(provider.id) }
    catch { continue }
    if (models.length === 0) continue
    const listed = []
    for (const model of models) {
      let contextWindow: number | undefined
      try {
        const info = await llm.resolveModelInfo(provider.id, model.id)
        contextWindow = info.context?.contextWindow
      } catch (error) {
        // A metadata miss must not drop the model from the desktop catalog.
        void error
      }
      listed.push({
        id: model.id,
        name: model.name,
        ...contextWindow === undefined ? {} : { contextWindow },
      })
    }
    groups.push({
      id: provider.id,
      name: provider.name,
      models: listed,
    })
  }
  return groups
}

function isRequestMessage(value: unknown): value is RequestMessage {
  if (typeof value !== 'object' || value === null) return false
  const role = Reflect.get(value, 'role')
  const content = Reflect.get(value, 'content')
  return typeof role === 'string' && ROLES.has(role) && Array.isArray(content)
}

function isTool(value: unknown): value is ToolSchema {
  if (typeof value !== 'object' || value === null) return false
  const parameters = Reflect.get(value, 'parameters')
  return typeof Reflect.get(value, 'name') === 'string'
    && typeof Reflect.get(value, 'description') === 'string'
    && typeof parameters === 'object' && parameters !== null && !Array.isArray(parameters)
}

function hasBlockedMedia(messages: readonly RequestMessage[]): boolean {
  for (const message of messages) {
    const content = Reflect.get(message, 'content')
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      const type = Reflect.get(block, 'type')
      if (type === 'image' || type === 'file') return true
    }
  }
  return false
}

/** Why a proxy body cannot be run. */
export type ProxyReject = 'invalid' | 'media'

/**
 * Validate one proxy body. Image and file blocks stay on the Desktop attachment store, so they are refused.
 * @param body - JSON body from the Desktop Host.
 * @returns the Web Host model request, or why it was refused.
 */
export function parseProxiedModel(body: unknown): { ok: true; options: GenerateOptions } | { ok: false; reason: ProxyReject } {
  if (typeof body !== 'object' || body === null) return { ok: false, reason: 'invalid' }
  const provider = Reflect.get(body, 'provider')
  const model = Reflect.get(body, 'model')
  const messages = Reflect.get(body, 'messages')
  if (typeof provider !== 'string' || provider === '' || provider === CLOUD_PROXY_PROVIDER
    || typeof model !== 'string' || model === '' || !Array.isArray(messages)
    || !messages.every(isRequestMessage)) return { ok: false, reason: 'invalid' }
  if (hasBlockedMedia(messages)) return { ok: false, reason: 'media' }
  const effort = Reflect.get(body, 'reasoningEffort')
  const temperature = Reflect.get(body, 'temperature')
  const maxTokens = Reflect.get(body, 'maxTokens')
  const stop = Reflect.get(body, 'stop')
  const system = Reflect.get(body, 'system')
  const tools = Reflect.get(body, 'tools')
  if (effort !== undefined && typeof effort !== 'string') return { ok: false, reason: 'invalid' }
  if (temperature !== undefined && typeof temperature !== 'number') return { ok: false, reason: 'invalid' }
  if (maxTokens !== undefined && typeof maxTokens !== 'number') return { ok: false, reason: 'invalid' }
  if (system !== undefined && typeof system !== 'string') return { ok: false, reason: 'invalid' }
  if (stop !== undefined && (!Array.isArray(stop) || !stop.every(item => typeof item === 'string'))) {
    return { ok: false, reason: 'invalid' }
  }
  if (tools !== undefined && (!Array.isArray(tools) || !tools.every(isTool))) return { ok: false, reason: 'invalid' }
  return {
    ok: true,
    options: {
      provider,
      model,
      messages,
      ...typeof effort === 'string' ? { reasoningEffort: ReasoningEffortId(effort) } : {},
      ...typeof temperature === 'number' ? { temperature } : {},
      ...typeof maxTokens === 'number' ? { maxTokens } : {},
      ...typeof system === 'string' ? { system } : {},
      ...Array.isArray(stop) ? { stop } : {},
      ...Array.isArray(tools) ? { tools } : {},
    },
  }
}

/**
 * Stream one validated call as newline-delimited chunks.
 * @param llm - Web Host model registry. It owns the provider request.
 * @param options - parsed proxy request.
 * @param response - HTTP response that receives the chunks.
 * @param signal - cancellation when the Desktop caller disconnects.
 */
export async function writeProxiedModel(
  llm: Pick<ProxyLlm, 'stream'>,
  options: GenerateOptions,
  response: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  response.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  for await (const chunk of llm.stream({ ...options, signal })) {
    if (!response.write(`${JSON.stringify(chunk)}\n`)) await once(response, 'drain')
    if (signal.aborted) break
  }
  response.end()
}

function loopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

function originOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  let url: URL
  try { url = new URL(value.trim()) } catch { return undefined }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url.hostname)))
    || url.username !== '' || url.password !== ''
    || (url.pathname !== '/' && url.pathname !== '')
    || url.search !== '' || url.hash !== '') return undefined
  return url.origin
}

/**
 * Read the Web Host origin and platform access token Desktop stored for this sign-in.
 * @param userData - Electron userData directory.
 * @param now - current epoch milliseconds.
 * @returns the call target, or undefined when either file is missing or the token is expired.
 */
export async function readDesktopProxyTarget(userData: string, now = Date.now()): Promise<DesktopProxyTarget | undefined> {
  let originRaw: string
  let sessionRaw: string
  try {
    originRaw = await readFile(join(userData, 'desktop', 'cloud-host.json'), 'utf8')
    sessionRaw = await readFile(join(userData, 'desktop', 'platform-session.json'), 'utf8')
  } catch (error) {
    if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT') return undefined
    throw error
  }
  let originValue: unknown
  let sessionValue: unknown
  try {
    originValue = JSON.parse(originRaw)
    sessionValue = JSON.parse(sessionRaw)
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
  const origin = originOf(typeof originValue === 'object' && originValue !== null ? Reflect.get(originValue, 'origin') : undefined)
  if (origin === undefined || typeof sessionValue !== 'object' || sessionValue === null) return undefined
  const accessToken = Reflect.get(sessionValue, 'accessToken')
  const expiresAt = Reflect.get(sessionValue, 'expiresAt')
  if (typeof accessToken !== 'string' || accessToken === '' || typeof expiresAt !== 'number' || expiresAt <= now) return undefined
  return { origin, accessToken }
}

const CHUNK_TYPES = new Set(['block-start', 'text-delta', 'reasoning-delta', 'tool-call-delta', 'block-end', 'usage', 'finish'])

function isStreamChunk(value: unknown): value is StreamChunk {
  if (typeof value !== 'object' || value === null) return false
  const type = Reflect.get(value, 'type')
  return typeof type === 'string' && CHUNK_TYPES.has(type)
}

function chunkOf(value: unknown): StreamChunk {
  if (!isStreamChunk(value)) throw new LlmError('Web Host model proxy returned a malformed chunk', 'MALFORMED_RESPONSE')
  return value
}

/** Desktop adapter. `stream` posts to the Web Host route and never to a model base URL. */
export class CloudModelProxyAdapter extends LlmAdapter {
  private readonly contextWindows = new Map<string, number>()

  /**
   * @param userData - directory that holds `desktop/cloud-host.json` and `desktop/platform-session.json`.
   */
  constructor(private readonly userData: string) { super() }

  override providerInfo(provider: string) { return { id: provider, name: 'Cloud' } }

  override async listModels(provider: string): Promise<readonly { provider: string; id: string; name: string }[]> {
    const target = await readDesktopProxyTarget(this.userData)
    if (target === undefined) return []
    const response = await fetch(new URL(MODEL_PROXY_PATH, target.origin), {
      headers: { authorization: `Bearer ${target.accessToken}`, ...attributionHeaders() },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return []
    const payload: unknown = await response.json()
    const groups = typeof payload === 'object' && payload !== null ? Reflect.get(payload, 'groups') : undefined
    if (!Array.isArray(groups)) return []
    const models = []
    for (const group of groups) {
      if (typeof group !== 'object' || group === null) continue
      const id = Reflect.get(group, 'id')
      const listed = Reflect.get(group, 'models')
      if (typeof id !== 'string' || !Array.isArray(listed)) continue
      for (const model of listed) {
        if (typeof model !== 'object' || model === null) continue
        const modelId = Reflect.get(model, 'id')
        const name = Reflect.get(model, 'name')
        if (typeof modelId !== 'string') continue
        const encoded = encodeCloudModel(id, modelId)
        const disclosed = Reflect.get(model, 'contextWindow')
        this.contextWindows.set(encoded,
          typeof disclosed === 'number' && Number.isInteger(disclosed) && disclosed > 0
            ? disclosed
            : PLATFORM_MODEL_CONTEXT_WINDOW)
        models.push({
          provider,
          id: encoded,
          name: typeof name === 'string' ? name : modelId,
        })
      }
    }
    return models
  }

  override async resolveModel(provider: string, modelId: string) {
    const decoded = decodeCloudModel(modelId)
    if (decoded === undefined) throw new LlmError(`cloud model "${modelId}" is unavailable`, 'UNKNOWN_MODEL')
    const listed = (await this.listModels(provider)).find(model => model.id === modelId)
    return {
      provider,
      id: modelId,
      name: listed?.name ?? decoded.model,
      context: { contextWindow: this.contextWindows.get(modelId) ?? PLATFORM_MODEL_CONTEXT_WINDOW },
    }
  }

  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const decoded = decodeCloudModel(options.model)
    if (decoded === undefined) throw new LlmError(`cloud model "${options.model}" is unavailable`, 'UNKNOWN_MODEL')
    if (hasBlockedMedia(options.messages)) {
      throw new LlmError('This cloud model call cannot include images or files.', 'INVALID_REQUEST')
    }
    const target = await readDesktopProxyTarget(this.userData)
    if (target === undefined) throw new LlmError('Sign in to the Web Host before using a cloud model.', 'PLATFORM_SIGN_IN_REQUIRED')
    const body = {
      provider: decoded.provider,
      model: decoded.model,
      messages: options.messages,
      ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
      ...options.temperature === undefined ? {} : { temperature: options.temperature },
      ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
      ...options.stop === undefined ? {} : { stop: options.stop },
      ...options.system === undefined ? {} : { system: options.system },
      ...options.tools === undefined ? {} : { tools: options.tools },
    }
    const response = await fetch(new URL(MODEL_PROXY_PATH, target.origin), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${target.accessToken}`,
        'content-type': 'application/json',
        ...attributionHeaders(),
      },
      body: JSON.stringify(body),
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 800)
      throw new LlmError(`Web Host model proxy failed with HTTP ${response.status}: ${detail}`, 'PLATFORM_MODEL_REQUEST', { status: response.status })
    }
    if (response.body === null) throw new LlmError('Web Host model proxy returned no stream body', 'MALFORMED_RESPONSE')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const step = await reader.read()
        buffer += decoder.decode(step.value, { stream: !step.done })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.trim() === '') continue
          const chunk: unknown = JSON.parse(line)
          yield chunkOf(chunk)
        }
        if (step.done) break
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
}
