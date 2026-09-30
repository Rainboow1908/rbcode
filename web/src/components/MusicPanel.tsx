import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Backend } from '../lib/executor/types.ts'
import { useT } from '../lib/i18n.ts'
import {
  type HistoryEntry,
  type LikedEntry,
  type Lyrics,
  type Track,
  activeLyricIndex,
  downloadTrack,
  fetchCoverDataWithFallback,
  fetchTrackBytes,
  fetchLyrics,
  formatTime,
  isLiked,
  loadHistory,
  loadLikes,
  musicConfig,
  resolveTrackUrlWithFallback,
  saveDownloadedTrack,
  saveLikes,
  searchMusic,
  toggleLike,
  trackKey,
} from '../lib/music.ts'
import {
  type PlayMode,
  clearSource,
  cyclePlayMode,
  getAudio,
  playerSnapshot,
  replaceQueue,
  seek,
  setError as setPlayerError,
  setPlaying as setPlayerPlaying,
  setSource,
  setVolume,
  stepIndex,
  subscribePlayer,
} from '../lib/musicPlayer.ts'
import type { AppSettings } from '../lib/types.ts'
import {
  ArrowDownIcon,
  DownloadIcon,
  HeartIcon,
  LoaderIcon,
  PlayIcon,
  RepeatIcon,
  RepeatOneIcon,
  SearchIcon,
  ShuffleIcon,
  SkipIcon,
  StopIcon,
  VolumeIcon,
  VolumeMuteIcon,
} from './icons.tsx'
import Tooltip from './Tooltip.tsx'

type Tab = 'search' | 'likes' | 'history'

interface Props {
  backend: Backend | null
  settings: AppSettings
}

/**
 * 音乐面板。所有请求都经本机执行器（companion）代理，没连时只显示一句提示。
 *
 * 两个视图（手机音乐 App 那种感觉）：
 *   - 列表视图：搜索 + 结果 / 点赞 / 历史 + 底部迷你播放器；
 *   - 详情视图：点迷你播放器（或列表里「正在播放」那首）铺满整个面板。
 * 真正的 `<audio>` 在 `lib/musicPlayer.ts` 里（React 之外），
 * 所以切标签页、切主题都不会断音。
 */
