import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { lastLine, markdownHardBreaks } from '../lib/text.ts'
import { useT } from '../lib/i18n.ts'
import type { Attachment, Message, ToolCall } from '../lib/types.ts'
import { Markdown } from './Markdown.tsx'
import Collapse from './Collapse.tsx'
import { createPortal } from 'react-dom'
import CopyButton from './CopyButton.tsx'
import { getLanguage } from '../lib/i18n.ts'
import { canSpeak, speakText, stopSpeaking, useSpeakingId } from '../lib/speech.ts'
import Tooltip from './Tooltip.tsx'
import ToolCallCard from './ToolCallCard.tsx'
import {
  ChevronRightIcon,
  ArrowDownIcon,
  BranchIcon,
  LightbulbIcon,
  LoaderIcon,
  PencilIcon,
  SpeakIcon,
  SpeakStopIcon,
  UndoIcon,
  XCircleIcon,
} from './icons.tsx'

interface Props {
  messages: Message[]
  running: boolean
  undone: string[]
  /** 模型正在生成的工具参数（草稿） */
  toolDraft: { name: string; argsSoFar: string } | null
  onUndo: (undoId: string) => void
  /** 还没有项目时的提示 */
  emptyHint: string
  /** 思考过程是否默认展开（默认折叠） */
  reasoningExpanded?: boolean
  /** 紧凑过程：把思考与工具调用折叠成 "Used …" 摘要行 */
  compactActivity?: boolean
  /** 结果模式：过程完全不显示，运行时只有一行 Working（可展开看 Used），做完只留最终文字 */
  resultOnly?: boolean
  /** 从这条消息分叉出一个新会话（复制该点之前的上下文） */
  onForkMessage?: (messageId: string) => void
  /** 修改这条（我发的）消息并分叉：新会话 + 把文字填回输入框 */
  onEditMessage?: (message: Message) => void
  /**
   * 撤销到这条（我发的）消息之前。`conversation` = 只撤对话、`files` = 只撤文件改动、
   * `both` = 两者一起。文件回退用的是各轮工具自带的撤销记录。
   */
  onRevertMessage?: (messageId: string, scope: 'conversation' | 'files' | 'both') => void
  /** 朗读设置（设置 → 语音）：开着就在每条回答下显示小喇叭 */
  speech?: { enabled: boolean; rate: number; voiceName: string }
}

/** 距底部多少像素以内算“贴着底” */
const BOTTOM_THRESHOLD = 48

/** 右侧导航：每条的高度 / 行距（决定「超过多少条开始滚动」） */
const NAV_ITEM_HEIGHT = 8
const NAV_ITEM_PITCH = 10
const NAV_VISIBLE_MAX = 20

