import { complete } from './llm.ts'
import type { LlmTarget, Message } from './types.ts'

/** 压缩时保留最近的消息条数 */
const KEEP_RECENT = 8

function estimateSize(message: Message): number {
  const calls = message.toolCalls ? JSON.stringify(message.toolCalls).length : 0
  return message.content.length + (message.reasoning?.length ?? 0) + calls + 8
}

export function estimateChars(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + estimateSize(message), 0)
}

/**
 * 粗略估算 token 数。中英混合下约 2.5 个字符对应 1 个 token，
 * 刻意偏保守（高估），以便在真正触顶前就压缩。
 */
export function estimateTokens(messages: Message[]): number {
  return Math.ceil(estimateChars(messages) / 2.5)
}

/** 是否已接近上下文窗口的阈值 */
export function shouldCompact(
  messages: Message[],
  contextWindow: number,
  thresholdPercent: number,
  keepRecent = KEEP_RECENT,
): boolean {
  if (messages.length <= keepRecent + 2) return false
  const limit = (contextWindow * thresholdPercent) / 100
  return estimateTokens(messages) > limit
}

function toTranscript(messages: Message[]): string {
  return messages
    .map((message) => {
      if (message.role === 'user') {
        return `${message.inserted ? '[user, inserted mid-task] ' : '[user] '}${message.content}`
      }
      if (message.role === 'assistant') {
        const calls = message.toolCalls
          ?.map((call) => `→ called ${call.name}(${JSON.stringify(call.args)})`)
          .join('\n')
        return `[assistant] ${message.content}${calls ? `\n${calls}` : ''}`
      }
      return `[tool result ${message.toolName ?? ''}] ${message.content.slice(0, 1500)}`
    })
    .join('\n\n')
}

/** 模型侧那条摘要消息的开头（旧版本也用它，所以能据此识别旧数据） */
const SUMMARY_PREFIX = '[Summary of earlier conversation]\n'

/**
 * 界面上表示「压缩完成」的那对消息：assistant 的 compact_context 调用 + tool 结果。
 * 只展示、不发模型；带确定性的 id 便于旧数据迁移时保持稳定。
 */
function compactionDisplay(summaryText: string, createdAt: number, idPrefix?: string): Message[] {
  const callId = idPrefix ? `${idPrefix}:call` : crypto.randomUUID()
  return [
    {
      id: idPrefix ? `${idPrefix}:msg` : crypto.randomUUID(),
      role: 'assistant',
      content: '',
      toolCalls: [{ id: callId, name: 'compact_context', args: {} }],
      createdAt,
      uiOnly: true,
    },
    {
      id: idPrefix ? `${idPrefix}:result` : crypto.randomUUID(),
      role: 'tool',
      toolCallId: callId,
      toolName: 'compact_context',
      content: summaryText,
      createdAt,
      uiOnly: true,
    },
  ]
}

/**
 * 旧版本把摘要直接当成一条普通消息存了下来（没有 compact_context 工具卡片）。
 * 打开旧会话时补一次：把它改成「隐藏的模型摘要」，并在旁边补上仅展示的工具卡片，
 * 这样旧会话也能看到「压缩上下文」这次调用。数据不变，只是渲染口径统一。
 */
export function migrateCompaction(messages: Message[]): Message[] {
  const hasLegacy = messages.some(
    (message) => !message.hidden && !message.uiOnly && message.content.startsWith(SUMMARY_PREFIX),
  )
  if (!hasLegacy) return messages

  const out: Message[] = []
  for (const message of messages) {
    if (message.hidden || message.uiOnly || !message.content.startsWith(SUMMARY_PREFIX)) {
      out.push(message)
      continue
    }
    const text = message.content.slice(SUMMARY_PREFIX.length)
    out.push({ ...message, hidden: true })
    out.push(...compactionDisplay(text, message.createdAt, `compact:${message.id}`))
  }
  return out
}

/**
 * 压缩结果：
 * - `model`：发给模型的新历史（一条隐藏的摘要消息 + 保留的近期原文）
 * - `display`：界面上表示「压缩完成」的那对消息（assistant 的 compact_context 调用
 *   + tool 结果），只展示、不发模型——看起来就和普通的 bash 工具卡片一样
 * - `compactedIds`：被归档的消息 id（界面照常显示，但不再发给模型）
 */
export interface CompactionResult {
  model: Message[]
  /** 隐藏的摘要消息：界面里不渲染，但必须留在会话里——后续请求靠它接上被压缩掉的历史 */
  summary: Message
  display: Message[]
  compactedIds: string[]
}

/**
 * 把较早的对话压缩成一条摘要，保留最近若干条原文。
 * 会在截断点向前回退，避免把 tool 结果和它的 tool_call 拆散。
 *
 * 注意：这里**不修改界面消息**——调用方拿 `display` / `compactedIds` 自己去标记，
 * 这样被压缩掉的历史在界面上原样保留，压缩本身则呈现为一次工具调用。
 */
export async function compactMessages(
  target: LlmTarget,
  messages: Message[],
  signal?: AbortSignal,
  keepRecent = KEEP_RECENT,
): Promise<CompactionResult | null> {
  let start = Math.max(0, messages.length - keepRecent)
  while (start > 0 && messages[start].role === 'tool') start--

  const older = messages.slice(0, start)
  const recent = messages.slice(start)
  if (older.length === 0) return null

  const summary = await complete(
    target,
    'You compress conversation history. Produce a concise summary that MUST preserve: the user goals and constraints, conclusions already reached, file paths and key changes, and any unfinished tasks. Do not invent information that is not in the transcript. Always write the summary in English, regardless of the language used in the conversation.',
    [
      {
        id: crypto.randomUUID(),
        role: 'user',
        content: `Summarize the following conversation history:\n\n${toTranscript(older)}`,
        createdAt: Date.now(),
      },
    ],
    signal,
  )

  if (!summary) return null

  const now = Date.now()
  // 发给模型的那份：用 user 角色（历史仍然以 user 开头，兼容思考模式接口），
  // hidden 让它在界面里不单独出现——界面用下面那张工具卡片来表示这次压缩。
  const modelSummary: Message = {
    id: crypto.randomUUID(),
    role: 'user',
    content: `${SUMMARY_PREFIX}${summary}`,
    createdAt: now,
    hidden: true,
  }

  return {
    model: [modelSummary, ...recent],
    summary: modelSummary,
    display: compactionDisplay(summary, now),
    compactedIds: older.map((message) => message.id),
  }
}

/**
 * 只返回新历史的旧接口：保留最近若干条原文，其余压成一条摘要消息。
 * （界面上的完整呈现请用 compactMessages，它会额外给你可展示的工具卡片。）
 */
export async function compact(
  target: LlmTarget,
  messages: Message[],
  signal?: AbortSignal,
  keepRecent = KEEP_RECENT,
): Promise<Message[]> {
  const result = await compactMessages(target, messages, signal, keepRecent)
  return result ? result.model : messages
}
