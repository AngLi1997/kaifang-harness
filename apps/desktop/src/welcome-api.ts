/** Operations available to the isolated native welcome renderer. */

import type { DesktopLocale } from './locale.ts'

/** Private native welcome channels, installed only while its window exists. */
export const WELCOME_IPC = {
  skip: 'dsh-welcome:skip',
  openSharedHarness: 'dsh-welcome:open-shared-harness',
  passwordSignIn: 'dsh-welcome:platform-password-sign-in',
  readSharedHarnessUrl: 'dsh-welcome:read-shared-harness-url',
  saveSharedHarnessUrl: 'dsh-welcome:save-shared-harness-url',
} as const

/** Credentials entered for the configured Platform IAM. */
export interface PlatformPasswordCredentials {
  readonly username: string
  readonly password: string
}

/** Password login outcome; credential details never cross back to the renderer. */
export type PlatformPasswordSignInResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'username-required' | 'password-required' | 'invalid-credentials' | 'unreachable' | 'failed' }

/** Result returned after validating or persisting a Platform origin. */
export type SharedHarnessUrlSaveResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: 'invalid-url' | 'write-failed' }

/** Host-owned operations used by the welcome window. */
export interface WelcomeOperations {
  /** @returns the saved Platform origin, build-time default, or an empty string. */
  readSharedHarnessUrl(): Promise<string>
  /** @returns the normalized saved URL or a validation/storage failure. */
  saveSharedHarnessUrl(value: string): Promise<SharedHarnessUrlSaveResult>
  /** @returns true when a configured shared Host window opened. */
  openSharedHarness(): Promise<boolean>
  /** Open the configured Platform's public Harness entry page. */
  passwordSignIn(credentials: PlatformPasswordCredentials): Promise<PlatformPasswordSignInResult>
  /** @returns completion after the local workspace opens. */
  skip(): Promise<void>
}

/** The renderer receives localized copy and safe shell operations. */
export type WelcomeApi = DesktopLocale & WelcomeOperations & { readonly initialPage: 'entry' | 'settings' }

/** Authentication facts supplied at cold start or after a completed sign-out. */
export interface WelcomeAuthentication {
  readonly loggedIn: boolean
  readonly hasApiKey: boolean
}

/** Decide whether local workspace startup requires the welcome entry. */
export function needsWelcome(authentication: WelcomeAuthentication): boolean {
  return !authentication.loggedIn && !authentication.hasApiKey
}
