import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps, ReactNode } from 'react'
import FloatingAgent from '../components/FloatingAgent.tsx'
import type { ApprovalRequest, AskRequest } from '../lib/tools/types.ts'

/** 默认所有东西都是空的，测试只覆盖自己关心的那几项 */
function renderAgent(
  overrides: Partial<Omit<ComponentProps<typeof FloatingAgent>, 'children'>> = {},
  children: ReactNode = <div>主对话区</div>,
) {
  const props: Omit<ComponentProps<typeof FloatingAgent>, 'children'> = {
    running: false,
    rounds: 0,
    startedAt: null,
    approval: null,
    approvalTimeout: 60,
    approvalLiveDetail: null,
    onDecideApproval: () => {},
    ask: null,
    onAnswerAsk: () => {},
    onInsert: () => {},
    onStop: () => {},
    onClose: () => {},
    ...overrides,
  }
  return render(<FloatingAgent {...props}>{children}</FloatingAgent>)
}

const ask: AskRequest = {
  questions: [
    {
      question: '选一个部署方式',
      options: [{ label: 'Cloudflare' }, { label: '自建' }],
      multiSelect: false,
    },
  ],
}

describe('悬浮窗（内容全部复用网页版组件）', () => {
  it('中间就是传进来的主对话区，原样渲染', () => {
    renderAgent()
    expect(screen.getByText('主对话区')).toBeTruthy()
  })

  it('没有审批和提问时不占位', () => {
    const { container } = renderAgent()
    expect(container.textContent).not.toContain('允许')
    expect(container.textContent).not.toContain('模型在等你回答')
  })

  it('运行中才有「终止」，点了回调 onStop', () => {
    const onStop = vi.fn()
    const { rerender } = renderAgent({ onStop })
    expect(screen.queryByText('终止')).toBeNull()

    rerender(
      <FloatingAgent
        running
        rounds={1}
        startedAt={null}
        approval={null}
        approvalTimeout={60}
        approvalLiveDetail={null}
        onDecideApproval={() => {}}
        ask={null}
        onAnswerAsk={() => {}}
        onInsert={() => {}}
        onStop={onStop}
        onClose={() => {}}
      >
        <div>主对话区</div>
      </FloatingAgent>,
    )
    fireEvent.click(screen.getByRole('button', { name: '终止' }))
    expect(onStop).toHaveBeenCalled()
  })

  it('网页版 ApprovalPanel 原样出现，点「允许」放行', () => {
    const onDecideApproval = vi.fn()
    const approval: ApprovalRequest = { tool: 'bash', summary: '运行 npm test', dangerous: false }
    renderAgent({ approval, onDecideApproval })

    expect(screen.getByText('运行 npm test')).toBeTruthy()
    fireEvent.click(screen.getByText('允许'))
    expect(onDecideApproval).toHaveBeenCalledWith(true)
  })

  it('网页版 AskPanel 原样出现：题目、选项、提交都在', () => {
    const onAnswerAsk = vi.fn()
    renderAgent({ ask, onAnswerAsk })

    expect(screen.getByText('选一个部署方式')).toBeTruthy()
    expect(screen.getByText('Cloudflare')).toBeTruthy()
    expect(screen.getByText('提交')).toBeTruthy()

    fireEvent.click(screen.getByText('Cloudflare'))
    fireEvent.click(screen.getByText('提交'))
    expect(onAnswerAsk).toHaveBeenCalledWith('Q: 选一个部署方式\nA: Cloudflare')
  })
})
