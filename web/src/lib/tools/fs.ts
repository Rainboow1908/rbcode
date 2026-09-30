import { formatBytes } from '../executor/path.ts'
import { snapshotTree } from '../undo.ts'
import { hitsRbcodePath, rbcodeRefusal } from './rbcode.ts'
import {
  failure,
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireString,
  text,
  type ToolDef,
} from './types.ts'

const MAX_LINES = 2000
/** 默认一次最多读多少行（限制单次输出，避免一次吃掉太多 token） */
const DEFAULT_LINES = 400

export const readFileTool: ToolDef = {
  readOnly: true,
  schema: {
    name: 'read_file',
    description:
      'Read a file. Each output line is prefixed with its line number in the form "N→content"; the numbers are only for locating text, never include them when editing. Use offset/limit to page through large files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the working directory' },
        offset: { type: 'number', description: 'First line to read, 1-based. Default 1' },
        limit: { type: 'number', description: `Maximum number of lines. Default ${DEFAULT_LINES}` },
      },
      required: ['path'],
    },
  },
  async run(args, ctx) {
    const path = requireString(args, 'path')
    if (hitsRbcodePath(path)) return failure(rbcodeRefusal(path))
    let raw: string
    try {
      raw = await ctx.backend.readFile(path)
    } catch (err) {
      return failure(`Failed to read: ${(err as Error).message}`)
    }

    const lines = raw.split('\n')
    const total = lines.length
    const offset = Math.max(1, Math.floor(optionalNumber(args, 'offset') ?? 1))
    const limit = Math.min(Math.max(1, Math.floor(optionalNumber(args, 'limit') ?? DEFAULT_LINES)), MAX_LINES)
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    const width = String(total).length
    const body = slice
      .map((line, i) => `${String(offset + i).padStart(width)}→${line}`)
      .join('\n')

    const shown = offset - 1 + slice.length
    const header =
      `File ${path} | ${total} lines | showing ${offset}-${shown}` +
      (shown < total ? ' (more lines remain, read on with offset)' : '')
    return text(`${header}\n${body}`)
  },
}

export const writeFileTool: ToolDef = {
  schema: {
    name: 'write_file',
    description:
      'Write the full content of a file (overwrites existing content, creates the file if missing, parent directories are created automatically). Read a file with read_file before overwriting it.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the working directory' },
        content: { type: 'string', description: 'Complete file content to write' },
      },
      required: ['path', 'content'],
    },
  },
  async run(args, ctx) {
    const path = requireString(args, 'path')
    if (hitsRbcodePath(path)) return failure(rbcodeRefusal(path))
    const content = typeof args.content === 'string' ? args.content : ''

    let before: string | null = null
    try {
      before = await ctx.backend.readFile(path)
    } catch {
      before = null
    }

    try {
      await ctx.backend.writeFile(path, content)
    } catch (err) {
      return failure(`Failed to write: ${(err as Error).message}`)
    }

    const undoId = await ctx.recordUndo({
      kind: before === null ? 'create' : 'modify',
      path,
      before,
      summary: before === null ? `Create ${path}` : `Modify ${path}`,
    })

    const message = `Wrote ${path} (${content.length} chars, ${content.split('\n').length} lines)`
    return { content: message, undoId, diff: lineDiffCounts(before, content) }
  },
}

export const editFileTool: ToolDef = {
  schema: {
    name: 'edit_file',
    description:
      'Replace an exact string in a file. old_string must match the file content character for character (without the line numbers). It must be unique unless replace_all is true.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the working directory' },
        old_string: { type: 'string', description: 'Exact text to replace' },
        new_string: { type: 'string', description: 'Replacement text; empty means delete' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence. Default false' },
      },
      required: ['path', 'old_string'],
    },
  },
  async run(args, ctx) {
    const path = requireString(args, 'path')
    if (hitsRbcodePath(path)) return failure(rbcodeRefusal(path))
    const oldString = requireString(args, 'old_string')
    const newString = typeof args.new_string === 'string' ? args.new_string : ''
    const replaceAll = optionalBoolean(args, 'replace_all')

    let original: string
    try {
      original = await ctx.backend.readFile(path)
    } catch (err) {
      return failure(`Failed to read: ${(err as Error).message}`)
    }

    const count = countOccurrences(original, oldString)
    if (count === 0) {
      return failure(
        `old_string was not found in ${path}. Use read_file to check the exact text (line numbers are not part of the content).`,
      )
    }
    if (count > 1 && !replaceAll) {
      return failure(
        `old_string occurs ${count} times in ${path}, cannot tell which one to replace. Add more context or set replace_all: true.`,
      )
    }

    const updated = replaceAll
      ? original.split(oldString).join(newString)
      : original.replace(oldString, newString)

    try {
      await ctx.backend.writeFile(path, updated)
    } catch (err) {
      return failure(`Failed to write: ${(err as Error).message}`)
    }

    const undoId = await ctx.recordUndo({
      kind: 'modify',
      path,
      before: original,
      summary: `Modify ${path}`,
    })

    return {
      content: `Edited ${path} (${replaceAll ? count : 1} replacement${(replaceAll ? count : 1) === 1 ? '' : 's'})`,
      undoId,
      diff: lineDiffCounts(original, updated),
    }
  },
}

