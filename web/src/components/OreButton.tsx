import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { useThemeMode } from '../lib/themeMode.ts'

/** OreUI 按钮的状态（对应上游 status_normal / status_green / status_red / status_disabled） */
export type OreButtonStatus = 'normal' | 'green' | 'red' | 'disabled'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** normal＝浅灰底黑字（相当于「取消」）、green＝原版绿、red＝原版红、disabled＝灰底 */
  status?: OreButtonStatus
  /** 传了它就当链接渲染（下载按钮那种），其余外观完全一样 */
  href?: string
  download?: string | boolean
  target?: string
  rel?: string
  /** React 19 允许把 ref 当普通 prop 传，直接透给底层元素 */
  ref?: Ref<HTMLButtonElement>
  children?: ReactNode
}

/**
 * OreUI 主题下只保留「布局」类，其余（颜色 / 边框 / 圆角 / 阴影 / 过渡 / 各状态变体 /
 * 上下内边距 / 高度）全部丢掉 —— 那些交给上游的 button.css 决定，
 * 免得我们自己的类把上游的按钮改样（文字位置、按下效果、禁用态高度都是这么被带偏的）。
 * 保留的只有：宽度 / 横向内边距 / 间距 / 定位 / 对齐 / 字号字重。
 */
const LAYOUT_CLASS =
  /^(?:w-|min-w-|max-w-|px-|pl-|pr-|ps-|pe-|m[trblxy]-|self-|order-|grow|shrink|basis-|flex|inline-flex|items-|justify-|gap-|space-|absolute|relative|fixed|sticky|inset-|top-|right-|bottom-|left-|z-|truncate|opacity-|text-(?:xs|sm|base|lg)|font-(?:light|normal|medium|semibold|bold)|whitespace-|break-|overflow-|cursor-|select-|pointer-events-|rb-nohover)/

function layoutOnly(className: string): string {
  return className
    .split(/\s+/)
    .filter((name) => name !== '' && !name.includes(':') && LAYOUT_CLASS.test(name))
    .join(' ')
}

/**
 * OreUI 按钮。
 *
 * 上游的组件（OreUIButton，components/controls/button/index.js）最终渲染出的就是一个
 * `<button class="oreui_btn_inner [size_*] status_*">文字</button>`，外观全部来自
 * 上游的 button.css。这里复现同一个结构，并把我们自己的类收窄到「布局」那几个，
 * 于是底色 / 凿边 / 描边 / 字体 / 按下效果 / 禁用态都跟上游一模一样。
 *
 * 切到 OreUI 主题时才换类名；其他主题继续用调用方原本的类名，外观与手感不变。
 */
export default function OreButton({
  status = 'normal',
  className = '',
  children,
  href,
  download,
  target,
  rel,
  ...rest
}: Props) {
  const oreui = useThemeMode() === 'oreui'
  const cls = oreui ? `oreui_btn_inner status_${status} ${layoutOnly(className)}`.trim() : className
  if (href !== undefined) {
    return (
      <a href={href} download={download} target={target} rel={rel} className={cls}>
        {children}
      </a>
    )
  }
  return (
    <button className={cls} {...rest}>
      {children}
    </button>
  )
}
