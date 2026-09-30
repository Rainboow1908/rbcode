import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import MessageList from '../components/MessageList.tsx'
import type { Message } from '../lib/types.ts'

afterEach(cleanup)

const createdAt = 1

/** 一段被压缩归档的历史 + 压缩工具卡片 + 之后的近期消息 */
const messages: Message[] = [
  { id: 'u1', role: 'user', content: '第一条', createdAt, compacted: true },
  {
    id: 'a1',
    role: 'assistant',
    content: '我看看',
    toolCalls: [{ id: 'old-1', name: 'bash', args: { command: 'ls' } }],
    createdAt,
    compacted: true,
  },
  {
    id: 't1',
    role: 'tool',
    toolCallId: 'old-1',
    toolName: 'bash',
    content: 'a.txt',
    createdAt,
    compacted: true,
  },
  {
    id: 'ac',
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'call-1', name: 'compact_context', args: { kept: 4 } }],
    uiOnly: true,
    createdAt,
  },
  {
    id: 'tc',
    role: 'tool',
    toolCallId: 'call-1',
    toolName: 'compact_context',
    content: 'SUMMARY TEXT',
    uiOnly: true,
    createdAt,
  },
  { id: 'u2', role: 'user', content: '继续', createdAt },
]

function renderList(compactActivity: boolean) {
  return render(
    <MessageList
      messages={messages}
      running={false}
      undone={[]}
      toolDraft={null}
      onUndo={() => {}}
      emptyHint=""
      compactActivity={compactActivity}
    />,
  )
}

it('紧凑过程：压缩变成 Used 行里的 Compact', () => {
  renderList(true)
  expect(screen.getAllByText(/^Used 1 Compact$/).length).toBeGreaterThan(0)
})

it('普通模式：压缩直接是一张 compact_context 工具卡片', () => {
  renderList(false)
  // 白色的是英文工具名，浅色的是本地化动词
  expect(screen.getAllByText('compact_context').length).toBeGreaterThan(0)
  expect(screen.getAllByText('压缩上下文').length).toBeGreaterThan(0)
})

it('回合没跑完：不在下方多出一行（时间/复制），跑完才出现', () => {
  const msgs: Message[] = [
    { id: 'u1', role: 'user', content: 'q1', createdAt },
    { id: 'a1', role: 'assistant', content: '答案1', createdAt },
    { id: 'u2', role: 'user', content: 'q2', createdAt },
    { id: 'a2', role: 'assistant', content: '中途说的话', createdAt },
  ]
  const props = { messages: msgs, undone: [], toolDraft: null, onUndo: () => {}, emptyHint: '' }
  const timePattern = /^\d+-\d+ \d\d:\d\d$/
  const first = render(<MessageList {...props} running compactActivity />)
  // 运行中：u1 / u2 的行 + 上一回合（已跑完）的最终输出 a1，共 3 行；当前回合 a2 还没定
  expect(screen.getAllByText(timePattern).length).toBe(3)
  first.unmount()
  render(<MessageList {...props} running={false} compactActivity />)
  // 跑完：当前回合的最终输出 a2 也铺出一行 → 4
  expect(screen.getAllByText(timePattern).length).toBe(4)
})

it('回合内插了压缩摘要也不会把中途文本误判成最终输出', () => {
  const msgs: Message[] = [
    { id: 'u1', role: 'user', content: 'q1', createdAt },
    { id: 'a1', role: 'assistant', content: '中途说的话', createdAt },
    // 压缩时插入的隐藏摘要（role=user）夹在回合中间
    { id: 'sum', role: 'user', content: '[Summary of earlier conversation]\n…', createdAt, hidden: true },
    { id: 'a2', role: 'assistant', content: '最终答案', createdAt },
  ]
  render(
    <MessageList
      messages={msgs}
      running={false}
      undone={[]}
      toolDraft={null}
      onUndo={() => {}}
      emptyHint=""
      compactActivity
    />,
  )
  // 只有 u1 和 a2（回合最终输出）有行动行；a1 不该有
  expect(screen.getAllByText(/^\d+-\d+ \d\d:\d\d$/).length).toBe(2)
})

it('结果模式：只显示 Done + 最终输出，过程默认不显示', () => {
  const messages: Message[] = [
    { id: 'u1', role: 'user', content: '问题', createdAt },
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      reasoning: '想一想',
      toolCalls: [{ id: 'c1', name: 'bash', args: { command: 'ls' } }],
      createdAt,
    },
    { id: 't1', role: 'tool', toolCallId: 'c1', toolName: 'bash', content: 'a.txt', createdAt },
    { id: 'a2', role: 'assistant', content: '最终答案', createdAt },
  ]
  const { container } = render(
    <MessageList
      messages={messages}
      running={false}
      undone={[]}
      toolDraft={null}
      onUndo={() => {}}
      emptyHint=""
      resultOnly
    />,
  )
  // 只显示 Done 标签，不出现 Used
  expect(screen.getByText('Done')).toBeTruthy()
  expect(container.textContent).not.toMatch(/Used \d/)
  // 中途 AI 文本不显示，只显示最终输出
  expect(screen.getByText('最终答案')).toBeTruthy()
  // 过程默认不显示（未展开）
  expect(container.textContent).not.toContain('a.txt')
  // 展开之后能看到过程
  fireEvent.click(screen.getByText('Done'))
  expect(container.textContent).toContain('a.txt')
})

it('紧凑过程展开后按真实顺序：思考 → 工具 → 思考 → 工具', () => {
  const seq: Message[] = [
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      reasoning: '第一段思考',
      toolCalls: [{ id: 'c1', name: 'bash', args: { command: 'ls' } }],
      createdAt,
    },
    {
      id: 'a2',
      role: 'assistant',
      content: '',
      reasoning: '第二段思考',
      toolCalls: [{ id: 'c2', name: 'grep', args: { pattern: 'x' } }],
      createdAt,
    },
  ]
  const { container } = render(
    <MessageList
      messages={seq}
      running={false}
      undone={[]}
      toolDraft={null}
      onUndo={() => {}}
      emptyHint=""
      compactActivity
    />,
  )
  // 展开 Used 行
  fireEvent.click(screen.getByText(/^Used /))
  const text = container.textContent ?? ''
  const i1 = text.indexOf('第一段思考')
  const iBash = text.indexOf('bash')
  const i2 = text.indexOf('第二段思考')
  const iGrep = text.indexOf('grep')
  expect(i1).toBeGreaterThan(-1)
  expect(i1).toBeLessThan(iBash)
  expect(iBash).toBeLessThan(i2)
  expect(i2).toBeLessThan(iGrep)
})
