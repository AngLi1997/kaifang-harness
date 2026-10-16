import type { IconProps } from './icons/props.ts'

/** Native viewBox of {@link KAIFANG_LOGO_PATH} (width and height in user units). */
export const KAIFANG_LOGO_VIEWBOX = { width: 483, height: 468 }

/** Kaifang seal color; the logo keeps it in every theme. */
export const KAIFANG_LOGO_COLOR = '#D83F21'

/** The four-quadrant Kaifang seal; the even-odd fill cuts the glyph strokes out of the square. */
export const KAIFANG_LOGO_PATH = 'M0 0h483v468H0zM233 0h16v468h-16zM0 226h108v16h-108zM124 226h109v16h-109zM249 226h234v16h-234zM108 46h16v384h-16zM43 156h65v15h-65zM124 156h57v15h-57zM358 46h16v180h-16zM289 85h17v141h-17zM426 85h17v141h-17zM43 281h17v148h-17zM124 281h69v16h-69zM176 297h17v132h-17zM289 281h154v16h-154zM289 347h154v16h-154zM289 414h154v16h-154z'

/**
 * Render the Kaifang seal logo.
 * @param props.size - width in px (default 24; height keeps the 483:468 ratio).
 * @param props.className - extra class for layout placement.
 * @returns the logo svg (aria-hidden; pair with the wordmark for accessibility).
 */
export function KaifangLogo({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={(size * KAIFANG_LOGO_VIEWBOX.height) / KAIFANG_LOGO_VIEWBOX.width}
      className={className}
      viewBox={`0 0 ${KAIFANG_LOGO_VIEWBOX.width} ${KAIFANG_LOGO_VIEWBOX.height}`}
      fill="none"
      aria-hidden="true"
    >
      <path d={KAIFANG_LOGO_PATH} fill={KAIFANG_LOGO_COLOR} fillRule="evenodd" />
    </svg>
  )
}
