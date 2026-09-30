import { useEffect, useRef, useState } from 'react'

let seq = 0

/**
 * mermaid 图（```mermaid 代码块）。
 * mermaid 本身很大，所以按需 import：只有真的出现 mermaid 块才会下载它。
 */
export default function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')
  const idRef = useRef(`rb-mermaid-${(seq += 1)}`)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize({
          startOnLoad: false,
          theme: 'dark',
          securityLevel: 'strict',
          // v11+ 出错时默认会往页面里塞一张「Syntax error」的炸弹图，关掉它，走我们自己的错误分支
          suppressErrorRendering: true,
        })
        // parse 会在语法错误时抛异常（render 不会）
        await mermaid.parse(code)
        const { svg: out } = await mermaid.render(idRef.current, code)
        if (alive) setSvg(out)
      } catch (err) {
        if (alive) setError(String((err as Error)?.message ?? err))
      }
    })()
    return () => {
      alive = false
    }
  }, [code])

  if (error) {
    return (
      <div className="my-2 overflow-x-auto rounded-lg border border-amber-900/50 bg-amber-950/20 p-2">
        <div className="mb-1 text-[11px] text-amber-300">
          mermaid 渲染失败：{error}
        </div>
        <pre className="font-mono text-[11px] break-all whitespace-pre-wrap text-neutral-300">{code}</pre>
      </div>
    )
  }

  return (
    <div
      className="rb-mermaid my-2 flex justify-center overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-900/40 p-3"
      // mermaid 输出的是它自己生成的 SVG（securityLevel: strict）
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
