/**
 * Shared-Host Peer roles for admitted `kaifang-user` principals.
 *
 * Product split for Settings chrome:
 * - `permissionPresets/catalog`: Desktop Settings → 权限 must work for Remote Client.
 *   Web does not require a Permissions UI, but the same shared-Host Peer may serve it.
 * - `agentPresets/list|read` (+ session `agentPresets/select`): Desktop and Web Agent 预设.
 *
 * Do not grant `account/watch` — DeepSeek account stream is absent for kaifang-user Peers
 * and would reintroduce the Desktop onboarding hang.
 */

/** Session-scoped Peer actions for an admitted kaifang-user. */
export const PLATFORM_USER_SESSION_ACTIONS = [
  'session/create', 'session/selectModel', 'session/openWorkspacePath', 'session/workspacePathApplications',
  'session/rename', 'session/fork', 'session/prompt', 'session/attachment', 'session/updateQueue',
  'session/cancel', 'session/page', 'session/follow', 'session/projections', 'session/list', 'session/search', 'session/control',
  'workspace/insertSessionBefore', 'workspace/archiveSession', 'workspace/unarchiveSession', 'workspace/deleteSession',
  'workspace/pinSession', 'workspace/unpinSession', 'workspace/follow',
  // Composer / mode-switch and preset selection operate on the admitted session.
  'commands/execute', 'commands/list', 'agentPresets/select',
  'fileUploads/upload', 'fileReferences/list', 'sessionReferenceResolver/candidates',
  'workspaceFiles/list', 'workspaceFiles/read', 'workspaceFiles/readBytes', 'workspaceFiles/stat', 'workspaceFiles/changes',
  'terminal/attach', 'terminal/close', 'terminal/create', 'terminal/environment', 'terminal/list',
  'terminal/rename', 'terminal/retain', 'terminal/shells',
  'subagents/interruptByParent', 'subagents/prompt',
  'userQuestions/answer', 'userQuestions/attachWait',
  'actionCards/act', 'goals/clear', 'goals/complete', 'goals/create', 'goals/edit', 'goals/get', 'goals/pause', 'goals/resume',
  'messageFeedback/delete', 'messageFeedback/list', 'messageFeedback/put', 'sessionFeedback/record',
] as const

/** Workspace-scoped Peer actions for an admitted kaifang-user. */
export const PLATFORM_USER_WORKSPACE_ACTIONS = [
  'workspace/create', 'workspace/initializeDefault', 'workspace/rename', 'workspace/delete', 'session/create',
  'workspace/insertBefore', 'workspace/insertSessionBefore', 'workspace/archiveSession',
  'workspace/unarchiveSession', 'workspace/deleteSession', 'workspace/pinSession', 'workspace/unpinSession', 'workspace/follow',
] as const

/**
 * Global Peer actions for an admitted kaifang-user on the shared Host.
 * No-resource RPCs resolve to the global resource; keep this list limited to
 * safe startup/read operations plus Settings chrome the Peer must serve.
 */
export const PLATFORM_USER_GLOBAL_ACTIONS = [
  'workspace/create', 'workspace/initializeDefault', 'workspace/follow',
  'session/create', 'session/list', 'session/search', 'session/control', 'session/modelCatalog',
  'session/initializeDefaultModel', 'settings/describe', 'settings/mutate', 'settings/update', 'settings/replace',
  'credentials/describe',
  'llm/listProviders', 'llm/listConfigurableProviders', 'llm/discoverModels',
  'directoryPicker/list', 'directoryPicker/createDirectory', 'directoryPicker/pick',
  'permissionPresets/catalog',
  'agentPresets/list', 'agentPresets/read',
  'skills/list',
  'productAnalytics/enabled', 'productAnalytics/report', 'productAnalytics/watchPolicy',
  'schedule/catalog', 'schedule/delete', 'schedule/deleteInactive', 'schedule/history', 'schedule/list', 'schedule/update',
  'knowledge/candidates', 'knowledge/catalog', 'knowledge/create', 'knowledge/delete', 'knowledge/deleteUpload',
  'knowledge/files', 'knowledge/follow', 'knowledge/reindex', 'knowledge/search', 'knowledge/update', 'knowledge/upload',
  'cotTranslation/limits', 'cotTranslation/translate',
  'officeToPdf/generation', 'officeToPdf/render',
  'job/follow', 'job/kill', 'job/list',
  'speech/cancelPreparation', 'speech/catalog', 'speech/configure', 'speech/follow', 'speech/prepare', 'speech/transcribe',
] as const
