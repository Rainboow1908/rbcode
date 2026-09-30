import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import type { PluggableList } from 'unified'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'highlight.js/styles/github-dark.css'
import CopyButton from './CopyButton.tsx'
import MermaidBlock from './MermaidBlock.tsx'
import { preprocessLatex } from '../lib/latex.ts'

/** 把 React 子树里的文本抠出来（代码块复制要用） */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && 'props' in node) {
    return textOf((node as { props?: { children?: ReactNode } }).props?.children)
  }
  return ''
}

function MarkdownImpl({ content }: { content: string }) {
  // 模型偶尔会直接吐一整篇 LaTeX 文档，先转成 markdown + $$…$$ 再交给 MathJax
  const prepared = useMemo(() => preprocessLatex(content), [content])

  // MathJax 体积很大（全量约 1.8MB），所以**只在真有公式时才按需加载**，
  // 让打包器把它拆成独立 chunk：普通对话不会下载它。
  const [mathjax, setMathjax] = useState<{ plugin: unknown } | null>(null)
  const wantsMath = useMemo(
    () =>
      /\$\$|\$[^$\n]+\$|\\\(|\\\[|\\begin\{(equation|align|alignat|flalign|gather|multline|cases|array|matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|smallmatrix|split|subequations)/.test(
        prepared,
      ),
    [prepared],
  )
  useEffect(() => {
    if (!wantsMath || mathjax) return
    let alive = true
    void import('rehype-mathjax')
      .then((mod) => {
        const plugin = (mod as { default?: unknown }).default ?? mod
        if (alive) setMathjax({ plugin })
      })
      .catch(() => {
        // 加载失败就按普通文本显示，别把公式变成代码块
      })
    return () => {
      alive = false
    }
  }, [wantsMath, mathjax])

  // 注意：remark-math 也要一起等。否则「有数学节点、但没有 rehype 插件接手」时，
  // remark-rehype 会把公式降级成 <code> —— 就是之前看到的「公式变成代码块」。
  const remarkPlugins = useMemo(() => (mathjax ? [remarkGfm, remarkMath] : [remarkGfm]), [mathjax])

  const rehypePlugins = useMemo(() => {
    const list: PluggableList = []
    if (mathjax) list.push([mathjax.plugin as never, { svg: { fontCache: 'local' } }])
    list.push([rehypeHighlight, { detect: true, ignoreMissing: true }])
    return list
  }, [mathjax])

  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={{
          // 外部链接新开标签，并避免把 react-markdown 的 node 属性透传到 DOM
          a: (props) => {
            const { node, ...rest } = props as React.ComponentProps<'a'> & { node?: unknown }
            void node
            return <a {...rest} target="_blank" rel="noreferrer noopener" />
          },
          // 代码块右上角挂一个复制按钮（悬停或键盘聚焦时出现）
          pre: (props) => {
            const { node, children, ...rest } = props as React.ComponentProps<'pre'> & {
              node?: unknown
            }
            void node
            // ```mermaid 代码块：直接画成图，而不是显示源码
            const first = Array.isArray(children) ? children[0] : children
            const cls =
              (first as { props?: { className?: string } } | undefined)?.props?.className ?? ''
            if (typeof cls === 'string' && cls.includes('language-mermaid')) {
              return <MermaidBlock code={textOf(children)} />
            }
            return (
              <div className="group/code relative">
                <CopyButton
                  text={textOf(children)}
                  className="absolute top-2 right-2 opacity-0 transition-opacity group-hover/code:opacity-100 focus:opacity-100"
                />
                <pre {...rest}>{children}</pre>
              </div>
            )
          },
        }}
      >
        {prepared}
      </ReactMarkdown>
    </div>
  )
}

export const Markdown = memo(MarkdownImpl)
