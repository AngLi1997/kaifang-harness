/** Operations available to the isolated native welcome renderer. */

import type { AccountView, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
import type { ProductEventMap } from '@deepseek-ai/dsh-client-product-analytics/types'
import type { DesktopLocale } from './locale.ts'

/** Private native welcome channels, installed only while its window exists. */
export const WELCOME_IPC = {
  saveApiKey: 'dsh-welcome:save-api-key',
  analytics: 'dsh-welcome:analytics',
  analyticsEnabled: 'dsh-welcome:analytics-enabled',
  skip: 'dsh-welcome:skip',
  start: 'dsh-welcome:start',
  cancel: 'dsh-welcome:cancel',
  copyLink: 'dsh-welcome:copy-link',
  state: 'dsh-welcome:state',
  takeNotice: 'dsh-welcome:take-notice',
  readSystemConnection: 'dsh-welcome:read-system-connection',
  saveSystemConnection: 'dsh-welcome:save-system-connection',
  passwordSignIn: 'dsh-welcome:password-sign-in',
} as const

/** Credential writes return a safe outcome without exposing Host diagnostics. */
export type WelcomeSaveResult = { readonly ok: true } | { readonly ok: false }

/** KaifangLab API endpoint, its browser sign-in page, and authorization code; all are required once saved. */
export interface SystemConnection {
  readonly systemUrl: string
  /** KaifangLab Web origin whose `/authorize` page completes browser sign-in. */
  readonly webUrl: string
  readonly authCode: string
}

/** Validation failure reported to the welcome form without exposing filesystem diagnostics. */
export type SystemConnectionInvalid = 'url-required' | 'url-invalid' | 'web-url-required' | 'web-url-invalid' | 'auth-code-required'

/** System connection writes return a field rule failure or a safe write failure. */
export type SystemConnectionSaveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: SystemConnectionInvalid | 'write-failed' }

/** KaifangLab account credentials entered on the password sign-in page. */
export interface PasswordCredentials {
  readonly username: string
  readonly password: string
}

/**
 * Password sign-in outcome; failures carry no server diagnostics.
 * `unreachable` covers transport failures to the configured system URL, `failed` an unexpected response or local write failure.
 */
export type PasswordSignInResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'username-required' | 'password-required' | 'invalid-credentials' | 'unreachable' | 'failed' }

/** One-time notification retained by the main process until Welcome receives it. */
export type WelcomeNotice = 'session-expired'

type WelcomeEventName = 'auth_page_view' | 'auth_page_click' | 'api_key_save_click'

/** Host-owned operations used by the welcome window. */
export interface WelcomeOperations {
  /** @param eventName - allowed welcome event. @param attributes - approved fields without credentials. */
  analytics?<K extends WelcomeEventName>(eventName: K, attributes: ProductEventMap[K]): Promise<void>
  /** @returns the Host's current effective collection policy. */
  analyticsEnabled(): Promise<boolean>
  /** @returns the pending notification, clearing it before another renderer can receive it. */
  takeNotice(): Promise<WelcomeNotice | undefined>
  /** @returns account state after starting a login attempt. */
  startSignIn(): Promise<AccountView>
  /** @param id - attempt to cancel. @returns the settled state. */
  cancelSignIn(id: SignInAttemptId): Promise<AccountView>
  /** @param id - current waiting attempt whose authorization URL is copied to the system clipboard. */
  copySignInLink(id: SignInAttemptId): Promise<void>

  /**
   * Store the official provider's key before entering the workspace.
   * @param value - validated, trimmed API key.
   * @returns whether the write completed, without private error details.
   */
  saveApiKey(value: string): Promise<WelcomeSaveResult>
  /** @returns the saved system connection, or its defaults. */
  readSystemConnection(): Promise<SystemConnection>
  /**
   * Validate and persist the system connection.
   * @param value - system URL and authorization code entered in the settings page.
   * @returns the validation or write outcome.
   */
  saveSystemConnection(value: SystemConnection): Promise<SystemConnectionSaveResult>
  /**
   * Authenticate against the KaifangLab system URL saved in settings, then enter the workspace.
   * @param value - username and password entered in the password sign-in page.
   * @returns the sign-in outcome; success resolves after the workspace opens.
   */
  passwordSignIn(value: PasswordCredentials): Promise<PasswordSignInResult>
  /**
   * Enter the workspace without writing an onboarding-completion setting.
   * @returns completion after the workspace opens.
   */
  skip(): Promise<void>
}

/** The renderer receives localized copy, login operations, and safe account snapshots. */
export type WelcomeApi = DesktopLocale & WelcomeOperations & {
  /** @param listener - safe account snapshot recipient. @returns subscription disposer. */
  onAccountState(listener: (state: AccountView) => void): () => void
}

/** Authentication facts supplied at cold start or after a completed sign-out. */
export interface WelcomeAuthentication {
  readonly loggedIn: boolean
  readonly hasApiKey: boolean
  /** Whether a KaifangLab password session for the configured system URL is stored and unexpired. */
  readonly kaifangSignedIn: boolean
}

/**
 * Decide whether a startup or sign-out requires the welcome entry.
 * @param authentication - current account, KaifangLab session, and independently stored API-key facts.
 * @returns true only when no authentication route is configured.
 */
export function needsWelcome(authentication: WelcomeAuthentication): boolean {
  return !authentication.loggedIn && !authentication.hasApiKey && !authentication.kaifangSignedIn
}
