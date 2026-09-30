import { describe, expect, it } from 'vitest'
import { SETTINGS_INDEX, matchSettings } from '../lib/settingsIndex.ts'

describe('设置搜索：精确到每一条设置项', () => {
  it('索引覆盖到具体设置项（不是只到分组名）', () => {
    expect(SETTINGS_INDEX.length).toBeGreaterThan(40)
    const titles = SETTINGS_INDEX.map((entry) => entry.title)
    expect(titles).toContain('兼容导入')
    expect(titles).toContain('悬浮窗')
    expect(titles).toContain('思考过程默认展开')
    // 每条都带上它所属的分组，点了能跳过去
    for (const entry of SETTINGS_INDEX) expect(entry.section.length).toBeGreaterThan(0)
  })

  it('按标题命中，支持子串；标题命中排在说明命中前面', () => {
    expect(matchSettings('兼容导入')[0].title).toBe('兼容导入')
    expect(matchSettings('兼容导入')[0].section).toBe('general')
    expect(matchSettings('浮窗').some((entry) => entry.title === '悬浮窗')).toBe(true)
    expect(matchSettings('导入').some((entry) => entry.title === '兼容导入')).toBe(true)
  })

  it('说明文字也能命中（例如在说明里提到 .reasonix）', () => {
    expect(matchSettings('.reasonix').some((entry) => entry.title === '兼容导入')).toBe(true)
  })

  it('没命中就返回空，不会把无关设置项倒出来', () => {
    expect(matchSettings('zzzz-不存在-zzzz')).toEqual([])
    expect(matchSettings('   ')).toEqual([])
  })
})
