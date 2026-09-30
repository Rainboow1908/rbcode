import type { WebSearchEngine } from '../types.ts'

/** 一个目录项 */
export interface FileNode {
  /** 相对工作目录的路径，形如 src/app.tsx */
  path: string
  name: string
  kind: 'file' | 'dir'
  size: number
  /** 修改时间（毫秒时间戳）；旧版 companion 不返回时为 undefined */
  modified?: number
}

/** 命令执行结果 */
export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
  /** 被丢掉的字节数（companion 会限制单个流的输出上限） */
  stdoutDropped?: number
  stderrDropped?: number
  /** 用户在前端「终端」面板手动结束的（不是正常退出，也不是空结果） */
  killed?: boolean
  /** 超过 timeout 被强制结束的 */
  timedOut?: boolean
}

/** 后台命令的增量输出 */
export interface ShellOutput {
  id: string
  /** 从 offset 开始的新输出（stdout 与 stderr 按到达顺序合并） */
  output: string
  /** 下次读取时把这个值当作 offset 传回来 */
  nextOffset: number
  /** 因为超出缓冲上限被丢掉的字节数 */
  dropped: number
  /** 命令是否已经结束 */
  done: boolean
  exitCode: number | null
  /** 用户手动结束的 */
  killed?: boolean
}

/** 一条正在执行（或刚结束）的命令 */
export interface RunningShell {
  id: string
  command: string
  pid: number
  startedAt: number
  /** 发起这条命令的会话 id（用于按会话分组显示） */
  sessionId?: string
  /** 命令是否已经结束（结束后仍可再读一次输出） */
  done?: boolean
  exitCode?: number | null
  /** 是不是常驻会话终端（前端手动开的那个，一直开着直到手动关） */
  console?: boolean
  /** 这个终端是不是真伪终端（PTY）。是的话回显/提示符由 shell 自己负责 */
  pty?: boolean
}

/** 后端具备的能力，UI 与工具过滤据此提示/裁剪 */
export interface BackendCapabilities {
  /** 能否执行**真实的系统命令**（python / git / npm / powershell …） */
  shell: boolean
  /** 是否提供内置的受限迷你 shell（ls/cat/grep 等） */
  miniShell: boolean
  /** 能否直接运行系统里的 python */
  python: boolean
  /** 是否可访问授权目录之外的路径（companion 可以，浏览器不可以） */
  unrestricted: boolean
}

/**
 * 执行后端：工具层唯一依赖的抽象。
 * 两个实现——BrowserBackend（File System Access API + 内置迷你 shell）
 * 与 CompanionBackend（本机 http://127.0.0.1:PORT）。
 */
