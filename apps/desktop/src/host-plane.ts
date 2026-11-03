/** Dual-plane (本机 / 云端) transport vocabulary for Desktop Remote Client. */

export type HostPlaneId = 'local' | 'cloud'

/** Path prefix the renderer uses for the inactive Host's unary RPCs. */
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

/** Resolve which Host answers the active shell vs the dual-plane sidecar. */
export function resolvePlaneHosts(
  plane: HostPlaneId,
  endpoints: DesktopHostEndpoints,
): {
  readonly active: { readonly hostUrl: string; readonly hostCookie: string }
  readonly sidecar: { readonly hostUrl: string; readonly hostCookie: string }
} {
  if (plane === 'local') {
    return {
      active: { hostUrl: endpoints.localUrl, hostCookie: endpoints.localCookie },
      sidecar: { hostUrl: endpoints.cloudUrl, hostCookie: endpoints.cloudCookie },
    }
  }
  return {
    active: { hostUrl: endpoints.cloudUrl, hostCookie: endpoints.cloudCookie },
    sidecar: { hostUrl: endpoints.localUrl, hostCookie: endpoints.localCookie },
  }
}

/** Boot fields the renderer needs for dual-plane sidebar/model menus. */
export function desktopDualPlaneBoot(options: {
  readonly cloudOnline: boolean
  readonly activePlane: HostPlaneId
  readonly activeHostUrl: string
}): {
  readonly streamBaseUrl: string
  readonly ownsHost: boolean
  readonly cloudOnline: boolean
  readonly activePlane: HostPlaneId
  readonly sidecarApiPrefix: string | undefined
} {
  return {
    streamBaseUrl: new URL(options.activeHostUrl).origin,
    // Local plane on Desktop is the owned Host peer world; cloud is Remote Client.
    ownsHost: !options.cloudOnline || options.activePlane === 'local',
    cloudOnline: options.cloudOnline,
    activePlane: options.activePlane,
    sidecarApiPrefix: options.cloudOnline ? DSH_SIDECAR_API_PREFIX : undefined,
  }
}
