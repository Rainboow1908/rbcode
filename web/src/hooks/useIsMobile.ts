import { useEffect, useState } from 'react'

/** 手机端断点：小于这个宽度就切成「抽屉式」单栏布局 */
export const MOBILE_QUERY = '(max-width: 767px)'

/**
 * 是否处于手机端宽度。
 * 用 matchMedia 而不是纯 CSS，是因为布局骨架（左栏 / 右栏是内联还是抽屉）
 * 需要在 JSX 层决定，不是套几段响应式 class 就能覆盖的。
 *
 * 没有 matchMedia 的环境（jsdom / 老浏览器）一律返回 false，即保持桌面布局。
 */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia(MOBILE_QUERY).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(MOBILE_QUERY)
    const onChange = () => setMobile(mql.matches)
    // 挂载后再对一次：首帧到 effect 之间窗口可能已经被拖动过
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return mobile
}
