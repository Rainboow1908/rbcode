import { describe, expect, it, vi } from 'vitest'
import { runAgent } from '../lib/agent.ts'
import type { Backend, FileNode, ShellResult } from '../lib/executor/types.ts'
import type { ToolContext } from '../lib/tools/types.ts'
import type { Message, ToolCall } from '../lib/types.ts'

/** ֻ��¼���õļ����� */
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

// ��ϸ����ģ�����
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

/** 允许执行真实命令的后端：只有它能拿到 bash 工具 */
class ShellStubBackend extends StubBackend {
  override readonly capabilities = {
    shell: true,
    miniShell: false,
    python: true,
    unrestricted: true,
  }
}

function makeCtx(backend: Backend = new StubBackend()): ToolContext {
  return {
    backend,
    getTodos: () => [],
    setTodos: () => {},
    askUser: async () => 'pick the default',
    recordUndo: async () => 'undo-1',
  }
}

const THREE_CALLS: ToolCall[] = [
  { id: 'c1', name: 'list_dir', args: { path: '.' } },
  { id: 'c2', name: 'list_dir', args: { path: 'src' } },
  { id: 'c3', name: 'list_dir', args: { path: 'lib' } },
]

describe('�ж�ʱ����ʷһ����', () => {
  it('��ֹ����Ϊÿ�� tool_call ������Ӧ��Ϣ', async () => {
    vi.mocked(chatStream).mockImplementation(async (opts) => {
      opts.onChunk({ type: 'tool_calls', calls: THREE_CALLS })
      opts.onChunk({ type: 'done' })
    })

    const controller = new AbortController()
    const toolMessages: Message[] = []

    await runAgent({
      target,
      system: '',
      history: [{ id: 'u1', role: 'user', content: 'list files', createdAt: 0 }],
      ctx: makeCtx(),
      planMode: false,
      permission: 'full',
      requestApproval: async () => true,
      maxIterations: 3,
      signal: controller.signal,
      onEvent: (evt) => {
        if (evt.type === 'tool_result') {
          toolMessages.push(evt.message)
          // ��һ�����������ģ���û��㡸ֹͣ��
          if (toolMessages.length === 1) controller.abort()
        }
      },
    })

    expect(toolMessages.map((m) => m.toolCallId)).toEqual(['c1', 'c2', 'c3'])
    expect(toolMessages[1].content).toContain('stopped the run')
    expect(toolMessages[2].content).toContain('stopped the run')
  })

  it('��������ʱ�����������Ĳ�����Ϣ', async () => {
    vi.mocked(chatStream).mockImplementation(async (opts) => {
      opts.onChunk({
        type: 'tool_calls',
        calls: [{ id: 'x1', name: 'list_dir', args: { path: '.' } }],
      })
      opts.onChunk({ type: 'done' })
    })

    const toolMessages: Message[] = []
    await runAgent({
      target,
      system: '',
      history: [{ id: 'u1', role: 'user', content: 'list files', createdAt: 0 }],
      ctx: makeCtx(),
      planMode: false,
      permission: 'full',
      requestApproval: async () => true,
      maxIterations: 2,
      signal: new AbortController().signal,
      onEvent: (evt) => {
        if (evt.type === 'tool_result') toolMessages.push(evt.message)
      },
    })

    expect(toolMessages.length).toBeGreaterThan(0)
    expect(toolMessages.every((m) => !m.content.includes('stopped the run'))).toBe(true)
  })
})

