/** Static archive tool catalog: sections, their groups, and each tool's localized keys. */
import type { ArchiveToolsKey } from './locales.ts'

/** Identity of one archive tool; also its reference id and `@` mention text. */
export type ArchiveToolId = 'ocr' | 'pdf' | 'repair' | 'polish' | 'demo'

/** Where a section's tools run. */
export type ArchiveToolSectionId = 'local' | 'online'

/** One titled or untitled run of tools inside a section. */
export interface ArchiveToolGroup {
  /** Group heading key; an untitled group renders its cards directly under the section heading. */
  readonly title?: ArchiveToolsKey
  /** `@` menu metadata line shared by the group's tools. */
  readonly meta: ArchiveToolsKey
  /** Tools in display order. */
  readonly tools: readonly ArchiveToolId[]
}

/** One catalog section. */
export interface ArchiveToolSection {
  readonly id: ArchiveToolSectionId
  readonly groups: readonly ArchiveToolGroup[]
}

/** Catalog sections in display order. */
export const ARCHIVE_TOOL_SECTIONS: readonly ArchiveToolSection[] = [
  {
    id: 'local',
    groups: [
      { title: 'group.image', meta: 'menu.meta.image', tools: ['ocr', 'pdf', 'repair'] },
      { title: 'group.document', meta: 'menu.meta.document', tools: ['polish'] },
    ],
  },
  {
    id: 'online',
    groups: [{ meta: 'menu.meta.online', tools: ['demo'] }],
  },
]

/** Every tool in catalog order with the metadata line of its group. */
export const ARCHIVE_TOOLS: readonly { readonly id: ArchiveToolId; readonly meta: ArchiveToolsKey }[] =
  ARCHIVE_TOOL_SECTIONS.flatMap(section => section.groups.flatMap(group =>
    group.tools.map(id => ({ id, meta: group.meta }))))

/**
 * Narrow an opaque reference or candidate value to a catalog tool.
 * @param value - candidate value or chip reference id.
 * @returns whether the value names a catalog tool.
 */
export function isArchiveToolId(value: string | undefined): value is ArchiveToolId {
  return ARCHIVE_TOOLS.some(tool => tool.id === value)
}

/**
 * Count the tools of one section.
 * @param section - catalog section.
 * @returns number of tools across its groups.
 */
export function sectionToolCount(section: ArchiveToolSection): number {
  return section.groups.reduce((count, group) => count + group.tools.length, 0)
}

/**
 * Model text of one tool reference.
 * @param id - catalog tool.
 * @returns the `@<id>` mention.
 */
export function toolMention(id: ArchiveToolId): string {
  return `@${id}`
}
