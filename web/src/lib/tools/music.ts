import { t } from '../i18n.ts'
import { fetchLyrics, musicConfig, searchMusic, trackLabel } from '../music.ts'
import { clearQueue, currentTrack, enqueue, playerSnapshot } from '../musicPlayer.ts'
import {
  failure,
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireString,
  text,
  type ToolDef,
} from './types.ts'

/**
 * 音乐面板的工具：模型也能搜歌、点歌（加进右侧音乐面板的播放队列）、查歌词。
 * 和面板共用同一份播放队列（`lib/musicPlayer.ts`），所以点完歌面板里立刻就开始放。
 *
 * 请求仍然只走本机执行器；不是只读工具 —— 计划模式下不出现。
 */
export const musicTool: ToolDef = {
  readOnly: false,
  schema: {
    name: 'music',
    description:
      'Control the built-in music player (the Music panel on the right). Requires the local executor. Actions: "search" lists songs, "play" queues one and starts playing, "lyrics" returns its lyrics, "queue" lists or clears the queue.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'play', 'lyrics', 'queue'],
          description: 'What to do',
        },
        query: { type: 'string', description: 'Song / artist / album name (search, play, lyrics)' },
        source: { type: 'string', description: 'Music source, default netease (joox also works)' },
        index: { type: 'number', description: 'Which search hit to use, 1-based (default 1)' },
        count: { type: 'number', description: 'How many hits for "search" (default 5, max 20)' },
        clear: { type: 'boolean', description: 'For action "queue": clear the queue' },
      },
      required: ['action'],
    },
  },
  async run(args, ctx) {
    if (!ctx.backend?.musicApi) {
      return failure(
        t(
          '音乐功能需要连接本机执行器（请求必须从你本机发出）。',
          'Music needs the local executor — requests must come from your machine.',
          '音樂功能需要連接本機執行器（請求必須從你本機發出）。',
        ),
      )
    }
    const settings = ctx.getSettings?.()
    if (!settings) return failure('Settings are not available.')

    const config = musicConfig(settings)
    const source = optionalString(args, 'source')?.trim()
    if (source) config.source = source

    const action = requireString(args, 'action')
    const query = optionalString(args, 'query')?.trim()
    const count = Math.min(20, Math.max(1, Math.floor(optionalNumber(args, 'count') ?? 5)))
    const index = Math.max(1, Math.floor(optionalNumber(args, 'index') ?? 1))

    // 队列本身不依赖搜索
    if (action === 'queue') {
      if (optionalBoolean(args, 'clear')) {
        clearQueue()
        return text('已清空播放队列。')
      }
      const state = playerSnapshot()
      if (state.queue.length === 0) return text('播放队列是空的。')
      const lines = state.queue.map(
        (track, position) =>
          `${position + 1}. ${trackLabel(track)}${position === state.index ? ` （${t('正在播放', 'now playing', '正在播放')}）` : ''}`,
      )
      return text(`播放队列共 ${state.queue.length} 首：\n${lines.join('\n')}`)
    }

    // 查歌词但没指定歌：用当前播放的这首
    if (action === 'lyrics' && !query) {
      const now = currentTrack()
      if (!now) return failure('现在没有在播放，请用 query 指定一首歌。')
      const { lines } = await fetchLyrics(ctx.backend, config, now)
      return text(
        lines.length > 0
          ? `《${trackLabel(now)}》歌词：\n${lines.map((line) => line.text).join('\n')}`
          : `《${trackLabel(now)}》没有歌词。`,
      )
    }

    if (!query) return failure(`action "${action}" 需要 query 参数。`)

    const hits = await searchMusic(ctx.backend, config, query, 1, Math.max(count, index))
    if (hits.length === 0) return text(`没搜到「${query}」。`)

    if (action === 'search') {
      const lines = hits
        .slice(0, count)
        .map((track, position) => `${position + 1}. ${trackLabel(track)}${track.album ? ` — ${track.album}` : ''}`)
      return text(
        `「${query}」搜到 ${hits.length} 首：\n${lines.join('\n')}\n\n要放哪首就用 action="play" 加 index（比如 index=${index}）。`,
      )
    }

    if (action === 'play') {
      const picked = hits[index - 1]
      if (!picked) return failure(`只有 ${hits.length} 条结果，index=${index} 超出范围。`)
      enqueue([picked], true)
      return text(`已加入播放队列并开始播放：${trackLabel(picked)}`)
    }

    if (action === 'lyrics') {
      const picked = hits[index - 1] ?? hits[0]
      const { lines } = await fetchLyrics(ctx.backend, config, picked)
      return text(
        lines.length > 0
          ? `《${trackLabel(picked)}》歌词：\n${lines.map((line) => line.text).join('\n')}`
          : `《${trackLabel(picked)}》没有歌词。`,
      )
    }

    return failure(`不认识的 action：${action}`)
  },
}
