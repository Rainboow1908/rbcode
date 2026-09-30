import { useEffect, useRef, useState } from 'react'
import { useT } from '../lib/i18n.ts'

interface Props {
  /** 要复制的内容 */
  text: string
  /** 按钮文案，默认「复制」 */
  label?: string
  className?: string
}

/** 写剪贴板：优先 Clipboard API；手机端多为 http://<局域网IP>（非安全上下文），
 *  这时 navigator.clipboard 是 undefined，退回老式的 execCommand 兜底。 */
async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // 没权限 / WebView 不支持：走下面的兜底
    }
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '0'
    area.style.left = '0'
    area.style.opacity = '0'
    area.style.pointerEvents = 'none'
    document.body.appendChild(area)
    area.focus()
    area.select()
    area.setSelectionRange(0, area.value.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

/** 到处都用得上的小复制按钮：点一下写剪贴板，一会儿显示「已复制」 */
export default function CopyButton({ text, label, className = '' }: Props) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const shown = label ?? t('复制', 'Copy', '複製', 'コピー')

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  return (
    <button
      type="button"
      title={shown}
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return
          setCopied(true)
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), 1600)
        })
      }}
      className={`inline-flex h-6 items-center gap-1 rounded border border-neutral-700 bg-neutral-900/90 px-1.5 text-[11px] text-neutral-400 transition-colors hover:border-amber-600 hover:text-amber-200 ${className}`}
    >
      {copied ? (
        <svg viewBox="0 0 16 16" className="h-3 w-3 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M2.5 8.5 6 12l7.5-8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
          <path d="M10.5 5.5v-2A1.5 1.5 0 0 0 9 2H4a1.5 1.5 0 0 0-1.5 1.5V9A1.5 1.5 0 0 0 4 10.5h1.5" strokeLinecap="round" />
        </svg>
      )}
      {copied ? t('已复制', 'Copied', '已複製') : shown}
    </button>
  )
}
