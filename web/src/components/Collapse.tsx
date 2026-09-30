import { useEffect, useState, type ReactNode } from 'react'

interface Props {
  open: boolean
  /** 追加到外层容器上的类名（例如边框、圆角） */
  className?: string
  children: ReactNode
}

/**
 * 统一的展开/收起容器：切换 grid-template-rows 0fr↔1fr，展开和收起都有高度动画
 * （和计划清单 / 提问面板同一套做法）。
 *
 * 内容**首次展开时才开始挂载**，之后一直保留 —— 这样：
 * - 收起时也不会把内容卸掉，收起动画才完整；
 * - 收起状态（尤其是一大堆工具卡片）不会提前渲染 Markdown / 高亮，长会话不卡。
 */
export default function Collapse({ open, className = '', children }: Props) {
  const [mounted, setMounted] = useState(open)

  useEffect(() => {
    if (open) setMounted(true)
  }, [open])

  return (
    <div
      className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${
        open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
      } ${className}`}
    >
      <div className="min-h-0 overflow-hidden">{mounted ? children : null}</div>
    </div>
  )
}
