import { DEFAULT_SOUNDS, DEFAULT_SOUND_VOLUME, isSoundId } from './sound.ts'
import type {
  ApiStyle,
  AppSettings,
  ExecutorKind,
  LlmTarget,
  McpServerConfig,
  Provider,
  ReasoningEffort,
  Skill,
  SoundEvent,
  SoundId,
} from './types.ts'

const STORAGE_KEY = 'rbcode.settings.v2'
const LEGACY_KEY = 'rbcode.settings.v1'

/** 展示用的应用版本（与 package.json 保持一致即可） */
export const APP_VERSION = '0.1.0'

export const DEFAULT_SYSTEM_PROMPT = `You are RB Code, an AI coding agent running in a browser. You work on the user's local files and run commands through tools.

Guidelines:
- Inspect before changing anything; never guess what a file contains.
- Read a file before editing it. For larger changes, list a plan with todo_write first and tick steps off as you go.
- Use the bash tool to run commands. The execution backend may be a browser sandbox or a local companion process.
- On the local companion the shell is **PowerShell on Windows** (or sh on other platforms), never
  bash: use PowerShell syntax — $variables, pipes with |, and ; or separate statements. Do NOT use
  bash-only syntax such as && / || chains, $( ) substitution, or single quotes expecting bash
  expansion. GNU tools like ls/cat/rm may not exist; prefer the file tools instead.
- Whether a command needs a timeout is your call: pass timeout (seconds) for commands that could hang,
  omit it for commands that should run to completion. For long-running commands (dev servers, watchers,
  builds) use background: true instead (it returns a shell id immediately); read progress with bash_output,
  wait for it with bash_wait (which takes its own timeoutMs), stop it with bash_kill.
- Terminals belong to the conversation that started them: bash_output / bash_wait / bash_kill only work on
  commands started in THIS conversation. If a shell id did not come from here, leave it alone — do not try
  to read or stop it, and do not go looking for other conversations' shells in the workspace or logs.
- Never try to obtain the companion pairing token (not from its window, not from WebView2 storage, not from
  config files) and never call the companion's /rpc endpoint yourself. Reach the machine only through these tools.
- The workspace .rbcode directory is the app's own data (chat sessions, undo snapshots, recycle bin, MCP
  caches). It is not part of the project: never list, read, search or modify anything inside it — the file
  tools and the shell reject those paths. If the user asks about it, say it is app data you cannot open.
- To remove files prefer delete_path over shelling out, so the user can undo the change.
- This workspace is a git repository and your work belongs in it: when you finish a task (or a coherent
  step), stage what you changed and commit with a short, specific message — do not leave finished work
  uncommitted. Never commit .rbcode, .mcp_output, build output or other generated files. Do not rewrite
  history, force-push, or lump unrelated changes into one commit. If the workspace has no git repository
  at all, ask the user before running git init.
- You can look at images with view_image (an image file inside the workspace) — use it to check a screenshot
  the user saved, a diagram or rendered output, instead of guessing.
- Answer concisely and in the language the user writes in. Keep code, commands and paths verbatim.
- Do not use emoji.`

export const PLAN_MODE_PROMPT = `

# Plan mode is ON
You may only read and search. Tools that write files, delete paths, or run state-changing commands are disabled and will be rejected if you call them.
Investigate the current state first, then use todo_write to list concrete, actionable steps and explain in your reply:
the approach, which files are involved, and any risks or decisions the user must make.
Stop after presenting the plan and wait for the user to confirm it. Do not modify any files.`

export const ENV_LOCAL_SHELL = `
 
# Environment
You are connected to the local companion executor: the bash tool runs real system
commands (python, git, npm, powershell) on the user's machine.`

/** 手机版（Android App）：shell 是 sh/bash，不是 Windows PowerShell */
export const ENV_ANDROID_SHELL = `
 
# Environment
You are connected to the RB Code Android app running on the user's phone.

IMPORTANT — this overrides anything above about PowerShell: the bash tool here runs **sh / bash on
Android**, NOT Windows PowerShell. Use POSIX shell syntax: $VARS, pipes with |, && / ||,
$(command) substitution, single quotes. Never use PowerShell syntax.

The shell is sandboxed and cannot touch the window manager or take screenshots (the screencap
command returns 0 bytes; am / monkey / uiautomator are blocked). To see or operate the phone screen,
use the computer_use tool — its screenshots come from the app's accessibility service. Files live in
shared storage (e.g. /sdcard) and in the selected project folder; prefer the file tools for reading
and editing files.`

