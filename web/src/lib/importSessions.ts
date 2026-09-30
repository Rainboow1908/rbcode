import { saveImageFile, stripInlineImages } from './attachments.ts'
import type { Backend } from './executor/types.ts'
import { RBC_DIR } from './rbcode.ts'
import { saveSession, type Session } from './sessions.ts'
import type { Attachment, Message, ToolCall } from './types.ts'

/**
 * 兼容导入：项目里带 `.reasonix` 时，把磁盘上属于这个项目的会话读进来，
 * 转成 `.rbcode` 的会话（含工具调用）。**只读源文件，绝不改动它们。**
 *
 * 两代会话都要认：
 *   - 老式：`<id>.jsonl` 全量 transcript（消息一行一条）+ `<id>.meta.json`（只有统计）
 *   - 新式：`<id>.events.jsonl` 追加式事件日志（真身）+ `<id>.jsonl`（派生）+ `<id>.jsonl.meta`
 * 两代的消息 schema 相同：`{ role, content, reasoning_content, tool_calls }`。
 */

const MARKER_FILE = `${RBC_DIR}/imported.json`

/** 工具名映射：外部的调用名 → 我们这边的工具名 */
const TOOL_NAME_MAP: Record<string, string> = {
  read_file: 'read_file',
  write_file: 'write_file',
  edit_file: 'edit_file',
  multi_edit: 'edit_file',
  notebook_edit: 'edit_file',
  read_notebook: 'read_file',
  list_directory: 'list_dir',
  list_dir: 'list_dir',
  search_content: 'grep',
  search_files: 'grep',
  grep: 'grep',
  glob: 'glob',
  find_files: 'glob',
  run_command: 'bash',
  shell: 'bash',
  bash: 'bash',
  delete_path: 'delete_path',
  remove_file: 'delete_path',
  todo_write: 'todo_write',
  ask: 'ask_user',
  ask_choice: 'ask_user',
  ask_user: 'ask_user',
  view_image: 'view_image',
  web_search: 'web_search',
  web_fetch: 'web_fetch',
  fetch: 'web_fetch',
}

/** 内部 id（会话/消息/调用都用它，避免和已有数据撞） */
function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function join(...parts: (string | null | undefined)[]): string {
  return parts
    .filter((part): part is string => Boolean(part && part.trim()))
    .map((part, index) => (index === 0 ? part.replace(/[\\/]+$/, '') : part.replace(/^[\\/]+|[\\/]+$/g, '')))
    .join('\\')
}

/** 项目路径 → 磁盘上的目录名（小写，每个非字母数字字符都换成分隔符） */
export function projectSlug(projectRoot: string): string {
  return projectRoot.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()
}

export interface EnvPaths {
  home?: string | null
  appData?: string | null
}

/** 扫描范围：默认只看这个项目的，放宽后连全局/归档一起看 */
export type ImportScope = 'project' | 'all'

export interface ImportCandidate {
  /** 稳定标识（去重标记用）：源文件绝对路径 */
  key: string
  kind: 'project' | 'legacy' | 'global' | 'archive' | 'local'
  file: string
  /** 元数据旁挂（可能没有） */
  metaFile?: string
  eventsFile?: string
  title: string
  updatedAt: number
}

/* ------------------------------ 读原始消息 ------------------------------ */

interface RawToolCall {
  id?: unknown
  function?: { name?: unknown; arguments?: unknown }
  name?: unknown
  arguments?: unknown
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text
        }
        return ''
      })
      .join('')
  }
  return ''
}

function parseArgs(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') return value as Record<string, unknown>
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
    } catch {
      // 参数不是合法 JSON：留空对象，内容仍在对话里
    }
  }
  return {}
}

