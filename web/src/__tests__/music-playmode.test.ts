import { beforeEach, describe, expect, it } from 'vitest'
import type { Track } from '../lib/music.ts'
import {
  cyclePlayMode,
  enqueue,
  getAudio,
  playerSnapshot,
  resetPlayer,
  setPlayMode,
  stepIndex,
} from '../lib/musicPlayer.ts'

const track = (id: string): Track => ({
  id,
  name: `song-${id}`,
  artist: ['A'],
  album: 'Album',
  picId: id,
  lyricId: id,
  source: 'netease',
})

describe('播放模式（顺序 / 单曲循环 / 随机）', () => {
  beforeEach(() => resetPlayer())

  it('点一下就在三种模式之间循环，并写进 localStorage', () => {
    expect(playerSnapshot().playMode).toBe('order')

    expect(cyclePlayMode()).toBe('loop')
    expect(playerSnapshot().playMode).toBe('loop')

    expect(cyclePlayMode()).toBe('shuffle')
    expect(playerSnapshot().playMode).toBe('shuffle')

    expect(cyclePlayMode()).toBe('order')
    expect(localStorage.getItem('rbcode.music.playMode')).toBe('order')
  })

  it('顺序模式：下一首按队列走', () => {
    enqueue([track('1'), track('2'), track('3')])
    stepIndex(1)
    expect(playerSnapshot().index).toBe(1)
  })

  it('随机模式：下一首会换成另一首（队列 > 1）', () => {
    enqueue([track('1'), track('2'), track('3'), track('4')])
    setPlayMode('shuffle')
    const before = playerSnapshot().index
    stepIndex(1)
    expect(playerSnapshot().index).not.toBe(before)
  })

  it('随机模式：队列只有一首时原地重放（不报错、不越界）', () => {
    enqueue([track('1')])
    setPlayMode('shuffle')
    stepIndex(1)
    expect(playerSnapshot().index).toBe(0)
  })

  it('单曲循环：ended 重放当前这首，不往下走', () => {
    const element = getAudio()
    expect(element).not.toBeNull()
    enqueue([track('1'), track('2')])
    setPlayMode('loop')

    element?.dispatchEvent(new Event('ended'))

    expect(playerSnapshot().index).toBe(0)
    expect(playerSnapshot().progress).toBe(0)
    expect(playerSnapshot().playing).toBe(true)
  })

  it('顺序模式：ended 走到下一首', () => {
    const element = getAudio()
    expect(element).not.toBeNull()
    enqueue([track('1'), track('2')])

    element?.dispatchEvent(new Event('ended'))

    expect(playerSnapshot().index).toBe(1)
  })
})
