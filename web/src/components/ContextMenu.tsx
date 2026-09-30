import { useEffect, useRef, type ReactNode } from 'react'

export interface MenuItem {
  /** 空字符串 + separator 表示分隔线 */
  label: string
  onClick: () => void
  /** 危险操作（删除）用红色 */
  danger?: boolean
  separator?: boolean
  /** 行首的小图标（例如置顶） */
  icon?: ReactNode
}

interface Props {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

/** 轻量右键菜单：点别处或按 Esc 关闭 */
export default function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    // 捕获阶段监听：点在别的条目上时先关掉旧菜单，再让那一行自己开新菜单
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      style={{ left: x, top: y }}
      className="anim-pop fixed z-50 min-w-44 overflow-hidden rounded-lg border rb-menu border-neutral-700 py-1 shadow-xl"
    >
      {items.map((item, index) =>
        item.separator ? (
          <div key={`sep-${index}`} className="my-1 border-t border-neutral-800" />
        ) : (
          <button
            key={item.label}
            type="button"
            onClick={() => {
              item.onClick()
              onClose()
            }}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
              item.danger
                ? 'text-red-300 hover:bg-red-950/60'
                : 'text-neutral-300 hover:bg-neutral-800'
            }`}
          >
            {item.icon}
            {item.label}
          </button>
        ),
      )}
    </div>
  )
}
