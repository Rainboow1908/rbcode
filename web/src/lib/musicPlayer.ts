import { loadHistory, pushHistory, saveHistory, type Track } from './music.ts'

/**
 * 播放内核：队列 + 真正的 `<audio>` 都在这里。
 *
 * 为什么 audio 不放在组件里：**一挂载/卸载就会断音** —— 切右侧标签页、
 * 切主题导致组件重建时，音乐就停了。放在模块里（React 之外）就与组件生命周期无关。
 * 歌词解析、直链请求仍然由面板负责，解析好了调 `setSource()` 回填。
 */

/** 播放模式：顺序 / 单曲循环 / 随机 */
export type PlayMode = 'order' | 'loop' | 'shuffle'

export const PLAY_MODES: PlayMode[] = ['order', 'loop', 'shuffle']

const PLAY_MODE_KEY = 'rbcode.music.playMode'

function loadPlayMode(): PlayMode {
  try {
    const raw = localStorage.getItem(PLAY_MODE_KEY)
    return PLAY_MODES.includes(raw as PlayMode) ? (raw as PlayMode) : 'order'
  } catch {
    // 没有 localStorage（隐私模式 / 测试环境）就用默认
    return 'order'
  }
}

export interface PlayerState {
  queue: Track[]
  /** 当前在 queue 里的位置；-1 = 没有 */
  index: number
  /** 播放意图 */
  playing: boolean
  /** 每次「要求重新开始播这首」时 +1，面板据此重新解析直链 */
  revision: number
  /** 已解析出的直链，以及它属于哪首歌（source:id） */
  sourceKey: string | null
  sourceUrl: string | null
  /** 这条直链是按哪个 revision 解析的 —— 面板重新挂载时据此判断「不用再来一遍」 */
  sourceRevision: number
  /** 实际拿到的音质与文件大小（KB） */
  bitrate: number
  sizeKB: number
  progress: number
  duration: number
  volume: number
  /** 播放模式：顺序 / 单曲循环 / 随机（存在 localStorage 里，刷新后保留） */
  playMode: PlayMode
  error: string | null
}

const INITIAL: PlayerState = {
  queue: [],
  index: -1,
  playing: false,
  revision: 0,
  sourceKey: null,
  sourceUrl: null,
  sourceRevision: -1,
  bitrate: 0,
  sizeKB: 0,
  progress: 0,
  duration: 0,
  volume: 0.8,
  playMode: 'order',
  error: null,
}

// 播放模式从 localStorage 恢复（不放进 INITIAL，免得测试之间互相串）
let state: PlayerState = { ...INITIAL, playMode: loadPlayMode() }
let audio: HTMLAudioElement | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function move(patch: Partial<PlayerState>): void {
  state = { ...state, ...patch }
  emit()
}

