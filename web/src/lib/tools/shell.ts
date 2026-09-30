import { formatBytes } from '../executor/path.ts'
import type { ShellOutput } from '../executor/types.ts'
import { isDangerousCommand } from '../permissions.ts'
import { snapshotTree } from '../undo.ts'
import { failure, requireString, text, type ToolDef } from './types.ts'
import { hitsRbcodeCommand, rbcodeRefusal } from './rbcode.ts'

/** Pull the targets out of a delete command so we can snapshot them for undo */
function extractRemoveTargets(command: string): string[] {
  const match = /(?:^|[\s;|&])(?:rm|rmdir|del|erase|Remove-Item|rd)\s+([^;|&]+)/i.exec(command)
  if (!match) return []
  return match[1]
    .split(/\s+/)
    .map((token) => token.replace(/^["']|["']$/g, ''))
    .filter((token) => token && !token.startsWith('-') && !/^\/[a-z]$/i.test(token))
}

export const bashTool: ToolDef = {
  schema: {
    name: 'bash',
    description:
      'Run a system command (python, git, npm, powershell...) through the local companion executor. In the browser sandbox there is no real shell and this tool returns an error — use the file tools there. To delete files, prefer delete_path so the change can be undone. Decide yourself whether a command needs a timeout (the optional timeout field, in seconds) — omit it for commands that should run to completion. For long-running commands (dev servers, watchers) pass background: true — it returns a shell id immediately, then use bash_output to read its output, bash_wait to wait for it, bash_kill to stop it.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to run' },
        description: { type: 'string', description: 'What this command is for (optional)' },
        timeout: {
          type: 'number',
          description:
            'Optional. Seconds before the command is killed. You decide: set it for commands that could hang, omit it for ones that should run to completion (for persistent processes like dev servers use background: true instead).',
        },
        background: {
          type: 'boolean',
          description:
            'Start it in the background and return a shell id right away (dev servers, watchers, anything long-running). Read output with bash_output, wait with bash_wait, stop with bash_kill.',
        },
      },
      required: ['command'],
    },
  },
  async run(args, ctx) {
    const command = requireString(args, 'command')
    // `.rbcode` 是应用数据目录：命令串里碰到就拒绝（尽力而为，见 rbcode.ts 说明）
    if (hitsRbcodeCommand(command)) return failure(rbcodeRefusal(command))

    // 浏览器沙箱没有能跑系统命令的 shell：直接返回错误，而不是让模型以为这个工具不存在
    if (!ctx.backend.capabilities.shell) {
      return failure(
        `No shell on this backend: "${ctx.backend.label}" cannot run system commands. ` +
          'Use the file tools (read_file, write_file, edit_file, delete_path, list_dir, glob, grep) ' +
          'or web_search / web_fetch; if a command is really needed, ask the user to switch to the local companion executor.',
      )
    }

    // 后台执行：立刻返回 id，之后用 bash_output / bash_wait / bash_kill
    if (args.background === true) {
      if (!ctx.backend.spawnShell) {
        return failure(
          `The backend "${ctx.backend.label}" cannot start commands in the background. Run it in the foreground instead.`,
        )
      }
      const started = await ctx.backend.spawnShell(command, ctx.sessionId)
      return text(
        `Started in the background.\nid: ${started.id}\npid: ${started.pid}\n\n` +
          'Read new output with bash_output (pass this id), wait for it with bash_wait, stop it with bash_kill.',
      )
    }

    const dangerous = isDangerousCommand(command)

    // Deleting through the shell: snapshot the targets when we can figure them out
    let undoId: string | undefined
    if (dangerous) {
      const targets = extractRemoveTargets(command)
      const files: { path: string; content: string }[] = []
      for (const target of targets) {
        const snapshot = await snapshotTree(ctx.backend, target).catch(() => ({
          files: [] as { path: string; content: string }[],
          truncated: true,
        }))
        files.push(...snapshot.files)
      }
      if (files.length > 0) {
        undoId = await ctx.recordUndo({
          kind: 'delete',
          path: targets.join(' '),
          before: null,
          files,
          summary: `Shell delete: ${command}`,
        })
      }
    }

    const timeoutMs =
      typeof args.timeout === 'number' && args.timeout > 0
        ? Math.round(args.timeout * 1000)
        : undefined
    const result = await ctx.backend.shell(command, ctx.sessionId, timeoutMs)

    const sections: string[] = []
    // 用户手动结束 / 超时被强杀：这两种都不是「命令正常跑完且没有输出」
    if (result.killed)
      sections.push('[the user stopped this command from the terminal panel — it was not an empty result]')
    else if (result.timedOut)
      sections.push('[timed out and was killed — increase the timeout or use background: true]')
    if (result.stdout) sections.push(result.stdout.trimEnd())
    if (result.stderr) sections.push(`[stderr]\n${result.stderr.trimEnd()}`)
    if (sections.length === 0) sections.push('(no output)')

    // companion 会给每个输出流设上限，被丢掉的部分这里说清楚，免得模型以为命令就这么点输出
    const dropped = (result.stdoutDropped ?? 0) + (result.stderrDropped ?? 0)
    const truncatedNote = dropped > 0 ? `\n[output truncated: dropped about ${formatBytes(dropped)}]` : ''
    const statusNote = result.killed ? ' · stopped by user' : result.timedOut ? ' · timed out' : ''
    const header = `$ ${command}\nexit code ${result.exitCode} (backend: ${ctx.backend.label})${statusNote}${truncatedNote}`
    const content = `${header}\n${sections.join('\n')}`.slice(0, 12_000)

    const ok =
      result.exitCode === 0 && !result.stderr && !result.killed && !result.timedOut
    const toolResult = ok ? text(content) : failure(content)
    return undoId ? { ...toolResult, undoId } : toolResult
  },
}