export const ENV_NO_SHELL = `

# Environment
You are running in the browser sandbox: there is no real shell here, so calling bash
returns an error. Use the file tools instead (read_file, write_file, edit_file,
delete_path, list_dir, glob, grep) plus web_search, web_fetch, ask_user and todo_write.
If a task truly requires running system commands, say so and tell the user to switch to
the local companion executor with the backend badge in the header.`

import { PROVIDER_PRESETS } from './presets/providers.ts'
import { DEFAULT_STATUS_ITEMS, STATUS_ITEM_IDS } from './statusBar.ts'
import type { StatusItemId } from './types.ts'

export const PRESET_PROVIDERS: { name: string; baseURL: string; apiStyle: ApiStyle }[] =
  PROVIDER_PRESETS.map((preset) => ({
    name: preset.name,
    baseURL: preset.baseURL,
    apiStyle: preset.apiStyle,
  }))

export function createProvider(name = '新提供商'): Provider {
  const preset = PRESET_PROVIDERS.find((p) => p.name === name)
  return {
    id: crypto.randomUUID(),
    name,
    baseURL: preset?.baseURL ?? 'https://api.openai.com/v1',
    apiKey: '',
    apiStyle: preset?.apiStyle ?? 'openai',
    models: [],
  }
}

export function defaultSettings(): AppSettings {
  const provider = createProvider('OpenAI')
  return {
    providers: [provider],
    activeProviderId: provider.id,
    activeModel: '',
    systemPrompt: '',
    executor: 'auto',
    companionToken: '',
    maxIterations: 60,
    contextWindow: 128_000,
    compactThreshold: 80,
    compactKeepRecent: 8,
    permission: 'auto',
    approvalTimeout: 60,
    repeatDetect: true,
    repeatScope: 'all',
    repeatThreshold: 3,
    repeatMinUnit: 24,
    theme: 'dark',
    color: 'default',
    language: 'zh',
    layout: 'classic',
    reasoningExpanded: false,
    flatBorders: false,
    activityMode: 'default',
    statusItems: [...DEFAULT_STATUS_ITEMS],
    statusStyle: 'icon',
    soundEnabled: true,
    soundVolume: DEFAULT_SOUND_VOLUME,
    sounds: { ...DEFAULT_SOUNDS },
    reasoningEffort: 'off',
    webSearchEngine: 'auto',
    proxy: '',
    musicSource: 'auto',
    musicBase: '',
    musicQuality: 320,
    computerEnabled: true,
    computerMaxWidth: 1280,
    floatingWindow: false,
    importScope: 'project',
    statusBar: true,
    mcpBrowser: 'chromium',
    mcpHeadless: true,
    mcpServers: [],
    skills: [],
    voiceInput: true,
    voiceOutput: true,
    voiceAutoRead: false,
    voiceRate: 1,
    voiceName: '',
    voiceGroup: 'language',
  }
}

export const REASONING_EFFORT_LABEL: Record<ReasoningEffort, string> = {
  off: 'Default',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

export const REASONING_EFFORT_HINT: Record<ReasoningEffort, string> = {
  off: '不发思考参数，交给模型默认行为',
  low: '轻量思考，响应更快',
  medium: '速度与质量平衡',
  high: '最深的思考预算，适合难题（更慢、更贵）',
}

export function loadSettings(): AppSettings {
  const base = defaultSettings()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return mergeSettings(base, JSON.parse(raw) as Partial<AppSettings>)
    const legacy = migrateLegacy()
    if (legacy) return legacy
    return base
  } catch {
    return base
  }
}

/** 把值夹在 [min, max] 内；不是有效数字就回退到 fallback */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 音量：允许 0（静音），所以不要用 clampNumber 的“<=0 视为无效”规则 */
function clampVolume(value: unknown, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(1, Math.max(0, n))
}

