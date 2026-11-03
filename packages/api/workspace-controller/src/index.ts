/** Host Workspace Remote owner: explicit commands and reconnect-safe state. */

import { Context } from '@deepseek-ai/cordis'
import { mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService, principalOf } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import {
  isDeviceAdmittedKaifangUser,
  isKaifangUserPrincipal,
  platformUserKey,
} from '@deepseek-ai/dsh-kaifang-platform-auth'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { WorkspaceCommands } from './commands.ts'
import { DirectoryPickerController } from './directory-picker.ts'
import { WorkspaceFeed, workspaceView } from './feed.ts'
import { defaultWorkspaceDirectory, validateDocumentsDirectory } from './default-directory.ts'
import { DEFAULT_WORKSPACE_DIRECTORY } from './default-workspace.ts'
import type {
  WorkspaceArchiveSessionRequest,
  WorkspaceDeleteSessionRequest,
  WorkspaceDeleteSessionValue,
  WorkspaceArchiveValue,
  WorkspaceBaseline,
  WorkspaceCreateRequest,
  WorkspaceCreateValue,
  WorkspaceDeleteRequest,
  WorkspaceDeleteValue,
  WorkspaceFollowFrame,
  WorkspaceId,
  WorkspaceInsertBeforeRequest,
  WorkspaceInsertSessionBeforeRequest,
  WorkspaceOrderValue,
  WorkspacePinSessionRequest,
  WorkspacePinValue,
  WorkspaceRenameRequest,
  WorkspaceUnarchiveSessionRequest,
  WorkspaceUnpinSessionRequest,
  WorkspaceValue,
} from './types.ts'

export type * from './types.ts'
export { DirectoryPickerController } from './directory-picker.ts'

/** First-use directory policy for the Host account. */
export interface Config {
  /** Override the system Documents directory with a fully qualified path. */
  documentsDirectory?: string
  /** Parent for per-platform-user Web workspaces on a shared Host. */
  platformUsersRootDirectory?: string
  /** Maximum duration of the operating system's Documents lookup. */
  documentsLookupTimeoutMs?: number
}

/** Directory policy after schema defaults have been applied. */
type ResolvedConfig = Config & { documentsLookupTimeoutMs: number }

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Workspace business API and Remote namespace owner. */
    workspaceController: WorkspaceController
  }
}

/** Host service backing the generated `ctx.remote.workspace` namespace. */
export class WorkspaceController extends TypertRemoteService {
  static inject = ['remoteAccess', 'typert', 'workspaceRegistry']

  static Config: z<Config, ResolvedConfig> = z.object({
    documentsDirectory: z.string(),
    platformUsersRootDirectory: z.string(),
    documentsLookupTimeoutMs: z.natural().min(1).default(10_000),
  })

  private readonly config: ResolvedConfig
  private readonly commands: WorkspaceCommands
  private readonly feed: WorkspaceFeed

