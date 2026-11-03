/** 按 Meta 用户隔离模型路由，并通过平台代理检查模型权限。 */
import { Buffer } from 'node:buffer'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { LlmAdapter, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { KaifangUserPrincipal } from './identity.ts'
import { platformModelProviderId } from './identity.ts'

interface PlatformModel {
  readonly id: string
  readonly name: string
  readonly model_type: 'chat' | 'vision'
}

interface ModelListReply {
  readonly data: readonly PlatformModel[]
}

interface ToolCallState {
  readonly id: ReturnType<typeof ToolCallId>
  name: string
  arguments: string
}

function apiUrl(issuer: string, path: string, api = 'ai'): URL {
  const base = new URL(issuer)
  const prefix = base.pathname.replace(/\/iam\/?$/u, '')
  if (prefix === base.pathname) throw new Error('KaifangMeta IAM issuer must end in /iam')
  return new URL(`${prefix}/platform/${api}/v1/${path}`, base.origin)
}

export class KaifangPlatformModelAdapter extends LlmAdapter {
  private catalog: { expiresAt: number; models: readonly PlatformModel[] } | undefined

  constructor(
    private readonly ctx: Context,
    private readonly issuer: string,
    private readonly token: () => string | undefined,
    private readonly desktop: boolean,
  ) { super() }

  override providerInfo(provider: string) { return { id: provider, name: 'KaifangMeta 平台模型' } }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return (await this.listing()).map(model => ({
      provider,
      id: model.id,
      name: model.name,
      description: model.model_type === 'vision' ? '视觉模型' : '对话模型',
      inputModalities: model.model_type === 'vision' ? ['text', 'image'] : ['text'],
    }))
  }

  override async resolveModel(provider: string, modelId: string) {
    const model = (await this.listing()).find(item => item.id === modelId)
    if (model === undefined) throw new LlmError(`KaifangMeta model "${modelId}" is unavailable`, 'UNKNOWN_MODEL')
    return {
      provider,
      id: model.id,
      name: model.name,
      inputModalities: model.model_type === 'vision' ? ['text', 'image'] as const : ['text'] as const,
    }
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.generate(options)
  }

  private async listing(): Promise<readonly PlatformModel[]> {
    if (this.catalog !== undefined && this.catalog.expiresAt > Date.now()) return this.catalog.models
    const token = this.token()
    if (token === undefined) return []
    const response = await fetch(apiUrl(this.issuer, 'models'), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new LlmError(`KaifangMeta model listing failed with HTTP ${response.status}`, 'PLATFORM_MODEL_CATALOG', { status: response.status })
    const payload = await response.json() as ModelListReply
    if (!Array.isArray(payload.data)) throw new LlmError('KaifangMeta returned an invalid model catalog', 'PLATFORM_MODEL_CATALOG')
    const models = payload.data.filter((model): model is PlatformModel => typeof model === 'object' && model !== null
      && !Array.isArray(model) && typeof model.id === 'string' && /^\d+$/u.test(model.id)
      && typeof model.name === 'string' && (model.model_type === 'chat' || model.model_type === 'vision'))
    this.catalog = { expiresAt: Date.now() + 10_000, models }
    return models
  }

  private async * generate(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const token = this.token()
    if (token === undefined) throw new LlmError('KaifangMeta sign-in is required to use platform models', 'PLATFORM_SIGN_IN_REQUIRED')
    const model = (await this.listing()).find(item => item.id === options.model)
    if (model === undefined) throw new LlmError(`KaifangMeta model "${options.model}" is unavailable`, 'UNKNOWN_MODEL')
    const attachments = this.ctx.get('attachments') as AttachmentStore | undefined
    const messages = await Promise.all(options.messages.map(async (message) => {
      const content = await this.openAiContent(message.content, attachments, options.signal)
      if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content }
      const toolCalls = message.role === 'assistant'
        ? message.content.flatMap(block => block.type === 'tool-call'
          ? [{ id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } }]
          : [])
        : []
      return { role: message.role, content, ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }) }
    }))
    const body = {
      messages,
      stream: true,
      ...(options.tools === undefined ? {} : { tools: options.tools.map(tool => ({
        type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      })) }),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
      ...(options.stop === undefined ? {} : { stop: options.stop }),
    }
    const endpoint = this.desktop
      ? apiUrl(this.issuer, 'bindings/harness.chat/invoke', 'capability')
      : apiUrl(this.issuer, `models/${encodeURIComponent(model.id)}/chat`)
    const requestBody = this.desktop ? { model_id: model.id, ...body } : body
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 800)
      const code = response.status === 401 || response.status === 403 ? 'AUTH'
        : response.status === 429 ? 'RATE_LIMIT' : 'PLATFORM_MODEL_REQUEST'
      throw new LlmError(`KaifangMeta model request failed with HTTP ${response.status}: ${detail}`, code, { status: response.status })
    }
    if (response.body === null) throw new LlmError('KaifangMeta model response has no stream body', 'MALFORMED_RESPONSE')

    let text = ''
    let textStarted = false
    let terminal = false
    const toolCalls = new Map<number, ToolCallState>()
    for await (const data of sseData(response.body)) {
      if (data === '[DONE]') break
      let payload: Record<string, unknown>
      try { payload = JSON.parse(data) as Record<string, unknown> }
      catch { continue }
      if (payload.error !== undefined) {
        const detail = typeof payload.error === 'object' && payload.error !== null
          ? Reflect.get(payload.error, 'message') : payload.error
        throw new LlmError(String(detail ?? 'KaifangMeta model request failed'), 'PLATFORM_MODEL_REQUEST')
      }
      const usage = payload.usage as Record<string, number> | undefined
      if (usage !== undefined && typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number') {
        yield { type: 'usage', usage: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens } }
      }
      const choice = (payload.choices as Array<Record<string, unknown>> | undefined)?.[0]
      const delta = choice?.delta as Record<string, unknown> | undefined
      if (typeof delta?.content === 'string' && delta.content.length > 0) {
        if (!textStarted) { textStarted = true; yield { type: 'block-start', index: 0, blockType: 'text' } }
        text += delta.content
        yield { type: 'text-delta', index: 0, text: delta.content }
      }
      for (const update of (delta?.tool_calls as Array<Record<string, unknown>> | undefined) ?? []) {
        const toolIndex = typeof update.index === 'number' ? update.index : toolCalls.size
        const existing = toolCalls.get(toolIndex)
        const fn = update.function as Record<string, unknown> | undefined
        const id = typeof update.id === 'string' ? ToolCallId(update.id) : existing?.id ?? ToolCallId(`platform-tool-${toolIndex}`)
        const state = existing ?? { id, name: '', arguments: '' }
        if (typeof fn?.name === 'string') state.name += fn.name
        if (typeof fn?.arguments === 'string') state.arguments += fn.arguments
        if (existing === undefined) {
          toolCalls.set(toolIndex, state)
          yield { type: 'block-start', index: toolIndex + 1, blockType: 'tool-call' }
        }
        yield { type: 'tool-call-delta', index: toolIndex + 1, id: state.id,
          ...(typeof fn?.name === 'string' ? { name: fn.name } : {}),
          argumentsDelta: typeof fn?.arguments === 'string' ? fn.arguments : '' }
      }
      const finish = choice?.finish_reason
      if (typeof finish === 'string') {
        if (textStarted) yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        for (const [toolIndex, call] of toolCalls) {
          if (call.name.length === 0) throw new LlmError('KaifangMeta returned a tool call without a name', 'MALFORMED_RESPONSE')
          yield { type: 'block-end', index: toolIndex + 1, block: {
            type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments,
          } }
        }
        yield { type: 'finish', reason: finish === 'tool_calls' ? { kind: 'tool-calls' }
          : finish === 'length' ? { kind: 'max-tokens' } : { kind: 'stop' } }
        terminal = true
        break
      }
    }
    if (!terminal) throw new LlmError('KaifangMeta model stream ended without a finish reason', 'STREAM_CLOSED')
  }

  private async openAiContent(
    content: GenerateOptions['messages'][number]['content'],
    attachments: AttachmentStore | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[]> {
    const result: ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[] = []
    for (const block of content) {
      if (block.type === 'text' && block.text.length > 0) result.push({ type: 'text', text: block.text })
      else if (block.type === 'image') {
        if (attachments === undefined) throw new LlmError('image attachments are unavailable on this Host', 'INVALID_REQUEST')
        const stored = await attachments.readImage(block.attachment as ImageAttachmentRef, signal)
        result.push({ type: 'image_url', image_url: { url: `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}` } })
      }
    }
    if (result.every(part => part.type === 'text')) return result.map(part => part.text).join('')
    return result
  }
}

