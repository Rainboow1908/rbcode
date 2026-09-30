import { describe, expect, it } from 'vitest'
import { lastLine } from '../lib/text.ts'

describe('单行预览：取最后一行', () => {
  it('单行内容原样返回', () => {
    expect(lastLine('现在改 agent.ts：abort 时补齐 tool 消息')).toBe(
      '现在改 agent.ts：abort 时补齐 tool 消息',
    )
  })

  it('多行取最后一行', () => {
    expect(lastLine('第一行\n第二行\n第三行')).toBe('第三行')
  })

  it('忽略末尾的空行', () => {
    expect(lastLine('第一行\n第二行\n\n  \n')).toBe('第二行')
  })

  it('空内容返回空串', () => {
    expect(lastLine('')).toBe('')
    expect(lastLine('\n\n  ')).toBe('')
  })

  it('太长的行保留末尾（正在做的事）', () => {
    const preview = lastLine(`${'废话'.repeat(200)}最后在做的事`)
    expect(preview.startsWith('…')).toBe(true)
    expect(preview).toContain('最后在做的事')
    expect(preview.length).toBeLessThanOrEqual(111)
  })

  it('思考过程的真实场景', () => {
    const reasoning = [
      '先看看工具调用的匹配问题。',
      '读一下 MessageList.tsx 里的 toolResults 构建。',
      '现在改 agent.ts：abort 时补齐 tool 消息（而不是直接 return）。',
    ].join('\n')
    expect(lastLine(reasoning)).toBe('现在改 agent.ts：abort 时补齐 tool 消息（而不是直接 return）。')
  })

  it('工具输出的最后一行（比如 bash 结果）', () => {
    const output = '文件 A 已更新\n文件 B 已更新\n共修改 2 个文件'
    expect(lastLine(output)).toBe('共修改 2 个文件')
  })

  it('不随超长内容线性变慢', () => {
    expect(lastLine('x'.repeat(200_000)).length).toBeLessThanOrEqual(111)
  })
})
