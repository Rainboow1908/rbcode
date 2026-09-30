import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Tooltip from '../components/Tooltip.tsx'

/** 模拟「手机端」：matchMedia 命中 (max-width: 767px) */
function stubMobile() {
  const make = (query: string) => ({
    media: query,
    onchange: null,
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  })
  vi.stubGlobal('matchMedia', (query: string) => make(query))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Tooltip', () => {
  it('桌面：悬浮显示，离开隐藏', () => {
    const { container } = render(
      <Tooltip label="权限档位">
        <button>图标</button>
      </Tooltip>,
    )
    const wrapper = container.firstChild as HTMLElement
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.mouseEnter(wrapper)
    expect(screen.getByRole('tooltip').textContent).toBe('权限档位')
    fireEvent.mouseLeave(wrapper)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('手机：完全不显示提示（悬浮也不出），但内容照常渲染', () => {
    stubMobile()
    const { container } = render(
      <Tooltip label="权限档位">
        <button>图标</button>
      </Tooltip>,
    )
    const wrapper = container.firstChild as HTMLElement
    expect(wrapper.className).toContain('inline-flex')
    expect(screen.getByText('图标')).toBeTruthy()

    fireEvent.mouseEnter(wrapper)
    fireEvent.focus(screen.getByText('图标'))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
