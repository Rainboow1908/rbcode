import type { ToolSchema } from './llm.ts'
import type {
  Backend,
  McpCallResult,
  McpServerInfo,
  McpServerSpec,
  McpToolInfo,
} from './executor/types.ts'
import { PLAYWRIGHT_MCP_TOOLS } from './presets/playwrightMcpTools.ts'
import type { ToolImage, ToolResult } from './tools/types.ts'
import type { AppSettings } from './types.ts'

/**
 * MCP（Model Context Protocol）接入。
 *
 * 工具名统一是 `mcp__<服务器id>__<工具名>`，出现在工具表里、由模型直接调用。
 * 真正拉起服务器、维持进程的是**本机执行器**（companion），并且按「项目根 + 服务器 id」
 * 每个项目一份进程 + 一份缓存目录 —— 所以两个项目互不影响。
 */

/** id 里只留安全字符（它同时进工具名和缓存目录名） */
function sanitize(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '_')
  return cleaned || 'server'
}

/** 工具表里的名字 */
export function mcpToolName(serverId: string, tool: string): string {
  return `mcp__${sanitize(serverId)}__${tool}`
}

/** 把设置里的 MCP 配置展开成发给 companion 的描述（内置浏览器 + 启用的自定义） */
export function resolveMcpSpecs(settings: AppSettings): McpServerSpec[] {
  const specs: McpServerSpec[] = []

  if (settings.mcpBrowser !== 'off') {
    specs.push({
      id: 'browser',
      name: 'Browser',
      builtin: true,
      command: '',
      args: [],
      env: {},
      browser: settings.mcpBrowser,
      proxy: settings.proxy,
      headless: settings.mcpHeadless,
    })
  }

  for (const server of settings.mcpServers) {
    if (!server.enabled) continue
    const command = server.command.trim()
    if (!command) continue
    specs.push({
      id: server.id,
      name: server.name || server.id,
      command,
      args: [...server.args],
      env: { ...server.env },
    })
  }

  return specs
}

/** 一个可以在工具表里出现的 MCP 工具 */
export interface McpToolEntry {
  /** 工具表里的名字（mcp__…） */
  name: string
  /** 原始工具名，调 tools/call 时用它 */
  tool: string
  /** 属于哪个服务器 */
  spec: McpServerSpec
  serverName: string
  schema: ToolSchema
  /** `annotations.readOnlyHint`：只读的才允许在计划模式下出现 */
  readOnly: boolean
}

/** 把 tools/list 的结果转成工具表条目 */
export function buildMcpTools(
  specs: McpServerSpec[],
  servers: McpServerInfo[],
): McpToolEntry[] {
  const byId = new Map(specs.map((spec) => [spec.id, spec]))
  const entries: McpToolEntry[] = []
  const used = new Set<string>()

  for (const server of servers ?? []) {
    const spec = byId.get(server.id)
    if (!spec) continue
    for (const tool of server.tools ?? []) {
      if (!tool?.name) continue
      let name = mcpToolName(server.id, tool.name)
      // 重名兜底（理论上不会，但别让工具表出现重复 name）
      while (used.has(name)) name = `${name}_`
      used.add(name)

      entries.push({
        name,
        tool: tool.name,
        spec,
        serverName: server.name || server.id,
        readOnly: tool.annotations?.readOnlyHint === true,
        schema: {
          name,
          description: describeTool(tool, server.name || server.id),
          parameters: normalizeSchema(tool),
        },
      })
    }
  }
  return entries
}

/** 描述前面标上来源，模型一眼知道是哪个 MCP 服务器 */
function describeTool(tool: McpToolInfo, serverName: string): string {
  const base = tool.description?.trim() || tool.annotations?.title || tool.name
  return `[MCP: ${serverName}] ${base}`
}

/**
 * MCP 的 inputSchema 基本能直接当工具参数用，只做两点收敛：
 * 去掉 `$schema`（有些厂商不接受额外字段），并保证是个 object。
 */
