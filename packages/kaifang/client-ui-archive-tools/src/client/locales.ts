/** Archive tool catalog, sidebar entry, and `@` picker copy. */

/** Locale namespace owned by this plugin. */
export const NS = 'kaifang.archiveTools'

/** Chinese copy. */
export const zh = {
  'panel': '档案工具',
  'page.title': '档案工具',
  'section.local': '本地工具',
  'section.online': '在线工具',
  'section.count': '{count} 项',
  'group.image': '图像处理',
  'group.document': '文档处理',
  'card.use': '在对话中引用：{name}',
  'menu.section': '档案工具',
  'menu.meta.image': '本地 · 图像处理',
  'menu.meta.document': '本地 · 文档处理',
  'menu.meta.online': '在线',
  'insert.failed': '当前对话暂时无法插入引用，请稍后再试。',
  'tool.ocr.name': 'OCR 文字识别',
  'tool.ocr.desc': '识别图片中的印刷体文字，输出可检索、可复制的文本。',
  'tool.pdf.name': '图片转双层 PDF',
  'tool.pdf.desc': '保留原始图像外观，叠加可搜索的文字层，便于归档与检索。',
  'tool.repair.name': 'AI 修档案',
  'tool.repair.desc': '自动裁切黑边、去除扫描噪点，还原干净平整的档案页面。',
  'tool.polish.name': '插件润色',
  'tool.polish.desc': '润色插件说明、界面文案与提示词，统一表达与术语。',
  'tool.demo.name': 'Demo 测试',
  'tool.demo.desc': '在线连通性与能力演示，用于验证工具调用链路。',
}

/** Dictionary key union of {@link NS}. */
export type ArchiveToolsKey = keyof typeof zh

/** English copy. */
export const en: Record<ArchiveToolsKey, string> = {
  'panel': 'Archive tools',
  'page.title': 'Archive tools',
  'section.local': 'Local tools',
  'section.online': 'Online tools',
  'section.count': '{count} items',
  'group.image': 'Image processing',
  'group.document': 'Document processing',
  'card.use': 'Reference in the conversation: {name}',
  'menu.section': 'Archive tools',
  'menu.meta.image': 'Local · Image processing',
  'menu.meta.document': 'Local · Document processing',
  'menu.meta.online': 'Online',
  'insert.failed': 'The reference could not be inserted into this conversation. Try again in a moment.',
  'tool.ocr.name': 'OCR text recognition',
  'tool.ocr.desc': 'Recognize printed text in an image and return searchable, copyable text.',
  'tool.pdf.name': 'Image to searchable PDF',
  'tool.pdf.desc': 'Keep the original page image and add a searchable text layer for archiving.',
  'tool.repair.name': 'AI archive cleanup',
  'tool.repair.desc': 'Crop black borders and remove scan noise to restore a clean, level page.',
  'tool.polish.name': 'Plugin copy polish',
  'tool.polish.desc': 'Polish plugin descriptions, interface copy, and prompts into one consistent voice.',
  'tool.demo.name': 'Demo test',
  'tool.demo.desc': 'An online connectivity and capability demo for checking the tool pipeline.',
}
