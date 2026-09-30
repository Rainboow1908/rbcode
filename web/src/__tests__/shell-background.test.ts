import { describe, expect, it, vi } from 'vitest'
import type { Backend } from '../lib/executor/types.ts'
import { bashKillTool, bashOutputTool, bashTool, bashWaitTool } from '../lib/tools/shell.ts'
import type { ToolContext } from '../lib/tools/types.ts'

/** 一个能跑命令的假后端；要测的后台方法按需覆盖 */
function makeCtx(overrides: Partial<Backend> = {}): ToolContext {
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
    ...overrides,
  } as unknown as Backend

  return {
    backend,
    // 工具会把当前会话 id 一并带给后端，好让终端能按会话分组
    sessionId: 'session-a',
    getTodos: () => [],
    setTodos: () => {},
    askUser: async () => '(skipped)',
    recordUndo: async () => 'undo-1',
  }
}

describe('bash 的后台能力', () => {
  it('background: true 时不等待，直接返回 shell id', async () => {
    const spawnShell = vi.fn(async () => ({ id: 'sh-42', pid: 42 }))
    const shell = vi.fn(async () => ({ stdout: 'should not run', stderr: '', exitCode: 0 }))

    const result = await bashTool.run(
      { command: 'npm run dev', background: true },
      makeCtx({ spawnShell, shell }),
    )

    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('sh-42')
    // 第二个参数是当前会话 id：后台命令据此归属到发起它的会话
    expect(spawnShell).toHaveBeenCalledWith('npm run dev', 'session-a')
    // 后台路径不该再走一次前台执行
    expect(shell).not.toHaveBeenCalled()
  })

  it('后端不支持后台时给出明确错误，而不是假装启动成功', async () => {
    const result = await bashTool.run(
      { command: 'npm run dev', background: true },
      makeCtx(),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('cannot start commands in the background')
  })

  it('bash_output 读增量输出，并告诉模型下次从哪读', async () => {
    const shellOutput = vi.fn(async () => ({
      id: 'sh-42',
      output: 'listening on 3000\n',
      nextOffset: 20,
      dropped: 0,
      done: false,
      exitCode: null,
    }))

    const result = await bashOutputTool.run({ id: 'sh-42', offset: 0 }, makeCtx({ shellOutput }))

    // 末尾的 sessionId：后端据此只放行本会话的终端
    expect(shellOutput).toHaveBeenCalledWith('sh-42', 0, 'session-a')
    expect(result.content).toContain('listening on 3000')
    expect(result.content).toContain('nextOffset: 20')
    expect(result.content).toContain('still running')
  })

  it('bash_wait 会带上超时，并在结束时报告退出码', async () => {
    const awaitShell = vi.fn(async () => ({
      id: 'sh-42',
      output: 'build ok\n',
      nextOffset: 9,
      dropped: 0,
      done: true,
      exitCode: 0,
      timedOut: false,
    }))

    const result = await bashWaitTool.run({ id: 'sh-42', timeoutMs: 5000 }, makeCtx({ awaitShell }))

    expect(awaitShell).toHaveBeenCalledWith('sh-42', 0, 5000, 'session-a')
    expect(result.content).toContain('finished, exitCode 0')
  })

  it('输出被截断时把丢弃的字节数说清楚', async () => {
    const shellOutput = vi.fn(async () => ({
      id: 'sh-1',
      output: 'x'.repeat(10),
      nextOffset: 10,
      dropped: 2048,
      done: false,
      exitCode: null,
    }))

    const result = await bashOutputTool.run({ id: 'sh-1' }, makeCtx({ shellOutput }))
    expect(result.content).toContain('dropped about')
  })

  it('bash_kill 停掉命令，并说明输出还能读', async () => {
    const killShell = vi.fn(async () => {})

    const result = await bashKillTool.run({ id: 'sh-42' }, makeCtx({ killShell }))

    expect(killShell).toHaveBeenCalledWith('sh-42', 'session-a')
    expect(result.content).toContain('Stopped sh-42')
  })

  it('不填 timeout 就是不限时（由模型自己决定）', async () => {
    const shell = vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }))
    await bashTool.run({ command: 'echo ok' }, makeCtx({ shell }))
    expect(shell).toHaveBeenCalledWith('echo ok', 'session-a', undefined)
  })

  it('用户手动结束：明确告诉模型是被停的，不是「没有输出」', async () => {
    const shell = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0, killed: true }))
    const result = await bashTool.run({ command: 'sleep 999' }, makeCtx({ shell }))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('the user stopped this command')
    expect(result.content).toContain('stopped by user')
  })

  it('超时被强杀：说明超时，并提示改用 background', async () => {
    const shell = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: true }))
    const result = await bashTool.run({ command: 'sleep 999', timeout: 5 }, makeCtx({ shell }))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('timed out and was killed')
    expect(shell).toHaveBeenCalledWith('sleep 999', 'session-a', 5000)
  })

  it('bash_output 在命令被手动结束时也指出来', async () => {
    const shellOutput = vi.fn(async () => ({
      id: 'sh-1',
      output: '',
      nextOffset: 0,
      dropped: 0,
      done: true,
      exitCode: -1,
      killed: true,
    }))
    const result = await bashOutputTool.run({ id: 'sh-1' }, makeCtx({ shellOutput }))
    expect(result.content).toContain('stopped by the user')
  })
})
