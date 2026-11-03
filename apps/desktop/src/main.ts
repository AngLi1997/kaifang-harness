import type { ProductEventMap, ProductEvent } from '@deepseek-ai/dsh-client-product-analytics/types'
import { WINDOWS_TITLEBAR_HEIGHT } from './windows-layout.ts'
/** Electron shell: desktop project ownership, custom protocol, windows, and lifecycle. */

import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  powerMonitor,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  session,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron'
import { resolveDesktopPaths } from './paths.ts'
import { DesktopProjectManager } from './project-manager.ts'
import { DesktopHostFatalError, DesktopHostProcess, DesktopHostUncleanExitError } from './host-process.ts'
import { DesktopPlatformView, PLATFORM_IPC, platformBounds } from './platform-view.ts'
import { installDesktopFileDrag } from './file-drag.ts'
import { installDesktopDirectoryPicker } from './directory-picker.ts'
import { installMicrophonePermissions } from './microphone-permissions.ts'
import { DesktopBackendController } from './backend-controller.ts'
import { DESKTOP_IPC, SCHEME, assertDesktopSender, type DesktopUpdateState, type HostPlaneView, type KaifangAccountView } from './ipc.ts'
import { readDeviceInfo } from './device-info.ts'
import { desktopUpdateReadyConfirmation, formatDesktopMessage, resolveDesktopLocale, resolveDesktopStartupLocale } from './locale.ts'
import { claimDesktopSingleInstance } from './single-instance.ts'
import { desktopUpdateChannel } from './update-channel.ts'
import { DesktopUpdateCoordinator } from './update-coordinator.ts'
import { prepareDesktopUpdateWindow } from './update-window.ts'
import { DesktopCommandManager } from './command-management.ts'
import { serveWebDocument, authenticateWebHost, forwardWebRequest, resolveDesktopHostForward, desktopHasModelCredentials, desktopFollowTransportAligned } from './web-document.ts'
import {
  attachSharedHostRemoteClient,
  shouldNotifySharedHostAttachFailure,
  type SharedHostAttachResult,
} from './shared-host-attach.ts'
import {
  desktopDualPlaneBoot,
  resolvePlaneHosts,
  type HostPlaneId,
} from './host-plane.ts'
import { DesktopFatalRecovery } from './fatal-recovery.ts'
import { pruneCrashReports, RendererConsoleTail, writeCrashReport, type CrashReportSource } from './crash-report.ts'
import { openWelcomeWindow } from './welcome-window.ts'
import { needsWelcome, type PlatformBrowserSignInResult, type PlatformPasswordCredentials, type PlatformPasswordSignInResult } from './welcome-api.ts'
import { PlatformBrowserSignIn, refreshPlatformSession } from './platform-browser-sign-in.ts'
import { clearPlatformSession, hasPlatformSession, readPlatformSession, writePlatformSession, type PlatformSession, type PlatformSessionUser } from './platform-session.ts'
import { connectDesktopWelcome, type DesktopWelcomeBackend } from './welcome-backend.ts'
import { DesktopUpdateJournal } from './update-journal.ts'
import { DesktopUpdatePreparationError } from './update-error.ts'
import { DesktopUpdateSchedule, resolveDesktopUpdateScheduleConfig } from './update-schedule.ts'
import { desktopUpdateErrorSummary, presentDesktopUpdate } from './update-presentation.ts'
import { desktopErrorState } from './startup-error.ts'
import { readDesktopLoginShellEnvironment, resolveDesktopLoginShellConfig } from './login-shell-environment.ts'
import { DesktopMandatoryUpdatePolicy, resolveDesktopPolicyConfig, type DesktopPolicyState } from './mandatory-update-policy.ts'
import { desktopClientMetadata, desktopClientVersion } from './client-metadata.ts'
import { DesktopMandatoryUpdateWindow } from './mandatory-update-window.ts'
import { DesktopPolicyTestAuth } from './policy-test-auth.ts'
import { readDesktopSettings } from './settings.ts'
import { createSharedHarnessWindow, readSharedHarnessUrl, saveSharedHarnessUrl, sharedHarnessEntryUrl } from './shared-harness.ts'
import { DesktopUpdateDialog, type UpdateDialogOptions } from './update-dialog.ts'
import { readDesktopRuntime } from './runtime-tree.ts'
import { DesktopBrowserGuests } from './browser-guests.ts'
import { installDesktopShortcuts } from './keyboard.ts'
import { DesktopUpdateOverlays } from './update-overlay.ts'
import { DesktopQuitConfirmation } from './quit-confirmation.ts'
import { DesktopTray } from './tray.ts'
import { DesktopBackgroundNotice } from './background-notice.ts'

let focusPrimaryWindow = (): void => {}
let openSharedHarness: () => Promise<boolean> = () => Promise.resolve(false)
let showSharedHarnessSettings: () => Promise<void> = () => Promise.resolve()
let stopForRecovery = async (): Promise<void> => {}
let shuttingDown = false
/**
 * Set by quit entries that must not ask: crash recovery exit and restart, and the
 * development restart command. The installer handoff has its own before-quit branch.
 */
let skipQuitConfirmation = false
let windowsLanguage: string | undefined
/**
 * Whether the backend has reached ready: false until the first ready, back to
 * false when a restart returns it to starting, frozen during shutdown so a
 * failure while tearing down a ready backend still reads as `running`.
 */
let backendReady = false
/** Error-level console output of the primary window, attached to crash reports. */
const rendererConsole = new RendererConsoleTail()

// Platform-conventional logs directory (macOS ~/Library/Logs/<name>, otherwise under userData);
// set before ready so the first fatal report already resolves under it.
app.setAppLogsPath()

function currentDesktopLocale(): ReturnType<typeof resolveDesktopLocale> {
  return resolveDesktopLocale(windowsLanguage ?? app.getLocale())
}


async function clearLoopbackHostAuthCookies(): Promise<void> {
  try {
    const cookieStore = session.defaultSession?.cookies
    if (cookieStore === undefined) return
    const targets = ['http://127.0.0.1', 'http://localhost']
    for (const url of targets) {
      const cookies = await cookieStore.get({ url })
      await Promise.all(cookies
        .filter(cookie => cookie.name.startsWith('dsh-auth-'))
        .map(async (cookie) => { await cookieStore.remove(url, cookie.name) }))
    }
  } catch (error) {
    console.warn('desktop auth: could not clear oversized loopback Host cookies', error)
  }
}

async function removeLegacyKaifangCredentials(userData: string): Promise<void> {
  const paths = ['kaifang-session.json', 'system-connection.json'].map(name => join(userData, 'desktop', name))
  await Promise.all(paths.map(async (path) => {
    try { await rm(path, { force: true }) }
    catch (error) { console.warn(`desktop auth: could not remove obsolete credential file ${path}`, error) }
  }))
}
/** Quit without the task confirmation; the caller has already decided the application must stop. */
function quitWithoutConfirmation(): void {
  skipQuitConfirmation = true
  app.quit()
}
const recovery = new DesktopFatalRecovery({
  messages: () => currentDesktopLocale().messages,
  show: options => dialog.showMessageBox(options),
  stop: () => { shuttingDown = true; return stopForRecovery() },
  disablePlugins: async () => {
    const manager = new DesktopProjectManager(resolveDesktopPaths(), runtimeResources())
    const backupPath = await manager.disableAllPlugins()
    console.info('Desktop profile recovery completed:', { profilePatchBackup: backupPath ?? null, homePatch: 'unchanged' })
  },
  exit: () => { quitWithoutConfirmation() },
  restart: () => { app.relaunch(); quitWithoutConfirmation() },
  writeReport: (error, source) => persistCrashReport(error, source),
})

function persistCrashReport(error: unknown, source: CrashReportSource): Promise<string | undefined> {
  return writeCrashReport(app.getPath('logs'), {
    source,
    phase: backendReady ? 'running' : 'startup',
    error,
    ...(error instanceof DesktopHostFatalError && error.diagnostic !== undefined ? { hostDiagnostic: error.diagnostic } : {}),
    rendererConsole: rendererConsole.snapshot(),
    app: {
      name: app.name, version: app.getVersion(), platform: process.platform, arch: process.arch,
      electron: process.versions.electron, node: process.versions.node, locale: currentDesktopLocale().id,
    },
    time: new Date(),
  })
}

function reportFatal(error: unknown, source: CrashReportSource): void {
  console.error(error)
  if (shuttingDown) {
    // No dialog during shutdown, but the report still records what failed on the way out.
    void persistCrashReport(error, source)
    return
  }
  void recovery.report(error, source).catch((failure: unknown) => { console.error(failure); app.exit(1) })
}

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
    codeCache: true,
  },
}])

interface RuntimeResources {
  readonly nodeBin: string
  readonly node: string
  readonly pnpm: string
  readonly dsh: string
}

