import type { Message } from './types.ts'

/** assistant 消息既没有文本也没有工具调用时，接口会直接拒收 */
function isEmptyAssistant(message: Message): boolean {
  if (message.role !== 'assistant') return false
  return message.content.trim() === '' && (message.toolCalls?.length ?? 0) === 0
}

/** user 消息既没有文本也没有附件时同样无意义 */
function isEmptyUser(message: Message): boolean {
  if (message.role !== 'user') return false
  return message.content.trim() === '' && (message.attachments?.length ?? 0) === 0
}

/**
 * 清洗历史，保证它能被 OpenAI 兼容接口接受。
 *
 * 处理三类问题：
 * 1. assistant 带 tool_calls 但缺少对应的 tool 响应 —— 接口报
 *    "must be followed by tool messages responding to each 'tool_call_id'"
 * 2. 空 assistant 消息（既无 content 也无 tool_calls）—— 接口报
 *    "Invalid assistant message: content or tool_calls must be set"
 *    （用户中途停止时，界面上的占位消息就会变成这种）
 * 3. 没有对应 tool_call 的孤立 tool 消息 —— 同样会被拒收
 *
 * 这些问题一旦留在历史里，整个会话会持续报错，所以每次请求前都跑一遍。
 */
export function repairToolMessages(messages: Message[]): Message[] {
  const out: Message[] = []
  let index = 0

  while (index < messages.length) {
    const message = messages[index]

    if (message.role === 'assistant') {
      // 丢弃空 assistant
      if (isEmptyAssistant(message)) {
        index++
        continue
      }

      // 有工具调用：确保每个 tool_call 都有响应
      if (message.toolCalls && message.toolCalls.length > 0) {
        out.push(message)

        const responses = new Map<string, Message>()
        let next = index + 1
        while (next < messages.length && messages[next].role === 'tool') {
          const tool = messages[next]
          if (tool.toolCallId) responses.set(tool.toolCallId, tool)
          next++
        }

        for (const call of message.toolCalls) {
          const found = responses.get(call.id)
          out.push(
            found ?? {
              id: `repaired-${call.id}`,
              role: 'tool',
              toolCallId: call.id,
              toolName: call.name,
              content:
                'No result was recorded for this tool call (the run was probably interrupted).',
              createdAt: message.createdAt,
              error: 'failed',
            },
          )
        }

        index = next
        continue
      }

      out.push(message)
      index++
      continue
    }

    if (message.role === 'tool') {
      // 没有对应 tool_call 的孤立 tool 消息
      index++
      continue
    }

    if (isEmptyUser(message)) {
      index++
      continue
    }

    out.push(message)
    index++
  }

  return out
}

/** 判断清洗是否真的改动了内容 */
export function historyChanged(before: Message[], after: Message[]): boolean {
  if (before.length !== after.length) return true
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) return true
  }
  return false
}
