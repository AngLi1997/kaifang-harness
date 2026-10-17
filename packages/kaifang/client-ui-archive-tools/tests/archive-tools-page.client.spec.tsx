// @vitest-environment jsdom
/** The catalog page lists every tool by section and group and reports card picks. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ArchiveToolsPage, type ArchiveToolsPageProps } from '../src/client/ArchiveToolsPage.tsx'
import { ArchiveToolsIcon } from '../src/client/ArchiveToolsIcon.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

function renderPage(dictionary: Record<string, string>) {
  const onSelectTool = vi.fn()
  const props = { t: makeTranslate(dictionary), onSelectTool } as never as ArchiveToolsPageProps
  render(<ArchiveToolsPage {...props} />)
  return onSelectTool
}

describe('archive tools page', () => {
  it('shows the title, two counted sections, the local groups, and every tool', () => {
    renderPage(zh)
    const page = screen.getByTestId('kaifang-archive-tools-page')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('档案工具')
    const local = screen.getByRole('region', { name: '本地工具' })
    expect(within(local).getByText('4 项')).toBeTruthy()
    expect(within(local).getAllByRole('heading', { level: 3 }).map(node => node.textContent)).toEqual(['图像处理', '文档处理'])
    const online = screen.getByRole('region', { name: '在线工具' })
    expect(within(online).getByText('1 项')).toBeTruthy()
    expect(within(online).queryAllByRole('heading', { level: 3 })).toHaveLength(0)
    expect([...page.querySelectorAll('[data-tool-id]')].map(node => node.getAttribute('data-tool-id')))
      .toEqual(['ocr', 'pdf', 'repair', 'polish', 'demo'])
    expect(page.querySelector('footer')).toBeNull()
  })

  it('reports the picked tool', () => {
    const onSelectTool = renderPage(en)
    fireEvent.click(screen.getByRole('button', { name: 'Reference in the conversation: AI archive cleanup' }))
    expect(onSelectTool).toHaveBeenCalledWith('repair')
  })

  it('draws the sidebar glyph at the requested size', () => {
    const { container } = render(<ArchiveToolsIcon {...{ size: 18, active: false } as Parameters<typeof ArchiveToolsIcon>[0]} />)
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('18')
  })
})
