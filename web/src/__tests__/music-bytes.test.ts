import { describe, expect, it, vi } from 'vitest'
import type { Backend } from '../lib/executor/types.ts'
import { fetchTrackBytes, musicConfig, type Track } from '../lib/music.ts'
import { defaultSettings } from '../lib/settings.ts'

const track: Track = {
  id: 'I3zF+zimNwHd3AtuxmgqABQ==',
  name: 'Wasted',
  artist: ['Juice WRLD'],
  album: 'Wasted',
  picId: 'p1',
  lyricId: 'l1',
  source: 'joox',
}

const config = musicConfig(defaultSettings())

describe('播放兜底：经本机执行器取音频', () => {
  it('base64 解成字节，带上 mime 和大小', async () => {
    const musicDownload = vi.fn(async () => ({
      mime: 'audio/mpeg',
      size: 2048,
      base64: 'AAECAw==',
      name: 'x.mp3',
    }))
    const backend = {
      kind: 'companion',
      label: '本机执行器',
      capabilities: {},
      musicDownload,
    } as unknown as Backend

    const result = await fetchTrackBytes(backend, config, track)
    expect(result?.mime).toBe('audio/mpeg')
    expect([...(result?.bytes ?? [])]).toEqual([0, 1, 2, 3])
    expect(result?.sizeKB).toBe(2)
    // 关键：id 原样传下去（含 + / = 的 base64 形态），编码由 companion 负责
    expect(musicDownload).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'joox', id: track.id }),
    )
  })

  it('没有下载能力（浏览器沙箱）→ 返回 null，不抛错', async () => {
    const backend = {
      kind: 'browser',
      label: '浏览器沙箱',
      capabilities: {},
    } as unknown as Backend
    await expect(fetchTrackBytes(backend, config, track)).resolves.toBeNull()
  })

  it('取失败（上游 503 等）→ 返回 null，交给界面显示原本的错误', async () => {
    const backend = {
      kind: 'companion',
      label: '本机执行器',
      capabilities: {},
      musicDownload: vi.fn(async () => {
        throw new Error('上游返回了错误（HTTP 503）')
      }),
    } as unknown as Backend
    await expect(fetchTrackBytes(backend, config, track)).resolves.toBeNull()
  })
})
