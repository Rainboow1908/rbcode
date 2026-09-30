import { beforeEach, describe, expect, it } from 'vitest'
import { defaultSettings, loadSettings } from '../lib/settings.ts'

const KEY = 'rbcode.settings.v2'

describe('设置：不限次数 / 不限时长 / 重复内容检测', () => {
  beforeEach(() => localStorage.clear())

  it('默认开着重复内容检测，范围「全部」，阈值 3，最小单元 24', () => {
    const settings = defaultSettings()
    expect(settings.repeatDetect).toBe(true)
    expect(settings.repeatScope).toBe('all')
    expect(settings.repeatThreshold).toBe(3)
    expect(settings.repeatMinUnit).toBe(24)
  })

  it('填 0 = 不限：存 0 读回来还是 0（不会被夹成默认值）', () => {
    localStorage.setItem(KEY, JSON.stringify({ maxIterations: 0, approvalTimeout: 0 }))
    const settings = loadSettings()
    expect(settings.maxIterations).toBe(0)
    expect(settings.approvalTimeout).toBe(0)
  })

  it('上限放开：很大的值也照原样留着', () => {
    localStorage.setItem(KEY, JSON.stringify({ maxIterations: 100000, approvalTimeout: 86400 }))
    const settings = loadSettings()
    expect(settings.maxIterations).toBe(100000)
    expect(settings.approvalTimeout).toBe(86400)
  })

  it('负数 / 非数字回落到默认值', () => {
    localStorage.setItem(KEY, JSON.stringify({ maxIterations: -5, approvalTimeout: 'x' }))
    const settings = loadSettings()
    expect(settings.maxIterations).toBe(60)
    expect(settings.approvalTimeout).toBe(60)
  })

  it('重复检测的阈值 / 单元超范围会夹回来，非法范围回落「全部」', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ repeatThreshold: 99, repeatMinUnit: 1, repeatScope: 'nope' }),
    )
    const settings = loadSettings()
    expect(settings.repeatThreshold).toBe(10)
    expect(settings.repeatMinUnit).toBe(8)
    expect(settings.repeatScope).toBe('all')
  })
})
