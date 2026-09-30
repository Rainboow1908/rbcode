import { describe, expect, it, vi } from 'vitest'

// 浏览器句柄要存进 IndexedDB，jsdom 里没有，就把它 stub 掉
vi.mock('../lib/executor/idb.ts', () => ({
  idbSet: vi.fn(async () => undefined),
  idbGet: vi.fn(async () => undefined),
  idbDelete: vi.fn(async () => undefined),
}))

import { BrowserBackend } from '../lib/executor/browser.ts'
import { viewImageTool } from '../lib/tools/image.ts'
import type { ToolContext } from '../lib/tools/types.ts'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

const PNG_BYTES = Uint8Array.from(atob(PNG_BASE64), (char) => char.charCodeAt(0))

/** 假的目录句柄：只要 File System Access API 里被用到的那几个方法 */
function fakeRoot(name: string, files: Record<string, Uint8Array>) {
  const fileHandle = (fileName: string, data: Uint8Array) => ({
    kind: 'file' as const,
    name: fileName,
    getFile: async () => new File([data.buffer as ArrayBuffer], fileName),
  })

  return {
    kind: 'directory' as const,
    name,
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    getDirectoryHandle: async (dirName: string) => {
      throw new Error(`missing dir ${dirName}`)
    },
    getFileHandle: async (fileName: string) => {
      const data = files[fileName]
      if (!data) throw new Error(`missing file ${fileName}`)
      return fileHandle(fileName, data)
    },
    removeEntry: async () => undefined,
    async *entries() {
      for (const [fileName, data] of Object.entries(files)) {
        yield [fileName, fileHandle(fileName, data)] as [string, unknown]
      }
    },
  }
}

function makeCtx(backend: BrowserBackend): ToolContext {
  return {
    backend,
    getTodos: () => [],
    setTodos: () => {},
    askUser: async () => '(skipped)',
    recordUndo: async () => 'u1',
  }
}

describe('浏览器沙箱下的 view_image（不经过 companion）', () => {
  it('用 File System Access API 直接读图，交给模型看', async () => {
    vi.stubGlobal('showDirectoryPicker', async () => fakeRoot('demo', { 'logo.png': PNG_BYTES }))

    const backend = await BrowserBackend.pick('test-key')
    const result = await viewImageTool.run({ path: 'logo.png' }, makeCtx(backend))

    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('logo.png')
    expect(result.images?.[0]?.name).toBe('logo.png')
    // 二进制原样读出来了（不是走 fs.read 那种 UTF-8 文本）
    expect(result.images?.[0]?.dataUrl).toBe(`data:image/png;base64,${PNG_BASE64}`)
  })

  it('文件不存在时报“找不到”，而不是把异常抛出去', async () => {
    vi.stubGlobal('showDirectoryPicker', async () => fakeRoot('demo', {}))

    const backend = await BrowserBackend.pick('test-key-missing')
    const result = await viewImageTool.run({ path: 'nope.png' }, makeCtx(backend))

    expect(result.isError).toBe(true)
    expect(result.content).toContain('Image not found')
  })
})
