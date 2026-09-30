/**
 * 极简 glob 转 RegExp。
 * 支持单星号（匹配单层）、双星号（匹配多层）、问号、花括号枚举与字符集合。
 */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '')
  let out = ''
  let i = 0

  while (i < normalized.length) {
    const ch = normalized[i]
    if (ch === '*') {
      const isDouble = normalized[i + 1] === '*'
      if (isDouble) {
        // **/ 匹配任意层级（含零层）
        if (normalized[i + 2] === '/') {
          out += '(?:[^/]+/)*'
          i += 3
          continue
        }
        out += '.*'
        i += 2
        continue
      }
      out += '[^/]*'
      i += 1
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      i += 1
      continue
    }
    if (ch === '[') {
      const close = normalized.indexOf(']', i + 1)
      if (close !== -1) {
        out += normalized.slice(i, close + 1)
        i = close + 1
        continue
      }
    }
    if (ch === '{') {
      const close = normalized.indexOf('}', i + 1)
      if (close !== -1) {
        const options = normalized
          .slice(i + 1, close)
          .split(',')
          .map((s) => escapeRegExp(s))
        out += `(?:${options.join('|')})`
        i = close + 1
        continue
      }
    }
    out += escapeRegExp(ch)
    i += 1
  }

  return new RegExp(`^${out}$`)
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 若 pattern 没有路径分隔符，则视为匹配任意目录下的文件名 */
export function normalizeGlob(pattern: string): string {
  const p = pattern.trim() || '**/*'
  return p.includes('/') ? p : `**/${p}`
}
