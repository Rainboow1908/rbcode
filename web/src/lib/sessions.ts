import type { Backend } from './executor/types.ts'
import { RBC_DIR, ensureRbcodeDir } from './rbcode.ts'
import type { Message, Todo, UsageStats } from './types.ts'

const SESSIONS_DIR = `${RBC_DIR}/sessions`
const INDEX_FILE = `${SESSIONS_DIR}/index.json`
/** 删除的会话先放这里，可找回 */
const TRASH_DIR = `${RBC_DIR}/trash`

export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  /** 置顶时间：有值的排在本项目其他会话前面（只影响这一份列表，不动文件） */
  pinnedAt?: number
  /** 从别的会话分叉出来的（侧栏显示一个分叉图标） */
  forkedAt?: number
}

/** 会话排序：置顶的在前（后置顶的更靠上），其余按创建时间 */
function sortMetas(metas: SessionMeta[]): SessionMeta[] {
  return metas.sort((a, b) => {
    const ap = a.pinnedAt ?? 0
    const bp = b.pinnedAt ?? 0
    if (ap !== bp) return bp - ap
    return a.createdAt - b.createdAt
  })
}

export interface Session extends SessionMeta {
  messages: Message[]
  /**
   * 这个会话待办（todo_write 写的）。跟着会话文件一起落盘，
   * 这样刷新页面、切换执行后端之后待办还在。
   */
  todos?: Todo[]
  /** 这个会话累计的用量（缓存命中率、token 等），跟着会话文件一起存 */
  usage?: UsageStats
}

/** 读取会话索引；索引缺失或损坏时，扫目录重建 */
export async function listSessions(backend: Backend): Promise<SessionMeta[]> {
  const fromIndex = await readIndex(backend)
  if (fromIndex.length > 0) return fromIndex
  // index.json 不存在（例如目录是别的模式建的、或早期版本没写索引）时，
  // 直接扫描 .rbcode/sessions 下的会话文件把索引补出来。
  const rebuilt = await rebuildIndex(backend)
  if (rebuilt.length > 0) {
    await writeIndex(backend, rebuilt)
  }
  return rebuilt
}

async function readIndex(backend: Backend): Promise<SessionMeta[]> {
  try {
    const raw = await backend.readFile(INDEX_FILE)
    const parsed = JSON.parse(raw) as SessionMeta[]
    if (!Array.isArray(parsed)) return []
    return sortMetas(parsed.filter((s) => s && typeof s.id === 'string'))
  } catch {
    return []
  }
}

/** 从 .rbcode/sessions/*.json 反推会话索引 */
async function rebuildIndex(backend: Backend): Promise<SessionMeta[]> {
  let entries
  try {
    entries = await backend.list(SESSIONS_DIR)
  } catch {
    return []
  }

  const metas: SessionMeta[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    if (entry.name === 'index.json') continue
    try {
      const session = JSON.parse(await backend.readFile(entry.path)) as Session
      if (!session?.id) continue
      metas.push({
        id: session.id,
        title: session.title || titleFromMessages(session.messages ?? []),
        createdAt: session.createdAt ?? Date.now(),
        updatedAt: session.updatedAt ?? session.createdAt ?? Date.now(),
        messageCount: session.messages?.length ?? 0,
        pinnedAt: session.pinnedAt,
      })
    } catch {
      // 单个文件坏了就跳过
    }
  }
  return sortMetas(metas)
}

async function writeIndex(backend: Backend, metas: SessionMeta[]): Promise<void> {
  await ensureRbcodeDir(backend)
  await backend.writeFile(INDEX_FILE, JSON.stringify(metas, null, 2))
}

export async function loadSession(backend: Backend, id: string): Promise<Session | null> {
  try {
    const raw = await backend.readFile(`${SESSIONS_DIR}/${id}.json`)
    return JSON.parse(raw) as Session
  } catch {
    return null
  }
}

/**
 * 会话目录到底读不读得到。
 * 用来分辨「这个会话文件真的没了」和「整个后端连不上 / 令牌不对」——
 * 后者（例如 companion 重启后换了令牌）如果只报「找不到会话文件」，会非常误导。
 */
