import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useAgent } from '../hooks/useAgent.ts'
import { migrateCompaction } from '../lib/compact.ts'
import { defaultSettings } from '../lib/settings.ts'
import type { Message } from '../lib/types.ts'

vi.mock('../lib/llm.ts', () => ({
  chatStream: vi.fn(async () => undefined),
  complete: vi.fn(async () => 'SUMMARY TEXT'),
}))

const createdAt = 1

function conversation(): Message[] {
  const out: Message[] = []
  for (let i = 0; i < 14; i++) {
    out.push({ id: `u${i}`, role: 'user', content: `问题 ${i}`, createdAt })
    out.push({ id: `a${i}`, role: 'assistant', content: `回答 ${i}`, createdAt })
  }
  return out
}

it('/compact 之后界面消息里出现 compact_context 的仅展示调用', async () => {
  const settings = defaultSettings()
  settings.providers = [
    {
      id: 'p1',
      name: 'P',
      baseURL: 'http://example.test/v1',
      apiKey: 'k',
      apiStyle: 'openai',
      models: [{ id: 'test-model' }],
    },
  ]
  settings.activeProviderId = 'p1'
  settings.activeModel = 'test-model'

  const { result } = renderHook(() =>
    useAgent({
      settings,
      backend: null,
      planMode: false,
      activeSessionId: 's1',
      requestApproval: async () => true,
      askUser: async () => '',
    }),
  )

  act(() => result.current.loadMessages('s1', conversation()))
  await act(async () => {
    await result.current.compactNow('s1')
  })

  const messages = result.current.messages as Message[]
  expect(
    messages.some((m) => m.uiOnly && m.toolCalls?.some((c) => c.name === 'compact_context')),
  ).toBe(true)
  expect(messages.some((m) => m.role === 'tool' && m.toolName === 'compact_context')).toBe(true)
  // 模型侧拿到的摘要仍然是一条隐藏消息
  expect(messages.some((m) => m.hidden && m.content.startsWith('[Summary of earlier'))).toBe(true)
})

it('旧数据迁移：把普通摘要消息补成隐藏摘要 + compact_context 卡片', () => {
  const legacy: Message[] = [
    { id: 'u0', role: 'user', content: '问', createdAt },
    {
      id: 'sum',
      role: 'assistant',
      content: '[Summary of earlier conversation]\n老的摘要内容',
      createdAt,
      compacted: true,
    },
    { id: 'a1', role: 'assistant', content: '继续', createdAt },
  ]

  const migrated = migrateCompaction(legacy)
  expect(migrated.find((m) => m.id === 'sum')?.hidden).toBe(true)
  expect(
    migrated.some((m) => m.uiOnly && m.toolCalls?.some((c) => c.name === 'compact_context')),
  ).toBe(true)
  const result = migrated.find((m) => m.role === 'tool' && m.toolName === 'compact_context')
  expect(result?.content).toBe('老的摘要内容')
})
