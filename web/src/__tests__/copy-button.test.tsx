import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CopyButton from '../components/CopyButton.tsx'
import { Markdown } from '../components/Markdown.tsx'
import MessageList from '../components/MessageList.tsx'

const writes: string[] = []

beforeEach(() => {
  writes.length = 0
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: {
      writeText: vi.fn(async (text: string) => {
        writes.push(text)
      }),
    },
    configurable: true,
  })
})

afterEach(cleanup)

describe('复制按钮', () => {
  it('点一下把内容写进剪贴板，并短暂显示「已复制」', async () => {
    render(<CopyButton text="hello world" />)

    fireEvent.click(screen.getByRole('button', { name: /复制/ }))
    expect(writes).toEqual(['hello world'])

    await waitFor(() => expect(screen.getByText('已复制')).toBeTruthy())
  })

  it('代码块右上角也有按钮，复制的是纯代码（不含围栏）', () => {
    render(<Markdown content={'说明文字\n\n```ts\nconst a = 1\nconsole.log(a)\n```\n'} />)

    fireEvent.click(screen.getByRole('button', { name: /复制/ }))

    expect(writes.length).toBe(1)
    expect(writes[0]).toContain('const a = 1')
    expect(writes[0]).toContain('console.log(a)')
    expect(writes[0]).not.toContain('```')
  })

  it('assistant 的最终回答也能一键复制', () => {
    render(
      <MessageList
        messages={[{ id: 'm1', role: 'assistant', content: '最终答案在这里', createdAt: 1 }]}
        running={false}
        undone={[]}
        toolDraft={null}
        onUndo={() => {}}
        emptyHint="空"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /复制/ }))
    expect(writes).toEqual(['最终答案在这里'])
  })

  it('代码块和整段回答是两个独立按钮，各复制各的', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'm2',
            role: 'assistant',
            content: '看这段：\n\n```js\nlet x = 42\n```\n结束。',
            createdAt: 1,
          },
        ]}
        running={false}
        undone={[]}
        toolDraft={null}
        onUndo={() => {}}
        emptyHint="空"
      />,
    )

    const buttons = screen.getAllByRole('button', { name: /复制/ })
    expect(buttons.length).toBe(2) // 代码块 + 整段

    // 现在整段复制按钮在消息下方那一行（行动行），排在代码块按钮之后
    fireEvent.click(buttons[0])
    fireEvent.click(buttons[1])

    expect(writes[0]).toContain('let x = 42')
    expect(writes[0]).not.toContain('看这段')
    expect(writes[1]).toContain('看这段')
    expect(writes[1]).toContain('let x = 42')
  })
})
