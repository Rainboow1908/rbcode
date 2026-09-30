import type { Backend, MusicApiParams, MusicDownloadResult } from './executor/types.ts'
import type { AppSettings } from './types.ts'

/**
 * 音乐面板的数据层。
 *
 * 所有请求都经**本机执行器**（companion）代理：浏览器直连第三方音乐 API 会被 CORS 拦，
 * 而且产品上要求「音乐只能通过本机执行器使用」。没连 companion 时这里会直接报错。
 */

/** 上游返回的一首歌（字段名照搬上游接口） */
export interface Track {
  id: string
  name: string
  artist: string[]
  album: string
  picId: string
  lyricId: string
  source: string
}

/** 一行歌词 */
export interface LyricLine {
  /** 毫秒 */
  time: number
  text: string
}

/** 设置里跟音乐有关的几项 */
export interface MusicConfig {
  source: string
  /** 空 = 用 companion 内置的默认地址 */
  base: string
  quality: number
  proxy: string
}

export function musicConfig(settings: AppSettings): MusicConfig {
  return {
    source: settings.musicSource || 'auto',
    base: settings.musicBase ?? '',
    quality: settings.musicQuality || 320,
    proxy: settings.proxy ?? '',
  }
}

/** 「自动」模式下按这个顺序搜并合并 */
const AUTO_SOURCES = ['joox', 'netease']

/** 名字里带这些字眼的，基本是翻唱 / 伴奏 / 改版 —— 排序时降权 */
const COVER_MARKERS = [
  'cover',
  '翻唱',
  '原唱',
  'remix',
  '伴奏',
  '纯音乐',
  '钢琴',
  '吉他',
  '女声',
  '男声',
  '深情',
  '伤感',
  '加速',
  '慢速',
  '完整版',
  'dj',
  'live',
]

/** 去掉括号内容、空白与大小写差异，用来判断「是不是同一首歌名」 */
export function normalizeName(value: string): string {
  const clean = (text: string) =>
    text.replace(/[\s·、,，.。!！?？'"“”‘’\-_/（）()\[\]【】]/g, '').trim()

  const lowered = value.toLowerCase()
  const withoutBrackets = clean(lowered.replace(/[（(\[【][^）)\]】]*[）)\]】]/g, ''))
  if (withoutBrackets) return withoutBrackets
  // 整个歌名都裹在括号里（比如「【晴天】」）时退一步：只去掉括号本身
  return clean(lowered)
}

/**
 * 关键词相关性重排（稳定排序）。
 *
 * 上游的排序对「只输歌名」很不友好：搜「晴天」返回的前 24 条全是翻唱，原唱在第 51 条。
 * 这里做三件事：① 歌名完全吻合的顶上来；② 带翻唱/伴奏/DJ 之类字眼的往后放；
 * ③ 查询里带了歌手名时，歌手对得上的加强。
 */