async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split(/\r?\n/u)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line === '') {
          if (data.length > 0) yield data.join('\n')
          data = []
        } else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
      }
      if (done) break
    }
    if (data.length > 0) yield data.join('\n')
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export interface PlatformModelProviderRegistry {
  ensure(identity: Pick<KaifangUserPrincipal, 'sub' | 'tid'>): string
  release(identity: Pick<KaifangUserPrincipal, 'sub' | 'tid'>): void
}

export function registerPlatformModelProvider(
  ctx: Context,
  issuer: string,
  tokenFor: (provider: string) => string | undefined,
): PlatformModelProviderRegistry {
  const desktop = (ctx.get('profileContext') as { readonly name?: string } | undefined)?.name === 'desktop'
  const routes = new Map<string, () => void>()
  ctx.effect(() => () => {
    for (const dispose of routes.values()) dispose()
    routes.clear()
  }, 'kaifang-platform-auth: model routes')
  return {
    ensure: (identity) => {
      const provider = platformModelProviderId(identity)
      if (!routes.has(provider)) {
        const dispose = ctx.llm.registerAdapter([provider], new KaifangPlatformModelAdapter(
          ctx,
          issuer,
          () => tokenFor(provider),
          desktop,
        ))
        routes.set(provider, dispose)
      }
      return provider
    },
    release: (identity) => {
      const provider = platformModelProviderId(identity)
      routes.get(provider)?.()
      routes.delete(provider)
    },
  }
}
