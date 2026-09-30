import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useT } from '../lib/i18n.ts'
import { CheckIcon, ChevronRightIcon, SearchIcon } from './icons.tsx'

export interface SelectOption<T extends string> {
  value: T
  label: ReactNode
  /** 搜索用的关键字（label 是节点时必填，比如带上别名 / 地址） */
  keywords?: string
  /** 所属分类：相邻同类只显示一次分类标题（已本地化的文案） */
  group?: string
}

interface Props<T extends string> {
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
  /** 当前值不在 options 里时显示的占位文案 */
  placeholder?: string
  /** 触发按钮的额外类名（控制宽度等） */
  className?: string
  /** 选项很多时打开搜索框（按 label / keywords 过滤） */
  searchable?: boolean
}

/**
 * 自定义下拉选择（替掉原生 <select>，那样没法统一风格、也没法加动画）。
 * 点开是一片带弹出动画的菜单，当前项打勾；选项多时可以带搜索框。
 */
export default function Select<T extends string>({
  value,
  options,
  onChange,
  placeholder,
  className = '',
  searchable = false,
}: Props<T>) {
  const t = useT()
  const [open, setOpen] = useState(false)
  /** 下面空间不够时向上弹（靠近页面底部的下拉就不会被裁掉） */
  const [dropUp, setDropUp] = useState(false)
  /** 靠近窗口右边缘时改为右对齐，避免面板往右溢出 */
  const [alignRight, setAlignRight] = useState(false)
  const [query, setQuery] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const current = options.find((option) => option.value === value)

  const toggle = () => {
    if (!open) {
      const rect = boxRef.current?.getBoundingClientRect()
      if (rect) {
        const below = window.innerHeight - rect.bottom
        setDropUp(below < 280 && rect.top > below)
        // 预留 340px 面板宽度，装不下就贴右边
        setAlignRight(rect.left + 340 > window.innerWidth - 8)
      }
      setQuery('')
    }
    setOpen((v) => !v)
  }

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    if (searchable) searchRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [open, searchable])

  /** 过滤后的选项（label 是字符串时直接匹配，否则用 keywords） */
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return options
    return options.filter((option) => {
      const text =
        option.keywords ??
        (typeof option.label === 'string' ? option.label : option.value)
      return `${text} ${option.value}`.toLowerCase().includes(keyword)
    })
  }, [options, query])

  return (
    <div ref={boxRef} className={`relative inline-block max-w-full ${className}`}>
      <button
        type="button"
        onClick={toggle}
        className="rb-field flex h-8 w-full items-center justify-end gap-1.5 rounded-lg bg-neutral-800/60 px-2 text-xs text-neutral-200 outline-none transition-colors hover:bg-neutral-800 focus:bg-neutral-800 focus-visible:ring-1 focus-visible:ring-neutral-600"
      >
        <span className="min-w-0 truncate">
          {current?.label ?? placeholder ?? t('请选择', 'Select…', '請選擇', '選択してください')}
        </span>
        <ChevronRightIcon
          className={`h-3.5 w-3.5 shrink-0 text-neutral-500 transition-transform ${
            open ? '-rotate-90' : 'rotate-90'
          }`}
        />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            className={`rb-menu anim-pop absolute z-40 flex max-h-72 w-max min-w-full max-w-[min(90vw,32rem)] flex-col overflow-hidden rounded-lg border border-neutral-700 shadow-xl ${
              alignRight ? 'right-0' : 'left-0'
            } ${dropUp ? 'bottom-full mb-1' : 'top-full mt-1'}`}
          >
            {searchable && (
              <div className="flex items-center gap-1.5 border-b border-neutral-800 px-2 py-1.5">
                <SearchIcon className="h-3.5 w-3.5 shrink-0 text-neutral-600" />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('搜索…', 'Search…', '搜尋…', '検索…')}
                  className="min-w-0 flex-1 bg-transparent text-xs text-neutral-200 outline-none placeholder:text-neutral-600"
                />
              </div>
            )}
            <div className="min-h-0 overflow-y-auto p-1">
              {filtered.length === 0 && (
                <p className="px-2.5 py-2 text-xs text-neutral-600">
                  {t('没有匹配项', 'No matches', '沒有符合項目', '一致する項目なし')}
                </p>
              )}
              {filtered.map((option, index) => {
                const active = option.value === value
                const showGroup = Boolean(option.group) && option.group !== filtered[index - 1]?.group
                return (
                  <div key={option.value}>
                    {showGroup && (
                      <div className="px-2.5 pt-2 pb-1 text-[10px] tracking-wider text-neutral-600 uppercase">
                        {option.group}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        onChange(option.value)
                        setOpen(false)
                      }}
                      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs whitespace-nowrap transition-colors ${
                        active
                          ? 'bg-neutral-800 text-neutral-100'
                          : 'text-neutral-300 hover:bg-neutral-800/60'
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">{option.label}</span>
                      {active && <CheckIcon className="h-3.5 w-3.5 shrink-0 text-amber-400" />}
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
