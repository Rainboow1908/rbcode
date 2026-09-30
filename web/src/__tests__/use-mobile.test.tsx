import { renderHook, act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useIsMobile } from '../hooks/useIsMobile.ts'

/** 可控的 matchMedia 替身：记录监听器，方便手动触发变化 */
function mockMatchMedia(initial: boolean) {
  const listeners = new Set<() => void>()
  let matches = initial
  const make = (query: string) => ({
    media: query,
    onchange: null,
    get matches() {
      return matches
    },
    addEventListener: (_type: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_type: string, cb: () => void) => listeners.delete(cb),
    addListener: (cb: () => void) => listeners.add(cb),
    removeListener: (cb: () => void) => listeners.delete(cb),
    dispatchEvent: () => true,
  })
  vi.stubGlobal('matchMedia', (query: string) => make(query))
  return {
    set(next: boolean) {
      matches = next
      listeners.forEach((listener) => listener())
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useIsMobile', () => {
  it('没有 matchMedia 的环境（jsdom / 老浏览器）保持桌面布局', () => {
    vi.stubGlobal('matchMedia', undefined)
    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(false)
  })

  it('窄屏为 true，宽屏为 false', () => {
    mockMatchMedia(true)
    expect(renderHook(() => useIsMobile()).result.current).toBe(true)

    vi.unstubAllGlobals()
    mockMatchMedia(false)
    expect(renderHook(() => useIsMobile()).result.current).toBe(false)
  })

  it('监听窗口变化：从窄到宽会实时切回 false', () => {
    const media = mockMatchMedia(true)
    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(true)

    act(() => media.set(false))
    expect(result.current).toBe(false)
  })
})
