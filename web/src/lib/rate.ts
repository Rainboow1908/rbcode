/**
 * 「当前速度」计量。
 *
 * 老做法是「本轮总 token ÷ 本轮总耗时」——工具执行、等审批这些空闲时间全进了分母，
 * 越跑越慢，等于一个平均速度。这里改成**滑动窗口**：只算最近几秒真的收到的 token，
 * 没有新 token 的时间自然从窗口里滑出去，速度就跟着掉下来（空闲 → 0），不会被平均稀释。
 */
export const SPEED_WINDOW_MS = 4000

/** 没有实时速率时的占位符（不要留空 / 不要隐藏） */
export const SPEED_PLACEHOLDER = '-'

/**
 * 速率 → 状态栏文案。
 * 没有在生成（在跑工具、在等用户回答 ask / 审批、整轮已结束）时窗口里没有样本，
 * `rate()` 返回 0 → 这里给 `-` 占位，而不是显示 0.0 或者干脆消失。
 */
export function formatSpeed(rate: number, digits = 1): string {
  if (!Number.isFinite(rate) || rate <= 0) return SPEED_PLACEHOLDER
  return `${rate.toFixed(digits)} tok/s`
}

export class RateMeter {
  private samples: { at: number; tokens: number }[] = []

  constructor(private readonly windowMs: number = SPEED_WINDOW_MS) {}

  /** 收到一批新的 token（流式增量） */
  add(tokens: number, at: number = Date.now()): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return
    this.samples.push({ at, tokens })
    this.prune(at)
  }

  /** 当前速率（tok/s）；窗口里没有数据就是 0 */
  rate(now: number = Date.now()): number {
    this.prune(now)
    if (this.samples.length === 0) return 0
    const tokens = this.samples.reduce((sum, sample) => sum + sample.tokens, 0)
    const span = (now - this.samples[0].at) / 1000
    // 窗口还没铺满时按**实际覆盖**的时间算，免得一上来就被低估；下限 0.5s 免得刚出一个字就爆表
    const seconds = Math.min(this.windowMs / 1000, Math.max(0.5, span))
    return tokens / seconds
  }

  /** 新一轮生成开始时清空 */
  reset(): void {
    this.samples = []
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs
    while (this.samples.length > 0 && this.samples[0].at < cutoff) this.samples.shift()
  }
}
