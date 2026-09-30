import { describe, expect, it, vi } from 'vitest'
import type { Backend } from '../lib/executor/types.ts'
import {
  activeLyricIndex,
  downloadTrack,
  fetchCoverUrl,
  fetchLyrics,
  formatTime,
  isLiked,
  loadHistory,
  loadLikes,
  mergeSources,
  musicConfig,
  normalizeName,
  parseLrc,
  pushHistory,
  rankTracks,
  resolveTrackUrl,
  saveHistory,
  saveLikes,
  searchMusic,
  toTrack,
  toggleLike,
  trackKey,
  trackLabel,
} from '../lib/music.ts'
import type { Track } from '../lib/music.ts'

const track = (name: string, artist: string, id = name): Track => ({
  id,
  name,
  artist: [artist],
  album: '',
  picId: id,
  lyricId: id,
  source: 'netease',
})

describe('搜索排序（上游排序不可靠，这里兜底）', () => {
  it('歌名完全吻合的排第一，翻唱 / 钢琴 / 女声版往后放', () => {
    const list = [
      track('晴天(深情版)', 'Lucky小爱'),
      track('晴天 (女声版))', 'GYBeat'),
      track('晴天 (钢琴版) [原唱: 周杰伦]', '纪钧瀚'),
      track('晴天', '周杰倫'),
      track('晴天 (Live)', '周杰倫'),
      track('江南', '林俊杰'),
    ]
    const ranked = rankTracks('晴天', list)
    expect(ranked[0].name).toBe('晴天')
    expect(ranked[0].artist[0]).toBe('周杰倫')
    for (const name of ['晴天(深情版)', '晴天 (女声版))', '晴天 (钢琴版) [原唱: 周杰伦]']) {
      expect(ranked.findIndex((item) => item.name === name)).toBeGreaterThan(0)
    }
  })

  it('查询里带歌手名时，歌手对得上的加强', () => {
    const list = [track('晴天', 'Lucky小爱'), track('晴天', '周杰伦')]
    expect(rankTracks('晴天 周杰伦', list)[0].artist[0]).toBe('周杰伦')
  })

  it('去掉括号和空白后判断同名', () => {
    expect(normalizeName('晴天 (Live)')).toBe('晴天')
    expect(normalizeName('【晴天】')).toBe('晴天')
  })

  it('多源合并按名次交错并去重（同一首只留先出现的）', () => {
    // B 在两个源都有：交错后 a 的 B 名次更靠前，所以留 a 的那条
    const a = [track('A', 'x', 'a1'), track('B', 'x', 'a2')]
    const b = [track('C', 'x', 'b1'), track('B', 'x', 'b2')]
    const merged = mergeSources([a, b])
    expect(merged.map((item) => item.name)).toEqual(['A', 'C', 'B'])
    expect(merged[2].id).toBe('a2')
  })
})
import { defaultSettings } from '../lib/settings.ts'

const rawTrack = {
  id: '509781655',
  name: '想你就写信 (Live)',
  artist: ['周杰伦', '李硕'],
  album: '中国新歌声第二季 第13期',
  pic_id: '109951163038292176',
  url_id: '509781655',
  lyric_id: '509781655',
  source: 'netease',
}

describe('搜索结果归一', () => {
  it('把上游字段转成 Track（缺 id/name 的丢掉）', () => {
    const track = toTrack(rawTrack)
    expect(track).toMatchObject({
      id: '509781655',
      name: '想你就写信 (Live)',
      artist: ['周杰伦', '李硕'],
      picId: '109951163038292176',
      lyricId: '509781655',
      source: 'netease',
    })
    expect(trackLabel(track!)).toBe('周杰伦 / 李硕 - 想你就写信 (Live)')
    expect(trackKey(track!)).toBe('netease:509781655')

    expect(toTrack({ name: '无 id' })).toBeNull()
    expect(toTrack({ id: 'x' })).toBeNull()
    expect(toTrack(null)).toBeNull()
    // 缺 pic_id / lyric_id 时回落到 id
    expect(toTrack({ id: 'a', name: 'b' })?.picId).toBe('a')
    // artist 是字符串也能收
    expect(toTrack({ id: 'a', name: 'b', artist: 'Solo' })?.artist).toEqual(['Solo'])
  })
})

describe('LRC 解析', () => {
  it('支持多种精度、一行多标签，并按时间排序', () => {
    const lines = parseLrc(
      [
        '[00:00.00] 作词 : 方文山',
        '[00:26.17]第一句',
        '[00:30]第二句',
        '[01:05.5][01:10.500]重复句',
        '没有时间标签的行要忽略',
      ].join('\n'),
    )
    expect(lines.map((line) => line.text)).toEqual(['作词 : 方文山', '第一句', '第二句', '重复句', '重复句'])
    expect(lines[1]).toEqual({ time: 26170, text: '第一句' })
    expect(lines[2]).toEqual({ time: 30000, text: '第二句' })
    expect(lines[3]).toEqual({ time: 65500, text: '重复句' })
    expect(lines[4]).toEqual({ time: 70500, text: '重复句' })
  })

  it('空内容不炸', () => {
    expect(parseLrc('')).toEqual([])
    expect(parseLrc('[00:01.00]   ')).toEqual([])
  })

  it('根据播放进度找当前行', () => {
    const lines = parseLrc('[00:00.00]a\n[00:10.00]b\n[00:20.00]c')
    expect(activeLyricIndex(lines, 0)).toBe(0)
    expect(activeLyricIndex(lines, 9.9)).toBe(0)
    expect(activeLyricIndex(lines, 10)).toBe(1)
    expect(activeLyricIndex(lines, 999)).toBe(2)
    expect(activeLyricIndex([], 5)).toBe(-1)
  })
})