export interface Backend {
  readonly kind: 'browser' | 'companion'
  /** 展示名 */
  readonly label: string
  /** 工作目录展示路径 */
  readonly rootLabel: string
  /** 运行平台（本机执行器用 /ping 返回的 platform，如 android / windows / linux） */
  readonly platform?: string
  readonly capabilities: BackendCapabilities

  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  list(path?: string): Promise<FileNode[]>
  exists(path: string): Promise<boolean>
  mkdir(path: string): Promise<void>
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>
  /** 按 glob 匹配文件路径（相对工作目录） */
  glob(pattern: string): Promise<string[]>
  /** 正则搜索文件内容，返回带行号的文本 */
  grep(
    pattern: string,
    opts?: { include?: string; maxResults?: number },
  ): Promise<string>
  /** 执行命令（sessionId 用于把这条命令归属到发起的会话；timeoutMs 到点强制结束） */
  shell(command: string, sessionId?: string, timeoutMs?: number): Promise<ShellResult>
  /**
   * 后台启动一条命令并立刻返回会话 id（只有能跑真实命令的后端支持）。
   * 之后用 shellOutput 读增量输出、awaitShell 等它结束、killShell 停掉它。
   */
  spawnShell?(command: string, sessionId?: string): Promise<{ id: string; pid: number }>
  shellOutput?(id: string, offset?: number, sessionId?: string): Promise<ShellOutput>
  awaitShell?(
    id: string,
    offset?: number,
    timeoutMs?: number,
    sessionId?: string,
  ): Promise<ShellOutput & { timedOut: boolean }>
  /** 列出正在执行（以及刚结束）的命令 */
  listShells?(): Promise<RunningShell[]>
  /**
   * 结束一条命令（连同它的子进程）；产出的输出仍可读一次。
   * 带上 sessionId 时后端只允许操作该会话起的命令（agent 工具走这条），
   * 不带则是界面上的「结束」按钮 —— 用户本来就能管所有终端。
   */
  killShell?(id: string, sessionId?: string): Promise<void>
  /** 打开/复用常驻会话终端（一直开着，手动关才没） */
  openConsole?(sessionId?: string): Promise<{ id: string; pid: number; command: string }>
  /** 往常驻会话终端写一段（一条命令 + 换行） */
  writeShell?(id: string, data: string, sessionId?: string): Promise<void>
  /**
   * 读二进制文件（图片等），返回 base64 与字节数。
   * 可选：后端没提供这个能力时，用它的工具会给出明确提示。
   */
  readFileBase64?(path: string): Promise<{ base64: string; size: number }>
  /**
   * 用户环境里的常用目录（`%APPDATA%` 之类）。只有本机执行器能拿到 ——
   * 扫别的工具的会话数据时用。
   */
  paths?(): Promise<{ home?: string | null; appData?: string | null; localAppData?: string | null }>
  /**
   * 写二进制文件（图片按字节落盘，不能走 writeFile —— 那是 UTF-8 文本）。
   * 没有这个能力的后端（浏览器沙箱）会退回「图片留在消息里」，功能不受影响。
   */
  writeFileBase64?(path: string, base64: string): Promise<{ bytes: number }>
  /**
   * 联网搜索。**只有本机执行器提供**：请求从用户本机发出，
   * 搜索引擎才不会把 Cloudflare 数据中心的出口 IP 当成爬虫封掉。
   * proxy 为空时直连（见设置里的「代理」）。浏览器后端不实现它，
   * web_search 工具会给出明确提示。
   */
  webSearch?(query: string, engine?: WebSearchEngine, proxy?: string): Promise<WebSearchResult>
  /**
   * 抓取网页。**只有本机执行器提供**：请求从本机发出，也能走用户配置的代理。
   * 没连本机执行器时，web_fetch 工具会直接报错（不再回退到 Worker）。
   */
  webFetch?(url: string, proxy?: string): Promise<WebFetchResult>
  /**
   * 列出（必要时先在项目目录下拉起）MCP 服务器的工具。
   * **只有本机执行器提供**：MCP 要起子进程，浏览器沙箱做不到。
   * 实例按「项目根 + 服务器 id」隔离，每个项目一份。
   */
  mcpList?(params: McpListParams): Promise<{ servers: McpServerInfo[] }>
  /** 调用一个 MCP 工具（服务器没起来会先拉起） */
  mcpCall?(params: McpCallParams): Promise<McpCallResult>
  /** 停掉某个项目（不传 = 全部）的 MCP 实例 */
  mcpStop?(root?: string): Promise<{ stopped: number }>
  /**
   * 音乐面板：代理第三方音乐 API（search / url / pic / lyric）。
   * **只有本机执行器提供**：浏览器直连会被 CORS 拦，而且产品上要求音乐只能走本机。
   */
  musicApi?(params: MusicApiParams): Promise<{ data: unknown }>
  /** 下载整首歌（返回 base64，前端再触发浏览器下载） */
  musicDownload?(params: MusicApiParams): Promise<MusicDownloadResult>
  /**
   * 取封面（返回 base64，前端转 data URL）。
   * 封面也必须走本机：浏览器直连上游图床（joox 之类）经常白图。
   */
  musicCover?(params: MusicApiParams): Promise<MusicCoverResult>
  /**
   * computer use：抓屏（可选等比缩小）。**只有本机执行器提供** —— 浏览器做不到。
   */
  computerScreen?(params: { maxWidth?: number }): Promise<ComputerScreen>
  /** computer use：执行一批键鼠动作（坐标是屏幕绝对坐标，按顺序执行） */
  computerActions?(params: { actions: ComputerAction[] }): Promise<{ applied: number }>
}

