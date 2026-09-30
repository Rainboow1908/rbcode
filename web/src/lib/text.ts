import { t } from './i18n.ts'
import type { Message } from './types.ts'

/**
 * 取文本的最后一个非空行，用于界面上的单行预览。
 * 只看末尾一小段，避免流式过程中对超长内容反复做全量分割。
 */
export function lastLine(text: string, max = 110): string {
  if (!text) return ''
  const tail = text.length > 2000 ? text.slice(-2000) : text
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line) return line.length > max ? `…${line.slice(-max)}` : line
  }
  return ''
}

/**
 * Markdown 会把单个换行当成空格。思考过程 / 工具结果里常常是逐行的纯文本，
 * 先把这个「单换行」转成硬换行（行尾两个空格），保住原本的分行。
 */
export function markdownHardBreaks(text: string): string {
  return text.replace(/([^\n])\n(?!\n)/g, '$1  \n')
}

/** 把一段会话导出成 Markdown（/export 指令用） */export function messagesToMarkdown(messages: Message[]): string {
  const out: string[] = []
  for (const message of messages) {
    if (message.hidden) continue
    if (message.role === 'user') {
      const refs = (message.attachments ?? []).filter((a) => a.kind === 'file')
      const imageCount = (message.attachments ?? []).filter((a) => a.kind === 'image').length
      const body = [
        message.content || (imageCount > 0 ? t('(图片)', '(image)', '（圖片）', '（画像）') : ''),
        ...refs.map((a) => `@${a.name}`),
      ]
        .filter(Boolean)
        .join('\n\n')
      out.push(`## ${t('用户', 'User', '使用者', 'ユーザー')}\n\n${body}`)
    } else if (message.role === 'assistant') {
      if (message.reasoning) {
        out.push(
          `> ${t('思考', 'Reasoning', '思考', '思考')}\n>\n> ${message.reasoning.replace(/\n/g, '\n> ')}`,
        )
      }
      if (message.content) out.push(`## ${t('助手', 'Assistant', '助理', 'アシスタント')}\n\n${message.content}`)
      for (const call of message.toolCalls ?? []) {
        out.push(
          `> ${t('调用工具', 'Tool call', '呼叫工具', 'ツール呼び出し')} \`${call.name}\`（\`${JSON.stringify(call.args).slice(0, 300)}\`）`,
        )
      }
    } else if (message.role === 'tool') {
      out.push(
        `<details><summary>${t('工具', 'Tool', '工具', 'ツール')} \`${message.toolName ?? ''}\` ${t('结果', 'result', '結果', 'の結果')}</summary>\n\n\`\`\`\n${message.content}\n\`\`\`\n\n</details>`,
      )
    }
  }
  return out.join('\n\n')
}
