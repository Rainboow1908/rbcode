import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import AskPanel from '../components/AskPanel.tsx'
import type { AskRequest } from '../lib/tools/types.ts'

/** 三个问题；跟模型参数无关，界面必须保证每题都能自己输入、都能跳过 */
const request: AskRequest = {
  questions: [
    {
      question: '第一题：用哪种语言？',
      options: [{ label: 'TypeScript' }, { label: 'Go' }],
      multiSelect: false,
    },
    {
      question: '第二题：还有别的偏好？',
      options: [],
      multiSelect: false,
    },
    {
      question: '第三题：要哪些附加内容？',
      options: [{ label: '测试' }, { label: '文档' }],
      multiSelect: true,
    },
  ],
}

afterEach(cleanup)

describe('AskPanel', () => {
  it('「第 x/n 题」会随着「下一题」前进', () => {
    render(<AskPanel request={request} onAnswer={() => {}} />)

    expect(screen.getByText(/第 1\/3 题/)).toBeTruthy()
    fireEvent.click(screen.getByText('TypeScript'))
    fireEvent.click(screen.getByRole('button', { name: '下一题' }))

    expect(screen.getByText(/第 2\/3 题/)).toBeTruthy()
    expect(screen.getByText('第二题：还有别的偏好？')).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText('输入你的回答'), { target: { value: '没有' } })
    fireEvent.click(screen.getByRole('button', { name: '下一题' }))

    expect(screen.getByText(/第 3\/3 题/)).toBeTruthy()
    expect(screen.getByText('第三题：要哪些附加内容？')).toBeTruthy()
  })

  it('每一题都能自己输入，不看模型给的 allowCustom', () => {
    render(<AskPanel request={request} onAnswer={() => {}} />)

    // 第一题带选项、且模型说 allowCustom: false —— 仍然要有输入框
    expect(screen.getByPlaceholderText('补充或自定义答案')).toBeTruthy()
  })

  it('自己输入的内容会一起交给模型', () => {
    const answers: string[] = []
    render(<AskPanel request={request} onAnswer={(answer) => answers.push(answer)} />)

    fireEvent.change(screen.getByPlaceholderText('补充或自定义答案'), {
      target: { value: '我想用 Rust' },
    })
    fireEvent.click(screen.getByRole('button', { name: '下一题' }))
    fireEvent.change(screen.getByPlaceholderText('输入你的回答'), { target: { value: '没有' } })
    fireEvent.click(screen.getByRole('button', { name: '下一题' }))
    fireEvent.click(screen.getByText('测试'))
    fireEvent.click(screen.getByRole('button', { name: '提交' }))

    expect(answers.length).toBe(1)
    expect(answers[0]).toContain('我想用 Rust')
    expect(answers[0]).toContain('测试')
  })

  it('跳过某一题之后回到它，「下一题」依然可用（不会被卡住）', () => {
    render(<AskPanel request={request} onAnswer={() => {}} />)

    // 第 1 题直接跳过 → 到第 2 题
    fireEvent.click(screen.getByRole('button', { name: '跳过这题' }))
    expect(screen.getByText(/第 2\/3 题/)).toBeTruthy()

    // 回到第 1 题：这里原来会因为没有答案而把「下一题」禁用，序号就停住不动
    fireEvent.click(screen.getByRole('button', { name: '上一题' }))
    expect(screen.getByText(/第 1\/3 题/)).toBeTruthy()
    const next = screen.getByRole('button', { name: '下一题' }) as HTMLButtonElement
    expect(next.disabled).toBe(false)

    fireEvent.click(next)
    expect(screen.getByText(/第 2\/3 题/)).toBeTruthy()
  })

  it('清空输入后进度要退回去，不留“已回答”的假象', () => {
    render(<AskPanel request={request} onAnswer={() => {}} />)

    const input = screen.getByPlaceholderText('补充或自定义答案')
    fireEvent.change(input, { target: { value: '写点东西' } })
    expect(screen.getByText('1/3 已处理')).toBeTruthy()

    fireEvent.change(input, { target: { value: '' } })
    expect(screen.getByText('0/3 已处理')).toBeTruthy()
    expect((screen.getByRole('button', { name: '下一题' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('跳过的题会以 (skipped) 一起交给模型', () => {
    const answers: string[] = []
    render(<AskPanel request={request} onAnswer={(answer) => answers.push(answer)} />)

    fireEvent.click(screen.getByRole('button', { name: '跳过这题' }))
    fireEvent.change(screen.getByPlaceholderText('输入你的回答'), { target: { value: '第二题的回答' } })
    fireEvent.click(screen.getByRole('button', { name: '下一题' }))
    fireEvent.click(screen.getByText('测试'))
    fireEvent.click(screen.getByRole('button', { name: '提交' }))

    expect(answers.length).toBe(1)
    expect(answers[0]).toContain('(skipped)')
    expect(answers[0]).toContain('第二题的回答')
    expect(answers[0]).toContain('测试')
  })
})
