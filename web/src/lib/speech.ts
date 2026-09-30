import { useSyncExternalStore } from 'react'

/**
 * 浏览器语音能力：语音输入（SpeechRecognition）与朗读（speechSynthesis）。
 *
 * 两者都是浏览器自带的，不需要联网模型：
 *   - 语音输入：Chrome / Edge / Android Chrome 支持，需要 HTTPS（本站是 https）且识别在服务端做，离线不可用
 *   - 朗读：绝大多数浏览器都支持，用的都是系统里的音色
 */

/* ------------------------------- 语言标签 ------------------------------- */

/** 界面语言 → 识别 / 朗读用的语言标签 */
export function speechLang(lang: string): string {
  if (lang === 'en') return 'en-US'
  if (lang === 'tw') return 'zh-TW'
  return 'zh-CN'
}

/* ------------------------------- 语音输入 ------------------------------- */

interface RecognitionResultLike {
  isFinal: boolean
  length: number
  [index: number]: { transcript: string }
}
interface RecognitionEventLike {
  resultIndex: number
  results: RecognitionResultLike[] & { length: number }
}
interface RecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: RecognitionEventLike) => void) | null
  onerror: ((event: { error?: string }) => void) | null
  onend: (() => void) | null
}
type RecognitionCtor = new () => RecognitionLike

function recognitionCtor(): RecognitionCtor | null {
  const scope = window as unknown as {
    SpeechRecognition?: RecognitionCtor
    webkitSpeechRecognition?: RecognitionCtor
  }
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null
}

/** 这个浏览器能不能语音输入 */
export function canRecognize(): boolean {
  return typeof window !== 'undefined' && recognitionCtor() !== null
}

export interface Dictation {
  stop(): void
}

/**
 * 开始一次听写。
 * `onText` 给的是**这一次听写的完整文本**（含未定稿的临时结果），调用方自己拼到输入框里。
 */
export function startDictation(options: {
  lang: string
  onText: (text: string, isFinal: boolean) => void
  onError?: (message: string) => void
  onEnd?: () => void
}): Dictation | null {
  const Ctor = recognitionCtor()
  if (!Ctor) return null
  const recognition = new Ctor()
  recognition.lang = speechLang(options.lang)
  recognition.continuous = true
  recognition.interimResults = true

  recognition.onresult = (event) => {
    let text = ''
    let final = true
    for (let i = 0; i < event.results.length; i += 1) {
      const result = event.results[i]
      if (!result) continue
      text += result[0]?.transcript ?? ''
      if (!result.isFinal) final = false
    }
    options.onText(text, final)
  }
  recognition.onerror = (event) => {
    if (event.error && event.error !== 'aborted' && event.error !== 'no-speech') {
      options.onError?.(event.error)
    }
  }
  recognition.onend = () => options.onEnd?.()

  try {
    recognition.start()
  } catch {
    return null
  }

  return {
    stop: () => {
      try {
        recognition.stop()
      } catch {
        // 已经停了就算了
      }
    },
  }
}

/* -------------------------------- 朗读 -------------------------------- */

export function canSpeak(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

/** 系统里可用的音色（有些浏览器要等 voiceschanged 之后才有） */
export function listVoices(): SpeechSynthesisVoice[] {
  if (!canSpeak()) return []
  return window.speechSynthesis.getVoices()
}

function pickVoice(lang: string, voiceName?: string): SpeechSynthesisVoice | null {
  const voices = listVoices()
  if (voices.length === 0) return null
  if (voiceName) {
    const exact = voices.find((voice) => voice.name === voiceName)
    if (exact) return exact
  }
  // 先找同语言，再退回默认音色
  return (
    voices.find((voice) => voice.lang?.toLowerCase() === lang.toLowerCase()) ??
    voices.find((voice) => voice.lang?.toLowerCase().startsWith(lang.slice(0, 2))) ??
    null
  )
}

/* 「当前正在朗读哪一条」—— 同时只允许一条，用模块级状态让所有按钮同步 */

let speakingId: string | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 订阅「正在朗读的消息 id」（没有就是 null） */
export function useSpeakingId(): string | null {
  return useSyncExternalStore(subscribe, () => speakingId, () => speakingId)
}

export function speakingMessageId(): string | null {
  return speakingId
}

/** 语言标签 → 分组名：只区分中文 / 英文 / 其他（其他直接显示语言代码） */
export function voiceGroupLabel(lang: string): string {
  const code = (lang || '').toLowerCase()
  if (code.startsWith('zh')) return '中文'
  if (code.startsWith('en')) return 'English'
  return `其他语言（${lang || '未知'}）`
}

/**
 * 粗略判断一段文字该用哪种语言的音色（「自动」用）：
 * 中日韩字符多 → 中文；拉丁字母多 → 英文；分不出来就给空串（交给界面语言兜底）。
 */
export function detectSpeechLang(text: string): string {
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/g) ?? []).length
  const latin = (text.match(/[A-Za-z]/g) ?? []).length
  if (cjk >= 4 && cjk * 2 >= latin) return 'zh-CN'
  if (latin >= 12 && latin > cjk * 2) return 'en-US'
  return ''
}

