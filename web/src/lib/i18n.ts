import { useSyncExternalStore } from 'react'
import { messages } from './i18n/messages.ts'
import type { MessageKey } from './i18n/messages.ts'
import type { Lang } from './types.ts'

export type { Lang }

export const LANGS: { value: Lang; label: string }[] = [
  { value: 'zh', label: '简体中文' },
  { value: 'en', label: 'English' },
  { value: 'tw', label: '繁體中文' },
  { value: 'jp', label: '日本語' },
]
// jp 目前**不受支持**：词条没有日语版本，选中后界面整体回落到简体中文
// （列表里会标注「不受支持」，设置页也会说明）。

/**
 * i18n：词条集中在 lib/i18n/messages.ts，调用处写 t('区域.用途')。
 * 兼容老的 t('中文','English','繁體','日本語') 老写法：第 4 个参数保留但**已不再使用**
 * （日本語自 2026-09 起不再支持），后续会逐步全部迁移成 key。
 * 用 useSyncExternalStore 订阅语言变化，被 memo 的组件也能跟着刷新。
 */
let current: Lang = 'zh'
const listeners = new Set<() => void>()

export function setLanguage(next: Lang): void {
  if (next === current || !next) return
  current = next
  for (const listener of listeners) listener()
}

export function getLanguage(): Lang {
  return current
}

/** 执行后端的显示名（按当前语言） */
export function backendName(kind: 'browser' | 'companion'): string {
  return kind === 'companion'
    ? t('本机执行器', 'Local executor', '本機執行器', 'ローカル実行環境')
    : t('浏览器沙箱', 'Browser sandbox', '瀏覽器沙箱', 'ブラウザサンドボックス')
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function t(key: MessageKey): string
/** 老写法：t(中文, English, 繁體, 日本語)。第 4 个参数已忽略（jp 不再支持） */
export function t(zh: string, en: string, tw: string, jp?: string): string
export function t(a: string, en?: string, tw?: string, _jp?: string): string {
  if (en === undefined) {
    const tables = messages as Record<string, Record<string, string | undefined> | undefined>
    // jp 没有词条：直接用简体中文那份（这就是「选中日本語、界面显示中文」的实现）
    const table = current === 'jp' ? undefined : tables[current]
    return table?.[a] ?? tables.zh?.[a] ?? a
  }
  switch (current) {
    case 'en':
      return en
    case 'tw':
      return tw ?? en
    default:
      // zh 与 jp（不受支持）都走简体中文
      return a
  }
}

/** 组件里用：语言一变就重渲染（memo 组件也能拿到最新语言） */
export function useT(): typeof t {
  useSyncExternalStore(subscribe, getLanguage, getLanguage)
  return t
}