describe('����ʱ��', () => {
  it('ģ�͸տ�ʼ���ɹ��߲���ʱ�ͷ�����������', async () => {
    const approvalSummary: string[] = []
    let firstRound = true

    vi.mocked(chatStream).mockImplementation(async (opts) => {
      if (!firstRound) {
        opts.onChunk({ type: 'done' })
        return
      }
      firstRound = false
      // ����������ʽ�����У����ȱ�����
      opts.onChunk({
        type: 'tool_progress',
        index: 0,
        name: 'write_file',
        argsSoFar: '{"path":"a.txt"',
      })
      opts.onChunk({
        type: 'tool_calls',
        calls: [{ id: 'w1', name: 'write_file', args: { path: 'a.txt', content: 'hi' } }],
      })
      opts.onChunk({ type: 'done' })
    })

    await runAgent({
      target,
      system: '',
      history: [{ id: 'u1', role: 'user', content: 'write a file', createdAt: 0 }],
      ctx: makeCtx(),
      planMode: false,
      // ֻ�������κ�д������Ҫ�������ұ����ڲ��������ڼ����
      permission: 'readonly',
      requestApproval: async (request) => {
        approvalSummary.push(request.detail ?? '')
        return true
      },
      maxIterations: 2,
      signal: new AbortController().signal,
      onEvent: () => {},
    })

    expect(approvalSummary.length).toBe(1)
    // ����ʱ�õ��ľ��ǡ����������С��Ĳ���������
    expect(approvalSummary[0]).toContain('a.txt')
  })

  it('�ܾ��󲻻�ִ�иù���', async () => {
    vi.mocked(chatStream).mockImplementation(async (opts) => {
      opts.onChunk({
        type: 'tool_calls',
        calls: [{ id: 'd1', name: 'delete_path', args: { path: 'important.txt', recursive: false } }],
      })
      opts.onChunk({ type: 'done' })
    })

    const results: Message[] = []
    await runAgent({
      target,
      system: '',
      history: [{ id: 'u1', role: 'user', content: 'delete it', createdAt: 0 }],
      ctx: makeCtx(),
      planMode: false,
      permission: 'auto',
      requestApproval: async () => false,
      maxIterations: 2,
      signal: new AbortController().signal,
      onEvent: (evt) => {
        if (evt.type === 'tool_result') results.push(evt.message)
      },
    })

    expect(results[0].error).toBe('failed')
    expect(results[0].content).toContain('did not approve')
  })
})

describe('��������', () => {
  it('������������̰Ѳ������Ϣ����ģ��', async () => {
    const inserted: Message[] = []
    let urgentUsed = false

    vi.mocked(chatStream).mockImplementation(async (opts) => {
      // �ڶ��ε���ʱӦ���ܿ����������Ϣ
      const hasInserted = opts.messages.some((m) => (m as Message).inserted)
      if (!hasInserted) {
        opts.onChunk({ type: 'tool_calls', calls: THREE_CALLS })
        opts.onChunk({ type: 'done' })
        return
      }
      opts.onChunk({ type: 'text', text: 'ok, taking the insert into account' })
      opts.onChunk({ type: 'done' })
    })

    await runAgent({
      target,
      system: '',
      history: [{ id: 'u1', role: 'user', content: 'list files', createdAt: 0 }],
      ctx: makeCtx(),
      planMode: false,
      permission: 'full',
      requestApproval: async () => true,
      maxIterations: 3,
      signal: new AbortController().signal,
      takeUrgent: () => {
        if (urgentUsed) return null
        urgentUsed = true
        return { text: 'actually stop and look at this first', attachments: [] }
      },
      onEvent: (evt) => {
        if (evt.type === 'urgent_inserted') inserted.push(evt.message)
      },
    })

    expect(inserted.length).toBe(1)
    expect(inserted[0].inserted).toBe(true)
  })
})

describe('立即插入：剩余工具不留悬空调用', () => {
  it('为没机会执行的工具补上 tool 消息，并且排在插入的消息之前', async () => {
    let urgentUsed = false
    const order: string[] = []

    vi.mocked(chatStream).mockImplementation(async (opts) => {
      const hasInserted = opts.messages.some((m) => (m as Message).inserted)
      if (hasInserted) {
        opts.onChunk({ type: 'done' })
        return
      }
      opts.onChunk({ type: 'tool_calls', calls: THREE_CALLS })
      opts.onChunk({ type: 'done' })
    })

    await runAgent({
      target,
      system: '',
      history: [{ id: 'u1', role: 'user', content: 'list files', createdAt: 0 }],
      ctx: makeCtx(),
      planMode: false,
      permission: 'full',
      requestApproval: async () => true,
      maxIterations: 3,
      signal: new AbortController().signal,
      takeUrgent: () => {
        if (urgentUsed) return null
        urgentUsed = true
        return { text: '先等一下，看这个', attachments: [] }
      },
      onEvent: (evt) => {
        if (evt.type === 'tool_result') order.push(`tool:${evt.call.id}:${evt.message.content}`)
        if (evt.type === 'urgent_inserted') order.push('user:inserted')
      },
    })

    expect(order.map((item) => item.split(':').slice(0, 2).join(':'))).toEqual([
      'tool:c1',
      'tool:c2',
      'tool:c3',
      'user:inserted',
    ])
    expect(order[1]).toContain('inserted a message mid-task')
    expect(order[2]).toContain('inserted a message mid-task')
  })
})

