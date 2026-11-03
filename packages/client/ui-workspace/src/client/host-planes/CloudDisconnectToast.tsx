/** Toast when the shared Host Peer drops: 「云端已断开」. */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { dualPlaneStore } from './store.ts'

export function CloudDisconnectToast({ text }: { text: string }): ReactNode {
  const [seq, setSeq] = useState(0)
  const seen = useRef(0)
  useEffect(() => dualPlaneStore.subscribe(() => {
    const next = dualPlaneStore.getSnapshot().disconnectToastSeq
    if (next !== seen.current) {
      seen.current = next
      if (next > 0) setSeq(next)
    }
  }), [])
  if (seq === 0) return null
  return <Toast key={seq} text={text} icon={<IconWarningOutlineRegular />} onDone={() => { setSeq(0) }} />
}
