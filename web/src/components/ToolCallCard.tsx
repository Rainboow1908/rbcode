import { memo, useState } from 'react'
import { lastLine, markdownHardBreaks } from '../lib/text.ts'
import { useT } from '../lib/i18n.ts'
import type { MessageKey } from '../lib/i18n/messages.ts'
import type { Attachment, Message, ToolCall } from '../lib/types.ts'
import { Markdown } from './Markdown.tsx'
import Collapse from './Collapse.tsx'
import {
  CheckIcon,
  ChevronRightIcon,
  LoaderIcon,
  UndoIcon,
  WrenchIcon,
  XCircleIcon,
} from './icons.tsx'

interface Props {
  call: ToolCall
  /** 对应的工具结果；还没执行完时为 undefined */
  result?: Message
  /** 已撤销过的记录 id */
  undone: string[]
  /** 参数还在生成中时的原始文本（草稿卡片用） */
  draftText?: string
  /** 这个工具产出的图片（展开时才显示，不在消息流里单独占位） */
  images?: Attachment[]
  onUndo: (undoId: string) => void
}

/** 这一行要展示的“当前动作” */
function actionLine(call: ToolCall): string {
  const args = call.args ?? {}
  const candidate =
    args.description ??
    args.path ??
    args.command ??
    args.url ??
    args.query ??
    args.pattern ??
    args.name ??
    args.prompt ??
    args.content
  if (typeof candidate !== 'string') return ''
  const line = candidate.replace(/\s+/g, ' ').trim()
  return line.length > 110 ? `…${line.slice(-110)}` : line
}

/** MCP 工具名 `mcp__<服务器>__<工具>` → 拆成「工具名 + 来源」，界面别直接甩一长串 */
function displayToolName(name: string): { label: string; source?: string } {
  if (!name.startsWith('mcp__')) return { label: name }
  const rest = name.slice('mcp__'.length)
  const at = rest.indexOf('__')
  if (at < 0) return { label: rest }
  return { label: rest.slice(at + 2), source: rest.slice(0, at) }
}

/** 每个工具在界面上的一句人话（词条 key） */
export const TOOL_VERB_KEY: Record<string, MessageKey> = {
  read_file: 'tool.read',
  write_file: 'tool.write',
  edit_file: 'tool.edit',
  delete_path: 'tool.delete',
  list_dir: 'tool.list',
  glob: 'tool.glob',
  grep: 'tool.grep',
  bash: 'tool.bash',
  ask_user: 'tool.ask',
  web_search: 'tool.webSearch',
  web_fetch: 'tool.webFetch',
  todo_write: 'tool.todoWrite',
  todo_read: 'tool.todoRead',
  subagent: 'tool.subagent',
  skill: 'tool.skill',
  compact_context: 'composer.compacting',
}

