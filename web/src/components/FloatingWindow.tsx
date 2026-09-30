import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ColorMode, ThemeMode } from '../lib/types.ts'

/**
 * 系统级置顶悬浮窗（Document Picture-in-Picture）。
 *
 * 浏览器里唯一能做「真正的置顶小窗」（还能盖在别的应用上面）的是
 * `documentPictureInPicture.requestWindow()`，需要 Chrome/Edge 116+。
 * 这里把迷你 UI 用 portal 渲染进去，并：
 *   - 把主文档的样式表整份复制过去（主题变量都在里面）
 *   - 把 `<html>` 上的 light / aurora / rb-color-* 类镜像过去 → 跟主题适配
 */

/** 把主题类套到任意根元素上（主文档和悬浮窗共用这一份逻辑） */
export function applyThemeClasses(root: {
  classList: { toggle: (name: string, force?: boolean) => void }
}, theme: ThemeMode, color: ColorMode): void {
  root.classList.toggle('light', theme === 'light')
  root.classList.toggle('aurora', theme === 'aurora')
  root.classList.toggle('oreui', theme === 'oreui')
  for (const name of ['amber', 'blue', 'cyan', 'emerald', 'violet', 'rose']) {
    root.classList.toggle(`rb-color-${name}`, color === name)
  }
}

interface Props {
  open: boolean
  theme: ThemeMode
  color: ColorMode
  onClose: () => void
  /** 打不开时（浏览器不支持 / 被拒）回调一句原因 */
  onError: (message: string) => void
  children: ReactNode
}

export default function FloatingWindow({ open, theme, color, onClose, onError, children }: Props) {
  const [host, setHost] = useState<HTMLElement | null>(null)
  const windowRef = useRef<Window | null>(null)

  useEffect(() => {
    if (!open) return
    const pip = (window as unknown as { documentPictureInPicture?: { requestWindow: (options?: object) => Promise<Window> } })
      .documentPictureInPicture
    if (!pip) {
      onError('这个浏览器不支持悬浮窗（需要 Chrome / Edge 116 及以上）')
      return
    }

    let cancelled = false
    void (async () => {
      try {
        const pipWindow = await pip.requestWindow({ width: 360, height: 520 })
        if (cancelled) {
          pipWindow.close()
          return
        }
        windowRef.current = pipWindow

        // 样式：把主文档的 <link>/<style> 整份复制过去
        for (const node of Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))) {
          pipWindow.document.head.appendChild(node.cloneNode(true))
        }
        applyThemeClasses(pipWindow.document.documentElement, theme, color)

        // 用户直接关掉系统小窗时，同步把设置关掉
        pipWindow.addEventListener('pagehide', () => {
          windowRef.current = null
          setHost(null)
          onClose()
        })

        setHost(pipWindow.document.body)
      } catch (err) {
        onError(`打不开悬浮窗：${(err as Error).message}`)
      }
    })()

    return () => {
      cancelled = true
      windowRef.current?.close()
      windowRef.current = null
      setHost(null)
    }
    // 只在开关变化时重建；主题变化走下面那个 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 主题 / 配色变化时同步
  useEffect(() => {
    const pipWindow = windowRef.current
    if (pipWindow) applyThemeClasses(pipWindow.document.documentElement, theme, color)
  }, [theme, color])

  if (!open || !host) return null
  return createPortal(children, host)
}
