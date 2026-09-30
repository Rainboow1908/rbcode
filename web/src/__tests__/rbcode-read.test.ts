import { beforeEach, describe, expect, it } from 'vitest'
import type { Backend, FileNode, ShellResult } from '../lib/executor/types.ts'
import { listSessions, loadSession, saveSession } from '../lib/sessions.ts'

/** 内存后端：模拟 .rbcode 里的文件 */
class MemoryBackend implements Backend {
  readonly kind = 'companion' as const
  readonly label = '内存后端'
  readonly rootLabel = 'D:\\demo'
  readonly capabilities = { shell: false, miniShell: false, python: false, unrestricted: false }
  files = new Map<string, string>()

  async readFile(path: string): Promise<string> {
    const value = this.files.get(path)
    if (value === undefined) throw new Error(`no such file: ${path}`)
    return value
  }
  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content)
  }
  async list(path: string): Promise<FileNode[]> {
    const prefix = path ? `${path}/` : ''
    const seen = new Map<string, FileNode>()
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      const name = rest.split('/')[0]
      if (seen.has(name)) continue
      seen.set(name, {
        path: `${prefix}${name}`,
        name,
        kind: rest.includes('/') ? 'dir' : 'file',
        size: 0,
      })
    }
    return [...seen.values()]
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
}

/** 带往返延迟的后端：模拟真实 RPC，让并发的读 / 写真正交错 */
class SlowMemoryBackend extends MemoryBackend {
  private async delay(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 3)))
  }
  override async readFile(path: string): Promise<string> {
    await this.delay()
    return super.readFile(path)
  }
  override async writeFile(path: string, content: string): Promise<void> {
    await this.delay()
    return super.writeFile(path, content)
  }
}

/** 「读 index 慢、写 index 快」的后端：让 read-modify-write 的窗口必然撞上 */
class RaceBackend extends MemoryBackend {
  override async readFile(path: string): Promise<string> {
    if (path.endsWith('index.json')) await new Promise((resolve) => setTimeout(resolve, 20))
    return super.readFile(path)
  }
  override async writeFile(path: string, content: string): Promise<void> {
    if (path.endsWith('index.json')) await new Promise((resolve) => setTimeout(resolve, 0))
    return super.writeFile(path, content)
  }
}