function normalizeToolCalls(value: unknown, unknownTools: Set<string>): ToolCall[] {
  if (!Array.isArray(value)) return []
  const calls: ToolCall[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const raw = entry as RawToolCall
    const original = String(raw.function?.name ?? raw.name ?? '').trim()
    if (!original) continue
    const mapped = TOOL_NAME_MAP[original]
    if (!mapped) unknownTools.add(original)
    calls.push({
      id: typeof raw.id === 'string' && raw.id.trim() ? raw.id : newId('call'),
      name: mapped ?? original,
      args: parseArgs(raw.function?.arguments ?? raw.arguments),
    })
  }
  return calls
}

export interface ConversionResult {
  messages: Message[]
  /** 原对话里出现、需要搬过来的附件（按消息挂） */
  pendingImages: { messageId: string; attachment: Attachment; sourceName: string }[]
  /** 没能对应上的工具名（已经标在结果里） */
  unknownTools: string[]
}

/**
 * 原始消息 → 我们的消息。
 * - system 丢掉（我们有自己的系统提示）
 * - assistant 的 `reasoning_content` → `reasoning`，`tool_calls` → `toolCalls`
 * - tool 结果按**位置**和前面的调用配对（老格式没有 tool_call_id）
 * - 认不出的工具：调用名照原样留、结果前面加一行标记
 * - 原始没有可靠时间戳：按顺序递增，保证显示顺序正确
 */
export function convertTranscript(
  raw: unknown[],
  options: { baseTime?: number; attachmentNames?: Set<string> } = {},
): ConversionResult {
  const messages: Message[] = []
  const pendingImages: ConversionResult['pendingImages'] = []
  const unknownTools = new Set<string>()
  const pending: { id: string; name: string }[] = []
  let time = options.baseTime ?? Date.now()

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const role = String(item.role ?? '').trim()
    if (role === 'system') continue
    time += 1000

    if (role === 'assistant') {
      const calls = normalizeToolCalls(item.tool_calls, unknownTools)
      for (const call of calls) pending.push({ id: call.id, name: call.name })
      const reasoning = textOf(item.reasoning_content) || textOf(item.reasoning)
      messages.push({
        id: newId('msg'),
        role: 'assistant',
        content: textOf(item.content),
        createdAt: time,
        ...(reasoning ? { reasoning } : {}),
        ...(calls.length > 0 ? { toolCalls: calls } : {}),
      })
      continue
    }

    if (role === 'tool') {
      const content = textOf(item.content)
      const matched = pending.shift()
      const name = matched?.name ?? String(item.name ?? '').trim()
      const known = Boolean(name) && Boolean(TOOL_NAME_MAP[name])
      // 认不出的工具：内容前面标一行，卡片上仍能看到原名
      const body = name && !known ? `[未识别的工具：${name}]\n${content}` : content
      messages.push({
        id: newId('msg'),
        role: 'tool',
        content: body,
        createdAt: time,
        ...(matched ? { toolCallId: matched.id } : {}),
        ...(name ? { toolName: name } : {}),
      })
      continue
    }

    // user（以及没见过的角色，一律当用户消息，别丢内容）
    const content = textOf(item.content)
    const message: Message = { id: newId('msg'), role: 'user', content, createdAt: time }
    messages.push(message)

    for (const name of options.attachmentNames ?? []) {
      if (!content.includes(name)) continue
      const attachment: Attachment = { id: newId('img'), kind: 'image', name }
      message.attachments = [...(message.attachments ?? []), attachment]
      pendingImages.push({ messageId: message.id, attachment, sourceName: name })
    }
  }

  return { messages, pendingImages, unknownTools: [...unknownTools] }
}

/* -------------------------------- 扫描 -------------------------------- */

async function listFiles(backend: Backend, dir: string): Promise<string[]> {
  try {
    const entries = await backend.list(dir)
    return entries.filter((entry) => entry.kind === 'file').map((entry) => entry.path)
  } catch {
    return []
  }
}

async function readJson(backend: Backend, path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await backend.readFile(path)) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function titleOf(meta: Record<string, unknown> | null, fallback: string): string {
  const candidates = [meta?.topic_title, meta?.title, meta?.summary, meta?.preview]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 60)
  }
  return fallback
}

