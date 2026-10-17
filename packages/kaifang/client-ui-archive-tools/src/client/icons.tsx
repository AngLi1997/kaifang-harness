/** Stroke glyphs for the archive tools, their sections, and the sidebar entry. */
import type { ComponentType, ReactNode } from 'react'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ArchiveToolId, ArchiveToolSectionId } from './catalog.ts'

/**
 * Draw one 24-unit current-color glyph.
 * @param props - rendered edge and the glyph's paths.
 * @returns decorative SVG.
 */
function Glyph({ size = 16, className, children }: IconProps & { children: ReactNode }) {
  return <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {children}
  </svg>
}

/** Toolbox glyph of the sidebar entry. */
export const ToolboxIcon = (props: IconProps) => <Glyph {...props}>
  <path d="M9 6.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v.5" />
  <rect x={3.5} y={6.5} width={17} height={12.5} rx={2.5} />
  <path d="M3.5 11h17" />
  <path d="M9.75 11v2.75h4.5V11" />
</Glyph>

const OcrIcon = (props: IconProps) => <Glyph {...props}>
  <path d="M4 8V6a2 2 0 0 1 2-2h2" />
  <path d="M16 4h2a2 2 0 0 1 2 2v2" />
  <path d="M20 16v2a2 2 0 0 1-2 2h-2" />
  <path d="M8 20H6a2 2 0 0 1-2-2v-2" />
  <path d="M8 9h8" />
  <path d="M8 12h8" />
  <path d="M8 15h5" />
</Glyph>

const PdfIcon = (props: IconProps) => <Glyph {...props}>
  <path d="M8 5.5V4.5A1.5 1.5 0 0 1 9.5 3H15l3.5 3.5v10a1.5 1.5 0 0 1-1.5 1.5h-1" />
  <rect x={4} y={7} width={12.5} height={14} rx={1.8} />
  <path d="M7 11.5h6.5" />
  <path d="M7 14.5h6.5" />
  <path d="M7 17.5h4" />
</Glyph>

const RepairIcon = (props: IconProps) => <Glyph {...props}>
  <path d="M4.5 19.5l9.8-9.8" />
  <path d="M12.6 6.2l1.1 2.4 2.4 1.1-2.4 1.1-1.1 2.4-1.1-2.4-2.4-1.1 2.4-1.1z" />
  <path d="M18.5 14.4l.7 1.5 1.5.7-1.5.7-.7 1.5-.7-1.5-1.5-.7 1.5-.7z" />
</Glyph>

const PolishIcon = (props: IconProps) => <Glyph {...props}>
  <path d="M4.5 19.5l1.2-4.2 9.8-9.8a2 2 0 0 1 2.8 0l.2.2a2 2 0 0 1 0 2.8l-9.8 9.8z" />
  <path d="M4.5 19.5l4.2-1.2" />
  <path d="M13.6 7.4l3 3" />
</Glyph>

const DemoIcon = (props: IconProps) => <Glyph {...props}>
  <path d="M9 3.5h6" />
  <path d="M10 3.5v5.2L5.4 17a2 2 0 0 0 1.8 3h9.6a2 2 0 0 0 1.8-3L14 8.7V3.5" />
  <path d="M8.2 14h7.6" />
  <path d="M11 16.3l2.1 1.5-2.1 1.5z" fill="currentColor" stroke="none" />
</Glyph>

const LocalIcon = (props: IconProps) => <Glyph {...props}>
  <rect x={4} y={4.5} width={16} height={11} rx={1.8} />
  <path d="M2.5 19h19" />
  <path d="M9 19l.5-3.5h5l.5 3.5" />
</Glyph>

const OnlineIcon = (props: IconProps) => <Glyph {...props}>
  <circle cx={12} cy={12} r={8.5} />
  <path d="M3.5 12h17" />
  <path d="M12 3.5c2.4 2.3 3.6 5.2 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.2-3.6-8.5S9.6 5.8 12 3.5z" />
</Glyph>

/** Glyph per tool, shared by catalog cards and `@` menu rows. */
export const TOOL_ICONS: Readonly<Record<ArchiveToolId, ComponentType<IconProps>>> = {
  ocr: OcrIcon,
  pdf: PdfIcon,
  repair: RepairIcon,
  polish: PolishIcon,
  demo: DemoIcon,
}

/** Glyph per catalog section heading. */
export const SECTION_ICONS: Readonly<Record<ArchiveToolSectionId, ComponentType<IconProps>>> = {
  local: LocalIcon,
  online: OnlineIcon,
}