export function subscribePlayer(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function playerSnapshot(): PlayerState {
  return state
}

export function currentTrack(): Track | null {
  return state.queue[state.index] ?? null
}

/**
 * 开始播一首就记进历史 —— 放在这里而不是面板里，是为了**谁点的都记**：
 * 面板里点、上下首切歌、以及模型用 `music` 工具点歌，都走这几个入口。
 */
function rememberHistory(track: Track | null): void {
  if (!track) return
  try {
    saveHistory(pushHistory(loadHistory(), track))
  } catch {
    // 存不进去也不该影响播放
  }
}

export function trackIdOf(track: Track | null): string | null {
  return track ? `${track.source}:${track.id}` : null
}

/** 当前曲目的 key（和 music.ts 的 trackKey 一致，但这里不引进来免得循环依赖） */
export function currentKey(): string | null {
  return trackIdOf(currentTrack())
}

/* --------------------------------- audio --------------------------------- */

function safePlay(element: HTMLAudioElement): void {
  try {
    const result = element.play()
    // jsdom 等环境里 play() 直接返回 undefined
    if (result && typeof result.catch === 'function') {
      result.catch(() => move({ playing: false }))
    }
  } catch {
    // 不支持播放的环境：忽略
  }
}

function safeLoad(element: HTMLAudioElement): void {
  try {
    element.load()
  } catch {
    // 同上
  }
}

/** 单曲循环：从头再放一遍这首歌（直链没变，不用重新解析） */
function replayCurrent(): void {
  const element = audio
  if (!element) return
  try {
    element.currentTime = 0
  } catch {
    // 环境不支持就只表达重放意图
  }
  move({ progress: 0, playing: true })
  safePlay(element)
}

/** 随机：换一首别的（队列只有一首时就重放它） */
function playRandom(): void {
  const total = state.queue.length
  if (total === 0 || state.index < 0) return
  if (total === 1) {
    replayCurrent()
    return
  }
  let next = state.index
  while (next === state.index) next = Math.floor(Math.random() * total)
  playIndex(next)
}

/** 懒创建那个唯一的 audio 元素（在 React 之外，所以切组件不会断） */
export function getAudio(): HTMLAudioElement | null {
  if (audio) return audio
  if (typeof Audio === 'undefined') return null

  const element = new Audio()
  element.preload = 'auto'
  element.volume = state.volume
  element.addEventListener('timeupdate', () => move({ progress: element.currentTime }))
  element.addEventListener('durationchange', () =>
    move({ duration: Number.isFinite(element.duration) ? element.duration : 0 }),
  )
  element.addEventListener('ended', () => {
    // 单曲循环：重放这首；顺序 / 随机交给 stepIndex（随机在它内部处理）
    if (state.playMode === 'loop') {
      replayCurrent()
      return
    }
    if (!stepIndex(1)) move({ playing: false, progress: 0 })
  })
  element.addEventListener('play', () => {
    if (!state.playing) move({ playing: true })
  })
  element.addEventListener('pause', () => {
    if (state.playing) move({ playing: false })
  })
  element.addEventListener('error', () =>
    move({ playing: false, error: '播放失败：直链可能已过期，重新点一次那首歌' }),
  )

  audio = element
  return element
}

/* ---------------------------- 跨标签页只响一个 ---------------------------- */

/**
 * 一个页面里只有**一个** `<audio>` 元素，所以「同时听到两首歌」通常是**开了两个标签页**：
 * 比如模型在 A 页换了歌，B 页还在放原来那首。这里用 BroadcastChannel 让「刚开始出声的页」
 * 通知其它页让位 —— 和视频网站一样，同一时刻只在一个标签页发声。
 * 只单向通知（收到就让位、不回发），所以两个页不会互相打断。
 */
const MUSIC_CHANNEL = 'rbcode.music'
let channel: BroadcastChannel | null = null
let channelOpened = false

function musicChannel(): BroadcastChannel | null {
  if (channelOpened) return channel
  channelOpened = true
  try {
    if (typeof BroadcastChannel === 'undefined') return null
    channel = new BroadcastChannel(MUSIC_CHANNEL)
    channel.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as { type?: string } | null
      if (data?.type !== 'playing' || !state.playing) return
      // 别的页开始播了：本页让位（暂停，不释放队列，切回来还能接着听）
      state = { ...state, playing: false }
      emit()
      applyAudio()
    })
  } catch {
    channel = null
  }
  return channel
}

/** 本页开始出声时广播一句，让其它页停 */
function announcePlaying(): void {
  try {
    musicChannel()?.postMessage({ type: 'playing' })
  } catch {
    // 广播不了不影响本页播放
  }
}

/** 把「意图」同步到 audio —— 唯一碰 src / play / pause 的地方 */
function applyAudio(): void {
  const element = getAudio()
  if (!element) return
  musicChannel()
  element.volume = state.volume

  const wanted = state.sourceUrl && state.sourceKey === currentKey() ? state.sourceUrl : null
  const attached = element.getAttribute('src')

  if (!wanted) {
    if (attached) {
      element.pause()
      element.removeAttribute('src')
      safeLoad(element)
    }
    return
  }

  if (attached !== wanted) {
    element.setAttribute('src', wanted)
    safeLoad(element)
  }

  if (state.playing) {
    if (element.paused) {
      safePlay(element)
      // 刚开始出声：告诉其它标签页让位（同一时刻只在一个标签页响）
      announcePlaying()
    }
  } else if (!element.paused) {
    element.pause()
  }
}

/* --------------------------------- 队列 --------------------------------- */

