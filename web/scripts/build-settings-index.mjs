// 从 SettingsPage.tsx 里抽出每一条设置项（它所在的分组 + 标题 + 说明摘要），
// 生成 src/lib/settingsIndex.ts，供设置页搜索使用 —— 搜「悬浮窗」「兼容导入」这种
// 具体设置项时能精确命中，而不是只能搜分组名。
//
// 用法：node scripts/build-settings-index.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = join(here, '..', 'src', 'components', 'SettingsPage.tsx')
const target = join(here, '..', 'src', 'lib', 'settingsIndex.ts')

const text = readFileSync(source, 'utf8')

/** 每个分组在文件里的起始位置：`{section === 'general' && (` */
const sections = []
for (const match of text.matchAll(/section === '([a-z-]+)'/g)) {
  sections.push({ id: match[1], at: match.index ?? 0 })
}

const sectionAt = (offset) => {
  let current = 'general'
  for (const section of sections) {
    if (section.at <= offset) current = section.id
  }
  return current
}

/** 取 `t('zh', 'en', 'tw')` 里的第一个（中文）字符串 */
function firstZh(block, key) {
  const match = new RegExp(`${key}=\\{\\s*t\\(\\s*'((?:[^'\\\\]|\\\\.)*)'`, 'm').exec(block)
  return match ? match[1].replace(/\\'/g, "'") : ''
}

/** 从 `<Row` 开始找这个开标签的结束（括号配对 + 跳过字符串里的 `>`） */
function tagEnd(text, start) {
  let depth = 0
  let quote = ''
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = ''
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '{' || char === '(') depth += 1
    else if (char === '}' || char === ')') depth -= 1
    else if (char === '>' && depth === 0) return index + 1
  }
  return Math.min(text.length, start + 2500)
}

const rows = []
const seen = new Set()
const rowPattern = /<Row\b/g
for (const match of text.matchAll(rowPattern)) {
  const start = match.index ?? 0
  // 只在这个 Row 自己的开标签范围里找 title/desc，免得串到下一条
  const block = text.slice(start, tagEnd(text, start))
  const title = firstZh(block, 'title')
  if (!title) continue
  const desc = firstZh(block, 'desc').slice(0, 120)
  const id = sectionAt(start)
  const key = `${id}:${title}`
  if (seen.has(key)) continue
  seen.add(key)
  rows.push({ section: id, title, desc })
}

const body = rows
  .map((row) => `  { section: '${row.section}', title: ${JSON.stringify(row.title)}, desc: ${JSON.stringify(row.desc)} },`)
  .join('\n')

writeFileSync(
  target,
  `// 由 scripts/build-settings-index.mjs 生成：设置页每一条设置项（分组 + 标题 + 说明摘要）。
// 设置页搜索用它命中「具体设置项」，改完 SettingsPage 记得重跑那个脚本。
export interface SettingIndexEntry {
  section: string
  title: string
  desc: string
}

export const SETTINGS_INDEX: SettingIndexEntry[] = [
${body}
]

/** 在索引里找匹配的设置项（标题或说明包含关键词，忽略大小写） */
export function matchSettings(query: string, limit = 40): SettingIndexEntry[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const hits = SETTINGS_INDEX.filter(
    (entry) =>
      entry.title.toLowerCase().includes(needle) || entry.desc.toLowerCase().includes(needle),
  )
  // 标题命中排在说明命中前面
  hits.sort((a, b) => {
    const aTitle = a.title.toLowerCase().includes(needle) ? 0 : 1
    const bTitle = b.title.toLowerCase().includes(needle) ? 0 : 1
    return aTitle - bTitle
  })
  return hits.slice(0, limit)
}
`,
  'utf8',
)

console.log(`settings index: ${rows.length} entries -> ${target}`)
