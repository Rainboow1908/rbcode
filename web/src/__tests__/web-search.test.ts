import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Backend, WebFetchResult, WebSearchResult } from '../lib/executor/types.ts'
import { webFetchTool, webSearchTool } from '../lib/tools/web.ts'
import type { ToolContext } from '../lib/tools/types.ts'
import type { AppSettings } from '../lib/types.ts'

/** 假后端：不传 search/fetch 就没有对应能力（相当于浏览器沙箱 / 老版 companion） */
function makeCtx(
  options: {
    search?: (query: string, engine?: string, proxy?: string) => Promise<WebSearchResult>
    fetch?: (url: string, proxy?: string) => Promise<WebFetchResult>
    engine?: string
    proxy?: string
  } = {},
): ToolContext {
  const backend = {
    kind: 'companion',
    label: 'stub',
    rootLabel: 'stub',
    capabilities: { shell: true, miniShell: false, python: true, unrestricted: true },
    readFile: async () => '',
    writeFile: async () => {},
    list: async () => [],
    exists: async () => false,
    mkdir: async () => {},
    remove: async () => {},
    glob: async () => [],
    grep: async () => '',
    shell: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    ...(options.search ? { webSearch: options.search } : {}),
    ...(options.fetch ? { webFetch: options.fetch } : {}),
  } as unknown as Backend

  return {
    backend,
    getTodos: () => [],
    setTodos: () => {},
    askUser: async () => '(skipped)',
    recordUndo: async () => 'undo-1',
    getSettings: () =>
      ({
        webSearchEngine: options.engine ?? 'auto',
        proxy: options.proxy ?? '',
      }) as unknown as AppSettings,
  }
}

const hit = (title: string) => ({ title, url: `https://${title}.example`, snippet: `s-${title}` })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('web_search', () => {
  it('没连本机执行器时：报错并提示去连 companion', async () => {
    const result = await webSearchTool.run({ query: 'rust' }, makeCtx())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('本机执行器')
  })

  it('把结果格式化成编号列表，并标出实际用的源', async () => {
    const search = vi.fn(async () => ({ engine: 'bing', results: [hit('A'), hit('B')] }))
    const result = await webSearchTool.run({ query: 'rust' }, makeCtx({ search }))
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('1. A')
    expect(result.content).toContain('2. B')
    expect(result.content).toContain('source: bing')
  })

  it('没传 engine 时用设置里的默认源', async () => {
    const search = vi.fn(async () => ({ engine: 'bing', results: [hit('A')] }))
    await webSearchTool.run({ query: 'q' }, makeCtx({ search, engine: 'bing' }))
    expect(search).toHaveBeenCalledWith('q', 'bing', undefined)
  })

  it('传 auto 时也用设置里的默认源', async () => {
    const search = vi.fn(async () => ({ engine: 'bing', results: [hit('A')] }))
    await webSearchTool.run({ query: 'q', engine: 'auto' }, makeCtx({ search, engine: 'bing' }))
    expect(search).toHaveBeenCalledWith('q', 'bing', undefined)
  })

  it('模型显式指定的 engine 覆盖设置里的默认值', async () => {
    const search = vi.fn(async () => ({ engine: 'duckduckgo', results: [hit('A')] }))
    await webSearchTool.run(
      { query: 'q', engine: 'duckduckgo' },
      makeCtx({ search, engine: 'bing' }),
    )
    expect(search).toHaveBeenCalledWith('q', 'duckduckgo', undefined)
  })

  it('设置里配了代理时把代理传给后端', async () => {
    const search = vi.fn(async () => ({ engine: 'bing', results: [hit('A')] }))
    await webSearchTool.run({ query: 'q' }, makeCtx({ search, proxy: 'http://127.0.0.1:7897' }))
    expect(search).toHaveBeenCalledWith('q', 'auto', 'http://127.0.0.1:7897')
  })

  it('max_results 会截断结果条数', async () => {
    const search = async () => ({
      engine: 'bing',
      results: [hit('A'), hit('B'), hit('C')],
    })
    const result = await webSearchTool.run({ query: 'q', max_results: 2 }, makeCtx({ search }))
    expect(result.content).toContain('1. A')
    expect(result.content).toContain('2. B')
    expect(result.content).not.toContain('3. C')
  })

  it('一条结果都没有时把 note 原样带回来（比如被验证码拦了）', async () => {
    const search = async () => ({
      engine: 'bing',
      results: [],
      note: 'No results were parsed (bing: captcha)',
    })
    const result = await webSearchTool.run({ query: 'q' }, makeCtx({ search }))
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('captcha')
  })

  it('后端抛错时包成失败结果', async () => {
    const search = async () => {
      throw new Error('connection refused')
    }
    const result = await webSearchTool.run({ query: 'q' }, makeCtx({ search }))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('connection refused')
  })
})

describe('web_fetch', () => {
  const ok = (): WebFetchResult => ({
    url: 'https://a.example/',
    status: 200,
    contentType: 'text/html',
    title: 'Page title',
    text: 'page body',
  })

  it('连着本机执行器时走它，并把代理传下去', async () => {
    const impl = vi.fn(async () => ok())
    const result = await webFetchTool.run(
      { url: 'https://a.example' },
      makeCtx({ fetch: impl, proxy: 'http://127.0.0.1:7897' }),
    )
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('Page title')
    expect(result.content).toContain('page body')
    expect(result.content).toContain('HTTP 200')
    expect(impl).toHaveBeenCalledWith('https://a.example', 'http://127.0.0.1:7897')
  })

  it('本机执行器报错时包成失败结果', async () => {
    const impl = async () => {
      throw new Error('dns failure')
    }
    const result = await webFetchTool.run({ url: 'https://a.example' }, makeCtx({ fetch: impl }))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('dns failure')
  })

  it('没连本机执行器时：报错并提示去连 companion', async () => {
    const spy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', spy)

    const result = await webFetchTool.run({ url: 'https://a.example' }, makeCtx())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('本机执行器')
    // 不再回退到 Worker 的 /api/fetch
    expect(spy).not.toHaveBeenCalled()
  })
})
