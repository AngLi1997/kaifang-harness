/** Committed install icon dimensions and the generator's SVG crop and safe-zone scale. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  APP_ICON_VARIANTS, ICON_OUTPUT_DIRECTORY, TILE_SOURCE,
  maskableDocument, tileDocument,
} from '../scripts/render-app-icons.ts'
import { pngSize } from './png-size.ts'

describe('web install icons', () => {
  it('ships every declared variant at its declared edge', async () => {
    for (const variant of APP_ICON_VARIANTS) {
      expect(pngSize(await readFile(join(ICON_OUTPUT_DIRECTORY, variant.file))))
        .toEqual([variant.size, variant.size])
    }
  })

  it('embeds the product mark the install icons rasterize', async () => {
    const source = await readFile(TILE_SOURCE, 'utf8')
    expect(source).toContain('<g id="tray-glyph">')
    expect(source).toContain('data:image/png;base64,')
    expect(source).toContain('viewBox="0 0 1024 1024"')
  })

  it('rejects non-PNG bytes and incomplete image headers', () => {
    expect(() => pngSize(Buffer.from('<svg/>'))).toThrow(/PNG IHDR/)
    expect(() => pngSize(Buffer.alloc(33))).toThrow(/PNG IHDR/)
  })

  it('fails loudly on a source without the tile it transforms', () => {
    expect(() => tileDocument('')).toThrow(/no root element/)
    expect(() => tileDocument('<svg></svg>')).toThrow(/no shadowed tile group/)
    expect(() => maskableDocument('<svg><g filter="url(#filter0_d_1637_371)"></g></svg>'))
      .toThrow(/no artwork group/)
  })
})
