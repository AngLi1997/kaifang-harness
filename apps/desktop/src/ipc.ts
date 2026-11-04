/** Typed preload operations exposed only by the Electron shell. */

import type { DesktopKeyboardApi, DesktopShortcutsApi } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import type { IpcMainInvokeEvent } from 'electron'
import type { DesktopBrowserBridge } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type { DesktopFileDrag } from '@deepseek-ai/dsh-util-file-drag'

/** IPC channel names kept private to the desktop application bundle. */
export const DESKTOP_IPC = {
  shortcutsInput: 'dsh-desktop:shortcuts-input',
  shortcutsCloseWindow: 'dsh-desktop:shortcuts-close-window',
  shortcutsGet: 'dsh-desktop:shortcuts-get',
  shortcutsEdit: 'dsh-desktop:shortcuts-edit',
  shortcutsChanged: 'dsh-desktop:shortcuts-changed',
  shortcutsRecording: 'dsh-desktop:shortcuts-recording',
  boot: 'dsh-desktop:boot',
  showSignIn: 'dsh-desktop:show-sign-in',
  enterWorkspace: 'dsh-desktop:enter-workspace',
  onboardingActive: 'dsh-desktop:onboarding-active',
  onboardingApiKey: 'dsh-desktop:onboarding-api-key',
  bootFailed: 'dsh-desktop:boot-failed',
  browserAcquire: 'dsh-desktop:browser-acquire',
  browserRelease: 'dsh-desktop:browser-release',
  browserOpenRequested: 'dsh-desktop:browser-open-requested',
  directoryPick: 'dsh-desktop:directory-pick',
  fileDragPrepare: 'dsh-desktop:file-drag-prepare',
  fileDragCancel: 'dsh-desktop:file-drag-cancel',
  fileDragStart: 'dsh-desktop:file-drag-start',
  fileDragRelease: 'dsh-desktop:file-drag-release',
  deviceInfo: 'dsh-desktop:device-info',
  localeBootstrap: 'dsh-desktop:locale-bootstrap',
  localeChanged: 'dsh-desktop:locale-changed',
  updatesStatus: 'dsh-desktop:updates-status',
  updatesOpen: 'dsh-desktop:updates-open',
  updatesPresentation: 'dsh-desktop:updates-presentation',
  nativeThemeSet: 'dsh-desktop:native-theme-set',
  windowFullscreen: 'dsh-desktop:window-fullscreen',
  windowsAppearance: 'dsh-desktop:windows-appearance',
  windowsMenu: 'dsh-desktop:windows-menu',
  kaifangAccount: 'dsh-desktop:kaifang-account',
  kaifangSignIn: 'dsh-desktop:kaifang-sign-in',
  kaifangSignOut: 'dsh-desktop:kaifang-sign-out',
  kaifangRefresh: 'dsh-desktop:kaifang-refresh',
  kaifangChanged: 'dsh-desktop:kaifang-changed',
  hostPlaneSet: 'dsh-desktop:host-plane-set',
  hostPlaneChanged: 'dsh-desktop:host-plane-changed',
  cloudDisconnected: 'dsh-desktop:cloud-disconnected',
} as const

/** Signed-in Platform identity shown by the workspace account launcher; carries no token. */
import type { HostPlaneId } from './host-plane.ts'
export type { HostPlaneId }

/** Dual-plane boot/change payload for the product renderer. */
export interface HostPlaneView {
  readonly cloudOnline: boolean
  readonly activePlane: HostPlaneId
  readonly streamBaseUrl: string
  readonly ownsHost: boolean
  readonly sidecarApiPrefix?: string
  /** Shared Host origin while the cloud endpoint exists. The shell socket stays on `streamBaseUrl`. */
  readonly cloudStreamBaseUrl?: string
  /** Account key of the cloud endpoint. A change disposes that generation before the next baseline. */
  readonly cloudAccountKey?: string
}

