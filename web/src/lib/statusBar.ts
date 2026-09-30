import type { MessageKey } from './i18n/messages.ts'
import type { StatusItemId } from './types.ts'

/**
 * 工作台底部状态栏可以显示哪些东西。
 * App 负责算值 + 渲染图标；设置页用同一份清单勾选，避免两边对不上。
 */
export const STATUS_ITEM_IDS: StatusItemId[] = [
  'project',
  'backend',
  'model',
  'permission',
  'reasoning',
  'cacheHit',
  'contextUsed',
  'contextTotal',
  'untilCompact',
  'compactThreshold',
  'speed',
  'outputTokens',
  'requests',
  'rounds',
  'messages',
  'todos',
  'elapsed',
  'shells',
]

/** 文字模式下的短标签（词条 key） */
export const STATUS_ITEM_LABEL: Record<StatusItemId, MessageKey> = {
  project: 'status.project',
  backend: 'status.backend',
  model: 'status.model',
  permission: 'status.permission',
  reasoning: 'status.reasoning',
  cacheHit: 'status.cacheHit',
  contextUsed: 'status.contextUsed',
  contextTotal: 'status.contextTotal',
  untilCompact: 'status.untilCompact',
  compactThreshold: 'status.compactThreshold',
  speed: 'status.speed',
  outputTokens: 'status.outputTokens',
  requests: 'status.requests',
  rounds: 'status.rounds',
  messages: 'status.messages',
  todos: 'status.todos',
  elapsed: 'status.elapsed',
  shells: 'status.shells',
}

/** 默认显示哪些（和改造前的状态栏信息量接近） */
export const DEFAULT_STATUS_ITEMS: StatusItemId[] = [
  'project',
  'backend',
  'model',
  'contextUsed',
  'cacheHit',
  'speed',
]

/** 大数字缩写：1234 → 1.2K、1200000 → 1.2M */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`
  return String(value)
}

/** 用时：1m20s / 45s */
export function formatDuration(startedAt: number | null, now = Date.now()): string {
  if (!startedAt) return '—'
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m > 0 ? `${m}m${s}s` : `${s}s`
}
