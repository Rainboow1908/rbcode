import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Backend, FileNode, ShellResult } from '../lib/executor/types.ts'

/* ------------------------------ 内存版执行后端 ------------------------------ */

class MemoryBackend implements Backend {
  readonly kind = 'companion' as const
  readonly label = '内存后端'
  readonly rootLabel = 'D:\\demo\\my-project'
  readonly capabilities = { shell: false, miniShell: false, python: false, unrestricted: false }

  files = new Map<string, string>()

  async readFile(path: string): Promise<string> {
    const value = this.files.get(path)
    if (value === undefined) throw new Error(`文件不存在: ${path}`)
    return value
  }
  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content)
  }
  async list(path: string): Promise<FileNode[]> {
    const prefix = path ? `${path}/` : ''
    const names = new Set<string>()
    const out: FileNode[] = []
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      const name = rest.split('/')[0]
      if (names.has(name)) continue
      names.add(name)
      out.push({
        path: `${prefix}${name}`,
        name,
        kind: rest.includes('/') ? 'dir' : 'file',
        size: 0,
      })
    }
    return out
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path)
  }
  async mkdir(): Promise<void> {}
  async remove(path: string): Promise<void> {
    this.files.delete(path)
  }
  async glob(): Promise<string[]> {
    return [...this.files.keys()]
  }
  async grep(): Promise<string> {
    return ''
  }
  async shell(): Promise<ShellResult> {
    return { stdout: '', stderr: '', exitCode: 0 }
  }
  async ensurePermission(): Promise<boolean> {
    return true
  }
}

/* 每个用例换一个后端实例：否则上一个用例「在途的写入」会落到下一个用例里，
   索引就会平白多出一条（之前表现为偶发失败，其实是有确定原因的）。 */
let memory = new MemoryBackend()

vi.mock('../lib/executor/browser.ts', () => ({
  BrowserBackend: {
    isSupported: () => true,
    pick: vi.fn(async () => memory),
    restore: vi.fn(async () => memory),
    forget: vi.fn(async () => undefined),
  },
}))

vi.mock('../lib/executor/companion.ts', () => ({
  CompanionBackend: {
    info: null,
    discover: vi.fn(async () => null),
  },
}))

/* --------------------------------- mock LLM -------------------------------- */

/** 允许测试指定“下一轮模型请求的工具调用”，并记录模型收到的消息 */
const mockState = vi.hoisted(() => ({
  nextToolCalls: null as { id: string; name: string; args: Record<string, unknown> }[] | null,
  lastMessages: [] as { role: string; content: string }[],
  /** 让下一次调用卡住，用来复现“生成中”状态 */
  hold: false,
  release: null as null | (() => void),
}))

vi.mock('../lib/llm.ts', async () => {
  return {
    chatStream: async (opts: {
      messages: { role: string; content: string }[]
      onChunk: (c: unknown) => void
    }) => {
      mockState.lastMessages = opts.messages.map((m) => ({ role: m.role, content: m.content }))

      if (mockState.hold) {
        mockState.hold = false
        await new Promise<void>((resolve) => {
          mockState.release = resolve
        })
      }

      const calls = mockState.nextToolCalls
      if (calls) {
        mockState.nextToolCalls = null
        opts.onChunk({ type: 'tool_calls', calls })
        opts.onChunk({ type: 'done' })
        return
      }
      const last = opts.messages[opts.messages.length - 1]
      opts.onChunk({ type: 'text', text: `回复：${last?.content ?? ''}` })
      opts.onChunk({ type: 'done' })
    },
    complete: async () => '摘要',
  }
})

import App from '../App.tsx'
import { defaultSettings } from '../lib/settings.ts'
import type { AppSettings } from '../lib/types.ts'

function seedSettings(): AppSettings {
  const base = defaultSettings()
  base.providers[0].apiKey = 'test-key'
  base.providers[0].models = [{ id: 'test-model' }]
  base.activeModel = 'test-model'
  base.approvalTimeout = 5
  localStorage.setItem('rbcode.settings.v2', JSON.stringify(base))
  return base
}