/** 把某个目录下的会话文件变成候选（顺序：meta → 文件名） */
async function collect(backend: Backend, dir: string, kind: ImportCandidate['kind']): Promise<ImportCandidate[]> {
  const files = await listFiles(backend, dir)
  const candidates: ImportCandidate[] = []
  for (const file of files) {
    const name = file.split(/[\\/]/).pop() ?? file
    if (!name.endsWith('.jsonl') || name.endsWith('.bak')) continue
    // 事件日志不是独立会话：候选挂在同名 transcript 上（由它指过去），否则一条会话会被列两遍
    if (name.endsWith('.events.jsonl')) continue
    const base = file.replace(/\.jsonl$/, '')
    const newMeta = await readJson(backend, `${file}.meta`)
    const oldMeta = await readJson(backend, `${base}.meta.json`)
    const meta = newMeta ?? oldMeta
    const eventsFile = name.endsWith('.events.jsonl') ? file : `${base}.events.jsonl`
    const hasEvents = files.includes(eventsFile)
    const updatedAt =
      typeof meta?.updated_at === 'string'
        ? Date.parse(meta.updated_at) || 0
        : typeof meta?.created_at === 'string'
          ? Date.parse(meta.created_at) || 0
          : 0

    candidates.push({
      key: file,
      kind,
      file,
      ...(newMeta ? { metaFile: `${file}.meta` } : oldMeta ? { metaFile: `${base}.meta.json` } : {}),
      ...(hasEvents ? { eventsFile } : {}),
      title: titleOf(meta, name.replace(/\.jsonl$/, '')),
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    })
  }
  return candidates
}

async function findCaseInsensitive(backend: Backend, dir: string, wanted: string): Promise<string | null> {
  try {
    const entries = await backend.list(dir)
    const hit = entries.find(
      (entry) => entry.kind === 'dir' && entry.name.toLowerCase() === wanted.toLowerCase(),
    )
    return hit?.path ?? null
  } catch {
    return null
  }
}

/**
 * 找候选会话。
 * 默认（`project`）只看这个项目自己的；`all` 时连全局会话、归档、以及老版本 home 一起看。
 */
export async function findImportCandidates(
  backend: Backend,
  paths: EnvPaths,
  projectRoot: string,
  scope: ImportScope = 'project',
): Promise<ImportCandidate[]> {
  const found: ImportCandidate[] = []
  const reasonixHome = paths.appData ? join(paths.appData, 'reasonix') : null
  const slug = projectSlug(projectRoot)

  if (reasonixHome) {
    // 项目级会话：目录名是项目路径的 slug（大小写可能不同，兜底再扫一遍）
    const projectsDir = join(reasonixHome, 'projects')
    const projectDir =
      (await findCaseInsensitive(backend, projectsDir, slug)) ?? join(projectsDir, slug)
    found.push(...(await collect(backend, join(projectDir, 'sessions'), 'project')))

    if (scope === 'all') {
      found.push(...(await collect(backend, join(reasonixHome, 'sessions'), 'global')))
      found.push(...(await collect(backend, join(reasonixHome, 'archive'), 'archive')))
    }
  }

  // 项目目录里的（有些版本把会话放在这里）＋ 老版本 home
  found.push(...(await collect(backend, join(projectRoot, '.reasonix', 'sessions'), 'local')))
  if (paths.home) {
    for (const candidate of await collect(backend, join(paths.home, '.reasonix', 'sessions'), 'legacy')) {
      if (scope === 'all') {
        found.push(candidate)
        continue
      }
      // 老会话的 meta 里可能写了它属于哪个工作区：写着这个项目的才默认带上
      const meta = candidate.metaFile ? await readJson(backend, candidate.metaFile) : null
      const workspace = typeof meta?.workspace === 'string' ? meta.workspace : ''
      if (workspace && projectSlug(workspace) === slug) found.push(candidate)
    }
  }

  return found
}

