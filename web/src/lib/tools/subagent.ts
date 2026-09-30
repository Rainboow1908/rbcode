import { runAgent } from '../agent.ts'
import { ENV_LOCAL_SHELL, ENV_NO_SHELL } from '../settings.ts'
import { failure, optionalString, requireString, text, type ToolDef } from './types.ts'

/**
 * 子 agent：把一段独立的任务丢给一个「自己的上下文」里跑的子 agent，
 * 子 agent 跑完只回一份简报，主对话因此不会被中间过程塞满。
 *
 * 三种类型：
 * - explore：读代码库（只读）
 * - search：联网 + 读工作区（只读）
 * - write：改代码 / 跑命令（写操作照常走主界面的审批）
 *
 * 子 agent 的工具列表里没有 subagent，所以不会无限递归。
 */

type AgentKind = 'explore' | 'search' | 'review' | 'write'

interface AgentDef {
  label: string
  prompt: string
  tools: string[]
}

const AGENTS: Record<AgentKind, AgentDef> = {
  explore: {
    label: 'Explore',
    prompt: `You are an exploration sub-agent working inside the user's project directory.
Your job is to investigate the codebase and report findings. You cannot modify anything.
Use list_dir, glob, grep and read_file to locate relevant files and read them. Be thorough but
efficient: start broad, then narrow down. Never guess file contents — read them.
When done, reply with a concise report: the answer to the task, the exact file paths involved,
and anything the caller must know (risks, open questions). Keep it under ~40 lines. No emoji.`,
    tools: ['read_file', 'list_dir', 'glob', 'grep'],
  },
  search: {
    label: 'Search',
    prompt: `You are a research sub-agent. Answer the task by gathering evidence from the web and
from the user's workspace, then report a concise summary.
Use web_search and web_fetch for external information, and glob/grep/read_file for the workspace.
Cross-check important claims and prefer primary sources. Always include the source URLs you used.
Reply concisely (bullet points are fine), under ~40 lines. No emoji.`,
    tools: ['web_search', 'web_fetch', 'read_file', 'glob', 'grep'],
  },
  review: {
    label: 'Review',
    prompt: `You are a code review sub-agent. Review the changes or files the task points at and report
concrete findings — not a vague summary.
Use git (via bash) to see the diff when useful (e.g. "git diff", "git diff --staged", "git log -p -1"),
and read the surrounding code before judging it. You must not modify anything.
For every finding give: severity (blocker / major / minor / nit), the exact file and line, what is wrong,
and a concrete suggestion. Look for correctness bugs, edge cases, security issues, missing tests, and
inconsistencies with the surrounding code. If you find nothing wrong, say so explicitly and list what you
checked. No emoji.`,
    tools: [
      'read_file',
      'list_dir',
      'glob',
      'grep',
      'bash',
      'bash_output',
      'bash_wait',
      'bash_kill',
    ],
  },
  write: {
    label: 'Write',
    prompt: `You are an implementation sub-agent. Complete one self-contained coding task in the
user's project: read what you need first, then make the changes.
Every write or delete still goes through the user's normal approval flow — do not try to bypass it.
Read a file before editing it, and prefer edit_file over rewriting a whole file. You may run
commands with bash when needed, but inspect before you change anything.
When done, reply with a concise report: what you changed (exact file paths), what you verified,
and any follow-up the caller should know. No emoji.`,
    tools: [
      'read_file',
      'write_file',
      'edit_file',
      'delete_path',
      'list_dir',
      'glob',
      'grep',
      'bash',
      'bash_output',
      'bash_wait',
      'bash_kill',
      'view_image',
    ],
  },
}

export const subagentTool: ToolDef = {
  schema: {
    name: 'subagent',
    description:
      'Delegate a self-contained task to a sub-agent that works in its own context and reports back a short summary. ' +
      'Kinds: "explore" (investigate the codebase, read-only), "search" (research the web and the workspace, read-only), ' +
      '"review" (review a diff/files and report findings, read-only), ' +
      '"write" (implement changes; writes still go through the normal approval flow). ' +
      'Use it for multi-step investigations so the main conversation stays focused. A sub-agent cannot spawn another sub-agent.',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['explore', 'search', 'review', 'write'],
          description: 'Which sub-agent to use. Default "explore".',
        },
        description: { type: 'string', description: 'A short 3-5 word label for this task.' },
        prompt: {
          type: 'string',
          description: 'The complete, self-contained task for the sub-agent.',
        },
      },
      required: ['prompt'],
    },
  },
  async run(args, ctx) {
    const prompt = requireString(args, 'prompt')
    const requested = optionalString(args, 'kind') ?? 'explore'
    const kind = (requested in AGENTS ? requested : 'explore') as AgentKind
    const agent = AGENTS[kind]

    const target = ctx.getTarget?.()
    if (!target) {
      return failure('No model is configured. Pick a provider and model in Settings first.')
    }

    const settings = ctx.getSettings?.()
    const controller = new AbortController()
    /** 只读子 agent 不需要审批（也改不了东西）；可写子 agent 沿用用户的权限档位 */
    const readOnly = kind !== 'write'
    const permission = readOnly ? 'auto' : (settings?.permission ?? 'auto')
    const approve = ctx.requestApproval ?? (async () => false)

    let report = ''
    let error = ''
    const system = `${agent.prompt}${ctx.backend.capabilities.shell ? ENV_LOCAL_SHELL : ENV_NO_SHELL}`

    await runAgent({
      target,
      system,
      history: [{ id: crypto.randomUUID(), role: 'user', content: prompt, createdAt: Date.now() }],
      ctx,
      planMode: false,
      permission,
      getPermission: () => (readOnly ? 'auto' : (ctx.getSettings?.().permission ?? 'auto')),
      toolNames: agent.tools,
      maxIterations: Math.min(20, Math.max(4, settings?.maxIterations ?? 12)),
      signal: controller.signal,
      requestApproval: approve,
      onEvent: (evt) => {
        if (evt.type === 'text') report += evt.text
        else if (evt.type === 'error') error = evt.message
      },
    })

    if (!report.trim() && error) {
      return failure(`Sub-agent (${agent.label}) failed: ${error}`)
    }
    return text(
      `[${agent.label} sub-agent report]\n${report.trim() || '(the sub-agent returned no text)'}`,
    )
  },
}
