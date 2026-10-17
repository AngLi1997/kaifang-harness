/**
 * Embedders and int8 vector arithmetic. `hashed-ngram` runs in-process with
 * no model file: it hashes CJK character unigrams and bigrams plus Latin words
 * and their character trigrams into a fixed-size vector, so it ranks lexical
 * and near-lexical similarity on any device. `openai-compatible` calls an
 * explicitly configured `/embeddings` endpoint, such as a local Ollama or
 * llama.cpp server, and sends chunk text to that endpoint.
 */

/** One text-to-vector implementation. */
export interface KnowledgeEmbedder {
  /** Stable model identity stored beside each vector; a change invalidates stored vectors. */
  readonly id: string
  /**
   * Embed texts in order.
   * @param texts - chunk or query texts.
   * @param signal - caller cancellation.
   * @returns one L2-normalized vector per text.
   */
  embed(texts: readonly string[], signal: AbortSignal): Promise<Float32Array[]>
}

/** One int8-quantized unit vector. */
export interface QuantizedVector {
  /** Multiplier restoring the original components. */
  readonly scale: number
  /** Quantized components. */
  readonly data: Int8Array
}

const CJK = /[㐀-鿿豈-﫿]/u
const WORD = /[\p{L}\p{N}_]+/gu

/** 32-bit FNV-1a hash. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Hashed features of one text: CJK unigrams and bigrams, Latin words and their trigrams. */
function features(text: string): string[] {
  const result: string[] = []
  for (const match of text.toLowerCase().matchAll(WORD)) {
    const word = match[0]
    if (CJK.test(word)) {
      const chars = Array.from(word)
      for (let index = 0; index < chars.length; index += 1) {
        const char = chars[index] as string
        if (!CJK.test(char)) continue
        result.push(char)
        const next = chars[index + 1]
        if (next !== undefined && CJK.test(next)) result.push(char + next)
      }
      continue
    }
    result.push(`w:${word}`)
    if (word.length > 3) for (let index = 0; index + 3 <= word.length; index += 1) result.push(`t:${word.slice(index, index + 3)}`)
  }
  return result
}

/** L2-normalize in place; a zero vector stays zero. */
function normalize(vector: Float32Array): Float32Array {
  let norm = 0
  for (const value of vector) norm += value * value
  if (norm === 0) return vector
  const inverse = 1 / Math.sqrt(norm)
  for (let index = 0; index < vector.length; index += 1) vector[index] = (vector[index] as number) * inverse
  return vector
}

/**
 * Create the in-process hashed n-gram embedder.
 * @param dimensions - vector length.
 * @returns embedder with id `hashed-ngram-<dimensions>`.
 */
export function createHashedNgramEmbedder(dimensions: number): KnowledgeEmbedder {
  return {
    id: `hashed-ngram-${dimensions}`,
    embed: (texts) => {
      return Promise.resolve(texts.map((text) => {
        const counts = new Map<number, number>()
        for (const feature of features(text)) {
          const hash = fnv1a(feature)
          const slot = hash % dimensions
          const signed = (hash & 0x80000000) === 0 ? slot + 1 : -(slot + 1)
          counts.set(signed, (counts.get(signed) ?? 0) + 1)
        }
        const vector = new Float32Array(dimensions)
        for (const [signed, count] of counts) {
          const slot = Math.abs(signed) - 1
          vector[slot] = (vector[slot] as number) + Math.sign(signed) * (1 + Math.log(count))
        }
        return normalize(vector)
      }))
    },
  }
}

/** Connection fields of an OpenAI-compatible embeddings endpoint. */
export interface OpenAiCompatibleEmbedderOptions {
  /** Base URL that serves `POST <baseUrl>/embeddings`. */
  readonly baseUrl: string
  /** Model name sent with each request. */
  readonly model: string
  /** Texts per request. */
  readonly batchSize: number
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs: number
}

interface EmbeddingResponse { readonly data?: readonly { readonly embedding?: readonly number[]; readonly index?: number }[] }

/**
 * Create an embedder that calls an OpenAI-compatible `/embeddings` endpoint.
 * @param options - endpoint, model, batch size, and timeout.
 * @returns embedder with id `openai-compatible:<model>`.
 */
export function createOpenAiCompatibleEmbedder(options: OpenAiCompatibleEmbedderOptions): KnowledgeEmbedder {
  const url = `${options.baseUrl.replace(/\/+$/u, '')}/embeddings`
  return {
    id: `openai-compatible:${options.model}`,
    embed: async (texts, signal) => {
      const vectors: Float32Array[] = []
      for (let offset = 0; offset < texts.length; offset += options.batchSize) {
        const batch = texts.slice(offset, offset + options.batchSize)
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: options.model, input: batch }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]),
        })
        if (!response.ok) throw new Error(`embedding endpoint returned HTTP ${response.status}`)
        const body = await response.json() as EmbeddingResponse
        const data = body.data
        if (data?.length !== batch.length) throw new Error('embedding endpoint returned an unexpected number of vectors')
        const ordered = data.toSorted((left, right) => (left.index ?? 0) - (right.index ?? 0))
        for (const item of ordered) {
          const embedding = item.embedding
          if (embedding === undefined || embedding.length === 0) throw new Error('embedding endpoint returned an empty vector')
          vectors.push(normalize(Float32Array.from(embedding)))
        }
      }
      return vectors
    },
  }
}

/**
 * Quantize a unit vector to int8 with one shared scale.
 * @param vector - L2-normalized vector.
 * @returns scale and components.
 */
export function quantize(vector: Float32Array): QuantizedVector {
  let max = 0
  for (const value of vector) max = Math.max(max, Math.abs(value))
  const scale = max === 0 ? 0 : max / 127
  const data = new Int8Array(vector.length)
  if (scale !== 0) for (let index = 0; index < vector.length; index += 1) data[index] = Math.round((vector[index] as number) / scale)
  return { scale, data }
}

/**
 * Cosine similarity of two quantized unit vectors of equal length.
 * @param left - first vector.
 * @param right - second vector.
 * @returns approximate cosine similarity; zero when lengths differ.
 */
export function similarity(left: QuantizedVector, right: QuantizedVector): number {
  if (left.data.length !== right.data.length) return 0
  let sum = 0
  for (let index = 0; index < left.data.length; index += 1) sum += (left.data[index] as number) * (right.data[index] as number)
  return sum * left.scale * right.scale
}
