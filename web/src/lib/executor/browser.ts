import { t } from '../i18n.ts'
import { globToRegExp, normalizeGlob } from './glob.ts'
import { idbDelete, idbGet, idbSet } from './idb.ts'
import { basename, dirname, joinPath, normalizePath, segments } from './path.ts'
import type { Backend, BackendCapabilities, FileNode, ShellResult } from './types.ts'

const HANDLE_PREFIX = 'browser-root-handle'

function handleKey(key: string): string {
  return `${HANDLE_PREFIX}:${key}`
}

async function* iterateEntries(
  dir: FileSystemDirectoryHandle,
): AsyncGenerator<[string, FileSystemHandle]> {
  const iterable = dir as unknown as {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>
  }
  for await (const entry of iterable.entries()) yield entry
}

/**
 * 浏览器沙箱后端：基于 File System Access API 操作用户授权的真实本地目录。
 * 这里没有能执行系统命令的 shell —— bash 工具会据此直接返回错误。
 */
export class BrowserBackend implements Backend {
  readonly kind = 'browser' as const
  /** 稳定标识：给模型的工具输出里用；界面显示名走 backendName(kind) */
  readonly label = '浏览器沙箱'
  readonly platform = 'browser'
  readonly capabilities: BackendCapabilities = {
    shell: false,
    miniShell: false,
    python: false,
    unrestricted: false,
  }

  private constructor(
    private readonly root: FileSystemDirectoryHandle,
    readonly rootLabel: string,
  ) {}

  static isSupported(): boolean {
    return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
  }

  /** 弹出目录选择器并记住选择；同一个目录名会复用同一条项目记录 */
  static async pick(key?: string): Promise<BrowserBackend> {
    if (!BrowserBackend.isSupported()) {
      throw new Error(
        '当前浏览器不支持 File System Access API（需要 Chrome / Edge）。可改用本机 companion 执行器。',
      )
    }
    const handle = await window.showDirectoryPicker!({ id: 'rbcode-root', mode: 'readwrite' })
    const backend = new BrowserBackend(handle, handle.name)
    const granted = await backend.ensurePermission(true)
    if (!granted)
      throw new Error(
        t(
          '没有获得该目录的读写权限',
          'Permission to read/write this folder was not granted',
          '沒有取得該目錄的讀寫權限',
          'このフォルダの読み書き権限が得られませんでした',
        ),
      )
    await idbSet(handleKey(key ?? handle.name), handle)
    return backend
  }

  /** 复用上次选中的目录（权限需由用户手势重新确认） */
  static async restore(key = 'default'): Promise<BrowserBackend | null> {
    const handle = await idbGet<FileSystemDirectoryHandle>(handleKey(key))
    if (!handle) return null
    return new BrowserBackend(handle, handle.name)
  }

  static async forget(key = 'default'): Promise<void> {
    await idbDelete(handleKey(key))
  }

  /** 查询权限；request=true 时会弹权限请求（必须在用户手势内调用） */
  async ensurePermission(request: boolean): Promise<boolean> {
    const opts: FileSystemHandlePermissionDescriptor = { mode: 'readwrite' }
    let state = await this.root.queryPermission?.(opts)
    if (state === 'granted') return true
    if (!request) return false
    state = await this.root.requestPermission?.(opts)
    return state === 'granted'
  }

  /* --------------------------------- 文件系统操作 -------------------------------- */

  private async getDir(path: string, create = false): Promise<FileSystemDirectoryHandle> {
    let handle = this.root
    for (const seg of segments(path)) {
      try {
        handle = await handle.getDirectoryHandle(seg, { create })
      } catch (err) {
        throw new Error(
          t(
            `目录不存在: ${path || '/'}（${(err as Error).message}）`,
            `Folder not found: ${path || '/'} (${(err as Error).message})`,
            `目錄不存在: ${path || '/'}（${(err as Error).message}）`,
            `フォルダが存在しません: ${path || '/'}（${(err as Error).message}）`,
          ),
        )
      }
    }
    return handle
  }

  private async getFileHandle(path: string, create = false): Promise<FileSystemFileHandle> {
    const p = normalizePath(path)
    if (!p)
      throw new Error(t('缺少文件路径', 'Missing file path', '缺少檔案路徑', 'ファイルパスがありません'))
    const dir = await this.getDir(dirname(p), create)
    try {
      return await dir.getFileHandle(basename(p), { create })
    } catch (err) {
      throw new Error(
        t(
          `文件不存在: ${p}（${(err as Error).message}）`,
          `File not found: ${p} (${(err as Error).message})`,
          `檔案不存在: ${p}（${(err as Error).message}）`,
          `ファイルが存在しません: ${p}（${(err as Error).message}）`,
        ),
      )
    }
  }

