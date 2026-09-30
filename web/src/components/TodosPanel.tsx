import { useT } from '../lib/i18n.ts'
import type { Todo } from '../lib/types.ts'
import { CheckCircleIcon, CircleDotIcon, CircleIcon } from './icons.tsx'

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

/** 待办面板：把模型写的 todo 清单放进右侧标签栏 */
export default function TodosPanel({ todos }: { todos: Todo[] }) {
  const t = useT()

  if (todos.length === 0) {
    return (
      <p className="p-3 text-xs leading-relaxed text-neutral-500">
        {t(
          '还没有待办。模型用 todo_write 写计划时会出现在这里。',
          'No todos yet. Items written by the model with todo_write show up here.',
          '還沒有待辦。模型用 todo_write 寫計畫時會出現在這裡。',
        )}
      </p>
    )
  }

  const done = todos.filter((todo) => todo.status === 'completed').length

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-neutral-800 px-2 py-1.5 text-[11px] text-neutral-500">
        {t(
          `${done}/${todos.length} 已完成`,
          `${done}/${todos.length} done`,
          `${done}/${todos.length} 已完成`,
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {todos.map((todo) => {
          const Icon = ICON[todo.status]
          return (
            <div key={todo.id} className="flex items-start gap-2 py-1">
              <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${ICON_COLOR[todo.status]}`} />
              <span className={`text-xs leading-relaxed ${TEXT_COLOR[todo.status]}`}>{todo.content}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
