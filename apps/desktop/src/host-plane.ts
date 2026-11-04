/** Dual-plane (本机 / 云端) transport vocabulary for Desktop Remote Client. */

export type HostPlaneId = 'local' | 'cloud'

/** Path prefix the renderer uses for the cloud Host's unary RPCs. */
export const DSH_SIDECAR_API_PREFIX = '/__dsh_sidecar__'

export function isSidecarApiPath(pathname: string): boolean {
  return pathname === DSH_SIDECAR_API_PREFIX
    || pathname.startsWith(`${DSH_SIDECAR_API_PREFIX}/`)
}

/** Strip the sidecar prefix so the target Host sees a normal `/api/…` path. */
export function stripSidecarApiPrefix(pathname: string): string {
  if (!isSidecarApiPath(pathname)) return pathname
  const rest = pathname.slice(DSH_SIDECAR_API_PREFIX.length)
  return rest === '' ? '/' : rest
}

export interface DesktopHostEndpoints {
  readonly localUrl: string
  readonly localCookie: string
  readonly cloudUrl: string
  readonly cloudCookie: string
}

/**
 * Keep the shell on the embedded Host and the sidecar prefix on the cloud Host.
 * The focused section does not swap these endpoints.
 * @param endpoints - both Hosts while the cloud endpoint exists.
 * @returns shell and cloud endpoints.
 */
export function resolvePlaneHosts(
  endpoints: DesktopHostEndpoints,
): {
  readonly active: { readonly hostUrl: string; readonly hostCookie: string }
  readonly sidecar: { readonly hostUrl: string; readonly hostCookie: string }
} {
  return {
    active: { hostUrl: endpoints.localUrl, hostCookie: endpoints.localCookie },
    sidecar: { hostUrl: endpoints.cloudUrl, hostCookie: endpoints.cloudCookie },
  }
}

/** Boot fields the renderer needs for dual-plane sidebar/model menus. */
export function desktopDualPlaneBoot(options: {
  readonly cloudOnline: boolean
  readonly activePlane: HostPlaneId
  /** Embedded Host the shell WebSocket stays on. */
  readonly activeHostUrl: string
  /** Shared Host origin while that endpoint exists. */
  readonly cloudHostUrl?: string
  /** Account key for the stored platform user. The main process computes it. */
  readonly cloudAccountKey?: string
}): {
  readonly streamBaseUrl: string
  readonly ownsHost: boolean
  readonly cloudOnline: boolean
  readonly activePlane: HostPlaneId
  readonly sidecarApiPrefix: string | undefined
  readonly cloudStreamBaseUrl?: string
  readonly cloudAccountKey?: string
} {
  const cloudStreamBaseUrl = options.cloudOnline && options.cloudHostUrl !== undefined
    ? new URL(options.cloudHostUrl).origin
    : undefined
  return {
    streamBaseUrl: new URL(options.activeHostUrl).origin,
    // The shell stays on the embedded Host. The cloud section uses its own socket.
    ownsHost: true,
    cloudOnline: options.cloudOnline,
    activePlane: options.activePlane,
    sidecarApiPrefix: options.cloudOnline ? DSH_SIDECAR_API_PREFIX : undefined,
    ...cloudStreamBaseUrl === undefined ? {} : { cloudStreamBaseUrl },
    ...options.cloudOnline && options.cloudAccountKey !== undefined
      ? { cloudAccountKey: options.cloudAccountKey }
      : {},
  }
}
