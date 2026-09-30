import { describe, expect, it, vi } from 'vitest'
import type { Backend } from '../lib/executor/types.ts'
import { viewImageTool } from '../lib/tools/image.ts'
import type { ToolContext } from '../lib/tools/types.ts'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

function makeCtx(options: {
  base64?: string
  size?: number
  exists?: boolean
  readError?: string
  /** 模拟“后端没有 readFileBase64” */
  noBase64Support?: boolean
} = {}): ToolContext {
  const backend: Record<string, unknown> = {
    kind: 'companion',
    label: '本机执行器',
    rootLabel: 'demo',
    capabilities: { shell: true, miniShell: false, python: true, unrestricted: true },
    readFile: async () => '',
    writeFile: async () => {},
    list: async () => [],
    exists: async () => options.exists ?? true,
    mkdir: async () => {},
    remove: async () => {},
    glob: async () => [],
    grep: async () => '',
    shell: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  }

  if (!options.noBase64Support) {
    backend.readFileBase64 = vi.fn(async () => {
      if (options.readError) throw new Error(options.readError)
      return { base64: options.base64 ?? PNG_BASE64, size: options.size ?? 70 }
    })
  }

  return {
    backend: backend as unknown as Backend,
    getTodos: () => [],
    setTodos: () => {},
    askUser: async () => '(skipped)',
    recordUndo: async () => 'u1',
  }
}

describe('view_image', () => {
  it('把图片读成 base64 交给模型看', async () => {
    const result = await viewImageTool.run({ path: 'design/logo.png' }, makeCtx())

    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('design/logo.png')
    expect(result.images?.[0]?.name).toBe('logo.png')
    expect(result.images?.[0]?.dataUrl).toBe(`data:image/png;base64,${PNG_BASE64}`)
  })

  it('支持的扩展名都映射到正确的 MIME', async () => {
    const cases: [string, string][] = [
      ['a.png', 'image/png'],
      ['a.jpg', 'image/jpeg'],
      ['a.jpeg', 'image/jpeg'],
      ['a.gif', 'image/gif'],
      ['a.webp', 'image/webp'],
    ]
    for (const [path, mime] of cases) {
      const result = await viewImageTool.run({ path }, makeCtx())
      expect(result.images?.[0]?.dataUrl.startsWith(`data:${mime};base64,`), path).toBe(true)
    }
  })

  it('不是图片扩展名就直接拒绝', async () => {
    const result = await viewImageTool.run({ path: 'notes.txt' }, makeCtx())

    expect(result.isError).toBe(true)
    expect(result.content).toContain('Unsupported image type')
  })

  it('文件不存在时给出明确错误', async () => {
    const result = await viewImageTool.run({ path: 'missing.png' }, makeCtx({ exists: false }))

    expect(result.isError).toBe(true)
    expect(result.content).toContain('Image not found')
  })

  it('后端读不了二进制时，建议改成粘贴图片', async () => {
    const result = await viewImageTool.run({ path: 'a.png' }, makeCtx({ noBase64Support: true }))

    expect(result.isError).toBe(true)
    expect(result.content).toContain('Paste the image')
  })

  it('图片超过 4MB 就拒绝', async () => {
    const result = await viewImageTool.run({ path: 'huge.png' }, makeCtx({ size: 5 * 1024 * 1024 }))

    expect(result.isError).toBe(true)
    expect(result.content).toContain('too large')
  })

  it('读取失败时把原因带回来', async () => {
    const result = await viewImageTool.run({ path: 'a.png' }, makeCtx({ readError: 'disk on fire' }))

    expect(result.isError).toBe(true)
    expect(result.content).toContain('disk on fire')
  })

  it('没有 shell 的后端也能用（只要它实现了 readFileBase64）', async () => {
    const ctx = makeCtx()
    ;(ctx.backend as unknown as { capabilities: { shell: boolean } }).capabilities.shell = false

    const result = await viewImageTool.run({ path: 'x.png' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.images?.length).toBe(1)
  })
})
