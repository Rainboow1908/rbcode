/** 统一使用正斜杠；去掉首尾多余的斜杠；去掉 . 段；拒绝越过根目录的 .. */
export function normalizePath(input: string): string {
  const parts = input.replace(/\\/g, '/').split('/')
  const out: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (out.length === 0) throw new Error(`Path escapes the workspace root: ${input}`)
      out.pop()
      continue
    }
    out.push(part)
  }
  return out.join('/')
}

export function segments(path: string): string[] {
  const normalized = normalizePath(path)
  return normalized ? normalized.split('/') : []
}

export function basename(path: string): string {
  const parts = segments(path)
  return parts.length ? parts[parts.length - 1] : ''
}

export function dirname(path: string): string {
  const parts = segments(path)
  parts.pop()
  return parts.join('/')
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter(Boolean).join('/'))
}

/** 判断 path 是否在 dir 之内（含 dir 自身） */
export function isInside(dir: string, path: string): boolean {
  const d = normalizePath(dir)
  const p = normalizePath(path)
  if (!d) return true
  return p === d || p.startsWith(`${d}/`)
}

/** 人类可读的字节数 */
export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}