export function rankTracks(query: string, tracks: Track[]): Track[] {
  const wanted = normalizeName(query)
  const loweredQuery = query.toLowerCase()

  const score = (track: Track): number => {
    const name = normalizeName(track.name)
    let value = 0

    if (wanted && name === wanted) value += 4
    else if (wanted && name.startsWith(wanted)) value += 2

    const rawName = track.name.toLowerCase()
    if (COVER_MARKERS.some((marker) => rawName.includes(marker))) value -= 3

    if (
      track.artist.some((artist) => artist.trim().length >= 2 && loweredQuery.includes(artist.toLowerCase()))
    ) {
      value += 2
    }
    return value
  }

  return tracks
    .map((track, index) => ({ track, index, score: score(track) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.track)
}

/** 合并多个源的结果：按名次交错，再按 歌名+歌手 去重 */
export function mergeSources(lists: Track[][]): Track[] {
  const merged: Track[] = []
  const seen = new Set<string>()
  const depth = Math.max(0, ...lists.map((list) => list.length))

  for (let position = 0; position < depth; position += 1) {
    for (const list of lists) {
      const track = list[position]
      if (!track) continue
      const key = `${normalizeName(track.name)}|${track.artist.join('/').toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(track)
    }
  }
  return merged
}

/* ---------------------------------- 纯函数 ---------------------------------- */

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 上游一条搜索结果 → Track（拿不到 id / name 就丢掉） */
export function toTrack(raw: unknown): Track | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const id = str(item.id)
  const name = str(item.name)
  if (!id || !name) return null

  const artists = Array.isArray(item.artist)
    ? item.artist.filter(
        (value): value is string => typeof value === 'string' && value.trim() !== '',
      )
    : str(item.artist)
      ? [str(item.artist)]
      : []

  return {
    id,
    name,
    artist: artists,
    album: str(item.album),
    picId: str(item.pic_id) || id,
    lyricId: str(item.lyric_id) || id,
    source: str(item.source) || 'netease',
  }
}

/** 点赞 / 历史用的稳定 key */
export function trackKey(track: Track): string {
  return `${track.source}:${track.id}`
}

/** 展示用「歌手 - 歌名」 */
export function trackLabel(track: Track): string {
  const artists = track.artist.join(' / ')
  return artists ? `${artists} - ${track.name}` : track.name
}

/** 秒 → m:ss */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * 解析 LRC。兼容 `[mm:ss]` / `[mm:ss.x]` / `[mm:ss.xx]` / `[mm:ss.xxx]`，
 * 一行多个时间标签、乱序都能处理；没有时间标签的行（作词/作曲之类）直接忽略。
 */
export function parseLrc(raw: string): LyricLine[] {
  const pattern = () => /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
  const lines: LyricLine[] = []

  for (const rawLine of raw.split(/\r?\n/)) {
    const matches = [...rawLine.matchAll(pattern())]
    if (matches.length === 0) continue
    const text = rawLine.replace(pattern(), '').trim()
    if (!text) continue

    for (const match of matches) {
      const minutes = Number(match[1])
      const seconds = Number(match[2])
      const fractionText = match[3] ?? ''
      const fraction = fractionText ? Number(`0.${fractionText}`) : 0
      lines.push({ time: Math.round((minutes * 60 + seconds + fraction) * 1000), text })
    }
  }

  return lines.sort((a, b) => a.time - b.time)
}

/** 当前播放到第几行（没有就 -1） */
export function activeLyricIndex(lines: LyricLine[], seconds: number): number {
  if (lines.length === 0) return -1
  const ms = seconds * 1000
  let index = -1
  for (const [position, line] of lines.entries()) {
    if (line.time <= ms) index = position
    else break
  }
  return index
}

/* ----------------------------------- 请求 ----------------------------------- */

function baseParams(config: MusicConfig): MusicApiParams {
  const params: MusicApiParams = { source: config.source, types: 'search' }
  if (config.base) params.base = config.base
  if (config.proxy) params.proxy = config.proxy
  return params
}

async function callApi(backend: Backend | null, params: MusicApiParams): Promise<unknown> {
  if (!backend?.musicApi) {
    throw new Error('音乐功能需要连接本机执行器（请求要从你本机发出）。')
  }
  const { data } = await backend.musicApi(params)
  return data
}

export async function searchMusic(
  backend: Backend | null,
  config: MusicConfig,
  keyword: string,
  page = 1,
  count = 24,
): Promise<Track[]> {
  // 「自动」= 同时搜多个源再合并：单靠 netease 的话「晴天」这类只输歌名的查询，
  // 原唱会被一堆翻唱压到很后面（实测原唱在第 51 条）。
  const sources = config.source === 'auto' ? AUTO_SOURCES : [config.source]

  const lists = await Promise.all(
    sources.map(async (source) => {
      const data = await callApi(backend, {
        ...baseParams(config),
        types: 'search',
        source,
        name: keyword,
        count,
        pages: page,
      })
      const list = Array.isArray(data) ? data : []
      return list.map(toTrack).filter((track): track is Track => track !== null)
    }),
  )

  const merged = sources.length > 1 ? mergeSources(lists) : (lists[0] ?? [])
  return rankTracks(keyword, merged)
}

export interface TrackSource {
  url: string
  /** 实际返回的音质 */
  br: number
  /** 文件大小（KB） */
  sizeKB: number
}

export async function resolveTrackUrl(
  backend: Backend | null,
  config: MusicConfig,
  track: Track,
  br?: number,
): Promise<TrackSource> {
  const data = await callApi(backend, {
    ...baseParams(config),
    types: 'url',
    source: track.source,
    id: track.id,
    br: br ?? config.quality,
  })
  const item = (data ?? {}) as Record<string, unknown>
  const url = str(item.url)
  if (!url) throw new Error('拿不到播放地址（可能没版权或需要会员）')
  return {
    url,
    br: Number(item.br) || 0,
    // 上游的 size 是**字节**（320kbps 的一首歌约 7–8MB），界面按 KB / MB 展示
    sizeKB: Math.round((Number(item.size) || 0) / 1024),
  }
}

/** 只搜一个源（换源兜底用） */
async function searchOneSource(
  backend: Backend | null,
  config: MusicConfig,
  source: string,
  keyword: string,
  count = 8,
): Promise<Track[]> {
  const data = await callApi(backend, {
    ...baseParams(config),
    types: 'search',
    source,
    name: keyword,
    count,
    pages: 1,
  })
  const list = Array.isArray(data) ? data : []
  return list.map(toTrack).filter((track): track is Track => track !== null)
}

/** 歌名/歌手归一化（换源匹配用）：去掉空白与常见标点，忽略大小写 */
function trackMatchKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s\-_()（）[\]【】·.,，、'"“”!！?？]/g, '')
}

/**
 * 换源兜底时挑最像的一首：歌名要对得上（完全相同 > 互相包含），歌手命中再加分。
 * 有多个版本（DJ 版 / 伴奏 / 翻唱）时靠歌手名把原版挑出来。
 */
export function pickBestMatch(candidates: Track[], target: Track): Track | null {
  const wanted = trackMatchKey(target.name)
  if (!wanted) return null
  const artists = new Set(target.artist.map(trackMatchKey).filter(Boolean))
  let best: { track: Track; score: number } | null = null
  for (const candidate of candidates) {
    const name = trackMatchKey(candidate.name)
    if (!name) continue
    const nameScore = name === wanted ? 3 : name.includes(wanted) || wanted.includes(name) ? 2 : 0
    if (nameScore === 0) continue
    const artistScore = candidate.artist.some((item) => artists.has(trackMatchKey(item))) ? 2 : 0
    const score = nameScore + artistScore
    if (!best || score > best.score) best = { track: candidate, score }
  }
  return best && best.score >= 2 ? best.track : null
}

/**
 * 取播放地址（带换源兜底）。
 *
 * 上游经常出现「这个源给不出这一首」（没版权 / 区域限制 / 要会员），但**别的源有** ——
 * 这时用「歌名 + 歌手」到其他源再找一次同一首并解析，而不是直接报错。
 * 全都失败才把最初的错误抛出去（报错文案保持原样）。
 */
export async function resolveTrackUrlWithFallback(
  backend: Backend | null,
  config: MusicConfig,
  track: Track,
  br?: number,
): Promise<TrackSource & { track: Track }> {
  const wanted = br ?? config.quality
  try {
    return { ...(await resolveTrackUrl(backend, config, track, wanted)), track }
  } catch (err) {
    const keyword = [track.name, track.artist[0] ?? ''].filter(Boolean).join(' ')
    for (const source of AUTO_SOURCES) {
      if (source === track.source) continue
      let candidates: Track[] = []
      try {
        candidates = await searchOneSource(backend, config, source, keyword)
      } catch {
        continue
      }
      const best = pickBestMatch(candidates, track)
      if (!best) continue
      try {
        return { ...(await resolveTrackUrl(backend, config, best, wanted)), track: best }
      } catch {
        // 这个源也不行，继续试下一个
      }
    }
    throw err
  }
}

export interface Lyrics {
  lines: LyricLine[]
  /** 中文翻译（不一定有） */
  translation: LyricLine[]
}

export async function fetchLyrics(
  backend: Backend | null,
  config: MusicConfig,
  track: Track,
): Promise<Lyrics> {
  const data = await callApi(backend, {
    ...baseParams(config),
    types: 'lyric',
    source: track.source,
    id: track.lyricId,
  })
  const item = (data ?? {}) as Record<string, unknown>
  return {
    lines: parseLrc(str(item.lyric)),
    translation: parseLrc(str(item.tlyric)),
  }
}

/**
 * 经本机执行器把整首歌取回来（用于播放兜底）。
 *
 * 正常播放是浏览器直接拉 CDN 的直链 —— 但 CDN 可能只在「本机 + 代理」下才通
 * （比如某些区域受限的源），这时候浏览器直连就会失败。这时改用这条通道：
 * 请求由 companion 发出（会走设置里的代理），前端拿字节自己放。
 */
export async function fetchTrackBytes(
  backend: Backend | null,
  config: MusicConfig,
  track: Track,
  br?: number,
): Promise<{ mime: string; bytes: Uint8Array<ArrayBuffer>; sizeKB: number } | null> {
  if (!backend?.musicDownload) return null
  try {
    const result = await backend.musicDownload({
      ...baseParams(config),
      source: track.source,
      id: track.id,
      name: track.name,
      br: br ?? config.quality,
    })
    if (!result?.base64) return null
    const binary = atob(result.base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return {
      mime: result.mime || 'audio/mpeg',
      bytes,
      sizeKB: Math.round((result.size || bytes.length) / 1024),
    }
  } catch {
    return null
  }
}

/**
 * 封面（带换源兜底）。
 *
 * 两种失败都要兜：① 能经本机取封面、但上游/图床取不到；
 * ② 只能直连图床时，图床不认浏览器直连（典型就是 joox 的图床）。
 * 这时用「歌名 + 歌手」到别的源找同一首，优先用浏览器也认的图床
 * （网易云的 `p*.music.126.net` 直连没问题）。
 */
export async function fetchCoverDataWithFallback(
  backend: Backend | null,
  config: MusicConfig,
  track: Track,
  size: 300 | 500 = 300,
): Promise<string | null> {
  const own = await fetchCoverData(backend, config, track, size)
  // 经本机取回来的是 data URL —— 一定能显示
  if (own?.startsWith('data:')) return own
  // 直连模式下，源本身图床就友好（网易云）就不用折腾
  if (own && track.source === 'netease') return own

  const keyword = [track.name, track.artist[0] ?? ''].filter(Boolean).join(' ')
  for (const source of AUTO_SOURCES) {
    if (source === track.source) continue
    let candidates: Track[] = []
    try {
      candidates = await searchOneSource(backend, config, source, keyword)
    } catch {
      continue
    }
    const best = pickBestMatch(candidates, track)
    if (!best) continue
    const cover = await fetchCoverData(backend, config, best, size)
    if (!cover) continue
    if (cover.startsWith('data:') || source === 'netease') return cover
  }
  return own
}

/** 封面地址；拿不到就返回 null（不抛错，缺封面不影响听歌） */
export async function fetchCoverUrl(
  backend: Backend | null,
  config: MusicConfig,
  track: Track,
  size: 300 | 500 = 300,
): Promise<string | null> {
  try {
    const data = await callApi(backend, {
      ...baseParams(config),
      types: 'pic',
      source: track.source,
      id: track.picId,
      size,
    })
    return str((data as Record<string, unknown> | null)?.url) || null
  } catch {
    return null
  }
}

/**
 * 封面（给 `<img>` 用的地址）。
 *
 * 优先让**本机执行器**把图片取回来（data URL）—— 浏览器直连上游图床（joox 之类）
 * 经常白图：图床只认本机 / 要 Referer，而我们前面是绕过 companion 直连的。
 * 老版本 companion 没有 `music.cover` 时退回直链，至少不报错。
 */
export async function fetchCoverData(
  backend: Backend | null,
  config: MusicConfig,
  track: Track,
  size: 300 | 500 = 300,
): Promise<string | null> {
  if (backend?.musicCover) {
    try {
      const result = await backend.musicCover({
        ...baseParams(config),
        source: track.source,
        id: track.picId,
        size,
      })
      if (result?.base64) {
        return `data:${result.mime || 'image/jpeg'};base64,${result.base64}`
      }
    } catch {
      // 取不到就走下面的直链
    }
  }
  return fetchCoverUrl(backend, config, track, size)
}

export async function downloadTrack(
  backend: Backend | null,
  config: MusicConfig,
  track: Track,
): Promise<MusicDownloadResult> {
  if (!backend?.musicDownload) {
    throw new Error('下载需要连接本机执行器。')
  }
  return backend.musicDownload({
    ...baseParams(config),
    types: 'url',
    source: track.source,
    id: track.id,
    br: config.quality,
    name: trackLabel(track),
  })
}

/** 用**浏览器自己的下载**保存：Blob + `<a download>`，文件名能保住 */
export function saveDownloadedTrack(result: MusicDownloadResult): void {
  const binary = atob(result.base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: result.mime || 'audio/mpeg' }))
  const link = document.createElement('a')
  link.href = url
  link.download = result.name || 'track.mp3'
  document.body.appendChild(link)
  link.click()
  link.remove()
  // 给浏览器一点时间开始下载再释放
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/* -------------------------------- 点赞 / 历史 -------------------------------- */

const LIKE_KEY = 'rbcode.music.likes'
const HISTORY_KEY = 'rbcode.music.history'
/** 列表最多留多少条 */
const HISTORY_LIMIT = 100

/** 点赞 / 历史里的条目 */
export interface HistoryEntry {
  track: Track
  at: number
}

export type LikedEntry = HistoryEntry

function readEntries(key: string): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(key)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) => {
        const entry = item as Partial<HistoryEntry>
        const track = toTrack(entry.track)
        if (!track || typeof entry.at !== 'number') return null
        return { track, at: entry.at }
      })
      .filter((entry): entry is HistoryEntry => entry !== null)
  } catch {
    return []
  }
}

function writeEntries(key: string, entries: HistoryEntry[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(entries.slice(0, HISTORY_LIMIT)))
  } catch {
    // 存储写不进去也不该影响听歌
  }
}

export function loadLikes(): LikedEntry[] {
  return readEntries(LIKE_KEY)
}

export function saveLikes(entries: LikedEntry[]): void {
  writeEntries(LIKE_KEY, entries)
}

export function isLiked(entries: LikedEntry[], track: Track): boolean {
  const key = trackKey(track)
  return entries.some((entry) => trackKey(entry.track) === key)
}

/** 已赞就取消，否则加到最前 */
export function toggleLike(entries: LikedEntry[], track: Track): LikedEntry[] {
  const key = trackKey(track)
  if (entries.some((entry) => trackKey(entry.track) === key)) {
    return entries.filter((entry) => trackKey(entry.track) !== key)
  }
  return [{ track, at: Date.now() }, ...entries]
}

export function loadHistory(): HistoryEntry[] {
  return readEntries(HISTORY_KEY)
}

export function saveHistory(entries: HistoryEntry[]): void {
  writeEntries(HISTORY_KEY, entries)
}

/** 最近的排最前，同一首只留一条 */
export function pushHistory(entries: HistoryEntry[], track: Track): HistoryEntry[] {
  const key = trackKey(track)
  return [{ track, at: Date.now() }, ...entries.filter((entry) => trackKey(entry.track) !== key)].slice(
    0,
    HISTORY_LIMIT,
  )
}
