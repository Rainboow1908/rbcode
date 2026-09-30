import { describe, expect, it, vi } from 'vitest'
import type { Backend } from '../lib/executor/types.ts'
import { loadSession, saveSession, setSessionTodos } from '../lib/sessions.ts'

/** 内存文件系统后端（够 saveSession / loadSession 用） */
function fsBackend(files: Record<string, string> = {}): Backend {
  const map = { ...files }
  return {
    kind: 'companion',
    label: '本机执行器',
    capabilities: {},
    exists: vi.fn(async (path: string) => path in map),
    mkdir: vi.fn(async () => {}),
    writeFile: vi.fn(async (path: string, content: string) => {
      map[path] = content
    }),
    readFile: vi.fn(async (path: string) => {
      if (!(path in map)) throw new Error(`no file: ${path}`)
      return map[path]
    }),
    remove: vi.fn(async () => {}),
    list: vi.fn(async (dir: string) => {
      const prefix = `${dir.replace(/[\\/]+$/, '')}/`
      const seen = new Set<string>()
      const entries: { path: string; name: string; kind: 'file' | 'dir'; size: number }[] = []
      for (const path of Object.keys(map)) {
        const normalized = path.replace(/\\/g, '/')
        if (!normalized.startsWith(prefix)) continue
        const rest = normalized.slice(prefix.length)
        const [head, ...tail] = rest.split('/')
        if (!head || seen.has(head)) continue
        seen.add(head)
        entries.push({
          path: tail.length > 0 ? `${prefix}${head}` : path,
          name: head,
          kind: tail.length > 0 ? 'dir' : 'file',
          size: tail.length > 0 ? 0 : (map[path]?.length ?? 0),
        })
      }
      return entries
    }),
  } as unknown as Backend
}

describe('待办跟着会话落盘', () => {
  it('写进会话文件后，重新载入还在（刷新 / 换后端就靠这个）', async () => {
    const backend = fsBackend()
    await saveSession(backend, {
      id: 's1',
      title: '会话',
      createdAt: 1,
      updatedAt: 1,
      messageCount: 0,
      messages: [],
    })

    await setSessionTodos(backend, 's1', [
      { id: 't1', content: '改配置', status: 'in_progress' },
      { id: 't2', content: '跑测试', status: 'pending' },
    ])

    const session = await loadSession(backend, 's1')
    expect(session?.todos).toHaveLength(2)
    expect(session?.todos?.[0]).toEqual({ id: 't1', content: '改配置', status: 'in_progress' })
    // 消息没被动过
    expect(session?.messages).toEqual([])
  })

  it('待办清空也会落盘（不是「没有就不写」）', async () => {
    const backend = fsBackend()
    await saveSession(backend, {
      id: 's2',
      title: '会话',
      createdAt: 1,
      updatedAt: 1,
      messageCount: 0,
      messages: [],
    })
    await setSessionTodos(backend, 's2', [{ id: 't1', content: 'a', status: 'completed' }])
    await setSessionTodos(backend, 's2', [])
    const session = await loadSession(backend, 's2')
    expect(session?.todos).toEqual([])
  })

  it('会话文件还不存在时静默跳过（等消息保存时自然带上）', async () => {
    await expect(setSessionTodos(fsBackend(), 'missing', [])).resolves.toBeUndefined()
  })

  it('消息保存带上待办时，待办跟着一起落盘、不会被冲掉', async () => {
    const backend = fsBackend()
    const session = {
      id: 's3',
      title: '会话',
      createdAt: 1,
      updatedAt: 1,
      messageCount: 0,
      messages: [],
    }
    await saveSession(backend, session)
    await setSessionTodos(backend, 's3', [{ id: 't1', content: '改配置', status: 'pending' }])

    // 之后的消息保存会带上当前待办（App 就是这么写的）：待办必须还在
    const todos = (await loadSession(backend, 's3'))?.todos ?? []
    await saveSession(backend, {
      ...session,
      messageCount: 1,
      messages: [{ id: 'm1', role: 'user', content: '继续', createdAt: 2 }],
      todos,
    })

    const reloaded = await loadSession(backend, 's3')
    expect(reloaded?.todos).toHaveLength(1)
    expect(reloaded?.messages).toHaveLength(1)
  })
})
