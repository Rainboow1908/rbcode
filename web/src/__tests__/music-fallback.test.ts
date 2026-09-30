import { describe, expect, it, vi } from 'vitest'
import type { Backend } from '../lib/executor/types.ts'
import {
  musicConfig,
  pickBestMatch,
  resolveTrackUrlWithFallback,
  type Track,
} from '../lib/music.ts'
import { defaultSettings } from '../lib/settings.ts'

const config = musicConfig(defaultSettings())

const jooxTrack: Track = {
  id: 'zwNlYcCNhJGKOXqF7HbkEA==',
  name: '琵琶曲',
  artist: ['鄭浩', '冰潔'],
  album: '琵琶曲',
  picId: 'p1',
  lyricId: 'l1',
  source: 'joox',
}

const raw = (track: Track) => ({
  id: track.id,
  name: track.name,
  artist: track.artist,
  album: track.album,
  pic_id: track.picId,
  lyric_id: track.lyricId,
  source: track.source,
})

describe('换源兜底：这个源没版权时换别的源', () => {
  it('joox 给不出直链 → 去网易云找到同一首并解析', async () => {
    const musicApi = vi.fn(async (params: { types: string; source: string }) => {
      if (params.source === 'joox') return { data: { url: '' } }
      if (params.types === 'search') {
        return {
          data: [
            raw({
              id: '3353484168',
              name: '琵琶曲 (DJ筱轩版)',
              artist: ['郑浩Z-Hao', '冰洁'],
              album: '琵琶曲',
              picId: 'p2',
              lyricId: 'l2',
              source: 'netease',
            }),
            raw({
              id: '3330620554',
              name: '琵琶曲',
              artist: ['郑浩Z-Hao', '冰洁'],
              album: '琵琶曲',
              picId: 'p3',
              lyricId: 'l3',
              source: 'netease',
            }),
          ],
        }
      }
      return { data: { url: 'https://cdn/x.mp3', br: 320, size: 2048 } }
    })
    const backend = {
      kind: 'companion',
      label: '本机执行器',
      capabilities: {},
      musicApi,
    } as unknown as Backend

    const result = await resolveTrackUrlWithFallback(backend, config, jooxTrack)
    expect(result.url).toBe('https://cdn/x.mp3')
    expect(result.track.source).toBe('netease')
    // 挑的是「琵琶曲」原版，不是 DJ 版
    expect(result.track.id).toBe('3330620554')
  })

  it('换源也拿不到 → 抛最开始那个错误（界面文案不变）', async () => {
    const musicApi = vi.fn(async (params: { source: string; types: string }) => {
      if (params.types === 'search') return { data: [] }
      return { data: { url: '' } }
    })
    const backend = {
      kind: 'companion',
      label: '本机执行器',
      capabilities: {},
      musicApi,
    } as unknown as Backend

    await expect(resolveTrackUrlWithFallback(backend, config, jooxTrack)).rejects.toThrow(
      '拿不到播放地址',
    )
  })
})

describe('挑最像的一首', () => {
  const target: Track = {
    id: 'x',
    name: '琵琶曲',
    artist: ['郑浩'],
    album: '琵琶曲',
    picId: 'p',
    lyricId: 'l',
    source: 'joox',
  }
  const make = (name: string, artist: string[]): Track => ({
    id: name + artist.join(),
    name,
    artist,
    album: '',
    picId: '',
    lyricId: '',
    source: 'netease',
  })

  it('同名同歌手优先，DJ/伴奏版靠歌手区分', () => {
    const best = pickBestMatch(
      [
        make('琵琶曲 (DJ阿澤版)', ['郑浩']),
        make('琵琶曲 (伴奏)', ['郑浩', '冰洁']),
        make('琵琶曲', ['郑浩', '冰洁']),
        make('须尽欢', ['郑浩']),
      ],
      target,
    )
    expect(best?.name).toBe('琵琶曲')
  })

  it('歌名对不上就直接放弃（宁可报错也不放错歌）', () => {
    expect(pickBestMatch([make('须尽欢', ['郑浩'])], target)).toBeNull()
  })
})
