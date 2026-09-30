import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Backend, MusicApiParams } from '../lib/executor/types.ts'
import type { Track } from '../lib/music.ts'
import { loadHistory } from '../lib/music.ts'
import { defaultSettings } from '../lib/settings.ts'
import type { ToolContext } from '../lib/tools/types.ts'
import { musicTool } from '../lib/tools/music.ts'
import {
  clearQueue,
  clearSource,
  currentTrack,
  enqueue,
  playerSnapshot,
  playIndex,
  resetPlayer,
  setPlaying,
  setSource,
  stepIndex,
  subscribePlayer,
} from '../lib/musicPlayer.ts'

const track = (id: string, name = `song-${id}`): Track => ({
  id,
  name,
  artist: ['A'],
  album: 'Album',
  picId: id,
  lyricId: id,
  source: 'netease',
})

const fakeBackend = (api: (params: MusicApiParams) => Promise<unknown>): Backend =>
  ({ musicApi: vi.fn(api), musicDownload: vi.fn() }) as unknown as Backend

const context = (backend: Backend | null): ToolContext => ({
  backend: backend as Backend,
  getTodos: () => [],
  setTodos: () => {},
  askUser: async () => '(skipped)',
  recordUndo: async () => 'undo',
  getSettings: () => defaultSettings(),
})

describe('播放队列（面板与工具共用）', () => {
  beforeEach(() => resetPlayer())

  it('入队后立刻播第一首新歌，revision 递增', () => {
    enqueue([track('1'), track('2')])
    const state = playerSnapshot()
    expect(state.queue.map((item) => item.id)).toEqual(['1', '2'])
    expect(state.index).toBe(0)
    expect(state.playing).toBe(true)
    expect(state.revision).toBe(1)
    expect(currentTrack()?.id).toBe('1')

    // 追加但不播
    enqueue([track('3')], false)
    expect(playerSnapshot().queue).toHaveLength(3)
    expect(playerSnapshot().index).toBe(0)
  })

  it('上一首 / 下一首循环', () => {
    enqueue([track('1'), track('2'), track('3')])
    playIndex(2)
    expect(currentTrack()?.id).toBe('3')
    stepIndex(1)
    expect(currentTrack()?.id).toBe('1') // 循环回第一首
    stepIndex(-1)
    expect(currentTrack()?.id).toBe('3')
  })

  it('空队列时不会乱跳；清空后也没了', () => {
    expect(stepIndex(1)).toBe(false)
    enqueue([track('1')])
    clearQueue()
    expect(playerSnapshot().queue).toEqual([])
    expect(currentTrack()).toBeNull()
  })

  it('播放状态只在真的变化时通知订阅者', () => {
    const listener = vi.fn()
    const unsubscribe = subscribePlayer(listener)
    enqueue([track('1')]) // 通知一次
    const before = listener.mock.calls.length
    setPlaying(true) // 已经是 true，不该再通知
    expect(listener.mock.calls.length).toBe(before)
    setPlaying(false)
    expect(listener.mock.calls.length).toBe(before + 1)
    unsubscribe()
  })

  it('模型点歌（enqueue）也会记进历史', () => {
    localStorage.clear()
    expect(loadHistory()).toEqual([])

    enqueue([track('1', '稻香')])
    expect(loadHistory().map((entry) => entry.track.name)).toEqual(['稻香'])

    enqueue([track('2', '晴天')], false)
    playIndex(1)
    expect(loadHistory().map((entry) => entry.track.name)).toEqual(['晴天', '稻香'])
  })

  it('记住直链是按哪个 revision 解析的（面板重挂载时据此跳过重解析）', () => {
    enqueue([track('1')])
    const revision = playerSnapshot().revision
    expect(playerSnapshot().sourceRevision).toBe(-1)

    setSource({
      url: 'https://cdn/1.mp3',
      key: 'netease:1',
      br: 320,
      sizeKB: 9550,
      revision,
    })
    expect(playerSnapshot()).toMatchObject({
      sourceKey: 'netease:1',
      sourceUrl: 'https://cdn/1.mp3',
      sourceRevision: revision,
      bitrate: 320,
      sizeKB: 9550,
    })

    clearSource()
    expect(playerSnapshot().sourceKey).toBeNull()
    expect(playerSnapshot().sourceUrl).toBeNull()
    expect(playerSnapshot().sourceRevision).toBe(-1)
  })
})

describe('music 工具', () => {
  beforeEach(() => resetPlayer())

  it('没连本机执行器时给出提示', async () => {
    const bare = {} as unknown as Backend
    const result = await musicTool.run(
      { action: 'search', query: 'x' },
      { ...context(bare) },
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('本机执行器')
  })

  it('search 返回编号列表并提示怎么点歌', async () => {
    const backend = fakeBackend(async () => ({ data: [{ id: '1', name: '稻香', artist: ['周杰伦'] }] }))
    const result = await musicTool.run({ action: 'search', query: '稻香' }, context(backend))
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('1. 周杰伦 - 稻香')
    expect(result.content).toContain('action="play"')
  })

  it('play 把第 index 首加进队列并开始播', async () => {
    const backend = fakeBackend(async () => ({
      data: [
        { id: '1', name: '第一首', artist: ['A'] },
        { id: '2', name: '第二首', artist: ['B'] },
      ],
    }))
    const result = await musicTool.run({ action: 'play', query: 'x', index: 2 }, context(backend))
    expect(result.content).toContain('B - 第二首')
    expect(currentTrack()?.id).toBe('2')
    expect(playerSnapshot().playing).toBe(true)
  })

  it('index 超范围时报错而不是乱播', async () => {
    const backend = fakeBackend(async () => ({ data: [{ id: '1', name: 'only', artist: [] }] }))
    const result = await musicTool.run({ action: 'play', query: 'x', index: 3 }, context(backend))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('超出范围')
  })

  it('queue 列队列 / clear 清空', async () => {
    const backend = fakeBackend(async () => ({ data: [] }))
    enqueue([track('1', '稻香')])

    const listed = await musicTool.run({ action: 'queue' }, context(backend))
    expect(listed.content).toContain('稻香')
    expect(listed.content).toContain('正在播放')

    const cleared = await musicTool.run({ action: 'queue', clear: true }, context(backend))
    expect(cleared.content).toContain('已清空')
    expect(playerSnapshot().queue).toEqual([])
  })

  it('lyrics 不指定歌时用当前播放的', async () => {
    const backend = fakeBackend(async (params) => {
      if (params.types === 'lyric') return { data: { lyric: '[00:01.00]第一句' } }
      return { data: [] }
    })
    enqueue([track('1', '稻香')])

    const result = await musicTool.run({ action: 'lyrics' }, context(backend))
    expect(result.content).toContain('稻香')
    expect(result.content).toContain('第一句')
  })

  it('没有在播且没给 query 时提示要指定歌', async () => {
    const backend = fakeBackend(async () => ({ data: [] }))
    const result = await musicTool.run({ action: 'lyrics' }, context(backend))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('query')
  })
})
