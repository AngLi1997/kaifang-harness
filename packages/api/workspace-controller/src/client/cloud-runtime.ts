/** Second Host carrier for the signed-in cloud endpoint. The shell connection stays on the local Host. */

import type { Context } from '@deepseek-ai/cordis'
import {
  RemoteStream,
  RemoteStreamMuxClient,
  type ClientRemote,
  type RemoteStreamOptions,
} from '@deepseek-ai/dsh-api-gateway/client'
import {
  ClientSessions,
  createSessionControlStream,
  type SessionBinding,
  type SessionRemotes,
} from '@deepseek-ai/dsh-api-session-controller/client'
import { createWorkspaceStateStream } from './index.ts'
import { ClientWorkspaceModel } from './model.ts'
import { WorkspaceCreateError } from './service.ts'
import {
  createWebConnectionRpc,
  openConnectionWebSocket,
  type ConnectionGeneration,
  type ConnectionWebSocket,
} from '@deepseek-ai/dsh-client-connection/client'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceView } from '../types.ts'

/** One cloud workspace row for the sidebar catalog. */
interface CloudWorkspaceRow {
  readonly workspaceId: string
  readonly title: string
}

/** One cloud session row for the sidebar catalog. */
interface CloudSessionRow {
  readonly sessionId: string
  readonly title: string
  readonly workspaceId?: string
  readonly updatedAt?: number
}

/** One cloud model group for the sidebar catalog. */
interface CloudModelGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly { readonly id: string; readonly name: string }[]
}

/** Live cloud catalog projected into the sidebar. */
export interface CloudCatalog {
  readonly workspaces: readonly CloudWorkspaceRow[]
  readonly sessions: readonly CloudSessionRow[]
  readonly modelGroups: readonly CloudModelGroup[]
}

/** One cloud generation. `stop` drops it without touching the shell connection. */
export interface CloudRuntime {
  readonly sessions: ClientSessions
  /** Create a workspace on this cloud Host. */
  createWorkspace(input: { readonly path: string }): Promise<WorkspaceView>
  /** Record a model on a session that belongs to this cloud Host. */
  selectModel(request: {
    readonly sessionId: string
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }): Promise<{ ok: true; value: undefined } | { ok: false; error: { code: string; message: string } }>
  stop(): void
}

/** Inputs for one cloud generation. The workspace controller's context owns scopes and descriptors. */
export interface CloudRuntimeOptions {
  /** Shared Host origin for the cloud WebSocket. */
  readonly origin: string
  /** Stable prefix forwarded to the cloud cookie. */
  readonly apiPrefix: string
  /** Replace the sidebar's cloud rows. Ignored after `stop`. */
  readonly onCatalog: (catalog: CloudCatalog) => void
  /** Cloud follow ended. The caller marks that section disconnected. */
  readonly onLost: () => void
  /**
   * Conversation binding owned by this generation.
   * @param binding - binding to show, or undefined when this generation stops.
   */
  readonly onFocus: (binding: SessionBinding | undefined) => void
}

/**
 * Connect one cloud Host and follow its workspace and session catalogs.
 * @param ctx - workspace controller context. Its `typert` descriptors and scopes belong to this catalog.
 * @param options - origin, cookie prefix, and catalog sink.
 * @returns the running generation.
 */
