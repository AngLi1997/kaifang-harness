/** Desktop dual-plane (本机 / 云端) client vocabulary. */

export type HostPlaneId = 'local' | 'cloud'

export interface HostPlaneTransport {
  readonly cloudOnline: boolean
  readonly activePlane: HostPlaneId
  readonly streamBaseUrl: string
  readonly ownsHost: boolean
  readonly sidecarApiPrefix?: string
}

export interface SidecarSessionRow {
  readonly sessionId: string
  readonly title: string
  readonly workspaceId: string
  readonly workspaceTitle: string
}

export interface SidecarModelGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly { readonly id: string; readonly name: string }[]
}

export interface DualPlaneSnapshot {
  readonly cloudOnline: boolean
  /** True after cloud disconnect while the empty 云端 shell remains visible. */
  readonly cloudShellEmpty: boolean
  readonly activePlane: HostPlaneId
  readonly sidecarApiPrefix: string | undefined
  readonly sidecarSessions: readonly SidecarSessionRow[]
  readonly sidecarModelGroups: readonly SidecarModelGroup[]
  readonly disconnectToastSeq: number
}