/** 把后台命令的读取结果整理成给模型看的一段话 */
function formatShellOutput(result: ShellOutput & { timedOut?: boolean }): string {
  const parts: string[] = []
  const body = result.output.trimEnd() || '(no new output)'
  parts.push(body.length > 12_000 ? `${body.slice(0, 12_000)}\n…[truncated]` : body)
  if (result.dropped > 0) {
    parts.push(`[output truncated: dropped about ${formatBytes(result.dropped)}]`)
  }
  if (result.killed) parts.push('[stopped by the user from the terminal panel — not an empty result]')
  else if (result.done) parts.push(`[finished, exitCode ${result.exitCode ?? -1}]`)
  else parts.push('[still running]')
  parts.push(`nextOffset: ${result.nextOffset}`)
  return parts.join('\n')
}

/** 读后台命令的新输出 */
export const bashOutputTool: ToolDef = {
  schema: {
    name: 'bash_output',
    description:
      'Read new output from a command started with bash background:true, in THIS conversation. Pass the nextOffset of the previous result to get only what is new. When done is true the command has finished — see exitCode. Commands started by other conversations are not accessible here.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Shell id returned by bash' },
        offset: {
          type: 'number',
          description: 'Where to read from: the nextOffset of the previous result (omit for everything so far)',
        },
      },
      required: ['id'],
    },
  },
  readOnly: true,
  async run(args, ctx) {
    const id = requireString(args, 'id')
    if (!ctx.backend.shellOutput) {
      return failure(`The backend "${ctx.backend.label}" does not support background commands.`)
    }
    const offset = typeof args.offset === 'number' ? args.offset : 0
    return text(formatShellOutput(await ctx.backend.shellOutput(id, offset, ctx.sessionId)))
  },
}

/** 等后台命令结束 */
export const bashWaitTool: ToolDef = {
  schema: {
    name: 'bash_wait',
    description:
      'Wait until a command started with bash background:true in THIS conversation finishes (or the timeout hits), then return the output produced meanwhile. Use it instead of polling with bash_output. timedOut is true when it is still running.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Shell id returned by bash' },
        timeoutMs: {
          type: 'number',
          description: 'How long to wait at most in milliseconds (default 30000, max 180000)',
        },
        offset: { type: 'number', description: 'Where to read from (use the previous nextOffset)' },
      },
      required: ['id'],
    },
  },
  readOnly: true,
  async run(args, ctx) {
    const id = requireString(args, 'id')
    if (!ctx.backend.awaitShell) {
      return failure(`The backend "${ctx.backend.label}" does not support background commands.`)
    }
    const offset = typeof args.offset === 'number' ? args.offset : 0
    const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 30_000
    return text(
      formatShellOutput(await ctx.backend.awaitShell(id, offset, timeoutMs, ctx.sessionId)),
    )
  },
}

/** 停掉后台命令 */
export const bashKillTool: ToolDef = {
  schema: {
    name: 'bash_kill',
    description:
      'Stop a command started with bash background:true in THIS conversation (kills the whole process tree). What it produced so far can still be read with bash_output.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Shell id returned by bash' },
      },
      required: ['id'],
    },
  },
  async run(args, ctx) {
    const id = requireString(args, 'id')
    if (!ctx.backend.killShell) {
      return failure(`The backend "${ctx.backend.label}" does not support background commands.`)
    }
    await ctx.backend.killShell(id, ctx.sessionId)
    // 停掉命令时把「已经输出的部分」一并交回给模型；否则模型只看到一句「已停止」，
    // 拿不到命令中断前跑出来的东西。
    if (ctx.backend.shellOutput) {
      try {
        const out = await ctx.backend.shellOutput(id, 0, ctx.sessionId)
        return text(`Stopped ${id}.\n${formatShellOutput({ ...out, killed: true, done: true })}`)
      } catch {
        // 读不到就算了，退回原来的提示
      }
    }
    return text(`Stopped ${id}. You can still read what it produced with bash_output.`)
  },
}
