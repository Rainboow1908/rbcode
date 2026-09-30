import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import MusicPanel from '../components/MusicPanel.tsx'
import type { Backend } from '../lib/executor/types.ts'
import type { Track } from '../lib/music.ts'
import { enqueue, resetPlayer } from '../lib/musicPlayer.ts'
import { defaultSettings } from '../lib/settings.ts'

const track = (id: string): Track => ({
  id,
  name: `song-${id}`,
  artist: ['A'],
  album: 'Album',
  picId: id,
  lyricId: id,
  source: 'netease',
})

const backend = (): Backend =>
  ({
    kind: 'companion',
    label: '本机执行器',
    capabilities: {},
    // 面板要求「有 musicApi 才算可用」；直链随便给一个能解析成功的
    musicApi: vi.fn(async () => ({ data: { url: 'https://cdn/x.mp3', br: 320, size: 100 } })),
    musicDownload: vi.fn(),
  }) as unknown as Backend

function renderPanel() {
  return render(<MusicPanel backend={backend()} settings={defaultSettings()} />)
}

describe('音乐面板：点赞与跳曲按钮', () => {
  beforeEach(() => {
    localStorage.clear()
    resetPlayer()
  })

  it('点赞按钮能用：点一下 +1 且图标变实心，再点一下取消', () => {
    enqueue([track('1')])
    renderPanel()
    expect(screen.getByText('点赞 0')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('点赞'))
    expect(screen.getByText('点赞 1')).toBeTruthy()
    expect(
      screen.getByLabelText('点赞').querySelector('svg')?.getAttribute('class') ?? '',
    ).toContain('fill-current')

    fireEvent.click(screen.getByLabelText('点赞'))
    expect(screen.getByText('点赞 0')).toBeTruthy()
  })

  it('上一首 / 下一首 图标方向没反：左边是上一首（不转），右边是下一首（转 180°）', () => {
    enqueue([track('1'), track('2')])
    renderPanel()

    // 控制条和底部迷你播放器各有一套，都必须是「上一首不转、下一首转 180°」
    const prevIcons = screen.getAllByLabelText('上一首').map((el) => el.querySelector('svg'))
    const nextIcons = screen.getAllByLabelText('下一首').map((el) => el.querySelector('svg'))
    expect(prevIcons.length).toBeGreaterThan(0)
    expect(nextIcons.length).toBeGreaterThan(0)

    for (const icon of prevIcons) {
      expect(icon?.getAttribute('class') ?? '').not.toContain('rotate-180')
    }
    for (const icon of nextIcons) {
      expect(icon?.getAttribute('class') ?? '').toContain('rotate-180')
    }
  })
})