export function startCloudRuntime(ctx: Context, options: CloudRuntimeOptions): CloudRuntime {
  const lifetime = new AbortController()
  const generations = new GenerationSource()
  const ignoredCloses = new WeakSet<ConnectionWebSocket>()
  let stopping = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let modelGroups: readonly CloudModelGroup[] = []

  const rpc = createWebConnectionRpc((input, init) => {
    const path = typeof input === 'string' ? input : input.toString()
    const suffix = path.replace(/^\//, '')
    return fetch(`${options.apiPrefix.replace(/\/$/, '')}/${suffix}`, init)
  })
  const mux = new RemoteStreamMuxClient(path => openCloudSocket(path))

  function openCloudSocket(path: string): ConnectionWebSocket {
    const socket = openConnectionWebSocket(path, undefined, options.origin)
    socket.addEventListener('open', () => { generations.ready() })
    socket.addEventListener('close', () => {
      if (stopping || ignoredCloses.has(socket)) return
      generations.lost()
      retryTimer = setTimeout(() => {
        if (stopping) return
        ignoredCloses.add(socket)
        mux.reconnect()
      }, 1000)
    })
    return socket
  }

  function decodeValue(descriptor: InvocationDescriptor, value: unknown): unknown {
    return descriptor.result.mode === 'strict' && descriptor.result.decode !== undefined
      ? descriptor.result.decode(value)
      : value
  }

  function invoke(endpoint: string, values: readonly unknown[]): unknown {
    const descriptor = ctx.typert.remotes.get(endpoint)
    if (descriptor === undefined) throw new Error(`cloud runtime: missing remote ${endpoint}`)
    if (descriptor.invocation.kind !== 'direct' || descriptor.scope !== undefined) {
      throw new Error(`cloud runtime: ${endpoint} requires a context receiver`)
    }
    const expected = descriptor.parameters.length
    const hasSignal = descriptor.cancellation !== undefined && values.length === expected + 1
    if (values.length !== expected && !hasSignal) {
      throw new Error(`cloud runtime: ${endpoint} expected ${String(expected)} argument(s), got ${String(values.length)}`)
    }
    const args: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    descriptor.parameters.forEach((parameter, index) => {
      const value = values[index]
      if (value !== undefined) args[parameter.wire] = value
    })
    const callerSignal = hasSignal && values[expected] instanceof AbortSignal ? values[expected] : undefined
    const signal = callerSignal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, callerSignal])
    if (descriptor.mode === 'stream') {
      const abort = new AbortController()
      const linked = AbortSignal.any([signal, abort.signal])
      return new CloudDownlink(endpoint, mux.open(endpoint, { args }, linked), descriptor, abort)
    }
    return callUnary(endpoint, descriptor, args, signal)
  }

  async function callUnary(
    endpoint: string,
    descriptor: InvocationDescriptor,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }> {
    try {
      const result = await rpc.call('/api', endpoint, { args }, signal)
      if (!result.ok) return { ok: false, error: { code: result.error.code, message: result.error.message } }
      return { ok: true, value: decodeValue(descriptor, result.value) }
    } catch (error) {
      return {
        ok: false,
        error: { code: 'cloud/carrier', message: error instanceof Error ? error.message : String(error) },
      }
    }
  }

  function namespace(name: string): object {
    return new Proxy({}, {
      get(_target, method) {
        if (typeof method !== 'string' || method === 'then') return undefined
        return (...values: unknown[]) => invoke(`${name}/${method}`, values)
      },
    })
  }

  const remotes = {
    $stream: <Item>(streamOptions: RemoteStreamOptions<Item>) => new RemoteStream({ generation: generations }, streamOptions),
    commands: namespace('commands'),
    session: namespace('session'),
    subagents: namespace('subagents'),
  } as SessionRemotes
  const sessions = new ClientSessions(ctx, remotes, { publish: false })
  const workspaces = new ClientWorkspaceModel(namespace('workspace') as ClientRemote['workspace'])
  const control = createSessionControlStream(remotes, {
    accept: (frame) => { sessions.handleControlFrame(frame) },
    failed: (error) => {
      if (!stopping) console.error('[cloud-runtime] control stream failed:', error)
    },
  })
  const workspaceStream = createWorkspaceStateStream({
    $stream: remotes.$stream,
    workspace: namespace('workspace'),
  } as ClientRemote, {
    accept: workspaces,
    failed: (error) => {
      if (stopping) return
      console.error('[cloud-runtime] workspace stream failed:', error)
      options.onLost()
    },
  })

  function emit(): void {
    if (stopping) return
    const snapshot = workspaces.getSnapshot()
    const list = sessions.list.getSnapshot()
    const workspaceOf = new Map<string, string>()
    for (const item of snapshot.items) {
      for (const id of item.sessionIds) workspaceOf.set(id, item.workspaceId)
    }
    const deleted = new Set<string>(snapshot.deletedSessionIds)
    const catalogSessions: CloudSessionRow[] = []
    for (const id of list.ids) {
      const row = list.byId[id]
      if (row === undefined || row.blank || row.origin === 'subagent' || deleted.has(id)) continue
      const workspaceId = workspaceOf.get(id)
      catalogSessions.push({
        sessionId: id,
        title: row.title ?? '',
        ...workspaceId === undefined ? {} : { workspaceId },
        updatedAt: row.updatedAt,
      })
    }
    options.onCatalog({
      workspaces: snapshot.items.map(item => ({ workspaceId: item.workspaceId, title: item.title })),
      sessions: catalogSessions,
      modelGroups,
    })
  }

  async function loadModels(): Promise<void> {
    const result = await invoke('session/modelCatalog', []) as {
      ok?: boolean
      value?: { groups?: readonly { id?: unknown; name?: unknown; models?: readonly { id?: unknown; name?: unknown }[] }[] }
    }
    if (stopping || result.ok !== true) return
    modelGroups = (result.value?.groups ?? []).flatMap((group) => {
      if (typeof group.id !== 'string') return []
      const models = (group.models ?? []).flatMap(model => (
        typeof model.id === 'string' ? [{ id: model.id, name: typeof model.name === 'string' ? model.name : model.id }] : []
      ))
      return [{ id: group.id, name: typeof group.name === 'string' ? group.name : group.id, models }]
    })
    emit()
  }

  const stopWorkspace = workspaces.subscribe(() => {
    emit()
    void sessions.refresh()
  })
  const stopSessions = sessions.list.subscribe(() => { emit() })
  const stopGeneration = generations.subscribe(() => {
    if (stopping || generations.getSnapshot() === undefined) return
    sessions.handleConnected()
    control.restart()
    control.start()
    workspaceStream.restart()
    workspaceStream.start()
    void loadModels()
  })
  mux.start()

  return {
    sessions,
    createWorkspace(input) {
      return workspaces.create(input).then((result) => {
        if (!result.ok) throw new WorkspaceCreateError(result.error)
        return result.value.workspace
      })
    },
    async selectModel(request) {
      const result = await invoke('session/selectModel', [request])
      if (typeof result === 'object' && result !== null && Reflect.get(result, 'ok') === true) {
        return { ok: true, value: undefined }
      }
      const error = typeof result === 'object' && result !== null ? Reflect.get(result, 'error') : undefined
      const codeValue = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
      const messageValue = typeof error === 'object' && error !== null ? Reflect.get(error, 'message') : undefined
      return {
        ok: false,
        error: {
          code: typeof codeValue === 'string' ? codeValue : 'cloud/carrier',
          message: typeof messageValue === 'string' ? messageValue : 'cloud model selection failed',
        },
      }
    },
    stop() {
      if (stopping) return
      stopping = true
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      lifetime.abort()
      stopWorkspace()
      stopSessions()
      stopGeneration()
      options.onFocus(undefined)
      void (async () => {
        await control.dispose()
        await workspaceStream.dispose()
        await sessions.dispose()
        await mux.close()
      })()
    },
  }
}

