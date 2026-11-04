import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  DSH_SIDECAR_API_PREFIX,
  desktopDualPlaneBoot,
  isSidecarApiPath,
  resolvePlaneHosts,
  stripSidecarApiPrefix,
} from '../src/host-plane.ts'
import { desktopCloudAccountKey } from '../src/platform-session.ts'

it('classifies and strips the dual-plane sidecar API prefix', () => {
  expect(isSidecarApiPath(DSH_SIDECAR_API_PREFIX)).toBe(true)
  expect(isSidecarApiPath(`${DSH_SIDECAR_API_PREFIX}/api/workspace/listSnapshot`)).toBe(true)
  expect(isSidecarApiPath('/api/workspace/listSnapshot')).toBe(false)
  expect(stripSidecarApiPrefix(`${DSH_SIDECAR_API_PREFIX}/api/workspace/listSnapshot`))
    .toBe('/api/workspace/listSnapshot')
  expect(stripSidecarApiPrefix(DSH_SIDECAR_API_PREFIX)).toBe('/')
  expect(stripSidecarApiPrefix('/api/x')).toBe('/api/x')
})

it('keeps the shell on the local Host and the sidecar prefix on the cloud Host', () => {
  const endpoints = {
    localUrl: 'http://127.0.0.1:3080/?token=local',
    localCookie: 'local=1',
    cloudUrl: 'http://127.0.0.1:4080/?token=cloud',
    cloudCookie: 'cloud=1',
  }
  const planes = resolvePlaneHosts(endpoints)
  expect(planes.active.hostUrl).toContain('3080')
  expect(planes.active.hostCookie).toBe('local=1')
  expect(planes.sidecar.hostUrl).toContain('4080')
  expect(planes.sidecar.hostCookie).toBe('cloud=1')
})

it('boots the shell on the local origin and publishes the cloud origin beside it', () => {
  const offline = desktopDualPlaneBoot({
    cloudOnline: false,
    activePlane: 'local',
    activeHostUrl: 'http://127.0.0.1:3080/',
  })
  expect(offline).toMatchObject({
    ownsHost: true,
    cloudOnline: false,
    activePlane: 'local',
    sidecarApiPrefix: undefined,
    streamBaseUrl: 'http://127.0.0.1:3080',
  })
  expect(offline.cloudStreamBaseUrl).toBeUndefined()
  const dual = desktopDualPlaneBoot({
    cloudOnline: true,
    activePlane: 'local',
    activeHostUrl: 'http://127.0.0.1:3080/',
    cloudHostUrl: 'http://127.0.0.1:4080/',
    cloudAccountKey: 'abc',
  })
  expect(dual.ownsHost).toBe(true)
  expect(dual.streamBaseUrl).toBe('http://127.0.0.1:3080')
  expect(dual.cloudStreamBaseUrl).toBe('http://127.0.0.1:4080')
  expect(dual.cloudAccountKey).toBe('abc')
  expect(dual.sidecarApiPrefix).toBe(DSH_SIDECAR_API_PREFIX)
})

it('hashes the cloud account the same way as platformUserKey', () => {
  const key = desktopCloudAccountKey({ tid: 'tenant', sub: 'user' })
  expect(key).toBe(createHash('sha256').update('tenant\0user').digest('hex').slice(0, 24))
  expect(key).toHaveLength(24)
})
