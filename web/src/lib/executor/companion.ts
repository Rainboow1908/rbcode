import { t } from '../i18n.ts'
import type { WebSearchEngine } from '../types.ts'
import type {
  Backend,
  BackendCapabilities,
  ComputerAction,
  ComputerScreen,
  FileNode,
  McpCallParams,
  McpCallResult,
  McpListParams,
  McpServerInfo,
  MusicApiParams,
  MusicCoverResult,
  MusicDownloadResult,
  RunningShell,
  ShellOutput,
  ShellResult,
  WebFetchResult,
  WebSearchResult,
} from './types.ts'

export type { RunningShell }

/** companion 默认监听端口，按顺序探测 */
export const DEFAULT_PORTS = [7717, 7718, 7719, 7720]

/* RunningShell 定义在 ./types.ts（Backend 接口也要用），这里重新导出保持原有引用 */

interface RpcResponse<T> {
  ok: boolean
  result?: T
  error?: string
}

interface PingInfo {
  name: string
  version: string
  platform: string
  root: string
  tokenRequired: boolean
}

/**
 * 本机执行器后端：通过 http://127.0.0.1:PORT 调用用户本机运行的 companion 程序，
 * 可以真实执行系统命令（python / git / powershell ...）并访问整机文件。
 */
export class CompanionBackend implements Backend {
  readonly kind = 'companion' as const
  /** 稳定标识：给模型的工具输出里用；界面显示名走 backendName(kind) */
  readonly label = '本机执行器'
  /** 平台：android / windows / linux（companion 的 /ping 返回） */
  get platform(): string | undefined {
    return CompanionBackend.info?.platform
  }
  readonly capabilities: BackendCapabilities = {
    shell: true,
    miniShell: false,
    python: true,
    unrestricted: true,
  }

  static info: PingInfo | null = null

  private currentRoot: string

  private constructor(
    private readonly origin: string,
    private readonly token: string,
    root: string,
  ) {
    this.currentRoot = root
  }

  /** 切换本机执行器的工作目录 */
  async setRoot(root: string): Promise<void> {
    await this.rpc('env.setRoot', { root })
    this.currentRoot = root
  }

  /** 当前工作目录（跟随 setRoot 更新） */
  get rootLabel(): string {
    return this.currentRoot
  }

  /** 依次探测默认端口，返回第一个可用的 companion */
  static async discover(
    token: string,
    ports: number[] = DEFAULT_PORTS,
  ): Promise<CompanionBackend | null> {
    for (const port of ports) {
      const origin = `http://127.0.0.1:${port}`
      try {
        const res = await fetch(`${origin}/ping`, { signal: AbortSignal.timeout(1200) })
        if (!res.ok) continue
        const info = (await res.json()) as PingInfo
        CompanionBackend.info = info
        return new CompanionBackend(origin, token, info.root || `${info.platform}`)
      } catch {
        continue
      }
    }
    return null
  }

  /** 列出某个绝对路径下的目录（用于网页端的目录选择器） */
  async listDir(path: string): Promise<FileNode[]> {
    const result = await this.rpc<{ entries: FileNode[] }>('env.listDir', { path })
    return result.entries
  }

  /** 列出可用驱动器（Windows 下的 C:\、D:\ 等） */
  async drives(): Promise<string[]> {
    const result = await this.rpc<{ drives: string[] }>('env.drives', {})
    return result.drives
  }

  /** 列出本机正在执行的命令 */
  /** 后台启动一条命令（dev server、监听进程等），立刻返回 id */
  async spawnShell(
    command: string,
    sessionId?: string,
  ): Promise<{ id: string; pid: number }> {
    return this.rpc<{ id: string; pid: number }>('shell.spawn', { command, sessionId })
  }

  /** 读某条后台命令从 offset 开始的新输出 */
  async shellOutput(id: string, offset = 0, sessionId?: string): Promise<ShellOutput> {
    return this.rpc<ShellOutput>('shell.output', { id, offset, sessionId })
  }

  /** 等某条后台命令结束；超时就带着已有输出返回（timedOut 为 true） */
  async awaitShell(
    id: string,
    offset = 0,
    timeoutMs = 30_000,
    sessionId?: string,
  ): Promise<ShellOutput & { timedOut: boolean }> {
    return this.rpc<ShellOutput & { timedOut: boolean }>('shell.wait', {
      id,
      offset,
      timeoutMs,
      sessionId,
    })
  }

