import type { RepeatScope } from './types.ts'

/**
 * 重复内容检测：模型偶尔会「卡带」——同一句话 / 同一段代码 / 同一行 JSON 一直往下吐，
 * 直到把输出额度烧完。这里在**流式过程中**盯着最新的尾部，一旦发现同一段内容
 * 连续重复到阈值就报告，调用方据此中止本轮并在界面上说明原因。
 *
 * 只看尾部（不是全文扫描）：卡带一定发生在最后，而且这样每来一小段才做一次小计算。
 */

export type RepeatChannel = 'text' | 'reasoning' | 'tool'

export interface RepetitionHit {
  /** 重复的那个单元（已截断，用于展示 / 说明原因） */
  unit: string
  /** 连续出现了几次 */
  count: number
  /** 重复开始的位置（源文本里的下标）：用来把已经吐出来的重复内容裁掉 */
  at: number
}

export interface RepetitionOptions {
  /** 检测范围 */
  scope: RepeatScope
  /** 最小重复单元（字符）：太短的（标点、缩进）不算 */
  minUnit: number
  /** 连续重复达到这个次数就判定为异常 */
  threshold: number
  /** 每多累积这么多字符才检查一次（省 CPU）；默认 160 */
  checkEvery?: number
}

/** 只看尾部这么多字符（卡带永远在结尾，没必要扫全文） */
const TAIL_WINDOW = 6000
/** 字符级检测的最大单元长度 */
const MAX_CHAR_UNIT = 200
/** 行块级检测最多看「最后几行」作为一个单元 */
const MAX_LINE_BLOCK = 8
/**
 * 「重复内容总长度」的下限：连贯重复了这么多字符才值得掐断。
 * 工具参数的正常内容里本来就有成套的相似行（表格 / 测试数据 / 复制的配置块），
 * 所以它的门槛高一些，免得把正经干活当成卡带。
 */
const MIN_RUN: Record<RepeatChannel, number> = { text: 0, reasoning: 0, tool: 240 }

/** 这个通道在不在检测范围里 */
export function channelCovered(scope: RepeatScope, channel: RepeatChannel): boolean {
  switch (scope) {
    case 'text':
      return channel === 'text'
    case 'reasoning':
      return channel === 'reasoning'
    case 'both':
      return channel === 'text' || channel === 'reasoning'
    default:
      return true
  }
}

/** 把重复单元压成一行短摘要（用于界面提示） */
export function describeUnit(unit: string, max = 80): string {
  const flat = unit.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 从尾部往前数，看 unit 连续出现了几次 */
function countRepeats(text: string, unit: string, start: number): number {
  let count = 0
  let end = start
  while (end - unit.length >= 0 && text.slice(end - unit.length, end) === unit) {
    count += 1
    end -= unit.length
  }
  return count
}

/** 单元里至少要有几种不同字符（「好。好。好。」这种两三个字符的排比不算内容重复） */
function distinctChars(text: string): number {
  return new Set(text.replace(/\s+/g, '')).size
}

/** 字符级：同一小段内容（20-200 字）周期性地重复 */
function detectCharRepetition(text: string, minUnit: number, threshold: number): RepetitionHit | null {
  const maxUnit = Math.min(MAX_CHAR_UNIT, Math.floor(text.length / threshold))
  for (let size = minUnit; size <= maxUnit; size += 1) {
    const unit = text.slice(-size)
    // 纯空白 / 纯换行不算「内容重复」（表格对齐、排版用的空行很常见）
    if (unit.trim().length < Math.max(4, Math.floor(size / 4))) continue
    // 只有两三种字符在打转（分隔行、标点排比）也不当卡带
    if (distinctChars(unit) < 4) continue
    if (text.slice(-2 * size, -size) !== unit) continue
    const count = 2 + countRepeats(text, unit, text.length - 2 * size)
    if (count >= threshold) {
      return { unit, count, at: text.length - count * size }
    }
  }
  return null
}

/** 行块级：整行 / 整段（多行）连续重复 */
function detectLineRepetition(text: string, minUnit: number, threshold: number): RepetitionHit | null {
  const lines = text.split('\n')
  const maxBlock = Math.min(MAX_LINE_BLOCK, Math.floor(lines.length / threshold))
  for (let block = 1; block <= maxBlock; block += 1) {
    const unitLines = lines.slice(lines.length - block)
    const unit = unitLines.join('\n')
    if (unit.trim().length < minUnit) continue
    let count = 0
    let end = lines.length
    while (end - block >= 0) {
      let same = true
      for (let i = 0; i < block; i += 1) {
        if (lines[end - block + i] !== unitLines[i]) {
          same = false
          break
        }
      }
      if (!same) break
      count += 1
      end -= block
    }
    if (count >= threshold) {
      const at = text.length - lines.slice(end).join('\n').length
      return { unit, count, at: Math.max(0, at) }
    }
  }
  return null
}

/**
 * 一次性检测（也给单元测试用）：命中就返回重复单元、次数与起始位置。
 * 行块级优先（重复整段是更明显的卡带），其次才是字符级。
 */
export function detectRepetition(
  text: string,
  minUnit: number,
  threshold: number,
): RepetitionHit | null {
  if (!text || minUnit < 1 || threshold < 2) return null
  const window = text.slice(-TAIL_WINDOW)
  if (window.length < minUnit * threshold) return null
  const offset = text.length - window.length
  const hit =
    detectLineRepetition(window, minUnit, threshold) ??
    detectCharRepetition(window, minUnit, threshold)
  return hit ? { ...hit, at: offset + hit.at } : null
}

/**
 * 流式检测器：每次把「到目前为止的完整内容」喂进来（按通道分开），
 * 内部按 checkEvery 节流，只在长度涨够时才做一次检测。
 */
export class RepetitionWatcher {
  private options: RepetitionOptions
  private checked = new Map<RepeatChannel, number>()

  constructor(options: RepetitionOptions) {
    this.options = options
  }

  /** 这个通道要不要检测 */
  covers(channel: RepeatChannel): boolean {
    return channelCovered(this.options.scope, channel)
  }

  /** 喂一次当前完整内容；命中返回重复信息 */
  feed(channel: RepeatChannel, full: string): RepetitionHit | null {
    if (!this.covers(channel)) return null
    const every = this.options.checkEvery ?? 160
    const last = this.checked.get(channel) ?? 0
    if (full.length - last < every) return null
    this.checked.set(channel, full.length)
    const hit = detectRepetition(full, this.options.minUnit, this.options.threshold)
    if (!hit) return null
    // 重复得太短（工具参数里常见的相似行）先放过，等它继续重复下去再看
    if (hit.unit.length * hit.count < MIN_RUN[channel]) return null
    return hit
  }

  reset(): void {
    this.checked.clear()
  }
}
