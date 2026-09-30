import { describe, expect, it } from 'vitest'
import { applyThemeClasses } from '../components/FloatingWindow.tsx'

/** 用假的 classList 检查主题类怎么套上去（主文档和悬浮窗共用这一份逻辑） */
function fakeRoot() {
  const classes = new Set<string>()
  return {
    classes,
    classList: {
      toggle: (name: string, force?: boolean) => {
        if (force) classes.add(name)
        else classes.delete(name)
      },
    },
  }
}

describe('悬浮窗的主题适配', () => {
  it('深色主题：不加 light / aurora', () => {
    const root = fakeRoot()
    applyThemeClasses(root, 'dark', 'default')
    expect([...root.classes]).toEqual([])
  })

  it('浅色 / 极光 / OreUI 各自打上对应类', () => {
    const light = fakeRoot()
    applyThemeClasses(light, 'light', 'default')
    expect(light.classes.has('light')).toBe(true)
    expect(light.classes.has('aurora')).toBe(false)

    const aurora = fakeRoot()
    applyThemeClasses(aurora, 'aurora', 'default')
    expect(aurora.classes.has('aurora')).toBe(true)
    expect(aurora.classes.has('light')).toBe(false)

    const oreui = fakeRoot()
    applyThemeClasses(oreui, 'oreui', 'default')
    expect(oreui.classes.has('oreui')).toBe(true)
    expect(oreui.classes.has('light')).toBe(false)
    expect(oreui.classes.has('aurora')).toBe(false)
  })

  it('配色只留当前那个，切换时旧的会去掉', () => {
    const root = fakeRoot()
    applyThemeClasses(root, 'dark', 'blue')
    expect(root.classes.has('rb-color-blue')).toBe(true)

    applyThemeClasses(root, 'dark', 'rose')
    expect(root.classes.has('rb-color-blue')).toBe(false)
    expect(root.classes.has('rb-color-rose')).toBe(true)
  })
})
