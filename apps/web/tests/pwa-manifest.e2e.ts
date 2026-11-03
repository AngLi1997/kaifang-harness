import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { chromium, type Page } from 'playwright'
import {
  APP_ICON_VARIANTS, ICON_OUTPUT_DIRECTORY, TILE_SOURCE, renderAppIcons,
} from '../scripts/render-app-icons.ts'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

async function pixels(page: Page, url: string, size: number) {
  return page.evaluate(async ({ url, size }) => {
    const image = new Image()
    image.src = url
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    const context = canvas.getContext('2d')!
    context.drawImage(image, 0, 0, size, size)
    const { data } = context.getImageData(0, 0, size, size)
    let radius = 0
    let ink = 0
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const at = (y * size + x) * 4
        if (data[at + 3] === 0 || data[at]! + data[at + 1]! + data[at + 2]! >= 384) continue
        ink += 1
        radius = Math.max(radius, Math.hypot(x - (size - 1) / 2, y - (size - 1) / 2))
      }
    }
    return {
      width: image.naturalWidth, height: image.naturalHeight, radius, ink,
      corners: [0, size - 1, (size - 1) * size, size * size - 1].map(index => data[index * 4 + 3]),
    }
  }, { url, size })
}

function pngUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`
}

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<meta name="viewport" content="width=device-width, initial-scale=1" />')
  expect(index).toContain('<link rel="manifest" href="./manifest.webmanifest" />')
  expect(index).toContain('<link rel="apple-touch-icon" href="./apple-touch-icon.png" />')
  expect(index).toContain('<meta name="mobile-web-app-capable" content="yes" />')
  expect(index).toContain('<meta name="apple-mobile-web-app-title" content="DSH" />')
  // No `theme-color` here: `ThemePresenter` owns the single metadata node and
  // follows the resolved in-application theme, which a static media query
  // cannot. The manifest's `theme_color` covers the surrounding chrome before
  // the presenter runs, and `settings-chrome.e2e.ts` pins the live contract.

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  // No `id`: a browser resolves an explicit `id` against the start URL's origin,
  // so only an absent `id`, which defaults to the resolved `start_url`, gives
  // each mount its own identity. `public-mount.e2e.ts` reads the resolved form.
  expect(manifest).toEqual({
    name: 'DeepSeek Harness',
    short_name: 'DSH',
    start_url: './',
    scope: './',
    // `standalone` keeps the phone's status bar; `fullscreen` hides it and the
    // navigation bar, which strands a chat surface with no clock or battery.
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  })
})

it('decodes every generated and shipped icon with the transparent product mark', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const source = await readFile(TILE_SOURCE, 'utf8')
    const generated = await renderAppIcons(source)
    const manifest = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8')) as {
      icons: readonly { src: string; sizes: string }[]
    }
    const declared = [...manifest.icons, { src: 'apple-touch-icon.png', sizes: '180x180' }]
    expect(generated.map(({ variant }) => [variant.file, `${variant.size}x${variant.size}`]))
      .toEqual(declared.map(icon => [icon.src, icon.sizes]))
    for (const { variant, png } of generated) {
      for (const bytes of [png, await readFile(join(DIST_ROOT, variant.file))]) {
        const image = await pixels(page, pngUrl(bytes), variant.size)
        expect([image.width, image.height], variant.file).toEqual([variant.size, variant.size])
        expect(image.corners, variant.file).toEqual([0, 0, 0, 0])
        expect(image.ink, variant.file).toBeGreaterThan(0)
        expect(image.radius, variant.file).toBeGreaterThan(variant.size * 0.2)
      }
    }
  } finally { await browser.close() }
})

it('ships fixed-color favicons selected by document media queries', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="icon" type="image/svg+xml" href="./favicon-dark.svg" media="(prefers-color-scheme: dark)" />')
  expect(index).toContain('<link rel="icon" type="image/svg+xml" href="./favicon.svg" media="(prefers-color-scheme: light)" />')
  const light = await readFile(join(DIST_ROOT, 'favicon.svg'), 'utf8')
  const dark = await readFile(join(DIST_ROOT, 'favicon-dark.svg'), 'utf8')
  expect(light).not.toContain('<style>')
  expect(light).toContain('data:image/png;base64,')
  expect(dark).toBe(light)
})

it('decodes the Apple touch icon as the transparent product mark', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const png = await readFile(join(ICON_OUTPUT_DIRECTORY, 'apple-touch-icon.png'))
    const image = await pixels(page, pngUrl(png), 180)
    expect([image.width, image.height]).toEqual([180, 180])
    expect(image.corners).toEqual([0, 0, 0, 0])
    expect(image.ink).toBeGreaterThan(0)
  } finally { await browser.close() }
})

it('keeps the shipped maskable artwork inside the any-purpose icon', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const maskable = await readFile(join(DIST_ROOT, 'icon-maskable-512.png'))
    const tile = await readFile(join(DIST_ROOT, 'icon-512.png'))
    const size = APP_ICON_VARIANTS.find(variant => variant.kind === 'maskable')!.size
    const scaled = await pixels(page, pngUrl(maskable), size)
    const unscaled = await pixels(page, pngUrl(tile), size)
    expect(scaled.radius).toBeLessThan(unscaled.radius)
    expect(scaled.corners).toEqual([0, 0, 0, 0])
    expect(scaled.ink).toBeGreaterThan(0)
    expect(unscaled.ink).toBeGreaterThan(0)
  } finally {
    await browser.close()
  }
})
