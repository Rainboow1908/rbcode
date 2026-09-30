import { useThemeMode } from '../lib/themeMode.ts'
import checkWhite from '../oreui/check_white.png'

interface Props {
  /** 勾选状态 */
  checked: boolean
  /** 额外类名（外面套的容器用） */
  className?: string
}

/**
 * OreUI 复选框。
 *
 * 上游的 CustomCheckbox 组件（components/controls/checkbox/index.js）渲染出的结构是：
 * `<div class="custom-checkbox on enabled"><img src="check_white.png" /></div>`，
 * 外观全部来自上游的 .custom-checkbox 规则（见 src/oreui/checkbox.css，逐字复制）。
 * 这里复现同一个结构。
 *
 * 切到 OreUI 主题时才用它；其他主题继续用本项目原本的小方框样式。
 */
export default function OreCheckbox({ checked, className = '' }: Props) {
  const oreui = useThemeMode() === 'oreui'
  if (!oreui) {
    return (
      <span
        className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
          checked ? 'border-amber-500 bg-amber-500/20 text-amber-300' : 'border-neutral-600'
        } ${className}`}
      >
        {checked && (
          <svg viewBox="0 0 16 16" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M2.5 8.5 6 12l7.5-8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
    )
  }
  return (
    <span className={`inline-flex shrink-0 ${className}`}>
      <span className={`custom-checkbox ${checked ? 'on' : 'off'} enabled`}>
        <img alt="" className="checkmark" src={checkWhite} />
      </span>
    </span>
  )
}
