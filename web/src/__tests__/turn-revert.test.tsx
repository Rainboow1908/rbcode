import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import MessageList from '../components/MessageList.tsx'
import type { Message } from '../lib/types.ts'
import { undoIdsFromMessage } from '../lib/undo.ts'

const msg = (patch: Partial<Message> & { id: string; role: Message['role'] }): Message =>
  ({ content: '', createdAt: Date.now(), ...patch }) as Message

describe('收集可撤销的文件改动（从这条消息到会话末尾）', () => {
  it('跨消息回退时后面的每一轮都要收进来，否则文件退不全', () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: '第一轮' }),
      msg({ id: 't1', role: 'tool', undoId: 'a' }),
      msg({ id: 't2', role: 'tool', undoId: 'b' }),
      msg({ id: 't3', role: 'tool', undoId: 'a' }),
      msg({ id: 'u2', role: 'user', content: '第二轮' }),
      msg({ id: 't4', role: 'tool', undoId: 'c' }),
    ]
    // 回退到 u1：a、b（第一轮）和 c（第二轮）全都得退
    expect(undoIdsFromMessage(messages, 'u1')).toEqual(['a', 'b', 'c'])
    expect(undoIdsFromMessage(messages, 'u2')).toEqual(['c'])
    expect(undoIdsFromMessage(messages, '不存在')).toEqual([])
  })
})

describe('撤销按钮：先问范围', () => {
  // 每个用例一份干净的 DOM，否则上一轮的按钮还在，getByLabelText 会撞到多个
  afterEach(() => cleanup())

  function setup() {
    const onRevertMessage = vi.fn()
    render(
      <MessageList
        messages={[msg({ id: 'u1', role: 'user', content: '随便问一句' })]}
        running={false}
        undone={[]}
        toolDraft={null}
        onUndo={() => {}}
        emptyHint=""
        onRevertMessage={onRevertMessage}
      />,
    )
    return onRevertMessage
  }

  it('三个范围选项都在，选「只撤文件改动」传 files', () => {
    const onRevertMessage = setup()
    fireEvent.click(screen.getByLabelText('撤销到这里'))
    expect(screen.getByText('对话 + 文件一起撤销')).toBeTruthy()
    expect(screen.getByText('只撤对话')).toBeTruthy()
    expect(screen.getByText('只撤文件改动')).toBeTruthy()

    fireEvent.click(screen.getByText('只撤文件改动'))
    expect(onRevertMessage).toHaveBeenCalledWith('u1', 'files')
  })

  it('选「对话 + 文件一起撤销」传 both', () => {
    const onRevertMessage = setup()
    fireEvent.click(screen.getByLabelText('撤销到这里'))
    fireEvent.click(screen.getByText('对话 + 文件一起撤销'))
    expect(onRevertMessage).toHaveBeenCalledWith('u1', 'both')
  })

  it('选「只撤对话」传 conversation', () => {
    const onRevertMessage = setup()
    fireEvent.click(screen.getByLabelText('撤销到这里'))
    fireEvent.click(screen.getByText('只撤对话'))
    expect(onRevertMessage).toHaveBeenCalledWith('u1', 'conversation')
  })
})
