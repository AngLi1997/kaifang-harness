/** KaifangLab identity published by the Desktop preload; absent in ordinary browsers. */

/** Signed-in KaifangLab account; carries no token. */
export interface KaifangAccount {
  readonly username: string
  readonly displayName: string
  readonly email: string | null
  /** Absolute http(s) picture URL, or null when the profile has none. */
  readonly avatarUrl: string | null
}

/** `dshDesktop.kaifang` operations exposed by the Desktop application preload. */
export interface KaifangBridge {
  /** @returns the signed-in account, or null when no session is stored. */
  current(): Promise<KaifangAccount | null>
  /** @returns after the Desktop removes the session and returns to its welcome window when nothing else signs in. */
  signOut(): Promise<void>
  /** @param listener - receives each sign-in and sign-out. @returns subscription disposer. */
  subscribe(listener: (account: KaifangAccount | null) => void): () => void
}

/**
 * Locate the Desktop KaifangLab bridge.
 * @param scope - global object carrying the preload API.
 * @returns the bridge, or undefined outside a Desktop build that provides it.
 */
export function kaifangBridge(scope: typeof globalThis): KaifangBridge | undefined {
  return (scope as typeof globalThis & { dshDesktop?: { kaifang?: KaifangBridge } }).dshDesktop?.kaifang
}
