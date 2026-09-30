import { normalizePath, joinPath } from './path.ts'
import type { FileNode, ShellResult } from './types.ts'

/** 迷你 shell 依赖的最小文件系统接口 */
export interface ShellContext {
  getCwd(): string
  setCwd(path: string): void
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  list(path: string): Promise<FileNode[]>
  mkdir(path: string): Promise<void>
  remove(path: string, opts: { recursive: boolean }): Promise<void>
  glob(pattern: string): Promise<string[]>
  exists(path: string): Promise<boolean>
}

const HELP = `Built-in mini shell (browser sandbox). Available commands:
  pwd, cd, ls [-l] [path], cat <file>, head/tail [-n N] <file>, wc -l <file>
  echo <text> [> file] [>> file], mkdir -p <dir>, rm [-r] <path>, touch <file>
  cp <src> <dst>, mv <src> <dst>, grep <pattern> [--include=glob] [path]
  find <path> -name <glob>, tree [path], help
Note: this is a restricted shell running inside the browser. It only touches the
directory the user granted, and cannot run system programs (python, git, ...).`

export async function runShell(ctx: ShellContext, input: string): Promise<ShellResult> {
  const parts = splitTopLevel(input)
  let stdout = ''
  let stderr = ''
  let exitCode = 0

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (!part.cmd.trim()) continue
    const res = await runSingle(ctx, part.cmd)
    stdout += res.stdout
    stderr += res.stderr
    exitCode = res.exitCode

    const joiner = part.joiner
    if (joiner === 'and' && res.exitCode !== 0) break
    if (joiner === 'or' && res.exitCode === 0) break
  }

  return { stdout, stderr, exitCode }
}

interface CommandPart {
  cmd: string
  joiner?: 'and' | 'or' | 'seq'
}

/** 按顶层 && || ; 与换行切分命令 */
function splitTopLevel(input: string): CommandPart[] {
  const parts: CommandPart[] = []
  let cur = ''
  let quote: string | null = null

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quote) {
      cur += ch
      if (ch === '\\') {
        if (i + 1 < input.length) cur += input[++i]
      } else if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === '&' && input[i + 1] === '&') {
      parts.push({ cmd: cur, joiner: 'and' })
      cur = ''
      i++
      continue
    }
    if (ch === '|' && input[i + 1] === '|') {
      parts.push({ cmd: cur, joiner: 'or' })
      cur = ''
      i++
      continue
    }
    if (ch === ';' || ch === '\n') {
      parts.push({ cmd: cur, joiner: 'seq' })
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) parts.push({ cmd: cur })
  return parts
}

function tokenize(input: string): string[] {
  const tokens: string[] = []
  let cur = ''
  let has = false
  let quote: string | null = null

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < input.length) {
        cur += input[++i]
        continue
      }
      if (ch === quote) {
        quote = null
        continue
      }
      cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      has = true
      continue
    }
    if (ch === '\\' && i + 1 < input.length) {
      cur += input[++i]
      has = true
      continue
    }
    if (/\s/.test(ch)) {
      if (has || cur) {
        tokens.push(cur)
        cur = ''
        has = false
      }
      continue
    }
    cur += ch
  }
  if (has || cur) tokens.push(cur)
  return tokens
}

/** 抽出末尾的 > / >> 重定向目标 */
function extractRedirect(raw: string): {
  command: string
  redirect?: { path: string; append: boolean }
} {
  let quote: string | null = null
  let index = -1
  let append = false

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '>') {
      if (index !== -1) break
      append = raw[i + 1] === '>'
      index = i
      i += append ? 1 : 0
    }
  }

  if (index === -1) return { command: raw }
  const target = raw.slice(index + (append ? 2 : 1)).trim()
  if (!target) return { command: raw }
  return { command: raw.slice(0, index).trim(), redirect: { path: target, append } }
}

function ok(stdout: string): ShellResult {
  return { stdout, stderr: '', exitCode: 0 }
}

function fail(stderr: string, exitCode = 1): ShellResult {
  return { stdout: '', stderr: `${stderr}\n`, exitCode }
}