async function openProject() {
  fireEvent.click(screen.getByLabelText('打开一个目录作为项目'))
  await waitFor(() => expect(screen.getAllByText(/本机执行器/).length).toBeGreaterThan(0))
}

async function sendMessage(text: string) {
  const box = screen.getByPlaceholderText(/描述你想让 RB Code 做什么/)
  fireEvent.change(box, { target: { value: text } })
  fireEvent.click(screen.getByLabelText('发送'))
  await waitFor(() => expect(screen.getByText(`回复：${text}`)).toBeTruthy(), { timeout: 3000 })
}

function sessionIndexFile(): string | undefined {
  return memory.files.get('.rbcode/sessions/index.json')
}

describe('会话流程', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    localStorage.clear()
    memory = new MemoryBackend()
    seedSettings()
  })

  it('打开项目时会创建 .rbcode 目录结构', async () => {
    render(<App />)
    await openProject()
    // ensureRbcodeDir 会 mkdir，但内存后端不记录目录；这里直接验证首个会话会落到 .rbcode/sessions
    await sendMessage('第一条')
    await waitFor(() => expect(sessionIndexFile()).toBeTruthy(), { timeout: 3000 })
  })

  it('同一个项目下可以创建多个会话', async () => {
    render(<App />)
    await openProject()

    await sendMessage('第一条消息')
    await waitFor(() => {
      const index = JSON.parse(sessionIndexFile() ?? '[]') as unknown[]
      expect(index.length).toBe(1)
    }, { timeout: 3000 })

    // 新建会话
    fireEvent.click(screen.getByLabelText('在该项目下新建会话'))
    await sendMessage('第二条消息')

    await waitFor(() => {
      const index = JSON.parse(sessionIndexFile() ?? '[]') as { id: string }[]
      expect(index.length).toBe(2)
    }, { timeout: 4000 })
  })

  it('重复打开同一个目录不会产生重复项目', async () => {
    render(<App />)
    await openProject()
    await openProject()

    const projects = JSON.parse(localStorage.getItem('rbcode.projects.v1') ?? '[]') as unknown[]
    expect(projects.length).toBe(1)
  })

  it('agent 调用 todo_write 后，输入框上方出现可折叠的计划清单', async () => {    render(<App />)
    await openProject()

    mockState.nextToolCalls = [
      {
        id: 'tc-todo',
        name: 'todo_write',
        args: {
          todos: [
            { content: '第一步：读代码', status: 'in_progress' },
            { content: '第二步：改代码', status: 'pending' },
          ],
        },
      },
    ]

    const box = screen.getByPlaceholderText(/描述你想让 RB Code 做什么/)
    fireEvent.change(box, { target: { value: '给我一个计划' } })
    fireEvent.click(screen.getByLabelText('发送'))

    await waitFor(() => expect(screen.getByText('计划清单')).toBeTruthy(), { timeout: 5000 })
    expect(screen.getByText('第一步：读代码')).toBeTruthy()
    expect(screen.getByText('第二步：改代码')).toBeTruthy()
    expect(screen.getByText('0/2')).toBeTruthy()

    // 折叠后收起（高度动画，内容仍挂载），标题旁的提示变成「展开」
    fireEvent.click(screen.getByText('计划清单'))
    await waitFor(() => expect(screen.getByText('展开')).toBeTruthy())
    expect(screen.getByText('计划清单')).toBeTruthy()
  })

  it('ask_user 会在输入框上方出现提问面板，用户的选择回传给模型', async () => {
    render(<App />)
    await openProject()

    mockState.nextToolCalls = [
      {
        id: 'tc-ask',
        name: 'ask_user',
        args: {
          questions: [
            {
              question: '这个项目用什么语言写？',
              options: [{ label: 'C#' }, { label: 'Java' }],
              allow_custom: true,
            },
          ],
        },
      },
    ]

    const box = screen.getByPlaceholderText(/描述你想让 RB Code 做什么/)
    fireEvent.change(box, { target: { value: '帮我选个语言' } })
    fireEvent.click(screen.getByLabelText('发送'))

    await waitFor(() => expect(screen.getByText('模型在等你回答')).toBeTruthy(), {
      timeout: 15000,
    })
    expect(screen.getByText('这个项目用什么语言写？')).toBeTruthy()

    fireEvent.click(screen.getByText('C#'))
    fireEvent.click(screen.getByText('提交'))

    await waitFor(
      () => {
        const toolMessage = mockState.lastMessages.find((m) => m.role === 'tool')
        expect(toolMessage?.content).toContain('C#')
      },
      { timeout: 5000 },
    )
  })

  it('计划模式下列出计划后，可以确认开始执行（自动退出计划模式）', async () => {
    render(<App />)
    await openProject()

    fireEvent.click(screen.getByText(/计划模式 关/))
    await waitFor(() => expect(screen.getByText(/计划模式 开/)).toBeTruthy())

    mockState.nextToolCalls = [
      {
        id: 'tc-plan',
        name: 'todo_write',
        args: { todos: [{ content: '第一步：读代码', status: 'pending' }] },
      },
    ]

    const box = screen.getByPlaceholderText(/描述你想让 RB Code 做什么/)
    fireEvent.change(box, { target: { value: '先给一个计划' } })
    fireEvent.click(screen.getByLabelText('发送'))

    await waitFor(() => expect(screen.getByText(/计划已列出/)).toBeTruthy(), { timeout: 5000 })

    fireEvent.click(screen.getByText('开始执行'))
    await waitFor(() => expect(screen.getByText(/计划模式 关/)).toBeTruthy(), { timeout: 5000 })
    await waitFor(
      () => {
        const last = mockState.lastMessages[mockState.lastMessages.length - 1]
        expect(last?.content).toContain('计划已确认')
      },
      { timeout: 5000 },
    )
  })

  it('生成中切换会话：停止生成，且内容不会串到新会话', async () => {
    render(<App />)
    await openProject()

    // 会话 A
    await sendMessage('会话A的消息')

    // 新建会话 → B（此时消息区清空，'会话A的消息' 只剩侧栏那一条）
    fireEvent.click(screen.getByLabelText('在该项目下新建会话'))
    await new Promise((r) => setTimeout(r, 1200))
    // eslint-disable-next-line no-console
    console.log('=== 侧栏内容 ===\n' + (document.querySelector('aside')?.textContent ?? '(无 aside)'))
    await waitFor(() => expect(screen.getByText('会话A的消息')).toBeTruthy(), { timeout: 4000 })

    // 在 B 里发消息，并让模型卡住（保持“生成中”）
    mockState.hold = true
    const box = screen.getByPlaceholderText(/描述你想让 RB Code 做什么/)
    fireEvent.change(box, { target: { value: '会话B的消息' } })
    fireEvent.click(screen.getByLabelText('发送'))

    await waitFor(() => expect(screen.getByText('生成中')).toBeTruthy(), { timeout: 4000 })

    // 切回会话 A（侧栏那一条）
    fireEvent.click(screen.getByText('会话A的消息'))

    // 生成被中断，工作状态消失
    await waitFor(() => expect(screen.queryByText('生成中')).toBeNull(), { timeout: 4000 })

    // A 的界面里不该出现 B 的内容
    expect(screen.queryByText(/回复：会话B的消息/)).toBeNull()
    // A 自己的内容回来了（用户气泡）
    expect(screen.getAllByText('会话A的消息').length).toBeGreaterThan(0)

    mockState.release?.()
  })

  it('切换会话后，之前的消息不会出现在新会话里', async () => {
    render(<App />)
    await openProject()

    await sendMessage('第一个会话')

    fireEvent.click(screen.getByLabelText('在该项目下新建会话'))
    // 新建会话后消息区应该是空的（侧栏的会话标题不算，所以看模型回复）
    await waitFor(() => expect(screen.queryByText(/回复：第一个会话/)).toBeNull())
    expect(screen.queryByText('回复：第一个会话')).toBeNull()
  })

  it('切换项目会清空会话列表，不会残留上一个项目的会话', async () => {
    render(<App />)
    await openProject()
    await sendMessage('项目里的会话')

    await waitFor(() => expect(screen.getAllByText('项目里的会话').length).toBeGreaterThan(0), {
      timeout: 4000,
    })

    // 归档当前项目：侧栏的会话条目必须一起清空（消息区那份不算）
    fireEvent.click(screen.getByLabelText('归档项目（不会删除磁盘文件）'))
    await waitFor(() =>
      expect(screen.queryAllByText('项目里的会话').length).toBeLessThanOrEqual(1),
    )
    // 项目本身也从列表消失
    expect(screen.getByText('还没有项目。点右上角的图标打开一个目录。')).toBeTruthy()
  })

  it('点一次项目就会自动展开并显示它的会话', async () => {
    render(<App />)
    await openProject()
    await sendMessage('我的会话')

    // 会落后侧栏就有内容（不再是“暂无会话”）
    await waitFor(() => expect(screen.queryByText('暂无会话')).toBeNull(), { timeout: 4000 })

    // 手动折叠
    fireEvent.click(screen.getByLabelText('折叠会话'))
    await waitFor(() => expect(screen.getByLabelText('展开会话')).toBeTruthy())

    // 只点一次项目名 → 自动展开，并且会话确实显示出来
    fireEvent.click(screen.getByTitle('打开项目 my-project'))
    await waitFor(() => expect(screen.getByLabelText('折叠会话')).toBeTruthy(), { timeout: 4000 })
    expect(screen.queryByText('暂无会话')).toBeNull()
  })

  it('切到别的会话后原会话继续在后台跑，侧栏显示转圈', async () => {
    render(<App />)
    await openProject()

    // 会话 A：让模型卡住，保持“生成中”
    mockState.hold = true
    const box = screen.getByPlaceholderText(/描述你想让 RB Code 做什么/)
    fireEvent.change(box, { target: { value: '会话A的问题' } })
    fireEvent.click(screen.getByLabelText('发送'))
    await waitFor(() => expect(screen.getByText('生成中')).toBeTruthy(), { timeout: 4000 })

    // 等会话 A 落盘出现在侧栏（保存有防抖），然后应该显示转圈
    await waitFor(() => expect(screen.getByTitle('正在生成')).toBeTruthy(), { timeout: 5000 })

    // 新建会话 B：当前视图不再显示“生成中”，但 A 没被中断
    fireEvent.click(screen.getByLabelText('在该项目下新建会话'))
    await waitFor(() => expect(screen.queryByText('生成中')).toBeNull())
    // A 仍在后台跑 → 侧栏那条会话还在转圈
    expect(screen.getByTitle('正在生成')).toBeTruthy()

    // 放行模型
    mockState.release?.()
    await new Promise((r) => setTimeout(r, 300))
  })

  it('只是打开一个会话，不会把它的时间改成刚刚', async () => {
    render(<App />)
    await openProject()
    await sendMessage('一条消息')
    await waitFor(() => expect(screen.queryByText('暂无会话')).toBeNull(), { timeout: 4000 })
    await new Promise((r) => setTimeout(r, 900))

    const readIndex = () =>
      JSON.parse(memory.files.get('.rbcode/sessions/index.json') ?? '[]') as {
        id: string
        updatedAt: number
      }[]
    const before = readIndex()
    expect(before.length).toBeGreaterThan(0)
    const updatedBefore = before[0].updatedAt

    // 切走再切回来
    fireEvent.click(screen.getByLabelText('在该项目下新建会话'))
    await new Promise((r) => setTimeout(r, 900))
    fireEvent.click(screen.getAllByText('一条消息')[0])
    await new Promise((r) => setTimeout(r, 900))

    const after = readIndex()
    expect(after[0].updatedAt).toBe(updatedBefore)
  })

  it('多个问题时一次只显示一个，答完点下一题才出现第二个', async () => {
    render(<App />)
    await openProject()

    mockState.nextToolCalls = [
      {
        id: 'tc-ask2',
        name: 'ask_user',
        args: {
          questions: [
            {
              question: '第一个问题：用哪个语言？',
              options: [{ label: 'Rust' }],
              allow_custom: true,
            },
            {
              question: '第二个问题：要不要测试？',
              options: [{ label: '要' }],
              allow_custom: true,
            },
          ],
        },
      },
    ]

    const box = screen.getByPlaceholderText(/描述你想让 RB Code 做什么/)
    fireEvent.change(box, { target: { value: '帮我决定' } })
    fireEvent.click(screen.getByLabelText('发送'))

    // 只显示第一题
    await waitFor(() => expect(screen.getByText('第一个问题：用哪个语言？')).toBeTruthy(), {
      timeout: 15000,
    })
    expect(screen.queryByText('第二个问题：要不要测试？')).toBeNull()
    expect(screen.getByText(/第 1\/2 题/)).toBeTruthy()

    fireEvent.click(screen.getByText('Rust'))
    fireEvent.click(screen.getByText('下一题'))

    // 第二题出现，第一题收起
    await waitFor(() => expect(screen.getByText('第二个问题：要不要测试？')).toBeTruthy())
    expect(screen.queryByText('第一个问题：用哪个语言？')).toBeNull()

    fireEvent.click(screen.getByText('要'))
    fireEvent.click(screen.getByText('提交'))

    await waitFor(
      () => {
        const toolMessage = mockState.lastMessages.find((m) => m.role === 'tool')
        expect(toolMessage?.content).toContain('Rust')
        expect(toolMessage?.content).toContain('要')
      },
      { timeout: 5000 },
    )
  })

  it('刷新后能回到上次的项目，并加载出它的会话', async () => {
    const first = render(<App />)
    await openProject()
    await sendMessage('刷新前的消息')
    await waitFor(() => expect(screen.queryByText('暂无会话')).toBeNull(), { timeout: 5000 })
    await new Promise((r) => setTimeout(r, 800))

    // 模拟刷新：卸载再挂载，localStorage 保留
    first.unmount()
    render(<App />)

    // 不需要重新点项目，就应恢复项目和它的会话列表
    await waitFor(() => expect(screen.queryByText('暂无会话')).toBeNull(), { timeout: 6000 })
    expect(screen.getByTitle('打开项目 my-project')).toBeTruthy()
    // 上次那个对话的内容也自动回来（不必手动点标签）。
    // 这里断言的是模型的回复：侧栏标题只会显示用户那条消息，
    // 只有真的把会话文件读回来，消息区里才会出现回复。
    await waitFor(
      () => expect(screen.getAllByText('回复：刷新前的消息').length).toBeGreaterThan(0),
      { timeout: 6000 },
    )
  })

  it('/clear 会把磁盘上的会话也清空（重开时不会再看到旧消息）', async () => {
    render(<App />)
    await openProject()
    await sendMessage('清空前的消息')

    const id = (JSON.parse(sessionIndexFile() ?? '[]') as { id: string }[])[0].id
    const sessionFile = `.rbcode/sessions/${id}.json`
    await waitFor(() => {
      const session = JSON.parse(memory.files.get(sessionFile) ?? 'null')
      expect(session?.messages?.length).toBe(2)
    })

    // 走发送按钮：输入 /clear 会先弹出指令补全菜单，回车不会提交
    const box = screen.getByPlaceholderText(/描述你想让 RB Code 做什么/)
    fireEvent.change(box, { target: { value: '/clear' } })
    fireEvent.click(screen.getByLabelText('发送'))

    await waitFor(
      () => {
        const session = JSON.parse(memory.files.get(sessionFile) ?? 'null')
        expect(session?.messages?.length ?? -1).toBe(0)
      },
      { timeout: 4000 },
    )
    expect(screen.queryByText('清空前的消息')).toBeNull()
  })

  it('只读模式下，一轮里两个需要审批的写操作都能确认后执行（不会卡死）', async () => {
    render(<App />)
    await openProject()
    // 权限档位现在是一个下拉菜单：先展开，再选「只读」
    fireEvent.click(screen.getByLabelText('权限档位'))
    fireEvent.click(screen.getByText('只读'))

    mockState.nextToolCalls = [
      { id: 'w1', name: 'write_file', args: { path: 'a.txt', content: 'AAA' } },
      { id: 'w2', name: 'write_file', args: { path: 'b.txt', content: 'BBB' } },
    ]

    const box = screen.getByPlaceholderText(/描述你想让 RB Code 做什么/)
    fireEvent.change(box, { target: { value: '写两个文件' } })
    fireEvent.click(screen.getByLabelText('发送'))

    // 两个审批排队出现：确认完第一个才会显示第二个
    await waitFor(() => expect(screen.getByText('允许')).toBeTruthy(), { timeout: 3000 })
    fireEvent.click(screen.getByText('允许'))
    await waitFor(() => expect(screen.getByText('允许')).toBeTruthy(), { timeout: 3000 })
    fireEvent.click(screen.getByText('允许'))

    await waitFor(
      () => {
        expect(memory.files.get('a.txt')).toBe('AAA')
        expect(memory.files.get('b.txt')).toBe('BBB')
      },
      { timeout: 4000 },
    )
    await waitFor(() => expect(screen.queryByText('允许')).toBeNull(), { timeout: 4000 })
  })

  it('浏览器沙箱下调 bash：由 bash 自己报错，而不是“工具不存在”', async () => {
    // 这个内存后端的 capabilities.shell 是 false，等价于浏览器沙箱
    render(<App />)
    await openProject()

    mockState.nextToolCalls = [{ id: 'b1', name: 'bash', args: { command: 'python main.py' } }]
    const box = screen.getByPlaceholderText(/描述你想让 RB Code 做什么/)
    fireEvent.change(box, { target: { value: '跑个 python' } })
    fireEvent.click(screen.getByLabelText('发送'))

    await waitFor(
      () => {
        const toolMessage = mockState.lastMessages.find((m) => m.role === 'tool')
        expect(toolMessage?.content).toContain('No shell on this backend')
      },
      { timeout: 5000 },
    )
  })

  it('运行中打字：停止键变「插入」，插入后按钮消失、输入清空、内容交给模型', async () => {
    render(<App />)
    await openProject()

    // 发一条并让模型卡住，保持「生成中」
    mockState.hold = true
    const box = screen.getByPlaceholderText(/描述你想让 RB Code 做什么/)
    fireEvent.change(box, { target: { value: '第一件事' } })
    fireEvent.click(screen.getByLabelText('发送'))
    await waitFor(() => expect(screen.getByLabelText('停止生成')).toBeTruthy(), { timeout: 4000 })

    // 运行中打字 → 多出一个「插入」图标按钮，「停止」仍在（不被覆盖）
    fireEvent.change(box, { target: { value: '插进去的话' } })
    await waitFor(() => expect(screen.getByLabelText('插入')).toBeTruthy())
    expect(screen.getByLabelText('停止生成')).toBeTruthy()

    // 点插入：输入框清空，插入按钮消失，「停止」还在
    fireEvent.click(screen.getByLabelText('插入'))
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''))
    await waitFor(() => expect(screen.queryByLabelText('插入')).toBeNull())
    expect(screen.getByLabelText('停止生成')).toBeTruthy()

    // 放掉卡住的请求：插入的内容会作为一条用户消息交给模型，并出现在消息流里（且只出现一次）
    mockState.release?.()
    await waitFor(() => expect(screen.getAllByText('插进去的话').length).toBe(1), { timeout: 5000 })
  })
})
