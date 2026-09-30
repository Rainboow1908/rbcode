import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface Props {
  /** 后端已累计的输出（按增量写进终端） */
  text: string
  /** 用户按键：原样送到后端 shell 的 stdin（回车是 \r，方向键/^C 也原样传） */
  onInput: (data: string) => void
  /** 后端没有 PTY 时我们自己回显；有 PTY 时 shell 会回显，必须关掉（否则双份） */
  localEcho?: boolean
  className?: string
}

/**
 * 真正的终端：显示归 xterm 管（ANSI 颜色 / \r 覆盖 / 清屏 / 光标），
 * 输入也归 xterm 管（onData 原样转发给后端 shell 的 stdin）。
 * 我们自己不再放输入框，避免两边抢焦点。
 */
export default function XtermTerminal({ text, onInput, localEcho = true, className = '' }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const writtenRef = useRef(0)
  // 用 ref 存回调，避免因为父组件每次渲染换函数而重建终端
  const inputRef = useRef(onInput)
  inputRef.current = onInput
  /** 本地回显记住的「当前这一行」（退格不会越行删到提示符） */
  const echoRef = useRef('')
  const localEchoRef = useRef(localEcho)
  localEchoRef.current = localEcho

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      fontSize: 11,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: { background: 'rgba(0,0,0,0)' },
      scrollback: 5000,
      cursorBlink: false,
      convertEol: false,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    writtenRef.current = 0
    // 不做本地回显：shell 自己会回显提示符和整行命令（实测 cmd 一定会）。
    // 我们之前每敲一个键就往终端写一次，既闪屏、又把 cmd 的提示符位置搅乱 —— 删掉。
    const dataSub = term.onData((chunk) => {
      // 方向键 / 功能键原样送；回车统一成 \r（父组件再按平台补 \n / \r\n）
      let send = ''
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          if (!send.endsWith('\r')) send += '\r'
        } else if (ch === '\u007f' || ch === '\b') {
          send += '\u007f'
        } else if (ch >= ' ' || ch === '\t') {
          send += ch
        }
      }
      if (!send) return

      // 本地回显（只在后端没有 PTY 时做）：有 PTY 时 shell 自己会回显，做了就双份。
      if (localEchoRef.current) {
        let line = echoRef.current
        for (const ch of send) {
          if (ch === '\r') {
            line = ''
          } else if (ch === '\u007f') {
            if (line.length > 0) {
              line = line.slice(0, -1)
              term.write('\b \b')
            }
          } else {
            line += ch
            term.write(ch)
          }
        }
        echoRef.current = line
      }
      inputRef.current(send)
    })

    // 关键：只有尺寸真的变了才 fit()。否则 fit() 改尺寸 → ResizeObserver 再触发 →
    // 又 fit()，会死循环把界面卡死（上一版的「输入像死了」就是它）。
    let lastW = -1
    let lastH = -1
    let raf = 0
    const resize = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const w = host.clientWidth
        const h = host.clientHeight
        if (w === lastW && h === lastH) return
        lastW = w
        lastH = h
        try {
          fit.fit()
        } catch {
          // 容器还没量出尺寸，忽略
        }
      })
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      dataSub.dispose()
      term.dispose()
      termRef.current = null
    }
  }, [])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    // 文本因为超上限被截断过：整屏重画
    if (text.length < writtenRef.current) {
      term.reset()
      writtenRef.current = 0
    }
    if (text.length > writtenRef.current) {
      term.write(text.slice(writtenRef.current))
      writtenRef.current = text.length
    }
  }, [text])

  return <div ref={hostRef} className={className} onMouseDown={() => termRef.current?.focus()} />
}