/** 把值夹在 [min, max] 内；不是有效数字就回退到 fallback。允许 0（0 常用来表示「不限」） */
function clampZeroOk(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 逐个事件校验提示音 id，缺的用默认值补上 */
function mergeSounds(value: unknown): Record<SoundEvent, SoundId> {
  const out = { ...DEFAULT_SOUNDS }
  if (value && typeof value === 'object') {
    for (const event of Object.keys(DEFAULT_SOUNDS) as SoundEvent[]) {
      const candidate = (value as Record<string, unknown>)[event]
      if (isSoundId(candidate)) out[event] = candidate
    }
  }
  return out
}

/** 清洗技能列表（丢到没有名字的项） */
function mergeSkills(value: unknown): Skill[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is Partial<Skill> => Boolean(item) && typeof item === 'object')
    .map((entry) => ({
      id: typeof entry.id === 'string' && entry.id ? entry.id : crypto.randomUUID(),
      name: typeof entry.name === 'string' ? entry.name : '',
      description: typeof entry.description === 'string' ? entry.description : '',
      instructions: typeof entry.instructions === 'string' ? entry.instructions : '',
    }))
    .filter((skill) => skill.name.trim() !== '')
}

/** 清洗自定义 MCP 服务器：没命令的丢掉，id 去重（重复会共用同一份缓存目录） */
function mergeMcpServers(value: unknown): McpServerConfig[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: McpServerConfig[] = []

  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Partial<McpServerConfig>
    const command = typeof item.command === 'string' ? item.command.trim() : ''
    if (!command) continue

    const name =
      typeof item.name === 'string' && item.name.trim() ? item.name.trim() : command
    const wanted = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : name
    let id = wanted
    let suffix = 2
    while (seen.has(id)) {
      id = `${wanted}-${suffix}`
      suffix += 1
    }
    seen.add(id)

    const env: Record<string, string> = {}
    if (item.env && typeof item.env === 'object' && !Array.isArray(item.env)) {
      for (const [key, text] of Object.entries(item.env)) {
        if (typeof text === 'string') env[key] = text
      }
    }

    out.push({
      id,
      name,
      command,
      args: Array.isArray(item.args)
        ? item.args.filter((arg): arg is string => typeof arg === 'string')
        : [],
      env,
      enabled: item.enabled !== false,
    })
  }
  return out
}

