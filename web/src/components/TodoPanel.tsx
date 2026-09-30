import type { Todo } from '../lib/types.ts'
import { useT } from '../lib/i18n.ts'
import {
  CheckCircleIcon,
  ChevronRightIcon,
  CircleDotIcon,
  CircleIcon,
  ClipboardListIcon,
  XIcon,
} from './icons.tsx'

interface Props {
  todos: Todo[]
  collapsed: boolean
  onToggle: () => void
  /** 关掉整个计划清单（用户自己决定要不要看） */
  onClose: () => void
}

const ICON = {
  pending: CircleIcon,
  in_progress: CircleDotIcon,
  completed: CheckCircleIcon,
} as const

const ICON_COLOR: Record<Todo['status'], string> = {
  pending: 'text-neutral-600',
  in_progress: 'text-amber-400',
  completed: 'text-emerald-500',
}

const TEXT_COLOR: Record<Todo['status'], string> = {
  pending: 'text-neutral-400',
  in_progress: 'text-neutral-100',
  completed: 'text-neutral-500 line-through',
}

/**
 * 计划清单：与输入框同一套浮动卡片，贴在输入框上方，可折叠。
 */
export default function TodoPanel({ todos, collapsed, onToggle, onClose }: Props) {
  const t = useT()
  if (todos.length === 0) return null

  const done = todos.filter((t) => t.status === 'completed').length
  const current = todos.find((t) => t.status === 'in_progress')
  const progress = Math.round((done / todos.length) * 100)

  return (
    <div className="anim-rise px-4 pt-2">
      <div className="mx-auto max-w-3xl">
        <div className="rounded-xl border border-neutral-700 bg-neutral-900/70 shadow-lg">
          <button
            onClick={onToggle}
            className="rb-nohover group flex w-full items-center gap-2 rounded-t-xl px-3 py-2.5 text-left"
          >
            <ChevronRightIcon
              className={`h-3.5 w-3.5 shrink-0 text-neutral-500 transition-transform ${
                collapsed ? '' : 'rotate-90'
              }`}
            />
            <ClipboardListIcon className="h-3.5 w-3.5 shrink-0 text-amber-400" />
            <span className="shrink-0 text-xs font-medium text-neutral-200">
              {t('计划清单', 'Plan', '計畫清單', '計画リスト')}
            </span>
            <span className="shrink-0 rounded-full bg-neutral-800 px-1.5 text-[10px] leading-4 tabular-nums text-neutral-400">
              {done}/{todos.length}
            </span>
            {collapsed ? (
              current && (
                <span className="min-w-0 flex-1 truncate text-xs text-neutral-500">
                  {`· ${current.content}`}
                </span>
              )
            ) : (
              <span className="flex-1" />
            )}
            <span className="ml-auto shrink-0 text-[11px] text-neutral-600 transition-colors group-hover:text-neutral-400">
              {collapsed
                ? t('展开', 'Expand', '展開', '展開')
                : t('收起', 'Collapse', '收合', '折りたたむ')}
            </span>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                onClose()
              }}
              aria-label={t('关闭计划清单', 'Hide the plan', '關閉計畫清單')}
              title={t('关闭计划清单', 'Hide the plan', '關閉計畫清單')}
              className="rb-nohover ml-1 shrink-0 rounded p-0.5 text-neutral-600 transition-colors hover:text-neutral-200"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          </button>

          <div className="px-3 pb-2.5">
            {/* 进度条：折叠时也能一眼看到完成度 */}
            <div className="h-1 overflow-hidden rounded-full bg-neutral-800/80">
              <div
                className="h-full rounded-full bg-emerald-500/70 transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>

            <div
              className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${
                collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'
              }`}
            >
              <div className="overflow-hidden">
                <ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto">
                {todos.map((todo) => {
                  const Icon = ICON[todo.status]
                  return (
                    <li
                      key={todo.id}
                      className={`flex items-start gap-2 rounded-md px-1.5 py-1 text-sm ${
                        todo.status === 'in_progress' ? 'bg-amber-500/10' : ''
                      }`}
                    >
                      <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${ICON_COLOR[todo.status]}`} />
                      <span
                        className={`min-w-0 flex-1 leading-relaxed whitespace-pre-wrap ${TEXT_COLOR[todo.status]}`}
                      >
                        {todo.content}
                      </span>
                    </li>
                  )
                })}
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
