import { expect, it } from 'vitest'
import {
  DSH_SIDECAR_API_PREFIX,
  desktopDualPlaneBoot,
  isSidecarApiPath,
  resolvePlaneHosts,
  stripSidecarApiPrefix,
} from '../src/host-plane.ts'

it('classifies and strips the dual-plane sidecar API prefix', () => {
  expect(isSidecarApiPath(DSH_SIDECAR_API_PREFIX)).toBe(true)
  expect(isSidecarApiPath(`${DSH_SIDECAR_API_PREFIX}/api/workspace/listSnapshot`)).toBe(true)
  expect(isSidecarApiPath('/api/workspace/listSnapshot')).toBe(false)
  expect(stripSidecarApiPrefix(`${DSH_SIDECAR_API_PREFIX}/api/workspace/listSnapshot`))
    .toBe('/api/workspace/listSnapshot')
  expect(stripSidecarApiPrefix(DSH_SIDECAR_API_PREFIX)).toBe('/')
  expect(stripSidecarApiPrefix('/api/x')).toBe('/api/x')
})

it('swaps active and sidecar Hosts by plane without merging storage endpoints', () => {
  const endpoints = {
    localUrl: 'http://127.0.0.1:3080/?token=local',
    localCookie: 'local=1',
    cloudUrl: 'http://127.0.0.1:4080/?token=cloud',
    cloudCookie: 'cloud=1',
  }
  const local = resolvePlaneHosts('local', endpoints)
  expect(local.active.hostUrl).toContain('3080')
  expect(local.sidecar.hostUrl).toContain('4080')
  const cloud = resolvePlaneHosts('cloud', endpoints)
  expect(cloud.active.hostUrl).toContain('4080')
  expect(cloud.sidecar.hostUrl).toContain('3080')
})

it('boots dual-plane fields: default ownsHost on local; sidecar only while cloud online', () => {
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
  })
  const dualLocal = desktopDualPlaneBoot({
    cloudOnline: true,
    activePlane: 'local',
    activeHostUrl: 'http://127.0.0.1:3080/',
  })
  expect(dualLocal.ownsHost).toBe(true)
  expect(dualLocal.sidecarApiPrefix).toBe(DSH_SIDECAR_API_PREFIX)
  const dualCloud = desktopDualPlaneBoot({
    cloudOnline: true,
    activePlane: 'cloud',
    activeHostUrl: 'http://127.0.0.1:4080/',
  })
  expect(dualCloud.ownsHost).toBe(false)
  expect(dualCloud.streamBaseUrl).toBe('http://127.0.0.1:4080')
  expect(dualCloud.sidecarApiPrefix).toBe(DSH_SIDECAR_API_PREFIX)
})
