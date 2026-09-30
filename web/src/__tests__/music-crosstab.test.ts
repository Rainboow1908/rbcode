import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../lib/music.ts'

/** 假的 BroadcastChannel：能手动触发「别的标签页开始播」 */
class FakeChannel {
  static instances: FakeChannel[] = []
  listeners: ((event: { data: unknown }) => void)[] = []
  constructor(public name: string) {
    FakeChannel.instances.push(this)
  }
  addEventListener(_type: string, listener: (event: { data: unknown }) => void): void {
    this.listeners.push(listener)
  }
  postMessage(_message: unknown): void {}
  emit(data: unknown): void {
    for (const listener of this.listeners) listener({ data })
  }
}

const track = (id: string): Track => ({
  id,
  name: `song-${id}`,
  artist: ['A'],
  album: 'Album',
  picId: id,
  lyricId: id,
  source: 'netease',
})

describe('跨标签页：同一时刻只在一个页面发声', () => {
  beforeEach(() => {
    FakeChannel.instances = []
    vi.stubGlobal('BroadcastChannel', FakeChannel)
    vi.resetModules()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('别的标签页开始播 → 本页让位（暂停，但队列还在）', async () => {
    const player = await import('../lib/musicPlayer.ts')
    player.resetPlayer()
    player.enqueue([track('1'), track('2')])
    expect(player.playerSnapshot().playing).toBe(true)

    const channel = FakeChannel.instances[0]
    expect(channel).toBeTruthy()
    channel.emit({ type: 'playing' })

    expect(player.playerSnapshot().playing).toBe(false)
    // 队列和位置保留，切回这个标签页还能继续听
    expect(player.playerSnapshot().queue).toHaveLength(2)
    expect(player.playerSnapshot().index).toBe(0)
  })

  it('无关的消息不会打断播放', async () => {
    const player = await import('../lib/musicPlayer.ts')
    player.resetPlayer()
    player.enqueue([track('1')])

    FakeChannel.instances[0].emit({ type: 'something-else' })
    expect(player.playerSnapshot().playing).toBe(true)
  })
})
