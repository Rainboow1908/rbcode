import { describe, expect, it, vi } from 'vitest'
import {
  buildMcpTools,
  loadMcpTools,
  mcpResultToToolResult,
  mcpToolName,
  resolveMcpSpecs,
  runMcpTool,
} from '../lib/mcp.ts'
import type { Backend, McpServerInfo } from '../lib/executor/types.ts'
import { defaultSettings } from '../lib/settings.ts'
import type { McpServerConfig } from '../lib/types.ts'

const custom = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: 'fs',
  name: 'Files',
  command: 'npx',
  args: ['-y', 'some-mcp'],
  env: { TOKEN: 'abc' },
  enabled: true,
  ...over,
})

describe('MCP 工具名', () => {
  it('统一加前缀，并把不安全的字符换掉', () => {
    expect(mcpToolName('browser', 'browser_navigate')).toBe('mcp__browser__browser_navigate')
    expect(mcpToolName('my server/x', 'go')).toBe('mcp__my_server_x__go')
  })
})

describe('从设置展开 MCP 服务器', () => {
  it('默认带内置浏览器（含代理），自定义按开关挑', () => {
    const settings = {
      ...defaultSettings(),
      mcpBrowser: 'chrome' as const,
      proxy: 'http://127.0.0.1:7897',
      mcpServers: [custom(), custom({ id: 'off', enabled: false }), custom({ id: '空', command: '' })],
    }
    const specs = resolveMcpSpecs(settings)
    expect(specs.map((spec) => spec.id)).toEqual(['browser', 'fs'])

    const builtin = specs[0]
    expect(builtin.builtin).toBe(true)
    expect(builtin.browser).toBe('chrome')
    expect(builtin.proxy).toBe('http://127.0.0.1:7897')
    expect(builtin.headless).toBe(true)

    expect(specs[1]).toMatchObject({ id: 'fs', name: 'Files', command: 'npx' })
  })

  it('mcpBrowser = off 时不带内置浏览器', () => {
    const settings = { ...defaultSettings(), mcpBrowser: 'off' as const }
    expect(resolveMcpSpecs(settings)).toHaveLength(0)
  })
})

describe('生成工具表条目', () => {
  const settings = { ...defaultSettings(), mcpBrowser: 'msedge' as const }
  const specs = resolveMcpSpecs(settings)

  const servers: McpServerInfo[] = [
    {
      id: 'browser',
      name: 'Browser',
      tools: [
        {
          name: 'browser_navigate',
          description: 'Navigate to a URL',
          inputSchema: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: { url: { type: 'string' } },
            required: ['url'],
          },
          annotations: { readOnlyHint: false },
        },
        {
          name: 'browser_snapshot',
          description: 'Take a snapshot',
          inputSchema: { type: 'object', properties: {} },
          annotations: { readOnlyHint: true, title: 'Snapshot' },
        },
      ],
    },
    { id: 'gone', name: 'Gone', tools: [{ name: 'x' }], error: '启动失败' },
  ]

  it('名字加前缀、描述标出来源、$schema 去掉、readOnlyHint 映射到 readOnly', () => {
    const entries = buildMcpTools(specs, servers)
    expect(entries.map((entry) => entry.name)).toEqual([
      'mcp__browser__browser_navigate',
      'mcp__browser__browser_snapshot',
    ])

    const [navigate, snapshot] = entries
    expect(navigate.tool).toBe('browser_navigate')
    expect(navigate.schema.description).toBe('[MCP: Browser] Navigate to a URL')
    expect(navigate.schema.parameters).toEqual({
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    })
    expect(navigate.readOnly).toBe(false)
    expect(snapshot.readOnly).toBe(true)
    expect(snapshot.schema.description).toBe('[MCP: Browser] Take a snapshot')
  })

  it('没在 specs 里的服务器（比如起不来）不会进工具表', () => {
    const entries = buildMcpTools(specs, servers)
    expect(entries.some((entry) => entry.name.includes('gone'))).toBe(false)
  })
})

