/** Decorative occupant for the knowledge base sidebar entry. */
import { IconDatabaseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the database glyph at the size the sidebar asks for; the sidebar owns the row label.
 * @param props - the sidebar's icon share.
 * @returns decorative icon.
 */
export function KnowledgeIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconDatabaseOutlineRegular size={size} />
}