function mergeSettings(base: AppSettings, parsed: Partial<AppSettings>): AppSettings {
  const providers = Array.isArray(parsed.providers) && parsed.providers.length > 0
    ? parsed.providers.map((p) => ({
        id: p.id ?? crypto.randomUUID(),
        name: p.name ?? '未命名提供商',
        baseURL: p.baseURL ?? '',
        apiKey: p.apiKey ?? '',
        apiStyle: p.apiStyle ?? 'openai',
        models: Array.isArray(p.models)
          ? p.models
              .filter((m) => m?.id)
              .map((m) => ({ id: m.id, ...(m.label ? { label: m.label } : {}) }))
          : [],
        ...(p.defaultModel ? { defaultModel: p.defaultModel } : {}),
        ...(Array.isArray(p.headers)
          ? {
              headers: p.headers
                .filter((h) => h && typeof h.key === 'string')
                .map((h) => ({ key: h.key, value: h.value ?? '' })),
            }
          : {}),
        // 兼容性选项：原样保留（都是可选的）
        ...(p.maxTokensParam === 'max_completion_tokens'
          ? { maxTokensParam: 'max_completion_tokens' as const }
          : p.maxTokensParam === 'max_tokens'
            ? { maxTokensParam: 'max_tokens' as const }
            : {}),
        ...(p.systemRole === 'developer'
          ? { systemRole: 'developer' as const }
          : p.systemRole === 'system'
            ? { systemRole: 'system' as const }
            : {}),
        ...(typeof p.streamUsage === 'boolean' ? { streamUsage: p.streamUsage } : {}),
        ...(typeof p.sendSampling === 'boolean' ? { sendSampling: p.sendSampling } : {}),
        ...(typeof p.extraBody === 'string' ? { extraBody: p.extraBody } : {}),
      }))
    : base.providers

  const activeProviderId =
    providers.find((p) => p.id === parsed.activeProviderId)?.id ?? providers[0].id

  return {
    ...base,
    ...parsed,
    providers,
    activeProviderId,
    activeModel: parsed.activeModel ?? '',
    // 数值项一律夹到合法范围（老的配置里可能存着 99999 这种越界值）
    contextWindow: clampNumber(parsed.contextWindow, 1000, 10_000_000, base.contextWindow),
    maxIterations: clampZeroOk(parsed.maxIterations, 0, 1_000_000, base.maxIterations),
    approvalTimeout: clampZeroOk(parsed.approvalTimeout, 0, 86_400, base.approvalTimeout),
    // 重复内容检测
    repeatDetect: parsed.repeatDetect !== false,
    repeatScope:
      parsed.repeatScope === 'text' ||
      parsed.repeatScope === 'reasoning' ||
      parsed.repeatScope === 'both'
        ? parsed.repeatScope
        : 'all',
    repeatThreshold: clampNumber(parsed.repeatThreshold, 2, 10, base.repeatThreshold),
    repeatMinUnit: clampNumber(parsed.repeatMinUnit, 8, 400, base.repeatMinUnit),
    temperature:
      typeof parsed.temperature === 'number'
        ? clampNumber(parsed.temperature, 0, 2, base.temperature ?? 0.7)
        : base.temperature,
    topP:
      typeof parsed.topP === 'number' ? clampNumber(parsed.topP, 0, 1, base.topP ?? 1) : base.topP,
    maxTokens:
      typeof parsed.maxTokens === 'number' && parsed.maxTokens > 0
        ? Math.min(1_000_000, Math.floor(parsed.maxTokens))
        : base.maxTokens,
    compactThreshold:
      Number(parsed.compactThreshold) > 0 && Number(parsed.compactThreshold) <= 100
        ? Number(parsed.compactThreshold)
        : base.compactThreshold,
    compactKeepRecent: clampNumber(parsed.compactKeepRecent, 2, 50, base.compactKeepRecent),
    // 主题：默认 / 浅色 / 极光 / OreUI（老的 minimal 迁移到默认）
    theme:
      parsed.theme === 'aurora' || parsed.theme === 'light' || parsed.theme === 'oreui'
        ? parsed.theme
        : 'dark',
    color:
      parsed.color === 'amber' ||
      parsed.color === 'blue' ||
      parsed.color === 'cyan' ||
      parsed.color === 'emerald' ||
      parsed.color === 'violet' ||
      parsed.color === 'rose'
        ? parsed.color
        : 'default',
    layout: parsed.layout === 'workbench' ? 'workbench' : 'classic',
    // 语言：jp（日本語）不受支持，选中后界面回落到简体中文
    language:
      parsed.language === 'en' || parsed.language === 'tw' || parsed.language === 'jp'
        ? parsed.language
        : 'zh',
    reasoningExpanded: parsed.reasoningExpanded === true,
    statusStyle: parsed.statusStyle === 'text' ? 'text' : 'icon',
    statusItems: Array.isArray(parsed.statusItems)
      ? STATUS_ITEM_IDS.filter((id) => (parsed.statusItems as StatusItemId[]).includes(id))
      : [...DEFAULT_STATUS_ITEMS],
    flatBorders: parsed.flatBorders === true,
    // 过程显示模式：新字段优先；老配置里只有 compactActivity 布尔值，就地迁移过来
    activityMode:
      parsed.activityMode === 'compact' || parsed.activityMode === 'result'
        ? parsed.activityMode
        : (parsed as { compactActivity?: boolean }).compactActivity === true
          ? 'compact'
          : 'default',
    soundEnabled: parsed.soundEnabled !== false,
    soundVolume: clampVolume(parsed.soundVolume, base.soundVolume),
    sounds: mergeSounds(parsed.sounds),
    skills: mergeSkills(parsed.skills),
    reasoningEffort:
      parsed.reasoningEffort === 'low' ||
      parsed.reasoningEffort === 'medium' ||
      parsed.reasoningEffort === 'high'
        ? parsed.reasoningEffort
        : 'off',
    webSearchEngine:
      parsed.webSearchEngine === 'bing' || parsed.webSearchEngine === 'duckduckgo'
        ? parsed.webSearchEngine
        : 'auto',
    proxy: typeof parsed.proxy === 'string' ? parsed.proxy.trim() : '',
    musicSource:
      typeof parsed.musicSource === 'string' && parsed.musicSource.trim() !== ''
        ? parsed.musicSource.trim()
        : 'auto',
    musicBase: typeof parsed.musicBase === 'string' ? parsed.musicBase.trim() : '',
    musicQuality: [128, 192, 320, 740, 999].includes(parsed.musicQuality as number)
      ? (parsed.musicQuality as number)
      : 320,
    computerEnabled: parsed.computerEnabled !== false,
    computerMaxWidth:
      typeof parsed.computerMaxWidth === 'number' && Number.isFinite(parsed.computerMaxWidth)
        ? Math.min(4096, Math.max(0, Math.round(parsed.computerMaxWidth)))
        : 1280,
    floatingWindow: parsed.floatingWindow === true,
    importScope: parsed.importScope === 'all' ? 'all' : 'project',
    statusBar: parsed.statusBar !== false,
    mcpBrowser:
      parsed.mcpBrowser === 'off' ||
      parsed.mcpBrowser === 'msedge' ||
      parsed.mcpBrowser === 'chrome' ||
      parsed.mcpBrowser === 'chromium'
        ? parsed.mcpBrowser
        : 'chromium',
    mcpHeadless: parsed.mcpHeadless !== false,
    mcpServers: mergeMcpServers(parsed.mcpServers),
    // 语音：输入 / 朗读默认开，自动朗读默认关
    voiceInput: parsed.voiceInput !== false,
    voiceOutput: parsed.voiceOutput !== false,
    voiceAutoRead: parsed.voiceAutoRead === true,
    voiceRate:
      typeof parsed.voiceRate === 'number' && Number.isFinite(parsed.voiceRate)
        ? Math.min(2, Math.max(0.5, parsed.voiceRate))
        : base.voiceRate,
    voiceName: typeof parsed.voiceName === 'string' ? parsed.voiceName.trim() : '',
    voiceGroup:
      parsed.voiceGroup === 'online' || parsed.voiceGroup === 'name'
        ? parsed.voiceGroup
        : 'language',
  }
}

