/** 会话消息角色 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

/** 模型请求的一次工具调用 */
export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

/** 用户在输入框里附带的图片或引用的文件 */
/** 一个会话累计的用量与缓存命中统计（跟着会话文件存进 .rbcode，随项目走） */
export interface UsageStats {
  /** 发出去的请求数（用于算平均） */
  requests: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  cacheWriteTokens: number
}

export interface Attachment {
  id: string
  kind: 'image' | 'file'
  name: string
  /** 图片的 data URL */
  dataUrl?: string
  /** 图片已经落到工作区里时的引用路径（`.rbcode/images/xxx.png`），会话文件只存它 */
  storedPath?: string
  /** 落盘时的 MIME（读回来拼 data URL 用） */
  mime?: string
  /** @ 引用的文件路径 */
  path?: string
  /** 由工具产出时，记下是哪个工具调用给的（图片要收进对应卡片） */
  toolCallId?: string
}

/** 一条会话消息 */
export interface Message {
  id: string
  role: MessageRole
  content: string
  /** 部分模型返回的思考过程 */
  reasoning?: string
  /** assistant 消息中请求执行的工具调用 */
  toolCalls?: ToolCall[]
  /** role === 'tool' 时对应的调用 id */
  toolCallId?: string
  /** role === 'tool' 时的工具名，便于展示 */
  toolName?: string
  createdAt: number
  /** 失败信息 */
  error?: string
  /** 该工具调用产生的可撤销记录 id */
  undoId?: string
  /** 用户消息附带的图片/文件引用 */
  attachments?: Attachment[]
  /** 这条用户消息是任务进行中「立即插入」的 */
  inserted?: boolean
  /** 工具产出的图片消息：只在对应工具卡片里展示，不在消息流里单独出现 */
  hidden?: boolean
  /** 文件改动行数统计（写入 / 编辑类工具），紧凑模式下显示 +x -y */
  diff?: { added: number; removed: number }
  /**
   * 已被上下文压缩归档：界面里照常原样显示，但发给模型的历史里不再包含它
   * （那段历史已经被一条摘要消息代替）。
   */
  compacted?: boolean
  /**
   * 只在界面上出现、不发给模型的消息。压缩完成的那张工具卡片就用它表示：
   * assistant 的 compact_context 调用 + 对应的 tool 结果（摘要）。
   */
  uiOnly?: boolean
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface Todo {
  id: string
  content: string
  status: TodoStatus
}

/** 接口风格：OpenAI 兼容 或 Anthropic 原生 */
export type ApiStyle = 'openai' | 'anthropic'

/** 挂在某个提供商下的一个模型 */
export interface ModelEntry {
  /** 模型 id，例如 gpt-4o、deepseek-chat */
  id: string
  /** 可选显示名（只影响界面展示，请求里仍用 id） */
  label?: string
}

/** 一条自定义请求头，随该提供商的每次请求发送 */
export interface RequestHeader {
  key: string
  value: string
}

/** 一个模型提供商（一条连接配置 + 它下面可用的模型） */
export interface Provider {
  /** 本地唯一 id */
  id: string
  /** 显示名，例如 OpenAI、DeepSeek */
  name: string
  /** 形如 https://api.openai.com/v1（不带结尾斜杠） */
  baseURL: string
  apiKey: string
  apiStyle: ApiStyle
  /** 该提供商下已添加的模型 */
  models: ModelEntry[]
  /** 该提供商下默认选中的模型 id（切换提供商时自动选中它） */
  defaultModel?: string
  /** 额外请求头（自定义网关、代理鉴权等） */
  headers?: RequestHeader[]
  /* ---- 兼容性选项：不同厂商的 OpenAI 兼容实现细节不一样，按需开关 ---- */
  /** 最大 token 用哪个字段名（新版 OpenAI 推理模型要 max_completion_tokens） */
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens'
  /** 系统提示词用哪个角色（o 系列 / 新接口用 developer） */
  systemRole?: 'system' | 'developer'
  /** 是否请求流式返回 usage（个别网关不认 stream_options，关掉即可） */
  streamUsage?: boolean
  /** 是否发送温度 / top_p（部分推理模型不接受采样参数） */
  sendSampling?: boolean
  /** 额外请求体（JSON 文本，浅合并进请求，用来兜住各种厂商私有参数） */
  extraBody?: string
}

/** 发起一次模型请求所需的全部连接信息 */
export interface LlmTarget {
  baseURL: string
  apiKey: string
  apiStyle: ApiStyle
  model: string
  /** 采样温度（0-2）；未设置则用接口默认 */
  temperature?: number
  /** 核采样 top_p（0-1）；未设置则用接口默认 */
  topP?: number
  /** 单次回复最大 token；未设置时 Anthropic 回退到 8192 */
  maxTokens?: number
  /** 额外请求头（来自提供商的 headers 配置） */
  headers?: RequestHeader[]
  /** 思考强度；off 或未设置时不发 */
  reasoningEffort?: ReasoningEffort
  /** 最大 token 字段名（默认 max_tokens） */
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens'
  /** 系统提示词角色（默认 system） */
  systemRole?: 'system' | 'developer'
  /** 是否请求流式 usage（默认 true） */
  streamUsage?: boolean
  /** 是否发送采样参数（默认 true；显式 false 时不发 temperature / top_p） */
  sendSampling?: boolean
  /** 额外请求体（已解析的 JSON 对象，浅合并进请求） */
  extraBody?: Record<string, unknown>
}

export type ExecutorKind = 'auto' | 'browser' | 'companion'

/**
 * 权限档位：
 * - readonly：AI 要修改任何文件都必须先询问用户
 * - auto：除危险操作（删除）外都直接执行
 * - full：完全不审批
 */
export type PermissionMode = 'readonly' | 'auto' | 'full'

/**
 * 重复内容检测的范围：
 * - `text`      只看模型的回答正文
 * - `reasoning` 只看思考过程
 * - `both`      正文 + 思考
 * - `all`       正文 + 思考 + 工具参数（最全）
 */
export type RepeatScope = 'text' | 'reasoning' | 'both' | 'all'

/** 朗读音色列表的分组方式 */
export type VoiceGroup = 'language' | 'online' | 'name'

/** 界面语言。jp（日本語）自 2026-09 起不再支持，代码里保留的 jp 文本会被忽略 */
export type Lang = 'zh' | 'en' | 'tw' | 'jp'

/** 主题：默认（深色）/ 浅色 / 极光。配色由 color 决定 */
export type ThemeMode = 'dark' | 'light' | 'aurora' | 'oreui'

/**
 * 配色：'default' = 用主题自带配色（不覆盖强调色、极光不做色相偏移）；
 * 其余值会把界面强调色与极光整体换成对应色系。
 */
export type ColorMode = 'default' | 'amber' | 'blue' | 'cyan' | 'emerald' | 'violet' | 'rose'

/** 界面骨架：classic=三栏；workbench=opencode 式（顶栏标签页 + 抽屉） */
export type LayoutMode = 'classic' | 'workbench'

/** 思考强度：off 表示不发任何 reasoning 参数 */
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high'

/** 过程显示模式：默认 / 紧凑（Used 摘要）/ 结果（只留 Working 与最终文字） */
export type ActivityMode = 'default' | 'compact' | 'result'

/** 状态栏显示样式：图标 + 数据 / 文字 + 数据 */
export type StatusStyle = 'icon' | 'text'

/** 联网搜索用哪个源：auto = 按顺序兜底（Bing → DuckDuckGo） */
export type WebSearchEngine = 'auto' | 'bing' | 'duckduckgo'

/** 内置浏览器 MCP 用哪个浏览器通道；off = 不启用 */
export type McpBrowser = 'off' | 'msedge' | 'chrome' | 'chromium'

/** 一个自定义 MCP 服务器（命令 + 参数 + 环境变量） */
export interface McpServerConfig {
  /** 稳定 id，同时决定缓存目录名 */
  id: string
  /** 展示名 */
  name: string
  command: string
  /** 参数（设置页里一行一个） */
  args: string[]
  env: Record<string, string>
  enabled: boolean
}

/** 工作台底部状态栏可显示的项 */
export type StatusItemId =
  | 'project'
  | 'backend'
  | 'model'
  | 'permission'
  | 'reasoning'
  | 'cacheHit'
  | 'contextUsed'
  | 'contextTotal'
  | 'untilCompact'
  | 'compactThreshold'
  | 'speed'
  | 'outputTokens'
  | 'requests'
  | 'rounds'
  | 'messages'
  | 'todos'
  | 'elapsed'
  | 'shells'

/** 一个可被模型调用的技能（reusable instructions） */
export interface Skill {
  id: string
  /** 技能名（模型用它调用），建议英文短横线 */
  name: string
  /** 一句话说明，会列在系统提示词里 */
  description: string
  /** 调用技能时注入给模型的完整指令 */
  instructions: string
}

/** 可选提示音（对应 public/sounds/<id>.mp3；none 表示不响） */
export type SoundId = 'none' | 'chime' | 'bell' | 'pop' | 'ping' | 'success' | 'alert' | 'soft'

/** 会触发提示音的事件 */
export type SoundEvent = 'taskDone' | 'ask' | 'approval' | 'plan' | 'error'

/** 删除操作保存下来的文件快照 */
export interface UndoFileSnapshot {
  path: string
  content: string
}

/** 一次可撤销的文件变更 */
export interface UndoRecord {
  id: string
  createdAt: number
  /** modify: 修改已有文件；create: 新建；delete: 删除 */
  kind: 'modify' | 'create' | 'delete'
  path: string
  /** modify 时记录修改前内容；create 时为 null */
  before: string | null
  /** delete 时保存被删文件的快照 */
  files?: UndoFileSnapshot[]
  /** 展示用说明 */
  summary: string
}

export interface AppSettings {
  providers: Provider[]
  /** 当前使用的提供商 id */
  activeProviderId: string
  /** 当前使用的模型 id */
  activeModel: string
  /** 覆盖默认系统提示词 */
  systemPrompt: string
  executor: ExecutorKind
  /** 本机执行器配对令牌 */
  companionToken: string
  /** 单轮最多工具调用迭代次数；0 = 不限（一直干到模型自己停） */
  maxIterations: number
  /** 当前模型的上下文窗口大小（token），用于决定何时压缩 */
  contextWindow: number
  /** 压缩触发阈值（百分比 0-100），达到即提前压缩 */
  compactThreshold: number
  /** 压缩历史时保留最近多少条原文 */
  compactKeepRecent: number
  /** 权限档位 */
  permission: PermissionMode
  /** 审批等待时长（秒），超时视为否决；0 = 不限（一直等你决定） */
  approvalTimeout: number
  /** 重复内容检测：模型在同一轮里连续重复同一段内容到阈值就自动停止 */
  repeatDetect: boolean
  /** 检测范围：正文 / 思考 / 两者 / 全部（含工具参数） */
  repeatScope: RepeatScope
  /** 同一段内容连续重复几次算异常（2-10） */
  repeatThreshold: number
  /** 最小重复单元：短于这么多字的不算（8-400），避免正常的标点 / 缩进误判 */
  repeatMinUnit: number
  /** 采样温度（0-2）；留空用接口默认 */
  temperature?: number
  /** 核采样 top_p（0-1）；留空用接口默认 */
  topP?: number
  /** 单次回复最大 token；留空用接口默认（Anthropic 为 8192） */
  maxTokens?: number
  /** 界面主题：默认（深色）/ 极光 */
  theme: ThemeMode
  /** 配色（强调色） */
  color: ColorMode
  /** 界面语言 */
  language: Lang
  /** 界面骨架（与配色主题相互独立） */
  layout: LayoutMode
  /** 思考过程是否默认展开（默认折叠） */
  reasoningExpanded: boolean
  /** 扁平控件：隐藏所有边框，鼠标悬浮给底色反馈 */
  flatBorders: boolean
  /** 过程显示：默认（全部展示）/ 紧凑（Used 摘要）/ 结果（只留 Working 与最终文字） */
  activityMode: ActivityMode
  /** 工作台底部状态栏显示哪些项（顺序即显示顺序） */
  statusItems: StatusItemId[]
  /** 状态栏样式：图标 + 数据 / 文字 + 数据 */
  statusStyle: StatusStyle
  /** 是否启用事件提示音 */
  soundEnabled: boolean
  /** 提示音音量 0-1 */
  soundVolume: number
  /** 每个事件用哪个提示音 */
  sounds: Record<SoundEvent, SoundId>
  /** 思考强度 */
  reasoningEffort: ReasoningEffort
  /**
   * 联网搜索的默认源（模型没传 engine 或传 auto 时用它）。
   * 搜索走本机执行器，不经过 Cloudflare 数据中心。
   */
  webSearchEngine: WebSearchEngine
  /**
   * 联网代理（HTTP 代理），空 = 直连，例如 http://127.0.0.1:7897。
   * 只对本机执行器发出的请求生效（web_search / web_fetch）——
   * 浏览器直连模型 API 的流量它管不了（那要靠系统代理 / VPN）。
   */
  proxy: string
  /** 音乐面板默认用哪个音乐源（上游现在能用的是 netease / joox） */
  musicSource: string
  /** 音乐 API 地址；留空 = 用 companion 内置的默认地址（可换成自建实例） */
  musicBase: string
  /** 优先请求的音质：128 / 192 / 320 / 740（无损）/ 999（无损） */
  musicQuality: number
  /**
   * computer use（看屏幕 + 动键鼠）。默认开，但**第一次用会按会话征求一次授权**。
   * 关掉后 computer_use 工具直接拒绝。
   */
  computerEnabled: boolean
  /** computer use 的截图宽度上限；0 = 原分辨率（官方建议 1280，原分辨率点击更容易偏） */
  computerMaxWidth: number
  /**
   * 悬浮窗：一个置顶小窗，显示模型的状态/思考/决定/回答，也能在里面审批与插话。
   * 用 Document Picture-in-Picture，需要 Chrome / Edge 116+。
   */
  floatingWindow: boolean
  /**
   * 兼容导入的扫描范围：`project` = 只找属于当前项目的会话（默认）；
   * `all` = 连全局会话、归档、旧版目录一起找。
   */
  importScope: 'project' | 'all'
  /** 底部状态栏是否显示（经典三栏和 workbench 两套布局都生效） */
  statusBar: boolean
  /**
   * 内置浏览器 MCP（Playwright）用哪个浏览器通道；`off` = 不启用。
   * 每个项目一份独立实例与 profile（`<项目>/.rbcode/mcp/playwright/`）。
   */
  mcpBrowser: McpBrowser
  /**
   * 内置浏览器是否用无界面模式（headless）。
   * 关掉 = 有界面：会弹出一个真浏览器窗口，需要你手动登录 / 过验证码时用。
   */
  mcpHeadless: boolean
  /** 自定义 MCP 服务器（同样每个项目一份进程 + 缓存目录） */
  mcpServers: McpServerConfig[]
  /** 可被模型调用的技能 */
  skills: Skill[]
  /** 显示语音输入（麦克风）按钮 */
  voiceInput: boolean
  /** 显示朗读（小喇叭）按钮 */
  voiceOutput: boolean
  /** 自动朗读每轮的最终回答（默认关，只在设置里打开） */
  voiceAutoRead: boolean
  /** 朗读速度 0.5–2 倍 */
  voiceRate: number
  /** 朗读音色（系统音色的 name）；留空 = 按回答文字的语言自动挑一个 */
  voiceName: string
  /** 音色列表怎么分组：按语言 / 按在线·本地 / 按音色名 */
  voiceGroup: VoiceGroup
}

/** GET {baseURL}/models 返回的模型信息（已归一化） */
export interface ModelInfo {
  id: string
  ownedBy?: string
  created?: number
}
