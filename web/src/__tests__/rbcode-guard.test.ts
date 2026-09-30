import { describe, expect, it, vi } from 'vitest'
import type { Backend } from '../lib/executor/types.ts'
import { globTool, grepTool, listDirTool, readFileTool, writeFileTool, editFileTool, deletePathTool } from '../lib/tools/fs.ts'
import { viewImageTool } from '../lib/tools/image.ts'
import { hitsRbcodeCommand, hitsRbcodePath } from '../lib/tools/rbcode.ts'
import { bashTool } from '../lib/tools/shell.ts'
import type { ToolContext } from '../lib/tools/types.ts'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

function makeCtx(overrides: Record<string, unknown> = {}): ToolContext {
  const backend: Record<string, unknown> = {
    kind: 'companion',
    label: '本机执行器',
    rootLabel: 'demo',
    capabilities: { shell: true, miniShell: false, python: true, unrestricted: true },
    readFile: vi.fn(async (path: string) => `content of ${path}`),
    writeFile: vi.fn(async () => {}),
    readFileBase64: vi.fn(async () => ({ base64: PNG_BASE64, size: 70 })),
    list: vi.fn(async () => []),
    exists: vi.fn(async () => true),
    mkdir: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    glob: vi.fn(async () => []),
    grep: vi.fn(async () => ''),
    shell: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    ...overrides,
  }
  return {
    backend: backend as unknown as Backend,
    getTodos: () => [],
    setTodos: () => {},
    askUser: async () => '(skipped)',
    recordUndo: async () => 'u1',
  }
}

describe('路径判定：只认整段 `.rbcode`', () => {
  it('命中这些', () => {
    const hit = [
      '.rbcode',
      '.rbcode/sessions/a.json',
      'sub/../.rbcode/x.json',
      'D:\\proj\\.rbcode\\sessions\\a.json',
      '.RBCODE/index.json',
      'file:///D:/proj/.rbcode/a.json',
    ]
    for (const path of hit) expect(hitsRbcodePath(path), path).toBe(true)
  })

  it('绝不误伤这些', () => {
    const miss = [
      '',
      'rbcode',
      'rbcode/src/app.ts',
      'src/rbcode/x.ts',
      'D:\\36629\\Desktop\\Reasonix\\rbcode\\README.md',
      '.rbcodex',
      'foo.rbcode',
      '.mcp_output/browser/shot.png',
      'README.md',
    ]
    for (const path of miss) expect(hitsRbcodePath(path), path).toBe(false)
  })

  it('终端命令按 token 判定', () => {
    const hit = [
      'cat .rbcode/sessions/a.json',
      'cd ..\\.rbcode',
      'type "D:\\proj\\.rbcode\\x.json"',
      'ls --exclude-dir=.rbcode',
      'powershell Get-Content .RBCODE/index.json',
    ]
    for (const command of hit) expect(hitsRbcodeCommand(command), command).toBe(true)

    const miss = [
      'npm run build',
      'cd rbcode',
      'ls rbcode/src',
      'git -C D:\\36629\\Desktop\\Reasonix\\rbcode status',
      'cat notes.rbcode.md',
      'npx vite build',
    ]
    for (const command of miss) expect(hitsRbcodeCommand(command), command).toBe(false)
  })
})

describe('模型工具挡住 `.rbcode`', () => {
  it('read_file / write_file / edit_file / delete_path 一律拒绝，且不碰后端', async () => {
    const readCtx = makeCtx()
    const writeCtx = makeCtx()
    const results = [
      await readFileTool.run({ path: '.rbcode/sessions/a.json' }, readCtx),
      await writeFileTool.run({ path: '.rbcode/sessions/a.json', content: 'x' }, writeCtx),
      await editFileTool.run({ path: '.rbcode/index.json', old_string: 'a' }, makeCtx()),
      await deletePathTool.run({ path: '.rbcode', recursive: true }, makeCtx()),
    ]
    for (const result of results) {
      expect(result.isError, result.content).toBe(true)
      expect(result.content).toContain('.rbcode')
    }
    expect(readCtx.backend.readFile).not.toHaveBeenCalled()
    expect(writeCtx.backend.writeFile).not.toHaveBeenCalled()
  })

  it('view_image 也拒绝', async () => {
    const result = await viewImageTool.run({ path: '.rbcode/shot.png' }, makeCtx())
    expect(result.isError).toBe(true)
  })

  it('bash 碰到 `.rbcode` 就拒绝，命令不会真的执行', async () => {
    const ctx = makeCtx()
    const result = await bashTool.run({ command: 'cat .rbcode/sessions/index.json' }, ctx)
    expect(result.isError).toBe(true)
    expect(ctx.backend.shell).not.toHaveBeenCalled()
  })

  it('list_dir：`.rbcode` 隐身，别的目录（含名字叫 rbcode 的）照常', async () => {
    const ctx = makeCtx({
      list: vi.fn(async () => [
        { path: '.rbcode', name: '.rbcode', kind: 'dir', size: 0 },
        { path: '.mcp_output', name: '.mcp_output', kind: 'dir', size: 0 },
        { path: 'rbcode', name: 'rbcode', kind: 'dir', size: 0 },
        { path: 'src', name: 'src', kind: 'dir', size: 0 },
      ]),
    })
    const result = await listDirTool.run({}, ctx)
    expect(result.content).toContain('src/')
    expect(result.content).toContain('.mcp_output/')
    expect(result.content).toContain('rbcode/')
    expect(result.content).not.toContain('.rbcode')
  })

  it('直接 list_dir `.rbcode` 会被拒', async () => {
    const result = await listDirTool.run({ path: '.rbcode' }, makeCtx())
    expect(result.isError).toBe(true)
  })

  it('glob：`.rbcode` 的命中被丢掉', async () => {
    const ctx = makeCtx({
      glob: vi.fn(async () => ['.rbcode/sessions/a.json', '.rbcode', 'src/app.ts']),
    })
    const result = await globTool.run({ pattern: '**/*.json' }, ctx)
    expect(result.content).toContain('src/app.ts')
    expect(result.content).not.toContain('.rbcode')
  })

  it('glob 用 `.rbcode/**` 这种模式直接拒', async () => {
    const result = await globTool.run({ pattern: '.rbcode/**' }, makeCtx())
    expect(result.isError).toBe(true)
  })

  it('grep：只按路径过滤，正文里提到 .rbcode 不误伤', async () => {
    const ctx = makeCtx({
      grep: vi.fn(async () =>
        [
          '.rbcode/sessions/a.json:3: {"kind":"create"}',
          'README.md:9: 别读 .rbcode 里的东西',
          'src/app.ts:12: const path = 1',
        ].join('\n'),
      ),
    })
    const result = await grepTool.run({ pattern: 'x' }, ctx)
    expect(result.content).toContain('README.md:9')
    expect(result.content).toContain('src/app.ts:12')
    expect(result.content).not.toContain('sessions/a.json')
  })
})
