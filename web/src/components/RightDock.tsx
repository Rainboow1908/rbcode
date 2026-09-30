import { useState } from 'react'
import { t } from '../lib/i18n.ts'
import { CheckIcon, ChevronRightIcon, PlusIcon, XIcon } from './icons.tsx'
import Tooltip from './Tooltip.tsx'

/** 右侧标签栏里可以放哪些面板 */
export type DockPanelId = 'context' | 'terminals' | 'music' | 'files' | 'todos'

/** 所有可选面板（「+」菜单的顺序） */
export const DOCK_PANEL_IDS: DockPanelId[] = ['context', 'terminals', 'music', 'files', 'todos']

/** 面板的展示名（给标签页和「+」菜单用） */
export function dockPanelTitle(id: DockPanelId): string {
  switch (id) {
    case 'context':
      return t('上下文', 'Context', '上下文')
    case 'terminals':
      return t('终端', 'Terminals', '終端')
    case 'music':
      return t('音乐', 'Music', '音樂')
    case 'files':
      return t('文件树', 'Files', '檔案樹')
    default:
      return t('待办', 'Todos', '待辦')
  }
}

interface Props {
  /** 当前打开的面板（顺序即显示顺序） */
  open: DockPanelId[]
  active: DockPanelId | null
  onSelect: (id: DockPanelId) => void
  onOpen: (id: DockPanelId) => void
  onClose: (id: DockPanelId) => void
  onMove: (from: DockPanelId, to: DockPanelId) => void
  /** 画某个面板的内容（由 App 提供，方便直接用现有组件和数据） */
  renderPanel: (id: DockPanelId) => React.ReactNode
  /** 经典布局下可拖动调整宽度 */
  width?: number
  /** 工作台抽屉里用：不再依赖 lg 断点隐藏 */
  inDrawer?: boolean
}

/**
 * 右侧「上下文 / 终端 / 音乐 / 文件树 / 待办」的标签栏容器。
 * 交互和对话区那套标签一样：可拖动排序、可关闭、可新增。
 */
export default function RightDock({
  open,
  active,
  onSelect,
  onOpen,
  onClose,
  onMove,
  renderPanel,
  width,
  inDrawer = false,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [dragId, setDragId] = useState<DockPanelId | null>(null)

  return (
    <aside
      style={!width ? undefined : { width }}
      className={`${
        inDrawer ? 'flex h-full' : 'hidden lg:flex'
      } w-72 shrink-0 flex-col border-l border-neutral-800 bg-neutral-950`}
    >
      {/* 标签栏：高度对齐主区顶栏（h-7 内容 + py-2），否则两边的分隔线会错开 */}
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-neutral-800 px-2">
        <div className="rb-noscrollbar flex min-h-0 flex-1 items-center gap-1 overflow-x-auto">
          {open.map((id) => {
            const isActive = id === active
            return (
              <div
                key={id}
                draggable
                onDragStart={() => setDragId(id)}
                onDragOver={(event) => {
                  event.preventDefault()
                  if (dragId && dragId !== id) onMove(dragId, id)
                }}
                onDragEnd={() => setDragId(null)}
                onClick={() => onSelect(id)}
                className={`group flex h-7 shrink-0 cursor-grab items-center gap-1 rounded-md px-2 text-xs transition-colors active:cursor-grabbing ${
                  dragId === id ? 'opacity-50' : ''
                } ${
                  isActive
                    ? 'bg-neutral-800 text-neutral-100'
                    : 'text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-200'
                }`}
              >
                <span className="whitespace-nowrap">{dockPanelTitle(id)}</span>
                {open.length > 1 && (
                  <button
                    onClick={(event) => {
                      event.stopPropagation()
                      onClose(id)
                    }}
                    aria-label={t('关闭面板', 'Close panel', '關閉面板')}
                    className="rb-nohover shrink-0 text-neutral-500 opacity-0 transition-opacity group-hover:opacity-100 hover:text-neutral-200"
                  >
                    <XIcon className="h-3 w-3" />
                  </button>
                )}
              </div>
            )
          })}
        </div>

        {/* 新增面板 */}
        <div className="relative shrink-0">
          <Tooltip label={t('新增面板', 'Add panel', '新增面板')}>
            <button
              onClick={() => setMenuOpen((value) => !value)}
              className="rb-nohover flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
            >
              <PlusIcon className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
              <div className="rb-menu anim-pop absolute right-0 z-40 mt-1 min-w-36 rounded-lg border border-neutral-700 p-1 shadow-xl">
                {DOCK_PANEL_IDS.map((id) => {
                  const already = open.includes(id)
                  return (
                    <button
                      key={id}
                      disabled={already}
                      onClick={() => {
                        onOpen(id)
                        setMenuOpen(false)
                      }}
                      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
                        already
                          ? 'cursor-default text-neutral-600'
                          : 'text-neutral-300 hover:bg-neutral-800/60'
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">{dockPanelTitle(id)}</span>
                      {already && <CheckIcon className="h-3.5 w-3.5 shrink-0 text-amber-400" />}
                    </button>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {/* 面板内容：每个面板自己管滚动 */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {active ? (
          renderPanel(active)
        ) : (
          <div className="flex flex-1 items-center justify-center gap-1.5 p-4 text-xs text-neutral-500">
            <ChevronRightIcon className="h-3.5 w-3.5" />
            {t('点右上角「+」添加面板', 'Use the “+” above to add a panel', '點右上角「+」新增面板')}
          </div>
        )}
      </div>
    </aside>
  )
}