describe('时间格式', () => {
  it('秒 → m:ss', () => {
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(9.7)).toBe('0:09')
    expect(formatTime(65)).toBe('1:05')
    expect(formatTime(-1)).toBe('0:00')
    expect(formatTime(Number.NaN)).toBe('0:00')
  })
})

describe('点赞 / 历史', () => {
  const a = toTrack({ id: '1', name: 'A' })!
  const b = toTrack({ id: '2', name: 'B' })!

  it('点赞可切换、能落盘', () => {
    localStorage.clear()
    expect(loadLikes()).toEqual([])
    const liked = toggleLike([], a)
    expect(liked.map((entry) => entry.track.name)).toEqual(['A'])
    expect(isLiked(liked, a)).toBe(true)
    saveLikes(liked)
    expect(loadLikes().map((entry) => entry.track.name)).toEqual(['A'])
    expect(toggleLike(liked, a)).toEqual([])
    expect(isLiked(liked, b)).toBe(false)
  })

  it('历史最近的在前、同一首去重、能落盘', () => {
    localStorage.clear()
    let history = pushHistory([], a)
    history = pushHistory(history, b)
    history = pushHistory(history, a)
    expect(history.map((entry) => entry.track.name)).toEqual(['A', 'B'])
    saveHistory(history)
    expect(loadHistory().map((entry) => entry.track.name)).toEqual(['A', 'B'])
  })

  it('坏掉的 localStorage 内容不会炸', () => {
    localStorage.setItem('rbcode.music.history', '{ not json')
    localStorage.setItem('rbcode.music.likes', '"nope"')
    expect(loadHistory()).toEqual([])
    expect(loadLikes()).toEqual([])
  })
})

describe('经本机执行器请求', () => {
  const config = musicConfig({ ...defaultSettings(), musicQuality: 320 })

  const backendWith = (api: (params: unknown) => Promise<unknown>): Backend =>
    ({ musicApi: vi.fn(api) }) as unknown as Backend

  it('没连本机执行器时直接报错', async () => {
    await expect(searchMusic(null, config, '周杰伦')).rejects.toThrow('本机执行器')
    await expect(downloadTrack(null, config, toTrack(rawTrack)!)).rejects.toThrow('本机执行器')
  })

  it('搜索：带上源/数量/页码，返回归一后的列表', async () => {
    const api = vi.fn(async () => ({ data: [rawTrack, { garbage: true }] }))
    const tracks = await searchMusic(backendWith(api), config, '周杰伦', 2)
    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({ types: 'search', source: 'netease', name: '周杰伦', pages: 2, count: 24 }),
    )
    expect(tracks).toHaveLength(1)
    expect(tracks[0].name).toBe('想你就写信 (Live)')
  })

  it('取直链：没给 url 时报错', async () => {
    const ok = await resolveTrackUrl(
      backendWith(async () => ({ data: { url: 'https://cdn/x.mp3', br: 320, size: 9550125 } })),
      config,
      toTrack(rawTrack)!,
    )
    expect(ok).toEqual({ url: 'https://cdn/x.mp3', br: 320, sizeKB: 9326 })

    await expect(
      resolveTrackUrl(backendWith(async () => ({ data: {} })), config, toTrack(rawTrack)!),
    ).rejects.toThrow('拿不到播放地址')
  })

  it('歌词：原文 + 翻译都解析', async () => {
    const lyrics = await fetchLyrics(
      backendWith(async () => ({ data: { lyric: '[00:01.00]hello', tlyric: '[00:01.00]你好' } })),
      config,
      toTrack(rawTrack)!,
    )
    expect(lyrics.lines).toEqual([{ time: 1000, text: 'hello' }])
    expect(lyrics.translation).toEqual([{ time: 1000, text: '你好' }])
  })

  it('封面：失败就返回 null，不抛错', async () => {
    expect(
      await fetchCoverUrl(
        backendWith(async () => ({ data: { url: 'https://pic/x.jpg' } })),
        config,
        toTrack(rawTrack)!,
      ),
    ).toBe('https://pic/x.jpg')

    expect(
      await fetchCoverUrl(
        backendWith(async () => {
          throw new Error('上游挂了')
        }),
        config,
        toTrack(rawTrack)!,
      ),
    ).toBeNull()
  })

  it('下载：把「歌手 - 歌名」当文件名传下去', async () => {
    const download = vi.fn(async () => ({ name: 'x.mp3', mime: 'audio/mpeg', size: 1, base64: 'AA==' }))
    const backend = { musicDownload: download } as unknown as Backend
    await downloadTrack(backend, config, toTrack(rawTrack)!)
    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({ types: 'url', id: '509781655', br: 320, name: '周杰伦 / 李硕 - 想你就写信 (Live)' }),
    )
  })

  it('自建 base / 代理会一起带上', async () => {
    const api = vi.fn(async () => ({ data: [] }))
    await searchMusic(
      backendWith(api),
      { ...config, base: 'http://127.0.0.1:3000/api.php', proxy: 'http://127.0.0.1:7897' },
      'x',
    )
    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({ base: 'http://127.0.0.1:3000/api.php', proxy: 'http://127.0.0.1:7897' }),
    )
  })
})
