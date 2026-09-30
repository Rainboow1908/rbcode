import type { Backend } from '../executor/types.ts'
import type { ToolSchema } from '../llm.ts'
import type { AppSettings, LlmTarget, Todo, UndoRecord } from '../types.ts'

/** 需要用户批准的一次操作 */
export interface ApprovalRequest {
  /** 工具名 */
  tool: string
  /** 一句话说明，例如「写入 src/app.tsx」 */
  summary: string
  /** 详细信息：命令原文、改动预览等 */
  detail?: string
  /** 是否属于危险操作（删除） */
  dangerous: boolean
}

export interface AskOption {
  label: string
  description?: string
}

/** 一个待提问的问题 */
export interface AskQuestion {
  question: string
  /** 可选项（最多 4 个；为空就是纯自由问答） */
  options: AskOption[]
  multiSelect: boolean
}

/** 模型向用户提出的问题（最多 5 个） */
export interface AskRequest {
  questions: AskQuestion[]
}

export interface ToolContext {
  backend: Backend
  /** 当前会话 id：后台命令据此归属到发起它的会话，界面按会话分组显示 */
  sessionId?: string
  getTodos(): Todo[]
  setTodos(todos: Todo[]): void
  /** 向用户提问并等待回答（用户跳过时返回一句说明） */
  askUser(request: AskRequest): Promise<string>
  /** 记录一次可撤销的文件变更，返回记录 id */
  recordUndo(record: Omit<UndoRecord, 'id' | 'createdAt'>): Promise<string>
  /**
   * 子 agent 需要的东西（普通工具用不到，测试里构造 context 时可以不给）。
   * getSettings/getTarget 提供当前模型连接；requestApproval 让可写子 agent 的
   * 审批能冒泡到主界面的审批面板。
   */
  getSettings?(): AppSettings
  getTarget?(): LlmTarget | null
  requestApproval?(request: ApprovalRequest): Promise<boolean>
}

/** 工具产出的图片：会作为一条附了图片的消息追加给模型，模型才能真正看到 */
export interface ToolImage {
  name: string
  /** data URL，例如 data:image/jpeg;base64,... */
  dataUrl: string
}

export interface ToolResult {
  content: string
  isError?: boolean
  /** 本次操作产生的可撤销记录 id */
  undoId?: string
  /** 需要让模型看到的图片（截屏、读图片文件） */
  images?: ToolImage[]
  /** 文件改动的行数统计（新增 / 删除），供紧凑显示用 */
  diff?: { added: number; removed: number }
}

export interface ToolDef {
  readonly schema: ToolSchema
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
  /** 是否属于只读工具（计划模式下只允许只读工具） */
  readonly readOnly?: boolean
  /** 是否属于危险操作（删除类），由 agent 层决定要不要先请求审批 */
  readonly dangerous?: boolean
}

export function text(content: string): ToolResult {
  return { content }
}

export function failure(content: string): ToolResult {
  return { content, isError: true }
}

export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Parameter "${key}" must be a non-empty string`)
  }
  return value
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

export function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return undefined
}

export function optionalBoolean(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true
}
