import { saveImageFile } from './attachments.ts'
import { chatStream } from './llm.ts'
import type { ToolSchema, Usage } from './llm.ts'
import { isDangerousCommand, needsApproval } from './permissions.ts'
import {
  RepetitionWatcher,
  describeUnit,
  type RepeatChannel,
  type RepetitionHit,
  type RepetitionOptions,
} from './repetition.ts'
import { getTool, runTool, toolSchemas } from './tools/index.ts'
import type { ApprovalRequest, ToolContext, ToolResult } from './tools/types.ts'
import type { Attachment, LlmTarget, Message, PermissionMode, ToolCall } from './types.ts'

export interface AgentRunOptions {
  target: LlmTarget
  system: string
  /** 已有会话（含本轮用户消息） */
  history: Message[]
  ctx: ToolContext
  /** 计划模式：只允许只读工具 */
  planMode: boolean
  /** 权限档位的初始值（没给 getPermission 时用它） */
  permission: PermissionMode
  /** 每次判断要不要审批时实时读一次；给了它，运行中切换档位就能立即生效 */
  getPermission?: () => PermissionMode
  /** 单轮最多工具调用迭代次数；0 = 不限 */
  maxIterations: number
  /** 重复内容检测（设置里可调范围 / 阈值）；不传就不检测 */
  repetition?: RepetitionOptions | null
  signal: AbortSignal
  /** 只把这些工具交给模型（子 agent 用来收窄能力）；不传则不限制 */
  toolNames?: string[]
  /**
   * 动态工具（MCP）：调用方已按计划模式过滤好，直接并进工具表。
   * 给了 toolNames（子 agent）时忽略 —— MCP 不泄漏给子 agent。
   */
  extraTools?: ToolSchema[]
  /** 动态工具里哪些按「危险」处理（非只读的 MCP 工具）→ 自动档下也会先问一次 */
  extraDangerous?: string[]
  /** 调用动态工具（名字命中 extraTools 时走这里） */
  callExtraTool?: (name: string, args: Record<string, unknown>) => Promise<ToolResult>
  /** 请求一次操作批准；返回 false 表示被拒绝或超时 */
  requestApproval: (request: ApprovalRequest) => Promise<boolean>
  /** 取出用户「立即插入」的消息；每执行完一个工具都会问一次 */
  takeUrgent?: () => { text: string; attachments: Attachment[] } | null
  /**
   * 每次「模型 → 工具」之后、下一次请求模型之前调用一次：达到阈值就在这里压缩。
   * 因为调用点在一轮工具全部跑完之后，所以永远不会打断正在执行的工具；
   * 返回新的模型历史（摘要 + 近期原文），返回 null 表示这次不用压缩。
   */
  maybeCompact?: (messages: Message[]) => Promise<Message[] | null>
  onEvent: (evt: AgentEvent) => void
}

export type AgentEvent =
  | { type: 'iteration'; index: number }
  | { type: 'assistant_start'; messageId: string }
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_progress'; name: string; argsSoFar: string }
  | { type: 'assistant_end'; message: Message }
  | { type: 'tools_start'; calls: ToolCall[] }
  | { type: 'tool_start'; call: ToolCall }
  | { type: 'tool_result'; call: ToolCall; message: Message; isError: boolean }
  | { type: 'usage'; usage: Usage }
  /** 用户中途插入的消息已进入上下文 */
  | { type: 'urgent_inserted'; message: Message }
  /** 工具产出的图片：已作为一条带附件的新消息交给模型 */
  | { type: 'images_attached'; message: Message }
  /** 本次模型请求正在重试（连不上 / 服务端暂时不可用） */
  | { type: 'retry'; attempt: number; max: number; delayMs: number; error: string }
  | { type: 'error'; message: string }
  /** 单轮工具调用次数跑满了（任务可能没做完） */
  | { type: 'iteration_limit'; max: number }
  /** 检测到模型在重复输出同一段内容，已自动停止这一轮 */
  | { type: 'repetition'; channel: RepeatChannel; unit: string; count: number }
  /** 模型输出被 max_tokens 截断了 */
  | { type: 'truncated' }
  | { type: 'done' }