function runtimeResources(): RuntimeResources {
  const development = !app.isPackaged
  const node = process.execPath
  const nodeBin = development ? join(app.getAppPath(), 'scripts', 'node-bin') : join(process.resourcesPath, 'runtime', 'bin')
  const pnpm = (development ? process.env.DSH_DESKTOP_PNPM_ENTRY : undefined)
    ?? (development ? join(app.getAppPath(), 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
      : join(process.resourcesPath, 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'))
  const dsh = (development ? process.env.DSH_DESKTOP_DSH_DIR : undefined)
    ?? (development ? join(app.getAppPath(), '.desktop-build', 'development', 'project') : join(app.getAppPath(), 'dsh'))
  return { node, nodeBin, pnpm, dsh }
}

function developmentPrimaryRuntime(): string {
  const directory = process.env.DSH_DESKTOP_PRIMARY_RUNTIME_DIR
  if (directory === undefined || directory === '') {
    throw new Error('dsh desktop: DSH_DESKTOP_PRIMARY_RUNTIME_DIR is required for an unpackaged launch')
  }
  return directory
}

function developmentHostInspectPort(enabled: boolean): number | undefined {
  const configured = process.env.DSH_DESKTOP_HOST_INSPECT_PORT
  if (!enabled || configured === undefined || configured === '') return undefined
  const port = Number(configured)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('dsh desktop: DSH_DESKTOP_HOST_INSPECT_PORT must be an integer from 1 through 65535')
  }
  return port
}

/**
 * Opaque chrome fallback matching the built-in sidebar palette (the resolved
 * `--dsw-static-neutral-bluish-900` / `-50` tokens). An approximation for
 * custom themes: Windows swaps in the renderer's measured palette over the
 * windowsAppearance IPC, and macOS shows it only while minimized or hidden.
 * @returns the sidebar fill hex for the active system color scheme.
 */
function chromeFallbackFill(): string {
  return nativeTheme.shouldUseDarkColors ? '#1b1b1c' : '#f9fafb'
}

function createWindow(preload: string, show = false, primary = false): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 520,
    minHeight: 600,
    show,
    ...(process.platform === 'win32' && primary ? {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: { height: WINDOWS_TITLEBAR_HEIGHT, color: chromeFallbackFill(),
        symbolColor: nativeTheme.shouldUseDarkColors ? '#f9fafb' : '#0f1115' },
    } : {}),
    // hiddenInset places traffic lights inside the sidebar; sidebar vibrancy
    // needs a transparent window background to show through the page.
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: { x: 16, y: 18 },
      vibrancy: 'sidebar' as const,
      // 'active' keeps the vibrancy material stable when the window blurs;
      // 'followWindow' washes the sidebar out behind an unfocused window.
      visualEffectState: 'active' as const,
      backgroundColor: '#00000000',
    } : {}),
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: primary,
      devTools: true,
    },
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (['http:', 'https:'].includes(new URL(url).protocol)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.platform === 'darwin' || process.platform === 'win32') {
    // Fullscreen hides native window controls; overlays drop their caption clearance.
    const sendFullscreen = (): void => {
      if (!window.isDestroyed()) window.webContents.send(DESKTOP_IPC.windowFullscreen, window.isFullScreen())
    }
    window.on('enter-full-screen', sendFullscreen)
    window.on('leave-full-screen', sendFullscreen)
    // Reloads and navigations re-register the preload listener; resend the
    // current state so a fullscreen reload does not fall back to windowed CSS.
    window.webContents.on('did-finish-load', sendFullscreen)
  }
  if (process.platform === 'darwin') {
    // Deminiaturize reattaches the NSVisualEffectView material late
    // (electron/electron#25368), so a transparent window shows the desktop
    // through the sidebar until then. Paint an opaque base while minimized or
    // hidden so the deminiaturize animation and the reattachment gap show a
    // solid fill; restoring flips back, and the null -> 'sidebar' transition
    // forces the material to reattach.
    const applyBackdrop = (): void => {
      if (window.isDestroyed()) return
      if (window.isMinimized() || !window.isVisible()) {
        window.setVibrancy(null)
        window.setBackgroundColor(chromeFallbackFill())
      } else {
        window.setVibrancy('sidebar')
        window.setBackgroundColor('#00000000')
      }
    }
    window.on('minimize', applyBackdrop)
    window.on('hide', applyBackdrop)
    window.on('restore', applyBackdrop)
    window.on('show', applyBackdrop)
  }
  window.webContents.on('context-menu', (_event, { isEditable, selectionText, editFlags }) => {
    const items: MenuItemConstructorOptions[] = []
    if (isEditable) {
      items.push(
        { role: 'undo', enabled: editFlags.canUndo },
        { role: 'redo', enabled: editFlags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: editFlags.canCut },
        { role: 'copy', enabled: editFlags.canCopy },
        { role: 'paste', enabled: editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: editFlags.canSelectAll },
      )
    } else if (selectionText.length > 0) {
      items.push({ role: 'copy', enabled: editFlags.canCopy })
    }
    // Empty accelerators suppress Electron's default shortcut labels for native roles.
    if (items.length > 0) {
      const messages = currentDesktopLocale().messages
      Menu.buildFromTemplate(items.map(item => ({
        ...item,
        ...(process.platform === 'win32' && item.role !== undefined && item.role in messages
          ? { label: messages[item.role as keyof typeof messages] } : {}),
        accelerator: '',
      }))).popup({ window })
    }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const destination = new URL(url)
    const current = new URL(window.webContents.getURL())
    if (destination.protocol !== `${SCHEME}:`
      && !(destination.protocol === 'http:' && destination.origin === current.origin)) {
      event.preventDefault()
      if (['http:', 'https:'].includes(destination.protocol)) void shell.openExternal(url)
    }
  })
  return window
}

