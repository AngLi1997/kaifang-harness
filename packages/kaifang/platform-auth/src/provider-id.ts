/** Prefix shared by Host model routes and the browser's platform-model view. */
export const KAIFANG_MODEL_PROVIDER_PREFIX = 'kaifang-meta-'

/** Whether a provider route belongs to the KaifangMeta model adapter. */
export function isKaifangModelProvider(provider: string): boolean {
  return provider.startsWith(KAIFANG_MODEL_PROVIDER_PREFIX)
}
