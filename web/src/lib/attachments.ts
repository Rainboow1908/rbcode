import type { Backend } from './executor/types.ts'
import type { Attachment, Message } from './types.ts'

/**
 * 图片不再塞进会话文件（base64 会把会话 JSON 撑到几十 MB），改为落到工作区里的
 * `.rbcode/images/`，消息里只留一个引用。
 *
 * 界面和模型仍然照旧按 data URL 用图 —— 差别只在两个边界上：
 *   落盘前把内联数据摘掉（`stripInlineImages`）、载入后再读回来（`hydrateImages`）。
 * 后端不支持二进制写（浏览器沙箱）时全部退回原样，功能不受影响。
 */
export const IMAGES_DIR = '.rbcode/images'

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** `data:image/png;base64,xxx` → `{ mime, base64 }`；不是图片 data URL 就返回 null */
export function parseImageDataUrl(
  dataUrl: string | undefined,
): { mime: string; base64: string } | null {
  if (!dataUrl) return null
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl)
  if (!match) return null
  return { mime: match[1].toLowerCase(), base64: match[2] }
}

/** 内容指纹：同一张图只存一份 */
async function fingerprint(base64: string): Promise<string> {
  try {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
    const hash = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(hash).slice(0, 8))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  } catch {
    // 个别环境没有 crypto.subtle：退回「长度 + 随机」，仍然能存（只是不去重）
    return `${base64.length.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }
}

/**
 * 把一张图片存进 `<项目>/.rbcode/images/`，返回 `{ storedPath, mime }`。
 * 后端不支持二进制写、或写失败时返回 null（调用方保留原样的 data URL）。
 */
export async function saveImageFile(
  backend: Backend,
  dataUrl: string | undefined,
): Promise<Partial<Attachment> | null> {
  const parsed = parseImageDataUrl(dataUrl)
  if (!parsed || !backend.writeFileBase64) return null
  try {
    const ext = EXT_BY_MIME[parsed.mime] ?? 'png'
    const storedPath = `${IMAGES_DIR}/${await fingerprint(parsed.base64)}.${ext}`
    if (!(await backend.exists(storedPath))) {
      await backend.mkdir(IMAGES_DIR)
      await backend.writeFileBase64(storedPath, parsed.base64)
    }
    return { storedPath, mime: parsed.mime }
  } catch {
    return null
  }
}

/** 一批附件：能落盘的落盘，其余原样留着（返回新数组，不改原对象） */
export async function prepareAttachments(
  backend: Backend,
  attachments: Attachment[],
): Promise<Attachment[]> {
  return Promise.all(
    attachments.map(async (attachment) => {
      if (attachment.kind !== 'image' || !attachment.dataUrl || attachment.storedPath) {
        return attachment
      }
      const saved = await saveImageFile(backend, attachment.dataUrl)
      return saved ? { ...attachment, ...saved } : attachment
    }),
  )
}

/** 落盘前：已经有文件引用的附件，把内联 base64 摘掉（会话文件就小了） */
export function stripInlineImages(messages: Message[]): Message[] {
  if (!Array.isArray(messages)) return messages
  return messages.map((message) => {
    const attachments = message.attachments
    if (!attachments?.some((item) => item.storedPath && item.dataUrl)) return message
    return {
      ...message,
      attachments: attachments.map((item) =>
        item.storedPath && item.dataUrl
          ? {
              id: item.id,
              kind: item.kind,
              name: item.name,
              storedPath: item.storedPath,
              mime: item.mime,
              toolCallId: item.toolCallId,
            }
          : item,
      ),
    }
  })
}

/** 载入后：把文件引用读回 data URL（同一个文件只读一次，并发也只读一次） */
export async function hydrateImages(
  backend: Backend,
  messages: Message[],
  /** 进度回调：读第几张 / 共几张（会话里图片多时给界面用） */
  onProgress?: (done: number, total: number) => void,
): Promise<Message[]> {
  const cache = new Map<string, Promise<string | null>>()
  const wanted = new Set<string>()
  for (const message of messages) {
    for (const item of message.attachments ?? []) {
      if (item.storedPath && !item.dataUrl) wanted.add(item.storedPath)
    }
  }
  const total = wanted.size
  let done = 0
  onProgress?.(0, total)

  const read = (path: string): Promise<string | null> => {
    let pending = cache.get(path)
    if (!pending) {
      pending = (async () => {
        try {
          const file = await backend.readFileBase64?.(path)
          const ext = path.split('.').pop()?.toLowerCase() ?? ''
          if (file?.base64) {
            return `data:${MIME_BY_EXT[ext] ?? 'image/png'};base64,${file.base64}`
          }
        } catch {
          // 读不到就当没有
        }
        return null
      })().then((value) => {
        done += 1
        onProgress?.(done, total)
        return value
      })
      cache.set(path, pending)
    }
    return pending
  }

  return Promise.all(
    messages.map(async (message) => {
      const attachments = message.attachments
      if (!attachments?.some((item) => item.storedPath && !item.dataUrl)) return message
      return {
        ...message,
        attachments: await Promise.all(
          attachments.map(async (item) => {
            if (!item.storedPath || item.dataUrl) return item
            const dataUrl = await read(item.storedPath)
            return dataUrl ? { ...item, dataUrl } : item
          }),
        ),
      }
    }),
  )
}
