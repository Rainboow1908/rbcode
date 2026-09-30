import { describe, expect, it, vi } from 'vitest'
import type { Backend } from '../lib/executor/types.ts'
import {
  hydrateImages,
  parseImageDataUrl,
  prepareAttachments,
  saveImageFile,
  stripInlineImages,
} from '../lib/attachments.ts'
import type { Message } from '../lib/types.ts'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='

function makeBackend(overrides: Record<string, unknown> = {}): Backend {
  return {
    kind: 'companion',
    label: '本机执行器',
    capabilities: {},
    exists: vi.fn(async () => false),
    mkdir: vi.fn(async () => {}),
    writeFileBase64: vi.fn(async () => ({ bytes: 4 })),
    readFileBase64: vi.fn(async () => ({ base64: 'AAAA', size: 3 })),
    ...overrides,
  } as unknown as Backend
}

const message = (attachments?: Message['attachments']): Message =>
  ({ id: 'm1', role: 'user', content: 'hi', createdAt: 0, attachments }) as Message

describe('data URL 解析', () => {
  it('认得图片，不认别的', () => {
    expect(parseImageDataUrl(PNG)).toEqual({
      mime: 'image/png',
      base64: 'iVBORw0KGgoAAAANSUhEUg==',
    })
    expect(parseImageDataUrl('data:image/jpeg;base64,AAAA')?.mime).toBe('image/jpeg')
    expect(parseImageDataUrl('data:text/plain;base64,AAAA')).toBeNull()
    expect(parseImageDataUrl('https://x/a.png')).toBeNull()
    expect(parseImageDataUrl(undefined)).toBeNull()
  })
})

describe('图片落盘到 .rbcode/images', () => {
  it('按内容指纹命名，重复的图只写一次', async () => {
    const backend = makeBackend()
    const saved = await saveImageFile(backend, PNG)

    expect(saved?.mime).toBe('image/png')
    expect(saved?.storedPath).toMatch(/^\.rbcode\/images\/[0-9a-f]+\.png$/)
    expect(backend.mkdir).toHaveBeenCalledWith('.rbcode/images')
    expect(backend.writeFileBase64).toHaveBeenCalledWith(saved?.storedPath, 'iVBORw0KGgoAAAANSUhEUg==')

    // 同一张图：第二遍发现文件已存在，不再重复写
    const again = makeBackend({ exists: vi.fn(async () => true) })
    await saveImageFile(again, PNG)
    expect(again.writeFileBase64).not.toHaveBeenCalled()
  })

  it('后端不支持二进制写（浏览器沙箱）就原样返回 null', async () => {
    const backend = makeBackend({ writeFileBase64: undefined })
    expect(await saveImageFile(backend, PNG)).toBeNull()
  })

  it('prepareAttachments 只动图片，其它附件原样保留', async () => {
    const backend = makeBackend()
    const list = await prepareAttachments(backend, [
      { id: 'a', kind: 'image', name: 'shot.png', dataUrl: PNG },
      { id: 'b', kind: 'file', name: 'note.txt', path: 'note.txt' },
    ])
    expect(list[0].storedPath).toBeTruthy()
    expect(list[0].dataUrl).toBe(PNG) // 内存里仍然带 data URL，界面和模型照旧
    expect(list[1]).toEqual({ id: 'b', kind: 'file', name: 'note.txt', path: 'note.txt' })
  })
})

describe('会话文件只留引用', () => {
  it('已经有文件引用的附件，落盘前把内联 base64 摘掉', () => {
    const stripped = stripInlineImages([
      message([
        { id: 'a', kind: 'image', name: 'shot.png', dataUrl: PNG, storedPath: '.rbcode/images/x.png', mime: 'image/png' },
        { id: 'b', kind: 'image', name: 'inline.png', dataUrl: PNG },
      ]),
    ])
    expect(stripped[0].attachments?.[0].dataUrl).toBeUndefined()
    expect(stripped[0].attachments?.[0].storedPath).toBe('.rbcode/images/x.png')
    // 没能落盘的那张仍然带内联数据（老会话也照旧能显示）
    expect(stripped[0].attachments?.[1].dataUrl).toBe(PNG)
  })

  it('没有图片的消息不重建对象', () => {
    const plain = message()
    expect(stripInlineImages([plain])[0]).toBe(plain)
  })

  it('载入时把引用读回 data URL，同一个文件只读一次', async () => {
    const readFileBase64 = vi.fn(async () => ({ base64: 'AAAA', size: 3 }))
    const backend = makeBackend({ readFileBase64 })
    const hydrated = await hydrateImages(backend, [
      message([
        { id: 'a', kind: 'image', name: 'shot.png', storedPath: '.rbcode/images/x.png', mime: 'image/png' },
        { id: 'b', kind: 'image', name: 'same.png', storedPath: '.rbcode/images/x.png', mime: 'image/png' },
      ]),
    ])
    expect(hydrated[0].attachments?.[0].dataUrl).toBe('data:image/png;base64,AAAA')
    expect(hydrated[0].attachments?.[1].dataUrl).toBe('data:image/png;base64,AAAA')
    expect(readFileBase64).toHaveBeenCalledTimes(1)
  })

  it('文件读不到就保持原样（不炸、也不清空引用）', async () => {
    const backend = makeBackend({
      readFileBase64: vi.fn(async () => {
        throw new Error('gone')
      }),
    })
    const hydrated = await hydrateImages(backend, [
      message([{ id: 'a', kind: 'image', name: 'x.png', storedPath: '.rbcode/images/x.png' }]),
    ])
    expect(hydrated[0].attachments?.[0].dataUrl).toBeUndefined()
    expect(hydrated[0].attachments?.[0].storedPath).toBe('.rbcode/images/x.png')
  })
})
