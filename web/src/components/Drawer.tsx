import { useEffect, type ReactNode } from 'react'

interface Props {
  open: boolean
  side: 'left' | 'right'
  onClose: () => void
  children: ReactNode
}

/**
 * 工作台布局的抽屉：左栏 / 右栏收进来，点遮罩或按 Esc 关闭。
 * 容器始终挂载，只切换 transform / opacity 的 class——
 * 这样展开和收起都是 CSS 过渡（之前用 rAF 会在首帧前就切走，导致没有过渡）。
 */
export default function Drawer({ open, side, onClose, children }: Props) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const hiddenTransform = side === 'left' ? '-translate-x-full' : 'translate-x-full'

  return (
    <div className={`fixed inset-0 z-40 overflow-hidden ${open ? '' : 'pointer-events-none'}`}>
      <div
        onClick={onClose}
        className={`absolute inset-0 bg-black/50 transition-opacity duration-200 ${
          open ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <div
        className={`absolute top-0 bottom-0 flex transition-transform duration-200 ease-out ${
          side === 'left' ? 'left-0' : 'right-0'
        } ${open ? 'translate-x-0' : hiddenTransform}`}
      >
        {children}
      </div>
    </div>
  )
}