describe('MCP 返回值转换', () => {
  it('文本拼接；图片转 data URL 交给模型看；isError 透传', () => {
    const result = mcpResultToToolResult({
      content: [
        { type: 'text', text: '第一段' },
        { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
        { type: 'text', text: '第二段' },
      ],
    })
    expect(result.content).toContain('第一段')
    expect(result.content).toContain('第二段')
    expect(result.images?.[0].dataUrl).toBe('data:image/jpeg;base64,AAAA')
    expect(result.isError).toBeUndefined()

    expect(mcpResultToToolResult({ isError: true, content: [] }).isError).toBe(true)
    expect(mcpResultToToolResult({ content: [] }).content).toContain('没有返回内容')
  })
})

describe('调用 MCP 工具', () => {
  const [entry] = buildMcpTools(
    [{ id: 'browser', name: 'Browser', builtin: true, command: '', args: [], env: {} }],
    [
      {
        id: 'browser',
        name: 'Browser',
        tools: [{ name: 'browser_navigate', description: 'go' }],
      },
    ],
  )

  it('没连本机执行器时直接报错', async () => {
    const result = await runMcpTool(null, 'D:\\proj', entry, {})
    expect(result.isError).toBe(true)
    expect(result.content).toContain('本机执行器')
  })

  it('把 root / 服务器 / 工具名 / 参数原样交给后端', async () => {
    const mcpCall = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }))
    const backend = { mcpCall } as unknown as Backend

    const result = await runMcpTool(backend, 'D:\\proj', entry, { url: 'https://x' })
    expect(result.content).toBe('ok')
    expect(mcpCall).toHaveBeenCalledWith({
      root: 'D:\\proj',
      server: expect.objectContaining({ id: 'browser' }),
      tool: 'browser_navigate',
      args: { url: 'https://x' },
    })
  })

  it('后端抛错时包成失败结果', async () => {
    const backend = {
      mcpCall: async () => {
        throw new Error('服务器已退出')
      },
    } as unknown as Backend
    const result = await runMcpTool(backend, 'D:\\proj', entry, {})
    expect(result.isError).toBe(true)
    expect(result.content).toContain('服务器已退出')
  })
})

describe('按需启动', () => {
  it('start:false 只读缓存，并用打包清单兜底内置浏览器', async () => {
    const mcpList = vi.fn(async () => ({
      servers: [{ id: 'browser', name: 'Browser', tools: [], cached: true }],
    }))
    const backend = { mcpList } as unknown as Backend

    const snapshot = await loadMcpTools(backend, defaultSettings(), 'D:\\proj', { start: false })

    expect(mcpList).toHaveBeenCalledWith(
      expect.objectContaining({ start: false, root: 'D:\\proj' }),
    )
    // 打包的已知清单把内置浏览器那批工具顶上了，模型不用等服务器启动
    expect(snapshot.entries.length).toBeGreaterThan(10)
    expect(snapshot.entries.some((entry) => entry.name === 'mcp__browser__browser_navigate')).toBe(
      true,
    )
    expect(snapshot.errors).toHaveLength(0)
  })

  it('服务器给出真实清单时优先用它（不用打包那份）', async () => {
    const mcpList = vi.fn(async () => ({
      servers: [{ id: 'browser', name: 'Browser', tools: [{ name: 'only_one', description: 'x' }] }],
    }))
    const backend = { mcpList } as unknown as Backend

    const snapshot = await loadMcpTools(backend, defaultSettings(), 'D:\\proj', { start: false })
    expect(snapshot.entries.map((entry) => entry.name)).toEqual(['mcp__browser__only_one'])
  })

  it('默认（不传 start）会让服务器起来', async () => {
    const mcpList = vi.fn(async () => ({ servers: [] }))
    const backend = { mcpList } as unknown as Backend

    await loadMcpTools(backend, defaultSettings(), 'D:\\proj')
    expect(mcpList).toHaveBeenCalledWith(expect.objectContaining({ start: true }))
  })
})
