/** Copy for the KaifangMeta model catalog in Models settings. */
export const en = {
  title: 'KaifangMeta platform models',
  description: 'Models enabled for your account in KaifangMeta.',
  empty: 'No enabled platform models are available for this account.',
  loadFailed: 'Could not load platform models',
  refresh: 'Refresh',
} as const

/** Chinese translations of {@link en}. */
export const zh: { [Key in keyof typeof en]: string } = {
  title: 'KaifangMeta 平台模型',
  description: '当前账号在 KaifangMeta 中已启用并授权的模型。',
  empty: '当前账号暂无可用的平台模型。',
  loadFailed: '加载平台模型失败',
  refresh: '刷新',
}