/** 把歌加到队列末尾；`playNow` 为真时立刻从第一首新歌开始播 */
export function enqueue(tracks: Track[], playNow = true): Track[] {
  if (tracks.length === 0) return state.queue
  const queue = [...state.queue, ...tracks]
  if (playNow) {
    // 注意：起播位置要在 move 之前算好 —— move 之后 state.queue 就已经是新的了
    const startIndex = state.queue.length
    move({ queue, index: startIndex, playing: true, revision: state.revision + 1 })
    rememberHistory(queue[startIndex] ?? null)
  } else {
    move({ queue })
  }
  applyAudio()
  return queue
}

/** 跳到队列里的某一首并开始播 */
export function playIndex(index: number): void {
  if (index < 0 || index >= state.queue.length) return
  move({ index, playing: true, revision: state.revision + 1 })
  rememberHistory(state.queue[index] ?? null)
  applyAudio()
}

/** 上一首 / 下一首，返回是否真的切了。随机模式下「下一首」改成随机挑一首 */
export function stepIndex(delta: number): boolean {
  if (state.queue.length === 0 || state.index < 0) return false
  if (delta > 0 && state.playMode === 'shuffle' && state.queue.length > 1) {
    playRandom()
    return true
  }
  playIndex((state.index + delta + state.queue.length) % state.queue.length)
  return true
}

export function replaceQueue(tracks: Track[], index: number, playing: boolean): void {
  move({ queue: tracks, index, playing, revision: state.revision + 1 })
  if (playing) rememberHistory(tracks[index] ?? null)
  applyAudio()
}

/** 播放 / 暂停（面板、事件回调都走它） */
export function setPlaying(playing: boolean): void {
  if (state.playing === playing) return
  move({ playing })
  applyAudio()
}

/** 再按一次「播放」：重新拉起当前曲目 */
export function restartCurrent(): void {
  if (state.index < 0) return
  move({ playing: true, revision: state.revision + 1 })
  applyAudio()
}

/** 切播放模式（顺序 / 单曲循环 / 随机），并记进 localStorage */
export function setPlayMode(mode: PlayMode): void {
  if (state.playMode === mode) return
  move({ playMode: mode })
  try {
    localStorage.setItem(PLAY_MODE_KEY, mode)
  } catch {
    // 存不了就算了（隐私模式 / 没有 localStorage）
  }
}

/** 点一下切换：顺序 → 单曲循环 → 随机 → 顺序 */
export function cyclePlayMode(): PlayMode {
  const next = PLAY_MODES[(PLAY_MODES.indexOf(state.playMode) + 1) % PLAY_MODES.length] ?? 'order'
  setPlayMode(next)
  return next
}

export function setSource(input: {
  url: string
  key: string
  br: number
  sizeKB: number
  /** 解析时对应的 revision */
  revision: number
}): void {
  move({
    sourceKey: input.key,
    sourceUrl: input.url,
    sourceRevision: input.revision,
    bitrate: input.br,
    sizeKB: input.sizeKB,
    progress: 0,
    duration: 0,
    error: null,
  })
  applyAudio()
}

export function clearSource(): void {
  move({
    sourceKey: null,
    sourceUrl: null,
    sourceRevision: -1,
    bitrate: 0,
    sizeKB: 0,
    progress: 0,
    duration: 0,
  })
  applyAudio()
}

export function seek(seconds: number): void {
  const element = getAudio()
  if (element && Number.isFinite(seconds) && element.getAttribute('src')) {
    try {
      element.currentTime = Math.max(0, seconds)
    } catch {
      // 忽略
    }
  }
  move({ progress: Math.max(0, seconds) })
}

export function setVolume(volume: number): void {
  const clamped = Math.min(1, Math.max(0, volume))
  move({ volume: clamped })
  applyAudio()
}

export function setError(message: string | null): void {
  move({ error: message })
}

export function clearQueue(): void {
  move({
    queue: [],
    index: -1,
    playing: false,
    sourceKey: null,
    sourceUrl: null,
    sourceRevision: -1,
    progress: 0,
    duration: 0,
  })
  applyAudio()
}

/** 测试用：恢复初始状态 */
export function resetPlayer(): void {
  state = { ...INITIAL }
  listeners.clear()
}