export async function sessionsDirReadable(backend: Backend): Promise<boolean> {
  try {
    return await backend.exists(SESSIONS_DIR)
  } catch {
    return false
  }
}

/**
 * 索引写操作串行化：saveSession / deleteSession 都是「读索引 → 改 → 写回」，
 * 多会话同时落盘时可能读到同一份旧索引，后写的会把先写的挤掉
 * —— 那个会话就会从侧栏消失（文件还在，但列表里看不到）。
 */
let indexWriteQueue: Promise<unknown> = Promise.resolve()

function enqueueIndexWrite<T>(task: () => Promise<T>): Promise<T> {
  const next = indexWriteQueue.then(task)
  indexWriteQueue = next.catch(() => undefined)
  return next
}

/** 保存会话并更新索引（同一页面内的写操作排队执行） */
export function saveSession(backend: Backend, session: Session): Promise<SessionMeta[]> {
  return enqueueIndexWrite(() => saveSessionNow(backend, session))
}

async function saveSessionNow(backend: Backend, session: Session): Promise<SessionMeta[]> {
  await ensureRbcodeDir(backend)
  // 保留原有的置顶状态（saveSession 每次都重建 meta，不能把它冲掉）
  const previous = (await listSessions(backend)).find((m) => m.id === session.id)
  const meta: SessionMeta = {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: Date.now(),
    messageCount: session.messages.length,
    pinnedAt: previous?.pinnedAt,
    forkedAt: previous?.forkedAt,
  }
  await backend.writeFile(`${SESSIONS_DIR}/${session.id}.json`, JSON.stringify(session, null, 2))

  const metas = await listSessions(backend)
  // 排序见 sortMetas：置顶在前，其余按创建时间（更新对话不会把它顶到最上面）
  const next = sortMetas([meta, ...metas.filter((m) => m.id !== session.id)])
  await writeIndex(backend, next)
  return next
}

/** 重命名会话（只改标题，不动消息） */
export function renameSession(
  backend: Backend,
  id: string,
  title: string,
): Promise<SessionMeta[]> {
  return enqueueIndexWrite(() => updateMeta(backend, id, { title }))
}

/** 置顶 / 取消置顶（只影响侧栏顺序） */
export function setSessionPinned(
  backend: Backend,
  id: string,
  pinned: boolean,
): Promise<SessionMeta[]> {
  return enqueueIndexWrite(() =>
    updateMeta(backend, id, { pinnedAt: pinned ? Date.now() : undefined }),
  )
}

/** 标记这个会话是从别处分叉出来的（侧栏显示分叉图标） */
export function setSessionForked(backend: Backend, id: string): Promise<SessionMeta[]> {
  return enqueueIndexWrite(() => updateMeta(backend, id, { forkedAt: Date.now() }))
}

/**
 * 只更新会话里的待办（`todo_write` 写的）。
 *
 * 单独走一个通道、并且复用同一条写队列：刷新页面、切换执行后端之后待办还在，
 * 又不会和消息保存互相覆盖。
 */
export function setSessionTodos(backend: Backend, id: string, todos: Todo[]): Promise<void> {
  return enqueueIndexWrite(async () => {
    let session: Session
    try {
      session = JSON.parse(await backend.readFile(`${SESSIONS_DIR}/${id}.json`)) as Session
    } catch {
      return [] // 会话文件还没写过（或读不到）：等下次消息保存时自然带上
    }
    await backend.writeFile(
      `${SESSIONS_DIR}/${id}.json`,
      JSON.stringify({ ...session, todos, updatedAt: Date.now() }, null, 2),
    )
    return []
  }).then(() => undefined)
}

