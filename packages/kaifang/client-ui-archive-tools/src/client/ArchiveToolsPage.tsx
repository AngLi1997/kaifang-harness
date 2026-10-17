/** Main-column catalog of archive tools; picking a card references the tool in a conversation. */
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { ARCHIVE_TOOL_SECTIONS, sectionToolCount, type ArchiveToolGroup, type ArchiveToolId, type ArchiveToolSection } from './catalog.ts'
import { SECTION_ICONS, TOOL_ICONS } from './icons.tsx'
import css from './ArchiveToolsPage.module.css'

/** Pick action injected by the plugin. */
export interface ArchiveToolsInjected {
  /**
   * Reference one tool in the current conversation, or in a new one when none is open.
   * @param id - picked catalog tool.
   */
  readonly onSelectTool: (id: ArchiveToolId) => void
}

/** Catalog page props derived from the `main` seat, the inject face, and the plugin's copy. */
export type ArchiveToolsPageProps = PropsRuntime<'main'>
  & InjectFace<ArchiveToolsInjected>
  & PropsLocale<'kaifang.archiveTools'>

type Translate = TranslateNS<'kaifang.archiveTools'>

/**
 * Render the archive tool catalog.
 * @param props - localized copy and the pick action.
 * @returns the scrollable catalog page.
 */
export function ArchiveToolsPage({ t, onSelectTool }: ArchiveToolsPageProps) {
  return <section className={css.page} aria-label={t('page.title')} data-testid="kaifang-archive-tools-page">
    <div className={css.scroll}>
      <div className={css.content}>
        <h1 className={css.title} data-window-drag>{t('page.title')}</h1>
        {ARCHIVE_TOOL_SECTIONS.map(section =>
          <CatalogSection key={section.id} section={section} t={t} onSelectTool={onSelectTool} />)}
      </div>
    </div>
  </section>
}

interface SectionProps {
  readonly t: Translate
  readonly onSelectTool: (id: ArchiveToolId) => void
}

/**
 * Render one catalog section with its heading and groups.
 * @param props - section data, copy, and pick action.
 * @returns the section element.
 */
function CatalogSection({ section, t, onSelectTool }: SectionProps & { readonly section: ArchiveToolSection }) {
  const Mark = SECTION_ICONS[section.id]
  const headingId = `kaifang-archive-tools-${section.id}`
  return <section className={css.section} aria-labelledby={headingId}>
    <div className={css.sectionHead}>
      <span className={css.sectionMark} aria-hidden="true"><Mark size={16} /></span>
      <h2 className={css.sectionTitle} id={headingId}>{t(`section.${section.id}`)}</h2>
      <span className={css.sectionCount}>{t('section.count', { count: sectionToolCount(section) })}</span>
    </div>
    <div className={css.groups}>
      {section.groups.map(group =>
        <CatalogGroup key={group.title ?? group.meta} group={group} t={t} onSelectTool={onSelectTool} />)}
    </div>
  </section>
}

/**
 * Render one group: its optional heading above a card grid.
 * @param props - group data, copy, and pick action.
 * @returns the group element.
 */
function CatalogGroup({ group, t, onSelectTool }: SectionProps & { readonly group: ArchiveToolGroup }) {
  return <div className={css.group}>
    {group.title === undefined ? null : <h3 className={css.groupTitle}>
      {t(group.title)}
      <span className={css.groupLine} aria-hidden="true" />
    </h3>}
    <ul className={css.grid}>
      {group.tools.map(id => <ToolCard key={id} id={id} t={t} onSelectTool={onSelectTool} />)}
    </ul>
  </div>
}

/**
 * Render one tool card.
 * @param props - tool id, copy, and pick action.
 * @returns the list item holding the card button.
 */
function ToolCard({ id, t, onSelectTool }: SectionProps & { readonly id: ArchiveToolId }) {
  const Icon = TOOL_ICONS[id]
  const name = t(`tool.${id}.name`)
  const label = t('card.use', { name })
  return <li className={css.cardItem}>
    <button type="button" className={css.card} data-tool-id={id} aria-label={label} title={label}
      onClick={() => { onSelectTool(id) }}>
      <span className={css.tile} aria-hidden="true"><Icon size={20} /></span>
      <span className={css.cardBody}>
        <span className={css.cardTitle}>{name}</span>
        <span className={css.cardDesc}>{t(`tool.${id}.desc`)}</span>
      </span>
      <span className={css.cardHint} aria-hidden="true">@</span>
    </button>
  </li>
}
