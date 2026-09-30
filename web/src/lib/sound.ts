import type { SoundEvent, SoundId } from './types.ts'
import { t } from './i18n.ts'

/**
 * 事件提示音。音频文件由 web/scripts/make-sounds.py 生成
 * （MIDI → FluidSynth + GeneralUser GS → mp3），放在 public/sounds/。
 */

export const SOUND_IDS: SoundId[] = [
  'none',
  'chime',
  'bell',
  'pop',
  'ping',
  'success',
  'alert',
  'soft',
]

export const SOUND_LABEL: Record<SoundId, string> = {
  none: '无',
  chime: '清铃',
  bell: '钟声',
  pop: '气泡',
  ping: '提示',
  success: '完成音',
  alert: '警示',
  soft: '柔和',
}

export interface SoundEventMeta {
  id: SoundEvent
  label: string
  hint: string
}

export const SOUND_EVENTS: SoundEventMeta[] = [
  { id: 'taskDone', label: '任务完成', hint: '一次任务顺利做完时' },
  { id: 'ask', label: '模型提问', hint: '模型需要你回答问题时' },
  { id: 'approval', label: '权限审批', hint: '需要你批准写文件 / 删除等操作时' },
  { id: 'plan', label: '计划就绪', hint: '把计划列出来、等你确认时' },
  { id: 'error', label: '运行出错', hint: '生成出问题或任务中途失败时' },
]

export const DEFAULT_SOUNDS: Record<SoundEvent, SoundId> = {
  taskDone: 'success',
  ask: 'ping',
  approval: 'alert',
  plan: 'chime',
  error: 'soft',
}

export const DEFAULT_SOUND_VOLUME = 0.6

/* ------------------------------ 多语言显示名 ------------------------------ */

/** [简体, English, 繁體] —— 日本語已不再支持，不再提供第 4 种 */
type Lang3 = [string, string, string]

const SOUND_NAME: Record<SoundId, Lang3> = {
  none: ['无', 'None', '無'],
  chime: ['清铃', 'Chime', '清鈴'],
  bell: ['钟声', 'Bell', '鐘聲'],
  pop: ['气泡', 'Pop', '氣泡'],
  ping: ['提示', 'Ping', '提示'],
  success: ['完成音', 'Success', '完成音'],
  alert: ['警示', 'Alert', '警示'],
  soft: ['柔和', 'Soft', '柔和'],
}

const EVENT_NAME: Record<SoundEvent, Lang3> = {
  taskDone: ['任务完成', 'Task done', '任務完成'],
  ask: ['模型提问', 'Model asks', '模型提問'],
  approval: ['权限审批', 'Approval', '權限審批'],
  plan: ['计划就绪', 'Plan ready', '計畫就緒'],
  error: ['运行出错', 'Runtime error', '執行出錯'],
}

const EVENT_HINT: Record<SoundEvent, Lang3> = {
  taskDone: ['一次任务顺利做完时', 'When a task finishes successfully', '一次任務順利做完時'],
  ask: ['模型需要你回答问题时', 'When the model needs an answer from you', '模型需要你回答問題時'],
  approval: [
    '需要你批准写文件 / 删除等操作时',
    'When a write or delete needs your approval',
    '需要你批准寫檔案 / 刪除等操作時',
  ],
  plan: ['把计划列出来、等你确认时', 'When a plan is ready for you to confirm', '把計畫列出來、等你確認時'],
  error: ['生成出问题或任务中途失败时', 'When generating fails or a task breaks off', '生成出問題或任務中途失敗時'],
}

export function soundLabel(id: SoundId): string {
  const entry = SOUND_NAME[id]
  return entry ? t(entry[0], entry[1], entry[2]) : id
}

export function soundEventLabel(id: SoundEvent): string {
  const entry = EVENT_NAME[id]
  return entry ? t(entry[0], entry[1], entry[2]) : id
}

export function soundEventHint(id: SoundEvent): string {
  const entry = EVENT_HINT[id]
  return entry ? t(entry[0], entry[1], entry[2]) : ''
}

/** 某个值是否是合法的提示音 id */
export function isSoundId(value: unknown): value is SoundId {
  return typeof value === 'string' && (SOUND_IDS as string[]).includes(value)
}

/**
 * 播放一个提示音。id 为 none、或环境不支持音频（如测试环境）时静默返回。
 * 浏览器对自动播放有限制，但用户已经和页面交互过，通常都能播。
 */
export function playSound(id: SoundId, volume = DEFAULT_SOUND_VOLUME): void {
  if (id === 'none') return
  if (typeof Audio === 'undefined') return
  try {
    const audio = new Audio(`/sounds/${id}.mp3`)
    audio.volume = Math.min(1, Math.max(0, volume))
    void audio.play().catch(() => undefined)
  } catch {
    // 没有音频设备 / 被策略拦下：忽略，不影响主流程
  }
}
