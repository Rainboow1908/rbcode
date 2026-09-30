import { describe, expect, it } from 'vitest'
import { RateMeter, SPEED_PLACEHOLDER, SPEED_WINDOW_MS, formatSpeed } from '../lib/rate.ts'

describe('当前速度计量（滑动窗口）', () => {
  it('空表 → 0', () => {
    expect(new RateMeter().rate(1000)).toBe(0)
  })

  it('铺满一个窗口：窗口内 token ÷ 覆盖秒数', () => {
    const meter = new RateMeter(4000)
    for (const at of [0, 1000, 2000, 3000]) meter.add(25, at)
    expect(meter.rate(3000)).toBeCloseTo(100 / 3, 5)
    expect(meter.rate(3999)).toBeCloseTo(100 / 3.999, 3)
  })

  it('空闲会衰减到 0（样本自己滑出窗口）', () => {
    const meter = new RateMeter(4000)
    meter.add(100, 0)
    // 刚出一个字按 0.5s 下限算，不会一上来就爆表
    expect(meter.rate(100)).toBeCloseTo(200, 5)
    expect(meter.rate(4100)).toBe(0)
  })

  it('中途停顿不被平均掉（这次修的就是这个）', () => {
    const meter = new RateMeter(4000)
    meter.add(50, 0)
    meter.add(50, 1000)
    // 接下来 30 秒在跑工具 / 等审批，没有新 token —— 平均速度会被拖垮，这里必须是 0
    expect(meter.rate(31000)).toBe(0)
    // 恢复生成就立刻有速度，不受那 30 秒影响
    meter.add(50, 31000)
    meter.add(50, 32000)
    expect(meter.rate(32000)).toBeCloseTo(100, 5)
  })

  it('超出窗口的老样本被裁掉', () => {
    const meter = new RateMeter(4000)
    meter.add(1000, 0)
    meter.add(10, 3900)
    // 4001ms 时 0ms 那个样本已经过期
    expect(meter.rate(4001)).toBeCloseTo(20, 5)
  })

  it('非法值 / 非正数被忽略', () => {
    const meter = new RateMeter(4000)
    meter.add(0, 0)
    meter.add(-5, 0)
    meter.add(Number.NaN, 0)
    expect(meter.rate(0)).toBe(0)
  })

  it('默认窗口 4 秒', () => {
    expect(SPEED_WINDOW_MS).toBe(4000)
  })

  it('等用户回答（ask / 审批）的时间不算进速度：答完继续，速率立刻恢复', () => {
    const meter = new RateMeter(4000)
    meter.add(40, 0)
    meter.add(40, 1000)
    // 模型提问 / 请求审批，用户想了 2 分钟 —— 期间没有任何 token
    expect(meter.rate(121000)).toBe(0)
    // 用户回答后继续生成：立刻是真实速率，而不是被那 2 分钟平均出来的小数字
    meter.add(40, 121000)
    meter.add(40, 122000)
    expect(meter.rate(122000)).toBeCloseTo(80, 5)
  })

  it('没有实时速率时用 "-" 占位（不留空、不显示 0.0）', () => {
    expect(formatSpeed(0)).toBe('-')
    expect(formatSpeed(Number.NaN)).toBe('-')
    expect(formatSpeed(-3)).toBe('-')
    expect(formatSpeed(12.34)).toBe('12.3 tok/s')
    expect(formatSpeed(12.34, 0)).toBe('12 tok/s')
    expect(SPEED_PLACEHOLDER).toBe('-')
  })
})
