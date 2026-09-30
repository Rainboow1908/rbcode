import { useCallback, useEffect, useRef, useState } from 'react'
import { runAgent } from '../lib/agent.ts'
import { compactMessages, migrateCompaction, shouldCompact } from '../lib/compact.ts'
import type { Backend } from '../lib/executor/types.ts'
import { t } from '../lib/i18n.ts'
import type { Usage } from '../lib/llm.ts'
import { loadMcpTools, runMcpTool, type McpSnapshot } from '../lib/mcp.ts'
import { RateMeter } from '../lib/rate.ts'
import { prepareAttachments } from '../lib/attachments.ts'
import { historyChanged, repairToolMessages } from '../lib/sanitize.ts'
import {
  DEFAULT_SYSTEM_PROMPT,
  ENV_ANDROID_SHELL,
  ENV_LOCAL_SHELL,
  ENV_NO_SHELL,
  PLAN_MODE_PROMPT,
  toLlmTarget,
} from '../lib/settings.ts'
import type { ApprovalRequest, AskRequest, ToolContext } from '../lib/tools/types.ts'
import type { AppSettings, Attachment, Message, Todo, UsageStats } from '../lib/types.ts'
import { applyUndo, archiveMessages, pushUndo, undoIdsFromMessage } from '../lib/undo.ts'

export interface QueuedMessage {
  id: string
  text: string
  attachments: Attachment[]
}

export type { UsageStats }

/** 还没探测 / 不可用时的空 MCP 快照 */
const EMPTY_MCP: McpSnapshot = { root: '', specs: [], entries: [], errors: [] }

/**
 * 每个会话自己的运行时状态。
 * 分开存是为了让「切到别的会话」不影响正在跑的那个：
 * 消息、运行状态、队列、中止控制器全部按会话隔离。
 */
interface SessionRuntime {
  messages: Message[]
  running: boolean
  rounds: number
  compacting: boolean
  toolDraft: { name: string; argsSoFar: string } | null
  undone: string[]
  queue: QueuedMessage[]
  urgent: QueuedMessage[]
  usage: UsageStats
  startedAt: number | null
  notice: string | null
  abort: AbortController | null
  /** 这个会话自己的计划清单（切走再切回来还在，也不会串到别的会话） */
  todos: Todo[]
}

const EMPTY_USAGE: UsageStats = {
  requests: 0,
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
}

const EMPTY_RUNTIME: SessionRuntime = {
  messages: [],
  running: false,
  rounds: 0,
  compacting: false,
  toolDraft: null,
  undone: [],
  queue: [],
  urgent: [],
  usage: EMPTY_USAGE,
  startedAt: null,
  notice: null,
  abort: null,
  todos: [],
}

export interface UseAgentOptions {
  settings: AppSettings
  backend: Backend | null
  planMode: boolean
  /** 当前界面上显示哪个会话 */
  activeSessionId: string | null
  requestApproval: (request: ApprovalRequest) => Promise<boolean>
  askUser: (request: AskRequest) => Promise<string>
  /** 某个会话的消息有变化（用于按会话持久化） */
  onSessionMessages?: (
    sessionId: string,
    messages: Message[],
    usage: UsageStats,
    todos: Todo[],
  ) => void
  /** 某个会话的待办清单变了（TodoPanel 用） */
  onTodos?: (todos: Todo[]) => void
  /** 一次模型请求结束（用于统计） */
  onRequestDone?: () => void
  /** 一轮对话真正结束且未被中止（用于提示音）：done=正常结束，error=报错 */
  onTaskEnd?: (sessionId: string, outcome: 'done' | 'error') => void
}

/** 依次尝试读取常见的项目记忆文件 */
async function loadMemory(backend: Backend): Promise<string> {
  const candidates = ['AGENTS.md', 'CLAUDE.md', '.cursorrules']
  for (const name of candidates) {
    try {
      const content = await backend.readFile(name)
      if (content.trim()) {
        return `\n\n# Project memory (from ${name})\n\n${content.slice(0, 8000)}`
      }
    } catch {
      // 文件不存在就继续尝试下一个
    }
  }
  return ''
}

