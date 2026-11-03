/** Operations available to the isolated native welcome renderer. */

import type { DesktopLocale } from './locale.ts'

/** Private native welcome channels, installed only while its window exists. */
export const WELCOME_IPC = {
  skip: 'dsh-welcome:skip',
  startBrowserSignIn: 'dsh-welcome:start-browser-sign-in',
  cancelBrowserSignIn: 'dsh-welcome:cancel-browser-sign-in',
  passwordSignIn: 'dsh-welcome:platform-password-sign-in',
  readSharedHarnessUrl: 'dsh-welcome:read-shared-harness-url',
  saveSharedHarnessUrl: 'dsh-welcome:save-shared-harness-url',
} as const

/** Credentials entered for the configured Platform IAM (legacy in-app form). */
export interface PlatformPasswordCredentials {
  readonly username: string
  readonly password: string
}

/** Password login outcome; credential details never cross back to the renderer. */
export type PlatformPasswordSignInResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'username-required' | 'password-required' | 'invalid-credentials' | 'unreachable' | 'failed' }

/** Browser OAuth outcome for the welcome primary action. */
export type PlatformBrowserSignInResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'url-required' | 'unreachable' | 'cancelled' | 'expired' | 'denied' | 'failed' }

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
  /**
   * Open the system browser to the Platform authorization page and wait for the loopback callback.
   * @returns success after the native workspace opens, or a safe failure reason.
   */
  startBrowserSignIn(): Promise<PlatformBrowserSignInResult>
  /** Cancel an in-flight browser authorization attempt. */
  cancelBrowserSignIn(): Promise<void>
  /** Legacy password form; Desktop prefers browser OAuth and may route this to the same flow. */
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
  /** Whether a Platform IAM session for the configured origin is stored and still usable. */
  readonly platformSignedIn: boolean
}

/** Decide whether local workspace startup requires the welcome entry. */
export function needsWelcome(authentication: WelcomeAuthentication): boolean {
  return !authentication.loggedIn && !authentication.hasApiKey && !authentication.platformSignedIn
}