describe('.rbcode 读取', () => {
  let backend: MemoryBackend
  beforeEach(() => {
    backend = new MemoryBackend()
  })

  it('目录里只有会话文件、没有 index.json 时能扫描重建', async () => {
    // 模拟别的模式（companion / 早期版本）留下的数据：只有会话文件
    backend.files.set(
      '.rbcode/sessions/abc.json',
      JSON.stringify({
        id: 'abc',
        title: '以前建的会话',
        createdAt: 1000,
        updatedAt: 2000,
        messageCount: 2,
        messages: [],
      }),
    )

    const sessions = await listSessions(backend)
    expect(sessions.length).toBe(1)
    expect(sessions[0].title).toBe('以前建的会话')
    // 重建之后应该把索引补回去，下次就不用再扫
    expect(backend.files.get('.rbcode/sessions/index.json')).toBeTruthy()
  })

  it('按创建时间排列（更新对话不会把它顶到最上面）', async () => {
    // old 是先前建的，但刚被更新过（updatedAt 最大）
    backend.files.set(
      '.rbcode/sessions/old.json',
      JSON.stringify({ id: 'old', title: '先建的', createdAt: 1000, updatedAt: 9999, messageCount: 1, messages: [] }),
    )
    backend.files.set(
      '.rbcode/sessions/new.json',
      JSON.stringify({ id: 'new', title: '后建的', createdAt: 2000, updatedAt: 2001, messageCount: 1, messages: [] }),
    )

    const sessions = await listSessions(backend)
    expect(sessions.map((s) => s.id)).toEqual(['old', 'new'])
  })

  it('坏掉的会话文件不会让整个列表失败', async () => {
    backend.files.set('.rbcode/sessions/broken.json', '{ not json')
    backend.files.set(
      '.rbcode/sessions/ok.json',
      JSON.stringify({ id: 'ok', title: '好的', createdAt: 1, updatedAt: 2, messageCount: 0, messages: [] }),
    )

    const sessions = await listSessions(backend)
    expect(sessions.map((s) => s.id)).toEqual(['ok'])
  })

  it('有 index.json 时直接用，不再扫目录', async () => {
    backend.files.set(
      '.rbcode/sessions/index.json',
      JSON.stringify([{ id: 'x', title: '来自索引', createdAt: 1, updatedAt: 5, messageCount: 1 }]),
    )
    backend.files.set(
      '.rbcode/sessions/other.json',
      JSON.stringify({ id: 'other', title: '不该被用到', createdAt: 1, updatedAt: 9, messageCount: 1, messages: [] }),
    )

    const sessions = await listSessions(backend)
    expect(sessions.map((s) => s.id)).toEqual(['x'])
  })

  it('.rbcode 完全不存在时返回空列表而不是报错', async () => {
    expect(await listSessions(backend)).toEqual([])
  })

  it('能按 id 读回单个会话', async () => {
    backend.files.set(
      '.rbcode/sessions/abc.json',
      JSON.stringify({
        id: 'abc',
        title: 't',
        createdAt: 1,
        updatedAt: 2,
        messageCount: 1,
        messages: [{ id: 'm', role: 'user', content: 'hi', createdAt: 1 }],
      }),
    )
    const session = await loadSession(backend, 'abc')
    expect(session?.messages[0].content).toBe('hi')
  })

  it('用量统计跟着会话一起落盘，并能读回来算缓存命中率', async () => {
    await saveSession(backend, {
      id: 'u1',
      title: 't',
      createdAt: 1,
      updatedAt: 2,
      messageCount: 1,
      messages: [{ id: 'm', role: 'user', content: 'hi', createdAt: 1 }],
      usage: {
        requests: 3,
        promptTokens: 1000,
        completionTokens: 200,
        cachedTokens: 750,
        cacheWriteTokens: 50,
      },
    })

    const raw = JSON.parse(backend.files.get('.rbcode/sessions/u1.json') ?? '{}')
    expect(raw.usage.cachedTokens).toBe(750)

    const session = await loadSession(backend, 'u1')
    expect(session?.usage?.requests).toBe(3)
    // 缓存命中率 = 命中 / 提示词
    expect(Math.round(((session?.usage?.cachedTokens ?? 0) / (session?.usage?.promptTokens ?? 1)) * 100)).toBe(75)
  })

  it('多个会话同时写盘时不会互相覆盖索引', async () => {
    const make = (id: string, createdAt: number) => ({
      id,
      title: id,
      createdAt,
      updatedAt: createdAt,
      messageCount: 1,
      messages: [{ id: `${id}-m1`, role: 'user' as const, content: 'hi', createdAt }],
    })

    // 三个会话「同时」落盘。saveSession 是 读索引 → 合并 → 写回，
    // 如果并发时读到同一份旧索引，后写的就会把先写的挤掉。
    await Promise.all([
      saveSession(backend, make('a', 1000)),
      saveSession(backend, make('b', 2000)),
      saveSession(backend, make('c', 3000)),
    ])

    const index = JSON.parse(backend.files.get('.rbcode/sessions/index.json') ?? '[]') as {
      id: string
    }[]
    expect(index.map((item) => item.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('后端有往返延迟（真实 RPC 那样）时，并发写盘也不会丢索引条目', async () => {
    const slow = new SlowMemoryBackend()
    const make = (id: string, createdAt: number) => ({
      id,
      title: id,
      createdAt,
      updatedAt: createdAt,
      messageCount: 1,
      messages: [{ id: `${id}-m1`, role: 'user' as const, content: 'hi', createdAt }],
    })

    const ids = ['a', 'b', 'c', 'd', 'e']
    await Promise.all(ids.map((id, i) => saveSession(slow, make(id, 1000 + i))))

    const index = JSON.parse(slow.files.get('.rbcode/sessions/index.json') ?? '[]') as {
      id: string
    }[]
    expect(index.map((item) => item.id).sort()).toEqual(ids)
    for (const id of ids) expect(slow.files.has(`.rbcode/sessions/${id}.json`)).toBe(true)
  })

  it('索引读写交错时不会丢条目（read-modify-write 窗口）', async () => {
    const session = (id: string, createdAt: number) => ({
      id,
      title: id,
      createdAt,
      updatedAt: createdAt,
      messageCount: 1,
      messages: [],
    })

    // 先让索引里已经有一个会话（这样 listSessions 不会再扫盘兜底）
    await saveSession(backend, session('a', 1000))

    // 换成「读 index 慢、写 index 快」的后端：后两个会话必然读到同一份旧索引
    const race = new RaceBackend()
    race.files = new Map(backend.files)

    await Promise.all([saveSession(race, session('b', 2000)), saveSession(race, session('c', 3000))])

    const index = JSON.parse(race.files.get('.rbcode/sessions/index.json') ?? '[]') as {
      id: string
    }[]
    // 两个都写完了，索引里就该有三条，不能少
    expect(index.map((item) => item.id).sort()).toEqual(['a', 'b', 'c'])
    expect(race.files.has('.rbcode/sessions/b.json')).toBe(true)
    expect(race.files.has('.rbcode/sessions/c.json')).toBe(true)
  })
})