export function useAgent({
  settings,
  backend,
  planMode,
  activeSessionId,
  requestApproval,
  askUser,
  onSessionMessages,
  onTodos,
  onRequestDone,
  onTaskEnd,
}: UseAgentOptions) {
  const [runtimes, setRuntimes] = useState<Map<string, SessionRuntime>>(new Map())
  const memoryRef = useRef<{ key: string; text: string } | null>(null)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const planModeRef = useRef(planMode)
  planModeRef.current = planMode
  const backendRef = useRef<Backend | null>(backend)
  backendRef.current = backend
  const callbacksRef = useRef({ onSessionMessages, onTodos, onRequestDone, onTaskEnd })
  callbacksRef.current = { onSessionMessages, onTodos, onRequestDone, onTaskEnd }

  /**
   * 「当前速度」计量：每个会话一份。只统计最近几秒收到的 token，
   * 工具执行 / 等审批这些空闲时间会自然滑出窗口，所以不会像平均速度那样被稀释。
   */
  const metersRef = useRef(new Map<string, RateMeter>())
  const meterFor = useCallback((sessionId: string) => {
    let meter = metersRef.current.get(sessionId)
    if (!meter) {
      meter = new RateMeter()
      metersRef.current.set(sessionId, meter)
    }
    return meter
  }, [])

  /**
   * MCP：当前项目探测到的工具。只放 ref —— 它只用来拼工具表，不需要触发渲染，
   * 也避免 state 与 ref 之间的竞态。
   */
  const mcpRef = useRef<McpSnapshot>(EMPTY_MCP)

  useEffect(() => {
    // 项目 / 后端 / MCP 设置变了：先清空。
    // 真正去拉起服务器放在「第一次发消息时」按需做（见下面的 runStream），
    // 这样打开项目不会白起一个 npx 进程；浏览器内核更是要等模型真去开页面才下载。
    mcpRef.current = EMPTY_MCP
  }, [
    backend,
    settings.mcpBrowser,
    settings.mcpHeadless,
    settings.mcpServers,
    settings.proxy,
  ])

  /** 读某个会话的运行时（不存在就是空） */
  const readRuntime = useCallback(
    (sessionId: string | null): SessionRuntime =>
      (sessionId ? runtimes.get(sessionId) : undefined) ?? EMPTY_RUNTIME,
    [runtimes],
  )

  const runtime = readRuntime(activeSessionId)

  /** 正在运行的会话 id（侧栏用来显示转圈） */
  const runningSessionIds = [...runtimes.entries()]
    .filter(([, item]) => item.running)
    .map(([id]) => id)

  /** 只更新指定会话，不碰其他会话 */
  const patchRuntime = useCallback(
    (
      sessionId: string,
      patch: Partial<SessionRuntime> | ((prev: SessionRuntime) => Partial<SessionRuntime>),
    ) => {
      setRuntimes((prev) => {
        const next = new Map(prev)
        const current = next.get(sessionId) ?? EMPTY_RUNTIME
        const changes = typeof patch === 'function' ? patch(current) : patch
        next.set(sessionId, { ...current, ...changes })
        return next
      })
    },
    [],
  )

  const updateMessages = useCallback(
    (sessionId: string, fn: (prev: Message[]) => Message[]) => {
      setRuntimes((prev) => {
        const next = new Map(prev)
        const current = next.get(sessionId) ?? EMPTY_RUNTIME
        const messages = fn(current.messages)
        next.set(sessionId, { ...current, messages })
        // 通知外部持久化（按会话）—— 用量一起带上，写进会话文件
        callbacksRef.current.onSessionMessages?.(sessionId, messages, current.usage, current.todos)
        return next
      })
    },
    [],
  )

  const patchLastAssistant = useCallback(
    (sessionId: string, patch: (msg: Message) => Message) => {
      updateMessages(sessionId, (prev) => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last && last.role === 'assistant') next[next.length - 1] = patch(last)
        return next
      })
    },
    [updateMessages],
  )

  /**
   * 压缩完成后更新界面：被归档的消息打上 compacted 标记（界面照常显示，只是不再发模型），
   * 并把「压缩完成」的那对消息（compact_context 工具调用 + 结果）插到边界处。
   */
  const markCompacted = useCallback(
    (
      sessionId: string,
      result: { summary: Message; display: Message[]; compactedIds: string[] },
    ) => {
      const ids = new Set(result.compactedIds)
      updateMessages(sessionId, (prev) => {
        const next = prev.map((message) =>
          ids.has(message.id) ? { ...message, compacted: true } : message,
        )
        // 插到「还没归档、也不是仅展示」的第一条之前（多次压缩时保持在正确的时间位置）
        const firstRecent = next.findIndex(
          (message) => !message.compacted && !message.uiOnly,
        )
        // 摘要消息是 hidden 的（界面不显示），但必须留在会话里，后续请求才算得上
        next.splice(
          firstRecent === -1 ? next.length : firstRecent,
          0,
          result.summary,
          ...result.display,
        )
        return next
      })
    },
    [updateMessages],
  )

  const accumulateUsage = useCallback(
    (sessionId: string, chunk: Usage) => {
      patchRuntime(sessionId, (prev) => ({
        usage: {
          requests: prev.usage.requests + (chunk.promptTokens ? 1 : 0),
          promptTokens: prev.usage.promptTokens + (chunk.promptTokens ?? 0),
          completionTokens: prev.usage.completionTokens + (chunk.completionTokens ?? 0),
          cachedTokens: prev.usage.cachedTokens + (chunk.cachedTokens ?? 0),
          cacheWriteTokens: prev.usage.cacheWriteTokens + (chunk.cacheWriteTokens ?? 0),
        },
      }))
    },
    [patchRuntime],
  )

  /** 真正执行一轮对话（含工具循环）；所有状态都写进它自己的会话 */
  const run = useCallback(
    async (sessionId: string, text: string, attachments: Attachment[]) => {
      const currentBackend = backendRef.current
      if (!currentBackend) return
      const currentSettings = settingsRef.current
      const target = toLlmTarget(currentSettings)
      if (!target) {
        patchRuntime(sessionId, {
          notice: t('请先在设置里添加提供商并选择模型', 'Add a provider and pick a model in Settings first', '請先在設定裡新增供應商並選擇模型'),
        })
        return
      }

      // 图片先落到 <项目>/.rbcode/images/（会话文件里只留引用），内存里仍带 data URL
      const readyAttachments = await prepareAttachments(currentBackend, attachments)
      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        content: text,
        createdAt: Date.now(),
        ...(readyAttachments.length > 0 ? { attachments: readyAttachments } : {}),
      }
      // 注意：这里要自己拼出最新的历史。runtimesRef 还是上一次渲染的快照，
      // 直接用它会漏掉刚追加的这条用户消息。
      const previous = (runtimesRef.current.get(sessionId) ?? EMPTY_RUNTIME).messages
      const uiHistory = [...previous, userMessage]
      updateMessages(sessionId, () => uiHistory)

      // 发给模型的历史：压缩归档的（compacted）和只在界面上出现的（uiOnly）都不算
      let history = uiHistory.filter((message) => !message.compacted && !message.uiOnly)

      patchRuntime(sessionId, (prev) => ({
        running: true,
        rounds: 0,
        startedAt: prev.startedAt ?? Date.now(),
      }))

      // 历史里若有「tool_calls 缺少 tool 响应」或空 assistant，接口会直接 400
      const repaired = repairToolMessages(history)
      if (historyChanged(history, repaired)) {
        // 修复只动发给模型的那部分；界面上归档的 / 仅展示的消息要原样保留
        const preserved = uiHistory.filter((message) => message.compacted || message.uiOnly)
        updateMessages(sessionId, () => [...preserved, ...repaired])
        patchRuntime(sessionId, {
          notice: t(
            '上一次的改动没有正常收尾，已经整理好继续',
            'The previous change did not finish cleanly — everything was tidied up and the run continues',
            '上一次的改動沒有正常收尾，已經整理好繼續',
          ),
        })
        history = repaired
      }

      const controller = new AbortController()
      patchRuntime(sessionId, { abort: controller })

      // MCP：只读一份工具清单缓存（`start: false`）—— 不启动任何进程、不下载任何东西。
      // 服务器真正被拉起来、以及下载浏览器内核，都推迟到模型**调用**那件工具的那一刻。
      if (currentBackend.mcpList && mcpRef.current.root !== currentBackend.rootLabel) {
        mcpRef.current = await loadMcpTools(
          currentBackend,
          currentSettings,
          currentBackend.rootLabel,
          { start: false },
        )
      }

      const ctx: ToolContext = {
        backend: currentBackend,
        sessionId,
        // 计划清单按会话存
        getTodos: () => (runtimesRef.current.get(sessionId) ?? EMPTY_RUNTIME).todos,
        setTodos: (next) => {
          patchRuntime(sessionId, { todos: next })
          callbacksRef.current.onTodos?.(next)
        },
        askUser,
        recordUndo: (record) => pushUndo(currentBackend, record),
        // 子 agent 需要：当前设置、模型连接，以及把审批冒泡回主界面
        getSettings: () => settingsRef.current,
        getTarget: () => toLlmTarget(settingsRef.current),
        requestApproval,
      }

      // 项目记忆跟着工作目录走：目录变了就重新读一次，
      // 否则切到新项目后还在用上一个项目的 AGENTS.md
      const memoryKey = `${currentBackend.kind}:${currentBackend.rootLabel}`
      if (memoryRef.current?.key !== memoryKey) {
        memoryRef.current = { key: memoryKey, text: await loadMemory(currentBackend) }
      }

      /**
       * 达到阈值就压缩。调用点在 agent 循环里、每轮工具全部执行完之后，
       * 所以不会打断正在跑的工具；压缩后的新历史直接替换本地数组继续用。
       */
      const maybeCompact = async (modelMessages: Message[]): Promise<Message[] | null> => {
        const latest = settingsRef.current
        if (
          !shouldCompact(
            modelMessages,
            latest.contextWindow,
            latest.compactThreshold,
            latest.compactKeepRecent ?? 8,
          )
        ) {
          return null
        }
        const compactTarget = toLlmTarget(latest)
        if (!compactTarget) return null
        patchRuntime(sessionId, { compacting: true })
        try {
          const result = await compactMessages(
            compactTarget,
            modelMessages,
            controller.signal,
            latest.compactKeepRecent ?? 8,
          )
          if (!result) return null
          markCompacted(sessionId, result)
          return result.model
        } catch {
          // 压缩失败（网络 / 中止）就照常继续，别把这一轮拖死
          return null
        } finally {
          patchRuntime(sessionId, { compacting: false })
        }
      }

      const basePrompt = currentSettings.systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT
      const planHint = planModeRef.current ? PLAN_MODE_PROMPT : ''
      const envHint = !currentBackend.capabilities.shell
        ? ENV_NO_SHELL
        : currentBackend.platform === 'android'
          ? ENV_ANDROID_SHELL
          : ENV_LOCAL_SHELL
      const skills = currentSettings.skills ?? []
      const skillsHint =
        skills.length > 0
          ? `\n\n# Skills\nYou can load a skill with the skill tool when the task matches one of these. Available skills:\n${skills
              .map((skill) => `- ${skill.name}: ${skill.description || '(no description)'}`)
              .join('\n')}`
          : ''
      const system = `${basePrompt}${envHint}${planHint}${skillsHint}${memoryRef.current?.text ?? ''}`

      let failed = false
      /** 这一轮是不是因为「模型重复输出」被自动停止的（用于在消息流里留一条停止原因） */
      let repeatStop: { unit: string; count: number } | null = null
      try {
        await runAgent({
          target,
          system,
          history,
          ctx,
          planMode: planModeRef.current,
          permission: currentSettings.permission,
          // 每次判断审批时实时读一次：运行中切换权限档位立即生效
          getPermission: () => settingsRef.current.permission,
          maxIterations: currentSettings.maxIterations,
          // 重复内容检测：模型在同一轮里连续重复同一段内容 → 自动停止（范围 / 阈值可调）
          repetition: currentSettings.repeatDetect
            ? {
                scope: currentSettings.repeatScope,
                minUnit: currentSettings.repeatMinUnit,
                threshold: currentSettings.repeatThreshold,
              }
            : null,
          signal: controller.signal,
          // MCP 动态工具：计划模式下只给只读的（readOnlyHint=true）
          extraTools: mcpRef.current.entries
            .filter((entry) => !planModeRef.current || entry.readOnly)
            .map((entry) => entry.schema),
          extraDangerous: mcpRef.current.entries
            .filter((entry) => !entry.readOnly)
            .map((entry) => entry.name),
          callExtraTool: async (name, args) => {
            const entry = mcpRef.current.entries.find((item) => item.name === name)
            if (!entry) return { content: `Unknown tool: ${name}`, isError: true }
            return runMcpTool(backendRef.current, mcpRef.current.root, entry, args)
          },
          requestApproval,
          maybeCompact,
          takeUrgent: () => {
            const current = runtimesRef.current.get(sessionId) ?? EMPTY_RUNTIME
            const [next, ...rest] = current.urgent
            if (!next) return null
            // 同步把 ref 也推进到「已消费」：agent 可能紧接着再问一次，而这时
            // React 还没重渲染 —— 只看 patchRuntime 会把同一条插入取两次。
            runtimesRef.current = new Map(runtimesRef.current).set(sessionId, {
              ...current,
              urgent: rest,
            })
            patchRuntime(sessionId, { urgent: rest })
            return { text: next.text, attachments: next.attachments }
          },
          onEvent: (evt) => {
            switch (evt.type) {
              case 'iteration':
                patchRuntime(sessionId, { rounds: evt.index + 1 })
                break
              case 'assistant_start':
                // 新一轮生成开始：速度计量清空重算
                meterFor(sessionId).reset()
                updateMessages(sessionId, (prev) => [
                  ...prev,
                  { id: evt.messageId, role: 'assistant', content: '', createdAt: Date.now() },
                ])
                break
              case 'text':
                // 用字符数估 token（和 app 自己的 estimateTokens 同一套 2.5 字符/token 口径）
                meterFor(sessionId).add(evt.text.length / 2.5)
                patchLastAssistant(sessionId, (msg) => ({ ...msg, content: msg.content + evt.text }))
                // 有输出就说明连上了，把「重试中」的提示收掉
                patchRuntime(sessionId, { notice: null })
                break
              case 'reasoning':
                meterFor(sessionId).add(evt.text.length / 2.5)
                patchLastAssistant(sessionId, (msg) => ({
                  ...msg,
                  reasoning: (msg.reasoning ?? '') + evt.text,
                }))
                break
              case 'tool_progress':
                patchRuntime(sessionId, { toolDraft: { name: evt.name, argsSoFar: evt.argsSoFar } })
                break
              case 'tools_start':
                patchRuntime(sessionId, { toolDraft: null })
                break
              case 'usage':
                accumulateUsage(sessionId, evt.usage)
                break
              case 'retry':
                // 连不上模型 / 服务端暂时不可用：提示正在重试，不打断整轮
                patchRuntime(sessionId, {
                  notice: t(
                    `连接不上模型，${Math.round(evt.delayMs / 1000)} 秒后重试（第 ${evt.attempt}/${evt.max} 次）…`,
                    `Cannot reach the model — retrying in ${Math.round(evt.delayMs / 1000)}s (attempt ${evt.attempt}/${evt.max})…`,
                    `連不上模型，${Math.round(evt.delayMs / 1000)} 秒後重試（第 ${evt.attempt}/${evt.max} 次）…`,
                  ),
                })
                break
              case 'assistant_end':
                updateMessages(sessionId, (prev) => {
                  const next = [...prev]
                  const idx = next.findIndex((m) => m.id === evt.message.id)
                  if (idx !== -1) next[idx] = evt.message
                  return next
                })
                // 重复检测停止：在消息流里补一条「停止原因」（只在界面显示，不回填给模型）
                if (repeatStop) {
                  const reason = repeatStop
                  repeatStop = null
                  updateMessages(sessionId, (prev) => [
                    ...prev,
                    {
                      id: crypto.randomUUID(),
                      role: 'assistant',
                      content: t(
                        `已自动停止：检测到模型重复输出 —— 同一段内容「${reason.unit}」连续出现了 ${reason.count} 次。\n这一轮的回答已裁到重复开始之前；可以直接再发一条让它接着做，或在设置 → 通用 → 重复内容检测里调整范围 / 阈值。`,
                        `Stopped automatically: the model repeated itself — “${reason.unit}” appeared ${reason.count} times in a row.\nThe reply was trimmed back to where the repetition started. Send another message to continue, or tune the repetition guard in Settings → General.`,
                        `已自動停止：偵測到模型重複輸出 —— 同一段內容「${reason.unit}」連續出現 ${reason.count} 次。\n這一輪的回答已裁到重複開始之前；可以直接再傳一條讓它接著做，或在設定 → 一般 → 重複內容偵測裡調整範圍 / 門檻。`,
                      ),
                      createdAt: Date.now(),
                      error: '1',
                      uiOnly: true,
                    },
                  ])
                }
                break
              case 'tool_result':
              case 'urgent_inserted':
              case 'images_attached':
                updateMessages(sessionId, (prev) => [...prev, evt.message])
                break
              case 'iteration_limit':
                patchRuntime(sessionId, {
                  notice: t(
                    `这一轮已经连续做了 ${evt.max} 步，可能还没做完 —— 再发一条消息就会接着做；想让它一次做完，可以在设置里把「单轮最大工具调用次数」调大，或填 0 表示不限。`,
                    `This turn already ran ${evt.max} steps and may be unfinished. Send another message to continue, or raise "Max tool calls per turn" in Settings (0 = unlimited).`,
                    `這一輪已經連續做了 ${evt.max} 步，可能還沒做完 —— 再傳一條訊息就會接著做；想讓它一次做完，可以在設定把「單輪最大工具呼叫次數」調大，或填 0 表示不限。`,
                  ),
                })
                break
              case 'repetition':
                repeatStop = { unit: evt.unit, count: evt.count }
                patchRuntime(sessionId, {
                  notice: t(
                    `检测到模型重复输出（同一段内容连续出现 ${evt.count} 次），已自动停止这一轮。`,
                    `The model started repeating itself (same passage ${evt.count} times in a row) — this turn was stopped.`,
                    `偵測到模型重複輸出（同一段內容連續出現 ${evt.count} 次），已自動停止這一輪。`,
                  ),
                })
                break
              case 'truncated':
                patchRuntime(sessionId, {
                  notice: t(
                    '回答写到长度上限就停了，可能还没说完 —— 再发一条消息就会接着写，或者在设置里把「最大输出 token」调大。',
                    'The reply hit the length limit and may be cut off — send another message to continue, or raise the max output tokens in Settings.',
                    '回答寫到長度上限就停了，可能還沒說完 —— 再傳一條訊息就會接著寫，或在設定把「最大輸出 token」調大。',
                  ),
                })
                break
              case 'error':
                failed = true
                updateMessages(sessionId, (prev) => [
                  ...prev,
                  {
                    id: crypto.randomUUID(),
                    role: 'assistant',
                    content: evt.message,
                    createdAt: Date.now(),
                    error: '1',
                  },
                ])
                break
              case 'done':
                patchRuntime(sessionId, { toolDraft: null })
                updateMessages(sessionId, (prev) => {
                  const last = prev[prev.length - 1]
                  const isEmptyAssistant =
                    last &&
                    last.role === 'assistant' &&
                    last.content.trim() === '' &&
                    (last.toolCalls?.length ?? 0) === 0
                  return isEmptyAssistant ? prev.slice(0, -1) : prev
                })
                break
              default:
                break
            }
          },
        })
      } finally {
        const aborted = controller.signal.aborted
        patchRuntime(sessionId, { running: false, abort: null, toolDraft: null })
        callbacksRef.current.onRequestDone?.()
        // 被用户停止 / 组件卸载中止时不提示；正常结束或报错才响
        if (!aborted) callbacksRef.current.onTaskEnd?.(sessionId, failed ? 'error' : 'done')
      }
    },
    [
      accumulateUsage,
      askUser,
      markCompacted,
      patchLastAssistant,
      patchRuntime,
      requestApproval,
      updateMessages,
    ],
  )

  const runRef = useRef(run)
  runRef.current = run
  const runtimesRef = useRef(runtimes)
  runtimesRef.current = runtimes

  /** 发送；发给指定会话，正在生成则进入该会话的队列 */
  const send = useCallback((sessionId: string, text: string, attachments: Attachment[] = []) => {
    if (!text.trim() && attachments.length === 0) return
    const current = runtimesRef.current.get(sessionId) ?? EMPTY_RUNTIME
    if (current.running) {
      patchRuntime(sessionId, {
        queue: [...current.queue, { id: crypto.randomUUID(), text, attachments }],
      })
      return
    }

    void (async () => {
      await runRef.current(sessionId, text, attachments)
      // 这一轮结束后，把它自己的队列按顺序发出去
      while (true) {
        const latest = runtimesRef.current.get(sessionId) ?? EMPTY_RUNTIME
        const [next, ...rest] = latest.queue
        if (!next) break
        patchRuntime(sessionId, { queue: rest })
        await runRef.current(sessionId, next.text, next.attachments)
      }
    })()
  }, [patchRuntime])

  /** 把队列里的一条提到最前：当前工具一跑完就交给模型 */
  const insertNow = useCallback(
    (sessionId: string, id: string) => {
      const current = runtimesRef.current.get(sessionId) ?? EMPTY_RUNTIME
      const item = current.queue.find((queued) => queued.id === id)
      if (!item) return
      patchRuntime(sessionId, {
        queue: current.queue.filter((queued) => queued.id !== id),
        ...(current.running ? { urgent: [...current.urgent, item] } : {}),
      })
      if (!current.running) void runRef.current(sessionId, item.text, item.attachments)
    },
    [patchRuntime],
  )

  /** 从「已插入、等本轮结束」里撤掉一条 */
  const removeUrgent = useCallback(
    (sessionId: string, id: string) => {
      const current = runtimesRef.current.get(sessionId) ?? EMPTY_RUNTIME
      patchRuntime(sessionId, { urgent: current.urgent.filter((item) => item.id !== id) })
    },
    [patchRuntime],
  )

  /**
   * 运行中把输入框里的内容直接插进当前会话（不等本轮结束）。
   * 走和「立即插入」同一条通道（urgent），当前工具一跑完就交给模型；
   * 没在运行时就当普通发送。
   */
  const insert = useCallback(
    (sessionId: string, text: string, attachments: Attachment[] = []) => {
      if (!text.trim() && attachments.length === 0) return
      const current = runtimesRef.current.get(sessionId) ?? EMPTY_RUNTIME
      if (current.running) {
        patchRuntime(sessionId, {
          urgent: [...current.urgent, { id: crypto.randomUUID(), text, attachments }],
        })
      } else {
        void runRef.current(sessionId, text, attachments)
      }
    },
    [patchRuntime],
  )

  const removeQueued = useCallback(
    (sessionId: string, id: string) => {
      const current = runtimesRef.current.get(sessionId) ?? EMPTY_RUNTIME
      patchRuntime(sessionId, { queue: current.queue.filter((item) => item.id !== id) })
    },
    [patchRuntime],
  )

  /** 只停指定会话 */
  const stop = useCallback(
    (sessionId: string) => {
      const current = runtimesRef.current.get(sessionId) ?? EMPTY_RUNTIME
      current.abort?.abort()
      patchRuntime(sessionId, { abort: null, running: false, toolDraft: null, queue: [], urgent: [] })
    },
    [patchRuntime],
  )

  const undo = useCallback(
    async (sessionId: string, undoId: string) => {
      const currentBackend = backendRef.current
      if (!currentBackend) return
      try {
        const result = await applyUndo(currentBackend, undoId)
        const current = runtimesRef.current.get(sessionId) ?? EMPTY_RUNTIME
        patchRuntime(sessionId, { undone: [...current.undone, undoId], notice: result })
      } catch (err) {
        patchRuntime(sessionId, {
          notice: t(
            `撤销失败：${(err as Error).message}`,
            `Undo failed: ${(err as Error).message}`,
            `復原失敗：${(err as Error).message}`,
          ),
        })
      }
    },
    [patchRuntime],
  )

  /** 撤销到某条用户消息之前：可以只撤对话、只撤文件、或两者一起撤 */
  const revert = useCallback(
    async (
      sessionId: string,
      messageId: string,
      scope: 'conversation' | 'files' | 'both',
    ) => {
      const currentBackend = backendRef.current
      const runtime = runtimesRef.current.get(sessionId) ?? EMPTY_RUNTIME
      const messages = runtime.messages
      const index = messages.findIndex((message) => message.id === messageId)
      if (index === -1) return

      const notes: string[] = []

      if (scope === 'files' || scope === 'both') {
        const ids = undoIdsFromMessage(messages, messageId).filter(
          (id) => !runtime.undone.includes(id),
        )
        let done = 0
        if (currentBackend) {
          // 从最近一次改动往回退，保证同一个文件多轮改动时回到最早的那份内容
          for (const id of [...ids].reverse()) {
            try {
              await applyUndo(currentBackend, id)
              done += 1
            } catch {
              // 某一条失败不阻塞其余
            }
          }
        }
        if (done > 0) {
          patchRuntime(sessionId, (prev) => ({ undone: [...prev.undone, ...ids] }))
          notes.push(
            t(
              `已回退 ${done} 处文件改动`,
              `Reverted ${done} file change(s)`,
              `已回復 ${done} 處檔案改動`,
            ),
          )
        } else {
          notes.push(
            t('这一轮没有可回退的文件改动', 'No file changes to revert in this turn', '這一輪沒有可回復的檔案改動'),
          )
        }
      }

      if (scope === 'conversation' || scope === 'both') {
        const removed = messages.slice(index)
        if (currentBackend && removed.length > 0) {
          await archiveMessages(currentBackend, sessionId, removed)
        }
        updateMessages(sessionId, (prev) => prev.slice(0, index))
        notes.push(
          t(
            `已撤销之后的 ${removed.length} 条消息（回收站里留有副本）`,
            `Removed the ${removed.length} message(s) after it (a copy is in the recycle bin)`,
            `已撤銷之後的 ${removed.length} 則訊息（回收桶留有副本）`,
          ),
        )
      }

      patchRuntime(sessionId, { notice: notes.join('；') })
    },
    [patchRuntime, updateMessages],
  )

  /** 立即压缩指定会话的上下文（/compact 指令用） */
  const compactNow = useCallback(
    async (sessionId: string) => {
      const currentSettings = settingsRef.current
      const target = toLlmTarget(currentSettings)
      const current = runtimesRef.current.get(sessionId)
      if (!target) {
        patchRuntime(sessionId, { notice: t('请先在设置里选择模型', 'Pick a model in Settings first', '請先在設定裡選擇模型') })
        return
      }
      if (!current || current.messages.length === 0) {
        patchRuntime(sessionId, {
          notice: t(
            '这个会话还没有内容，先聊几句再压缩',
            'This session is empty — chat a bit before compacting',
            '這個工作階段還沒有內容，先聊幾句再壓縮',
          ),
        })
        return
      }
      if (current.running) {
        patchRuntime(sessionId, {
          notice: t(
            '正在生成中，等这一轮结束再压缩',
            'Generating right now — compact after this turn',
            '正在生成中，等這一輪結束再壓縮',
          ),
        })
        return
      }
      patchRuntime(sessionId, { compacting: true })
      try {
        const result = await compactMessages(
          target,
          current.messages.filter((message) => !message.compacted && !message.uiOnly),
          undefined,
          currentSettings.compactKeepRecent ?? 8,
        )
        if (!result) {
          patchRuntime(sessionId, {
            notice: t(
              '内容还不多，暂时不用压缩',
              'Not enough history yet — nothing to compact',
              '內容還不多，暫時不用壓縮',
            ),
          })
          return
        }
        markCompacted(sessionId, result)
        patchRuntime(sessionId, { notice: t('已压缩上下文', 'Context compacted', '已壓縮上下文') })
      } catch (err) {
        patchRuntime(sessionId, {
          notice: t(
            `压缩失败：${(err as Error).message}`,
            `Compaction failed: ${(err as Error).message}`,
            `壓縮失敗：${(err as Error).message}`,
          ),
        })
      } finally {
        patchRuntime(sessionId, { compacting: false })
      }
    },
    [markCompacted, patchRuntime],
  )

  /** 载入一个已有会话的内容（旧版的压缩数据在这里补成新的工具卡片形态） */
  const loadMessages = useCallback(
    (sessionId: string, next: Message[], usage: UsageStats = EMPTY_USAGE, todos: Todo[] = []) => {
      patchRuntime(sessionId, {
        messages: migrateCompaction(next),
        undone: [],
        usage,
        todos,
        startedAt: null,
        toolDraft: null,
      })
    },
    [patchRuntime],
  )

  /**
   * 分叉：把一段消息直接写进一个新会话。走 updateMessages 是为了触发落盘，
   * 这样新会话立刻出现在侧栏里。
   */
  const seedSession = useCallback(
    (sessionId: string, messages: Message[]) => {
      updateMessages(sessionId, () => messages)
    },
    [updateMessages],
  )

  /** 清空指定会话（组件卸载式的清空，不影响别的会话） */
  const clear = useCallback(
    (sessionId: string) => {
      const current = runtimesRef.current.get(sessionId)
      current?.abort?.abort()
      patchRuntime(sessionId, {
        messages: [],
        running: false,
        rounds: 0,
        compacting: false,
        toolDraft: null,
        undone: [],
        queue: [],
        urgent: [],
        usage: EMPTY_USAGE,
        startedAt: null,
        abort: null,
        notice: null,
        todos: [],
      })
      callbacksRef.current.onSessionMessages?.(sessionId, [], EMPTY_USAGE, [])
    },
    [patchRuntime],
  )

  /** 丢掉某个会话的运行时（会话被删除时） */
  const drop = useCallback((sessionId: string) => {
    setRuntimes((prev) => {
      const next = new Map(prev)
      next.get(sessionId)?.abort?.abort()
      next.delete(sessionId)
      return next
    })
  }, [])

  // 组件卸载时中止所有会话
  useEffect(() => {
    return () => {
      for (const item of runtimesRef.current.values()) item.abort?.abort()
    }
  }, [])

  return {
    // 当前会话的视图
    messages: runtime.messages,
    running: runtime.running,
    rounds: runtime.rounds,
    compacting: runtime.compacting,
    toolDraft: runtime.toolDraft,
    undone: runtime.undone,
    queue: runtime.queue,
    urgent: runtime.urgent,
    usage: runtime.usage,
    startedAt: runtime.startedAt,
    /** 当前速度（tok/s）：最近几秒的滑动窗口口径，空闲会衰减到 0 */
    speed: () => (activeSessionId ? meterFor(activeSessionId).rate() : 0),
    notice: runtime.notice,
    runningSessionIds,

    todos: runtime.todos,
    setNotice: (text: string | null) => {
      if (activeSessionId) patchRuntime(activeSessionId, { notice: text })
    },
    clearNotice: () => {
      if (activeSessionId) patchRuntime(activeSessionId, { notice: null })
    },

    send,
    stop,
    undo,
    revert,
    compactNow,
    clear,
    drop,
    loadMessages,
    seedSession,
    removeQueued,
    removeUrgent,
    insertNow,
    insert,
  }
}