/** 朗读一段文字；`id` 用来标记是哪一条（按钮据此显示播放 / 停止） */
export function speakText(
  id: string,
  text: string,
  options: { lang: string; rate?: number; voiceName?: string } = { lang: 'zh' },
): void {
  if (!canSpeak()) return
  const synth = window.speechSynthesis
  synth.cancel()
  const body = plainTextForSpeech(text)
  if (!body) return
  // 选了具体音色就用它；选「自动」时：先看这段文字是什么语言，其次跟界面语言
  const autoLang = options.voiceName ? '' : detectSpeechLang(body)
  const lang = autoLang || speechLang(options.lang)
  const utterance = new SpeechSynthesisUtterance(body)
  utterance.lang = lang
  utterance.rate = options.rate ?? 1
  const voice = pickVoice(lang, options.voiceName)
  if (voice) utterance.voice = voice
  speakingId = id
  emit()
  const finish = () => {
    if (speakingId === id) {
      speakingId = null
      emit()
    }
  }
  utterance.onend = finish
  utterance.onerror = finish
  synth.speak(utterance)
}

export function stopSpeaking(): void {
  if (canSpeak()) window.speechSynthesis.cancel()
  if (speakingId !== null) {
    speakingId = null
    emit()
  }
}

/* ---------------------- 公式 → 人话（朗读用） ---------------------- */

const MATH_SYMBOLS: [RegExp, string][] = [
  [/\\cdot|\\times/g, '乘'],
  [/\\div/g, '除以'],
  [/\\pm/g, '正负'],
  [/\\mp/g, '负正'],
  [/\\leq?|≤/g, '小于等于'],
  [/\\geq?|≥/g, '大于等于'],
  [/\\neq?|≠/g, '不等于'],
  [/\\approx|≈/g, '约等于'],
  [/\\infty|∞/g, '无穷'],
  [/\\sum/g, '求和'],
  [/\\prod/g, '求积'],
  [/\\int/g, '积分'],
  [/\\partial/g, '偏导'],
  [/\\nabla/g, '梯度'],
  [/\\pi|π/g, '派'],
  [/\\theta|θ/g, '西塔'],
  [/\\alpha|α/g, '阿尔法'],
  [/\\beta|β/g, '贝塔'],
  [/\\gamma|γ/g, '伽马'],
  [/\\lambda|λ/g, '兰姆达'],
  [/\\mu|μ/g, '缪'],
  [/\\sigma|σ/g, '西格玛'],
  [/\\omega|ω/g, '欧米伽'],
  [/\\varphi|\\phi|φ/g, '斐'],
  [/\\Delta|Δ/g, '德尔塔'],
  [/\\to|\\rightarrow/g, '趋于'],
  [/\\dots|\\ldots|\\cdots/g, '省略'],
  [/\\%|%/g, '百分之'],
  [/\+/g, '加'],
  [/=/g, '等于'],
  [/(?<=[\w\d)])-(?=[\w\d(])/g, '减'],
  [/\\>/g, '大于'],
  [/\\</g, '小于'],
]

/** 上下标：^2 → 的平方；_i → 下标 i */
function convertScripts(text: string): string {
  return text
    .replace(/\^\s*\{([^{}]*)\}/g, (_, power: string) => ` 的${spokenScript(power)}`)
    .replace(/\^\s*([\w\d])/g, (_, power: string) => ` 的${spokenScript(power)}`)
    .replace(/_\s*\{([^{}]*)\}/g, (_, sub: string) => ` 下标 ${sub.trim()}`)
    .replace(/_\s*([\w\d])/g, (_, sub: string) => ` 下标 ${sub}`)
}

