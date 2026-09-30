import type { Backend } from './executor/types.ts'
import { t } from './i18n.ts'
import type { Message, UndoRecord } from './types.ts'

/** 撤销快照与回收站都放在工作区下的 .rbcode 目录里（随项目走，不是全局） */
export const RBC_DIR = '.rbcode'
const UNDO_DIR = `${RBC_DIR}/undo`
const TRASH_DIR = `${RBC_DIR}/trash`

/**
 * 从这条用户消息开始、一直到会话末尾，所有可撤销的文件改动 id。
 *
 * 回退到**某一点**时，它后面的每一轮都得跟着退回去 —— 只退一轮的话，
 * 文件内容和对话就对不上了（跨消息回退尤其明显）。
 */
export function undoIdsFromMessage(messages: Message[], messageId: string): string[] {
  const start = messages.findIndex((message) => message.id === messageId)
  if (start === -1) return []
  const ids: string[] = []
  for (let index = start; index < messages.length; index += 1) {
    const id = messages[index].undoId
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/** 撤销对话前，把要丢掉的消息先存进回收站（手工可找回） */
export async function archiveMessages(
  backend: Backend,
  sessionId: string,
  messages: Message[],
): Promise<void> {
  try {
    await backend.mkdir(TRASH_DIR)
    await backend.writeFile(
      `${TRASH_DIR}/${sessionId}-${newId()}.json`,
      JSON.stringify(messages),
    )
  } catch {
    // 存档失败也不挡住撤销
  }
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 记录一次可撤销的文件变更，返回记录 id（失败也不影响主流程） */
export async function pushUndo(
  backend: Backend,
  record: Omit<UndoRecord, 'id' | 'createdAt'>,
): Promise<string> {
  const id = newId()
  const full: UndoRecord = { ...record, id, createdAt: Date.now() }
  try {
    await backend.mkdir(UNDO_DIR)
    await backend.writeFile(`${UNDO_DIR}/${id}.json`, JSON.stringify(full))
  } catch {
    // 快照写不进去时不阻塞操作
  }
  return id
}

export async function loadUndo(backend: Backend, id: string): Promise<UndoRecord | null> {
  try {
    return JSON.parse(await backend.readFile(`${UNDO_DIR}/${id}.json`)) as UndoRecord
  } catch {
    return null
  }
}

export async function dropUndo(backend: Backend, id: string): Promise<void> {
  try {
    await backend.remove(`${UNDO_DIR}/${id}.json`)
  } catch {
    // 忽略
  }
}

/** 撤销一次操作，返回给用户看的结果说明 */
export async function applyUndo(backend: Backend, id: string): Promise<string> {
  const record = await loadUndo(backend, id)
  if (!record)
    throw new Error(
      t(
        '找不到撤销记录（可能已被清理）',
        'Undo record not found (it may have been cleaned up)',
        '找不到復原記錄（可能已被清理）',
        '元に戻す記録が見つかりません（既に削除された可能性があります）',
      ),
    )

  if (record.kind === 'create') {
    await backend.remove(record.path, { recursive: true })
    await dropUndo(backend, id)
    return t(
      `已撤销新建：${record.path}（文件已移除）`,
      `Undid create: ${record.path} (file removed)`,
      `已復原新增：${record.path}（檔案已移除）`,
      `作成を取り消しました: ${record.path}（ファイルを削除しました）`,
    )
  }

  if (record.kind === 'delete') {
    const files = record.files ?? []
    for (const file of files) {
      await backend.writeFile(file.path, file.content)
    }
    await dropUndo(backend, id)
    return t(
      `已恢复被删除的 ${files.length} 个文件：${record.path}`,
      `Restored ${files.length} deleted file(s): ${record.path}`,
      `已還原被刪除的 ${files.length} 個檔案：${record.path}`,
      `削除された ${files.length} 個のファイルを復元しました: ${record.path}`,
    )
  }

  if (record.before === null) {
    await backend.remove(record.path, { recursive: true })
  } else {
    await backend.writeFile(record.path, record.before)
  }
  await dropUndo(backend, id)
  return t(
    `已把 ${record.path} 恢复到修改前的内容`,
    `Restored ${record.path} to its pre-edit content`,
    `已將 ${record.path} 還原到修改前的內容`,
    `${record.path} を変更前の内容に復元しました`,
  )
}

/** 递归收集一个路径下的所有文本文件（用于删除前的快照） */
export async function snapshotTree(
  backend: Backend,
  path: string,
  limit = 4_000_000,
): Promise<{ files: { path: string; content: string }[]; truncated: boolean }> {
  const files: { path: string; content: string }[] = []
  let total = 0
  let truncated = false

  const walk = async (current: string): Promise<void> => {
    if (truncated) return
    let entries
    try {
      entries = await backend.list(current)
    } catch {
      // 不是目录，按单文件处理
      const content = await backend.readFile(current).catch(() => null)
      if (content !== null && total + content.length <= limit) {
        files.push({ path: current, content })
        total += content.length
      } else {
        truncated = true
      }
      return
    }
    if (entries.length === 0) {
      const content = await backend.readFile(current).catch(() => null)
      if (content !== null) files.push({ path: current, content })
      return
    }
    for (const entry of entries) {
      if (truncated) return
      if (entry.kind === 'dir') await walk(entry.path)
      else {
        const content = await backend.readFile(entry.path).catch(() => null)
        if (content === null) {
          truncated = true
          return
        }
        if (total + content.length > limit) {
          truncated = true
          return
        }
        files.push({ path: entry.path, content })
        total += content.length
      }
    }
  }

  await walk(path)
  return { files, truncated }
}