async function updateMeta(
  backend: Backend,
  id: string,
  patch: Partial<SessionMeta>,
): Promise<SessionMeta[]> {
  const metas = await listSessions(backend)
  const next = sortMetas(
    metas.map((meta) => (meta.id === id ? { ...meta, ...patch } : meta)),
  )
  await writeIndex(backend, next)

  // 会话文件里也同步一份，重新扫描索引（rebuildIndex）时才不会把标题/置顶丢掉
  const session = await loadSession(backend, id)
  if (session) {
    const updated = { ...session, ...patch }
    if (patch.pinnedAt === undefined) delete (updated as { pinnedAt?: number }).pinnedAt
    await backend
      .writeFile(`${SESSIONS_DIR}/${id}.json`, JSON.stringify(updated, null, 2))
      .catch(() => undefined)
  }
  return next
}

/** 删除会话并更新索引（同样排队，避免和保存互相覆盖） */
export function deleteSession(backend: Backend, id: string): Promise<SessionMeta[]> {
  return enqueueIndexWrite(() => deleteSessionNow(backend, id))
}

/**
 * 删除会话：先把整份会话快照到 `.rbcode/trash/`，再从列表移走。
 * 这样删错了可以找回（回收站里再点「彻底删除」才真的没）。
 */
async function deleteSessionNow(backend: Backend, id: string): Promise<SessionMeta[]> {
  const session = await loadSession(backend, id)
  if (session) {
    try {
      await backend.mkdir(TRASH_DIR)
      await backend.writeFile(
        `${TRASH_DIR}/${id}.json`,
        JSON.stringify({ ...session, deletedAt: Date.now() }, null, 2),
      )
    } catch {
      // 快照写不进去也照样删，只是找不回来
    }
  }
  try {
    await backend.remove(`${SESSIONS_DIR}/${id}.json`)
  } catch {
    // 文件可能已不存在
  }
  const metas = (await listSessions(backend)).filter((m) => m.id !== id)
  await writeIndex(backend, metas)
  return metas
}

/* --------------------------------- 回收站 --------------------------------- */

export interface TrashedSession extends Session {
  deletedAt: number
}

/** 读回收站（按删除时间倒序） */
export async function listTrash(backend: Backend): Promise<TrashedSession[]> {
  let entries
  try {
    entries = await backend.list(TRASH_DIR)
  } catch {
    return []
  }
  const items: TrashedSession[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(await backend.readFile(entry.path)) as TrashedSession
      if (parsed?.id) items.push(parsed)
    } catch {
      // 坏文件跳过
    }
  }
  return items.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
}

/** 从回收站恢复一个会话 */
export function restoreSession(backend: Backend, id: string): Promise<SessionMeta[]> {
  return enqueueIndexWrite(async () => {
    let raw: string
    try {
      raw = await backend.readFile(`${TRASH_DIR}/${id}.json`)
    } catch {
      throw new Error('回收站里找不到这个会话')
    }
    const parsed = JSON.parse(raw) as TrashedSession
    delete (parsed as { deletedAt?: number }).deletedAt
    await backend.writeFile(`${SESSIONS_DIR}/${id}.json`, JSON.stringify(parsed, null, 2))
    try {
      await backend.remove(`${TRASH_DIR}/${id}.json`)
    } catch {
      // 忽略
    }
    const metas = await listSessions(backend)
    const meta: SessionMeta = {
      id: parsed.id,
      title: parsed.title || titleFromMessages(parsed.messages ?? []),
      createdAt: parsed.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      messageCount: parsed.messages?.length ?? 0,
    }
    const next = sortMetas([meta, ...metas.filter((m) => m.id !== id)])
    await writeIndex(backend, next)
    return next
  })
}

/** 彻底删除（从回收站移除） */
export function purgeTrash(backend: Backend, id: string): Promise<void> {
  return enqueueIndexWrite(async () => {
    try {
      await backend.remove(`${TRASH_DIR}/${id}.json`)
    } catch {
      // 忽略
    }
  })
}

/** 用第一条用户消息生成会话标题 */
export function titleFromMessages(messages: Message[]): string {
  const first = messages.find((m) => m.role === 'user')
  if (!first) return '新会话'
  const line = first.content.replace(/\s+/g, ' ').trim()
  return line.length > 24 ? `${line.slice(0, 24)}…` : line || '新会话'
}