export interface KaifangAccountView {
  readonly username: string
  readonly displayName: string
  readonly email: string | null
  readonly avatarUrl: string | null
}

/** Desktop release update state rendered by desktop-owned UI. */
export type DesktopUpdatePreparationFailureKind = 'stop-failed' | 'tasks-changed' | 'tasks-unavailable' | 'fullscreen-timeout'

export interface DesktopUpdateState {
  readonly phase: 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'installing' | 'ready' | 'error'
  readonly version?: string
  readonly message?: string
  /** Main-owned diagnostics without subprocess output or credentials; hidden until expanded. */
  readonly technicalDetails?: string
  readonly percent?: number
  readonly failedOperation?: 'check' | 'download' | 'install'
  /** Main-owned preparation cause; UI wording is selected by the active locale. */
  readonly preparationFailure?: DesktopUpdatePreparationFailureKind
}

/** Classified failure copy selected by the Web locale without exposing raw updater diagnostics. */
export type DesktopUpdateFailureKind =
  | 'check'
  | 'check-network'
  | 'download'
  | 'download-network'
  | 'install'
  | 'install-network'
  | 'stop-failed'
  | 'tasks-changed'
  | 'tasks-unavailable'
  | 'fullscreen-timeout'

/** Semantic status content; actions open main-process confirmation dialogs only. */
export interface DesktopUpdatePresentation {
  readonly phase: DesktopUpdateState['phase']
  readonly version?: string
  readonly percent?: number
  readonly failure?: DesktopUpdateFailureKind
}

/** Product documents cannot supply update versions, package URLs, or installation authorization. */
export interface DshDesktopProductApi {
  readonly protocolVersion: 1
  readonly browser: DesktopBrowserBridge
  readonly fileDrag: DesktopFileDrag
  /** Show the native sign-in page. */
  showSignIn(): Promise<void>
  readonly keyboard: DesktopKeyboardApi
  readonly shortcuts: DesktopShortcutsApi
  /**
   * Local machine description for the feedback questionnaire.
   * @returns `name=value` fields separated by `; `, with no hostname, user name, or serial number.
   */
  deviceInfo(): Promise<string>
  /** Platform account stored by system-browser OAuth; absent until sign-in. */
  readonly kaifang: {
    current(): Promise<KaifangAccountView | null>
    signIn(): Promise<void>
    signOut(): Promise<void>
    refresh(): Promise<void>
    subscribe(listener: (account: KaifangAccountView | null) => void): () => void
  }
  /** Dual-plane (本机 / 云端): switch active Host and observe disconnect. */
  readonly hostPlane: {
    current(): Promise<HostPlaneView>
    setActive(plane: HostPlaneId): Promise<HostPlaneView>
    /** Renderer observed the cloud sidecar as unreachable. */
    reportCloudLost(): Promise<HostPlaneView>
    subscribe(listener: (view: HostPlaneView) => void): () => void
    subscribeDisconnect(listener: () => void): () => void
  }
  readonly updates: {
    status(): Promise<DesktopUpdatePresentation>
    open(): Promise<void>
    subscribe(listener: (state: DesktopUpdatePresentation) => void): () => void
  }
}

/** Scheme of Desktop-owned application documents. */
export const SCHEME = 'dsh-app'

/**
 * Reject IPC outside the allowed Desktop document origins.
 * @param event - IPC caller whose frame URL supplies the origin.
 * @param hostnames - Desktop document hosts allowed for this operation.
 */
export function assertDesktopSender(event: IpcMainInvokeEvent, hostnames: readonly string[]): void {
  const senderFrame = event.senderFrame
  if (senderFrame === null) throw new Error('dsh desktop: rejected IPC without a sender frame')
  const url = new URL(senderFrame.url)
  if (url.protocol !== `${SCHEME}:` || !hostnames.includes(url.hostname)) {
    throw new Error('dsh desktop: rejected IPC from an unowned renderer')
  }
}