  async readFile(path: string): Promise<string> {
    const handle = await this.getFileHandle(path)
    return (await handle.getFile()).text()
  }

  async writeFile(path: string, content: string): Promise<void> {
    const handle = await this.getFileHandle(path, true)
    const writable = await handle.createWritable()
    await writable.write(content)
    await writable.close()
  }

  async list(path = ''): Promise<FileNode[]> {
    const dir = await this.getDir(path)
    const out: FileNode[] = []
    for await (const [name, handle] of iterateEntries(dir)) {
      if (handle.kind === 'file') {
        const file = await (handle as FileSystemFileHandle).getFile()
        out.push({ path: joinPath(path, name), name, kind: 'file', size: file.size })
      } else {
        out.push({ path: joinPath(path, name), name, kind: 'dir', size: 0 })
      }
    }
    return out
  }

  async exists(path: string): Promise<boolean> {
    const p = normalizePath(path)
    if (!p) return true
    try {
      const dir = await this.getDir(dirname(p))
      const target = basename(p)
      for await (const [name] of iterateEntries(dir)) {
        if (name === target) return true
      }
      return false
    } catch {
      return false
    }
  }

  async mkdir(path: string): Promise<void> {
    await this.getDir(normalizePath(path), true)
  }

  async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const p = normalizePath(path)
    if (!p)
      throw new Error(
        t('不能删除工作目录根', 'Cannot delete the workspace root', '不能刪除工作目錄根', 'ワークスペースのルートは削除できません'),
      )
    const dir = await this.getDir(dirname(p))
    await dir.removeEntry(basename(p), { recursive: opts?.recursive ?? false })
  }

  async glob(pattern: string): Promise<string[]> {
    const re = globToRegExp(normalizeGlob(pattern))
    const out: string[] = []
    const walk = async (path: string): Promise<void> => {
      if (out.length > 5000) return
      const nodes = await this.list(path).catch(() => [] as FileNode[])
      for (const node of nodes) {
        const child = joinPath(path, node.name)
        if (re.test(child)) out.push(node.kind === 'dir' ? `${child}/` : child)
        if (node.kind === 'dir') await walk(child)
      }
    }
    await walk('')
    return out
  }

  async grep(
    pattern: string,
    opts?: { include?: string; maxResults?: number },
  ): Promise<string> {
    const re = new RegExp(pattern, 'i')
    const includeRe = opts?.include ? globToRegExp(normalizeGlob(opts.include)) : null
    const max = opts?.maxResults ?? 200
    const hits: string[] = []

    const walk = async (path: string): Promise<void> => {
      if (hits.length >= max) return
      const nodes = await this.list(path).catch(() => [] as FileNode[])
      for (const node of nodes) {
        if (hits.length >= max) return
        const child = joinPath(path, node.name)
        if (node.kind === 'dir') {
          await walk(child)
          continue
        }
        if (includeRe && !includeRe.test(child)) continue
        if (node.size > 1_500_000) continue
        const content = await this.readFile(child).catch(() => '')
        const lines = content.split('\n')
        for (let i = 0; i < lines.length && hits.length < max; i++) {
          if (re.test(lines[i])) hits.push(`${child}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
        }
      }
    }
    await walk('')
    return hits.join('\n')
  }

  /**
   * 浏览器沙箱没有 shell。bash 工具在调用到这里之前就会按 capabilities.shell 返回错误，
   * 这里再抛一次，是为了兜住其它可能的调用路径。
   */
  async shell(command: string, _sessionId?: string): Promise<ShellResult> {
    throw new Error(`browser sandbox has no shell, cannot run: ${command}`)
  }

  /** 浏览器这边可以直接读二进制：拿 File 再把字节转成 base64 */
  async readFileBase64(path: string): Promise<{ base64: string; size: number }> {
    const handle = await this.getFileHandle(path)
    const file = await handle.getFile()
    const buffer = await file.arrayBuffer()
    return { base64: arrayBufferToBase64(buffer), size: file.size }
  }
}

/** ArrayBuffer → base64（分块拼，避免一次展开把栈顶爆） */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}
