import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Backend, FileNode, ShellResult } from '../lib/executor/types.ts'

/** 内存后端：两个项目各一份，用来验证「点别的项目下的会话」 */
class MemBackend implements Backend {
  readonly kind = 'browser' as const
  readonly label = '内存后端'
  readonly capabilities = { shell: false, miniShell: false, python: false, unrestricted: false }
  files = new Map<string, string>()

  constructor(readonly rootLabel: string) {}

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

const alpha = new MemBackend('alpha')
const beta = new MemBackend('beta')

vi.mock('../lib/executor/browser.ts', () => ({
  BrowserBackend: {
    isSupported: () => true,
    pick: vi.fn(async () => alpha),
    // 目录句柄的 key 就是项目 id 去掉 browser: 前缀
    restore: vi.fn(async (key: string) => (key === 'beta' ? beta : alpha)),
    forget: vi.fn(async () => undefined),
  },
}))

vi.mock('../lib/executor/companion.ts', () => ({
  CompanionBackend: { info: null, discover: vi.fn(async () => null) },
}))

vi.mock('../lib/llm.ts', () => ({
  chatStream: async () => {},
  complete: async () => '',
}))

import App from '../App.tsx'
import { defaultSettings } from '../lib/settings.ts'

const sessionFile = (id: string, title: string, userText: string, assistantText: string, createdAt: number) =>
  JSON.stringify({
    id,
    title,
    createdAt,
    updatedAt: createdAt,
    messageCount: 2,
    messages: [
      { id: `${id}-u`, role: 'user', content: userText, createdAt },
      { id: `${id}-a`, role: 'assistant', content: assistantText, createdAt },
    ],
  })

beforeEach(() => {
  localStorage.clear()
  alpha.files.clear()
  beta.files.clear()

  alpha.files.set(
    '.rbcode/sessions/s-alpha.json',
    sessionFile('s-alpha', 'alpha 的会话', 'alpha 里的消息', 'alpha 的回复', 1),
  )
  beta.files.set(
    '.rbcode/sessions/s-beta.json',
    sessionFile('s-beta', 'beta 的会话', 'beta 里的消息', 'beta 的回复', 3),
  )

  const settings = defaultSettings()
  settings.providers[0].apiKey = 'test-key'
  settings.providers[0].models = [{ id: 'test-model' }]
  settings.activeModel = 'test-model'
  localStorage.setItem('rbcode.settings.v2', JSON.stringify(settings))

  localStorage.setItem(
    'rbcode.projects.v1',
    JSON.stringify([
      { id: 'browser:alpha', name: 'alpha', path: 'alpha', backendKind: 'browser', createdAt: 1, lastOpenedAt: 1 },
      { id: 'browser:beta', name: 'beta', path: 'beta', backendKind: 'browser', createdAt: 2, lastOpenedAt: 2 },
    ]),
  )
  localStorage.setItem('rbcode.activeProjectId', 'browser:beta')
  localStorage.setItem('rbcode.expandedProjects', JSON.stringify(['browser:alpha', 'browser:beta']))
  // 侧栏会用这份缓存渲染「没在当前项目下」的会话
  localStorage.setItem(
    'rbcode.sessionCache.v1',
    JSON.stringify({
      'browser:alpha': [{ id: 's-alpha', title: 'alpha 的会话', createdAt: 1, updatedAt: 1, messageCount: 2 }],
      'browser:beta': [{ id: 's-beta', title: 'beta 的会话', createdAt: 3, updatedAt: 3, messageCount: 2 }],
    }),
  )
})

afterEach(cleanup)

describe('侧栏里的会话', () => {
  it('直接点另一个项目下的会话，会先切过去再打开（不用先点项目）', async () => {
    render(<App />)

    // 当前项目 beta 的会话先出来，另一个项目的会话来自缓存
    await waitFor(() => expect(screen.getByText('beta 的会话')).toBeTruthy(), { timeout: 6000 })
    expect(screen.getByText('alpha 的会话')).toBeTruthy()

    fireEvent.click(screen.getByText('alpha 的会话'))

    await waitFor(() => expect(screen.getByText('alpha 的回复')).toBeTruthy(), { timeout: 6000 })
    expect(localStorage.getItem('rbcode.activeProjectId')).toBe('browser:alpha')
  })

  it('点当前项目下的会话照旧正常工作', async () => {
    render(<App />)

    await waitFor(() => expect(screen.getByText('beta 的会话')).toBeTruthy(), { timeout: 6000 })
    fireEvent.click(screen.getByText('beta 的会话'))

    await waitFor(() => expect(screen.getByText('beta 的回复')).toBeTruthy(), { timeout: 6000 })
    expect(localStorage.getItem('rbcode.activeProjectId')).toBe('browser:beta')
  })
})
