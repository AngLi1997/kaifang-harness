/** Read and mutate Desktop dual-plane fields on `__DSH_TRANSPORT__`. */

import type { HostPlaneId, HostPlaneTransport } from './types.ts'

interface TransportGlobal {
  __DSH_TRANSPORT__?: {
    ownsHost?: boolean
    streamBaseUrl?: string
    cloudOnline?: boolean
    activePlane?: HostPlaneId
    sidecarApiPrefix?: string
  }
  dshDesktop?: {
    hostPlane?: {
      current(): Promise<HostPlaneTransport>
      setActive(plane: HostPlaneId): Promise<HostPlaneTransport>
      reportCloudLost(): Promise<HostPlaneTransport>
      subscribe(listener: (view: HostPlaneTransport) => void): () => void
      subscribeDisconnect(listener: () => void): () => void
    }
  }
}

export function readHostPlaneTransport(): HostPlaneTransport | undefined {
  const transport = (globalThis as TransportGlobal).__DSH_TRANSPORT__
  if (transport?.streamBaseUrl === undefined) return undefined
  if (transport.cloudOnline !== true) {
    return {
      cloudOnline: false,
      activePlane: 'local',
      streamBaseUrl: transport.streamBaseUrl,
      ownsHost: transport.ownsHost !== false,
    }
  }
  return {
    cloudOnline: true,
    activePlane: transport.activePlane === 'cloud' ? 'cloud' : 'local',
    streamBaseUrl: transport.streamBaseUrl,
    ownsHost: transport.ownsHost !== false,
    ...transport.sidecarApiPrefix === undefined ? {} : { sidecarApiPrefix: transport.sidecarApiPrefix },
  }
}

export function applyHostPlaneTransport(view: HostPlaneTransport): void {
  const globals = globalThis as TransportGlobal
  const previous = globals.__DSH_TRANSPORT__ ?? {}
  globals.__DSH_TRANSPORT__ = {
    ...previous,
    ownsHost: view.ownsHost,
    streamBaseUrl: view.streamBaseUrl,
    cloudOnline: view.cloudOnline,
    activePlane: view.activePlane,
    ...view.sidecarApiPrefix === undefined ? { sidecarApiPrefix: undefined } : { sidecarApiPrefix: view.sidecarApiPrefix },
  }
}

export function desktopHostPlaneApi(): TransportGlobal['dshDesktop'] extends infer D
  ? D extends { hostPlane?: infer H } ? H : undefined
  : undefined {
  return (globalThis as TransportGlobal).dshDesktop?.hostPlane as never
}