export default function MusicPanel({ backend, settings }: Props) {
  const t = useT()
  // 只按这几个值 memo：否则切主题等任何设置变化都会生成新对象，
  // 让下面的解析 effect 重跑 → 直链被清掉 → 音乐听起来像「停了」
  const config = useMemo(
    () => musicConfig(settings),
    [settings.proxy, settings.musicSource, settings.musicBase, settings.musicQuality],
  )
  const available = Boolean(backend?.musicApi)

  const [tab, setTab] = useState<Tab>('search')
  const [keyword, setKeyword] = useState('')
  const [results, setResults] = useState<Track[]>([])
  const [page, setPage] = useState(1)
  const [searching, setSearching] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  /** 收起时先播完退场动画再卸载（不然动画看不出来） */
  const [detailClosing, setDetailClosing] = useState(false)
  const [downloading, setDownloading] = useState(false)
  /** 静音前的音量，点回来时恢复 */
  const [lastVolume, setLastVolume] = useState(0.8)

  const player = useSyncExternalStore(subscribePlayer, playerSnapshot)
  const current = player.queue[player.index] ?? null
  const currentKey = current ? trackKey(current) : null
  /** 直链只在「属于当前这首」时才算数（见 musicPlayer 里的说明） */
  const src = player.sourceKey && player.sourceKey === currentKey ? player.sourceUrl : null
  const error = player.error
  /** 这首歌是否已经改用「本机取音频」兜底过（同一首只兜底一次） */
  const proxiedFor = useRef<string | null>(null)
  /** 兜底用的本地 blob 地址，换歌 / 卸载时释放 */
  const blobUrl = useRef<string | null>(null)

  const [cover, setCover] = useState<string | null>(null)
  const [lyrics, setLyrics] = useState<Lyrics | null>(null)

  const [likes, setLikes] = useState<LikedEntry[]>(loadLikes)
  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory)

  const lyricsRef = useRef<HTMLDivElement | null>(null)

  /* ------------------------------- 播放一首歌 ------------------------------- */

  const playTrack = (track: Track, list?: Track[]) => {
    const tracks = list && list.length > 0 ? list : [track]
    const index = Math.max(0, tracks.findIndex((item) => trackKey(item) === trackKey(track)))
    // 历史由播放内核统一记录（这样模型用 music 工具点的歌也会进历史）
    replaceQueue(tracks, index, true)
    setPlayerError(null)
  }

  // 换歌（或模型点歌）→ 解析直链
  /** 直链已经解析好、而且就是给这一轮用的：面板重新挂载（切标签页/切布局）时不要再来一遍，
      否则会先 pause + 清直链，听起来就是「音乐被关掉又重解析」 */
  const resolvedFresh =
    Boolean(currentKey) &&
    player.sourceKey === currentKey &&
    Boolean(player.sourceUrl) &&
    player.sourceRevision === player.revision

  useEffect(() => {
    if (!current) return
    if (resolvedFresh) return
    let cancelled = false
    const revision = player.revision
    // 先停掉上一首、清掉旧直链，免得解析期间把旧歌放出来
    getAudio()?.pause()
    clearSource()
    void (async () => {
      try {
        const resolved = await resolveTrackUrlWithFallback(backend, config, current)
        if (!cancelled) {
          setSource({
            url: resolved.url,
            key: trackKey(current),
            br: resolved.br,
            sizeKB: resolved.sizeKB,
            revision,
          })
        }
      } catch (err) {
        if (cancelled) return
        // 直链拿不到（这个源在当前网络下可能要经代理）：改由本机执行器取音频
        const proxied = await fetchTrackBytes(backend, config, current, settings.musicQuality)
        if (cancelled) return
        if (proxied) {
          const url = URL.createObjectURL(new Blob([proxied.bytes], { type: proxied.mime }))
          if (blobUrl.current) URL.revokeObjectURL(blobUrl.current)
          blobUrl.current = url
          proxiedFor.current = trackKey(current)
          setSource({
            url,
            key: trackKey(current),
            br: 0,
            sizeKB: proxied.sizeKB,
            revision,
          })
          setPlayerPlaying(true)
          return
        }
        setPlayerError((err as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
    // revision 变了说明要求「重新播这首」
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, player.revision, resolvedFresh, backend, config])

  /**
   * 播放失败时兜底：直链能拿到、但浏览器直连 CDN 不通（源只在代理/本机下可用）时，
   * 改由本机执行器把音频取回来，用 blob 本地播放。同一首只兜底一次，避免打转。
   */
  useEffect(() => {
    if (!current || !player.error) return
    const key = trackKey(current)
    if (proxiedFor.current === key) return
    proxiedFor.current = key
    let cancelled = false
    void (async () => {
      const proxied = await fetchTrackBytes(backend, config, current, settings.musicQuality)
      if (cancelled || !proxied) return
      const url = URL.createObjectURL(new Blob([proxied.bytes], { type: proxied.mime }))
      if (blobUrl.current) URL.revokeObjectURL(blobUrl.current)
      blobUrl.current = url
      setPlayerError(null)
      setSource({
        url,
        key,
        br: 0,
        sizeKB: proxied.sizeKB,
        revision: playerSnapshot().revision,
      })
      setPlayerPlaying(true)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player.error, current, backend, config])

  // 离开面板时把本地 blob 释放掉
  useEffect(
    () => () => {
      if (blobUrl.current) URL.revokeObjectURL(blobUrl.current)
    },
    [],
  )

  // 封面 + 歌词（拿不到都不影响听歌）
  useEffect(() => {
    if (!current) return
    let cancelled = false
    setCover(null)
    setLyrics(null)
    void fetchCoverDataWithFallback(backend, config, current).then((url) => {
      if (!cancelled) setCover(url)
    })
    void fetchLyrics(backend, config, current)
      .then((data) => {
        if (!cancelled) setLyrics(data)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [current, backend, config])

  const activeIndex = lyrics ? activeLyricIndex(lyrics.lines, player.progress) : -1

  // 换歌时重读历史：模型用 music 工具点的歌也会出现在「历史」页里
  useEffect(() => {
    setHistory(loadHistory())
  }, [player.index, player.revision])

  // 歌词跟着滚动（详情视图里那块）
  useEffect(() => {
    if (!detailOpen || activeIndex < 0) return
    const line = lyricsRef.current?.querySelector<HTMLElement>(`[data-line="${activeIndex}"]`)
    line?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [activeIndex, detailOpen])

  /* --------------------------------- 操作 --------------------------------- */

  const runSearch = async (nextPage = 1) => {
    const text = keyword.trim()
    if (!text) return
    setSearching(true)
    setPlayerError(null)
    try {
      const tracks = await searchMusic(backend, config, text, nextPage)
      setResults((prev) => (nextPage === 1 ? tracks : [...prev, ...tracks]))
      setPage(nextPage)
      setTab('search')
      if (tracks.length === 0 && nextPage === 1) {
        setPlayerError(t('没搜到结果', 'No results', '沒搜到結果'))
      }
    } catch (err) {
      setPlayerError((err as Error).message)
    } finally {
      setSearching(false)
    }
  }

  const togglePlay = () => {
    setPlayerPlaying(!player.playing)
  }

  /** 收起详情：先播完退场动画再真的卸载，不然「展开/收起」没有动画 */
  const closeDetail = () => {
    if (detailClosing) return
    setDetailClosing(true)
    window.setTimeout(() => {
      setDetailOpen(false)
      setDetailClosing(false)
    }, 180)
  }

  const toggleLikeTrack = (track: Track) => {
    setLikes((prev) => {
      const next = toggleLike(prev, track)
      saveLikes(next)
      return next
    })
  }

  const download = async (track: Track) => {
    if (downloading) return
    setDownloading(true)
    setPlayerError(null)
    try {
      const result = await downloadTrack(backend, config, track)
      saveDownloadedTrack(result)
    } catch (err) {
      setPlayerError((err as Error).message)
    } finally {
      setDownloading(false)
    }
  }

  /* --------------------------------- 渲染 --------------------------------- */

  if (!available) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <p className="text-center text-xs leading-relaxed text-neutral-500">
          {t(
            '音乐功能需要连接本机执行器（请求要从你本机发出，浏览器直连会被 CORS 拦）。',
            'Music needs the local executor — requests must come from your machine, and a direct browser call would be blocked by CORS.',
            '音樂功能需要連接本機執行器（請求要從你本機發出，瀏覽器直連會被 CORS 攔）。',
          )}
        </p>
      </div>
    )
  }

  const list =
    tab === 'search' ? results : tab === 'likes' ? likes.map((entry) => entry.track) : history.map((entry) => entry.track)
  const liked = current ? isLiked(likes, current) : false
  const muted = player.volume <= 0.001

  const toggleMute = () => {
    if (muted) {
      setVolume(lastVolume > 0 ? lastVolume : 0.8)
      return
    }
    setLastVolume(player.volume)
    setVolume(0)
  }

  /** 底部那排控制（列表视图和详情视图共用同一份实现） */
  /** 播放模式：顺序 / 单曲循环 / 随机（点一下循环切） */
  const playModeLabel: Record<PlayMode, string> = {
    order: t('顺序播放', 'Play in order', '順序播放'),
    loop: t('单曲循环', 'Repeat one', '單曲循環'),
    shuffle: t('随机播放', 'Shuffle', '隨機播放'),
  }

  const controls = (
    <>
      <input
        type="range"
        min={0}
        max={Math.max(1, player.duration)}
        step={0.5}
        value={player.progress}
        disabled={!src}
        onChange={(event) => seek(Number(event.target.value))}
        className="h-1 w-full accent-amber-500"
      />
      <div className="flex items-center justify-between text-[10px] text-neutral-500">
        <span className="font-mono">{formatTime(player.progress)}</span>
        <span className="font-mono">{formatTime(player.duration)}</span>
      </div>

      {/* 1fr / auto / 1fr：中间那组按内容定宽，两边各占剩余的一半 —— 中间是真的居中，
          而且不会像三等分那样在窄面板里被挤出格子、盖住（点不到）旁边的按钮 */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <div className="flex items-center gap-1 justify-self-start">
          <button
            onClick={() => current && toggleLikeTrack(current)}
            disabled={!current}
            aria-label={t('点赞', 'Like', '點讚')}
            className={`flex h-7 w-7 items-center justify-center rounded transition-colors disabled:opacity-40 ${
              liked ? 'text-rose-400' : 'text-neutral-500 hover:text-neutral-200'
            }`}
          >
            <HeartIcon className={`h-3.5 w-3.5 ${liked ? 'fill-current' : ''}`} />
          </button>

          {/* 播放模式：就在点赞右边，点一下在 顺序 → 单曲循环 → 随机 之间切换 */}
          <Tooltip label={playModeLabel[player.playMode]}>
            <button
              onClick={() => cyclePlayMode()}
              aria-label={playModeLabel[player.playMode]}
              className={`flex h-7 w-7 items-center justify-center rounded transition-colors ${
                player.playMode === 'order'
                  ? 'text-neutral-500 hover:text-neutral-200'
                  : 'text-amber-400 hover:text-amber-200'
              }`}
            >
              {player.playMode === 'shuffle' ? (
                <ShuffleIcon className="h-3.5 w-3.5" />
              ) : player.playMode === 'loop' ? (
                <RepeatOneIcon className="h-3.5 w-3.5" />
              ) : (
                <RepeatIcon className="h-3.5 w-3.5" />
              )}
            </button>
          </Tooltip>
        </div>

        <div className="flex items-center gap-2 justify-self-center">
          <button
            onClick={() => stepIndex(-1)}
            disabled={player.queue.length === 0}
            aria-label={t('上一首', 'Previous', '上一首')}
            className="flex h-7 w-7 items-center justify-center rounded text-neutral-400 transition-colors hover:text-neutral-100 disabled:opacity-40"
          >
            <SkipIcon className="h-4 w-4" />
          </button>
          <button
            onClick={togglePlay}
            disabled={!src}
            aria-label={player.playing ? t('暂停', 'Pause', '暫停') : t('播放', 'Play', '播放')}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-neutral-700 text-neutral-200 transition-colors hover:border-amber-600 hover:text-amber-200 disabled:opacity-40"
          >
            {player.playing ? <StopIcon className="h-4 w-4" /> : <PlayIcon className="h-4 w-4" />}
          </button>
          <button
            onClick={() => stepIndex(1)}
            disabled={player.queue.length === 0}
            aria-label={t('下一首', 'Next', '下一首')}
            className="flex h-7 w-7 items-center justify-center rounded text-neutral-400 transition-colors hover:text-neutral-100 disabled:opacity-40"
          >
            {/* SkipIcon 转了 180° 才是「下一首」（原本竖线在左、三角朝左 = 上一首） */}
            <SkipIcon className="h-4 w-4 rotate-180" />
          </button>
        </div>

        <div className="flex items-center gap-1 justify-self-end">
          {/* 音量就是一个小按钮：点一下静音，再点恢复 */}
          <button
            onClick={toggleMute}
            aria-label={muted ? t('取消静音', 'Unmute', '取消靜音') : t('静音', 'Mute', '靜音')}
            className={`flex h-7 w-7 items-center justify-center rounded transition-colors ${
              muted ? 'text-neutral-600' : 'text-neutral-500 hover:text-neutral-200'
            }`}
          >
            {muted ? <VolumeMuteIcon className="h-3.5 w-3.5" /> : <VolumeIcon className="h-3.5 w-3.5" />}
          </button>
          <button
            onClick={() => current && void download(current)}
            disabled={!current || downloading}
            aria-label={t('下载', 'Download', '下載')}
            className="flex h-7 w-7 items-center justify-center rounded text-neutral-500 transition-colors hover:text-neutral-200 disabled:opacity-40"
          >
            {downloading ? <LoaderIcon className="h-3.5 w-3.5 animate-spin" /> : <DownloadIcon className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
    </>
  )

  /** 歌词：可点（点了跳到那一句）、当前行放大、邻近行略放大、行距拉开 */
  const lyricLines = (
    <div ref={lyricsRef} className="mt-5 pb-6 text-center">
      {lyrics && lyrics.lines.length > 0 ? (
        lyrics.lines.map((line, index) => {
          const distance = index - activeIndex
          const isActive = distance === 0
          const isNear = Math.abs(distance) === 1
          return (
            <button
              type="button"
              key={`${line.time}-${index}`}
              data-line={index}
              onClick={() => seek(line.time / 1000)}
              className={`block w-full px-2 transition-all duration-200 ${
                isActive
                  ? 'py-2.5 text-sm font-medium text-amber-300'
                  : isNear
                    ? 'py-2 text-xs text-neutral-400'
                    : 'py-2 text-[11px] text-neutral-500 hover:text-neutral-300'
              }`}
            >
              {line.text}
              {lyrics.translation[index]?.text ? (
                <span
                  className={`mt-0.5 block ${
                    isActive ? 'text-[11px] text-amber-200/70' : 'text-[10px] text-neutral-600'
                  }`}
                >
                  {lyrics.translation[index].text}
                </span>
              ) : null}
            </button>
          )
        })
      ) : (
        <p className="text-[11px] text-neutral-600">
          {t('这首歌没有歌词', 'No lyrics for this song', '這首歌沒有歌詞')}
        </p>
      )}
    </div>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {detailOpen && current ? (
        /* ------------------------------ 正在播放详情页 ------------------------------ */
        <div
          className={`flex min-h-0 flex-1 flex-col ${
            detailClosing ? 'anim-detail-out' : 'anim-detail'
          }`}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-neutral-800 px-2 py-1.5">
            <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-500">
              {t('正在播放', 'Now playing', '正在播放')}
            </span>
            <button
              onClick={closeDetail}
              aria-label={t('收起', 'Collapse', '收起')}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
            >
              <ArrowDownIcon className="h-4 w-4" />
            </button>
          </div>

          {/* 固定的信息行：封面在左、信息在右。和底部那条一样是独立一块，
              图片/文字不会和歌词叠在一起 */}
          <div className="shrink-0 border-b border-neutral-800 px-3 py-3">
            <div className="flex items-center gap-3">
              <div className="h-20 w-20 shrink-0 overflow-hidden rounded-lg bg-neutral-800">
                {cover ? (
                  <img
                    src={cover}
                    alt=""
                    className="h-full w-full object-cover"
                    // 加载失败就退回占位图（以前会留一个「碎图」图标）
                    onError={() => setCover(null)}
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-neutral-600">
                    <HeartIcon className="h-6 w-6" />
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-neutral-100">{current.name}</div>
                <div className="mt-0.5 truncate text-xs text-neutral-500">
                  {current.artist.join(' / ') || '—'}
                </div>
                {current.album && (
                  <div className="mt-0.5 truncate text-[11px] text-neutral-600">{current.album}</div>
                )}
                <div className="mt-1 text-[10px] text-neutral-600">
                  {current.source}
                  {player.bitrate ? ` · ${player.bitrate} kbps` : ''}
                  {player.sizeKB > 0 ? ` · ${(player.sizeKB / 1024).toFixed(1)} MB` : ''}
                </div>
              </div>
            </div>
            {error && <p className="mt-2 text-[11px] leading-relaxed text-amber-400">{error}</p>}
          </div>

          {/* 只有歌词这块滚动 */}
          <div className="min-h-0 flex-1 overflow-y-auto px-3">
            {lyricLines}
          </div>
        </div>
      ) : (
        /* --------------------------------- 列表视图 --------------------------------- */
        <>
          <div className="shrink-0 space-y-2 border-b border-neutral-800 p-2">
            <div className="flex items-center gap-1.5">
              <input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void runSearch(1)
                }}
                placeholder={t('搜歌 / 歌手 / 专辑', 'Song / artist / album', '搜歌 / 歌手 / 專輯')}
                className="rb-field h-7 min-w-0 flex-1 rounded-md bg-neutral-800/60 px-2 text-xs text-neutral-100 outline-none placeholder:text-neutral-600 focus-visible:ring-1 focus-visible:ring-neutral-600"
              />
              <button
                onClick={() => void runSearch(1)}
                disabled={searching}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-neutral-700 text-neutral-300 transition-colors hover:border-amber-600 hover:text-amber-200 disabled:opacity-50"
              >
                {searching ? <LoaderIcon className="h-3.5 w-3.5 animate-spin" /> : <SearchIcon className="h-3.5 w-3.5" />}
              </button>
            </div>
            <div className="flex items-center gap-1">
              {(
                [
                  ['search', t('搜索', 'Search', '搜尋')],
                  ['likes', t(`点赞 ${likes.length}`, `Likes ${likes.length}`, `點讚 ${likes.length}`)],
                  ['history', t(`历史 ${history.length}`, `History ${history.length}`, `歷史 ${history.length}`)],
                ] as [Tab, string][]
              ).map(([id, title]) => (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
                    tab === id ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'
                  }`}
                >
                  {title}
                </button>
              ))}
            </div>
            {error && <p className="text-[11px] leading-relaxed text-amber-400">{error}</p>}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            {list.length === 0 && (
              <p className="p-3 text-center text-[11px] text-neutral-600">
                {tab === 'search'
                  ? t('搜一下想听的歌', 'Search for something to play', '搜一下想聽的歌')
                  : tab === 'likes'
                    ? t('还没有点赞的歌', 'Nothing liked yet', '還沒有點讚的歌')
                    : t('还没有播放记录', 'No history yet', '還沒有播放記錄')}
              </p>
            )}
            {list.map((track) => {
              const key = trackKey(track)
              const isCurrent = currentKey === key
              return (
                <button
                  key={key}
                  onClick={() => {
                    // 点「正在播放」这首 = 打开详情页，而不是从头再播一遍
                    if (isCurrent) {
                      setDetailOpen(true)
                      return
                    }
                    playTrack(track, tab === 'search' ? results : list)
                  }}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                    isCurrent ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-300 hover:bg-neutral-800/50'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate text-xs">{track.name}</span>
                  <span className="max-w-[45%] shrink-0 truncate text-[11px] text-neutral-500">
                    {track.artist.join(' / ') || '—'}
                  </span>
                  {isLiked(likes, track) && (
                    <HeartIcon className="h-3 w-3 shrink-0 fill-current text-rose-400" />
                  )}
                </button>
              )
            })}
            {tab === 'search' && results.length > 0 && (
              <button
                onClick={() => void runSearch(page + 1)}
                disabled={searching}
                className="mt-1 w-full rounded-md border border-neutral-800 py-1.5 text-[11px] text-neutral-400 transition-colors hover:border-neutral-600 hover:text-neutral-200 disabled:opacity-50"
              >
                {t('加载更多', 'Load more', '載入更多')}
              </button>
            )}
          </div>

          {/* 上半区只放列表；底部那排（曲名 + 进度 + 控制）由外面统一渲染，
              这样展开前后底部完全一致 */}
        </>
      )}

      {/* 底部迷你播放器：列表/详情两个视图完全一样，一直保留 */}
      <div className="shrink-0 space-y-2 border-t border-neutral-800 p-2">
        <button
          onClick={() => {
            if (!current) return
            if (detailOpen) closeDetail()
            else setDetailOpen(true)
          }}
          disabled={!current}
          className="rb-nohover flex w-full items-center gap-2 rounded-md text-left transition-colors hover:bg-neutral-800/40 disabled:cursor-default"
        >
          {cover ? (
            <img
              src={cover}
              alt=""
              className="h-9 w-9 shrink-0 rounded object-cover"
              onError={() => setCover(null)}
            />
          ) : (
            <div className="h-9 w-9 shrink-0 rounded bg-neutral-800" />
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs text-neutral-200">
              {current ? current.name : t('未在播放', 'Nothing playing', '未在播放')}
            </div>
            <div className="truncate text-[10px] text-neutral-500">
              {current ? current.artist.join(' / ') : '—'}
            </div>
          </div>
          {current && <span className="w-2 shrink-0" />}
        </button>
        {controls}
      </div>
    </div>
  )
}