function normalizeSchema(tool: McpToolInfo): Record<string, unknown> {
  const rest: Record<string, unknown> = {
    ...((tool.inputSchema ?? {}) as Record<string, unknown>),
  }
  delete rest.$schema
  // 模型工具的参数约定是 object；缺 properties 时补个空的
  return { ...rest, type: 'object', properties: rest.properties ?? {} }
}

/** 一次 MCP 探测的结果 */
export interface McpSnapshot {
  /** 对应的项目目录 */
  root: string
  specs: McpServerSpec[]
  entries: McpToolEntry[]
  /** 没起来的服务器（id / 名字 / 原因） */
  errors: Array<{ id: string; name: string; error: string }>
}

/**
 * 探测某个项目下的 MCP 工具。
 *
 * 默认 `start: true`：必要时把服务器拉起来（设置页的「检测」就走这条）。
 * `start: false` 只读工具清单缓存、绝不启动进程 —— 这是给「模型还没调用」的场景用的：
 * 内置浏览器那份清单由 RB Code 打包提供，所以不启动也能让模型看到并调用，
 * 而启动 / 下载浏览器内核都被推迟到模型**真的调用**那一刻。
 */
export async function loadMcpTools(
  backend: Backend | null,
  settings: AppSettings,
  root: string,
  options: { start?: boolean } = {},
): Promise<McpSnapshot> {
  const specs = resolveMcpSpecs(settings)
  const empty: McpSnapshot = { root, specs, entries: [], errors: [] }

  if (!backend?.mcpList || !root || specs.length === 0) return empty

  const start = options.start !== false

  try {
    const { servers } = await backend.mcpList({
      root,
      start,
      builtin: {
        enabled: settings.mcpBrowser !== 'off',
        browser: settings.mcpBrowser,
        proxy: settings.proxy,
        headless: settings.mcpHeadless,
      },
      servers: specs.filter((spec) => !spec.builtin),
    })

    // 服务器还没启动过（只读了缓存）时，内置浏览器用打包好的已知清单兜底
    const merged = (servers ?? []).map((server) =>
      (server.tools?.length ?? 0) > 0 || server.id !== 'browser'
        ? server
        : { ...server, tools: PLAYWRIGHT_MCP_TOOLS },
    )

    return {
      root,
      specs,
      entries: buildMcpTools(specs, merged),
      errors: (servers ?? [])
        .filter((server) => Boolean(server.error))
        .map((server) => ({
          id: server.id,
          name: server.name || server.id,
          error: server.error ?? '',
        })),
    }
  } catch (err) {
    return {
      ...empty,
      errors: [{ id: '*', name: 'MCP', error: (err as Error).message }],
    }
  }
}

/** 调一个 MCP 工具，并把 MCP 的 content 转成工具结果（图片也带上，模型能真看到） */
export async function runMcpTool(
  backend: Backend | null,
  root: string,
  entry: McpToolEntry,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (!backend?.mcpCall) {
    return { content: `${entry.name} 需要连接本机执行器（MCP 要起子进程）。`, isError: true }
  }
  try {
    const result = await backend.mcpCall({
      root,
      server: entry.spec,
      tool: entry.tool,
      args,
    })
    return mcpResultToToolResult(result)
  } catch (err) {
    return { content: `${entry.name} 调用失败：${(err as Error).message}`, isError: true }
  }
}

/** MCP 的 CallToolResult → 我们的 ToolResult */
export function mcpResultToToolResult(result: McpCallResult): ToolResult {
  const images: ToolImage[] = []
  const parts: string[] = []

  for (const item of result.content ?? []) {
    if (item?.type === 'text' && item.text) {
      parts.push(item.text)
      continue
    }
    if (item?.type === 'image' && item.data) {
      const mime = item.mimeType || 'image/png'
      images.push({
        name: `mcp-${images.length + 1}`,
        dataUrl: `data:${mime};base64,${item.data}`,
      })
      parts.push(`(图片：${mime})`)
      continue
    }
    if (item?.type === 'resource' && item.text) {
      parts.push(item.text)
    }
  }

  const content = parts.join('\n\n').trim()
  return {
    content: content || '(MCP 工具没有返回内容)',
    ...(result.isError === true ? { isError: true } : {}),
    ...(images.length > 0 ? { images } : {}),
  }
}