/* -------------------------------- 读取 -------------------------------- */

/** 读出原始消息数组：新式优先读事件日志里的 replace，老式直接读 transcript */
export async function readRawMessages(backend: Backend, candidate: ImportCandidate): Promise<unknown[]> {
  const sources = candidate.eventsFile ? [candidate.eventsFile, candidate.file] : [candidate.file]
  for (const file of sources) {
    let text: string
    try {
      text = await backend.readFile(file)
    } catch {
      continue
    }
    const rows: unknown[] = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        rows.push(JSON.parse(trimmed))
      } catch {
        // 半行/脏行直接跳过
      }
    }
    // 事件日志：取最后一个 replace 里的完整消息数组
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index] as { type?: unknown; messages?: unknown }
      if (row?.type === 'replace' && Array.isArray(row.messages)) return row.messages
    }
    // transcript：一行一条消息
    if (rows.some((row) => (row as { role?: unknown })?.role)) return rows
  }
  return []
}

/* -------------------------------- 导入 -------------------------------- */

export interface ImportMarker {
  [key: string]: { importedAt: number; sessionId: string }
}

export async function loadImportMarker(backend: Backend): Promise<ImportMarker> {
  const parsed = await readJson(backend, MARKER_FILE)
  return (parsed as ImportMarker | null) ?? {}
}

export async function saveImportMarker(backend: Backend, marker: ImportMarker): Promise<void> {
  try {
    await backend.mkdir(RBC_DIR)
    await backend.writeFile(MARKER_FILE, JSON.stringify(marker, null, 2))
  } catch {
    // 标记写不进去只是下次会重复列出，不影响导入本身
  }
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** 项目 `.reasonix/attachments/` 里的附件名 → 绝对路径 */
export async function listAttachments(backend: Backend, projectRoot: string): Promise<Map<string, string>> {
  const dir = join(projectRoot, '.reasonix', 'attachments')
  const files = await listFiles(backend, dir)
  const out = new Map<string, string>()
  for (const file of files) {
    const name = file.split(/[\\/]/).pop()
    if (name) out.set(name, file)
  }
  return out
}

/**
 * 导入一个会话：转消息 → 图片按统一方式落盘 → 写进 `.rbcode/sessions/`。
 * 返回新会话 id。源文件全程只读。
 */
export async function importCandidate(
  backend: Backend,
  projectRoot: string,
  candidate: ImportCandidate,
): Promise<string> {
  const raw = await readRawMessages(backend, candidate)
  const attachments = await listAttachments(backend, projectRoot)
  const converted = convertTranscript(raw, {
    baseTime: candidate.updatedAt || Date.now(),
    attachmentNames: new Set(attachments.keys()),
  })

  // 图片：读出来交给统一的落盘流程（和粘贴的图完全同一条路）
  for (const pending of converted.pendingImages) {
    const source = attachments.get(pending.sourceName)
    if (!source) continue
    try {
      const file = await backend.readFileBase64?.(source)
      if (!file?.base64) continue
      const ext = pending.sourceName.split('.').pop()?.toLowerCase() ?? 'png'
      const mime = MIME_BY_EXT[ext] ?? 'image/png'
      const saved = await saveImageFile(backend, `data:${mime};base64,${file.base64}`)
      if (saved) Object.assign(pending.attachment, saved)
    } catch {
      // 单张图读不到就跳过
    }
  }

  const messages = stripInlineImages(converted.messages)
  const now = Date.now()
  const session: Session = {
    id: newId('imp'),
    title: `[导入] ${candidate.title}`.slice(0, 80),
    createdAt: candidate.updatedAt || now,
    updatedAt: candidate.updatedAt || now,
    messageCount: messages.length,
    messages,
  }
  await saveSession(backend, session)
  return session.id
}