class GenerationSource {
  private current: ConnectionGeneration | undefined
  private nextId = 0
  private readonly listeners = new Set<() => void>()

  getSnapshot(): ConnectionGeneration | undefined {
    return this.current
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  ready(): void {
    this.current = { id: ++this.nextId, host: { home: '' } }
    this.notify()
  }

  lost(): void {
    if (this.current === undefined) return
    this.current = undefined
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

class CloudDownlink implements AsyncIterable<unknown> {
  private consumed = false

  /**
   * @param endpoint - diagnostic name.
   * @param source - mux downlink.
   * @param descriptor - result codec for each item.
   * @param abort - cancels this logical stream.
   */
  constructor(
    private readonly endpoint: string,
    private readonly source: AsyncIterable<unknown>,
    private readonly descriptor: InvocationDescriptor,
    private readonly abort: AbortController,
  ) {}

  send(): void {}

  end(): void {}

  dispose(): void {
    this.abort.abort()
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    if (this.consumed) throw new Error(`cloud runtime: ${this.endpoint} stream has one consumer`)
    this.consumed = true
    const iterator = this.source[Symbol.asyncIterator]()
    const abort = this.abort
    const decode = this.descriptor.result.mode === 'strict' ? this.descriptor.result.decode : undefined
    return {
      async next() {
        const item = await iterator.next()
        if (item.done === true) return { done: true, value: undefined }
        return { done: false, value: decode === undefined ? item.value : decode(item.value) }
      },
      async return() {
        abort.abort()
        await iterator.return?.(undefined)
        return { done: true, value: undefined }
      },
    }
  }
}
