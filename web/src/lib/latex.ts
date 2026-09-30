/**
 * 有些模型会直接吐**一整篇 LaTeX 文档**（\documentclass、\begin{document}、\section、
 * \begin{equation}…），而 KaTeX 只渲染数学模式（$…$ / $$…$$）。
 * equation / align / boxed 这些其实 KaTeX 都支持 —— 只是模型把它们写在了数学模式外面。
 *
 * 这里做一层纯文本预处理：去掉导言区、章节命令变 markdown 标题、各种数学环境包成 $$…$$，
 * 之后 KaTeX 就能正常渲染了（不用再引 latex.js 那种整文档渲染库）。
 */
/**
 * 去掉一个「{…} 参数」命令的外壳，只留里面的内容（括号要配对，支持嵌套）。
 * KaTeX 把 \boxed 画成一个竖条元素（.katex-stretchy.fbox），在聊天里就是条莫名其妙的竖线，
 * 所以直接把 \boxed{...} 展开成 ...。
 */
function unwrapBraced(text: string, name: string): string {
  const token = `\\${name}{`
  let out = ''
  let i = 0
  for (;;) {
    const at = text.indexOf(token, i)
    if (at < 0) {
      out += text.slice(i)
      break
    }
    out += text.slice(i, at)
    let depth = 0
    let end = -1
    for (let j = at + token.length - 1; j < text.length; j++) {
      const ch = text[j]
      if (ch === '\\') {
        j += 1
        continue
      }
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          end = j
          break
        }
      }
    }
    if (end < 0) {
      out += text.slice(at)
      break
    }
    out += text.slice(at + token.length, end)
    i = end + 1
  }
  return out
}

/** 从 text[pos]（必须是 '{'）取一个配对的花括号参数 */
function takeBraced(text: string, pos: number): { value: string; end: number } | null {
  let depth = 0
  for (let j = pos; j < text.length; j++) {
    const ch = text[j]
    if (ch === '\\') {
      j += 1
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return { value: text.slice(pos + 1, j), end: j + 1 }
    }
  }
  return null
}

/**
 * 把 `\cmd{arg1}{arg2}…` 换成 build(args) 的结果（参数个数固定）。
 * build 返回 null 表示原样保留。
 */
function replaceCommandWithArgs(
  text: string,
  token: string,
  argCount: number,
  build: (args: string[]) => string | null,
): string {
  let out = ''
  let i = 0
  for (;;) {
    const at = text.indexOf(token, i)
    if (at < 0) {
      out += text.slice(i)
      break
    }
    // 后面必须紧跟 '{'（允许中间有空格），否则不是这个命令
    let p = at + token.length
    while (text[p] === ' ') p += 1
    const args: string[] = []
    let cursor = p
    let ok = true
    for (let n = 0; n < argCount; n++) {
      const got = takeBraced(text, cursor)
      if (!got) {
        ok = false
        break
      }
      args.push(got.value)
      cursor = got.end
      while (text[cursor] === ' ') cursor += 1
    }
    if (!ok) {
      out += text.slice(i, at + token.length)
      i = at + token.length
      continue
    }
    const replaced = build(args)
    if (replaced === null) {
      out += text.slice(i, cursor)
    } else {
      out += text.slice(i, at) + replaced
    }
    i = cursor
  }
  return out
}

/**
 * KaTeX 没实现的命令 -> 等价写法。
 * 覆盖常见扩展包：unicode-math（\symbf/\mathds…）、bm、mathtools（\prescript）、
 * cancel（\cancelto）、以及 subequations/\notag/\label 这些纯排版命令。
 */