export default function MessageList({
  messages,
  running,
  undone,
  toolDraft,
  onUndo,
  emptyHint,
  reasoningExpanded = false,
  compactActivity = false,
  resultOnly = false,
  onForkMessage,
  onEditMessage,
  onRevertMessage,
  speech,
}: Props) {
  const t = useT()
  const scrollRef = useRef<HTMLDivElement>(null)
  /** 用户是否停在底部；只有为 true 时才自动跟随 */
  const stickToBottom = useRef(true)
  const [showJumpButton, setShowJumpButton] = useState(false)
  /** 右侧导航：悬浮在第几条时显示的左侧文字（含它相对滚动容器的纵向位置） */
  const [navTip, setNavTip] = useState<{ index: number; top: number } | null>(null)
  const railRef = useRef<HTMLDivElement>(null)
  /** 指针最后的位置：滚动时鼠标没动，要靠它重新判定悬浮的是哪一条 */
  const navPointer = useRef<{ x: number; y: number } | null>(null)

  /** 按指针当前压在哪一条上来更新悬浮态（鼠标移动 / 容器滚动都要调） */
  const syncNavFromPointer = useCallback(() => {
    const pointer = navPointer.current
    if (!pointer) return
    const hit = document.elementFromPoint(pointer.x, pointer.y) as HTMLElement | null
    const button = hit?.closest('[data-nav-index]') as HTMLElement | null
    if (!button) {
      setNavTip(null)
      return
    }
    const index = Number(button.dataset.navIndex)
    if (!Number.isFinite(index)) return
    setNavTip({
      index,
      top: button.offsetTop - (railRef.current?.scrollTop ?? 0) + button.offsetHeight / 2,
    })
  }, [])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    const atBottom = distance <= BOTTOM_THRESHOLD
    stickToBottom.current = atBottom
    setShowJumpButton(!atBottom)
  }, [])

  // 只在用户本来就贴着底时才自动滚动，避免打断向上翻阅
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !stickToBottom.current) return
    el.scrollTop = el.scrollHeight
  }, [messages, running, toolDraft])

  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    // 点「回到底部」时给一段平滑滚动动画
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    stickToBottom.current = true
    setShowJumpButton(false)
  }, [])

  // 把 tool 结果按 toolCallId 建索引，渲染时与 assistant 的调用合并成一张卡片
  const toolResults = new Map<string, Message>()
  // 工具产出的图片也按 toolCallId 收好，交给对应卡片展示
  const toolImages = new Map<string, Attachment[]>()
  for (const message of messages) {
    if (message.role === 'tool' && message.toolCallId) {
      toolResults.set(message.toolCallId, message)
    }
    for (const attachment of message.attachments ?? []) {
      if (!attachment.toolCallId) continue
      const list = toolImages.get(attachment.toolCallId)
      if (list) list.push(attachment)
      else toolImages.set(attachment.toolCallId, [attachment])
    }
  }

  // 只有最后一条 assistant 处于流式状态
  const lastAssistantId = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return messages[i].id
    }
    return null
  })()

  /**
   * 每个「回合」（两条 user 之间）里最后一条有正文的 assistant = 该回合的最终输出。
   * 这些消息：正文不再放右上角复制按钮，回合跑完后在下方给出复制/分叉。
   * 轮内「中途说的话」不算，所以不会每条都长按钮。
   */
  const finalOutputIds = useMemo(() => {
    const ids = new Set<string>()
    let lastContent: string | null = null
    for (const message of messages) {
      // 隐藏消息（如压缩摘要）不是真正的回合边界，跳过——
      // 否则它插在回合中间会把这一轮劈成两段，前半段的中途文本会被误判成最终输出
      if (message.hidden) continue
      if (message.role === 'user') {
        if (lastContent) ids.add(lastContent)
        lastContent = null
        continue
      }
      if (message.role === 'assistant' && message.content.trim() !== '') lastContent = message.id
    }
    if (lastContent) ids.add(lastContent)
    return ids
  }, [messages])

  /** 正在跑的这个回合（最后一条 user 之后）里的消息：跑完之前不算最终输出 */
  const runningTurnIds = useMemo(() => {
    const ids = new Set<string>()
    if (!running) return ids
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].hidden) continue
      if (messages[i].role === 'user') break
      ids.add(messages[i].id)
    }
    return ids
  }, [messages, running])

  /**
   * 渲染项。紧凑过程模式下，把一轮里连续的「思考 + 工具调用」合并成一条
   * "Used N …" 摘要；助手正文仍然按原位置分隔开。
   */
  const items = useMemo<ListItem[]>(() => {
    // 结果模式：按回合显示 —— 每回合只有一行 Working/Done（展开才是 Used）+ 该回合的最终输出
    if (resultOnly) {
      type Turn = { user?: Message; entries: ActivityEntry[]; final?: Message }
      const turns: Turn[] = []
      let current: Turn | null = null
      for (const message of messages) {
        if (message.role === 'tool' || message.hidden) continue
        if (message.role === 'user') {
          if (current) turns.push(current)
          current = { user: message, entries: [] }
          continue
        }
        if (!current) current = { entries: [] }
        if (message.reasoning) current.entries.push({ kind: 'reasoning', text: message.reasoning })
        // 中途说过的话也收进展开里（只留过程，不在正文区单独显示）
        if (message.content.trim() !== '') {
          if (current.final) current.entries.push({ kind: 'text', text: current.final.content })
          current.final = message
        }
        for (const call of message.toolCalls ?? []) current.entries.push({ kind: 'call', call })
      }
      if (current) turns.push(current)

      const out: ListItem[] = []
      turns.forEach((turn, index) => {
        if (turn.user) out.push({ kind: 'message', message: turn.user })
        // 最后一个回合进行中：只给 Working，先不显示这一轮的输出文字
        const inProgress = index === turns.length - 1 && running
        if (turn.entries.length > 0) {
          out.push({
            kind: 'activity',
            key: `working-${turn.user?.id ?? index}`,
            entries: turn.entries,
            streaming: inProgress,
            label: inProgress ? 'Working' : 'Done',
          })
        }
        if (turn.final && !inProgress) out.push({ kind: 'message', message: turn.final })
      })
      return out
    }
    if (!compactActivity) {
      return messages
        .filter((message) => message.role !== 'tool' && !message.hidden)
        .map((message) => ({ kind: 'message', message }))
    }
    const out: ListItem[] = []
    let block: { key: string; entries: ActivityEntry[]; streaming: boolean; anchorId?: string } | null =
      null
    const flush = () => {
      if (!block) return
      if (block.entries.length > 0) {
        out.push({ kind: 'activity', ...block })
      }
      block = null
    }
    for (const message of messages) {
      if (message.role === 'tool' || message.hidden) continue
      if (message.role !== 'assistant') {
        flush()
        out.push({ kind: 'message', message })
        continue
      }
      if (!block) block = { key: `activity:${message.id}`, entries: [], streaming: false }
      // 同一条 assistant 消息里：先思考、后工具，按这个顺序塞进 entries
      if (message.reasoning) block.entries.push({ kind: 'reasoning', text: message.reasoning })
      for (const call of message.toolCalls ?? []) {
        block.entries.push({ kind: 'call', call })
        if (isCompactCall(call)) block.anchorId = `rb-compact-${call.id}`
      }
      if (running && message.id === lastAssistantId) block.streaming = true
      if (message.content.trim() !== '' || message.error) {
        flush()
        out.push({ kind: 'message', message })
      }
    }
    flush()
    return out
  }, [messages, compactActivity, resultOnly, running, finalOutputIds, runningTurnIds])

  /** 最新一次压缩卡片（或承载它的 Used 行）的锚点 id */
  const compactAnchor = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]
      if (item.kind === 'activity') {
        if (item.anchorId) return item.anchorId
      } else {
        const call = item.message.toolCalls?.find(isCompactCall)
        if (call) return `rb-compact-${call.id}`
      }
    }
    return null
  }, [items])

  /**
   * 手动 /compact 时用户正停在底部，而压缩卡片是插在「历史中间」的，
   * 不主动滚过去就看不到。首次挂载只记录不滚动，免得打开旧会话乱跳。
   */
  const seenCompactRef = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (seenCompactRef.current === undefined) {
      seenCompactRef.current = compactAnchor
      return
    }
    if (!compactAnchor || running) return
    if (seenCompactRef.current === compactAnchor) return
    seenCompactRef.current = compactAnchor
    document.getElementById(compactAnchor)?.scrollIntoView({ block: 'center' })
  }, [compactAnchor, running])

  /** 右侧导航：我发过的消息（点一下跳到那条） */
  const userNav = useMemo(
    () =>
      messages
        .filter((message) => message.role === 'user' && !message.hidden)
        .map((message) => {
          const text = message.content.replace(/\s+/g, ' ').trim()
          return {
            id: message.id,
            text: text.length > 60 ? `${text.slice(0, 60)}…` : text || t('(仅图片)', '(image only)', '（僅圖片）'),
          }
        }),
    [messages],
  )

  return (
    <div className="anim-fade relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-5 sm:py-5"
      >
        <div className="mx-auto max-w-3xl space-y-2">
          {messages.length === 0 ? (
            <EmptyState hint={emptyHint} />
          ) : (
            items.map((item) =>
              item.kind === 'message' ? (
                <MessageRow
                  key={item.message.id}
                  finalOutput={
                    finalOutputIds.has(item.message.id) && !runningTurnIds.has(item.message.id)
                  }
                  onForkMessage={onForkMessage}
                  onEditMessage={onEditMessage}
                  onRevertMessage={onRevertMessage}
                  speech={speech}
                  domId={
                    item.message.toolCalls?.find(isCompactCall)
                      ? `rb-compact-${item.message.toolCalls.find(isCompactCall)!.id}`
                      : undefined
                  }
                  message={item.message}
                  toolResults={toolResults}
                  toolImages={toolImages}
                  undone={undone}
                  onUndo={onUndo}
                  streaming={running && item.message.id === lastAssistantId}
                  reasoningExpanded={reasoningExpanded}
                  compact={compactActivity}
                />
              ) : (
                <CompactActivity
                  key={item.key}
                  entries={item.entries}
                  streaming={item.streaming}
                  anchorId={item.anchorId}
                  label={item.label}
                  toolResults={toolResults}
                  toolImages={toolImages}
                  undone={undone}
                  onUndo={onUndo}
                  reasoningExpanded={reasoningExpanded}
                />
              ),
            )
          )}

          {/*
            模型正在生成工具参数：立刻在它该出现的位置（工具卡片处）显示一张卡片。
            紧凑过程模式下不显示这个流式过程，只让它并入 "Used …" 摘要。
          */}
          {toolDraft && !compactActivity && !resultOnly && (
            <ToolCallCard
              call={{ id: '__draft__', name: toolDraft.name, args: {} }}
              draftText={toolDraft.argsSoFar}
              undone={undone}
              onUndo={() => {}}
            />
          )}

          {running && !toolDraft && !resultOnly && (
            <div className="py-1 text-xs text-neutral-500">
              <span className="rb-scan">Working</span>
            </div>
          )}
        </div>
      </div>

      {showJumpButton && (
        <button
          onClick={jumpToBottom}
          title={t('msg.jumpBottom')}
          className="absolute bottom-4 left-1/2 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-neutral-700 bg-neutral-900/95 text-neutral-300 shadow-lg hover:border-amber-600 hover:text-amber-200"
        >
          <ArrowDownIcon className="h-4 w-4" />
        </button>
      )}

      {/* 右侧对话导航：细条代表「我发过的消息」；悬浮时文字浮在那条的左边；过多可滚动 */}
      {userNav.length > 1 && (
        <div
          className="absolute top-1/2 right-1.5 z-20 hidden -translate-y-1/2 sm:block"
          onMouseLeave={() => setNavTip(null)}
        >
          <div
            ref={railRef}
            className="rb-nav-rail flex flex-col items-end gap-0.5 overflow-y-auto overscroll-contain py-1"
            style={{ maxHeight: NAV_VISIBLE_MAX * NAV_ITEM_PITCH }}
            onMouseMove={(event) => {
              navPointer.current = { x: event.clientX, y: event.clientY }
              syncNavFromPointer()
            }}
            onScroll={syncNavFromPointer}
            onMouseLeave={() => {
              navPointer.current = null
              setNavTip(null)
            }}
          >
            {userNav.map((item, index) => {
              // 悬浮那条放大，相邻的次之（“靠近就放大”的观感）
              const distance = navTip ? Math.abs(index - navTip.index) : 99
              const bar =
                distance === 0
                  ? 'h-[5px] w-7 bg-amber-400'
                  : distance === 1
                    ? 'h-1 w-6 bg-amber-400/80'
                    : distance === 2
                      ? 'h-[3px] w-5 bg-neutral-500'
                      : 'h-[3px] w-4 bg-neutral-700 hover:bg-neutral-500'
              return (
                <button
                  key={item.id}
                  type="button"
                  data-nav-index={index}
                  aria-label={`${t('跳到第', 'Jump to', '跳到第', '移動')} ${index + 1}`}
                  onClick={() =>
                    document
                      .querySelector(`[data-msg="${item.id}"]`)
                      ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
                  }
                  className="flex shrink-0 items-center justify-end"
                  style={{ height: NAV_ITEM_HEIGHT, width: '100%' }}
                >
                  <span className={`block rounded-full transition-all duration-150 ease-out ${bar}`} />
                </button>
              )
            })}
          </div>

          {/* 文字浮在那条横条的左边（在滚动容器之外，不会被裁掉） */}
          {navTip && (
            <div
              style={{ top: navTip.top }}
              className="anim-fade pointer-events-none absolute right-full mr-2 max-w-56 -translate-y-1/2 truncate rounded-md border border-neutral-700/70 bg-neutral-900/90 px-2 py-1 text-xs text-neutral-200 shadow-lg backdrop-blur"
            >
              {navTip.index + 1}. {userNav[navTip.index].text}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function EmptyState({ hint }: { hint: string }) {
  const t = useT()
  return (
    <div className="anim-fade mt-10 text-center text-sm text-neutral-500">
      <div className="rb-watermark mb-6 text-6xl tracking-tight">RB Code</div>
      <p className="text-neutral-400">{hint}</p>
      <ul className="mx-auto mt-3 max-w-md space-y-1 text-left text-neutral-500">
        <li>· {t('msg.emptyAt')}</li>
        <li>· {t('msg.emptySlash')}</li>
        <li>· {t('msg.emptyPaste')}</li>
      </ul>
    </div>
  )
}

/** 思考过程：思考时展开、结束后自动收起（同一套高度动画），内容渲染 Markdown */
const ReasoningRow = memo(function ReasoningRow({
  text,
  showSpinner,
  defaultExpanded,
}: {
  text: string
  showSpinner: boolean
  defaultExpanded: boolean
}) {
  const t = useT()
  const bodyRef = useRef<HTMLDivElement>(null)
  /** 用户是否停在底部：贴着底才自动跟随，免得打断向上翻阅 */
  const stick = useRef(true)
  const [open, setOpen] = useState(false)

  /**
   * 「思考过程默认展开」的含义：思考进行中自动展开，思考结束后自动收起。
   * 设置关掉时就保持收起，交给用户手动点开。
   */
  useEffect(() => {
    if (defaultExpanded) setOpen(showSpinner)
  }, [defaultExpanded, showSpinner])

  useEffect(() => {
    const el = bodyRef.current
    if (!el || !stick.current) return
    el.scrollTop = el.scrollHeight
  }, [text, open])

  // Markdown 会把单个换行当空格：先把「单换行」转成硬换行，保住原有的分行
  const markdown = useMemo(() => markdownHardBreaks(text), [text])

  return (
    <div className="anim-rise rounded-lg border border-neutral-800 bg-neutral-900/40">
      <button type="button"
        onClick={() => setOpen((value) => !value)}
        className="rb-nohover flex h-8 w-full cursor-pointer items-center gap-1.5 px-3 text-xs text-neutral-500"
      >
        <ChevronRightIcon
          className={`h-3 w-3 shrink-0 text-neutral-600 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <LightbulbIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="shrink-0">{t('msg.thinking')}</span>
        <span
          className={`ml-1 min-w-0 flex-1 truncate text-left ${
            showSpinner ? 'text-neutral-400' : 'text-neutral-600'
          }`}
        >
          · {lastLine(text)}
        </span>
        {showSpinner && <LoaderIcon className="h-3 w-3 shrink-0 animate-spin text-amber-400" />}
        {/* 与工具卡片右侧的对号对称：思考中黄色脉动，思考结束转绿 */}
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              showSpinner ? 'animate-pulse bg-amber-400' : 'bg-emerald-500'
            }`}
          />
        </span>
      </button>
      <Collapse open={open}>
        <div
          ref={bodyRef}
          onScroll={() => {
            const el = bodyRef.current
            if (!el) return
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24
          }}
          className="rb-tool-md max-h-64 overflow-auto border-t border-neutral-800 px-3 py-2 text-neutral-400"
        >
          <Markdown content={markdown} />
        </div>
      </Collapse>
    </div>
  )
})

/** 紧凑摘要里对工具的叫法：始终英文，不随界面语言变 */
const COMPACT_LABEL: Record<string, string> = {
  read_file: 'Read',
  list_dir: 'List',
  glob: 'Glob',
  grep: 'Grep',
  write_file: 'Write',
  edit_file: 'Edit',
  delete_path: 'Delete',
  bash: 'Shell',
  bash_output: 'Shell',
  bash_wait: 'Shell',
  bash_kill: 'Shell',
  web_search: 'Search',
  web_fetch: 'Fetch',
  view_image: 'Image',
  todo_write: 'Todo',
  todo_read: 'Todo',
  ask_user: 'Ask',
  subagent: 'Subagent',
  skill: 'Skill',
  music: 'Music',
  computer_use: 'Computer use',
  compact_context: 'Compact',
}

/** 活动摘要里的工具名：MCP 工具（`mcp__server__tool`）直接显示工具名，保持英文 */
function compactLabel(name: string): string {
  if (name.startsWith('mcp__')) {
    const rest = name.slice('mcp__'.length)
    const at = rest.indexOf('__')
    const server = at < 0 ? rest : rest.slice(0, at)
    const tool = at < 0 ? rest : rest.slice(at + 2)
    // 内置浏览器那二十来个工具（browser_navigate / browser_resize / browser_emulate_media …）
    // 在摘要里统一显示成 browser，否则一行能列十几个。
    return server === 'browser' ? 'browser' : tool
  }
  return COMPACT_LABEL[name] ?? name
}

/** 活动摘要里的一条：思考 / 工具调用 / 模型中途说的话。**按真实发生顺序**排列 */
type ActivityEntry =
  | { kind: 'reasoning'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'call'; call: ToolCall }

/** 哪些工具名代表一次上下文压缩（用来给这张卡片定位 / 滚动） */
function isCompactCall(call: ToolCall): boolean {
  return call.name === 'compact_context'
}

/** 消息区的渲染项：普通消息，或一条合并后的活动摘要 */
type ListItem =
  | { kind: 'message'; message: Message }
  | {
      kind: 'activity'
      key: string
      entries: ActivityEntry[]
      streaming: boolean
      /** 这一块里有压缩调用时，给它一个锚点 id（用来滚进视野） */
      anchorId?: string
      /** 覆盖摘要文字（结果模式：Working / Done） */
      label?: string
    }

/** 紧凑过程的一行摘要：把一轮里的思考与工具调用合并，点击展开细节 */
function CompactActivity({
  entries,
  streaming,
  anchorId,
  label,
  toolResults,
  toolImages,
  undone,
  onUndo,
  reasoningExpanded,
}: {
  entries: ActivityEntry[]
  streaming: boolean
  anchorId?: string
  /** 覆盖摘要文字（结果模式下显示 Working） */
  label?: string
  toolResults: Map<string, Message>
  toolImages: Map<string, Attachment[]>
  undone: string[]
  onUndo: (undoId: string) => void
  reasoningExpanded: boolean
}) {
  const [open, setOpen] = useState(false)
  const hasReasoning = entries.some((entry) => entry.kind === 'reasoning')
  const labels = [
    ...new Set(
      entries
        .filter((entry) => entry.kind === 'call')
        .map((entry) => compactLabel(entry.call.name)),
    ),
  ]
  const parts = [...(hasReasoning ? ['Thoughts'] : []), ...labels]
  const total = entries.length
  const summary = label ?? `Used ${total} ${parts.join(', ')}`

  return (
    <div id={anchorId}>
      <button
        onClick={() => setOpen((value) => !value)}
        className="rb-nohover flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-xs text-neutral-500"
      >
        <ChevronRightIcon
          className={`h-3 w-3 shrink-0 text-neutral-600 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className={`min-w-0 flex-1 truncate ${streaming && !open ? 'rb-scan' : ''}`}>
          {summary}
        </span>
      </button>
      <Collapse open={open}>
        <div className="mt-1 space-y-1 pl-4">
          {/* 按真实顺序渲染：思考 → 它触发的工具 → 下一段思考 → … */}
          {entries.map((entry, index) =>
            entry.kind === 'reasoning' ? (
              <ReasoningRow
                key={`reasoning-${index}`}
                text={entry.text}
                showSpinner={false}
                defaultExpanded={reasoningExpanded}
              />
            ) : entry.kind === 'text' ? (
              <div key={`text-${index}`} className="rb-tool-md px-1 py-0.5 text-neutral-400">
                <Markdown content={markdownHardBreaks(entry.text)} />
              </div>
            ) : (
              <ToolCallCard
                key={entry.call.id}
                call={entry.call}
                result={toolResults.get(entry.call.id)}
                images={toolImages.get(entry.call.id)}
                undone={undone}
                onUndo={onUndo}
              />
            ),
          )}
        </div>
      </Collapse>
    </div>
  )
}

/** 消息时间戳（同一天只显示时分，跨天带上月日） */
function formatTime(ts?: number): string {
  if (!ts) return ''
  const date = new Date(ts)
  const now = new Date()
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  if (date.toDateString() === now.toDateString()) return `${hh}:${mm}`
  return `${date.getMonth() + 1}-${date.getDate()} ${hh}:${mm}`
}

/** 撤销范围的小菜单：fixed + portal 渲染，免得被消息行的滚动容器和层叠顺序裁掉/盖住 */
function RevertMenu({
  anchor,
  onPick,
  onClose,
}: {
  anchor: HTMLElement | null
  onPick: (scope: 'conversation' | 'files' | 'both') => void
  onClose: () => void
}) {
  const t = useT()
  if (!anchor) return null
  const rect = anchor.getBoundingClientRect()
  const doc = anchor.ownerDocument
  const width = 176
  const viewport = doc.defaultView?.innerWidth ?? 1024
  const left = Math.max(8, Math.min(rect.right - width, viewport - width - 8))
  const top = Math.max(8, rect.top - 6)
  const items = [
    ['both', t('对话 + 文件一起撤销', 'Revert both', '對話 + 檔案一起撤銷', '両方を戻す')],
    ['conversation', t('只撤对话', 'Conversation only', '只撤對話', '會話のみ')],
    ['files', t('只撤文件改动', 'File changes only', '只撤檔案改動', 'ファイル変更のみ')],
  ] as const

  return createPortal(
    <>
      <span className="fixed inset-0 z-[80]" onClick={onClose} />
      <span
        style={{ left, top }}
        className="rb-menu anim-pop fixed z-[90] flex w-44 -translate-y-full flex-col overflow-hidden rounded-md border border-neutral-700 shadow-xl"
      >
        {items.map(([scope, label]) => (
          <button key={scope}
            type="button"
            onClick={() => onPick(scope)}
            className="px-2 py-1.5 text-left text-[11px] text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
          >
            {label}
          </button>
        ))}
      </span>
    </>,
    doc.body,
  )
}

/** 一条消息下面那一行：时间（悬浮才显示）+ 复制（只有 AI 的文本输出才给）*/
function MessageMeta({
  message,
  align,
  showCopy = false,
  onFork,
  onEdit,
  onRevert,
  speech,
}: {
  message: Message
  align: 'left' | 'right'
  /** 只有「模型最终输出的文本」才在下面放复制/分叉按钮 */
  showCopy?: boolean
  onFork?: () => void
  onEdit?: () => void
  /** 撤销到这条之前；点开先选范围（对话 / 文件 / 两者） */
  onRevert?: (scope: 'conversation' | 'files' | 'both') => void
  /** 朗读设置（设置 → 语音） */
  speech?: { enabled: boolean; rate: number; voiceName: string }
}) {
  const t = useT()
  const [menuOpen, setMenuOpen] = useState(false)
  const speakingId = useSpeakingId()
  const revertAnchor = useRef<HTMLButtonElement | null>(null)
  const time = formatTime(message.createdAt)
  if (!time && !(showCopy && message.content)) return null
  const speakable = speech?.enabled === true && canSpeak() && message.content.trim() !== ''
  const speaking = speakingId === message.id
  return (
    <div
      className={`mt-1 flex items-center gap-2 text-[11px] text-neutral-600 opacity-0 transition-opacity group-hover/msg:opacity-100 ${
        menuOpen ? 'opacity-100' : ''
      } ${align === 'right' ? 'justify-end' : 'justify-start'}`}
    >
      {time && <span className="tabular-nums">{time}</span>}
      {showCopy && message.content && <CopyButton text={message.content} />}
      {speakable && (
        <Tooltip
          label={
            speaking
              ? t('停止朗读', 'Stop reading', '停止朗讀')
              : t('朗读这条回答', 'Read this reply aloud', '朗讀這則回答')
          }
        >
          <button
            type="button"
            onClick={() => {
              if (speaking) stopSpeaking()
              else
                speakText(message.id, message.content, {
                  lang: getLanguage(),
                  rate: speech?.rate ?? 1,
                  voiceName: speech?.voiceName ?? '',
                })
            }}
            aria-label={
              speaking
                ? t('停止朗读', 'Stop reading', '停止朗讀')
                : t('朗读这条回答', 'Read this reply aloud', '朗讀這則回答')
            }
            className={`inline-flex h-6 w-6 items-center justify-center rounded border transition-colors ${
              speaking
                ? 'border-amber-600 text-amber-300'
                : 'border-neutral-700 bg-neutral-900/90 text-neutral-400 hover:border-amber-600 hover:text-amber-200'
            }`}
          >
            {speaking ? <SpeakStopIcon className="h-3 w-3" /> : <SpeakIcon className="h-3 w-3" />}
          </button>
        </Tooltip>
      )}
      {onEdit && (
        <Tooltip label={t('修改这条并分叉', 'Edit & branch', '修改這則並分叉', '編集して分岐')}>
          <button
            type="button"
            onClick={onEdit}
            aria-label={t('修改这条并分叉', 'Edit & branch', '修改這則並分叉', '編集して分岐')}
            className="inline-flex h-6 w-6 items-center justify-center rounded border border-neutral-700 bg-neutral-900/90 text-[11px] text-neutral-400 transition-colors hover:border-amber-600 hover:text-amber-200"
          >
            <PencilIcon className="h-3 w-3" />
          </button>
        </Tooltip>
      )}
      {showCopy && onFork && (
        <Tooltip label={t('从这里分叉', 'Branch from here', '從這裡分叉', 'ここから分岐')}>
          <button
            type="button"
            onClick={onFork}
            aria-label={t('从这里分叉', 'Branch from here', '從這裡分叉', 'ここから分岐')}
            className="inline-flex h-6 w-6 items-center justify-center rounded border border-neutral-700 bg-neutral-900/90 text-[11px] text-neutral-400 transition-colors hover:border-amber-600 hover:text-amber-200"
          >
            <BranchIcon className="h-3 w-3" />
          </button>
        </Tooltip>
      )}
      {onRevert && (
        <span className="relative">
          <Tooltip label={t('撤销到这里', 'Revert to here', '撤銷到這裡', 'ここまで戻す')}>
            <button
              ref={revertAnchor}
              type="button"
              onClick={() => setMenuOpen((value) => !value)}
              aria-label={t('撤销到这里', 'Revert to here', '撤銷到這裡', 'ここまで戻す')}
              className="inline-flex h-6 w-6 items-center justify-center rounded border border-neutral-700 bg-neutral-900/90 text-[11px] text-neutral-400 transition-colors hover:border-red-500 hover:text-red-300"
            >
              <UndoIcon className="h-3 w-3" />
            </button>
          </Tooltip>
          {menuOpen && (
            <RevertMenu
              anchor={revertAnchor.current}
              onPick={(scope) => {
                setMenuOpen(false)
                onRevert(scope)
              }}
              onClose={() => setMenuOpen(false)}
            />
          )}
        </span>
      )}
    </div>
  )
}

const MessageRow = memo(function MessageRow({
  message,
  toolResults,
  toolImages,
  undone,
  onUndo,
  streaming,
  reasoningExpanded,
  compact,
  domId,
  finalOutput = false,
  onForkMessage,
  onEditMessage,
  onRevertMessage,
  speech,
}: {
  message: Message
  toolResults: Map<string, Message>
  toolImages: Map<string, Attachment[]>
  undone: string[]
  onUndo: (undoId: string) => void
  streaming: boolean
  reasoningExpanded: boolean
  /** 紧凑过程模式下，正文消息只渲染正文（思考/工具已并入 Used 摘要） */
  compact: boolean
  /** 需要滚动定位时挂一个 DOM id（目前只有压缩卡片用） */
  domId?: string
  /** 是不是模型最终那条文本输出：只有它把复制/分叉放到下方一行 */
  finalOutput?: boolean
  onForkMessage?: (messageId: string) => void
  onEditMessage?: (message: Message) => void
  onRevertMessage?: (messageId: string, scope: 'conversation' | 'files' | 'both') => void
  /** 朗读设置（设置 → 语音） */
  speech?: { enabled: boolean; rate: number; voiceName: string }
}) {
  const t = useT()
  if (message.role === 'user') {
    return (
      <div className="group/msg anim-rise" data-msg={message.id}>
        <div className="flex justify-end">
          <div className="max-w-[85%] space-y-2">
          {message.attachments && message.attachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {message.attachments.map((attachment) =>
                attachment.kind === 'image' ? (
                  <img
                    key={attachment.id}
                    src={attachment.dataUrl}
                    alt={attachment.name}
                    className="max-h-48 rounded-lg border border-neutral-700"
                  />
                ) : (
                  <span
                    key={attachment.id}
                    className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-xs text-neutral-400"
                  >
                    @{attachment.name}
                  </span>
                ),
              )}
            </div>
          )}
          {message.content && (
            <div className="rb-bubble-user rounded-xl bg-neutral-800/70 px-3.5 py-2 text-sm whitespace-pre-wrap break-words text-neutral-100 [overflow-wrap:anywhere]">
              {message.inserted && (
                <span className="mr-1.5 rounded bg-amber-900/70 px-1.5 py-0.5 align-middle text-[10px] text-amber-200">
                  {t('中途插入', 'Inserted mid-run', '中途插入', '実行中に挿入')}
                </span>
              )}
              {message.content}
            </div>
          )}
          </div>
        </div>
        <MessageMeta
          message={message}
          align="right"
          showCopy
          onEdit={onEditMessage ? () => onEditMessage(message) : undefined}
          onRevert={onRevertMessage ? (scope) => onRevertMessage(message.id, scope) : undefined}
        />
      </div>
    )
  }

  const hasTools = (message.toolCalls?.length ?? 0) > 0

  const contentBlock = message.content ? (
    message.error ? (
      <div className="flex items-start gap-2 rounded-xl border border-red-900 bg-red-950/40 px-3.5 py-2 text-sm text-red-300">
        <XCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
        <span className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
          {message.content}
        </span>
      </div>
    ) : finalOutput ? (
      // 最终输出：复制按钮放到消息下方那一行，这里不再叠一个
      <Markdown content={message.content} />
    ) : (
      <div className="group/msg relative">
        <CopyButton
          text={message.content}
          className="absolute top-0 right-0 opacity-0 transition-opacity group-hover/msg:opacity-100 focus:opacity-100"
        />
        <Markdown content={message.content} />
      </div>
    )
  ) : null

  // 紧凑过程：正文消息只显示正文，思考与工具已经并入上面的 "Used …" 摘要
  if (compact) {
    return (
      <div className="group/msg anim-rise space-y-2" data-msg={message.id}>
        {contentBlock}
        {!streaming && finalOutput && contentBlock && (
          <MessageMeta
            message={message}
            align="left"
            showCopy
            onFork={onForkMessage ? () => onForkMessage(message.id) : undefined}
            speech={speech}
          />
        )}
      </div>
    )
  }

  return (
    <div id={domId} data-msg={message.id} className="group/msg anim-rise space-y-2">
      {message.reasoning && (
        <ReasoningRow
          text={message.reasoning}
          showSpinner={streaming && !hasTools}
          defaultExpanded={reasoningExpanded}
        />
      )}

      {contentBlock}

      {message.toolCalls?.map((call) => (
        <ToolCallCard
          key={call.id}
          call={call}
          result={toolResults.get(call.id)}
          images={toolImages.get(call.id)}
          undone={undone}
          onUndo={onUndo}
        />
      ))}

      {!streaming && finalOutput && message.content && (
        <MessageMeta
          message={message}
          align="left"
          showCopy
          onFork={onForkMessage ? () => onForkMessage(message.id) : undefined}
          speech={speech}
        />
      )}
    </div>
  )
})
