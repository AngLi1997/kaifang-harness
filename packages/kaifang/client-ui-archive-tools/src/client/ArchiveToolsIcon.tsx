/** Decorative occupant for the archive tools sidebar entry. */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { ToolboxIcon } from './icons.tsx'

/**
 * Render the toolbox glyph at the size the sidebar asks for; the sidebar owns
 * the button, its accessible label, and the selected state.
 * @param props - the sidebar's icon share.
 * @returns decorative toolbox icon.
 */
export function ArchiveToolsIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <ToolboxIcon size={size} />
}
