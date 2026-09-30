import type { SessionMeta } from './sessions.ts'

/**
 * 每个项目的会话索引缓存。
 *
 * 会话内容本身存在工作区的 `.rbcode/` 里，这里只是为了「刷新之后侧栏别变空」：
 * 启动时只有当前项目会真的去读 `.rbcode/sessions`，其它项目先用上次看到的列表渲染，
 * 用户点进去时再由 refreshSessions 刷新。
 */
const KEY = 'rbcode.sessionCache.v1'

/** 单个项目最多缓存多少条，避免把 localStorage 撑爆 */
const MAX_PER_PROJECT = 200

export type SessionCache = Record<string, SessionMeta[]>

export function loadSessionCache(): SessionCache {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    const out: SessionCache = {}
    for (const [projectId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue
      out[projectId] = value
        .filter((item): item is SessionMeta => {
          const meta = item as SessionMeta | null
          return Boolean(meta) && typeof meta?.id === 'string'
        })
        .slice(0, MAX_PER_PROJECT)
    }
    return out
  } catch {
    return {}
  }
}

export function saveSessionCache(cache: SessionCache): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(cache))
  } catch {
    // 隐私模式等写不进去就算了，不影响功能
  }
}
