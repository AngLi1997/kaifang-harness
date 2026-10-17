/**
 * Split extracted text into bounded chunks along line boundaries. Markdown
 * headings start a new chunk and become the heading of the chunks under them.
 */

import type { ExtractedPart } from './extract.ts'

/** One indexed unit of text. */
export interface TextChunk {
  /** Nearest Markdown heading, or the part label. */
  heading?: string
  /** One-based first line within the extracted part. */
  lineStart: number
  /** Chunk text. */
  text: string
}

/** Chunk size bounds in UTF-16 code units. */
export interface ChunkLimits {
  /** Target maximum characters per chunk. */
  chunkChars: number
  /** Trailing characters of one chunk repeated at the start of the next within the same section. */
  overlapChars: number
}

const HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/u

/**
 * Chunk every part of one document.
 * @param parts - extracted parts in document order.
 * @param limits - configured chunk bounds.
 * @returns non-empty chunks in document order.
 */
export function chunkParts(parts: readonly ExtractedPart[], limits: ChunkLimits): TextChunk[] {
  return parts.flatMap(part => chunkText(part.text, part.label, limits))
}

/** One buffered line piece and its one-based source line. */
interface Piece {
  readonly text: string
  readonly line: number
}

function chunkText(text: string, label: string | undefined, limits: ChunkLimits): TextChunk[] {
  const chunks: TextChunk[] = []
  let heading = label
  let pieces: Piece[] = []
  let size = 0
  const flush = (carry: boolean): void => {
    const body = pieces.map(piece => piece.text).join('\n').trim()
    if (body !== '') {
      chunks.push({ ...heading === undefined ? {} : { heading }, lineStart: (pieces[0] as Piece).line, text: body })
    }
    pieces = carry && limits.overlapChars > 0 ? overlapTail(pieces, limits.overlapChars) : []
    size = pieces.reduce((total, piece) => total + piece.text.length + 1, 0)
  }
  const lines = text.replace(/\r\n?/gu, '\n').split('\n')
  for (const [index, raw] of lines.entries()) {
    const title = HEADING.exec(raw)?.[1]
    if (title !== undefined) {
      flush(false)
      heading = label === undefined ? title : `${label} › ${title}`
    }
    for (const part of splitLong(raw, limits.chunkChars)) {
      if (size + part.length > limits.chunkChars && pieces.length > 0) {
        flush(true)
        // Overlap never pushes a chunk past its bound.
        if (size + part.length > limits.chunkChars) {
          pieces = []
          size = 0
        }
      }
      pieces.push({ text: part, line: index + 1 })
      size += part.length + 1
    }
  }
  flush(false)
  return chunks
}

/** Whole trailing pieces, excluding the first, whose total length stays within the overlap. */
function overlapTail(pieces: readonly Piece[], overlapChars: number): Piece[] {
  const tail: Piece[] = []
  let size = 0
  for (let index = pieces.length - 1; index > 0; index -= 1) {
    const piece = pieces[index] as Piece
    if (size + piece.text.length > overlapChars) break
    tail.unshift(piece)
    size += piece.text.length + 1
  }
  return tail
}

/** Split one line longer than the chunk size into chunk-sized pieces. */
function splitLong(line: string, chunkChars: number): string[] {
  if (line.length <= chunkChars) return [line]
  const pieces: string[] = []
  for (let offset = 0; offset < line.length; offset += chunkChars) pieces.push(line.slice(offset, offset + chunkChars))
  return pieces
}