const SIMPLE_SHIMS: [RegExp, string][] = [
  // unicode-math / 各种字体别名
  [/\\mathds\{/g, '\\mathbb{'],
  [/\\symbfit\{/g, '\\mathbf{'],
  [/\\symbfup\{/g, '\\mathbf{'],
  [/\\symbf\{/g, '\\mathbf{'],
  [/\\symit\{/g, '\\mathit{'],
  [/\\symup\{/g, '\\mathrm{'],
  [/\\symrm\{/g, '\\mathrm{'],
  [/\\symsfup\{/g, '\\mathsf{'],
  [/\\symsf\{/g, '\\mathsf{'],
  [/\\symtt\{/g, '\\mathtt{'],
  [/\\symcal\{/g, '\\mathcal{'],
  [/\\symscr\{/g, '\\mathscr{'],
  [/\\symfrak\{/g, '\\mathfrak{'],
  [/\\symbb\{/g, '\\mathbb{'],
  // bm / pmb
  [/\\bm\{/g, '\\mathbf{'],
  [/\\pmb\{/g, '\\mathbf{'],
  // 纯排版 / 编号相关：直接去掉
  [/\\notag\b/g, ''],
  [/\\nonumber\b/g, ''],
  [/\\label\{[^{}]*\}/g, ''],
  [/\\vspace\*?\{[^{}]*\}/g, ''],
  [/\\begin\{subequations\}/g, ''],
  [/\\end\{subequations\}/g, ''],
  [/\\begin\{dmath\}/g, ''],
  [/\\end\{dmath\}/g, ''],
  [/\\hspace\*?\{[^{}]*\}/g, '\\;'],
  [/\\intertext\s*\{/g, '\\text{'],
  [/\\eqref\{([^{}]*)\}/g, '(\\mathrm{$1})'],
  [/\\ref\{([^{}]*)\}/g, '\\mathrm{$1}'],
  // mathtools 的 cases 变体 / 带星号的矩阵：KaTeX 只认基础名
  [/\\begin\{dcases\*?\}/g, '\\begin{cases}'],
  [/\\end\{dcases\*?\}/g, '\\end{cases}'],
  [/\\begin\{rcases\*?\}/g, '\\begin{cases}'],
  [/\\end\{rcases\*?\}/g, '\\end{cases}'],
  [/\\begin\{cases\*\}/g, '\\begin{cases}'],
  [/\\end\{cases\*\}/g, '\\end{cases}'],
  [/\\begin\{(p|b|B|v|V|small)?matrix\*\}/g, '\\begin{$1matrix}'],
  [/\\end\{(p|b|B|v|V|small)?matrix\*\}/g, '\\end{$1matrix}'],
  // multline 的左右对齐命令
  [/\\shoveleft\b/g, ''],
  [/\\shoveright\b/g, ''],
  // extarrows 的 \xlongequal{X} -> \overset{=}{X}
  [/\\xlongequal\{/g, '\\overset{=}{'],
  [/\\xlongleftrightarrow\{/g, '\\overset{\\longleftrightarrow}{'],
  [/\\xLeftrightarrow\{/g, '\\overset{\\Longleftrightarrow}{'],
]

/** 显示环境里多出来的 {列数} 参数（alignat）KaTeX 的 aligned 不认，去掉 */
function stripAlignatArg(text: string): string {
  return text.replace(/(\\begin\{aligned(at)?\})\s*\{[^{}]*\}/g, '$1')
}

/** \DeclareMathOperator{\Tr}{Tr} -> 记住 \Tr，之后换成 \operatorname{Tr} */
function hoistMathOperators(text: string): { text: string; ops: Map<string, string> } {
  const ops = new Map<string, string>()
  let out = replaceCommandWithArgs(text, '\\DeclareMathOperator', 2, (args) => {
    const name = args[0].trim().replace(/^\\/, '').replace(/\*$/, '')
    const body = args[1]
    if (!name) return null
    ops.set(name, body)
    return ''
  })
  out = replaceCommandWithArgs(out, '\\DeclareMathOperator*', 2, (args) => {
    const name = args[0].trim().replace(/^\\/, '')
    if (!name) return null
    ops.set(name, args[1])
    return ''
  })
  return { text: out, ops }
}

function applyMathOperators(text: string, ops: Map<string, string>): string {
  let out = text
  for (const [name, body] of ops) {
    out = out.replace(new RegExp(`\\\\${name}\\b`, 'g'), `\\operatorname{${body}}`)
  }
  return out
}

/**
 * 只在「非代码」片段上跑变换：``` 围栏块 与 `行内代码` 里的反斜杠是**示例文本**，
 * 不能当成公式去处理（否则会把段落结构撑坏，变成一堆 `…`、`、` 碎片）。
 */
function mapOutsideCode(input: string, fn: (chunk: string) => string): string {
  const re = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g
  let out = ''
  let last = 0
  for (const match of input.matchAll(re)) {
    const at = match.index ?? 0
    out += fn(input.slice(last, at))
    out += match[0]
    last = at + match[0].length
  }
  out += fn(input.slice(last))
  return out
}

/**
 * MathJax 渲染不了的真·LaTeX 排版/颜色命令（面板那类）。
 * 碰到这些**不按公式渲染**，改成带标注的代码块 —— 免得 MathJax 报错画成「黄底红字」。
 */
const UNSUPPORTED_LATEX =
  /\\(fcolorbox|colorbox|scalebox|resizebox|footnotesize|rule|boxtimes|square|blacksquare|numberwithin|newtheorem|newcommand|renewcommand|providecommand|allowdisplaybreaks|documentclass|usepackage|maketitle|verb)\b/

/** 渲染不了就原样显示，并标注「不支持」 */
function unsupportedBlock(inner: string): string {
  return `\n\u0060\u0060\u0060text\n[不支持的 LaTeX 语法，已按源码显示]\n${inner}\n\u0060\u0060\u0060\n`
}

/** 能渲染成公式就转成公式，渲染不了就转成带标注的代码块 */
function toMath(inner: string, display: boolean): string {
  const body = inner.trim()
  if (UNSUPPORTED_LATEX.test(body)) return `\n${unsupportedBlock(body)}`
  return display ? `\n$$\n${body}\n$$\n` : `$${body}$`
}

function transformLatex(input: string): string {
  let text = input

  // 0) \DeclareMathOperator 先登记（它本身在 KaTeX 里是报错的）
  const hoisted = hoistMathOperators(text)
  text = hoisted.text

  // 0.5) KaTeX 没有的命令 -> 等价写法
  for (const [pattern, replacement] of SIMPLE_SHIMS) text = text.replace(pattern, replacement)
  // \prescript{上}{下}{X} -> {}^{上}_{下}X
  text = replaceCommandWithArgs(text, '\\prescript', 3, (args) =>
    args.length === 3 ? `{}^{${args[0]}}_{${args[1]}}${args[2]}` : null,
  )
  // \cancelto{目标}{X} -> \cancel{X}
  text = replaceCommandWithArgs(text, '\\cancelto', 2, (args) =>
    args.length === 2 ? `\\cancel{${args[1]}}` : null,
  )
  // \xrightarrow 之类 KaTeX 支持；\xRightarrow 也支持。其余未列出的保持原样（KaTeX 会显示为源码）

  // 0) 把只影响排版的盒子命令拆掉（KaTeX 会把 \boxed 画成一条竖线）
  text = unwrapBraced(text, 'boxed')
  text = unwrapBraced(text, 'fbox')

  // 1) 导言区 / 文档包裹：直接去掉（聊天里不需要标题页、页边距这些）
  text = text.replace(/\\documentclass(\[[^\]]*\])?\{[^{}]*\}/g, '')
  text = text.replace(/\\usepackage(\[[^\]]*\])?\{[^{}]*\}/g, '')
  text = text.replace(/\\begin\{document\}/g, '')
  text = text.replace(/\\end\{document\}/g, '')
  text = text.replace(/\\maketitle/g, '')
  text = text.replace(/\\(title|author|date)\{[^{}]*\}/g, '')
  text = text.replace(/\\(geometry|setlength|pagestyle)\{[^{}]*\}(\[[^\]]*\])?\{[^{}]*\}/g, '')
  text = text.replace(/\\geometry\{[^{}]*\}/g, '')

  // 2) 章节命令 -> markdown 标题（原样贴在一行里也能变成标题）
  text = text.replace(/\\(sub){0,2}section\*?\{([^{}]*)\}/g, (_, sub: string | undefined, title: string) => {
    const level = sub ? (sub.length > 4 ? '####' : '###') : '##'
    return `\n\n${level} ${title}\n\n`
  })

  // 3) \[ … \] -> $$ … $$；\( … \) -> $ … $
  text = text.replace(/\\\[([\s\S]*?)\\\]/g, (_, body: string) => toMath(body, true))
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, (_, body: string) => toMath(body, false))

  // 4) 各种数学环境 -> $$…$$（align/gather 之类在 KaTeX 里要用 aligned）
  //    注意 alignat 后面还有个 {列数} 参数，要一起吃掉
  text = text.replace(
    /\\begin\{(equation\*?|align\*?|alignat\*?|flalign\*?|gather\*?|multline\*?|eqnarray\*?|displaymath|dmath\*?)\}\s*(?:\{[^{}]*\})?([\s\S]*?)\\end\{\1\}/g,
    (_, env: string, body: string) => {
      const needsAligned = /^(align|alignat|flalign|gather|multline|eqnarray)/.test(env)
      const inner = needsAligned ? `\\begin{aligned}${body}\\end{aligned}` : body
      return `\n$$\n${inner.trim()}\n$$\n`
    },
  )
  text = stripAlignatArg(text)

  // 5) 去掉多余空行（最多留一个空行）
  text = text.replace(/\n{3,}/g, '\n\n')

  // 6) \DeclareMathOperator 定义的算子 -> \operatorname{…}
  return applyMathOperators(text, hoisted.ops)
}

/** 把整篇 LaTeX 文档/环境转成 markdown + $$…$$（代码块与行内代码原样保留） */
export function preprocessLatex(input: string): string {
  if (!input || !input.includes('\\')) return input
  return mapOutsideCode(input, transformLatex)
}
