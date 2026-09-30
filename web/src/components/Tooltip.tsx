import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useIsMobile } from '../hooks/useIsMobile.ts'

interface Props {
  label: string
  children: ReactNode
  side?: 'top' | 'bottom'
  /** 包一层的额外类名（多数时候传 inline-flex 让其贴合内容） */
  className?: string
  /** 需要整行铺开时用（例如下拉里的菜单项要纵向排列） */
  block?: boolean
}

/** 同一时刻只显示一个提示：新提示出现前先关掉上一个 */
let activeHide: (() => void) | null = null

/**
 * 自定义悬浮提示（仅在桌面端）：
 * - 鼠标悬浮 / 聚焦时显示，替掉原生 title（原生没法统一风格、也没动画）
 * - fixed 定位 + 实时坐标，不会被滚动容器裁掉
 * - 靠近底部自动朝上弹
 * - 宽元素（如整行的文本）靠左对齐到起点，窄元素居中，并做视口夹取
 *
 * 手机端没有鼠标悬浮、长按又容易误触，所以**移动端干脆不显示任何提示**：
 * 只原样渲染包一层的容器，连监听都不挂。桌面行为完全不变。
 */
export default function Tooltip({ label, children, side = 'bottom', className, block }: Props) {
  const isMobile = useIsMobile()
  const ref = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{
    x: number
    y: number
    up: boolean
    left: boolean
    /** portal 到**触发元素所在文档**的 body（悬浮窗是另一个 document） */
    container: HTMLElement
  } | null>(null)

  const wrapperClass = `${block ? 'flex w-full' : 'inline-flex'} ${className ?? ''}`

  // 手机端：不渲染提示，也不挂事件，保持同样的容器类名避免布局变化
  if (isMobile) {
    return <span className={wrapperClass}>{children}</span>
  }

  const hide = () => {
    if (activeHide === hide) activeHide = null
    setPos(null)
  }

  const show = () => {
    const element = ref.current
    const rect = element?.getBoundingClientRect()
    if (!element || !rect) return
    // 悬浮窗是另一个 document：尺寸和 portal 目标都跟着触发元素所在的文档走
    const view = element.ownerDocument.defaultView ?? window
    const below = view.innerHeight - rect.bottom
    const up = side === 'top' || below < 120 || rect.top > view.innerHeight * 0.72
    const left = rect.width > 180
    // 宽元素贴左边文字起点；窄元素居中。都往视口内夹一下
    const rawX = left ? rect.left : rect.left + rect.width / 2
    const x = Math.max(12, Math.min(rawX, view.innerWidth - 12))
    activeHide?.()
    activeHide = hide
    setPos({ x, y: up ? rect.top : rect.bottom, up, left, container: element.ownerDocument.body })
  }

  return (
    <span
      ref={ref}
      className={wrapperClass}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {pos &&
        typeof document !== 'undefined' &&
        createPortal(
          <span
            role="tooltip"
            style={{ left: pos.x, top: pos.y }}
            className={`anim-fade pointer-events-none fixed z-[70] max-w-[min(420px,90vw)] truncate rounded-md border rb-menu border-neutral-700 px-2 py-1 text-[11px] text-neutral-200 shadow-lg ${
              pos.up ? '-translate-y-[calc(100%+6px)]' : 'translate-y-1.5'
            } ${pos.left ? '' : '-translate-x-1/2'}`}
          >
            {label}
          </span>,
          pos.container,
        )}
    </span>
  )
}