describe('bash 的删除命令也算危险操作', () => {
  it('auto 档位下删除类命令要审批，普通命令不问', async () => {
    const asked: string[] = []
    let round = 0

    vi.mocked(chatStream).mockImplementation(async (opts) => {
      round++
      if (round === 1) {
        opts.onChunk({
          type: 'tool_calls',
          calls: [{ id: 'b1', name: 'bash', args: { command: 'Remove-Item a.txt -Force' } }],
        })
        opts.onChunk({ type: 'done' })
        return
      }
      if (round === 2) {
        opts.onChunk({
          type: 'tool_calls',
          calls: [{ id: 'b2', name: 'bash', args: { command: 'ls -la' } }],
        })
        opts.onChunk({ type: 'done' })
        return
      }
      opts.onChunk({ type: 'done' })
    })

    await runAgent({
      target,
      system: '',
      history: [{ id: 'u1', role: 'user', content: 'run things', createdAt: 0 }],
      ctx: makeCtx(new ShellStubBackend()),
      planMode: false,
      permission: 'auto',
      requestApproval: async (request) => {
        asked.push(request.summary)
        return true
      },
      maxIterations: 4,
      signal: new AbortController().signal,
      onEvent: () => {},
    })

    expect(asked.length).toBe(1)
    expect(asked[0]).toContain('delete')
  })
})

describe('运行中切换权限档位', () => {
  it('改档位立即生效，不用等这一轮跑完', async () => {
    // 起始是「只读」：任何写操作都要问
    let mode: 'readonly' | 'auto' | 'full' = 'readonly'
    const asked: string[] = []
    let round = 0

    vi.mocked(chatStream).mockImplementation(async (opts) => {
      round++
      if (round === 1) {
        opts.onChunk({
          type: 'tool_calls',
          calls: [
            { id: 'w1', name: 'write_file', args: { path: 'a.txt', content: 'A' } },
            { id: 'w2', name: 'write_file', args: { path: 'b.txt', content: 'B' } },
            { id: 'w3', name: 'write_file', args: { path: 'c.txt', content: 'C' } },
          ],
        })
        opts.onChunk({ type: 'done' })
        return
      }
      opts.onChunk({ type: 'done' })
    })

    await runAgent({
      target,
      system: '',
      history: [{ id: 'u1', role: 'user', content: '写三个文件', createdAt: 0 }],
      ctx: makeCtx(),
      planMode: false,
      permission: 'readonly',
      getPermission: () => mode,
      requestApproval: async (request) => {
        asked.push(request.summary)
        // 第 1 个审批弹出来的同时，用户把档位切到「完全」
        mode = 'full'
        return true
      },
      maxIterations: 2,
      signal: new AbortController().signal,
      onEvent: () => {},
    })

    // 第 1 个问了；切到 full 之后，同一轮里的第 2、3 个不该再问
    expect(asked.length).toBe(1)
  })
})

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

/** 一个能提供图片的后端（view_image 会用到 readFileBase64） */
function makeImageCtx(): ToolContext {
  const backend = {
    kind: 'companion',
    label: 'stub',
    rootLabel: 'stub',
    capabilities: { shell: true, miniShell: false, python: true, unrestricted: true },
    readFile: async () => '',
    writeFile: async () => {},
    list: async () => [],
    exists: async () => true,
    mkdir: async () => {},
    remove: async () => {},
    glob: async () => [],
    grep: async () => '',
    shell: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    readFileBase64: async () => ({ base64: PNG_BASE64, size: 70 }),
  }

  return {
    backend: backend as unknown as Backend,
    getTodos: () => [],
    setTodos: () => {},
    askUser: async () => '(skipped)',
    recordUndo: async () => 'undo-1',
  }
}

describe('工具产出的图片', () => {
  it('一轮里追加的图片消息排在所有 tool 消息之后（插在中间会被接口 400）', async () => {
    const shapes: string[] = []
    let round = 0

    vi.mocked(chatStream).mockImplementation(async (opts) => {
      round++
      if (round === 1) {
        opts.onChunk({
          type: 'tool_calls',
          calls: [
            { id: 'c1', name: 'view_image', args: { path: 'a.png' } },
            { id: 'c2', name: 'list_dir', args: { path: '.' } },
          ],
        })
        opts.onChunk({ type: 'done' })
        return
      }
      // 第二轮：把历史形状记下来
      shapes.push(
        opts.messages.map((m) => m.role + (m.attachments?.length ? '+img' : '')).join('>'),
      )
      opts.onChunk({ type: 'done' })
    })

    await runAgent({
      target,
      system: '',
      history: [{ id: 'u1', role: 'user', content: '看看这张图', createdAt: 0 }],
      ctx: makeImageCtx(),
      planMode: false,
      permission: 'full',
      requestApproval: async () => true,
      maxIterations: 3,
      signal: new AbortController().signal,
      onEvent: () => {},
    })

    // 两个 tool 消息紧跟着 assistant，图片排在它们之后
    expect(shapes[0]).toBe('user>assistant>tool>tool>user+img')
  })
})