async function runSingle(ctx: ShellContext, raw: string): Promise<ShellResult> {
  const { command, redirect } = extractRedirect(raw)
  const tokens = tokenize(command)
  if (tokens.length === 0) return ok('')

  const [cmd, ...args] = tokens
  let result: ShellResult
  try {
    result = await dispatch(ctx, cmd, args)
  } catch (err) {
    return fail(`${cmd}: ${(err as Error).message}`)
  }

  if (redirect && result.exitCode === 0) {
    const target = resolvePath(ctx, redirect.path)
    try {
      const prev = redirect.append ? await ctx.readFile(target).catch(() => '') : ''
      await ctx.writeFile(target, prev + result.stdout)
      return { stdout: '', stderr: result.stderr, exitCode: 0 }
    } catch (err) {
      return fail(`cannot write ${redirect.path}: ${(err as Error).message}`)
    }
  }

  return result
}

function resolvePath(ctx: ShellContext, path: string): string {
  const p = path.trim()
  if (!p || p === '.') return ctx.getCwd()
  if (p === '/') return ''
  if (p.startsWith('/')) return normalizePath(p)
  return joinPath(ctx.getCwd(), p)
}

async function dispatch(ctx: ShellContext, cmd: string, args: string[]): Promise<ShellResult> {
  const cwd = ctx.getCwd()

  switch (cmd) {
    case 'help':
    case '--help':
      return ok(`${HELP}\n`)

    case 'pwd':
      return ok(`${cwd ? `/${cwd}` : '/'}\n`)

    case 'cd': {
      const target = args[0] ?? ''
      if (!target || target === '~' || target === '/') {
        ctx.setCwd('')
        return ok('')
      }
      const path = resolvePath(ctx, target)
      const entries = await ctx.list(path)
      if (!Array.isArray(entries)) throw new Error(`not a directory: ${target}`)
      ctx.setCwd(path)
      return ok('')
    }

    case 'ls': {
      const flags = args.filter((a) => a.startsWith('-'))
      const paths = args.filter((a) => !a.startsWith('-'))
      const target = paths[0] ?? '.'
      const path = resolvePath(ctx, target)
      const long = flags.some((f) => f.includes('l') || f.includes('a'))

      if (!(await ctx.exists(path))) throw new Error(`no such file or directory: ${target}`)

      let entries: FileNode[]
      try {
        entries = await ctx.list(path)
      } catch {
        entries = []
      }
      if (entries.length === 0) {
        // 不是目录，就是单个文件
        return ok(`${target}\n`)
      }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      const lines = entries.map((e) =>
        e.kind === 'dir' ? `${e.name}/` : long ? `${e.name}  (${e.size} B)` : e.name,
      )
      return ok(`${lines.join('\n')}\n`)
    }

    case 'cat': {
      if (args.length === 0) throw new Error('missing file operand')
      let out = ''
      for (const file of args) {
        out += await ctx.readFile(resolvePath(ctx, file))
      }
      return ok(out)
    }

    case 'head':
    case 'tail': {
      const n = readCountFlag(args)
      const files = args.filter((a) => !/^-\d+$/.test(a) && a !== '-n')
      if (files.length === 0) throw new Error('missing file operand')
      const content = await ctx.readFile(resolvePath(ctx, files[0]))
      const lines = content.split('\n')
      const slice = cmd === 'head' ? lines.slice(0, n) : lines.slice(-n)
      return ok(`${slice.join('\n')}\n`)
    }

    case 'wc': {
      const files = args.filter((a) => !a.startsWith('-'))
      if (files.length === 0) throw new Error('missing file operand')
      const content = await ctx.readFile(resolvePath(ctx, files[0]))
      const lines = content === '' ? 0 : content.split('\n').length
      return ok(`${lines} lines  ${content.length} bytes  ${files[0]}\n`)
    }

    case 'echo':
      return ok(`${args.join(' ')}\n`)

    case 'mkdir': {
      const dirs = args.filter((a) => !a.startsWith('-'))
      if (dirs.length === 0) throw new Error('missing operand')
      for (const dir of dirs) await ctx.mkdir(resolvePath(ctx, dir))
      return ok('')
    }

    case 'touch': {
      const files = args.filter((a) => !a.startsWith('-'))
      if (files.length === 0) throw new Error('missing file operand')
      for (const file of files) {
        const path = resolvePath(ctx, file)
        if (!(await ctx.exists(path))) await ctx.writeFile(path, '')
      }
      return ok('')
    }

    case 'rm': {
      const recursive = args.some((a) => a.startsWith('-') && a.includes('r'))
      const targets = args.filter((a) => !a.startsWith('-'))
      if (targets.length === 0) throw new Error('missing operand')
      for (const target of targets) {
        const path = resolvePath(ctx, target)
        if (!(await ctx.exists(path))) throw new Error(`no such file or directory: ${target}`)
        await ctx.remove(path, { recursive })
      }
      return ok('')
    }

    case 'cp':
    case 'mv': {
      const operands = args.filter((a) => !a.startsWith('-'))
      if (operands.length < 2) throw new Error(`usage: ${cmd} <src> <dst>`)
      const src = resolvePath(ctx, operands[0])
      let dst = resolvePath(ctx, operands[1])
      if (await ctx.exists(dst)) {
        const entries = await ctx.list(dst).catch(() => [])
        if (entries.length > 0) dst = joinPath(dst, operands[0].replace(/^.*\//, ''))
      }
      const content = await ctx.readFile(src)
      await ctx.writeFile(dst, content)
      if (cmd === 'mv') await ctx.remove(src, { recursive: false })
      return ok('')
    }

    case 'grep': {
      const flags = args.filter((a) => a.startsWith('-'))
      const rest = args.filter((a) => !a.startsWith('-'))
      if (rest.length === 0) throw new Error('usage: grep <pattern> [path]')
      const pattern = rest[0]
      const target = rest[1] ?? '.'
      const include = flags.find((f) => f.startsWith('--include='))?.slice(10)
      const re = new RegExp(pattern, 'i')
      const files = await collectFiles(ctx, resolvePath(ctx, target), include)
      const hits: string[] = []
      for (const file of files) {
        const content = await ctx.readFile(file).catch(() => '')
        if (content.length > 2_000_000) continue
        content.split('\n').forEach((line, i) => {
          if (re.test(line)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 300)}`)
        })
        if (hits.length > 500) break
      }
      return hits.length ? ok(`${hits.slice(0, 500).join('\n')}\n`) : fail('', 1)
    }

    case 'find':
    case 'tree': {
      const nameFlag = args.indexOf('-name')
      if (cmd === 'find' && nameFlag !== -1) {
        const pattern = args[nameFlag + 1] ?? '*'
        const matches = await ctx.glob(pattern.includes('/') ? pattern : `**/${pattern}`)
        return ok(`${matches.join('\n')}\n`)
      }
      const target = args.find((a) => !a.startsWith('-')) ?? '.'
      const base = resolvePath(ctx, target)
      const entries = await ctx.glob(base ? `${base}/**/*` : '**/*')
      return ok(`${entries.slice(0, 500).join('\n')}\n`)
    }

    case 'python':
    case 'python3':
    case 'node':
    case 'npm':
    case 'git':
    case 'pip':
      return fail(
        `${cmd}: this command cannot run inside the browser sandbox.\n` +
          `To use the real ${cmd} from the system, start the local companion executor and select it in the settings.`,
      )

    default:
      return fail(`unknown command: ${cmd} (type "help" for the list)`)
  }
}

function readCountFlag(args: string[]): number {
  const idx = args.indexOf('-n')
  if (idx !== -1) {
    const n = Number(args[idx + 1])
    if (Number.isFinite(n)) return n
  }
  const inline = args.find((a) => /^-\d+$/.test(a))
  if (inline) return Number(inline.slice(1))
  return 10
}

async function collectFiles(
  ctx: ShellContext,
  target: string,
  include?: string,
): Promise<string[]> {
  const entries = await ctx.list(target).catch(() => null)
  if (entries === null) return [target]

  const files: string[] = []
  const matcher = include ? new RegExp(include.replace(/\./g, '\\.').replace(/\*/g, '.*')) : null

  const walk = async (path: string) => {
    const nodes = await ctx.list(path).catch(() => [] as FileNode[])
    for (const node of nodes) {
      const child = path ? `${path}/${node.name}` : node.name
      if (node.kind === 'dir') {
        await walk(child)
      } else if (!matcher || matcher.test(node.name)) {
        files.push(child)
      }
    }
  }
  await walk(target)
  return files
}
