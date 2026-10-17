/** Pure helpers shared by the page, the `@` source, and the ask action. */
import type { DraftSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Input-trigger source name that owns knowledge base chips. */
export const KNOWLEDGE_SOURCE = 'knowledge'

/**
 * Compose a draft that starts with one knowledge base chip.
 * @param mention - the base's canonical mention from the Host catalog.
 * @param name - user-facing name shown on the chip.
 * @param prompt - text after the chip.
 * @returns the draft document; the chip's span equals its mention text.
 */
export function knowledgeDraft(mention: string, name: string, prompt: string): DraftSnapshot {
  return {
    text: `${mention} ${prompt}`,
    references: [{
      source: KNOWLEDGE_SOURCE, ref: mention, offset: 0, length: mention.length, label: name, appearance: 'folder', clipboardText: mention,
    }],
  }
}

/**
 * Encode bytes as canonical base64 without building one large intermediate string per byte.
 * @param bytes - file content.
 * @returns base64 text.
 */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

/**
 * Lowercase extension with its leading dot.
 * @param name - file name.
 * @returns the extension, or an empty string without one.
 */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

/**
 * Last path segment for display.
 * @param path - absolute Host path in POSIX or Windows form.
 * @returns the base name, or the path itself when it has no separator.
 */
export function baseName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path
}