/** 从 v1 的单提供商配置迁移 */
function migrateLegacy(): AppSettings | null {
  const raw = localStorage.getItem(LEGACY_KEY)
  if (!raw) return null
  try {
    const old = JSON.parse(raw) as {
      provider?: { baseURL?: string; apiKey?: string; model?: string; apiStyle?: ApiStyle }
      systemPrompt?: string
      executor?: ExecutorKind
      companionToken?: string
      maxIterations?: number
    }
    const base = defaultSettings()
    const provider = base.providers[0]
    provider.baseURL = old.provider?.baseURL || provider.baseURL
    provider.apiKey = old.provider?.apiKey ?? ''
    provider.apiStyle = old.provider?.apiStyle ?? 'openai'
    if (old.provider?.model) {
      provider.models = [{ id: old.provider.model }]
      base.activeModel = old.provider.model
    }
    base.systemPrompt = old.systemPrompt ?? ''
    base.executor = old.executor ?? 'auto'
    base.companionToken = old.companionToken ?? ''
    base.maxIterations = old.maxIterations ?? 25
    return base
  } catch {
    return null
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // 隐私模式下可能写入失败，忽略
  }
}

/** 当前选中的提供商 */
export function activeProvider(settings: AppSettings): Provider | null {
  return (
    settings.providers.find((p) => p.id === settings.activeProviderId) ??
    settings.providers[0] ??
    null
  )
}

/** 组装一次请求所需的连接信息；缺少模型或提供商时返回 null */
export function toLlmTarget(settings: AppSettings): LlmTarget | null {
  const provider = activeProvider(settings)
  if (!provider || !settings.activeModel) return null
  const headers = (provider.headers ?? []).filter((h) => h.key.trim() !== '')
  return {
    baseURL: provider.baseURL,
    apiKey: provider.apiKey,
    apiStyle: provider.apiStyle,
    model: settings.activeModel,
    ...(typeof settings.temperature === 'number' ? { temperature: settings.temperature } : {}),
    ...(typeof settings.topP === 'number' ? { topP: settings.topP } : {}),
    ...(typeof settings.maxTokens === 'number' && settings.maxTokens > 0
      ? { maxTokens: settings.maxTokens }
      : {}),
    ...(headers.length > 0 ? { headers } : {}),
    ...(settings.reasoningEffort && settings.reasoningEffort !== 'off'
      ? { reasoningEffort: settings.reasoningEffort }
      : {}),
    // 兼容性选项
    ...(provider.maxTokensParam ? { maxTokensParam: provider.maxTokensParam } : {}),
    ...(provider.systemRole ? { systemRole: provider.systemRole } : {}),
    ...(typeof provider.streamUsage === 'boolean' ? { streamUsage: provider.streamUsage } : {}),
    ...(typeof provider.sendSampling === 'boolean' ? { sendSampling: provider.sendSampling } : {}),
    ...(parseExtraBody(provider.extraBody) ? { extraBody: parseExtraBody(provider.extraBody)!.extraBody } : {}),
  }
}

/** 解析「额外请求体」文本框：不是合法对象就当没填（不阻断请求） */
function parseExtraBody(raw?: string): { extraBody: Record<string, unknown> } | null {
  const text = (raw ?? '').trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return { extraBody: parsed as Record<string, unknown> }
  } catch {
    return null
  }
}