export const deletePathTool: ToolDef = {
  dangerous: true,
  schema: {
    name: 'delete_path',
    description:
      'Delete a file or directory. Its content is snapshotted into the workspace .rbcode directory first, so the user can undo it. Needs user approval under the "auto" permission level.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File or directory to delete' },
        recursive: { type: 'boolean', description: 'Delete a directory recursively. Default false' },
      },
      required: ['path'],
    },
  },
  async run(args, ctx) {
    const path = requireString(args, 'path')
    if (hitsRbcodePath(path)) return failure(rbcodeRefusal(path))
    const recursive = optionalBoolean(args, 'recursive')

    const snapshot = await snapshotTree(ctx.backend, path).catch(() => ({
      files: [],
      truncated: true,
    }))

    try {
      await ctx.backend.remove(path, { recursive })
    } catch (err) {
      return failure(`Failed to delete: ${(err as Error).message}`)
    }

    const undoId = await ctx.recordUndo({
      kind: 'delete',
      path,
      before: null,
      files: snapshot.files,
      summary: `Delete ${path}`,
    })

    const note = snapshot.truncated
      ? ' (content was large or binary, snapshot is incomplete)'
      : ` (${snapshot.files.length} files snapshotted, can be undone)`
    return { content: `Deleted ${path}${note}`, undoId }
  },
}

export const listDirTool: ToolDef = {
  readOnly: true,
  schema: {
    name: 'list_dir',
    description:
      'List a directory. Directory names end with "/". An empty path means the workspace root.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path, defaults to the root' } },
    },
  },
  async run(args, ctx) {
    const path = optionalString(args, 'path') ?? ''
    if (hitsRbcodePath(path)) return failure(rbcodeRefusal(path))
    try {
      const entries = (await ctx.backend.list(path)).filter(
        // `.rbcode` 对模型隐身：目录名也不出现在列表里
        (entry) => !hitsRbcodePath(entry.path) && !hitsRbcodePath(entry.name),
      )
      if (entries.length === 0) return text(`Directory ${path || '.'} is empty`)
      entries.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      const body = entries
        .map((e) =>
          e.kind === 'dir' ? `[dir]  ${e.name}/` : `[file] ${e.name}  ${formatBytes(e.size)}`,
        )
        .join('\n')
      return text(`Directory ${path || '.'} (${entries.length} entries)\n${body}`)
    } catch (err) {
      return failure(`Failed to list directory: ${(err as Error).message}`)
    }
  },
}

export const globTool: ToolDef = {
  readOnly: true,
  schema: {
    name: 'glob',
    description:
      'Find file paths by glob pattern. Supports *, **, ? and {a,b}. Example: **/*.ts finds all TypeScript files.',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Glob pattern, e.g. **/*.ts' } },
      required: ['pattern'],
    },
  },
  async run(args, ctx) {
    const pattern = requireString(args, 'pattern')
    if (hitsRbcodePath(pattern)) return failure(rbcodeRefusal(pattern))
    try {
      // `.rbcode` 隐身：即使命中也从结果里去掉，和「文件不存在」表现一致
      const matches = (await ctx.backend.glob(pattern)).filter((match) => !hitsRbcodePath(match))
      if (matches.length === 0) return text(`No files matched ${pattern}`)
      const shown = matches.slice(0, 500)
      return text(
        `Matched ${pattern}: ${matches.length} entries\n${shown.join('\n')}` +
          (matches.length > shown.length
            ? `\n…(${matches.length - shown.length} more omitted)`
            : ''),
      )
    } catch (err) {
      return failure(`Glob failed: ${(err as Error).message}`)
    }
  },
}

export const grepTool: ToolDef = {
  readOnly: true,
  schema: {
    name: 'grep',
    description:
      'Search file contents with a regular expression (case-insensitive). Returns "file:line: content". Use include to restrict which file names are searched.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression' },
        include: { type: 'string', description: 'File name glob, e.g. *.tsx' },
        max_results: { type: 'number', description: 'Maximum matches to return. Default 80' },
      },
      required: ['pattern'],
    },
  },
  async run(args, ctx) {
    const pattern = requireString(args, 'pattern')
    const include = optionalString(args, 'include')
    if (include && hitsRbcodePath(include)) return failure(rbcodeRefusal(include))
    try {
      const output = await ctx.backend.grep(pattern, {
        include,
        maxResults: Math.min(optionalNumber(args, 'max_results') ?? 80, 400),
      })
      // `.rbcode` 隐身：结果行是「路径:行号: 内容」，只按**路径**部分过滤，不误伤正文
      const lines = output.split('\n').filter((line) => {
        const colon = line.indexOf(':')
        return !hitsRbcodePath(colon === -1 ? line : line.slice(0, colon))
      })
      const body = lines.join('\n')
      const trimmed = body.length > 12_000 ? `${body.slice(0, 12_000)}\n…[truncated]` : body
      return trimmed ? text(trimmed) : text(`No matches for "${pattern}"`)
    } catch (err) {
      return failure(`Search failed: ${(err as Error).message}`)
    }
  },
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count++
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/** 粗略的行级改动统计（按行多重集比较），用于紧凑模式显示 +x -y */
function lineDiffCounts(
  before: string | null,
  after: string,
): { added: number; removed: number } {
  const lines = (text: string) => text.split('\n').filter((line) => line.trim() !== '')
  const countMap = (items: string[]) => {
    const map = new Map<string, number>()
    for (const item of items) map.set(item, (map.get(item) ?? 0) + 1)
    return map
  }
  const beforeMap = countMap(lines(before ?? ''))
  const afterMap = countMap(lines(after))
  let added = 0
  let removed = 0
  for (const [line, count] of afterMap) added += Math.max(0, count - (beforeMap.get(line) ?? 0))
  for (const [line, count] of beforeMap) removed += Math.max(0, count - (afterMap.get(line) ?? 0))
  return { added, removed }
}