function spokenScript(power: string): string {
  const value = power.trim()
  if (value === '2') return '平方'
  if (value === '3') return '立方'
  return `${value}次方`
}

/** 把一段 LaTeX 念成人话：\frac{2}{3} → 三分之二、x^2 → x 的平方 */
export function mathToSpeech(latex: string): string {
  let text = latex
  // \text{…} / \mathrm{…} 里的原文直接读
  text = text.replace(/\\(?:text|mathrm|mathbf|operatorname)\s*\{([^{}]*)\}/g, ' $1 ')
  // 分数：分母在前（「三分之二」），可嵌套
  for (let i = 0; i < 6 && /\\frac/.test(text); i += 1) {
    text = text.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_, numerator: string, denominator: string) => {
      return ` ${denominator.trim()}分之${numerator.trim()} `
    })
  }
  // 根号
  text = text.replace(/\\sqrt\s*\{([^{}]*)\}/g, ' 根号 $1 ')
  text = text.replace(/\\left|\\right|\\displaystyle|\\limits|\\,|\\;|\\!|\\quad|\\qquad/g, ' ')
  // 上下标
  text = convertScripts(text)
  // 常见符号
  for (const [pattern, spoken] of MATH_SYMBOLS) text = text.replace(pattern, ` ${spoken} `)
  // 剩下的 \命令 → 去掉命令名、留下参数
  text = text.replace(/\\[a-zA-Z]+\s*\{([^{}]*)\}/g, ' $1 ')
  text = text.replace(/\\[a-zA-Z]+/g, ' ')
  // 括号、大括号一律去掉（念出来没意义）
  text = text.replace(/[{}\\]/g, ' ')
  text = text.replace(/[ \t]+/g, ' ').replace(/\s+([，。；、])/g, '$1').trim()
  return text
}

/** markdown 表格 → 逐行念：「姓名 张三，年龄 30」 */
function tableToSpeech(block: string): string {
  const rows = block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'))
    .map((line) =>
      line
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim()),
    )
  // 第二行是 |---|---|，扔掉
  const body = rows.filter((cells) => !cells.every((cell) => /^:?-{2,}:?$/.test(cell)))
  if (body.length === 0) return ''
  const [header, ...data] = body
  const spoken: string[] = []
  for (const cells of data) {
    const pairs = cells
      .map((cell, index) => {
        const name = header?.[index]?.trim()
        const value = cell.trim()
        if (!value) return ''
        return name && name !== value ? `${name} ${value}` : value
      })
      .filter(Boolean)
    if (pairs.length > 0) spoken.push(pairs.join('，'))
  }
  return spoken.join('；')
}

/**
 * 把 markdown 洗成适合朗读的纯文本：
 *   - 代码块直接跳过（念出来没意义）
 *   - 表格按「列名 + 值」逐行念
 *   - 公式按人话念（三分之二、x 的平方）
 *   - 链接只留文字，去掉各种标记符号
 */
export function plainTextForSpeech(markdown: string): string {
  let text = markdown
  // 代码块整段跳过
  text = text.replace(/```[\s\S]*?```/g, ' ')
  // 表格 → 逐行念
  text = text.replace(/(?:^\s*\|.*\|\s*$\n?){2,}/gm, (block) => ` ${tableToSpeech(block)} `)
  // 公式 → 人话
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_, body: string) => ` ${mathToSpeech(body)} `)
  text = text.replace(/\\\[([\s\S]*?)\\\]/g, (_, body: string) => ` ${mathToSpeech(body)} `)
  text = text.replace(/\$([^$\n]*)\$/g, (_, body: string) => ` ${mathToSpeech(body)} `)
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, (_, body: string) => ` ${mathToSpeech(body)} `)
  // 图片只留 alt，链接只留文字
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  // 行内代码去掉反引号
  text = text.replace(/`([^`]*)`/g, '$1')
  // 标题 / 引用 / 列表符号
  text = text.replace(/^\s{0,3}#{1,6}\s*/gm, '')
  text = text.replace(/^\s{0,3}>\s?/gm, '')
  text = text.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
  // 强调、删除线、分割线
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2')
  text = text.replace(/(\*|_)(.*?)\1/g, '$2')
  text = text.replace(/~~(.*?)~~/g, '$1')
  text = text.replace(/^\s*([-*_]\s*){3,}$/gm, ' ')
  // HTML 标签、多余空白
  text = text.replace(/<[^>]+>/g, ' ')
  text = text.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim()
  // 太长就截断，免得一口气念不完
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text
}
