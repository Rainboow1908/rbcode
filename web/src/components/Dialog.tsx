import type { ReactNode } from 'react'
import { useT } from '../lib/i18n.ts'
import OreButton from './OreButton.tsx'

interface DialogProps {
  open: boolean
  onClose: () => void
  children: ReactNode
  className?: string
}

/** 自定义对话框：遮罩淡入 + 面板弹出动画 */
export default function Dialog({ open, onClose, children, className }: DialogProps) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="anim-fade absolute inset-0 bg-black/60" onClick={onClose} />
      <div
        className={`anim-pop relative w-full max-w-md overflow-hidden rounded-xl border rb-dialog border-neutral-700 shadow-2xl ${
          className ?? ''
        }`}
      >
        {children}
      </div>
    </div>
  )
}

interface ConfirmProps {
  open: boolean
  title: string
  message?: string
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** 二次确认对话框 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: ConfirmProps) {
  const t = useT()
  return (
    <Dialog open={open} onClose={onCancel}>
      <div className="border-b border-neutral-800 px-4 py-3 text-sm font-medium text-neutral-100">
        {title}
      </div>
      {message && (
        <p className="px-4 py-3 text-xs leading-relaxed text-neutral-400">{message}</p>
      )}
      <div className="flex justify-end gap-2 border-t border-neutral-800 px-4 py-3">
        <OreButton
          status="normal"
          onClick={onCancel}
          className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 transition-colors hover:border-neutral-500"
        >
          {t('common.cancel')}
        </OreButton>
        <OreButton
          status={danger ? 'red' : 'green'}
          onClick={onConfirm}
          className={`rounded-md px-3.5 py-1.5 text-xs font-medium text-white transition-colors ${
            danger ? 'bg-red-600 hover:bg-red-500' : 'bg-amber-600 hover:bg-amber-500'
          }`}
        >
          {confirmLabel ?? t('common.confirm')}
        </OreButton>
      </div>
    </Dialog>
  )
}
