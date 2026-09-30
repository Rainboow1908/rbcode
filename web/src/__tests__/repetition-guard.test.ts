import { describe, expect, it, vi } from 'vitest'
import { runAgent, type AgentEvent } from '../lib/agent.ts'
import type { Backend, FileNode, ShellResult } from '../lib/executor/types.ts'
import type { ToolContext } from '../lib/tools/types.ts'

/** 只记录调用参数的假后端 */
class StubBackend implements Backend {
  readonly kind = 'companion' as const
  readonly label = 'stub'
  readonly rootLabel = 'stub'
  readonly capabilities = { shell: false, miniShell: false, python: false, unrestricted: false }
  async readFile(): Promise<string> {
    return ''
  }
  async writeFile(): Promise<void> {}
  async list(): Promise<FileNode[]> {
    return []
  }
  async exists(): Promise<boolean> {
    return false
  }
  async mkdir(): Promise<void> {}
  async remove(): Promise<void> {}
  async glob(): Promise<string[]> {
    return []
  }
  async grep(): Promise<string> {
    return ''
  }
  async shell(): Promise<ShellResult> {
    return { stdout: '', stderr: '', exitCode: 0 }
  }
}

vi.mock('../lib/llm.ts', () => ({
  chatStream: vi.fn(),
  complete: vi.fn(async () => ''),
}))

import { chatStream } from '../lib/llm.ts'

const target = {
  baseURL: 'https://example.test/v1',
  apiKey: 'k',
  apiStyle: 'openai' as const,
  model: 'm',
}

function makeCtx(): ToolContext {
  return {
    backend: new StubBackend(),
    getTodos: () => [],
    setTodos: () => {},
    askUser: async () => 'ok',
    recordUndo: async () => 'undo-1',
  }
}

const UNIT = '这一段内容模型会原封不动地重复很多遍，说明它已经卡住了，应该马上停下来。'

describe('重复内容检测：自动停止', () => {
  it('连续重复到阈值 → 报 repetition、不再跑工具、不报「达到单轮上限」', async () => {
    vi.mocked(chatStream).mockImplementation(async (opts) => {
      for (let i = 0; i < 8; i += 1) {
        opts.onChunk({ type: 'text', text: UNIT })
        if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      }
      opts.onChunk({ type: 'done' })
    })

    const events: AgentEvent[] = []
    const controller = new AbortController()
    await runAgent({
      target,
      system: '',
      history: [{ id: 'u1', role: 'user', content: '写一段说明', createdAt: 0 }],
      ctx: makeCtx(),
      planMode: false,
      permission: 'full',
      requestApproval: async () => true,
      maxIterations: 10,
      repetition: { scope: 'text', minUnit: 20, threshold: 3, checkEvery: 40 },
      signal: controller.signal,
      onEvent: (evt) => events.push(evt),
    })

    const repeat = events.find((evt) => evt.type === 'repetition')
    expect(repeat).toBeTruthy()
    expect(events.some((evt) => evt.type === 'iteration_limit')).toBe(false)
    expect(events.at(-1)?.type).toBe('done')

    // 已经吐出来的重复内容会被裁掉（只留下第一次出现之前的部分）
    const end = events.find((evt) => evt.type === 'assistant_end')
    expect(end).toBeTruthy()
    if (end?.type === 'assistant_end') {
      expect(end.message.content.length).toBeLessThan(UNIT.length * 8)
      expect(end.message.toolCalls ?? []).toEqual([])
    }
    // 是「我们自己」掐断的，不是用户点的停止
    expect(controller.signal.aborted).toBe(false)
  })

  it('关掉检测（不传 repetition）时照常把重复内容吐完', async () => {
    vi.mocked(chatStream).mockImplementation(async (opts) => {
      for (let i = 0; i < 5; i += 1) opts.onChunk({ type: 'text', text: UNIT })
      opts.onChunk({ type: 'done' })
    })

    const events: AgentEvent[] = []
    await runAgent({
      target,
      system: '',
      history: [{ id: 'u1', role: 'user', content: '写一段说明', createdAt: 0 }],
      ctx: makeCtx(),
      planMode: false,
      permission: 'full',
      requestApproval: async () => true,
      maxIterations: 10,
      signal: new AbortController().signal,
      onEvent: (evt) => events.push(evt),
    })

    expect(events.some((evt) => evt.type === 'repetition')).toBe(false)
    const end = events.find((evt) => evt.type === 'assistant_end')
    if (end?.type === 'assistant_end') {
      expect(end.message.content).toBe(UNIT.repeat(5))
    }
  })
})
