import { describe, expect, it } from 'vitest'
import { preprocessLatex } from '../lib/latex.ts'

/** 模型真吐过的一整篇 LaTeX 文档（用户反馈的那份） */
const DOC = String.raw`\documentclass[11pt]{ctexart} \usepackage{amsmath,amssymb} \usepackage{geometry} \geometry{a4paper,margin=2.5cm}

\title{一道分数的精确计算} \author{RB Code} \date{\today}

\begin{document} \maketitle

\section{问题} 计算下列表达式的精确值： \begin{equation} \frac{3}{5}+\frac{8898}{93}+8^{7}. \end{equation}

\section{求解过程} 先计算幂： \begin{equation} 8^{7}=2097152. \end{equation} 再把两个分数通分： \begin{equation} \frac{3}{5}+\frac{8898}{93}=\frac{279}{465}+\frac{44490}{465}=\frac{44769}{465}=\frac{14923}{155}, \end{equation} 其中最后一步用最大公约数 3 约分。于是 \begin{align} 2097152+\frac{14923}{155} &=\frac{2097152\times 155+14923}{155}\\ &=\frac{325058560+14923}{155}\\ &=\frac{325073483}{155}. \end{align}

\section{结论} \begin{equation*} \boxed{\frac{3}{5}+\frac{8898}{93}+8^{7}} =\frac{325073483}{155}\approx 2{,}097{,}248.2774193548. \end{equation*}

\end{document}`

describe('preprocessLatex', () => {
  it('去掉导言区与文档包裹', () => {
    const out = preprocessLatex(DOC)
    expect(out).not.toContain('\\documentclass')
    expect(out).not.toContain('\\usepackage')
    expect(out).not.toContain('\\begin{document}')
    expect(out).not.toContain('\\maketitle')
    expect(out).not.toContain('\\title{')
  })

  it('章节命令变成 markdown 标题', () => {
    const out = preprocessLatex(DOC)
    expect(out).toContain('## 问题')
    expect(out).toContain('## 求解过程')
    expect(out).toContain('## 结论')
  })

  it('equation / equation* / align 都包成 $$…$$，align 用 aligned', () => {
    const out = preprocessLatex(DOC)
    expect(out).toContain('\\frac{3}{5}+\\frac{8898}{93}+8^{7}')
    expect(out).toContain('\\begin{aligned}')
    expect(out).not.toContain('\\boxed{')
    // 每个数学环境外层都应该是 $$
    const dollarBlocks = out.split('$$').length - 1
    expect(dollarBlocks % 2).toBe(0)
    expect(dollarBlocks).toBeGreaterThanOrEqual(6)
  })

  it('\\[ … \\] 与 \\( … \\) 也转成 $$ / $', () => {
    expect(preprocessLatex('\\[ a+b \\]')).toContain('$$\na+b\n$$')
    expect(preprocessLatex('\\(a+b\\)')).toContain('$a+b$')
  })

  it('\\boxed 外壳被拆掉（KaTeX 会把它画成一条竖线）', () => {
    expect(preprocessLatex('\\boxed{\\frac{3}{5}+8^{7}} = x')).toBe('\\frac{3}{5}+8^{7} = x')
    // 嵌套也要正确配对
    expect(preprocessLatex('\\boxed{a+\\frac{1}{2}}')).toBe('a+\\frac{1}{2}')
  })

  it('代码块 / 行内代码里的反斜杠不动（它们是示例文本，不是公式）', () => {
    expect(preprocessLatex('用 `\\(a\\)` 表示行内')).toBe('用 `\\(a\\)` 表示行内')
    expect(preprocessLatex('```\n\\[ x \\]\n```')).toBe('```\n\\[ x \\]\n```')
    expect(preprocessLatex('`\\(a\\)` 和 \\(b\\)')).toBe('`\\(a\\)` 和 $b$')
  })

  it('补上 KaTeX 没有的命令（shim）', () => {
    // unicode-math / bm
    expect(preprocessLatex('\\mathds{1}')).toContain('\\mathbb{1}')
    expect(preprocessLatex('\\symbf{v}')).toContain('\\mathbf{v}')
    expect(preprocessLatex('\\bm{x}')).toContain('\\mathbf{x}')
    // mathtools 的 \prescript
    expect(preprocessLatex('\\prescript{a}{b}{X}')).toContain('{}^{a}_{b}X')
    // cancel 的 \cancelto
    expect(preprocessLatex('\\cancelto{0}{x}')).toContain('\\cancel{x}')
    // 纯排版命令直接去掉
    expect(preprocessLatex('a \\notag b')).toContain('a  b')
    expect(preprocessLatex('\\begin{subequations}x\\end{subequations}')).toBe('x')
    // \DeclareMathOperator -> \operatorname
    const declared = preprocessLatex('\\DeclareMathOperator{\\Tr}{Tr} $\\Tr A$')
    expect(declared).not.toContain('\\DeclareMathOperator')
    expect(declared).toContain('\\operatorname{Tr}')
  })

  it('alignat 的列数参数被吃掉', () => {
    const out = preprocessLatex('\\begin{alignat}{2} x &= 1 \\end{alignat}')
    expect(out).not.toContain('{2}')
    expect(out).toContain('\\begin{aligned}')
  })

  it('没有反斜杠的普通文本原样返回', () => {
    expect(preprocessLatex('就是普通的一句话')).toBe('就是普通的一句话')
  })

  it('渲染不了的 LaTeX（面板类）转成带标注的代码块，而不是让 MathJax 报错', () => {
    const panel = '\\(\\fcolorbox{#3E2C1F}{#3D3D3D}{ x }\\)'
    const out = preprocessLatex(panel)
    expect(out).toContain('```text')
    expect(out).toContain('不支持的 LaTeX 语法')
    expect(out).not.toContain('$$')
  })
})
