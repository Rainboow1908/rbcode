import { useSyncExternalStore } from 'react'
import type { ThemeMode } from './types.ts'

/**
 * 当前主题（模块级订阅）。
 *
 * 组件要知道「现在是不是 OreUI 主题」才能决定用哪套按钮：OreUI 的按钮是它自己的
 * 类名（oreui_btn_inner status_*），只在切到那个主题时才挂上。
 * 用一份模块级状态而不是 Context：对话框 / 悬浮窗里的组件都是同一份 JS 上下文
 * （悬浮窗是 Document PiP，共享同一个模块实例），不必层层传 provider。
 */
let current: ThemeMode = 'dark'
const listeners = new Set<() => void>()

export function setThemeMode(theme: ThemeMode): void {
  if (current === theme) return
  current = theme
  for (const listener of listeners) listener()
}

function snapshot(): ThemeMode {
  return current
}

export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    snapshot,
    snapshot,
  )
}

/** 是不是 OreUI 主题（非 React 场合也能用，比如测试里直接问） */
export function isOreuiTheme(): boolean {
  return current === 'oreui'
}