  /**
   * @param ctx - Host context containing the Workspace registry.
   * @param config - first-use directory policy.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'workspaceController', { namespace: 'workspace' })
    ctx.typert.resources.register('workspace', { field: 'workspaceId' })
    this.config = WorkspaceController.Config(config)
    if (this.config.documentsDirectory !== undefined) validateDocumentsDirectory(this.config.documentsDirectory)
    if (this.config.platformUsersRootDirectory !== undefined) {
      validateDocumentsDirectory(this.config.platformUsersRootDirectory)
    }
    this.commands = new WorkspaceCommands(ctx)
    this.feed = new WorkspaceFeed(ctx)
    // This package is the Loader entry for both Remote owners it hosts: the
    // directory-picking seam is abstract and never an entry itself. The child
    // stays pending until a picking backend is composed, so a host without one
    // registers no picking namespace instead of answering an unservable verb.
    ctx.plugin(DirectoryPickerController)
  }

  /**
   * Create or idempotently resolve one Workspace over an existing directory.
   * @param request - directory path to register.
   * @returns the Workspace and whether this call created it.
   */
  @Remote('create')
  async create(request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue> {
    const partition = await this.platformPartition()
    if (partition === undefined) return this.commands.create(request)
    // Desktop Remote Client (device-ticket Peer) picks OS-local folders that may
    // sit outside the Web partition root on a same-machine shared Host. Keep
    // ownerId for access policy; browser OAuth Peers stay path-confined below.
    // Browse/list/createDirectory and initializeDefault remain partition-bound
    // for every kaifang-user Peer.
    const path = isDeviceAdmittedKaifangUser(principalOf(this.ctx.invocation))
      ? request.path
      : await this.assertPathInPartition(request.path, partition.root)
    const result = await this.commands.create({ path }, partition.ownerId)
    if (result.created) this.ctx.remoteAccess.invalidate(principalOf(this.ctx.invocation))
    return result
  }

  /**
   * Initialize or reuse the default Workspace during first-use startup. The
   * directory name is fixed, so the Host never renames or relocates an
   * existing default; its initial title is that same name, which browser
   * consumers label in the reader's language.
   * @param signal - caller lifetime; cancels native directory lookup.
   * @returns the durable Workspace, or undefined when first-use initialization is ineligible; creates no Session or message.
   */
  @Remote('initializeDefault')
  async initializeDefault(signal: AbortSignal): Promise<WorkspaceValue | undefined> {
    const partition = await this.platformPartition()
    if (partition !== undefined) {
      signal.throwIfAborted()
      const path = resolve(partition.root, DEFAULT_WORKSPACE_DIRECTORY)
      await mkdir(path, { recursive: true })
      const existing = await this.ctx.workspaceRegistry.resolveByPath(path, partition.ownerId)
      const workspace = existing ?? await this.ctx.workspaceRegistry.create(path, undefined, partition.ownerId)
      if (existing === undefined) this.ctx.remoteAccess.invalidate(principalOf(this.ctx.invocation))
      return { workspace: workspaceView(workspace) }
    }
    const workspace = await this.ctx.workspaceRegistry.initializeDefault(async () => {
      const timeout = AbortSignal.timeout(this.config.documentsLookupTimeoutMs)
      return await defaultWorkspaceDirectory(
        this.config.documentsDirectory, AbortSignal.any([signal, timeout]),
      )
    })
    return workspace === undefined ? undefined : { workspace: workspaceView(workspace) }
  }

  /** Whether the active Remote invocation belongs to a platform Web user. */
  isPlatformUserInvocation(): boolean {
    return isKaifangUserPrincipal(principalOf(this.ctx.invocation))
  }

  /** Resolve and confine a directory-picker request to the active platform user's data root. */
  async directoryPickerPath(path: string | undefined): Promise<string | undefined> {
    const partition = await this.platformPartition()
    if (partition === undefined) return path
    return this.assertPathInPartition(path ?? partition.root, partition.root)
  }

  /**
   * Rename one Workspace to a unique non-blank title.
   * @param request - Workspace identity and proposed title.
   * @returns the updated Workspace projection.
   */
  @Remote('rename')
  rename(request: WorkspaceRenameRequest): Promise<WorkspaceValue> {
    return this.commands.rename(request)
  }

  /**
   * Remove one Workspace registration while retaining files and Session logs.
   * Accounted Sessions are soft-deleted with the registration (not Ungrouped).
   * @param request - Workspace identity to remove.
   * @returns deletion confirmation plus the complete soft-delete set.
   */
  @Remote('delete')
  delete(request: WorkspaceDeleteRequest): Promise<WorkspaceDeleteValue> {
    // Enqueue immediately (ownership runs inside the command queue) so a
    // concurrent rename cannot leapfrog while platformPartition awaits.
    // Soft-delete of accounted Sessions is atomic with the registration drop.
    return this.commands.delete(request, async () => {
      const partition = await this.platformPartition()
      return partition?.ownerId
    })
  }

  /**
   * Move one Workspace within the registry display order.
   * @param request - moved Workspace and optional anchor.
   * @returns the complete resulting Workspace order.
   */
  @Remote('insertBefore')
  insertBefore(request: WorkspaceInsertBeforeRequest): Promise<WorkspaceOrderValue> {
    return this.commands.insertBefore(request)
  }

  /**
   * Move one accounted Session within a Workspace.
   * @param request - Workspace, Session, and optional anchor identities.
   * @returns the updated Workspace projection.
   */
  @Remote('insertSessionBefore')
  insertSessionBefore(request: WorkspaceInsertSessionBeforeRequest): Promise<WorkspaceValue> {
    return this.commands.insertSessionBefore(request)
  }

  /**
   * Hide one known Session from Workspace grouping surfaces.
   * @param request - Session identity to archive.
   * @returns the complete resulting archive set.
   */
  @Remote('archiveSession')
  archiveSession(request: WorkspaceArchiveSessionRequest): Promise<WorkspaceArchiveValue> {
    return this.commands.archiveSession(request)
  }

  /**
   * Restore one archived Session to Workspace grouping surfaces.
   * @param request - Session identity to unarchive.
   * @returns the complete resulting archive set.
   */
  @Remote('unarchiveSession')
  unarchiveSession(request: WorkspaceUnarchiveSessionRequest): Promise<WorkspaceArchiveValue> {
    return this.commands.unarchiveSession(request)
  }

  /**
   * Soft-delete one Session: leave every browse filter while retaining logs.
   * Distinct from {@link archiveSession}.
   */
  @Remote('deleteSession')
  deleteSession(request: WorkspaceDeleteSessionRequest): Promise<WorkspaceDeleteSessionValue> {
    return this.commands.deleteSession(request)
  }

  /**
   * Surface one known unarchived Session ahead of unpinned Sessions.
   * @param request - Session identity to pin.
   * @returns the complete resulting pin set, most recently pinned first.
   */
  @Remote('pinSession')
  pinSession(request: WorkspacePinSessionRequest): Promise<WorkspacePinValue> {
    return this.commands.pinSession(request)
  }

  /**
   * Remove one Session's pin without changing its saved Session order.
   * @param request - Session identity to unpin.
   * @returns the complete resulting pin set, most recently pinned first.
   */
  @Remote('unpinSession')
  unpinSession(request: WorkspaceUnpinSessionRequest): Promise<WorkspacePinValue> {
    return this.commands.unpinSession(request)
  }

  /**
   * Unary snapshot of the admitted Workspace projection (same filter as follow).
   * Desktop dual-plane sidecar polls this for the inactive Host without a second mux.
   */
  @Remote('listSnapshot')
  listSnapshot(): WorkspaceBaseline {
    return this.admittedBaseline()
  }

  /**
   * Stream a complete Workspace baseline followed by ordered increments. A
   * non-owner receives only the Workspaces and Sessions `allows()` admits.
   * When a delivered Workspace is no longer admitted at its next change or
   * the next order change, the stream sends a `replace` frame with the
   * complete filtered state instead of a `remove`, because a Client never
   * resurrects a removed Workspace; a `remove` frame reports a deletion and
   * reaches only a Client that received that Workspace.
   * @param signal - generation cancellation.
   * @returns baseline followed by ordered Workspace increments.
   */
  @Remote({ mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<WorkspaceFollowFrame> {
    const filtered = (value: WorkspaceBaseline): WorkspaceBaseline => this.admittedBaseline(value)
    const visible = (workspaceId: WorkspaceId): boolean => this.ctx.remoteAccess.allows({ kind: 'workspace', id: workspaceId })
    const sessions = (sessionIds: readonly SessionId[]): SessionId[] =>
      sessionIds.filter(sessionId => this.ctx.remoteAccess.allows({ kind: 'session', id: sessionId }))
    /** Workspaces this generation has delivered and not yet removed. */
    const delivered = new Set<WorkspaceId>()
    // Seed delivered from the opening baseline filter below.
    const track = (value: WorkspaceBaseline): WorkspaceBaseline => {
      const next = filtered(value)
      delivered.clear()
      for (const item of next.items) delivered.add(item.workspaceId)
      return next
    }
    for await (const frame of this.feed.follow(signal)) {
      switch (frame.type) {
        case 'baseline':
          yield { type: 'baseline', value: track(frame.value) }
          break
        case 'upsert': {
          const workspaceId = frame.workspace.workspaceId
          if (visible(workspaceId)) {
            delivered.add(workspaceId)
            yield { type: 'upsert', workspace: { ...frame.workspace, sessionIds: sessions(frame.workspace.sessionIds) } }
          } else if (delivered.has(workspaceId)) {
            yield { type: 'replace', value: track(this.feed.baseline()) }
          }
          break
        }
        case 'remove':
          if (delivered.delete(frame.workspaceId)) yield frame
          break
        case 'order':
          if (frame.workspaceIds.some(workspaceId => delivered.has(workspaceId) && !visible(workspaceId))) {
            yield { type: 'replace', value: track(this.feed.baseline()) }
          } else {
            yield { type: 'order', workspaceIds: frame.workspaceIds.filter(visible) }
          }
          break
        case 'archived':
          yield { type: 'archived', archivedSessionIds: sessions(frame.archivedSessionIds) }
          break
        case 'pinned':
          yield { type: 'pinned', pinnedSessionIds: sessions(frame.pinnedSessionIds) }
          break
        case 'deleted':
          yield { type: 'deleted', deletedSessionIds: sessions(frame.deletedSessionIds) }
          break
        /* v8 ignore next -- closed follow-frame union. */
        default:
          assertNever(frame)
      }
    }
  }


  /** Filter a baseline (or the live feed baseline) by Remote access admits. */
  private admittedBaseline(value: WorkspaceBaseline = this.feed.baseline()): WorkspaceBaseline {
    const access = this.ctx.remoteAccess
    const visible = (workspaceId: WorkspaceId): boolean => access.allows({ kind: 'workspace', id: workspaceId })
    const sessions = (sessionIds: readonly SessionId[]): SessionId[] =>
      sessionIds.filter(sessionId => access.allows({ kind: 'session', id: sessionId }))
    return {
      items: value.items.filter(item => visible(item.workspaceId))
        .map(item => ({ ...item, sessionIds: sessions(item.sessionIds) })),
      archivedSessionIds: sessions(value.archivedSessionIds),
      pinnedSessionIds: sessions(value.pinnedSessionIds),
      deletedSessionIds: sessions(value.deletedSessionIds),
    }
  }

  private async platformPartition(): Promise<{ readonly ownerId: string; readonly root: string } | undefined> {
    const principal = principalOf(this.ctx.invocation)
    if (!isKaifangUserPrincipal(principal)) return undefined
    const configuredRoot = this.config.platformUsersRootDirectory
    if (configuredRoot === undefined || configuredRoot.trim() === '') {
      throw new RemoteError('workspace/invalid-path', 'shared Web workspaces need platformUsersRootDirectory', { path: '' })
    }
    const ownerId = platformUserKey(principal)
    const root = resolve(configuredRoot, ownerId)
    await mkdir(root, { recursive: true })
    return { ownerId, root: await realpath(root) }
  }

  private async assertPathInPartition(path: string, root: string): Promise<string> {
    let canonical: string
    try { canonical = await realpath(path) }
    catch (error) {
      throw new RemoteError(
        'workspace/invalid-path',
        `cannot resolve a directory inside the signed-in user's workspace: ${String(error)}`,
        { path },
        { cause: error },
      )
    }
    const relativePath = relative(root, canonical)
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new RemoteError('workspace/invalid-path', 'directory is outside the signed-in user workspace', { path })
    }
    return canonical
  }
}

/* v8 ignore next 3 -- closed-union backstop. */
function assertNever(value: never): never {
  throw new Error(`unreachable Workspace follow frame: ${JSON.stringify(value)}`)
}

export default WorkspaceController