  async listShells(): Promise<RunningShell[]> {
    const result = await this.rpc<{ commands: RunningShell[] }>('shell.list', {})
    return result.commands
  }

  /** 在系统文件管理器里选中某个路径（右键菜单用） */
  async reveal(path: string): Promise<void> {
    await this.rpc('env.reveal', { path })
  }

  /** 结束一条正在执行的命令 */
  async killShell(id: string, sessionId?: string): Promise<void> {
    await this.rpc('shell.kill', { id, sessionId })
  }

  /** 打开（或复用）常驻会话终端 */
  async openConsole(sessionId?: string): Promise<{ id: string; pid: number; command: string }> {
    return this.rpc<{ id: string; pid: number; command: string }>('shell.console', { sessionId })
  }

  /** 往常驻会话终端写一段（一条命令 + 换行） */
  async writeShell(id: string, data: string, sessionId?: string): Promise<void> {
    await this.rpc('shell.write', { id, data, sessionId })
  }

  /** 探活：本机执行器还在不在（掉线后自动重连用） */
  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.origin}/ping`, { signal: AbortSignal.timeout(1500) })
      return res.ok
    } catch {
      return false
    }
  }

  /// 连不上本机执行器时的重试次数 / 间隔（它可能刚重启，端口还没就绪）
  private static readonly RPC_RETRY = 3
  private static readonly RPC_RETRY_DELAY_MS = 800

  /** POST 到本机执行器；网络层失败重试几次，HTTP 错误原样返回给上层判断 */
  private async post(path: string, body: unknown): Promise<Response> {
    let lastError: unknown = null
    for (let attempt = 1; attempt <= CompanionBackend.RPC_RETRY; attempt++) {
      try {
        return await fetch(`${this.origin}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-RB-Token': this.token },
          body: JSON.stringify(body),
        })
      } catch (err) {
        lastError = err
        if (attempt < CompanionBackend.RPC_RETRY) {
          await new Promise((r) => setTimeout(r, CompanionBackend.RPC_RETRY_DELAY_MS * attempt))
        }
      }
    }
    const message = (lastError as Error)?.message ?? String(lastError)
    throw new Error(
      t(
        `无法连接本机执行器：${message}`,
        `Cannot reach the local executor: ${message}`,
        `無法連接本機執行器：${message}`,
        `ローカル実行環境に接続できません: ${message}`,
      ),
    )
  }

  private async rpc<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    const res = await this.post('/rpc', { op, params })

    if (res.status === 401)
      throw new Error(
        t(
          '配对令牌不正确，请在 companion 界面复制新的令牌',
          'Incorrect pairing token — copy a new one from the companion window',
          '配對權杖不正確，請在 companion 介面複製新的權杖',
          'ペアリングトークンが正しくありません。companion の画面で新しいトークンをコピーしてください',
        ),
      )

    const json = (await res
      .json()
      .catch(() => ({ ok: false, error: t('响应不是合法 JSON', 'Response is not valid JSON', '回應不是合法的 JSON', 'レスポンスが有効な JSON ではありません') }))) as
      | RpcResponse<T>
      | { ok: false; error: string }

    if (!json.ok || json.result === undefined) {
      throw new Error(
        json.error ??
          t(
            `执行器返回错误 (HTTP ${res.status})`,
            `Executor returned an error (HTTP ${res.status})`,
            `執行器回傳錯誤 (HTTP ${res.status})`,
            `実行環境がエラーを返しました (HTTP ${res.status})`,
          ),
      )
    }
    return json.result
  }

  async readFile(path: string): Promise<string> {
    const r = await this.rpc<{ content: string }>('fs.read', { path })
    return r.content
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.rpc('fs.write', { path, content })
  }

  async list(path = ''): Promise<FileNode[]> {
    const r = await this.rpc<{ entries: FileNode[] }>('fs.list', { path })
    return r.entries
  }

  async exists(path: string): Promise<boolean> {
    const r = await this.rpc<{ exists: boolean }>('fs.exists', { path })
    return r.exists
  }

  async mkdir(path: string): Promise<void> {
    await this.rpc('fs.mkdir', { path })
  }

  async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
    await this.rpc('fs.remove', { path, recursive: opts?.recursive ?? false })
  }

  async glob(pattern: string): Promise<string[]> {
    const r = await this.rpc<{ matches: string[] }>('fs.glob', { pattern })
    return r.matches
  }

  async grep(pattern: string, opts?: { include?: string; maxResults?: number }): Promise<string> {
    const r = await this.rpc<{ output: string }>('fs.grep', {
      pattern,
      include: opts?.include,
      maxResults: opts?.maxResults ?? 200,
    })
    return r.output
  }

  async shell(command: string, sessionId?: string, timeoutMs?: number): Promise<ShellResult> {
    return this.rpc<ShellResult>('shell.exec', { command, sessionId, timeoutMs })
  }

  /** 读二进制文件（图片等）：fs.read 是 UTF-8 文本，读二进制会坏，所以单独走这个接口 */
  async readFileBase64(path: string): Promise<{ base64: string; size: number }> {
    return this.rpc<{ base64: string; size: number }>('fs.readBase64', { path })
  }

  /** 联网搜索：由本机发起 HTTP 请求，不经过 Cloudflare 数据中心；proxy 为空则直连 */
  webSearch(query: string, engine?: WebSearchEngine, proxy?: string): Promise<WebSearchResult> {
    return this.rpc<WebSearchResult>('web.search', { query, engine, proxy })
  }

  /** 抓网页：同样由本机发起，能用上本机代理 */
  webFetch(url: string, proxy?: string): Promise<WebFetchResult> {
    return this.rpc<WebFetchResult>('web.fetch', { url, proxy })
  }

  /** 列出（必要时拉起）当前项目的 MCP 服务器工具 */
  mcpList(params: McpListParams): Promise<{ servers: McpServerInfo[] }> {
    return this.rpc<{ servers: McpServerInfo[] }>(
      'mcp.list',
      params as unknown as Record<string, unknown>,
    )
  }

  /** 调一个 MCP 工具 */
  mcpCall(params: McpCallParams): Promise<McpCallResult> {
    return this.rpc<McpCallResult>('mcp.call', params as unknown as Record<string, unknown>)
  }

  /** 停掉某个项目（不传 = 全部）的 MCP 实例 */
  mcpStop(root?: string): Promise<{ stopped: number }> {
    return this.rpc<{ stopped: number }>('mcp.stop', { root })
  }

  /** 用户环境目录（%APPDATA% 等）：扫别的工具的数据时需要 */
  paths(): Promise<{ home?: string | null; appData?: string | null; localAppData?: string | null }> {
    return this.rpc<{ home?: string | null; appData?: string | null; localAppData?: string | null }>(
      'env.paths',
      {},
    )
  }

  /** 二进制写（图片落盘用；fs.write 是文本接口，写图片会坏） */
  writeFileBase64(path: string, base64: string): Promise<{ bytes: number }> {
    return this.rpc<{ bytes: number }>('fs.writeBase64', { path, base64 })
  }

  /** 音乐：代理第三方 API + 下载（都由本机发请求） */
  musicApi(params: MusicApiParams): Promise<{ data: unknown }> {
    return this.rpc<{ data: unknown }>(
      'music.api',
      params as unknown as Record<string, unknown>,
    )
  }

  musicDownload(params: MusicApiParams): Promise<MusicDownloadResult> {
    return this.rpc<MusicDownloadResult>(
      'music.download',
      params as unknown as Record<string, unknown>,
    )
  }

  /** 封面同样走本机：浏览器直连上游图床容易白图 */
  musicCover(params: MusicApiParams): Promise<MusicCoverResult> {
    return this.rpc<MusicCoverResult>('music.cover', params as unknown as Record<string, unknown>)
  }

  /** computer use：截屏 + 执行键鼠动作（都在本机） */
  computerScreen(params: { maxWidth?: number }): Promise<ComputerScreen> {
    return this.rpc<ComputerScreen>('computer.screen', params as Record<string, unknown>)
  }

  computerActions(params: { actions: ComputerAction[] }): Promise<{ applied: number }> {
    return this.rpc<{ applied: number }>(
      'computer.actions',
      params as unknown as Record<string, unknown>,
    )
  }
}
