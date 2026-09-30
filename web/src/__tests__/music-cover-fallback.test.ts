import { describe, expect, it, vi } from 'vitest'
import type { Backend } from '../lib/executor/types.ts'
import { fetchCoverDataWithFallback, musicConfig, type Track } from '../lib/music.ts'
import { defaultSettings } from '../lib/settings.ts'

const config = musicConfig(defaultSettings())

const jooxTrack: Track = {
  id: 'zwNlYcCNhJGKOXqF7HbkEA==',
  name: '琵琶曲',
  artist: ['鄭浩', '冰潔'],
  album: '琵琶曲',
  picId: '49a5ea5d0a259514',
  lyricId: 'l1',
  source: 'joox',
}

const neteaseHit = {
  id: '3330620554',
  name: '琵琶曲',
  artist: ['郑浩Z-Hao', '冰洁'],
  album: '琵琶曲',
  pic_id: '109951173179274574',
  lyric_id: '3330620554',
  source: 'netease',
}

describe('封面换源兜底', () => {
  it('本机能代理时：取回 joox 封面（data URL）就直接用', async () => {
    const backend = {
      kind: 'companion',
      label: '本机执行器',
      capabilities: {},
      musicCover: vi.fn(async () => ({ mime: 'image/jpeg', size: 100, base64: 'AAAA' })),
      musicApi: vi.fn(),
    } as unknown as Backend

    const cover = await fetchCoverDataWithFallback(backend, config, jooxTrack)
    expect(cover).toBe('data:image/jpeg;base64,AAAA')
  })

  it('没法代理（老版执行器）→ 换源拿网易云图床的封面（浏览器直连也没问题）', async () => {
    const musicApi = vi.fn(async (params: { types: string; source: string }) => {
      if (params.types === 'search' && params.source === 'netease') return { data: [neteaseHit] }
      if (params.types === 'pic' && params.source === 'netease') {
        return { data: { url: 'https://p2.music.126.net/x/109951173179274574.jpg?param=300y300' } }
      }
      // joox 的 pic 接口给出直链，但那个图床浏览器直连会被拒
      return { data: { url: 'https://image.joox.com/JOOXcover/0/49a5ea5d0a259514/300' } }
    })
    const backend = {
      kind: 'companion',
      label: '本机执行器',
      capabilities: {},
      musicApi,
    } as unknown as Backend

    const cover = await fetchCoverDataWithFallback(backend, config, jooxTrack)
    expect(cover).toBe('https://p2.music.126.net/x/109951173179274574.jpg?param=300y300')
  })

  it('换源也找不到同一首 → 返回原本的（哪怕是直链），不抛错', async () => {
    const musicApi = vi.fn(async (params: { types: string }) =>
      params.types === 'search' ? { data: [] } : { data: { url: 'https://image.joox.com/x.jpg' } },
    )
    const backend = {
      kind: 'companion',
      label: '本机执行器',
      capabilities: {},
      musicApi,
    } as unknown as Backend

    const cover = await fetchCoverDataWithFallback(backend, config, jooxTrack)
    expect(cover).toBe('https://image.joox.com/x.jpg')
  })
})
