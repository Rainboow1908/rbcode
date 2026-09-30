import { describe, expect, it, vi } from 'vitest'
import type { Backend } from '../lib/executor/types.ts'
import { toolSchemas } from '../lib/tools/index.ts'
import { bashTool } from '../lib/tools/shell.ts'
import type { ToolContext } from '../lib/tools/types.ts'

/** 造一个只关心 shell 能力的后端 */
function makeCtx(shell: boolean): ToolContext {
  const backend = {
    kind: shell ? 'companion' : 'browser',
    label: shell ? '本机执行器' : '浏览器沙箱',
    rootLabel: 'demo',
    capabilities: { shell, miniShell: false, python: shell, unrestricted: shell },
    readFile: async () => '',
    writeFile: async () => {},
    list: async () => [],
    exists: async () => false,
    mkdir: async () => {},
    remove: async () => {},
    glob: async () => [],
    grep: async () => '',
    shell: vi.fn(async () => ({ stdout: 'ran the command', stderr: '', exitCode: 0 })),
  } as unknown as Backend

  return {
    backend,
    getTodos: () => [],
    setTodos: () => {},
    askUser: async () => '(skipped)',
    recordUndo: async () => 'undo-1',
  }
}

const shellSpy = (ctx: ToolContext) => ctx.backend.shell as unknown as ReturnType<typeof vi.fn>

describe('bash 与后端能力', () => {
  it('bash 始终在工具列表里（不再按后端裁剪）', () => {
    expect(toolSchemas().map((item) => item.name)).toContain('bash')
    // 计划模式仍然只给只读工具
    expect(toolSchemas({ planMode: true }).map((item) => item.name)).not.toContain('bash')
  })

  it('本机执行器：命令照常执行', async () => {
    const ctx = makeCtx(true)
    const result = await bashTool.run({ command: 'echo hi' }, ctx)

    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('ran the command')
    expect(shellSpy(ctx)).toHaveBeenCalledTimes(1)
  })

  it('浏览器沙箱：bash 自己返回错误，而不是被告知“没有这个工具”', async () => {
    const ctx = makeCtx(false)
    const result = await bashTool.run({ command: 'python main.py' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('No shell on this backend')
    expect(result.content).toContain('浏览器沙箱')
    // 关键：根本没有去执行
    expect(shellSpy(ctx)).not.toHaveBeenCalled()
  })
})