/** 驱动一次完整的「模型 → 工具 → 模型」循环，直到模型不再请求工具 */
export async function runAgent(opts: AgentRunOptions): Promise<void> {
  const {
    target,
    system,
    ctx,
    planMode,
    permission,
    maxIterations,
    signal,
    toolNames,
    extraTools,
    extraDangerous,
    callExtraTool,
    requestApproval,
    takeUrgent,
    maybeCompact,
    onEvent,
  } = opts
  /** 当下这一档权限：每判断一次读一次，所以运行中切档位是立即生效的 */
  const readPermission = () => opts.getPermission?.() ?? permission
  const messages: Message[] = [...opts.history]

  /** 单轮上限：0（或非法值）= 不限 */
  const iterationLimit =
    Number.isFinite(maxIterations) && maxIterations > 0 ? Math.floor(maxIterations) : Infinity

  /**
   * 这一轮为什么停下来的：
   * - `limit`      工具调用次数跑满
   * - `aborted`    用户点了停止
   * - `repetition` 检测到模型在重复输出（已自动停止）
   */
  let stopReason: 'limit' | 'aborted' | 'repetition' | null = null
  /** 重复检测命中的信息（用来裁掉已经吐出来的重复内容） */
  let repeatHit: { channel: RepeatChannel; hit: RepetitionHit } | null = null
  /**
   * 内部中止控制器：既能被用户停止（外部 signal）打断，
   * 也能在检测到重复输出时由我们自己打断这次请求。
   */
  const inner = new AbortController()
  const repeatWatcher = opts.repetition
    ? new RepetitionWatcher(opts.repetition)
    : null

  /** 检测到重复：通知界面 → 记下位置 → 中止这次请求 */
  const stopForRepetition = (channel: RepeatChannel, hit: RepetitionHit) => {
    if (repeatHit) return
    repeatHit = { channel, hit }
    stopReason = 'repetition'
    onEvent({
      type: 'repetition',
      channel,
      unit: describeUnit(hit.unit),
      count: hit.count,
    })
    inner.abort()
  }

  /**
   * 读一遍当前状态。闭包里赋的值在 TS 的流分析里会被收窄成 never（它不认跨函数的赋值），
   * 所以统一从这里按声明类型取一次。
   */
  const readRunState = (): {
    stop: 'limit' | 'aborted' | 'repetition' | null
    repeat: { channel: RepeatChannel; hit: RepetitionHit } | null
  } => ({ stop: stopReason, repeat: repeatHit })

  /** 把一次「插入」包成 user 消息（和普通用户消息一致，只是标了 inserted） */
  const insertedMessage = (urgent: { text: string; attachments: Attachment[] }): Message => ({
    id: crypto.randomUUID(),
    role: 'user',
    content: urgent.text,
    createdAt: Date.now(),
    inserted: true,
    ...(urgent.attachments.length > 0 ? { attachments: urgent.attachments } : {}),
  })

  // 动态工具（MCP）：只有主 agent 会拿到；子 agent 传了 toolNames 就不并进来
  const extra = toolNames ? [] : (extraTools ?? [])
  const extraNames = new Set(extra.map((tool) => tool.name))
  const dangerousExtra = new Set(extraDangerous ?? [])
  const schemas = [...toolSchemas({ planMode, names: toolNames }), ...extra]

  for (let iteration = 0; ; iteration++) {
    if (iteration >= iterationLimit) {
      // 工具调用次数跑满（0 = 不限时永远不会到这里）
      stopReason = 'limit'
      break
    }
    if (signal.aborted) {
      stopReason = 'aborted'
      break
    }
    onEvent({ type: 'iteration', index: iteration })

    // 压缩时机：上一轮工具全部执行完之后、这一次请求模型之前。
    // 所以永远不会打断正在跑的工具；压缩后的新历史替换掉本地数组继续用。
    if (maybeCompact) {
      const compacted = await maybeCompact(messages)
      if (compacted) messages.splice(0, messages.length, ...compacted)
    }

    const assistantId = crypto.randomUUID()
    onEvent({ type: 'assistant_start', messageId: assistantId })

    let content = ''
    let reasoning = ''
    let toolCalls: ToolCall[] = []

    // 按 tool_call 序号缓存「提前发出的审批」。模型一开始生成参数就问，
    // 用户不必等它写完上百行代码才看到确认框。
    const preApprovals = new Map<number, Promise<boolean>>()

    // 用户点停止 → 转发到 inner，把这次请求掐掉
    const forwardAbort = () => inner.abort()
    if (signal.aborted) inner.abort()
    signal.addEventListener('abort', forwardAbort, { once: true })
    try {
      await chatStream({
        target,
        system,
        messages,
        tools: schemas,
        signal: inner.signal,
        onChunk: (chunk) => {
          if (chunk.type === 'text') {
            content += chunk.text
            onEvent({ type: 'text', text: chunk.text })
            // 重复内容检测：盯着累积的正文
            if (!repeatHit && repeatWatcher) {
              const hit = repeatWatcher.feed('text', content)
              if (hit) stopForRepetition('text', hit)
            }
          } else if (chunk.type === 'reasoning') {
            reasoning += chunk.text
            onEvent({ type: 'reasoning', text: chunk.text })
            if (!repeatHit && repeatWatcher) {
              const hit = repeatWatcher.feed('reasoning', reasoning)
              if (hit) stopForRepetition('reasoning', hit)
            }
          } else if (chunk.type === 'tool_progress') {
            if (!chunk.name) return
            onEvent({ type: 'tool_progress', name: chunk.name, argsSoFar: chunk.argsSoFar })
            // 工具参数也可能卡带（模型把同一段地址 / 内容反复往外吐）
            if (!repeatHit && repeatWatcher) {
              const hit = repeatWatcher.feed('tool', chunk.argsSoFar)
              if (hit) stopForRepetition('tool', hit)
            }

            if (!preApprovals.has(chunk.index)) {
              const def = getTool(chunk.name)
              const isExtra = extraNames.has(chunk.name)
              const dangerous =
                isDangerousToolCall(chunk.name, chunk.argsSoFar) ||
                dangerousExtra.has(chunk.name)
              const allowedInPlan = !planMode || def?.readOnly === true || isExtra
              if ((def || isExtra) && allowedInPlan && needsApproval(readPermission(), dangerous)) {
                preApprovals.set(
                  chunk.index,
                  requestApproval({
                    tool: chunk.name,
                    summary: describeCall(chunk.name, dangerous),
                    detail: chunk.argsSoFar.slice(0, 4000),
                    dangerous,
                  }),
                )
              }
            }
          } else if (chunk.type === 'tool_calls') {
            toolCalls = chunk.calls
          } else if (chunk.type === 'retry') {
            onEvent({
              type: 'retry',
              attempt: chunk.attempt,
              max: chunk.max,
              delayMs: chunk.delayMs,
              error: chunk.error,
            })
          } else if (chunk.type === 'truncated') {
            onEvent({ type: 'truncated' })
          } else if (chunk.type === 'usage') {
            onEvent({ type: 'usage', usage: chunk.usage })
          }
        },
      })
    } catch (err) {
      if (readRunState().stop === 'repetition') {
        // 重复检测掐断：不算错误 —— 继续走收尾流程（下面的代码会把重复部分裁掉并收尾）
      } else if ((err as Error).name === 'AbortError' || signal.aborted) {
        // 用户点停止：和以前一样，半截内容不写进历史
        stopReason = 'aborted'
        break
      } else {
        onEvent({ type: 'error', message: (err as Error).message })
        return
      }
    } finally {
      signal.removeEventListener('abort', forwardAbort)
    }

    const { repeat: repeatHitNow } = readRunState()
    if (repeatHitNow) {
      // 重复检测命中：把已经吐出来的重复内容裁掉，工具调用作废（可能是半截参数）
      const at = repeatHitNow.hit.at
      if (repeatHitNow.channel === 'text') content = content.slice(0, at)
      if (repeatHitNow.channel === 'reasoning') reasoning = reasoning.slice(0, at)
      toolCalls = []
    }

    if (signal.aborted && !stopReason) stopReason = 'aborted'

    const assistantMessage: Message = {
      id: assistantId,
      role: 'assistant',
      content,
      reasoning: reasoning || undefined,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      createdAt: Date.now(),
    }

    // 空 assistant（既无文本也无工具调用）会让后续请求被接口拒绝，不入历史
    if (content.trim() !== '' || toolCalls.length > 0) {
      messages.push(assistantMessage)
    }
    onEvent({ type: 'assistant_end', message: assistantMessage })

    // 重复检测已掐断这一轮：不再执行工具，也不继续（半截的工具调用不可信）
    if (readRunState().stop === 'repetition') break

    if (toolCalls.length === 0) {
      // 用户刚插进来的消息还没交给模型：再跑一轮，别把它丢了
      const pendingUrgent = takeUrgent?.()
      if (pendingUrgent) {
        const message = insertedMessage(pendingUrgent)
        messages.push(message)
        onEvent({ type: 'urgent_inserted', message })
        continue
      }
      onEvent({ type: 'done' })
      return
    }

    onEvent({ type: 'tools_start', calls: toolCalls })

    // 本轮工具产出的图片先攒着：等所有 tool 消息都排好队再统一追加一条带图片的 user 消息。
    // （tool 消息必须紧跟 assistant 的 tool_calls，中间插一条 user 会被接口直接拒收）
    const toolImages: { name: string; dataUrl: string; callId: string }[] = []

    for (let index = 0; index < toolCalls.length; index++) {
      const call = toolCalls[index]

      if (signal.aborted) {
        // 用户中止执行：仍然要补上 tool 消息。
        // 否则这条 assistant 的 tool_calls 会缺少响应，下一次请求会被接口直接拒绝。
        const skipped = skippedToolMessage(
          call,
          'The user stopped the run, so this tool was not executed.',
        )
        messages.push(skipped)
        onEvent({ type: 'tool_result', call, message: skipped, isError: true })
        continue
      }

      const def = getTool(call.name)
      // 用实际暴露给模型的列表来判断（计划模式下会砍掉写类工具）。
      // 后端能力差异不在这里拦：像 bash 这种工具自己会返回明确的错误。
      const available = schemas.some((schema) => schema.name === call.name)
      if (!available) {
        const reason = !def
          ? `Unknown tool "${call.name}".`
          : planMode
            ? `Tool "${call.name}" is not available in plan mode. Only read-only tools plus ask_user/todo_write are allowed.`
            : `Tool "${call.name}" is not available.`
        const blocked: Message = {
          id: crypto.randomUUID(),
          role: 'tool',
          content: reason,
          toolCallId: call.id,
          toolName: call.name,
          createdAt: Date.now(),
          error: 'failed',
        }
        messages.push(blocked)
        onEvent({ type: 'tool_result', call, message: blocked, isError: true })
        continue
      }

      // 审批：优先用流式期间就发出去的那个，否则现在补一个
      const dangerous =
        isDangerousToolCall(call.name, JSON.stringify(call.args ?? {})) ||
        dangerousExtra.has(call.name)
      let approved = true
      if (needsApproval(readPermission(), dangerous)) {
        const pendingApproval = preApprovals.get(index)
        approved = pendingApproval
          ? await pendingApproval
          : await requestApproval({
              tool: call.name,
              summary: describeCall(call.name, dangerous),
              detail: JSON.stringify(call.args, null, 2).slice(0, 4000),
              dangerous,
            })
      }

      if (!approved) {
        const rejected: Message = {
          id: crypto.randomUUID(),
          role: 'tool',
          content: `The user did not approve this operation: ${call.name}. If it is really necessary, explain why and try again.`,
          toolCallId: call.id,
          toolName: call.name,
          createdAt: Date.now(),
          error: 'failed',
        }
        messages.push(rejected)
        onEvent({ type: 'tool_result', call, message: rejected, isError: true })
        continue
      }

      onEvent({ type: 'tool_start', call })
      const result =
        callExtraTool && extraNames.has(call.name)
          ? await callExtraTool(call.name, call.args)
          : await runTool(call.name, call.args, ctx)

      const toolMessage: Message = {
        id: crypto.randomUUID(),
        role: 'tool',
        content: result.content,
        toolCallId: call.id,
        toolName: call.name,
        createdAt: Date.now(),
        ...(result.isError ? { error: 'failed' } : {}),
        ...(result.undoId ? { undoId: result.undoId } : {}),
        ...(result.diff ? { diff: result.diff } : {}),
      }
      messages.push(toolMessage)
      onEvent({ type: 'tool_result', call, message: toolMessage, isError: result.isError === true })

      // 工具产出的图片先攒着：本轮工具全部执行完再一起交给模型（见循环之后那段）
      if (result.images && result.images.length > 0) {
        toolImages.push(...result.images.map((image) => ({ ...image, callId: call.id })))
      }

      // 用户可能刚点了「立即插入」：立刻把他的话交给模型，不等本轮跑完
      const urgent = takeUrgent?.()
      if (urgent) {
        // 先给本轮剩下没机会执行的工具补上 tool 消息：assistant 的 tool_calls
        // 必须逐个有响应，否则下一次请求会被接口直接拒收。
        for (let rest = index + 1; rest < toolCalls.length; rest++) {
          const skipped = skippedToolMessage(
            toolCalls[rest],
            'Skipped because the user inserted a message mid-task. Ask again if you still need it.',
          )
          messages.push(skipped)
          onEvent({ type: 'tool_result', call: toolCalls[rest], message: skipped, isError: true })
        }
        const urgentMessage = insertedMessage(urgent)
        messages.push(urgentMessage)
        onEvent({ type: 'urgent_inserted', message: urgentMessage })
        break
      }
    }

    // 本轮所有 tool 消息都排好队了，这才把图片追加成一条 user 消息交给模型
    if (toolImages.length > 0) {
      // 工具产出的图片（截图等）也先落到 .rbcode/images/，会话里只留引用
      const stored = await Promise.all(
        toolImages.map(async (image) => ({
          ...image,
          ...((await saveImageFile(ctx.backend, image.dataUrl)) ?? {}),
        })),
      )
      const imagesMessage: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        content: `[image attached by the ${toolImages.length === 1 ? 'tool' : 'tools'} above]`,
        createdAt: Date.now(),
        attachments: stored.map((image) => ({
          id: crypto.randomUUID(),
          kind: 'image' as const,
          name: image.name,
          dataUrl: image.dataUrl,
          ...(image.storedPath ? { storedPath: image.storedPath, mime: image.mime } : {}),
          toolCallId: image.callId,
        })),
        // 图片只在产出它的工具卡片里展示，不在消息流里单独占一行
        hidden: true,
      }
      messages.push(imagesMessage)
      onEvent({ type: 'images_attached', message: imagesMessage })
    }
  }

  // 只有「工具调用次数跑满」才提示上限（正常结束会在循环里 return，
  // 用户点停止 / 重复检测掐断都不该被说成「达到单轮上限」）。
  if (readRunState().stop === 'limit') {
    onEvent({ type: 'iteration_limit', max: maxIterations })
  }
  onEvent({ type: 'done' })
}

/** 这次调用算不算危险操作：工具自带的标记，或者 bash 里的删除类命令 */
function isDangerousToolCall(name: string, argsText: string): boolean {
  if (getTool(name)?.dangerous === true) return true
  return name === 'bash' && isDangerousCommand(argsText)
}

/** 为没有执行的工具补一条 tool 消息，保持历史对接口合法 */
function skippedToolMessage(call: ToolCall, reason: string): Message {
  return {
    id: crypto.randomUUID(),
    role: 'tool',
    content: reason,
    toolCallId: call.id,
    toolName: call.name,
    createdAt: Date.now(),
    error: 'failed',
  }
}

function describeCall(name: string, dangerous: boolean): string {
  const verbs: Record<string, string> = {
    write_file: 'Write file',
    edit_file: 'Edit file',
    delete_path: 'Delete path',
    bash: dangerous ? 'Run a command that may delete files' : 'Run a command',
  }
  return verbs[name] ?? `Run tool "${name}"`
}
