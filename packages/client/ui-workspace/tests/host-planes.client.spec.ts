import { afterEach, expect, it, vi } from 'vitest'
import { applyHostPlaneTransport, readHostPlaneTransport } from '../src/client/host-planes/transport.ts'
import { dualPlaneStore, setDualPlaneReconnect, startDualPlaneRuntime } from '../src/client/host-planes/store.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__
})

it('reads offline transport as local-only dual-plane state', () => {
  vi.stubGlobal('__DSH_TRANSPORT__', {
    ownsHost: true,
    streamBaseUrl: 'http://127.0.0.1:3080',
  })
  expect(readHostPlaneTransport()).toEqual({
    cloudOnline: false,
    activePlane: 'local',
    streamBaseUrl: 'http://127.0.0.1:3080',
    ownsHost: true,
  })
})

it('keeps the shell connection when focus changes and clears cloud rows before the next account', () => {
  const reconnect = vi.fn()
  setDualPlaneReconnect(reconnect)
  const local = {
    cloudOnline: true,
    activePlane: 'local' as 'local' | 'cloud',
    streamBaseUrl: 'http://127.0.0.1:3080',
    ownsHost: true,
    sidecarApiPrefix: '/__dsh_sidecar__',
    cloudStreamBaseUrl: 'http://127.0.0.1:4080',
    cloudAccountKey: 'account-a',
  }
  let listener: (view: typeof local) => void = () => {}
  vi.stubGlobal('__DSH_TRANSPORT__', { ...local })
  vi.stubGlobal('dshDesktop', {
    hostPlane: {
      subscribe: (fn: (view: typeof local) => void) => {
        listener = fn
        return () => {}
      },
      subscribeDisconnect: () => () => {},
      setActive: async (plane: 'local' | 'cloud') => ({ ...local, activePlane: plane }),
      current: async () => local,
      reportCloudLost: async () => ({ ...local, cloudOnline: false }),
    },
  })
  const stop = startDualPlaneRuntime()
  try {
    dualPlaneStore.update((draft) => {
      draft.sidecarSessions = [{ sessionId: 's', title: 'A' }]
    })
    listener({ ...local, activePlane: 'cloud' })
    expect(reconnect).not.toHaveBeenCalled()
    expect(dualPlaneStore.getSnapshot().sidecarSessions).toEqual([{ sessionId: 's', title: 'A' }])
    listener({ ...local, cloudAccountKey: 'account-b' })
    expect(dualPlaneStore.getSnapshot().sidecarSessions).toEqual([])
    expect(reconnect).not.toHaveBeenCalled()
    listener({ ...local, cloudAccountKey: 'account-b', streamBaseUrl: 'http://127.0.0.1:3090' })
    expect(reconnect).toHaveBeenCalledOnce()
  } finally {
    stop()
    setDualPlaneReconnect(undefined)
  }
})

it('reads the live host plane when the document booted before sign-in', async () => {
  vi.stubGlobal('__DSH_TRANSPORT__', {
    ownsHost: true,
    streamBaseUrl: 'http://127.0.0.1:49217',
    cloudOnline: false,
    activePlane: 'local',
  })
  const online = {
    cloudOnline: true,
    activePlane: 'local' as const,
    streamBaseUrl: 'http://127.0.0.1:49217',
    ownsHost: true,
    sidecarApiPrefix: '/__dsh_sidecar__',
    cloudStreamBaseUrl: 'http://127.0.0.1:3080',
    cloudAccountKey: 'account-a',
  }
  vi.stubGlobal('dshDesktop', {
    hostPlane: {
      subscribe: () => () => {},
      subscribeDisconnect: () => () => {},
      current: async () => online,
      setActive: async () => online,
      reportCloudLost: async () => ({ ...online, cloudOnline: false }),
    },
  })
  const stop = startDualPlaneRuntime()
  try {
    expect(dualPlaneStore.getSnapshot().cloudOnline).toBe(false)
    await Promise.resolve()
    await Promise.resolve()
    expect(dualPlaneStore.getSnapshot().cloudOnline).toBe(true)
    expect(dualPlaneStore.getSnapshot().cloudAccountKey).toBe('account-a')
    expect(dualPlaneStore.getSnapshot().cloudStreamBaseUrl).toBe('http://127.0.0.1:3080')
  } finally {
    stop()
  }
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
