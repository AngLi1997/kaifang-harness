/** Browser entry for the Web client. */
import '@deepseek-ai/dsh-client-ui-theme/brand-font.css'
import { AppWebEntry, applyIndexInjections } from '@deepseek-ai/dsh-client-web'

type HostPlaneId = 'local' | 'cloud'

interface DesktopBootResult {
  injections: Parameters<typeof applyIndexInjections>[0]
  streamBaseUrl: string
  ownsHost?: boolean
  cloudOnline?: boolean
  activePlane?: HostPlaneId
  sidecarApiPrefix?: string
  cloudStreamBaseUrl?: string
  cloudAccountKey?: string
}

interface DesktopBootGlobal {
  dshDesktopBoot?: {
    failed(message: string): Promise<void>
    ready(): Promise<DesktopBootResult>
  }
}
const desktop = (globalThis as DesktopBootGlobal).dshDesktopBoot
const reportFailure = (reason: unknown): void => {
  if (desktop === undefined) throw reason
  void desktop.failed(reason instanceof Error ? reason.message : String(reason)).catch(console.error)
}

try {
  const el = document.getElementById('root')
  if (el === null) throw new Error('web app: missing #root')
  const entry = new AppWebEntry(el)
  if (desktop !== undefined) {
    const gate = (globalThis as { __DSH_BOOT_READY__?: PromiseWithResolvers<void> }).__DSH_BOOT_READY__
    if (gate === undefined) throw new Error('desktop web: boot readiness is missing')
    void desktop.ready().then(async ({
      injections, streamBaseUrl, ownsHost, cloudOnline, activePlane, sidecarApiPrefix,
      cloudStreamBaseUrl, cloudAccountKey,
    }) => {
      const transport = globalThis as {
        __DSH_TRANSPORT__?: {
          ownsHost: boolean
          streamBaseUrl: string
          cloudOnline?: boolean
          activePlane?: HostPlaneId
          sidecarApiPrefix?: string
          cloudStreamBaseUrl?: string
          cloudAccountKey?: string
        }
      }
      transport.__DSH_TRANSPORT__ = {
        ownsHost: ownsHost !== false,
        streamBaseUrl,
        ...cloudOnline === true ? { cloudOnline: true } : {},
        ...activePlane === undefined ? {} : { activePlane },
        ...sidecarApiPrefix === undefined ? {} : { sidecarApiPrefix },
        ...cloudStreamBaseUrl === undefined ? {} : { cloudStreamBaseUrl },
        ...cloudAccountKey === undefined ? {} : { cloudAccountKey },
      }
      await applyIndexInjections(injections, src => new Promise<void>((resolve, reject) => {
        const script = document.createElement('script')
        script.src = src
        script.onload = () => { resolve() }
        script.onerror = () => { reject(new Error(`desktop web: failed to load ${src}`)) }
        document.head.append(script)
      }))
      gate.resolve()
    }).catch((error: unknown) => { gate.reject(error) })
  }
  void entry.run(desktop === undefined ? undefined : reportFailure)
} catch (reason) {
  reportFailure(reason)
}