/** 递归渲染一个值：对象/数组展开成层级列表，不再丢一整块 JSON 给用户 */
function ArgValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || value === undefined) {
    return <span className="text-neutral-600">—</span>
  }
  if (typeof value === 'boolean') {
    return <code className="font-mono text-xs text-amber-300">{String(value)}</code>
  }
  if (typeof value === 'number') {
    return <code className="font-mono text-xs text-sky-300">{String(value)}</code>
  }
  if (typeof value === 'string') {
    return value.includes('\n') || value.length > 80 ? (
      <pre className="max-h-40 overflow-auto rounded border border-neutral-800 bg-neutral-950/60 px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-neutral-300">
        {value}
      </pre>
    ) : (
      <code className="font-mono text-xs break-all text-neutral-300">{value}</code>
    )
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-neutral-600">[]</span>
    return (
      <ul className={`space-y-1 ${depth > 0 ? 'border-l border-neutral-800 pl-2' : ''}`}>
        {value.map((item, index) => (
          <li key={index} className="flex gap-1.5">
            <span className="shrink-0 font-mono text-[11px] text-neutral-600">{index}</span>
            <ArgValue value={item} depth={depth + 1} />
          </li>
        ))}
      </ul>
    )
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return <span className="text-neutral-600">{'{}'}</span>
  return (
    <dl className={`space-y-1.5 ${depth > 0 ? 'border-l border-neutral-800 pl-2' : ''}`}>
      {entries.map(([key, item]) => (
        <div key={key} className="space-y-0.5">
          <dt className="font-mono text-[11px] text-neutral-500">{key}</dt>
          <dd className="min-w-0">
            <ArgValue value={item} depth={depth + 1} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** 内容是不是一段 JSON（对象 / 数组）——是的话前端渲染成列表，不显示 JSON 原文 */
function tryParseJson(text: string): unknown {
  const trimmed = text.trim()
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

/** 工具结果：JSON 渲染成层级列表，其余按 Markdown 渲染 */
function ResultBody({ content }: { content: string }) {
  const parsed = tryParseJson(content)
  if (parsed !== null && typeof parsed === 'object') {
    return <ArgValue value={parsed} />
  }
  return (
    <div className="rb-tool-md max-h-80 overflow-auto">
      <Markdown content={markdownHardBreaks(content)} />
    </div>
  )
}

/**
 * 工具参数：按字段渲染成「字段名 + 值」，不再直接丢一整块 JSON 给用户。
 * 多行字符串/对象递归展开，短字符串直接内联。
 */
function ToolArgs({ args }: { args: Record<string, unknown> }) {
  const entries = Object.entries(args ?? {})
  if (entries.length === 0) {
    return <div className="text-xs text-neutral-600">—</div>
  }
  return (
    <dl className="space-y-2">
      {entries.map(([key, value]) => (
        <div key={key} className="space-y-1">
          <dt className="font-mono text-[11px] text-neutral-500">{key}</dt>
          <dd className="min-w-0">
            <ArgValue value={value} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * 工具调用卡片。
 * 参数还在生成时就先出现（draftText），折叠状态下显示正在写入的最后一行，
 * 和“思考”那一行的形式一致；生成完变成正常卡片，跑完显示结果的最后一行。
 */
const ToolCallCard = memo(function ToolCallCard({
  call,
  result,
  undone,
  draftText,
  images,
  onUndo,
}: Props) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const generating = draftText !== undefined
  const running = generating || !result
  const failed = Boolean(result?.error)
  const undoId = result?.undoId ?? ''
  const undoable = Boolean(undoId) && !undone.includes(undoId)
  const isUndone = Boolean(undoId) && undone.includes(undoId)
  /** 上下文压缩：参数是空的、结果是一段 Markdown 摘要——单独渲染 */
  const isCompact = call.name === 'compact_context'

  const preview = generating
    ? lastLine(draftText, 110)
    : isCompact
      ? ''
      : result
        ? lastLine(result.content) || actionLine(call)
        : actionLine(call)

  return (
    <div
      className={`anim-rise group/undo overflow-hidden rounded-lg border bg-neutral-900/40 ${
        generating ? 'border-amber-800/50' : 'border-neutral-800'
      }`}
    >
      <div className="relative flex h-8 items-center gap-1.5 px-3">
        <button
          onClick={() => setOpen((v) => !v)}
          className="rb-nohover flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRightIcon
            className={`h-3 w-3 shrink-0 text-neutral-600 transition-transform ${
              open ? 'rotate-90' : ''
            }`}
          />
          <WrenchIcon className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
          <span className="shrink-0 font-mono text-xs text-neutral-300">
            {displayToolName(call.name).label}
          </span>
          {displayToolName(call.name).source && (
            <span className="shrink-0 rounded bg-neutral-800/80 px-1.5 py-0.5 text-[10px] text-neutral-500">
              MCP · {displayToolName(call.name).source}
            </span>
          )}
          {TOOL_VERB_KEY[call.name] && !generating && (
            <span className="shrink-0 text-xs text-neutral-600">{t(TOOL_VERB_KEY[call.name])}</span>
          )}
          {/* 与“思考”一样的一行实时预览 */}
          <span
            className={`min-w-0 flex-1 truncate text-xs ${
              generating ? 'text-amber-300/80' : 'text-neutral-500'
            }`}
          >
            {preview}
          </span>

          {!generating && result?.diff && (
            <span className="shrink-0 font-mono text-[11px]">
              <span className="text-emerald-500">+{result.diff.added}</span>{' '}
              <span className="text-red-400">-{result.diff.removed}</span>
            </span>
          )}

          {generating && (
            <>
              <span className="shrink-0 text-xs text-amber-400">{t('tool.generating')}</span>
              <LoaderIcon className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-400" />
            </>
          )}
          {!generating && running && (
            <>
              <span className="shrink-0 text-xs text-amber-400">{t('tool.running')}</span>
              <LoaderIcon className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-400" />
            </>
          )}
          {!running && failed && (
            <XCircleIcon
              className={`h-3.5 w-3.5 shrink-0 text-red-400 ${
                undoable ? 'transition-opacity group-hover/undo:opacity-0' : ''
              }`}
            />
          )}
          {!running && !failed && (
            <CheckIcon
              className={`h-3.5 w-3.5 shrink-0 text-emerald-500 ${
                undoable ? 'transition-opacity group-hover/undo:opacity-0' : ''
              }`}
            />
          )}
        </button>

        {undoable && (
          <button
            onClick={() => onUndo(undoId)}
            title={t('tool.undoTitle')}
            className="absolute top-1/2 right-2 inline-flex -translate-y-1/2 items-center gap-1 rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-xs text-neutral-400 opacity-0 transition-opacity group-hover/undo:opacity-100 hover:border-amber-600 hover:text-amber-200 focus:opacity-100"
          >
            <UndoIcon className="h-3 w-3" />
            {t('tool.undo')}
          </button>
        )}
        {isUndone && (
          <span className="shrink-0 text-xs text-emerald-500">{t('tool.undone')}</span>
        )}
      </div>

      <Collapse open={open}>
        <div className="space-y-2 border-t border-neutral-800 px-3 py-2">
          {!isCompact && (
            <div>
              <div className="mb-1 text-[11px] text-neutral-600">
                {generating ? t('tool.paramsGenerating') : t('tool.params')}
              </div>
              {generating ? (
                <pre className="max-h-48 overflow-auto font-mono text-xs whitespace-pre-wrap text-neutral-400">
                  {draftText}
                  <span className="text-amber-500/70">▍</span>
                </pre>
              ) : (
                <ToolArgs args={call.args} />
              )}
            </div>
          )}
          <div>
            <div className="mb-1 text-[11px] text-neutral-600">
              {isCompact ? t('composer.compacting') : t('tool.result')}
            </div>
            {generating ? (
              <div className="font-mono text-xs text-neutral-500">{t('tool.waitingArgs')}</div>
            ) : result ? (
              result.error ? (
                <div className="font-mono text-xs whitespace-pre-wrap text-red-300">
                  {result.content}
                </div>
              ) : (
                <ResultBody content={result.content} />
              )
            ) : (
              <div className="font-mono text-xs text-neutral-500">
                {t('执行中…', 'Running…', '執行中…', '実行中…')}
              </div>
            )}
          </div>
          {images && images.length > 0 && (
            <div>
              <div className="mb-1 text-[11px] text-neutral-600">{t('tool.images')}</div>
              <div className="flex flex-wrap gap-2">
                {images.map((image) => (
                  <img
                    key={image.id}
                    src={image.dataUrl}
                    alt={image.name}
                    className="max-h-48 rounded-lg border border-neutral-700"
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </Collapse>
    </div>
  )
})

export default ToolCallCard