async function main(): Promise<void> {
  await Promise.all([removeLegacyKaifangCredentials(app.getPath('userData')), clearLoopbackHostAuthCookies()])
  const desktopSettings = readDesktopSettings(app.getPath('userData'))
  void pruneCrashReports(app.getPath('logs'))
  const journalDirectory = process.env.DSH_DESKTOP_UPDATE_JOURNAL_DIR
  const updateJournal = journalDirectory === undefined ? undefined : new DesktopUpdateJournal(journalDirectory, app.getVersion())
  const resources = runtimeResources()
  const paths = resolveDesktopPaths()
  const development = !app.isPackaged
  const primaryRuntime = development
    ? developmentPrimaryRuntime()
    : join(process.resourcesPath, 'runtime', 'primary-runtime')
  const activeProject = paths.profile
  const manager = new DesktopProjectManager(paths, resources)
  // Dock and Finder launches inherit only launchd's environment; every Host shares one login-shell read.
  const loginShellRead = new AbortController()
  // The probe runs in its own process group, which outlives Desktop unless the read is aborted.
  app.on('will-quit', () => { loginShellRead.abort() })
  const loginShell = readDesktopLoginShellEnvironment(process.env, resolveDesktopLoginShellConfig(process.env), {
    signal: loginShellRead.signal,
  }).then((result) => {
    for (const failure of result.failures) console.warn(`desktop login shell: ${failure.shell} failed (${failure.reason})`)
    return result.environment
  })
  let hostEnvironment: NodeJS.ProcessEnv = process.env
  const prepareHostEnvironment = async (): Promise<void> => { hostEnvironment = await loginShell }
  let quitting = false
  let startup: Promise<void> | undefined
  let workspaceRecovery: Promise<void> | undefined
  let mainWindow: BrowserWindow | undefined
  let welcomeWindow: BrowserWindow | undefined
  let sharedHarnessWindow: BrowserWindow | undefined
  let sharedHarnessWindowUrl: string | undefined
  let sharedHarnessActive = false
  const installFileDrag = (): (() => Promise<void>) => installDesktopFileDrag(
    event => assertProductSender(event),
    (address, signal) => {
      const host = backend.host
      if (host === undefined) return Promise.reject(new Error('File drag Host unavailable'))
      return host.resolveDragResource(address, signal)
    },
  )
  const fileDragCleanups = new Set([installFileDrag()])
  let fileDragStopped = false
  const disposeFileDrag = async (): Promise<void> => {
    fileDragStopped = true
    const results = await Promise.allSettled([...fileDragCleanups].map(async (release) => {
      await release()
      fileDragCleanups.delete(release)
    }))
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
  let enteredWorkspace = false
  /** Platform account published to the workspace AccountMenu via dshDesktop.kaifang. */
  let platformAccount: KaifangAccountView | undefined
  // NSIS passes --updated when it launches the application after installation.
  let raiseAfterUpdate = process.platform === 'win32' && process.argv.includes('--updated')
  let shellInstallerOwnsQuit = false
  let requireCleanStop = false
  let updateStoppedHost = false
  let updateStopFailure: DesktopHostUncleanExitError | undefined
  let updateState: DesktopUpdateState = { phase: 'idle' }
  const systemLanguages = app.getPreferredSystemLanguages()
  let locale = resolveDesktopStartupLocale(null, systemLanguages)
  windowsLanguage = locale.id
  let mandatoryPolicy: DesktopMandatoryUpdatePolicy | undefined
  let mandatoryUI: DesktopMandatoryUpdateWindow | undefined
  let policyAuth: DesktopPolicyTestAuth | undefined
  let tray: DesktopTray | undefined
  /**
   * The operating system is ending the session: the quit skips its confirmation. Windows sets it
   * on the definitive session-end message. macOS sets it on the power-off notification, which
   * another application can still cancel, so the next focus or show of the main window clears it.
   */
  let sessionEnding = false
  const isQuitting = (): boolean => quitting
  const currentMainWindow = (): BrowserWindow | undefined => mainWindow
  const ordinaryDialogs = new Set<AbortController>()
  const currentDialogWindow = (): BrowserWindow | undefined =>
    (sharedHarnessActive ? sharedHarnessWindow : undefined) ?? welcomeWindow ?? mainWindow
  const updateOverlays = new DesktopUpdateOverlays()
  const updateDialog = new DesktopUpdateDialog(fileURLToPath(new URL('./preload-update-dialog.cjs', import.meta.url)), () => locale, updateOverlays)
  const isMandatory = (): boolean => mandatoryPolicy?.state.blocking === true
  const ordinaryMessageBox = async (options: UpdateDialogOptions): Promise<Electron.MessageBoxReturnValue> => {
    const controller = new AbortController()
    ordinaryDialogs.add(controller)
    try {
      const parent = currentDialogWindow()
      if (parent === undefined) return { response: options.cancelId ?? 0, checkboxChecked: false }
      return await updateDialog.show(parent, { ...options, signal: controller.signal })
    }
    finally { ordinaryDialogs.delete(controller) }
  }
  // Copy comes from the same locale as the update prompts so the dialog
  // chrome and its content never mix languages.
  const showAbout = async (): Promise<void> => {
    await ordinaryMessageBox({ type: 'info', title: locale.messages.aboutMenu, message: locale.messages.aboutProduct,
      detail: formatDesktopMessage(locale.messages.aboutVersion, { version: app.getVersion() }),
      buttons: [locale.messages.updateAcknowledge], cancelId: 0 })
  }
  const commandManager = new DesktopCommandManager({
    resources: process.resourcesPath,
    isPackaged: app.isPackaged,
    isInstalledLocation: () => process.platform !== 'darwin' || app.isInApplicationsFolder(),
    isInstalling: () => updateState.phase === 'installing',
    isQuitting,
    messages: () => currentDesktopLocale().messages,
    show: ordinaryMessageBox,
  })
  const appPreload = fileURLToPath(new URL('./preload-app.cjs', import.meta.url))
  const applicationUrl = `${SCHEME}://app/`
  let hostUrl: string | undefined
  let hostCookie: string | undefined
  let localHostUrl: string | undefined
  let localHostCookie: string | undefined
  /** False while a shared Host Peer is available (dual-plane or exclusive Remote Client). */
  let ownsHostTransport = true
  /** Dual-plane: Platform session admitted to shared Host; sidebar shows 本机+云端. */
  let cloudOnline = false
  let activePlane: HostPlaneId = 'local'
  let sharedHostUrl: string | undefined
  let sharedHostCookie: string | undefined
  const useLocalHostTransport = (): void => {
    if (localHostUrl === undefined || localHostCookie === undefined) return
    hostUrl = localHostUrl
    hostCookie = localHostCookie
    ownsHostTransport = true
    cloudOnline = false
    activePlane = 'local'
    sharedHostUrl = undefined
    sharedHostCookie = undefined
  }
  const applyActivePlane = (): void => {
    if (!cloudOnline || sharedHostUrl === undefined || sharedHostCookie === undefined
      || localHostUrl === undefined || localHostCookie === undefined) {
      useLocalHostTransport()
      return
    }
    const planes = resolvePlaneHosts(activePlane, {
      localUrl: localHostUrl,
      localCookie: localHostCookie,
      cloudUrl: sharedHostUrl,
      cloudCookie: sharedHostCookie,
    })
    hostUrl = planes.active.hostUrl
    hostCookie = planes.active.hostCookie
    ownsHostTransport = activePlane === 'local'
  }
  const hostPlaneSnapshot = (): HostPlaneView => {
    const transport = desktopDualPlaneBoot({
      cloudOnline,
      activePlane,
      activeHostUrl: hostUrl ?? localHostUrl ?? 'http://127.0.0.1:0',
    })
    return {
      cloudOnline: transport.cloudOnline,
      activePlane: transport.activePlane,
      streamBaseUrl: transport.streamBaseUrl,
      ownsHost: transport.ownsHost,
      ...transport.sidecarApiPrefix === undefined ? {} : { sidecarApiPrefix: transport.sidecarApiPrefix },
    }
  }
  const publishHostPlane = (): HostPlaneView => {
    const view = hostPlaneSnapshot()
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(DESKTOP_IPC.hostPlaneChanged, view)
    }
    return view
  }
  const markCloudDisconnected = (): HostPlaneView => {
    const wasOnline = cloudOnline
    useLocalHostTransport()
    const view = publishHostPlane()
    if (wasOnline && mainWindow !== undefined && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(DESKTOP_IPC.cloudDisconnected)
    }
    return view
  }
  const setActiveHostPlane = (plane: HostPlaneId): HostPlaneView => {
    if (!cloudOnline) {
      activePlane = 'local'
      applyActivePlane()
      return publishHostPlane()
    }
    activePlane = plane
    applyActivePlane()
    return publishHostPlane()
  }
  /**
   * When Platform login is available and the shared Host is reachable, point the
   * native shell at that Host as a kaifang-user Peer (device ticket cookie).
   * Offline / unreachable Host keeps the owned local Desktop Host; callers that
   * enter the workspace while signed-in must surface a visible failure notice.
   */
  const activateSharedHostIfPossible = async (): Promise<SharedHostAttachResult> => {
    if (localHostUrl === undefined || localHostCookie === undefined) {
      return { ok: false, reason: 'host-unreachable', detail: 'local Desktop Host is not ready' }
    }
    const userData = app.getPath('userData')
    const platformOrigin = await readSharedHarnessUrl(userData)
    let session = platformOrigin === ''
      ? undefined
      : await readPlatformSession(userData, platformOrigin, Date.now())
    // Prefer a local refresh when near expiry, but do not abandon shared-Host
    // activation when refresh fails while the access token is still usable —
    // Host device admission can refresh via refresh_token itself.
    if (session !== undefined && session.expiresAt <= Date.now() + 60_000 && session.refreshToken !== '') {
      try {
        session = await refreshPlatformSession(session, (input, init) => fetch(input, init))
        await writePlatformSession(userData, session)
      } catch (error) {
        if (session.expiresAt <= Date.now()) {
          console.warn('desktop shared Host: platform session expired and refresh failed; trying device ticket anyway', error)
        } else {
          console.warn('desktop shared Host: local refresh failed; trying device ticket with current access token', error)
        }
      }
    }
    const result = await attachSharedHostRemoteClient({
      userData,
      platformOrigin,
      session: session === undefined
        ? undefined
        : {
          accessToken: session.accessToken,
          refreshToken: session.refreshToken,
          expiresAt: session.expiresAt,
          scopes: session.scopes,
        },
    })
    if (!result.ok) {
      useLocalHostTransport()
      if (result.reason !== 'no-platform' && result.reason !== 'no-session') {
        console.warn('desktop shared Host: attach failed; staying on local Host', result.reason, result.detail)
      }
      return result
    }
    if (result.tokens !== undefined && session !== undefined) {
      session = {
        ...session,
        accessToken: result.tokens.accessToken,
        refreshToken: result.tokens.refreshToken,
        expiresAt: result.tokens.expiresAt,
        scopes: result.tokens.scopes,
      }
      await writePlatformSession(userData, session)
    }
    sharedHostUrl = result.hostUrl
    sharedHostCookie = result.cookie
    cloudOnline = true
    // Dual-plane (B): default active plane is 本机 so new chats land locally; 云端 is sidecar.
    activePlane = 'local'
    applyActivePlane()
    console.info(
      'desktop shared Host: dual-plane online (active=local, cloud sidecar)',
      new URL(result.hostUrl).origin,
    )
    return result
  }
  const notifySharedHostAttachFailure = async (result: SharedHostAttachResult): Promise<void> => {
    if (!shouldNotifySharedHostAttachFailure(true, result)) return
    const message = result.ok
      ? ''
      : result.reason === 'device-ticket-failed'
        ? locale.messages.sharedHostOfflineTicketFailed
        : locale.messages.sharedHostOfflineUnreachable
    await ordinaryMessageBox({
      type: 'warning',
      title: locale.messages.sharedHostOfflineTitle,
      message,
      buttons: [locale.messages.updateAcknowledge],
      cancelId: 0,
      defaultId: 0,
    })
  }
  const browserGuests = new DesktopBrowserGuests(() => hostUrl)
  let injections: readonly unknown[] = []
  let welcomeBackend: DesktopWelcomeBackend | undefined
  let reportedLaunch = false
  let analyticsEnabled = false
  const track = async <K extends keyof ProductEventMap>(eventName: K, attributes: ProductEventMap[K]): Promise<void> => {
    const event = { eventName, attributes, timestamp: Date.now() } as ProductEvent
    try {
      if (analyticsEnabled) await welcomeBackend?.report(event)
    } catch (_error) { /* Analytics cannot interrupt native actions. */ }
  }
  let stopAccount: (() => void) | undefined
  let openedAttempt: string | undefined
  let returnedAttempt: string | undefined
  let previousAccountStatus: string | undefined
  const assertProductSender = (event: IpcMainInvokeEvent): BrowserWindow => {
    assertDesktopSender(event, ['app'])
    if (mainWindow === undefined || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents
      || event.senderFrame === null || event.senderFrame !== mainWindow.webContents.mainFrame) {
      throw new Error('dsh desktop: rejected IPC from an unowned renderer')
    }
    return mainWindow
  }
  let navigation: { window: BrowserWindow; url: string; promise: Promise<void> } | undefined
  const navigateMain = (url: string): Promise<void> => {
    const window = mainWindow
    if (quitting || window === undefined || window.isDestroyed()) return Promise.resolve()
    if (navigation?.window === window && navigation.url === url) return navigation.promise
    const next = { window, url, promise: Promise.resolve() }
    next.promise = window.loadURL(url).catch((error: unknown) => {
      if (quitting || shuttingDown || window.isDestroyed() || navigation !== next
        || (error instanceof Error && 'code' in error && error.code === 'ERR_ABORTED')) return
      navigation = undefined
      throw error
    })
    navigation = next
    return next.promise
  }
  const platformView = new DesktopPlatformView(join(app.getAppPath(), 'lib', 'preload-platform-account.cjs'),
    () => locale.id === 'zh-CN' ? 'zh_CN' : 'en_US', process.platform === 'win32' ? 'win32' : 'darwin',
    owner => isMandatory() || updateOverlays.input(owner).blocked)
  const backend = new DesktopBackendController((onFailure) => {
    const hostInspectPort = developmentHostInspectPort(development)
    const host = new DesktopHostProcess(resources.node, resources.dsh, activeProject,
      hostInspectPort, { ...hostEnvironment, DSH_CLIENT_VERSION: desktopClientVersion() }, onFailure,
      primaryRuntime,
      resources, (next) => { platformView.setSession(next) })
    return {
      start: async () => {
        const ready = await host.start()
        localHostCookie = await authenticateWebHost(ready.url)
        localHostUrl = ready.url
        hostCookie = localHostCookie
        hostUrl = localHostUrl
        ownsHostTransport = true
        if (ready.injections === undefined) throw new Error('Desktop Host did not provide boot injections')
        injections = ready.injections
        await activateSharedHostIfPossible()
        welcomeBackend = await connectDesktopWelcome(ready.url, (input, init) => net.fetch(input, init), async () => (await session.defaultSession.cookies.get({ url: ready.url })).map(cookie => `${cookie.name}=${cookie.value}`).join('; '))
        analyticsEnabled = await welcomeBackend.analyticsEnabled().catch(() => false)
        if (!reportedLaunch) { reportedLaunch = true; void track('desktop_app_launch', {}) }
        stopAccount?.()
        const accountBackend = welcomeBackend.account
        let initialAccountState = true
        stopAccount = accountBackend.watch((state) => {
          if (quitting) return
          const attempt = state.attempt
          if (initialAccountState) {
            initialAccountState = false
            previousAccountStatus = state.status
            if (attempt?.phase === 'waiting-browser') openedAttempt = attempt.id
            return
          }
          if (attempt?.phase === 'waiting-browser' && attempt.authorizeUrl !== undefined && openedAttempt !== attempt.id) {
            openedAttempt = attempt.id
            void shell.openExternal(attempt.authorizeUrl)
              .catch((error: unknown) => { console.error('desktop DeepSeek account: could not open authorization page', error) })
          }
          if ((attempt?.phase === 'failed' || attempt?.phase === 'expired') && returnedAttempt !== attempt.id) {
            returnedAttempt = attempt.id
            focusPrimaryWindow()
          }
          if (state.status === 'credential-stored' && attempt?.phase === 'succeeded' && welcomeWindow !== undefined) void enterWorkspace({ activate: false }).catch(() => undefined)
          if (previousAccountStatus === 'credential-stored' && state.status === 'signed-out') {
            void readWelcomeState().then(async (value) => {
              if (needsWelcome(value) && !quitting) {
                enteredWorkspace = false
                await showWelcome()
              }
              return undefined
            }).catch(() => undefined)
          }
          previousAccountStatus = state.status
        }, () => {
          // The stream reconnects; a transport failure does not change account state.
        }, () => {
          void readWelcomeState().then(async (value) => {
            if (!needsWelcome(value) || quitting) return
            enteredWorkspace = false
            await showWelcome()
          }).catch(() => undefined)
        }, (enabled) => { analyticsEnabled = enabled })
      },
      stop: async () => {
        analyticsEnabled = false
        stopAccount?.()
        try { await host.stop(requireCleanStop) }
        catch (error) {
          if (!requireCleanStop || !(error instanceof DesktopHostUncleanExitError)) throw error
          // Backend cleanup succeeded; installation still rejects the unsuccessful task teardown.
          updateStopFailure = error
        }
      },
      updateTasks: (action: 'inspect' | 'lock' | 'unlock') => host.updateTasks(action),
      inspectQuit: () => host.inspectQuit(),
      resolveDragResource: (address: string, signal?: AbortSignal) => host.resolveDragResource(address, signal),
    }
  }, (state) => {
    if (state.phase === 'error') reportFatal(state.failure, 'host')
    else if (!shuttingDown) backendReady = state.phase === 'ready'
  })

  const updateErrors = new WeakMap<DesktopUpdateState, Promise<void>>()
  const showUpdateFailure = (state: DesktopUpdateState): Promise<void> => {
    if (state.phase !== 'error') return Promise.resolve()
    if (isMandatory()) { mandatoryUI?.sync(); return Promise.resolve() }
    let shown = updateErrors.get(state)
    if (shown === undefined) {
      shown = ordinaryMessageBox({ type: 'error', title: locale.messages.updateFailedTitle,
        message: desktopUpdateErrorSummary(state, locale.messages),
        technicalDetails: state.technicalDetails ?? state.message ?? '' }).then(() => {})
      updateErrors.set(state, shown)
    }
    return shown
  }
  const publishUpdate = (state: DesktopUpdateState): DesktopUpdateState => {
    updateJournal?.state(state)
    updateState = state
    mandatoryUI?.sync()
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(DESKTOP_IPC.updatesPresentation, presentDesktopUpdate(state))
    }
    if (state.phase === 'error' && state.failedOperation !== 'check') {
      if (state.failedOperation === 'install' && fileDragStopped && !quitting) {
        fileDragCleanups.add(installFileDrag())
        fileDragStopped = false
      }
      const restoreHost = state.failedOperation === 'install' && updateStoppedHost && !quitting
      shellInstallerOwnsQuit = false
      updateStoppedHost = false
      if (restoreHost) {
        // Only confirmed process exit permits replacement before another installation confirmation.
        const hostReady = backend.start(prepareHostEnvironment)
        startup = hostReady
        const recovery = hostReady.then(async () => {
          if (quitting) return
          // A replacement Host can have a new port, cookie, or boot injections even at the same URL.
          navigation = undefined
          await navigateMain(applicationUrl)
          if (backend.host !== undefined) updateJournal?.action('workspace-ready')
        })
        workspaceRecovery = recovery
        void recovery.catch((error: unknown) => { reportFatal(error, 'main') }).finally(() => {
          if (startup === hostReady) startup = undefined
          if (workspaceRecovery === recovery) workspaceRecovery = undefined
        })
      }
      void showUpdateFailure(state).catch((error: unknown) => { console.error(error) })
    }
    return state
  }

  const readWelcomeState = async () => {
    if (backend.host === undefined || welcomeBackend === undefined) throw new Error('desktop welcome: backend unavailable')
    const state = await welcomeBackend.read()
    const platformOrigin = await readSharedHarnessUrl(app.getPath('userData'))
    let platformSignedIn = await hasPlatformSession(app.getPath('userData'), platformOrigin, Date.now())
    if (platformSignedIn) {
      const current = await readPlatformSession(app.getPath('userData'), platformOrigin, Date.now())
      if (current !== undefined && current.expiresAt <= Date.now() + 60_000) {
        try {
          const refreshed = await refreshPlatformSession(current, (input, init) => fetch(input, init))
          await writePlatformSession(app.getPath('userData'), refreshed)
        } catch (error) {
          // Keep signed-in when access is still usable; Host device ticket can refresh.
          // Only treat as signed-out when the access token is already dead.
          if (current.expiresAt <= Date.now()) {
            console.warn('desktop platform: stored session expired and refresh failed', error)
            platformSignedIn = false
          } else {
            console.warn('desktop platform: could not refresh early; keeping signed-in for shared Host', error)
          }
        }
      }
    }
    return { ...state, platformSignedIn }
  }
  stopForRecovery = () => backend.close()

  const reconcileBackend = (): Promise<void> => {
    startup ??= (async () => {
      await navigateMain(applicationUrl)
      await backend.start(async () => {
        await Promise.all([manager.applyRelease(), prepareHostEnvironment()])
      })
      if (backend.host !== undefined) await openInitialWindow()
      if (backend.host !== undefined) updateJournal?.action('workspace-ready')
      // The existing Web document resumes through the boot IPC response.
    })().catch((error: unknown) => {
      updateJournal?.action('workspace-failed')
      reportFatal(error, 'main')
      throw error
    }).finally(() => { startup = undefined })
    return startup
  }

  const manifest: unknown = JSON.parse(await readFile(join(app.getAppPath(), 'package.json'), 'utf8'))
  const updateChannel = desktopUpdateChannel(manifest)
  const updates = new DesktopUpdateCoordinator(
    publishUpdate,
    async () => {
      await commandManager.idle()
      await workspaceRecovery
      await startup?.catch(() => undefined)
      const host = backend.host
      if (host === undefined) throw new DesktopUpdatePreparationError('tasks-unavailable', locale.messages.updateTasksUnavailable)
      const active = await host.updateTasks('inspect')
      const parent = currentDialogWindow()
      if (parent === undefined || !await prepareDesktopUpdateWindow(parent, locale.messages.updateFullscreenTimeout)) return false
      const ready = desktopUpdateReadyConfirmation(locale.messages, updates.state.version ?? '', process.platform)
      const confirmation: Electron.MessageBoxOptions = {
        type: active ? 'warning' : 'info', title: locale.messages.updateTitle,
        message: active ? locale.messages.updateActiveTasks : ready.message,
        detail: active ? locale.messages.updateActiveTasksDetail : ready.detail,
        buttons: active ? [locale.messages.updateStopTasks, locale.messages.updateLater] : [locale.messages.installAndRestart],
        defaultId: 1, cancelId: 1,
      }
      if (isMandatory()) {
        if (!await mandatoryUI?.confirm(updates.state.version ?? '', active)) return false
      } else {
        const result = await updateDialog.show(parent, confirmation)
        if (result.response !== 0 || isMandatory()) return false
      }
      // The update lock rejects new HTTP requests, including analytics intake.
      await track('desktop_upgrade_install_restart_click', {})
      if (backend.host !== host) throw new DesktopUpdatePreparationError('tasks-unavailable', locale.messages.updateTasksUnavailable)
      try {
        const stillActive = await host.updateTasks('lock')
        if (stillActive && !active) throw new DesktopUpdatePreparationError('tasks-changed', locale.messages.updateTasksChanged)
        mandatoryUI?.preparingRestart(stillActive)
        // The embedded Platform document holds credentials issued by the Host that is about to stop.
        await platformView.closeAndWait()
        await disposeFileDrag().catch((error: unknown) => { console.error(error) })
        requireCleanStop = true
        updateStopFailure = undefined
        await backend.stop()
        updateStoppedHost = true
        // The backend's async cleanup callback can assign this after the reset above.
        const stopFailure = updateStopFailure as DesktopHostUncleanExitError | undefined
        if (stopFailure !== undefined) throw new DesktopUpdatePreparationError('stop-failed', locale.messages.updateStopFailed, stopFailure.message)
        updateJournal?.action('install-confirmed')
        shellInstallerOwnsQuit = true
      } catch (error) {
        if (!updateStoppedHost) await host.updateTasks('unlock').catch((unlockError: unknown) => { console.error(unlockError) })
        throw error
      } finally {
        requireCleanStop = false
      }
      return true
    },
    undefined, undefined, undefined,
    (success, reason) => { void track('desktop_upgrade_download_result', { is_success: success, ...reason === undefined ? {} : { error_reason: reason } }) },
    updateChannel,
  )

  const updateSchedule = new DesktopUpdateSchedule(updates, resolveDesktopUpdateScheduleConfig(process.env))

  const downloadUpdate = async (version: string): Promise<DesktopUpdateState> => {
    void track('desktop_upgrade_click', {})
    updateJournal?.action('download-requested')
    const state = await updates.download(version)
    if (state.phase !== 'ready' || quitting) return state
    // Only a completed user-driven download opens this prompt; cancelling installation does not reopen it.
    // A confirmation on a hidden window would go unseen, so it waits for the next show; the mandatory
    // flow keeps its own taskbar and Dock attention instead.
    if (!isMandatory()) await windowShown()
    if (quitting) return state
    return updates.install(version)
  }
  const windowShown = (): Promise<void> => new Promise((resolve) => {
    const window = currentDialogWindow()
    if (window === undefined || window.isDestroyed() || window.isVisible()) { resolve(); return }
    window.once('show', () => { resolve() })
    window.once('closed', () => { resolve() })
  })

  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url)
    // Shell-owned documents live in the application bundle and never pass through the Host.
    if (url.hostname === 'shell') return serveWebDocument(request, join(app.getAppPath(),
      url.pathname === '/design-platform.css' ? 'lib/welcome' : 'renderer'))
    if (url.hostname === 'app') {
      if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname.startsWith('/assets/')
        || ['/favicon.svg', '/manifest.webmanifest'].includes(url.pathname)) {
        return serveWebDocument(request, join(resources.dsh, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist'))
      }
      if (backend.host === undefined || hostUrl === undefined || hostCookie === undefined) {
        return Promise.resolve(new Response(null, { status: 503 }))
      }
      // Online Remote Client: plugin bundles stay on the owned Desktop Host (boot
      // injections); /api and auth status use the shared Host kaifang-user Peer.
      const sidecar = cloudOnline && sharedHostUrl !== undefined && sharedHostCookie !== undefined
        && localHostUrl !== undefined && localHostCookie !== undefined
        ? resolvePlaneHosts(activePlane, {
          localUrl: localHostUrl,
          localCookie: localHostCookie,
          cloudUrl: sharedHostUrl,
          cloudCookie: sharedHostCookie,
        }).sidecar
        : undefined
      const forward = resolveDesktopHostForward(url.pathname, {
        ownsHost: ownsHostTransport,
        activeHostUrl: hostUrl,
        activeHostCookie: hostCookie,
        ...localHostUrl === undefined || localHostCookie === undefined
          ? {}
          : { localHostUrl, localHostCookie },
        ...sidecar === undefined ? {} : { sidecarHostUrl: sidecar.hostUrl, sidecarHostCookie: sidecar.hostCookie },
      })
      if (forward === undefined) return Promise.resolve(new Response(null, { status: 503 }))
      return forwardWebRequest(request, forward.hostUrl, forward.hostCookie, forward.pathname)
    }
    return Promise.resolve(new Response(null, { status: 404 }))
  })

  installDesktopDirectoryPicker(() => mainWindow)
  installMicrophonePermissions(session.defaultSession, () => mainWindow?.webContents)
  const shortcuts = installDesktopShortcuts(() => mainWindow, app.getPath('userData'),
    process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux', () => { refreshApplicationMenu() }, window => updateOverlays.input(window))
  app.on('will-quit', () => { shortcuts.dispose() })

  ipcMain.handle(DESKTOP_IPC.boot, async (event) => {
    assertDesktopSender(event, ['app'])
    await startup
    if (backend.host === undefined || hostUrl === undefined) throw new Error('Desktop Host is unavailable')
    const transport = desktopDualPlaneBoot({
      cloudOnline,
      activePlane,
      activeHostUrl: hostUrl,
    })
    if (!desktopFollowTransportAligned({
      ownsHost: transport.ownsHost,
      streamBaseUrl: transport.streamBaseUrl,
      activeHostUrl: hostUrl,
    })) {
      throw new Error('dsh desktop: follow streamBaseUrl is not aligned with the active Host')
    }
    return {
      injections,
      streamBaseUrl: transport.streamBaseUrl,
      ownsHost: transport.ownsHost,
      cloudOnline: transport.cloudOnline,
      activePlane: transport.activePlane,
      ...transport.sidecarApiPrefix === undefined ? {} : { sidecarApiPrefix: transport.sidecarApiPrefix },
    }
  })

  ipcMain.handle(DESKTOP_IPC.showSignIn, async (event) => {
    assertProductSender(event)
    await openingWelcome
    if (welcomeWindow !== undefined && !welcomeWindow.isDestroyed()) {
      // A sign-in request starts at the choice page, even if Welcome was left in Settings.
      welcomeWindow.destroy()
      welcomeWindow = undefined
    }
    await showWelcome(false, true)
  })

  ipcMain.handle(DESKTOP_IPC.bootFailed, (event, message: unknown) => {
    assertDesktopSender(event, ['app'])
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('dsh desktop: rejected startup failure from a non-primary frame')
    }
    if (typeof message !== 'string') throw new Error('dsh desktop: startup failure must be text')
    reportFatal(new Error(message), 'web-boot')
  })

  ipcMain.handle(DESKTOP_IPC.browserAcquire, (event, workspace: unknown) => {
    assertProductSender(event)
    return browserGuests.acquire(event.sender, workspace)
  })
  ipcMain.handle(DESKTOP_IPC.browserRelease, (event, lease: unknown) => {
    assertProductSender(event)
    return browserGuests.release(event.sender, lease)
  })

  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['ws://*/*', 'wss://*/*'] }, (details, callback) => {
    if (details.webContentsId !== mainWindow?.webContents.id) {
      callback({})
      return
    }
    const requested = new URL(details.url)
    const candidates: { url: string; cookie: string }[] = []
    if (hostUrl !== undefined && hostCookie !== undefined) candidates.push({ url: hostUrl, cookie: hostCookie })
    if (sharedHostUrl !== undefined && sharedHostCookie !== undefined) {
      candidates.push({ url: sharedHostUrl, cookie: sharedHostCookie })
    }
    if (localHostUrl !== undefined && localHostCookie !== undefined) {
      candidates.push({ url: localHostUrl, cookie: localHostCookie })
    }
    const matched = candidates.find((candidate) => {
      const target = new URL(candidate.url)
      return requested.host === target.host
        && requested.protocol === (target.protocol === 'https:' ? 'wss:' : 'ws:')
    })
    if (matched === undefined) { callback({}); return }
    const headers = Object.fromEntries(Object.entries(details.requestHeaders).map(([name, value]) => [name.toLowerCase(), value]))
    if (headers.origin !== 'dsh-app://app') { callback({ cancel: true }); return }
    const target = new URL(matched.url)
    callback({ requestHeaders: { ...headers, origin: target.origin, cookie: matched.cookie, 'sec-fetch-site': 'same-origin' } })
  })

  const assertMainApplication = (event: IpcMainInvokeEvent): BrowserWindow => {
    const owner = mainWindow
    if (owner === undefined || event.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame
      || !event.senderFrame.url.startsWith('dsh-app://app/')) throw new Error('Rejected Platform command')
    return owner
  }
  ipcMain.on(PLATFORM_IPC.bootstrap, (event) => {
    try { event.returnValue = platformView.bootstrap(event) }
    catch { event.returnValue = null }
  })
  ipcMain.handle(PLATFORM_IPC.open, (event, page: unknown, bounds: unknown) => {
    const owner = assertMainApplication(event)
    if (page !== 'usage' && page !== 'top-up') throw new Error('Invalid Platform page')
    return platformView.open(owner, page, platformBounds(bounds))
  })
  ipcMain.handle(PLATFORM_IPC.bounds, (event, bounds: unknown) => {
    assertMainApplication(event)
    platformView.setBounds(platformBounds(bounds))
  })
  ipcMain.handle(PLATFORM_IPC.close, (event) => { assertMainApplication(event); platformView.close() })
  // Only the main window may synchronize its palette with the native material.
  ipcMain.on(DESKTOP_IPC.nativeThemeSet, (event, source: unknown) => {
    if (mainWindow === undefined || event.sender !== mainWindow.webContents) return
    if (source === 'light' || source === 'dark' || source === 'system') nativeTheme.themeSource = source
  })
  ipcMain.handle(DESKTOP_IPC.localeBootstrap, async (event) => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame
      || new URL(event.senderFrame.url).origin !== new URL(applicationUrl).origin) {
      throw new Error('desktop welcome: rejected locale request from an unowned frame')
    }
    if (welcomeBackend === undefined) throw new Error('desktop welcome: backend unavailable')
    return { languages: systemLanguages, preference: await welcomeBackend.readLocalePreference() }
  })
  ipcMain.on(DESKTOP_IPC.localeChanged, (event, next: unknown) => {
    const window = mainWindow
    if (window === undefined || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
      || typeof next !== 'string') return
    const current = resolveDesktopStartupLocale(next, systemLanguages)
    if (current.id === locale.id) return
    locale = current
    platformView.notifyLocaleChanged()
    windowsLanguage = locale.id
    refreshApplicationMenu()
  })
  ipcMain.handle(DESKTOP_IPC.updatesStatus, (event) => {
    assertProductSender(event)
    return presentDesktopUpdate(updates.state)
  })
  ipcMain.handle(DESKTOP_IPC.deviceInfo, (event) => {
    assertProductSender(event)
    return readDeviceInfo()
  })
  ipcMain.handle(DESKTOP_IPC.onboardingApiKey, async (event) => {
    assertProductSender(event)
    // Online shared Host already exposes KaifangMeta platform models via device ticket;
    // do not force a local provider API key for onboarding/credential checks.
    return desktopHasModelCredentials({
      sharedHostOnline: !ownsHostTransport,
      localHasApiKey: (await readWelcomeState()).hasApiKey,
    })
  })
  ipcMain.on(DESKTOP_IPC.onboardingActive, (event, active: unknown) => {
    const window = mainWindow
    if (window === undefined || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame
      || !event.senderFrame.url.startsWith(`${SCHEME}://app/`) || typeof active !== 'boolean') return
    window.setMinimumSize(active ? 960 : 520, 600)
    if (active) {
      const { width, height } = window.getBounds()
      if (width < 960) window.setSize(960, height)
    }
  })
  ipcMain.handle(DESKTOP_IPC.updatesOpen, async (event) => {
    assertProductSender(event)
    await openUpdatePrompt()
  })

  let promptOperation: Promise<void> | undefined
  let policyAuthenticationQueued = false
  const openUpdatePrompt = (manual = false): Promise<void> => {
    if (authenticationOperation !== undefined) {
      policyAuth?.focus(); updateDialog.focus()
    }
    let failedOperation: 'check' | 'download' | 'install' = 'check'
    promptOperation ??= Promise.resolve().then(async () => {
      if (manual) updateJournal?.action('check-requested')
      const joinedPolicyAuthentication = authenticationOperation !== undefined
      if (joinedPolicyAuthentication) await authenticatePolicy()
      if (isMandatory()) {
        mandatoryUI?.focus()
        if (manual) await Promise.all([checkPolicyManually(), updateSchedule.check(true)])
        return
      }
      let controller: AbortController | undefined
      let progress: Promise<unknown> | undefined
      try {
        let state = updates.state
        if (manual || state.phase === 'idle' || (state.phase === 'error' && state.failedOperation === 'check')) {
          controller = new AbortController()
          ordinaryDialogs.add(controller)
          const parent = currentDialogWindow()
          progress = parent === undefined ? Promise.resolve() : updateDialog.show(parent, { type: 'info', title: locale.messages.updateCheckTitle,
            message: locale.messages.updateChecking, buttons: [locale.messages.later], cancelId: 0, signal: controller.signal })
          if (!joinedPolicyAuthentication) {
            void checkPolicyManually('deferred').catch((error: unknown) => { console.error(error) })
          }
          state = await updateSchedule.check(true)
        }
        if (isMandatory()) { mandatoryUI?.focus(); return }
        if (state.phase === 'error' && state.failedOperation === 'check') { await showUpdateFailure(state); return }
        if (state.phase === 'idle') {
          await ordinaryMessageBox({ type: 'info', title: locale.messages.updateCheckTitle,
            message: locale.messages.updateCurrent,
            detail: formatDesktopMessage(locale.messages.updateCurrentDetail, { version: app.getVersion() }) })
          return
        }
        if (state.phase === 'ready' || (state.phase === 'error' && state.failedOperation === 'install')) {
          if (state.version !== undefined) {
            failedOperation = 'install'
            await showUpdateFailure(await updates.install(state.version))
          }
          return
        }
        if (state.phase !== 'available' && !(state.phase === 'error' && state.failedOperation === 'download')) return
        if (manual) {
          const result = await ordinaryMessageBox({ title: locale.messages.updateCheckTitle,
            message: formatDesktopMessage(locale.messages.updateAvailable, { version: state.version ?? '' }),
            detail: locale.messages.updateDetail,
            buttons: [locale.messages.updateDownload], cancelId: 1 })
          if (result.response !== 0) return
        }
        if (!isMandatory() && state.version !== undefined) {
          controller?.abort()
          failedOperation = 'download'
          await showUpdateFailure(await downloadUpdate(state.version))
        }
      } finally {
        controller?.abort()
        if (controller !== undefined) ordinaryDialogs.delete(controller)
        await progress
      }
    }).catch((error: unknown) => showUpdateFailure({ phase: 'error', failedOperation,
      message: desktopErrorState(error).message }))
      .finally(() => { promptOperation = undefined; flushQueuedPolicyAuthentication() })
    return promptOperation
  }

  let authenticationOperation: Promise<DesktopPolicyState | undefined> | undefined
  const authenticatePolicy = () => {
    if (authenticationOperation !== undefined) { policyAuth?.focus(); updateDialog.focus() }
    authenticationOperation ??= runPolicyAuthentication().finally(() => { authenticationOperation = undefined })
    return authenticationOperation
  }
  const flushQueuedPolicyAuthentication = (): void => {
    if (!policyAuthenticationQueued || promptOperation !== undefined || authenticationOperation !== undefined
      || isMandatory() || quitting) return
    policyAuthenticationQueued = false
    void authenticatePolicy().catch((error: unknown) => { console.error(error) })
  }
  const queuePolicyAuthentication = (): void => {
    if (!desktopSettings.updates.allowTestAuthPopupWindow) return
    if (authenticationOperation !== undefined) {
      policyAuth?.focus(); updateDialog.focus()
      return
    }
    policyAuthenticationQueued = true
    flushQueuedPolicyAuthentication()
  }
  const runPolicyAuthentication = async () => {
    if (!desktopSettings.updates.allowTestAuthPopupWindow
      || policyAuth === undefined || mandatoryPolicy === undefined || quitting) return undefined
    const parent = mandatoryUI?.confirmationWindow ?? currentDialogWindow()
    if (parent === undefined) return undefined
    const consent = await updateDialog.show(parent, { type: 'info', title: locale.messages.policyLoginTitle,
      message: locale.messages.policyLoginRequired, buttons: [locale.messages.policyLogin, locale.messages.later], cancelId: 1 })
    if (consent.response !== 0 || isQuitting()) return undefined
    const outcome = await policyAuth.login()
    if (isQuitting() || outcome === 'cancelled') return undefined
    if (outcome === 'failed') {
      await updateDialog.show(parent, { type: 'error', title: locale.messages.policyLoginTitle,
        message: locale.messages.policyLoginFailed, buttons: [locale.messages.updateAcknowledge], cancelId: 0 })
      return undefined
    }
    // Drain a pre-login request before asking the server to evaluate the new cookies.
    await mandatoryPolicy.check('login-return')
    if (isQuitting()) return undefined
    return mandatoryPolicy.check('login-return', true)
  }

  const checkPolicyManually = async (authentication: 'immediate' | 'deferred' = 'immediate') => {
    if (authenticationOperation !== undefined) return authenticatePolicy()
    const policy = await mandatoryPolicy?.check('manual', true)
    if (policy?.error !== 'authentication-required' || !desktopSettings.updates.allowTestAuthPopupWindow) return policy
    if (authentication === 'immediate') return authenticatePolicy()
    queuePolicyAuthentication()
    return policy
  }

  const automaticCheck = (): void => {
    if (!quitting) void mandatoryPolicy?.check('foreground-or-resume').catch((error: unknown) => { console.error(error) })
    if (!quitting) void updateSchedule.check().catch((error: unknown) => { console.error(error) })
  }
  powerMonitor.on('resume', automaticCheck)
  app.on('will-quit', () => {
    updateSchedule.dispose()
    powerMonitor.off('resume', automaticCheck)
    updates.dispose()
  })

  const applicationIconPath = development ? join(app.getAppPath(), 'resources', 'icon-windows.png')
    : join(process.resourcesPath, 'icon.png')
  app.setAboutPanelOptions({
    applicationName: 'DeepSeek Harness',
    applicationVersion: app.getVersion(),
    // The release has no separate build number; omit Electron's bundle version.
    version: '',
    copyright: '',
    iconPath: applicationIconPath,
  })
  // A custom application menu replaces Electron's default menu, so macOS needs
  // its standard menus and application hide commands declared explicitly.
  // Keep app.name stable: Electron derives its default userData directory from it.
  const darwin = process.platform === 'darwin'
  const platformMenus = (): MenuItemConstructorOptions[] => darwin
    ? [shortcuts.fileMenu(currentDesktopLocale().messages), { role: 'editMenu' }, { role: 'windowMenu' }]
    : [{ role: 'editMenu' }]
  const hideCommands: MenuItemConstructorOptions[] = darwin
    ? [{ role: 'hide', label: currentDesktopLocale().messages.hideApplication },
      { role: 'hideOthers', label: currentDesktopLocale().messages.hideOtherApplications },
      { role: 'unhide', label: currentDesktopLocale().messages.showAllApplications }, { type: 'separator' }]
    : []
  const applicationItems = (): MenuItemConstructorOptions[] => [
    { label: currentDesktopLocale().messages.openApplication, click: () => {
      focusPrimaryWindow()
    } },
    { label: currentDesktopLocale().messages.sharedHarnessSettingsMenu, click: () => { void showSharedHarnessSettings() } },
    { label: currentDesktopLocale().messages.openSharedHarnessMenu, click: () => {
      void openSharedHarness().then((opened) => { if (!opened) return showSharedHarnessSettings() })
        .catch((error: unknown) => { console.error(error) })
    } },
    { label: currentDesktopLocale().messages.openLocalWorkspaceMenu, click: () => {
      void (backend.state.phase === 'ready' ? enterWorkspace() : reconcileBackend().then(() => enterWorkspace()))
        .catch((error: unknown) => { reportFatal(error, 'main') })
    } },
    { type: 'separator' },
    // Windows has no system About panel; Electron's fallback is a plain
    // message box, so the shell shows its own dimmed dialog instead.
    process.platform === 'win32'
      ? { label: currentDesktopLocale().messages.aboutMenu,
        click: () => { void showAbout().catch((error: unknown) => { console.error(error) }) } }
      : { label: currentDesktopLocale().messages.aboutMenu, role: 'about' },
    { type: 'separator' },
    ...platformAccount !== undefined ? [{ label: currentDesktopLocale().messages.kaifangSignOutMenu, click: requestPlatformSignOut },
      { type: 'separator' as const }] : [],
    { label: currentDesktopLocale().messages.checkUpdatesMenu, click: () => { void openUpdatePrompt(true) } },
    ...process.platform === 'darwin' || process.platform === 'win32'
      ? [{ label: currentDesktopLocale().messages.cliCommandMenu, click: () => { void commandManager.show() } }] : [],
    ...development ? [
      { type: 'separator' as const },
      { label: currentDesktopLocale().messages.reloadPageMenu, role: 'reload' as const },
      { label: currentDesktopLocale().messages.restartAppHostMenu, click: () => {
        if (quitting) return
        app.relaunch()
        quitWithoutConfirmation()
      } },
    ] : [],
    { type: 'separator' },
    ...hideCommands,
    { role: 'quit', ...(darwin ? { label: currentDesktopLocale().messages.quitApplication }
      : process.platform === 'win32' ? { label: currentDesktopLocale().messages.exitApplication } : {}) },
  ]
  const devToolsItems: MenuItemConstructorOptions[] = [
    { role: 'toggleDevTools', visible: false },
    { role: 'toggleDevTools', visible: false, accelerator: 'F12' },
  ]
  const refreshApplicationMenu = (): void => {
    Menu.setApplicationMenu(Menu.buildFromTemplate(process.platform === 'win32' ? devToolsItems : [{
      label: darwin ? app.name : currentDesktopLocale().messages.application,
      submenu: [...applicationItems(), ...devToolsItems],
    }, ...platformMenus()]))
    tray?.relabel()
  }
  refreshApplicationMenu()
  const trayIconPath = development ? join(app.getAppPath(), 'resources', 'tray-windows.ico') : join(process.resourcesPath, 'tray.ico')
  if (process.platform === 'win32') {
    // The tray is the way back to a hidden window; without it, relaunching the application still focuses it.
    try {
      tray = new DesktopTray({ iconPath: trayIconPath, locale: currentDesktopLocale,
        open: () => { focusPrimaryWindow() }, quit: () => { app.quit() } })
    } catch (error) { console.warn('desktop tray: unavailable', error) }
  }
  const backgroundNotice = process.platform === 'win32'
    ? new DesktopBackgroundNotice({ markerPath: join(app.getPath('userData'), 'background-close-confirmed'),
      locale: () => locale, show: ordinaryMessageBox, focus: () => { updateDialog.focus() } })
    : undefined
  const quitConfirmation = new DesktopQuitConfirmation({
    locale: () => locale,
    inspect: () => backend.host?.inspectQuit(),
    // No owner window: a hidden window stays hidden and the native box is its own top-level window.
    show: options => dialog.showMessageBox(options),
    // macOS raises the open alert with the application; Electron exposes no handle to the Windows task
    // dialog, so a repeated request there only joins the open decision.
    focus: () => { if (process.platform === 'darwin') app.focus({ steal: true }) },
    // The task dialog draws its main icon at the system icon size; the multi-size ICO yields that
    // size directly, where the 1024 px PNG would be scaled down by GDI.
    ...(process.platform === 'win32' ? { icon: nativeImage.createFromPath(trayIconPath) } : {}),
  })

  if (process.platform === 'win32') {
    ipcMain.handle(DESKTOP_IPC.windowsMenu, (event, name: unknown, x: unknown, y: unknown) => {
      assertDesktopSender(event, ['app'])
      if (mainWindow === undefined || event.sender !== mainWindow.webContents
        || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('desktop menu: rejected sender')
      if ((name !== 'application' && name !== 'edit')
        || typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)
        || x < 0 || y < 0 || x > 100_000 || y > 100_000) throw new Error('desktop menu: invalid popup request')
      const window = mainWindow
      // Editor-owned history listens to key events rather than Chromium's native undo stack.
      const editItem = (label: string, keyCode: string, modifiers: Array<'control'>, accelerator?: string): MenuItemConstructorOptions => ({
        label,
        ...(accelerator === undefined ? {} : { accelerator }),
        click: () => {
          shortcuts.sendEditingKey(keyCode, modifiers)
        },
      })
      const items: MenuItemConstructorOptions[] = name === 'application' ? applicationItems() : [
        editItem(currentDesktopLocale().messages.undo, 'Z', ['control'], 'Ctrl+Z'),
        editItem(currentDesktopLocale().messages.redo, 'Y', ['control'], 'Ctrl+Y'),
        { type: 'separator' },
        editItem(currentDesktopLocale().messages.cut, 'X', ['control'], 'Ctrl+X'),
        editItem(currentDesktopLocale().messages.copy, 'C', ['control'], 'Ctrl+C'),
        editItem(currentDesktopLocale().messages.paste, 'V', ['control'], 'Ctrl+V'),
        editItem(currentDesktopLocale().messages.delete, 'Delete', []),
        { type: 'separator' },
        editItem(currentDesktopLocale().messages.selectAll, 'A', ['control'], 'Ctrl+A'),
      ]
      const zoom = mainWindow.webContents.getZoomFactor()
      return new Promise<void>((resolve) => {
        Menu.buildFromTemplate(items).popup({ window, x: Math.round(x * zoom), y: Math.round(y * zoom), callback: resolve })
      })
    })
    ipcMain.on(DESKTOP_IPC.windowsAppearance, (event, language: unknown, color: unknown, symbolColor: unknown) => {
      if (mainWindow === undefined || event.sender !== mainWindow.webContents
        || event.senderFrame !== mainWindow.webContents.mainFrame) return
      if (!event.senderFrame.url.startsWith(`${SCHEME}://app/`)) return
      if (typeof language === 'string' && /^[a-zA-Z]+(?:-[a-zA-Z0-9]+)*$/u.test(language)) {
        windowsLanguage = language
      }
      // Empty colors precede client stylesheet installation; only CSS color values cross IPC.
      const validColor = (value: unknown): value is string => typeof value === 'string'
        && /^(?:#[\da-f]{3,8}|rgba?\([\d.,%\s]+\))$/iu.test(value)
      if (validColor(color) && validColor(symbolColor)) mainWindow.setTitleBarOverlay({ color, symbolColor })
    })
  }

  const hideMainWindow = (window: BrowserWindow): void => {
    if (process.platform === 'darwin' && window.isFullScreen()) {
      // Hiding a fullscreen window leaves an empty black space; leave fullscreen first.
      window.once('leave-full-screen', () => { if (!window.isDestroyed()) window.hide() })
      window.setFullScreen(false)
    } else {
      window.hide()
    }
  }
  const createMainWindow = (): BrowserWindow => {
    const window = createWindow(appPreload, false, true)
    mainWindow = window
    browserGuests.bind(window, (guest, name) => shortcuts.attachGuest(window, guest, name))
    shortcuts.attach(window)
    window.on('focus', automaticCheck)
    // Closing hides: the page and the Host keep running, and the next show resumes the same document.
    window.on('close', (event) => {
      if (quitting || shellInstallerOwnsQuit || sessionEnding) return
      event.preventDefault()
      if (updateDialog.isOpen) { updateDialog.focus(); return }
      const hide = (): void => {
        if (!quitting && !shellInstallerOwnsQuit && !sessionEnding && !window.isDestroyed()) hideMainWindow(window)
      }
      if (backgroundNotice === undefined) hide()
      else backgroundNotice.close(hide)
    })
    if (process.platform === 'win32') {
      // Shutdown, restart, and log-off must not wait on a confirmation. query-session-end is only a
      // question that another application can veto without any follow-up message, so it does not count.
      window.on('session-end', () => { sessionEnding = true })
    } else {
      // The macOS power-off notification arrives before the terminate request; a cancelled shutdown
      // leaves the process running, and user attention on the window shows the session continues.
      window.on('focus', () => { sessionEnding = false })
      window.on('show', () => { sessionEnding = false })
    }
    window.on('closed', () => { if (mainWindow === window) mainWindow = undefined })
    window.webContents.on('console-message', (details) => {
      if (details.level !== 'error') return
      rendererConsole.push(`${details.sourceId}:${String(details.lineNumber)} ${details.message}`)
    })
    window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3 && !quitting && !window.isDestroyed()) {
        reportFatal(new Error(`Desktop page failed to load: ${url} (${String(code)}: ${description})`), 'renderer')
      }
    })
    window.webContents.on('preload-error', (_event, _path, error) => {
      if (!quitting && !window.isDestroyed()) reportFatal(error, 'renderer')
    })
    window.webContents.on('render-process-gone', (_event, details) => {
      navigation = undefined
      if (!quitting && !window.isDestroyed() && details.reason !== 'clean-exit') {
        reportFatal(new Error(`Desktop renderer exited: ${details.reason}`), 'renderer')
      }
    })
    return window
  }
  const enterWorkspace = async ({ activate = true }: { activate?: boolean } = {}): Promise<void> => {
    if (quitting) return
    // Cold start / already-logged-in: attach Remote Client before the shell
    // document boots so sessions/models sync without a logout→login cycle.
    // Retry even when an earlier Host-down attempt left us on the local Host.
    let switchedToSharedHost = false
    if (ownsHostTransport) {
      const attached = await activateSharedHostIfPossible()
      switchedToSharedHost = attached.ok
      if (!attached.ok) {
        const platformOrigin = await readSharedHarnessUrl(app.getPath('userData'))
        const session = platformOrigin === ''
          ? undefined
          : await readPlatformSession(app.getPath('userData'), platformOrigin, Date.now())
        if (session !== undefined && session.expiresAt <= Date.now() && session.refreshToken === '') {
          console.warn('desktop shared Host: stored platform session is expired; prompting sign-in')
          await showPlatformSignIn()
          return
        }
        // Signed-in but still on local Host: never look "online" without saying so.
        if (session !== undefined) await notifySharedHostAttachFailure(attached)
      }
    }
    const window = mainWindow ?? createMainWindow()
    // Remount only when activation moved local → shared Host Peer world.
    if (switchedToSharedHost) navigation = undefined
    await navigateMain(applicationUrl)
    if (isQuitting() || recovery.active || window.isDestroyed()) return
    if (activate) window.show()
    else window.showInactive()
    enteredWorkspace = true
    sharedHarnessActive = false
    if (sharedHarnessWindow !== undefined && !sharedHarnessWindow.isDestroyed()) sharedHarnessWindow.destroy()
    const welcome = welcomeWindow
    welcomeWindow = undefined
    if (welcome !== undefined && !welcome.isDestroyed()) {
      welcome.close()
    }
    if (!window.isDestroyed()) window.webContents.send(DESKTOP_IPC.enterWorkspace)
    if (raiseAfterUpdate) {
      raiseAfterUpdate = false
      window.moveTop()
      window.focus()
    }
    if (activate && development && process.env.DSH_DESKTOP_OPEN_DEVTOOLS !== '0') {
      window.webContents.openDevTools({ mode: 'detach' })
    }
  }
  openSharedHarness = async (): Promise<boolean> => {
    if (quitting) return false
    const url = await readSharedHarnessUrl(app.getPath('userData'))
    if (url === '') return false
    let window = sharedHarnessWindow
    if (window === undefined || window.isDestroyed()) {
      const created = createSharedHarnessWindow(url)
      window = created
      sharedHarnessWindow = created
      sharedHarnessWindowUrl = url
      created.on('focus', automaticCheck)
      created.on('close', (event) => {
        if (quitting || shellInstallerOwnsQuit || sessionEnding) return
        event.preventDefault()
        if (!created.isDestroyed()) created.hide()
      })
      created.on('closed', () => {
        if (sharedHarnessWindow !== created) return
        sharedHarnessWindow = undefined
        sharedHarnessActive = false
      })
      if (process.platform === 'win32') created.on('session-end', () => { sessionEnding = true })
      else {
        created.on('focus', () => { sessionEnding = false })
        created.on('show', () => { sessionEnding = false })
      }
    } else if (sharedHarnessWindowUrl !== url) {
      sharedHarnessWindowUrl = url
      void window.loadURL(sharedHarnessEntryUrl(url)).catch((error: unknown) => { console.warn('desktop shared Harness: could not change Platform or Host', error) })
    }
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    // Keep this optional shared Web surface secondary; native workspace remains the post-login shell.
    sharedHarnessActive = true
    return true
  }
  // Use undici fetch — not Electron net.fetch — so defaultSession's many loopback
  // `dsh-auth-*` cookies are not attached (APISIX returns 400 Cookie Too Large).
  const platformSend = (input: string, init?: RequestInit): Promise<Response> => fetch(input, init)
  const platformBrowser = new PlatformBrowserSignIn({
    ttlMs: 600_000,
    send: platformSend,
    openBrowser: (url) => {
      void shell.openExternal(url).catch((error: unknown) => {
        console.warn('desktop platform: could not open the system browser', error)
      })
    },
    callbackPage: (outcome) => {
      const title = outcome === 'succeeded' ? locale.messages.welcomeAuthExchanging
        : outcome === 'cancelled' ? locale.messages.welcomeAuthCancel : locale.messages.welcomeAuthFailed
      const body = outcome === 'succeeded'
        ? (locale.id.startsWith('zh') ? '登录成功，请返回 KaifangHarness 桌面端。' : 'Sign-in complete. You can return to KaifangHarness Desktop.')
        : outcome === 'cancelled'
          ? (locale.id.startsWith('zh') ? '已取消登录。' : 'Sign-in was cancelled.')
          : (locale.id.startsWith('zh') ? '登录失败，请返回桌面端重试。' : 'Sign-in failed. Return to Desktop and try again.')
      return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font:14px/1.5 system-ui;padding:2rem"><h1>${title}</h1><p>${body}</p></body></html>`
    },
  })
  const toKaifangAccountView = (user: PlatformSessionUser): KaifangAccountView => ({
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    avatarUrl: null,
  })
  const publishPlatformAccount = (account: KaifangAccountView | undefined): void => {
    platformAccount = account
    refreshApplicationMenu()
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(DESKTOP_IPC.kaifangChanged, account ?? null)
    }
  }
  const readPlatformAccount = async (): Promise<KaifangAccountView | undefined> => {
    try {
      const platformOrigin = await readSharedHarnessUrl(app.getPath('userData'))
      const session = await readPlatformSession(app.getPath('userData'), platformOrigin, Date.now())
      return session === undefined ? undefined : toKaifangAccountView(session.user)
    } catch (error) {
      console.warn('desktop platform: could not read the stored account', error)
      return undefined
    }
  }
  const completePlatformSession = async (sessionValue: PlatformSession): Promise<void> => {
    await writePlatformSession(app.getPath('userData'), sessionValue)
    publishPlatformAccount(toKaifangAccountView(sessionValue.user))
    await activateSharedHostIfPossible()
    navigation = undefined
    await enterWorkspace()
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) await navigateMain(applicationUrl)
  }
  const startBrowserSignIn = async (): Promise<PlatformBrowserSignInResult> => {
    if (quitting) return { ok: false, reason: 'cancelled' }
    const configuredUrl = await readSharedHarnessUrl(app.getPath('userData'))
    if (configuredUrl === '') return { ok: false, reason: 'url-required' }
    const result = await platformBrowser.start(configuredUrl)
    if (!result.ok) return { ok: false, reason: result.reason }
    try {
      await completePlatformSession(result.session)
      return { ok: true }
    } catch (error) {
      console.error('desktop platform: could not enter the workspace after sign-in', error)
      return { ok: false, reason: 'failed' }
    }
  }
  const showPlatformSignIn = async (): Promise<void> => {
    await openingWelcome
    if (welcomeWindow !== undefined && !welcomeWindow.isDestroyed()) {
      welcomeWindow.destroy()
      welcomeWindow = undefined
    }
    await showWelcome(false, true)
  }
  const signOutPlatform = async (): Promise<void> => {
    if (quitting) return
    try {
      await clearPlatformSession(app.getPath('userData'))
    } catch (error) {
      console.error('desktop platform: could not remove the session', error)
      await ordinaryMessageBox({
        type: 'error',
        title: locale.messages.kaifangSignOutMenu,
        message: locale.messages.kaifangSignOutFailed,
        buttons: [locale.messages.updateAcknowledge],
        cancelId: 0,
      })
      return
    }
    publishPlatformAccount(undefined)
    useLocalHostTransport()
    navigation = undefined
    if (mainWindow !== undefined && !mainWindow.isDestroyed() && enteredWorkspace) {
      await navigateMain(applicationUrl)
    }
    if (!needsWelcome(await readWelcomeState()) || isQuitting()) return
    enteredWorkspace = false
    await showWelcome()
  }
  const requestPlatformSignOut = (): void => {
    void signOutPlatform().catch((error: unknown) => { console.error(error) })
  }
  const refreshPlatformAccount = async (): Promise<void> => {
    const account = await readPlatformAccount()
    if (account === undefined) {
      if (platformAccount !== undefined) publishPlatformAccount(undefined)
      return
    }
    if (platformAccount !== undefined
      && platformAccount.username === account.username
      && platformAccount.displayName === account.displayName
      && platformAccount.email === account.email) return
    publishPlatformAccount(account)
  }
  void readPlatformAccount().then((account) => {
    if (platformAccount === undefined && account !== undefined) publishPlatformAccount(account)
  })
  ipcMain.handle(DESKTOP_IPC.kaifangAccount, async (event) => {
    assertProductSender(event)
    return (await readPlatformAccount()) ?? null
  })
  ipcMain.handle(DESKTOP_IPC.kaifangSignIn, async (event) => {
    assertProductSender(event)
    await showPlatformSignIn()
  })
  ipcMain.handle(DESKTOP_IPC.kaifangSignOut, async (event) => {
    assertProductSender(event)
    await signOutPlatform()
  })
  ipcMain.handle(DESKTOP_IPC.kaifangRefresh, async (event) => {
    assertProductSender(event)
    await refreshPlatformAccount()
  })
  ipcMain.handle(DESKTOP_IPC.hostPlaneSet, async (event, plane: unknown) => {
    assertProductSender(event)
    await startup
    if (plane === 'current') return hostPlaneSnapshot()
    if (plane === 'cloud-lost') return markCloudDisconnected()
    if (plane !== 'local' && plane !== 'cloud') {
      throw new Error('dsh desktop: host plane must be local or cloud')
    }
    return setActiveHostPlane(plane)
  })

  const passwordSignIn = async ({ username, password }: PlatformPasswordCredentials): Promise<PlatformPasswordSignInResult> => {
    if (username.trim() === '') return { ok: false, reason: 'username-required' }
    if (password === '') return { ok: false, reason: 'password-required' }
    // In-app password no longer opens the Web Harness window; use system-browser OAuth instead.
    const result = await startBrowserSignIn()
    return result.ok ? { ok: true }
      : { ok: false, reason: result.reason === 'unreachable' ? 'unreachable' : 'failed' }
  }
  let openingWelcome: Promise<void> | undefined
  const showWelcome = (settings = false, allowWorkspace = false): Promise<void> => {
    if (quitting) return Promise.resolve()
    if (welcomeWindow !== undefined && !welcomeWindow.isDestroyed()) {
      welcomeWindow.show()
      welcomeWindow.focus()
      return Promise.resolve()
    }
    openingWelcome ??= (async () => {
      welcomeWindow = await openWelcomeWindow(locale, {
        readSharedHarnessUrl: async () => readSharedHarnessUrl(app.getPath('userData')),
        saveSharedHarnessUrl: async value => saveSharedHarnessUrl(app.getPath('userData'), value),
        startBrowserSignIn,
        cancelBrowserSignIn: async () => { platformBrowser.cancel() },
        passwordSignIn,
        skip: enterWorkspace,
      }, settings ? 'settings' : 'entry')
      const window = welcomeWindow
      window.once('closed', () => {
        if (welcomeWindow === window) welcomeWindow = undefined
        if (enteredWorkspace || recovery.active) return
        // Nothing runs before the workspace opens. macOS keeps the Dock convention and drops the
        // unused main window so the next activation rebuilds the welcome; elsewhere the close quits.
        if (process.platform === 'darwin') mainWindow?.destroy()
        else app.quit()
      })
      if (isQuitting() || recovery.active || (enteredWorkspace && !settings && !allowWorkspace)) window.close()
      else if (!enteredWorkspace) mainWindow?.hide()
    })().finally(() => { openingWelcome = undefined })
    return openingWelcome
  }
  showSharedHarnessSettings = () => showWelcome(true)
  const openInitialWindow = async (): Promise<void> => {
    if (quitting || recovery.active) return
    const state = await readWelcomeState()
    if (isQuitting() || backend.state.phase !== 'ready') return
    locale = resolveDesktopStartupLocale(state.localePreference, systemLanguages)
    windowsLanguage = locale.id
    refreshApplicationMenu()
    if (!enteredWorkspace && needsWelcome(state)) {
      // A later login must retain its own activation policy instead of replaying startup focus.
      raiseAfterUpdate = false
      await showWelcome()
    } else {
      await enterWorkspace()
    }
  }
  focusPrimaryWindow = () => {
    if (quitting) return
    if (isMandatory()) { mandatoryUI?.focus(); return }
    const window = (sharedHarnessActive ? sharedHarnessWindow : undefined) ?? welcomeWindow ?? mainWindow
    if (window === undefined || window.isDestroyed()) {
      try { createMainWindow() } catch (error) { reportFatal(error, 'main'); return }
      void (backend.state.phase === 'ready' ? openInitialWindow() : navigateMain(applicationUrl)).catch((error: unknown) => { reportFatal(error, 'main') })
      return
    }
    // Startup and sign-out select the visible window before activation may reveal the workspace.
    if (window === mainWindow && !enteredWorkspace) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  if (app.isPackaged || process.env.DSH_DESKTOP_DEV_APP === '1') app.setAsDefaultProtocolClient('dsh')
  app.on('open-url', (event, url) => {
    event.preventDefault()
    if (url === 'dsh://open' || url === 'dsh://open/') focusPrimaryWindow()
  })

  app.on('activate', (_event, hasVisibleWindows) => {
    if (!hasVisibleWindows) focusPrimaryWindow()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  if (process.platform !== 'win32') powerMonitor.on('shutdown', () => { sessionEnding = true })
  const finishQuit = (): void => {
    quitting = true
    shuttingDown = true
    updateJournal?.action('quit-requested')
    quitConfirmation.dispose()
    backgroundNotice?.dispose()
    tray?.dispose()
    stopAccount?.()
    platformBrowser.dispose()
    if (welcomeWindow !== undefined && !welcomeWindow.isDestroyed()) welcomeWindow.hide()
    if (sharedHarnessWindow !== undefined && !sharedHarnessWindow.isDestroyed()) sharedHarnessWindow.hide()
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.hide()
    updateSchedule.dispose()
    updateDialog.dispose()
    mandatoryUI?.dispose()
    void Promise.all([Promise.resolve(mandatoryPolicy?.dispose()).then(() => policyAuth?.dispose()), backend.close(),
      // A Platform cleanup failure is logged without cutting the remaining Host shutdown short.
      platformView.dispose().catch((error: unknown) => { console.error(error) }),
      disposeFileDrag().catch((error: unknown) => { console.error(error) })])
      .catch((error: unknown) => { console.error(error) }).finally(() => { app.quit() })
  }
  app.on('before-quit', (event) => {
    if (shellInstallerOwnsQuit) {
      shuttingDown = true
      quitConfirmation.dispose()
      backgroundNotice?.dispose()
      updateJournal?.action('quit-requested')
      tray?.dispose()
      updateDialog.dispose()
      mandatoryUI?.dispose()
      // Installation preparation already awaited Platform storage cleanup.
      void platformView.dispose().catch((error: unknown) => { console.error(error) })
      return
    }
    if (quitting) return
    event.preventDefault()
    if (skipQuitConfirmation || sessionEnding) { finishQuit(); return }
    void quitConfirmation.confirm().then((approved) => {
      if (quitting || shellInstallerOwnsQuit) return
      if (approved) { finishQuit(); return }
      // A quit that started from closing the welcome window destroyed it; a cancelled quit needs it back.
      if (!enteredWorkspace && !recovery.active) void showWelcome().catch((error: unknown) => { reportFatal(error, 'main') })
    }).catch((error: unknown) => { console.error(error); if (!quitting && !shellInstallerOwnsQuit) finishQuit() })
  })

  mainWindow = createMainWindow()
  if (typeof manifest !== 'object' || manifest === null) throw new Error('desktop policy: invalid application manifest')
  const developmentPolicy = app.isPackaged ? undefined : process.env.DSH_DESKTOP_MANDATORY_UPDATE_CONFIG
  const policyInput: unknown = app.isPackaged
    ? ('dshMandatoryUpdatePolicy' in manifest ? manifest.dshMandatoryUpdatePolicy : undefined)
    : developmentPolicy === undefined ? undefined : JSON.parse(developmentPolicy) as unknown
  const policyConfig = resolveDesktopPolicyConfig(policyInput, !app.isPackaged)
  if (policyConfig !== undefined) {
    if (policyConfig.authentication === 'feishu-test') {
      policyAuth = new DesktopPolicyTestAuth(policyConfig.origin, policyConfig.allowedAuthOrigins, locale,
        () => mandatoryUI?.confirmationWindow ?? currentDialogWindow(),
        (event) => { console.info(`desktop policy authentication: ${event}`); updateJournal?.action(`policy-login-${event}`) })
    }
    if (!['win32', 'darwin'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) throw new Error('desktop policy: unsupported platform')
    let wasBlocking = false
    mandatoryPolicy = new DesktopMandatoryUpdatePolicy(policyConfig, {
      platform: process.platform as 'win32' | 'darwin', arch: process.arch as 'x64' | 'arm64',
      channel: updateChannel,
      bundledDshVersion: app.isPackaged ? readDesktopRuntime(resources.dsh).release.version : app.getVersion(),
    }, (state) => {
      if (state.error !== 'authentication-required') policyAuthenticationQueued = false
      if (state.blocking) {
        for (const controller of ordinaryDialogs) controller.abort()
        if (!wasBlocking) updateDialog.cancel()
      }
      mandatoryUI?.sync()
      if (state.blocking && !wasBlocking) void updateSchedule.check(false, true).catch((error: unknown) => { console.error(error) })
      wasBlocking = state.blocking
    }, policyAuth?.request, () => desktopClientMetadata(locale.id))
    const policy = mandatoryPolicy
    mandatoryUI = new DesktopMandatoryUpdateWindow({
      overlays: updateOverlays,
      preload: fileURLToPath(new URL('./preload-mandatory.cjs', import.meta.url)), locale,
      allowedPageOrigins: policyConfig.allowedPageOrigins, parent: () => mainWindow,
      policy: () => policy.state, update: () => updates.state,
      refresh: async () => { await Promise.all([checkPolicyManually(), updateSchedule.check(true)]) },
      download: downloadUpdate, install: version => updates.install(version),
    })
    void mandatoryPolicy.check('launch').then((state) => {
      if (app.isPackaged && state.error === 'authentication-required' && !isQuitting()) queuePolicyAuthentication()
    }).catch((error: unknown) => { console.error(error) })
  }
  automaticCheck()
  await reconcileBackend().catch(() => undefined)
  // Window lifecycle callbacks run while backend startup is pending.
  if (isQuitting()) return
  const window = currentMainWindow()
  if (window !== undefined && development && process.env.DSH_DESKTOP_OPEN_DEVTOOLS !== '0') {
    window.webContents.openDevTools({ mode: 'detach' })
  }
  publishUpdate(updateState)
}

const ownsDesktopInstance = claimDesktopSingleInstance(app, () => { focusPrimaryWindow() })

if (ownsDesktopInstance) void app.whenReady().then(main).catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(error)
  const diagnosticFile = process.env.DSH_DESKTOP_DIAGNOSTIC_FILE
  if (diagnosticFile !== undefined) {
    await writeFile(diagnosticFile, `${error instanceof Error ? error.stack ?? message : message}\n`).catch(() => undefined)
  }
  reportFatal(error, 'main')
}).catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})
