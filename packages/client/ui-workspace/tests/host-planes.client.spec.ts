import { afterEach, expect, it, vi } from 'vitest'
import { applyHostPlaneTransport, readHostPlaneTransport } from '../src/client/host-planes/transport.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__
})

it('reads offline transport as local-only dual-plane state', () => {
  ;(globalThis as { __DSH_TRANSPORT__: { ownsHost: boolean; streamBaseUrl: string } }).__DSH_TRANSPORT__ = {
    ownsHost: true,
    streamBaseUrl: 'http://127.0.0.1:3080',
  }
  expect(readHostPlaneTransport()).toEqual({
    cloudOnline: false,
    activePlane: 'local',
    streamBaseUrl: 'http://127.0.0.1:3080',
    ownsHost: true,
  })
})

it('applies dual-plane boot fields onto the page transport', () => {
  applyHostPlaneTransport({
    cloudOnline: true,
    activePlane: 'cloud',
    streamBaseUrl: 'http://127.0.0.1:4080',
    ownsHost: false,
    sidecarApiPrefix: '/__dsh_sidecar__',
  })
  expect(readHostPlaneTransport()).toMatchObject({
    cloudOnline: true,
    activePlane: 'cloud',
    ownsHost: false,
    sidecarApiPrefix: '/__dsh_sidecar__',
  })
})
