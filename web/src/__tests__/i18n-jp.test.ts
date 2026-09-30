import { afterEach, describe, expect, it } from 'vitest'
import { getLanguage, LANGS, setLanguage, t } from '../lib/i18n.ts'

describe('语言：日本語（不受支持，回落简体中文）', () => {
  afterEach(() => setLanguage('zh'))

  it('语言列表里有日本語', () => {
    expect(LANGS.map((item) => item.value)).toContain('jp')
  })

  it('选中 jp 后，写死的三段式文案显示简体中文', () => {
    setLanguage('jp')
    expect(getLanguage()).toBe('jp')
    expect(t('取消', 'Cancel', '取消')).toBe('取消')
    expect(t('重启', 'Restart', '重啟')).toBe('重启')
  })

  it('选中 jp 后，词条表（key 形式）也回落到中文', () => {
    setLanguage('zh')
    const chinese = t('common.cancel')
    setLanguage('jp')
    expect(t('common.cancel')).toBe(chinese)
  })
})
