import { describe, expect, it, vi } from 'vitest'
import type { Backend } from '../lib/executor/types.ts'
import { musicConfig, fetchCoverData } from '../lib/music.ts'
import { defaultSettings } from '../lib/settings.ts'
import type { Track } from '../lib/music.ts'

const track: Track = {
  id: '9',
  name: 'Wasted',
  artist: ['Juice WRLD'],
  album: 'Goodbye',
  picId: 'pic-9',
  lyricId: '9',
  source: 'joox',
}

const config = musicConfig(defaultSettings())

function backendWith(musicCover?: unknown, musicApi?: unknown): Backend {
  return {
    kind: 'companion',
    label: '本机执行器',
    capabilities: {},
    ...(musicCover ? { musicCover } : {}),
    ...(musicApi ? { musicApi } : {}),
  } as unknown as Backend
}

describe('封面：优先走本机执行器', () => {
  it('companion 有 music.cover 时用 data URL（不再让浏览器直连图床）', async () => {
    const musicCover = vi.fn(async () => ({ mime: 'image/jpeg', size: 1234, base64: 'AAAA' }))
    const url = await fetchCoverData(backendWith(musicCover), config, track)

    expect(url).toBe('data:image/jpeg;base64,AAAA')
    // 走的是本机执行器，而不是让浏览器直连图床
    expect(musicCover).toHaveBeenCalled()
  })

  it('取回来没有 base64（比如这首歌没封面）→ 返回 null', async () => {
    const url = await fetchCoverData(backendWith(vi.fn(async () => ({ mime: '', size: 0, base64: '' }))), config, track)
    expect(url).toBeNull()
  })

  it('companion 取失败 → 退回直链，至少不报错', async () => {
    const musicApi = vi.fn(async () => ({ data: { url: 'https://image.example/cover.jpg' } }))
    const musicCover = vi.fn(async () => {
      throw new Error('上游返回了错误（HTTP 503）')
    })
    const url = await fetchCoverData(backendWith(musicCover, musicApi), config, track)
    expect(url).toBe('https://image.example/cover.jpg')
  })

  it('老版本 companion 没有 music.cover → 直接用直链', async () => {
    const musicApi = vi.fn(async () => ({ data: { url: 'https://image.example/old.jpg' } }))
    const url = await fetchCoverData(backendWith(undefined, musicApi), config, track)
    expect(url).toBe('https://image.example/old.jpg')
  })
})
