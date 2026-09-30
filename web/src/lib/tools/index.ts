import type { ToolSchema } from '../llm.ts'
import {
  deletePathTool,
  editFileTool,
  globTool,
  grepTool,
  listDirTool,
  readFileTool,
  writeFileTool,
} from './fs.ts'
import { askUserTool } from './ask.ts'
import { viewImageTool } from './image.ts'
import { bashKillTool, bashOutputTool, bashTool, bashWaitTool } from './shell.ts'
import { skillTool } from './skill.ts'
import { musicTool } from './music.ts'
import { computerTool } from './computer.ts'
import { subagentTool } from './subagent.ts'
import { todoReadTool, todoWriteTool } from './todo.ts'
import type { ToolContext, ToolDef, ToolResult } from './types.ts'
import { webFetchTool, webSearchTool } from './web.ts'

export const ALL_TOOLS: ToolDef[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  deletePathTool,
  listDirTool,
  globTool,
  grepTool,
  bashTool,
  bashOutputTool,
  bashWaitTool,
  bashKillTool,
  viewImageTool,
  askUserTool,
  webSearchTool,
  webFetchTool,
  todoWriteTool,
  todoReadTool,
  subagentTool,
  skillTool,
  musicTool,
  computerTool,
]

const registry = new Map(ALL_TOOLS.map((t) => [t.schema.name, t]))

/** 按名字取工具定义（agent 层需要它的元信息来判断审批与计划模式） */
export function getTool(name: string): ToolDef | undefined {
  return registry.get(name)
}

export interface SchemaOptions {
  /** 计划模式：只暴露只读工具 */
  planMode?: boolean
  /** 只暴露这些工具（子 agent 用来收窄能力），不传则不限 */
  names?: string[]
}

/**
 * 交给模型的工具列表。
 * 后端能力的差异（比如浏览器沙箱没有真 shell）不在这里裁剪 —— bash 始终在列表里，
 * 由工具自己在执行时检测后端、返回明确的错误。
 */
export function toolSchemas(options: SchemaOptions = {}): ToolSchema[] {
  const { planMode = false, names } = options
  return ALL_TOOLS.filter((tool) => {
    if (names && !names.includes(tool.schema.name)) return false
    if (planMode && tool.readOnly !== true) return false
    return true
  }).map((tool) => tool.schema)
}

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = registry.get(name)
  if (!tool) {
    return { content: `Unknown tool: ${name}`, isError: true }
  }
  try {
    return await tool.run(args, ctx)
  } catch (err) {
    return { content: `Tool ${name} failed: ${(err as Error).message}`, isError: true }
  }
}
