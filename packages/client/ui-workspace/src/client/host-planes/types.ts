/** Desktop dual-plane (本机 / 云端) client vocabulary. */

export type HostPlaneId = 'local' | 'cloud'

export interface HostPlaneTransport {
  readonly cloudOnline: boolean
  readonly activePlane: HostPlaneId
  readonly streamBaseUrl: string
  readonly ownsHost: boolean
  readonly sidecarApiPrefix?: string
  /** Cloud Host origin. Absent while that endpoint is absent. */
  readonly cloudStreamBaseUrl?: string
  /** Account key of the cloud endpoint. A new key clears that endpoint's snapshots first. */
  readonly cloudAccountKey?: string
}

export interface SidecarSessionRow {
  readonly sessionId: string
  /** Stored title. Empty when the Host has no title; the sidebar localizes that as unnamed. */
  readonly title: string
  readonly workspaceId?: string
  /** Epoch ms from the session list. Absent when the list omitted a finite time. */
  readonly updatedAt?: number
}

export interface SidecarGroup {
  readonly key: string
  readonly title: string
  readonly sessions: readonly SidecarSessionRow[]
}

export interface SidecarWorkspaceRow {
  readonly workspaceId: string
  readonly title: string
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
  /** Conversation plane. Clicks change this. They do not change `activePlane`. */
  readonly sessionPlane: HostPlaneId
  readonly sidecarApiPrefix: string | undefined
  readonly cloudStreamBaseUrl: string | undefined
  readonly cloudAccountKey: string | undefined
  readonly sidecarWorkspaces: readonly SidecarWorkspaceRow[]
  readonly sidecarSessions: readonly SidecarSessionRow[]
  readonly sidecarModelGroups: readonly SidecarModelGroup[]
  readonly disconnectToastSeq: number
}