/** 一条联网搜索结果 */
export interface SearchHit {
  title: string
  url: string
  snippet: string
}

/** 本机执行器返回的联网搜索结果 */
export interface WebSearchResult {
  /** 实际用的源：bing / duckduckgo */
  engine: string
  results: SearchHit[]
  /** 没结果时的说明（比如被验证码拦了） */
  note?: string
}

/** 本机执行器抓取网页的结果 */
export interface WebFetchResult {
  url: string
  status: number
  contentType: string
  title: string
  text: string
}

/** 发给本机执行器的 MCP 服务器描述 */
export interface McpServerSpec {
  id: string
  name: string
  /** 内置（浏览器）服务器：command/args 由 companion 自己拼 */
  builtin?: boolean
  command: string
  args: string[]
  env: Record<string, string>
  cwd?: string
  /** 内置服务器用：浏览器通道 */
  browser?: string
  /** 内置服务器用：代理 */
  proxy?: string
  /** 内置服务器用：是否无界面 */
  headless?: boolean
}

/** MCP 服务器暴露的一个工具（原样来自 tools/list） */
export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: {
    type?: string
    properties?: Record<string, unknown>
    required?: string[]
    /** MCP 服务器常带 `$schema` 之类的额外字段，原样收下 */
    [key: string]: unknown
  }
  annotations?: {
    title?: string
    readOnlyHint?: boolean
    destructiveHint?: boolean
    openWorldHint?: boolean
  }
}

/** 一个 MCP 服务器的列表结果 */
export interface McpServerInfo {
  id: string
  name: string
  tools: McpToolInfo[]
  /** 启动 / 握手失败时的原因（不影响其它服务器） */
  error?: string
  /** 这一份只是读的缓存（没有启动进程） */
  cached?: boolean
}

/** tools/call 的原样返回 */
export interface McpCallResult {
  content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>
  isError?: boolean
}

export interface McpListParams {
  root: string
  /** 不传 = true（必要时启动服务器）；false = 只读工具清单缓存，绝不启动进程 */
  start?: boolean
  builtin?: { enabled?: boolean; browser?: string; proxy?: string; headless?: boolean }
  servers?: McpServerSpec[]
}

export interface McpCallParams {
  root: string
  server: McpServerSpec
  tool: string
  args: Record<string, unknown>
}

/** 一次音乐 API 调用（经本机执行器代理，浏览器直连会被 CORS 拦） */
/** 取回来的封面图（base64 + mime，前端拼成 data URL） */
export interface MusicCoverResult {
  mime: string
  size: number
  base64: string
}

export interface MusicApiParams {
  /** 上游的四类接口 */
  types: 'search' | 'url' | 'pic' | 'lyric'
  source?: string
  id?: string
  name?: string
  count?: number
  pages?: number
  br?: number
  size?: number
  /** 换成自建 API 实例 */
  base?: string
  proxy?: string
}

/** 下载整首歌：返回 base64，前端自己触发「浏览器默认下载」 */
export interface MusicDownloadResult {
  name: string
  mime: string
  size: number
  base64: string
}

/** 一次截屏的结果（computer use） */
export interface ComputerScreen {
  /** 发给模型的图片尺寸（可能被缩过） */
  width: number
  height: number
  /** 实际虚拟桌面尺寸（还原坐标用） */
  screenWidth: number
  screenHeight: number
  /** 虚拟桌面左上角在屏幕坐标里的位置（多屏时可能为负） */
  originX: number
  originY: number
  /** base64 PNG */
  base64: string
}

/** 一个 computer use 动作（坐标是**屏幕绝对坐标**） */
export interface ComputerAction {
  action: string
  coordinate?: [number, number]
  start_coordinate?: [number, number]
  text?: string
  direction?: 'up' | 'down' | 'left' | 'right'
  amount?: number
  duration?: number
}

/** 路径不存在 / 类型不符时抛出 */
export class PathError extends Error {}
