/**
 * Text extraction for indexed files. Plain-text formats decode as UTF-8;
 * Office Open XML documents read their XML parts through fflate; PDF reads the
 * existing text layer through pdfjs. Scanned pages without a text layer yield
 * no text; OCR is out of scope.
 */

import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'

/** One extracted document part, such as a slide or worksheet. */
export interface ExtractedPart {
  /** Part label used as the chunk heading when the text carries none. */
  label?: string
  /** Extracted text. */
  text: string
}

/** Office Open XML extensions read through their XML parts. */
const OFFICE_EXTENSIONS = new Set(['.docx', '.pptx', '.xlsx'])

/**
 * Extract the text of one file.
 * @param path - absolute file path.
 * @returns ordered parts; an empty array when the file has no text.
 */
export async function extractText(path: string): Promise<ExtractedPart[]> {
  const extension = extname(path).toLowerCase()
  const bytes = await readFile(path)
  if (extension === '.pdf') return await extractPdf(bytes)
  if (OFFICE_EXTENSIONS.has(extension)) return extractOffice(extension, bytes)
  const text = decodeText(bytes)
  if (extension === '.html' || extension === '.htm') return [{ text: htmlToText(text) }]
  return [{ text }]
}

/** Decode UTF-8, dropping a byte-order mark; NUL bytes mark binary content and yield nothing. */
function decodeText(bytes: Uint8Array): string {
  if (bytes.includes(0)) return ''
  return new TextDecoder('utf-8', { ignoreBOM: false }).decode(bytes)
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' }

/** Replace the XML/HTML entities that occur in document text. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16))
    if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10))
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

/** Reduce HTML to visible text with block boundaries as line breaks. */
function htmlToText(html: string): string {
  return decodeEntities(html
    .replace(/<(script|style)[\s\S]*?<\/\1>/giu, '')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)\s*>|<br\s*\/?>/giu, '\n')
    .replace(/<[^>]+>/gu, ''))
}

/**
 * Collect text runs of one Office XML part, ending a line at each paragraph.
 * @param xml - part content.
 * @param run - text-run element name (`w:t` or `a:t`).
 * @param paragraph - paragraph element name (`w:p` or `a:p`).
 * @returns paragraphs joined by line breaks.
 */
function officeRuns(xml: string, run: string, paragraph: string): string {
  const lines: string[] = []
  for (const block of xml.split(`</${paragraph}>`)) {
    const texts = [...block.matchAll(new RegExp(`<${run}(?:\\s[^>]*)?>([^<]*)</${run}>`, 'gu'))].map(match => match[1] as string)
    if (texts.length > 0) lines.push(decodeEntities(texts.join('')))
  }
  return lines.join('\n')
}

/** Numeric suffix of a slide or worksheet member name, for ordering. */
function partNumber(name: string): number {
  return Number(name.replace(/\D+/gu, ''))
}

function extractOffice(extension: string, bytes: Uint8Array): ExtractedPart[] {
  const files = unzipSync(bytes, {
    filter: file => file.name === 'word/document.xml'
      || /^ppt\/slides\/slide\d+\.xml$/u.test(file.name)
      || file.name === 'xl/sharedStrings.xml'
      || /^xl\/worksheets\/sheet\d+\.xml$/u.test(file.name),
  })
  if (extension === '.docx') {
    const document = files['word/document.xml']
    return document === undefined ? [] : [{ text: officeRuns(strFromU8(document), 'w:t', 'w:p') }]
  }
  if (extension === '.pptx') {
    return Object.keys(files).filter(name => name.startsWith('ppt/slides/'))
      .sort((left, right) => partNumber(left) - partNumber(right))
      .map(name => ({ label: `Slide ${partNumber(name)}`, text: officeRuns(strFromU8(files[name] as Uint8Array), 'a:t', 'a:p') }))
  }
  const sharedXml = files['xl/sharedStrings.xml']
  const shared = sharedXml === undefined
    ? []
    : strFromU8(sharedXml).split('</si>').map(item => decodeEntities([...item.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/gu)].map(match => match[1]).join('')))
  return Object.keys(files).filter(name => name.startsWith('xl/worksheets/'))
    .sort((left, right) => partNumber(left) - partNumber(right))
    .map(name => ({ label: `Sheet ${partNumber(name)}`, text: sheetText(strFromU8(files[name] as Uint8Array), shared) }))
}

/** Render worksheet rows as tab-separated lines, resolving shared strings. */
function sheetText(xml: string, shared: readonly string[]): string {
  const rows: string[] = []
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gu)) {
    const cells: string[] = []
    for (const cell of (row[1] as string).matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gu)) {
      const body = cell[2] ?? ''
      const value = /<v>([^<]*)<\/v>/u.exec(body)?.[1] ?? /<t(?:\s[^>]*)?>([^<]*)<\/t>/u.exec(body)?.[1] ?? ''
      cells.push(/\bt="s"/u.test(cell[1] as string) ? shared[Number(value)] ?? '' : decodeEntities(value))
    }
    if (cells.some(cell => cell !== '')) rows.push(cells.join('\t'))
  }
  return rows.join('\n')
}

/** Text item of `getTextContent()` without marked content. */
interface PdfTextItem { readonly str: string; readonly hasEOL: boolean }

async function extractPdf(bytes: Uint8Array): Promise<ExtractedPart[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false, verbosity: 0 })
  try {
    const document = await task.promise
    const parts: ExtractedPart[] = []
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      const text = (content.items as PdfTextItem[]).map(item => item.str + (item.hasEOL ? '\n' : '')).join('')
      parts.push({ label: `Page ${pageNumber}`, text })
      page.cleanup()
    }
    return parts
  } finally {
    await task.destroy()
  }
}
