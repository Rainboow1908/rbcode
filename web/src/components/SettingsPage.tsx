import { Fragment, useEffect, useRef, useState } from 'react'
import Collapse from './Collapse.tsx'
import Drawer from './Drawer.tsx'
import LicenseDialog from './LicenseDialog.tsx'
import OreCheckbox from './OreCheckbox.tsx'
import Select from './Select.tsx'
import StatusItemIcon from './StatusItemIcon.tsx'
import { useIsMobile } from '../hooks/useIsMobile.ts'
import type { Backend } from '../lib/executor/types.ts'
import { backendName, LANGS, t, useT } from '../lib/i18n.ts'
import { canRecognize, canSpeak, listVoices, voiceGroupLabel } from '../lib/speech.ts'
import { loadMcpTools } from '../lib/mcp.ts'
import { listModels } from '../lib/models.ts'
import { permissionHint, permissionLabel } from '../lib/permissions.ts'
import { PROVIDER_PRESETS } from '../lib/presets/providers.ts'
import { STATUS_ITEM_IDS, STATUS_ITEM_LABEL } from '../lib/statusBar.ts'
import { matchSettings, type SettingIndexEntry } from '../lib/settingsIndex.ts'
import {
  APP_VERSION,
  activeProvider,
  createProvider,
  defaultSettings,
  REASONING_EFFORT_HINT,
  REASONING_EFFORT_LABEL,
} from '../lib/settings.ts'
import {
  playSound,
  SOUND_EVENTS,
  SOUND_IDS,
  soundEventHint,
  soundEventLabel,
  soundLabel,
} from '../lib/sound.ts'
import Tooltip from './Tooltip.tsx'
import OreButton from './OreButton.tsx'
import type {
  ActivityMode,
  AppSettings,
  ColorMode,
  ExecutorKind,
  Lang,
  LayoutMode,
  McpBrowser,
  McpServerConfig,
  ModelInfo,
  PermissionMode,
  Provider,
  ReasoningEffort,
  RepeatScope,
  RequestHeader,
  Skill,
  SoundId,
  ThemeMode,
  VoiceGroup,
  WebSearchEngine,
} from '../lib/types.ts'
import {
  AlertIcon,
  ArrowLeftIcon,
  BoxIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  ClipboardListIcon,
  DownloadIcon,
  FolderIcon,
  GaugeIcon,
  GridIcon,
  HeartIcon,
  HelpCircleIcon,
  ImageIcon,
  LightbulbIcon,
  MenuIcon,
  MessageSquareIcon,
  PermissionsIcon,
  PencilIcon,
  PanelRightIcon,
  PlusIcon,
  RepeatIcon,
  SearchIcon,
  SettingsIcon,
  SparklesIcon,
  TerminalIcon,
  TrashIcon,
  VolumeIcon,
  WrenchIcon,
} from './icons.tsx'

interface Props {
  open: boolean
  settings: AppSettings
  onChange: (patch: Partial<AppSettings>) => void
  onClose: () => void
  backend: Backend | null
  backendError: string | null
  onOpenProject: () => void
  /** 已保存的项目数量（数据页展示 + 清空前确认用） */
  projectCount: number
  /** 已缓存会话索引的项目数量 */
  sessionCacheProjects: number
  onClearSessionCache: () => void
  onClearProjects: () => void
  onConnectCompanion: (token: string) => void
  onDisconnect: () => void
}

type SectionId =
  | 'general'
  | 'appearance'
  | 'sound'
  | 'voice'
  | 'music'
  | 'providers'
  | 'backend'
  | 'mcp'
  | 'computer'
  | 'statusbar'
  | 'skills'
  | 'advanced'
  | 'data'

const SECTIONS: {
  group: string
  items: { id: SectionId; label: string; icon: typeof SettingsIcon }[]
}[] = [
  {
    group: '偏好设置',
    items: [
      { id: 'general', label: '通用', icon: SettingsIcon },
      { id: 'sound', label: '提示音', icon: VolumeIcon },
      { id: 'voice', label: '语音', icon: MessageSquareIcon },
      { id: 'music', label: '音乐', icon: HeartIcon },
    ],
  },
  { group: '模型', items: [{ id: 'providers', label: '模型服务', icon: BoxIcon }] },
  {
    group: '集成与连接',
    items: [
      { id: 'backend', label: '执行后端', icon: TerminalIcon },
      { id: 'mcp', label: 'MCP', icon: WrenchIcon },
      { id: 'computer', label: 'computer use', icon: ImageIcon },
    ],
  },
  {
    group: '个性化',
    items: [
      { id: 'appearance', label: '外观与交互', icon: LightbulbIcon },
      { id: 'statusbar', label: '状态栏', icon: PanelRightIcon },
    ],
  },
  {
    group: '高级',
    items: [
      { id: 'skills', label: '技能', icon: SparklesIcon },
      { id: 'advanced', label: '系统提示词', icon: WrenchIcon },
      { id: 'data', label: '数据与关于', icon: HelpCircleIcon },
    ],
  },
]

/**
 * 设置页控件的统一尺寸：高度 h-8 + text-xs，普通控件宽度 w-64（16rem / 256px）。
 */
const W_CTRL = 'w-64'
/** 窄输入框 w-48：数字输入，以及「连接」里的名称 / 接口地址 / API Key、本机执行器配对令牌（和阈值输入框同宽） */
const W_NUM = 'w-48'

const inputClass =
  'rb-field w-full h-8 rounded-lg bg-neutral-800/60 px-2.5 text-xs text-neutral-100 outline-none transition-colors placeholder:text-neutral-600 hover:bg-neutral-800 focus:bg-neutral-800 focus-visible:ring-1 focus-visible:ring-neutral-600'

/** MCP 配置里的多行输入框（不能带 h-8，否则和 resize-y 打架） */
const mcpAreaClass =
  'rb-field w-full resize-y rounded-lg bg-neutral-800/60 px-2.5 py-1.5 font-mono text-xs text-neutral-100 outline-none transition-colors placeholder:text-neutral-600 hover:bg-neutral-800 focus:bg-neutral-800 focus-visible:ring-1 focus-visible:ring-neutral-600'

/** MCP 环境变量：每行 `KEY=VALUE`（用文本行编辑，比让人写 JSON 顺手） */
function envToText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
}

function textToEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const at = line.indexOf('=')
    if (at < 0) {
      env[line] = ''
      continue
    }
    env[line.slice(0, at).trim()] = line.slice(at + 1)
  }
  return env
}

/** 预设分组的显示名（按当前界面语言） */
function presetGroupLabel(group: string): string {
  switch (group) {
    case 'officialIntl':
      return t('国际官方', 'International official', '國際官方', '海外公式')
    case 'officialCn':
      return t('国内官方', 'China official', '國內官方', '中国公式')
    case 'aggregatorIntl':
      return t('国际聚合', 'International aggregators', '國際聚合')
    case 'relayCn':
      return t('国内中转', 'China relay services', '國內中轉')
    default:
      return t('本地 / 自建', 'Local / self-hosted', '本機 / 自建')
  }
}

/** 额外请求体输入框下面的提示：是不是合法 JSON 对象 */
function extraBodyState(raw?: string): string {
  const text = (raw ?? '').trim()
  if (!text) return ''
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return t('需要是一个 JSON 对象', 'Must be a JSON object', '需要是一個 JSON 物件')
    }
    return t(
      'JSON 有效，会合并进请求体',
      'Valid JSON — will be merged into the request body',
      'JSON 有效，會合併進請求內容',
    )
  } catch {
    return t('不是合法 JSON，会被忽略', 'Not valid JSON — it will be ignored', '不是合法 JSON，會被忽略')
  }
}

/** 侧栏导航的分组名 / 条目名（按当前界面语言） */
function sectionGroupLabel(group: string, t: ReturnType<typeof useT>): string {
  const map: Record<string, [string, string, string, string]> = {
    偏好设置: ['偏好设置', 'Preferences', '偏好設定', '環境設定'],
    模型: ['模型', 'Model', '模型', 'モデル'],
    集成与连接: ['集成与连接', 'Integrations', '整合與連線', '連携と接続'],
    个性化: ['个性化', 'Personalization', '個人化', 'パーソナライズ'],
    高级: ['高级', 'Advanced', '進階', '詳細設定'],
  }
  const entry = map[group]
  return entry ? t(entry[0], entry[1], entry[2], entry[3]) : group
}

function sectionItemLabel(id: string, t: ReturnType<typeof useT>): string {
  const map: Record<string, [string, string, string, string]> = {
    general: ['通用', 'General', '一般', '一般'],
    appearance: ['外观与交互', 'Appearance', '外觀與互動', '外観と操作'],
    sound: ['提示音', 'Sounds', '提示音', '通知音'],
    voice: ['语音', 'Voice', '語音', '音声'],
    providers: ['模型服务', 'Model providers', '模型服務', 'モデルサービス'],
    backend: ['执行后端', 'Execution backend', '執行後端', '実行バックエンド'],
    mcp: ['MCP', 'MCP', 'MCP', 'MCP'],
    computer: ['Computer use', 'Computer use', 'Computer use', 'Computer use'],
    skills: ['技能', 'Skills', '技能', 'スキル'],
    statusbar: ['状态栏', 'Status bar', '狀態欄', 'ステータスバー'],
    advanced: ['系统提示词', 'System prompt', '系統提示詞', 'システムプロンプト'],
    data: ['数据与关于', 'Data & about', '資料與關於', 'データと情報'],
  }
  const entry = map[id]
  return entry ? t(entry[0], entry[1], entry[2], entry[3]) : id
}

/** 上下文窗口的常见取值，供下拉快速填入 */
const CONTEXT_PRESETS = [8_000, 16_000, 32_000, 64_000, 128_000, 200_000, 256_000, 1_000_000]

/* --------------------------------- 通用小组件 --------------------------------- */

function Toggle({
  value,
  onChange,
  disabled = false,
}: {
  value: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!value)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
        disabled ? 'cursor-not-allowed bg-neutral-800 opacity-50' : value ? 'bg-amber-600' : 'bg-neutral-700'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
          value ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  )
}

/** 可为空的数字输入：留空表示「使用接口默认值」 */
function OptionalNumber({
  value,
  onChange,
  min,
  max,
  step,
  placeholder,
  className = W_CTRL,
}: {
  value: number | undefined
  onChange: (next: number | undefined) => void
  min?: number
  max?: number
  step?: number
  placeholder?: string
  className?: string
}) {
  const t = useT()
  return (
    <input
      type="number"
      step={step}
      placeholder={placeholder ?? t('默认', 'Default', '預設')}
      value={value === undefined ? '' : value}
      onChange={(e) => {
        const raw = e.target.value
        if (raw === '') {
          onChange(undefined)
          return
        }
        const parsed = Number(raw)
        if (!Number.isFinite(parsed)) return
        // 自己夹到范围内：不用浏览器的原生「值必须小于或等于 100」气泡
        const lower = min ?? Number.NEGATIVE_INFINITY
        const upper = max ?? Number.POSITIVE_INFINITY
        onChange(Math.min(upper, Math.max(lower, parsed)))
      }}
      className={`rb-num ${inputClass} ${className} text-left placeholder:text-neutral-600`}
    />
  )
}

/**
 * 必填的数字输入：自己夹范围并关掉浏览器的原生校验气泡
 * （否则会出现「值必须小于或等于 100」这种原生提示）。
 */
function NumberField({
  value,
  onChange,
  min,
  max,
  step,
  fallback,
  suffix,
  hint,
  className = W_NUM,
}: {
  value: number
  onChange: (next: number) => void
  min?: number
  max?: number
  step?: number
  /** 清空时回退到这个值 */
  fallback: number
  suffix?: string
  /** 悬浮提示（面向用户的说明）；不传就用「取值范围」兜底 */
  hint?: string
  className?: string
}) {
  const lower = min ?? Number.NEGATIVE_INFINITY
  const upper = max ?? Number.POSITIVE_INFINITY
  // 悬浮提示：优先用调用方给的说明文字，否则退回「范围」
  const tip = hint ?? (min !== undefined && max !== undefined ? `${min}–${max}` : undefined)
  // 底色只由「输入框自己」提供，量词是浮在它上面的纯文字（pointer-events-none）——
  // 这样只有一处背景，不会再出现「数字区和量词区深浅不一」的接缝。
  const group = (
    <div className={`relative ${className}`}>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(event) => {
          if (event.target.value === '') {
            onChange(fallback)
            return
          }
          const parsed = Number(event.target.value)
          if (!Number.isFinite(parsed)) return
          onChange(Math.min(upper, Math.max(lower, parsed)))
        }}
        className={`rb-num rb-field h-8 w-full rounded-lg bg-neutral-800/60 pl-2.5 text-left text-xs text-neutral-100 outline-none transition-colors placeholder:text-neutral-600 hover:bg-neutral-800 focus:bg-neutral-800 focus-visible:ring-1 focus-visible:ring-neutral-600 ${
          suffix ? 'pr-14' : 'pr-2.5'
        }`}
      />
      {suffix && (
        <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-[11px] text-neutral-500">
          {suffix}
        </span>
      )}
    </div>
  )
  return tip ? <Tooltip label={tip}>{group}</Tooltip> : group
}

function Row({
  icon,
  title,
  desc,
  children,}: {
  icon: React.ReactNode
  title: string
  desc?: string
  children?: React.ReactNode
}) {
  return (
    <div
      data-setting-title={title}
      className="flex flex-wrap items-start gap-x-4 gap-y-2 border-b border-neutral-800/60 py-4 last:border-b-0"
    >
      <div className="mt-0.5 shrink-0 text-neutral-500">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-neutral-100">{title}</div>
        {desc && <div className="mt-1 text-xs leading-relaxed text-neutral-500">{desc}</div>}
      </div>
      {children && (
        <div className="shrink-0 whitespace-nowrap max-md:w-full max-md:whitespace-normal">
          {children}
        </div>
      )}
    </div>
  )
}

function GroupTitle({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="mb-2">
      <h2 className="text-base font-semibold text-neutral-100">{title}</h2>
      {desc && <p className="mt-1 text-xs text-neutral-500">{desc}</p>}
    </div>
  )
}

/** 小节标题：把一个长设置页分成「连接 / 模型 / 高级 / 危险区」几块 */
function SubTitle({ children, first }: { children: React.ReactNode; first?: boolean }) {
  return (
    <h3
      className={`text-[11px] font-medium tracking-wider text-neutral-500 uppercase ${
        first ? 'mt-2 mb-1' : 'mt-8 mb-1 border-t border-neutral-800/60 pt-4'
      }`}
    >
      {children}
    </h3>
  )
}

/** 可折叠小节：高级设置默认收起，页面才清爽 */
function SubSection({
  title,
  desc,
  children,
}: {
  title: string
  desc?: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-8 border-t border-neutral-800/60 pt-4">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="rb-nohover flex w-full items-center gap-1.5 text-left"
      >
        <ChevronRightIcon
          className={`h-3 w-3 shrink-0 text-neutral-600 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className="text-[11px] font-medium tracking-wider text-neutral-500 uppercase">
          {title}
        </span>
      </button>
      {desc && <p className="mt-1 ml-[18px] text-xs leading-relaxed text-neutral-600">{desc}</p>}
      <Collapse open={open}>
        <div className="mt-1">{children}</div>
      </Collapse>
    </div>
  )
}

type Feedback = { kind: 'ok' | 'error'; message: string } | null

function FeedbackLine({ value }: { value: Feedback }) {
  if (!value) return null
  return (
    <p className={`mt-3 text-xs ${value.kind === 'ok' ? 'text-emerald-400' : 'text-amber-400'}`}>
      {value.message}
    </p>
  )
}

/* ----------------------------------- 主体 ----------------------------------- */

export default function SettingsPage(props: Props) {
  const t = useT()
  const { open, settings, onChange, onClose, backend, backendError } = props
  const [section, setSection] = useState<SectionId>('general')
  const [query, setQuery] = useState('')
  /** 手机端：分组导航收进抽屉，用一个状态控制开合 */
  const [navOpen, setNavOpen] = useState(false)
  const isMobile = useIsMobile()
  const [discovered, setDiscovered] = useState<ModelInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testState, setTestState] = useState<Feedback>(null)
  const [dataState, setDataState] = useState<Feedback>(null)
  const [healthState, setHealthState] = useState<Feedback>(null)
  const [manualModel, setManualModel] = useState('')
  const [openSkillId, setOpenSkillId] = useState<string | null>(null)
  /** 版权与许可：点「查看」才弹出来 */
  const [licenseOpen, setLicenseOpen] = useState(false)
  /** 系统里可用的朗读音色（有的浏览器要等 voiceschanged 之后才给） */
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [mcpState, setMcpState] = useState<Feedback>(null)
  const [probingMcp, setProbingMcp] = useState(false)
  const importRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!canSpeak()) return
    const synth = window.speechSynthesis
    const load = () => setVoices(listVoices())
    load()
    synth.addEventListener?.('voiceschanged', load)
    return () => synth.removeEventListener?.('voiceschanged', load)
  }, [])

  /** 音色列表的分组名（按设置里选的分组方式算） */
  const voiceGroupOf = (voice: SpeechSynthesisVoice): string => {
    if (settings.voiceGroup === 'online') {
      return voice.localService
        ? t('本地（离线）', 'On-device (offline)', '本機（離線）')
        : t('在线', 'Online', '線上')
    }
    if (settings.voiceGroup === 'name') {
      const head = voice.name.split(/[-–—(（]/)[0]?.trim()
      return head || t('其他', 'Other', '其他')
    }
    const label = voiceGroupLabel(voice.lang)
    return label.startsWith('中文')
      ? t('中文', 'Chinese', '中文')
      : label.startsWith('English')
        ? 'English'
        : label
  }

  if (!open) return null

  const provider = activeProvider(settings)

  /* ------------------------------------ MCP ------------------------------------ */

  const patchMcpServer = (id: string, patch: Partial<McpServerConfig>) =>
    onChange({
      mcpServers: settings.mcpServers.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      ),
    })

  const addMcpServer = () =>
    onChange({
      mcpServers: [
        ...settings.mcpServers,
        {
          id: `mcp-${crypto.randomUUID().slice(0, 8)}`,
          name: t('新服务器', 'New server', '新伺服器'),
          command: '',
          args: [],
          env: {},
          enabled: true,
        },
      ],
    })

  const removeMcpServer = (id: string) =>
    onChange({ mcpServers: settings.mcpServers.filter((item) => item.id !== id) })

  /** 按当前配置拉一次：会在项目目录下真的把服务器起起来，并列出工具 */
  const probeMcp = async () => {
    if (!backend?.mcpList) {
      setMcpState({
        kind: 'error',
        message: t(
          '需要先连接本机执行器（MCP 要起子进程）。',
          'Connect the local executor first — MCP needs to spawn processes.',
          '需要先連接本機執行器（MCP 要起子行程）。',
        ),
      })
      return
    }
    setProbingMcp(true)
    setMcpState(null)
    try {
      const snapshot = await loadMcpTools(backend, settings, backend.rootLabel)
      const parts = snapshot.specs.map((spec) => {
        const count = snapshot.entries.filter((entry) => entry.spec.id === spec.id).length
        return `${spec.name}: ${count}`
      })
      for (const failure of snapshot.errors) parts.push(`${failure.name}: ${failure.error}`)
      setMcpState({
        kind: snapshot.errors.length > 0 ? 'error' : 'ok',
        message:
          parts.length > 0
            ? parts.join(' · ')
            : t('没有可用工具。', 'No tools available.', '沒有可用工具。'),
      })
    } catch (err) {
      setMcpState({ kind: 'error', message: (err as Error).message })
    } finally {
      setProbingMcp(false)
    }
  }

  const patchProviders = (providers: Provider[]) => onChange({ providers })
  const updateProvider = (patch: Partial<Provider>) => {
    if (!provider) return
    patchProviders(settings.providers.map((p) => (p.id === provider.id ? { ...p, ...patch } : p)))
  }

  /** 切换提供商：自动选中它的默认模型（没有就选第一个） */
  const selectProvider = (id: string) => {
    const target = settings.providers.find((p) => p.id === id)
    const model =
      target?.defaultModel && target.models.some((m) => m.id === target.defaultModel)
        ? target.defaultModel
        : (target?.models[0]?.id ?? '')
    onChange({ activeProviderId: id, activeModel: model })
  }

  const addProvider = (presetName: string) => {
    const next = createProvider(presetName)
    onChange({
      providers: [...settings.providers, next],
      activeProviderId: next.id,
      activeModel: '',
    })
  }

  const removeProvider = (id: string) => {
    if (settings.providers.length <= 1) {
      setError(t('至少要保留一个提供商', 'Keep at least one provider', '至少要保留一個供應商'))
      return
    }
    const remained = settings.providers.filter((p) => p.id !== id)
    const nextActive = settings.activeProviderId === id ? remained[0].id : settings.activeProviderId
    onChange({
      providers: remained,
      activeProviderId: nextActive,
      activeModel: nextActive === settings.activeProviderId ? settings.activeModel : '',
    })
  }

  const addModel = (id: string) => {
    if (!provider) return
    const trimmed = id.trim()
    if (!trimmed) return
    const exists = provider.models.some((m) => m.id === trimmed)
    const models = exists ? provider.models : [...provider.models, { id: trimmed }]
    onChange({
      providers: settings.providers.map((p) => (p.id === provider.id ? { ...p, models } : p)),
      activeModel: trimmed,
    })
  }

  const removeModel = (id: string) => {
    if (!provider) return
    const patch: Partial<Provider> = { models: provider.models.filter((m) => m.id !== id) }
    if (provider.defaultModel === id) patch.defaultModel = undefined
    updateProvider(patch)
    if (settings.activeModel === id) onChange({ activeModel: '' })
  }

  /** 设置/取消某个模型为该提供商的默认模型 */
  const toggleDefaultModel = (id: string) => {
    if (!provider) return
    updateProvider({ defaultModel: provider.defaultModel === id ? undefined : id })
  }

  /** 改模型显示名（只影响界面，请求里仍用 id） */
  const renameModel = (id: string, current?: string) => {
    if (!provider) return
    const input = window.prompt(
      t(
        '模型显示名（留空恢复用 id 显示）',
        'Model display name (leave empty to use the id)',
        '模型顯示名稱（留空則用 id 顯示）',
      ),
      current ?? '',
    )
    if (input === null) return
    const label = input.trim()
    updateProvider({
      models: provider.models.map((m) => (m.id === id ? (label ? { id: m.id, label } : { id: m.id }) : m)),
    })
  }

  async function identify() {
    if (!provider) return
    setLoading(true)
    setError(null)
    try {
      const list = await listModels(provider)
      setDiscovered(list)
      if (list.length === 0)
        setError(
          t(
            '接口没有返回模型，请手动填写模型名',
            'The API returned no models — enter a model name manually',
            '介面沒有回傳模型，請手動填寫模型名稱',
          ),
        )
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  /** 只验证 baseURL + Key 是否可用，不改动已添加的模型 */
  async function testConnection() {
    if (!provider) return
    setTesting(true)
    setTestState(null)
    try {
      const list = await listModels(provider)
      setTestState({
        kind: 'ok',
        message: t(
          `连接成功，接口返回 ${list.length} 个模型`,
          `Connected — the API returned ${list.length} models`,
          `連線成功，介面回傳 ${list.length} 個模型`,
        ),
      })
    } catch (err) {
      setTestState({ kind: 'error', message: (err as Error).message })
    } finally {
      setTesting(false)
    }
  }

  /* ------------------------------- 自定义请求头 ------------------------------- */

  const headers = provider?.headers ?? []
  const addHeader = () => updateProvider({ headers: [...headers, { key: '', value: '' }] })
  const updateHeader = (index: number, patch: Partial<RequestHeader>) =>
    updateProvider({ headers: headers.map((h, i) => (i === index ? { ...h, ...patch } : h)) })
  const removeHeader = (index: number) =>
    updateProvider({ headers: headers.filter((_, i) => i !== index) })

  /* ---------------------------------- 技能 ---------------------------------- */

  const addSkill = () => {
    const skill: Skill = {
      id: crypto.randomUUID(),
      name: 'new-skill',
      description: '',
      instructions: '',
    }
    onChange({ skills: [...settings.skills, skill] })
    setOpenSkillId(skill.id)
  }

  const updateSkill = (id: string, patch: Partial<Skill>) =>
    onChange({ skills: settings.skills.map((s) => (s.id === id ? { ...s, ...patch } : s)) })

  const removeSkill = (id: string) =>
    onChange({ skills: settings.skills.filter((s) => s.id !== id) })

  /* --------------------------------- 数据与关于 --------------------------------- */

  function exportSettings() {
    try {
      const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'rbcode-settings.json'
      link.click()
      URL.revokeObjectURL(url)
      setDataState({
        kind: 'ok',
        message: t(
          '已导出 rbcode-settings.json（含 API Key，请妥善保管）',
          'Exported rbcode-settings.json (contains your API key — keep it safe)',
          '已匯出 rbcode-settings.json（含 API Key，請妥善保管）',
        ),
      })
    } catch (err) {
      setDataState({
        kind: 'error',
        message: t(
          `导出失败：${(err as Error).message}`,
          `Export failed: ${(err as Error).message}`,
          `匯出失敗：${(err as Error).message}`,
        ),
      })
    }
  }

  function importSettings(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    void file.text().then((text) => {
      try {
        const parsed = JSON.parse(text) as Partial<AppSettings>
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.providers)) {
          throw new Error(
            t(
              '不是有效的 RB Code 设置文件',
              'Not a valid RB Code settings file',
              '不是有效的 RB Code 設定檔',
            ),
          )
        }
        onChange(parsed)
        setDataState({ kind: 'ok', message: t('设置已导入', 'Settings imported', '設定已匯入') })
      } catch (err) {
        setDataState({
          kind: 'error',
          message: t(
            `导入失败：${(err as Error).message}`,
            `Import failed: ${(err as Error).message}`,
            `匯入失敗：${(err as Error).message}`,
          ),
        })
      }
    })
  }

  function resetSettings() {
    if (
      !window.confirm(
        t(
          '恢复出厂设置？提供商、模型、提示词等设置都会重置（项目与会话数据不受影响）。',
          'Restore factory settings? Providers, models, prompts and other settings will be reset (projects and sessions are unaffected).',
          '恢復出廠設定？供應商、模型、提示詞等設定都會重設（專案與工作階段資料不受影響）。',
        ),
      )
    ) {
      return
    }
    onChange(defaultSettings())
    setDataState({ kind: 'ok', message: t('已恢复出厂设置', 'Factory settings restored', '已恢復出廠設定') })
  }

  function clearSessionCache() {
    if (
      !window.confirm(
        t(
          '清空会话列表缓存？下次启动会重新从各项目读取会话列表（不会动磁盘上的文件）。',
          'Clear the session list cache? On next launch the sidebar re-reads sessions from each project (no files on disk are touched).',
          '清空工作階段列表快取？下次啟動會重新從各專案讀取工作階段列表（不會動磁碟上的檔案）。',
        ),
      )
    ) {
      return
    }
    props.onClearSessionCache()
    setDataState({
      kind: 'ok',
      message: t('已清空会话列表缓存', 'Session list cache cleared', '已清空工作階段列表快取'),
    })
  }

  function clearProjects() {
    if (
      !window.confirm(
        t(
          `清空项目列表？将移除 ${props.projectCount} 条项目记录与目录授权，磁盘文件与会话数据不受影响。`,
          `Clear the project list? This removes ${props.projectCount} project records and folder permissions; files and sessions on disk are unaffected.`,
          `清空專案列表？將移除 ${props.projectCount} 筆專案記錄與目錄授權，磁碟檔案與工作階段資料不受影響。`,
        ),
      )
    ) {
      return
    }
    props.onClearProjects()
    setDataState({
      kind: 'ok',
      message: t('已清空项目列表', 'Project list cleared', '已清空專案列表'),
    })
  }

  async function checkHealth() {
    setHealthState(null)
    try {
      const res = await fetch('/api/health', { signal: AbortSignal.timeout(5000) })
      const data = (await res.json()) as { ok?: boolean; ts?: number }
      if (data?.ok) {
        setHealthState({
          kind: 'ok',
          message: t(
            `服务正常（${new Date(data.ts ?? Date.now()).toLocaleTimeString()}）`,
            `Service OK (${new Date(data.ts ?? Date.now()).toLocaleTimeString()})`,
            `服務正常（${new Date(data.ts ?? Date.now()).toLocaleTimeString()}）`,
          ),
        })
      } else {
        setHealthState({
          kind: 'error',
          message: t(
            `服务返回异常：${res.status}`,
            `Service returned an error: ${res.status}`,
            `服務回傳異常：${res.status}`,
          ),
        })
      }
    } catch (err) {
      setHealthState({
        kind: 'error',
        message: t(
          `连不上服务：${(err as Error).message}`,
          `Cannot reach the service: ${(err as Error).message}`,
          `連不上服務：${(err as Error).message}`,
        ),
      })
    }
  }

  async function testNotification() {
    if (typeof Notification === 'undefined') {
      setDataState({
        kind: 'error',
        message: t('当前环境不支持系统通知', 'System notifications are not supported here', '目前環境不支援系統通知'),
      })
      return
    }
    let permission = Notification.permission
    if (permission === 'default') {
      permission = await Notification.requestPermission()
    }
    if (permission !== 'granted') {
      setDataState({
        kind: 'error',
        message: t(
          '通知权限未授予，请在浏览器地址栏的权限设置里允许通知',
          'Notification permission was not granted — allow notifications in your browser’s address-bar permission settings',
          '尚未授予通知權限，請在瀏覽器網址列的權限設定中允許通知',
        ),
      })
      return
    }
    try {
      new Notification(
        t('RB Code 测试通知', 'RB Code test notification', 'RB Code 測試通知'),
        {
          body: t(
            '如果你看到这条，说明系统通知是通的。',
            'If you can see this, system notifications are working.',
            '如果你看到這則，表示系統通知是正常的。',
          ),
        },
      )
      setDataState({ kind: 'ok', message: t('已发送测试通知', 'Test notification sent', '已傳送測試通知') })
    } catch (err) {
      setDataState({
        kind: 'error',
        message: t(
          `发送失败：${(err as Error).message}`,
          `Sending failed: ${(err as Error).message}`,
          `傳送失敗：${(err as Error).message}`,
        ),
      })
    }
  }

  const pending = discovered.filter((m) => !provider?.models.some((x) => x.id === m.id))

  /** 搜索：既匹配分组名，也精确匹配到**每一条设置项**（标题 + 说明文字，忽略大小写） */
  const hits: SettingIndexEntry[] = query.trim() ? matchSettings(query) : []
  const hitsBySection = new Map<string, SettingIndexEntry[]>()
  for (const hit of hits) {
    hitsBySection.set(hit.section, [...(hitsBySection.get(hit.section) ?? []), hit])
  }

  const visibleSections = SECTIONS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) =>
        !query.trim() ||
        item.label.toLowerCase().includes(query.trim().toLowerCase()) ||
        hitsBySection.has(item.id),
    ),
  })).filter((group) => group.items.length > 0)

  const notificationPermission =
    typeof Notification === 'undefined'
      ? t('不支持', 'Unsupported', '不支援', '非対応')
      : Notification.permission

  /** 切换分组：手机端点了就顺手把抽屉关掉 */
  const selectSection = (id: SectionId) => {
    setSection(id)
    if (isMobile) setNavOpen(false)
  }

  /** 导航内容（搜索 + 分组列表）：桌面放左栏，手机放进抽屉 */
  const settingsNav = (
    <>
      <div className="px-3 pb-2">
        <div className="relative">
          <SearchIcon className="absolute top-2 left-2.5 h-3.5 w-3.5 text-neutral-600" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('搜索设置', 'Search settings', '搜尋設定')}
            className={inputClass + ' pr-2 pl-8'}
          />
        </div>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {visibleSections.length === 0 && (
          <p className="px-3 py-2 text-xs text-neutral-600">
            {t('没有匹配的设置项', 'No matching settings', '沒有符合的設定項')}
          </p>
        )}
        {visibleSections.map((group) => (
          <div key={group.group} className="mb-3">
            <div className="px-3 py-1.5 text-[11px] text-neutral-600">
              {sectionGroupLabel(group.group, t)}
            </div>
            {group.items.map((item) => {
              const Icon = item.icon
              return (
                <Fragment key={item.id}>
                  <button onClick={() => selectSection(item.id)}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                      section === item.id
                        ? 'bg-amber-600/15 text-amber-100'
                        : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200'
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    {sectionItemLabel(item.id, t)}
                  </button>
                  {/* 搜索命中的**具体设置项**：点一下跳到那一项 */}
                  {(hitsBySection.get(item.id) ?? []).map((hit) => (
                    <button
                      key={`${item.id}:${hit.title}`}
                      onClick={() => {
                        selectSection(item.id)
                        requestAnimationFrame(() => {
                          const node = Array.from(
                            document.querySelectorAll('[data-setting-title]'),
                          ).find(
                            (candidate) => candidate.getAttribute('data-setting-title') === hit.title,
                          )
                          node?.scrollIntoView({ block: 'center', behavior: 'smooth' })
                        })
                      }}
                      className="block w-full truncate rounded-md py-1 pr-2 pl-9 text-left text-[11px] text-neutral-500 transition-colors hover:bg-neutral-900 hover:text-amber-200"
                    >
                      {hit.title}
                    </button>
                  ))}
                </Fragment>
              )
            })}
          </div>
        ))}
      </nav>
    </>
  )

  return (
    <div className="rb-solid anim-fade fixed inset-0 z-50 flex flex-col bg-neutral-950 text-neutral-100 md:flex-row">
      {isMobile ? (
        /* 手机端：顶部一条，分组导航收进左侧抽屉 */
        <div className="flex shrink-0 items-center gap-2 border-b border-neutral-800 px-3 py-2">
          <button
            onClick={onClose}
            aria-label={t('返回工作区', 'Back to workspace', '返回工作區')}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-300 transition-colors hover:bg-neutral-900 hover:text-neutral-100"
          >
            <ArrowLeftIcon className="h-4 w-4" />
          </button>
          <div className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-100">
            {sectionItemLabel(section, t)}
          </div>
          <Tooltip label={t('设置分组', 'Settings sections', '設定分組')}>
            <button
              onClick={() => setNavOpen(true)}
              aria-label={t('设置分组', 'Settings sections', '設定分組')}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-300 transition-colors hover:bg-neutral-900 hover:text-neutral-100"
            >
              <MenuIcon className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>
      ) : (
        <aside className="flex w-64 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950/60">
          <div className="p-3">
            <OreButton status="normal"
              onClick={onClose}
              className="inline-flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-neutral-300 hover:bg-neutral-900 hover:text-neutral-100"
            >
              <ArrowLeftIcon className="h-4 w-4" />
              {t('返回工作区', 'Back to workspace', '返回工作區')}
            </OreButton>
          </div>
          {settingsNav}
        </aside>
      )}

      {/* 右侧内容 */}
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-4 py-5 sm:px-8 sm:py-8">
          {section === 'general' && (
            <>
              <GroupTitle
                title={t('通用', 'General', '一般', '一般')}
                desc={t(
                  '权限、上下文、采样参数与运行节奏。',
                  'Permissions, context, sampling and pace.',
                  '權限、上下文、取樣參數與執行節奏。',
                )}
              />

              <Row
                icon={<FolderIcon className="h-4 w-4" />}
                title={t('兼容导入', 'Import from other tools', '相容匯入')}
                desc={t(
                  '打开项目时，可以把旧工具（如 .reasonix）留下的对话导入进来；原文件只读。',
                  'Import conversations left behind by older tools (e.g. .reasonix); source files stay read-only.',
                  '開啟專案時，可以把舊工具（如 .reasonix）留下的對話匯入進來；原檔案唯讀。'
                )}
              >
                <Select<'project' | 'all'>
                  value={settings.importScope}
                  options={[
                    { value: 'project', label: t('只找本项目的', 'This project only', '只找本專案的') },
                    { value: 'all', label: t('连全局 / 归档一起', 'Include global / archive', '連全域 / 封存一起') },
                  ]}
                  onChange={(next) => onChange({ importScope: next })}
                />
              </Row>

              <Row
                icon={<PermissionsIcon className="h-4 w-4" />}
                title={t('默认权限', 'Default permission', '預設權限')}
                desc={permissionHint(settings.permission)}
              >
                <Select<PermissionMode>
                  value={settings.permission}
                  options={(['readonly', 'auto', 'full'] as PermissionMode[]).map((mode) => ({
                    value: mode,
                    label: permissionLabel(mode),
                  }))}
                  onChange={(next) => onChange({ permission: next })}
                />
              </Row>

              <Row
                icon={<BoxIcon className="h-4 w-4" />}
                title={t('上下文窗口', 'Context window', '上下文視窗')}
                desc={t(
                  '模型一次能记住多少内容。不确定就保持默认值。',
                  'How much the model can keep in mind at once. Keep the default if unsure.',
                  '模型一次能記住多少內容。不確定就保持預設值。'
                )}
              >
                <div className="flex items-center gap-2">
                  <Select
                    value=""
                    placeholder={t('常用…', 'Common…', '常用…')}
                    options={CONTEXT_PRESETS.map((value) => ({
                      value: String(value),
                      label: value >= 1_000_000 ? `${value / 1_000_000}M` : `${value / 1000}K`,
                    }))}
                    onChange={(next) => {
                      if (next) onChange({ contextWindow: Number(next) })
                    }}
                  />
                  <NumberField
                    value={settings.contextWindow}
                    min={1000}
                    step={1000}
                    fallback={128000}
                    hint={t(
                      '模型能记住多少字；不确定就填 128000 或点右边下拉挑一个',
                      'How much the model can remember; 128000 is a safe default',
                      '模型能記住多少字；不確定就填 128000',
                    )}
                    suffix="token"
                    onChange={(next) => onChange({ contextWindow: next })}
                  />
                </div>
              </Row>

              <Row
                icon={<BoxIcon className="h-4 w-4" />}
                title={t('压缩触发阈值', 'Compaction threshold', '壓縮觸發門檻')}
                desc={t(
                  `对话占到 ${settings.compactThreshold}% 时，前面的内容会自动总结掉；估算不完全精确，建议 70–80%。`,
                  `Older messages are summarized once the chat reaches ${settings.compactThreshold}%; the estimate is rough, 70–80% is a good range.`,
                  `對話佔到 ${settings.compactThreshold}% 時，前面的內容會自動總結掉；估算不完全精確，建議 70–80%。`,
                )}
              >
                <NumberField
                  value={settings.compactThreshold}
                  min={1}
                  max={100}
                  fallback={80}
                  hint={t(
                    '建议 70–80%；想更早腾出空间就调小',
                    'Recommended 70–80%; lower = compacts earlier',
                    '建議 70–80%；想更早騰出空間就調小',
                  )}
                  suffix="%"
                  onChange={(next) => onChange({ compactThreshold: next })}
                />
              </Row>

              <Row
                icon={<BoxIcon className="h-4 w-4" />}
                title={t('压缩保留条数', 'Recent messages kept', '壓縮保留則數')}
                desc={t(
                  '总结时最近几条保持原文。留得多更不容易忘事，也更占空间。',
                  'How many recent messages stay verbatim when older ones are summarized. More keeps context, but uses more space.',
                  '總結時最近幾則保持原文。留得多更不容易忘事，也更佔空間。'
                )}
              >
                <NumberField
                  value={settings.compactKeepRecent}
                  min={2}
                  max={50}
                  fallback={8}
                  hint={t(
                    '常用 6–10 条：留得越多越不容易忘事，但更占空间',
                    'Usually 6–10; more means less forgetting but more space',
                    '常用 6–10 條：留得越多越不容易忘事',
                    '目安 6〜10 件',
                  )}
                  suffix={t('条', 'items', '則')}
                  onChange={(next) => onChange({ compactKeepRecent: next })}
                />
              </Row>

              <Row
                icon={<WrenchIcon className="h-4 w-4" />}
                title={t('单轮最大工具调用次数', 'Max tool calls per turn', '單輪最大工具呼叫次數')}
                desc={t(
                  '一轮回答里模型最多连续调用多少次工具。填 0 = 不限（一直干到它自己做完），适合长任务；不确定就先用默认值。',
                  'How many tool calls the model may chain in one turn. 0 = unlimited (it keeps going until the task is done).',
                  '一輪回答裡模型最多連續呼叫多少次工具。填 0 = 不限（一直做到它自己完成）。',
                )}
              >
                <NumberField
                  value={settings.maxIterations}
                  min={0}
                  step={10}
                  fallback={0}
                  hint={t(
                    '填 0 = 不限次数；常用 30–100',
                    '0 = unlimited; 30–100 is typical',
                    '填 0 = 不限次數；常用 30–100',
                    '0 = 無制限（目安 30〜100）',
                  )}
                  suffix={settings.maxIterations > 0 ? t('次', 'calls', '次') : t('不限', 'unlimited', '不限')}
                  onChange={(next) => onChange({ maxIterations: next })}
                />
              </Row>

              <Row
                icon={<PermissionsIcon className="h-4 w-4" />}
                title={t('审批等待时长', 'Approval timeout', '審批等待時間')}
                desc={t(
                  '每次要你确认的操作，等这么多秒还没答复就自动拒绝。填 0 = 不限（一直等你）。',
                  'An approval left unanswered for this many seconds is auto-rejected. 0 = no limit (it waits for you).',
                  '每次要你確認的操作，等這麼多秒還沒回覆就自動拒絕。填 0 = 不限（一直等你）。',
                )}
              >
                <NumberField
                  value={settings.approvalTimeout}
                  min={0}
                  step={30}
                  fallback={0}
                  hint={t(
                    '填 0 = 一直等你，不自动拒绝',
                    '0 = wait forever, never auto-reject',
                    '填 0 = 一直等你，不自動拒絕',
                  )}
                  suffix={settings.approvalTimeout > 0 ? t('秒', 's', '秒', '秒') : t('不限', 'off', '不限')}
                  onChange={(next) => onChange({ approvalTimeout: next })}
                />
              </Row>

              <div className="mt-6">
                <div className="mb-1 text-sm font-medium text-neutral-200">
                  {t('重复内容检测', 'Repetition guard', '重複內容偵測')}
                </div>
                <p className="mb-2 text-xs text-neutral-500">
                  {t(
                    '模型偶尔会「卡带」：同一句话、同一段代码一直重复吐，直到把额度烧完。开启后会在流式过程中盯着输出，连续重复到阈值就自动停下，并告诉你为什么停。',
                    'Models sometimes get stuck repeating the same sentence or block. When this is on, the stream is watched and the turn stops with a clear reason once the repeat threshold is hit.',
                    '模型偶爾會「跳針」：同一句話、同一段程式一直重複。開啟後會在串流中盯著輸出，連續重複到門檻就自動停下並說明原因。',
                  )}
                </p>

                <Row
                  icon={<RepeatIcon className="h-4 w-4" />}
                  title={t('启用重复内容检测', 'Enable repetition guard', '啟用重複內容偵測')}
                  desc={t(
                    '关掉后不再自动停止（模型重复输出也不会被打断）。',
                    'Turn off to let the model keep repeating without being stopped.',
                    '關掉後不再自動停止。',
                  )}
                >
                  <Toggle
                    value={settings.repeatDetect}
                    onChange={(next) => onChange({ repeatDetect: next })}
                  />
                </Row>

                <Row
                  icon={<SearchIcon className="h-4 w-4" />}
                  title={t('检测范围', 'Check scope', '偵測範圍', '検出範囲')}
                  desc={t(
                    '看哪些输出：回答正文 / 思考过程 / 全部（连工具参数一起看）。',
                    'Which output to watch: the reply, the reasoning, or everything (including tool arguments).',
                    '看哪些輸出：回答正文 / 思考過程 / 全部（含工具參數）。',
                  )}
                >
                  <Select<RepeatScope>
                    value={settings.repeatScope}
                    options={[
                      { value: 'all', label: t('全部（正文 + 思考 + 工具参数）', 'Everything', '全部（正文 + 思考 + 工具參數）') },
                      { value: 'both', label: t('正文 + 思考', 'Reply + reasoning', '正文 + 思考', '回答 + 思考') },
                      { value: 'text', label: t('只看回答正文', 'Reply only', '只看回答正文') },
                      { value: 'reasoning', label: t('只看思考过程', 'Reasoning only', '只看思考過程') },
                    ]}
                    onChange={(next) => onChange({ repeatScope: next })}
                  />
                </Row>

                <Row
                  icon={<AlertIcon className="h-4 w-4" />}
                  title={t('重复阈值', 'Repeat threshold', '重複門檻')}
                  desc={t(
                    '同一段内容连续出现几次就算异常。越小越灵敏，也越容易误判。',
                    'How many times the same passage may repeat in a row before it counts as a loop. Smaller = more sensitive.',
                    '同一段內容連續出現幾次就算異常。越小越靈敏，也越容易誤判。',
                  )}
                >
                  <NumberField
                    value={settings.repeatThreshold}
                    min={2}
                    max={10}
                    fallback={3}
                    hint={t('建议 3；区间 2–10', 'Recommended 3 (2–10)', '建議 3；區間 2–10', '推奨 3（2〜10）')}
                    suffix={t('次', 'times', '次', '回')}
                    onChange={(next) => onChange({ repeatThreshold: next })}
                  />
                </Row>

                <Row
                  icon={<BoxIcon className="h-4 w-4" />}
                  title={t('最小重复单元', 'Minimum repeated unit', '最小重複單元')}
                  desc={t(
                    '多长的一段才算「一段内容」（太短的不算，免得把标点、缩进当成卡带）。',
                    'How long a passage must be to count (short bits like punctuation or indentation are ignored).',
                    '多長的一段才算「一段內容」（太短的不算，避免標點、縮排被誤判）。',
                  )}
                >
                  <NumberField
                    value={settings.repeatMinUnit}
                    min={8}
                    max={400}
                    step={8}
                    fallback={24}
                    hint={t('建议 20–40 字；区间 8–400', 'Recommended 20–40 (8–400)', '建議 20–40 字；區間 8–400', '推奨 20〜40（8〜400）')}
                    suffix={t('字', 'chars', '字', '文字')}
                    onChange={(next) => onChange({ repeatMinUnit: next })}
                  />
                </Row>
              </div>

              <div className="mt-6">
                <div className="mb-1 text-sm font-medium text-neutral-200">
                  {t('采样参数', 'Sampling', '取樣參數')}
                </div>
                <p className="mb-2 text-xs text-neutral-500">
                  {t(
                    '留空即使用接口默认值。不同模型对取值范围的容忍度不同，改动前建议先用默认值。',
                    'Leave blank to use the provider default. Models differ in the range they accept, so try the defaults first.',
                    '留空即使用介面預設值。不同模型對取值範圍的容忍度不同，改動前建議先用預設值。',
                  )}
                </p>

                <Row
                  icon={<BoxIcon className="h-4 w-4" />}
                  title={t('温度 temperature', 'Temperature', '溫度 temperature', '温度 temperature')}
                  desc={t(
                    '回答的随机程度：越低越稳，越高越有创意。留空 = 服务商默认值。',
                    'How varied the answers are: lower is steadier, higher is more creative. Blank = provider default.',
                    '回答的隨機程度：越低越穩，越高越有創意。留空 = 服務商預設值。'
                  )}
                >
                  <OptionalNumber
                    value={settings.temperature}
                    onChange={(next) => onChange({ temperature: next })}
                    min={0}
                    max={2}
                    step={0.1}
                  />
                </Row>

                <Row
                  icon={<BoxIcon className="h-4 w-4" />}
                  title={t('核采样 top_p', 'Top-p', '核取樣 top_p', 'Top-p')}
                  desc={t(
                    '和「温度」二选一调整即可。留空 = 默认值。',
                    'Adjust either this or Temperature, not both. Blank = default.',
                    '和「溫度」二選一調整即可。留空 = 預設值。'
                  )}
                >
                  <OptionalNumber
                    value={settings.topP}
                    onChange={(next) => onChange({ topP: next })}
                    min={0}
                    max={1}
                    step={0.05}
                  />
                </Row>

                <Row
                  icon={<BoxIcon className="h-4 w-4" />}
                  title={t('最大输出 token', 'Max output tokens', '最大輸出 token')}
                  desc={t(
                    '一条回复的最大长度。留空 = 服务商默认值。',
                    'The longest a single reply may be. Blank = provider default.',
                    '一則回覆的最大長度。留空 = 服務商預設值。'
                  )}
                >
                  <OptionalNumber
                    value={settings.maxTokens}
                    onChange={(next) => onChange({ maxTokens: next })}
                    min={1}
                    step={256}
                  />
                </Row>

                <Row
                  icon={<LightbulbIcon className="h-4 w-4" />}
                  title={t('思考强度', 'Reasoning effort', '思考強度')}
                  desc={t(
                    REASONING_EFFORT_HINT[settings.reasoningEffort],
                    settings.reasoningEffort === 'off'
                      ? 'Do not send any reasoning parameter; use the model default.'
                      : `Effort: ${REASONING_EFFORT_LABEL[settings.reasoningEffort]}. Higher costs more and is slower.`,
                    '不送出思考參數，交給模型預設行為。',
                  )}
                >
                  <Select<ReasoningEffort>
                    value={settings.reasoningEffort}
                    options={(['off', 'low', 'medium', 'high'] as ReasoningEffort[]).map(
                      (effort) => ({ value: effort, label: REASONING_EFFORT_LABEL[effort] }),
                    )}
                    onChange={(next) => onChange({ reasoningEffort: next })}
                  />
                </Row>
              </div>

              <div className="mt-6">
                <div className="mb-1 text-sm font-medium text-neutral-200">
                  {t('联网', 'Web access', '聯網')}
                </div>
                <p className="mb-2 text-xs leading-relaxed text-neutral-500">
                  {t(
                    '搜索和抓网页都由「本机执行器」发起：请求从你本机发出，不经过 Cloudflare 数据中心，也能走下面这个代理。',
                    'Search and page fetching are both made by the local executor: requests leave from your own machine (not Cloudflare) and can use the proxy below.',
                    '搜尋和抓網頁都由「本機執行器」發起：請求從你本機發出，不經過 Cloudflare 資料中心，也能走下面這個代理。',
                  )}
                </p>

                <Row
                  icon={<SearchIcon className="h-4 w-4" />}
                  title={t('默认搜索源', 'Default search engine', '預設搜尋來源')}
                  desc={t(
                    '搜索默认用哪个引擎；「自动」由程序挑。需要本机执行器。',
                    'Default search engine. "Auto" picks one for you. Requires the local companion.',
                    '搜尋預設用哪個引擎；「自動」由程式挑。需要本機執行器。'
                  )}
                >
                  <Select<WebSearchEngine>
                    value={settings.webSearchEngine}
                    options={[
                      {
                        value: 'auto' as const,
                        label: t(
                          '自动（Bing → DuckDuckGo）',
                          'Auto (Bing → DuckDuckGo)',
                          '自動（Bing → DuckDuckGo）',
                        ),
                      },
                      { value: 'bing' as const, label: 'Bing' },
                      { value: 'duckduckgo' as const, label: 'DuckDuckGo' },
                    ]}
                    onChange={(next) => onChange({ webSearchEngine: next })}
                  />
                </Row>

                <Row
                  icon={<TerminalIcon className="h-4 w-4" />}
                  title={t('代理', 'Proxy', '代理')}
                  desc={t(
                    '搜索与抓网页走本机代理（例如 Clash 的 127.0.0.1:7897）。留空 = 直连。',
                    'Route search and page fetches through a proxy on this machine (e.g. Clash at 127.0.0.1:7897). Blank = direct.',
                    '搜尋與抓網頁走本機代理（例如 Clash 的 127.0.0.1:7897）。留空 = 直連。'
                  )}
                >
                  <div className={W_NUM}>
                    <input
                      value={settings.proxy}
                      placeholder="http://127.0.0.1:7897"
                      spellCheck={false}
                      onChange={(e) => onChange({ proxy: e.target.value })}
                      className={inputClass + ' font-mono'}
                    />
                  </div>
                </Row>
              </div>
            </>
          )}

          {section === 'appearance' && (
            <>
              <GroupTitle
                title={t('外观与交互', 'Appearance', '外觀與互動')}
                desc={t(
                  '主题与消息流的展示方式。',
                  'Theme and how the conversation is displayed.',
                  '主題與訊息流的顯示方式。',
                )}
              />

              <Row
                icon={<LightbulbIcon className="h-4 w-4" />}
                title={t('主题', 'Theme', '主題')}
                desc={t(
                  '切换后立即生效，随设置保存在本机浏览器。OreUI 是《我的世界》基岩版的界面风格（方角、凿边按钮 + 原版绿）。',
                  'Applies immediately and is saved in this browser. OreUI is the Minecraft Bedrock UI style (square corners, bevelled controls, vanilla green).',
                  '切換後立即生效，隨設定存在本機瀏覽器。OreUI 是《我的世界》基岩版的介面風格（方角、鑿邊按鈕 + 原版綠）。',
                )}
              >
                <Select<ThemeMode>
                  value={settings.theme}
                  options={[
                    { value: 'dark', label: t('默认', 'Default', '預設') },
                    { value: 'light', label: t('浅色', 'Light', '淺色') },
                    { value: 'aurora', label: t('极光', 'Aurora', '極光') },
                    {
                      value: 'oreui',
                      label: t('OreUI（我的世界）', 'OreUI (Minecraft)', 'OreUI（我的世界）'),
                    },
                  ]}
                  onChange={(next) => onChange({ theme: next })}
                />
              </Row>

              <Row
                icon={<BoxIcon className="h-4 w-4" />}
                title={t('颜色', 'Color', '顏色')}
                desc={t(
                  '界面强调色。「默认」用主题自带配色。',
                  'Accent color. "Default" keeps the theme palette.',
                  '介面強調色。「預設」用主題自帶配色。'
                )}
              >
                <Select<ColorMode>
                  value={settings.color}
                  options={[
                    { value: 'default', label: t('默认', 'Default', '預設') },
                    { value: 'amber', label: t('琥珀', 'Amber', '琥珀') },
                    { value: 'blue', label: t('蓝', 'Blue', '藍') },
                    { value: 'cyan', label: t('青', 'Cyan', '青') },
                    { value: 'emerald', label: t('绿', 'Green', '綠') },
                    { value: 'violet', label: t('紫', 'Violet', '紫') },
                    { value: 'rose', label: t('玫红', 'Rose', '玫紅') },
                  ]}
                  onChange={(next) => onChange({ color: next })}
                />
              </Row>

              <Row
                icon={<PanelRightIcon className="h-4 w-4" />}
                title={t('悬浮窗', 'Floating window', '懸浮窗')}
                desc={t(
                  '一个置顶小窗：随时看模型的状态 / 决定 / 思考 / 回答，也能在里面审批和插话。需要 Chrome / Edge 116 以上；关掉小窗会自动把这个开关关掉。',
                  'An always-on-top mini window showing the model’s status, decision, thinking and answer — you can also approve and say things from it. Needs Chrome / Edge 116+; closing the mini window turns this off.',
                  '一個置頂小窗：隨時看模型的狀態 / 決定 / 思考 / 回答，也能在裡面審批和插話。需要 Chrome / Edge 116 以上；關掉小窗會自動把這個開關關掉。',
                )}
              >
                <Toggle
                  value={settings.floatingWindow}
                  onChange={(next) => onChange({ floatingWindow: next })}
                />
              </Row>

              <Row
                icon={<WrenchIcon className="h-4 w-4" />}
                title={t('思考过程默认展开', 'Expand reasoning by default', '思考過程預設展開')}
                desc={t(
                  '开启后，模型返回的思考内容默认展开；关闭则折叠成一行，点击再展开。',
                  'When on, the model’s reasoning is expanded; when off it collapses to one line you can click.',
                  '開啟後，模型回傳的思考內容預設展開；關閉則收合成一行，點擊再展開。',
                )}
              >
                <Toggle
                  value={settings.reasoningExpanded}
                  onChange={(next) => onChange({ reasoningExpanded: next })}
                />
              </Row>

              <Row
                icon={<LightbulbIcon className="h-4 w-4" />}
                title={t('语言', 'Language', '語言')}
                desc={
                  t('界面语言，立即生效。', 'Interface language, applied immediately.', '介面語言，立即生效。') +
                  (settings.language === 'jp'
                    ? t(
                        '日本語暂不支持，界面显示为简体中文。',
                        ' Japanese is not supported yet — the interface stays in Simplified Chinese.',
                        '日本語暫不支援，介面顯示為簡體中文。',
                      )
                    : '')
                }
              >
                <Select<Lang>
                  value={settings.language}
                  options={LANGS.map((item) => ({
                    value: item.value,
                    label:
                      item.value === 'jp'
                        ? `${item.label} · ${t('不受支持', 'unsupported', '不受支援')}`
                        : item.label,
                  }))}
                  onChange={(next) => onChange({ language: next })}
                />
              </Row>

              <Row
                icon={<PanelRightIcon className="h-4 w-4" />}
                title={t('界面布局', 'Layout', '介面版面')}
                desc={t(
                  '换一种排版：与主题配色互不影响，可以随意搭配。',
                  'A different arrangement of the interface. It is independent of the theme colors, so mix them freely.',
                  '換一種排版：與主題配色互不影響，可以隨意搭配。',
                )}
              >
                <Select<LayoutMode>
                  value={settings.layout}
                  options={[
                    { value: 'classic', label: t('经典三栏', 'Classic 3-column', '經典三欄') },
                    { value: 'workbench', label: t('工作台', 'Workbench', '工作台') },
                  ]}
                  onChange={(next) => onChange({ layout: next })}
                />
              </Row>

              <Row
                icon={<SettingsIcon className="h-4 w-4" />}
                title={t('扁平控件', 'Flat controls', '扁平控制項')}
                desc={
                  t(
                    '隐藏界面上的边框，改由鼠标悬浮时的轻微底色变化来提示。',
                    'Hides borders; hovering gives a subtle background hint instead.',
                    '隱藏介面上的邊框，改用滑鼠移入時的輕微底色變化來提示。',
                  ) +
                  (settings.theme === 'oreui'
                    ? t('（OreUI 主题下不可用）', ' (not available in the OreUI theme)', '（OreUI 主題下不可用）')
                    : '')
                }
              >
                <Toggle
                  value={settings.flatBorders}
                  disabled={settings.theme === 'oreui'}
                  onChange={(next) => onChange({ flatBorders: next })}
                />
              </Row>

              <Row
                icon={<ClipboardListIcon className="h-4 w-4" />}
                title={t('过程显示', 'Process display', '過程顯示')}
                desc={t(
                  '运行时显示多少过程：全部 / 紧凑（收成一行摘要）/ 只显示最终回答。',
                  'How much of the process to show: all / compact (one-line summary) / final answer only.',
                  '執行時顯示多少過程：全部 / 緊湊（收成一行摘要）/ 只顯示最終回答。'
                )}
              >
                <Select<ActivityMode>
                  value={settings.activityMode}
                  options={[
                    { value: 'default', label: t('默认', 'Default', '預設') },
                    { value: 'compact', label: t('紧凑', 'Compact', '緊湊') },
                    { value: 'result', label: t('结果', 'Result', '結果', '結果') },
                  ]}
                  onChange={(next) => onChange({ activityMode: next })}
                />
              </Row>
            </>
          )}

          {section === 'statusbar' && (
            <>
              <GroupTitle
                title={t('状态栏', 'Status bar', '狀態欄')}
                desc={t(
                  '底部那条横栏显示什么；经典三栏和 workbench 布局都会有，也可以整个关掉。',
                  'What the bottom strip shows. It appears in both the classic and workbench layouts, and can be turned off entirely.',
                  '底部那條橫欄顯示什麼；經典三欄與 workbench 版型都會有，也可以整個關掉。',
                )}
              />

              <Row
                icon={<PanelRightIcon className="h-4 w-4" />}
                title={t('显示状态栏', 'Show status bar', '顯示狀態欄')}
                desc={t(
                  '关掉就不再显示底部这条横栏（两套布局都不显示）。',
                  'Turn it off to hide the bottom strip in both layouts.',
                  '關掉就不再顯示底部這條橫欄（兩套版型都不顯示）。',
                )}
              >
                <Toggle
                  value={settings.statusBar}
                  onChange={(next) => onChange({ statusBar: next })}
                />
              </Row>

              <Row
                icon={<PanelRightIcon className="h-4 w-4" />}
                title={t('显示文字', 'Show text', '顯示文字')}
                desc={t(
                  '打开后状态栏显示「文字 + 图标」，更好辨认；关掉则只显示图标，更省地方。',
                  'When on, each status-bar item shows text + icon for readability; turn it off to show icons only and save space.',
                  '打開後狀態欄顯示「文字 + 圖示」，更好辨認；關掉則只顯示圖示，更省空間。',
                )}
              >
                <Toggle
                  value={settings.statusStyle === 'text'}
                  onChange={(next) => onChange({ statusStyle: next ? 'text' : 'icon' })}
                />
              </Row>

              <div className="mt-6">
                <div className="mb-1 text-sm font-medium text-neutral-100">
                  {t('显示哪些项', 'Which items to show', '顯示哪些項目')}
                </div>
                <p className="mb-3 text-xs leading-relaxed text-neutral-500">
                  {t(
                    '勾选想要的项；不勾就完全不显示。算不出值的项（比如还没请求过模型时的缓存命中）会自动隐藏。',
                    'Tick what you want. Items with no value yet (e.g. cache hit before any request) hide themselves automatically.',
                    '勾選想要的項目；不勾就完全不顯示。算不出值的項目（例如還沒請求過模型時的快取命中）會自動隱藏。',
                  )}
                </p>
                <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
                  {[
                    {
                      key: 'off',
                      title: t('未显示', 'Hidden', '未顯示'),
                      ids: STATUS_ITEM_IDS.filter((id) => !settings.statusItems.includes(id)),
                    },
                    {
                      key: 'on',
                      title: t('已显示', 'Shown', '已顯示'),
                      ids: STATUS_ITEM_IDS.filter((id) => settings.statusItems.includes(id)),
                    },
                  ].map((column) => (
                    <div key={column.key}>
                      <div className="mb-1.5 text-xs text-neutral-500">
                        {column.title}
                        <span className="ml-1 text-neutral-600">· {column.ids.length}</span>
                      </div>
                      {column.ids.length === 0 ? (
                        <p className="px-2.5 py-1.5 text-xs text-neutral-600">
                          {t('（无）', '(none)', '（無）')}
                        </p>
                      ) : (
                        <div className="flex flex-col gap-1.5">
                          {column.ids.map((id) => {
                            const on = column.key === 'on'
                            return (
                              <button key={id}
                                type="button"
                                onClick={() =>
                                  onChange({
                                    statusItems: on
                                      ? settings.statusItems.filter((item) => item !== id)
                                      : STATUS_ITEM_IDS.filter(
                                          (item) => item === id || settings.statusItems.includes(item),
                                        ),
                                  })
                                }
                                className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
                                  on
                                    ? 'bg-neutral-800 text-neutral-100'
                                    : 'text-neutral-400 hover:bg-neutral-800/60'
                                }`}
                              >
                                <OreCheckbox checked={on} />
                                <StatusItemIcon
                                  id={id}
                                  className={`h-3.5 w-3.5 shrink-0 ${
                                    on ? 'text-amber-300/70' : 'text-neutral-500'
                                  }`}
                                />
                                <span className="truncate">{t(STATUS_ITEM_LABEL[id])}</span>
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {section === 'voice' && (
            <>
              <GroupTitle
                title={t('语音', 'Voice', '語音')}
                desc={t(
                  '语音输入与朗读。',
                  'Voice input and read-aloud.',
                  '語音輸入與朗讀。'
                )}
              />

              <Row
                icon={<MessageSquareIcon className="h-4 w-4" />}
                title={t('语音输入', 'Voice input', '語音輸入')}
                desc={
                  t(
                    '输入框旁显示麦克风：点一下开始，再点一下结束。',
                    'Shows a microphone next to the input box: tap to start, tap again to stop.',
                    '輸入框旁顯示麥克風：點一下開始，再點一下結束。',
                  ) +
                  (canRecognize()
                    ? ''
                    : t(
                        '（这个浏览器不支持，Chrome / Edge 上可用）',
                        ' (not supported in this browser — works in Chrome / Edge)',
                        '（這個瀏覽器不支援，Chrome / Edge 上可用）',
                      ))
                }
              >
                <Toggle
                  value={settings.voiceInput && canRecognize()}
                  disabled={!canRecognize()}
                  onChange={(next) => onChange({ voiceInput: next })}
                />
              </Row>

              <Row
                icon={<VolumeIcon className="h-4 w-4" />}
                title={t('朗读回答', 'Read replies aloud', '朗讀回答')}
                desc={
                  t(
                    '每条回答下方显示小喇叭：点一下朗读，再点一下停止。',
                    'Shows a speaker under each reply: tap to read, tap again to stop.',
                    '每則回答下方顯示小喇叭：點一下朗讀，再點一下停止。',
                  ) + (canSpeak() ? '' : t('（这个浏览器不支持朗读）', ' (speech synthesis is unavailable here)', '（這個瀏覽器不支援朗讀）'))
                }
              >
                <Toggle
                  value={settings.voiceOutput && canSpeak()}
                  disabled={!canSpeak()}
                  onChange={(next) => onChange({ voiceOutput: next })}
                />
              </Row>

              <Row
                icon={<VolumeIcon className="h-4 w-4" />}
                title={t('自动朗读新回答', 'Auto-read new replies', '自動朗讀新回答')}
                desc={t(
                  '默认关闭；打开后自动朗读每轮的最终回答。',
                  'Off by default; when on, each final reply is read out.',
                  '預設關閉；打開後自動朗讀每輪的最終回答。'
                )}
              >
                <Toggle
                  value={settings.voiceAutoRead}
                  disabled={!settings.voiceOutput || !canSpeak()}
                  onChange={(next) => onChange({ voiceAutoRead: next })}
                />
              </Row>

              <Row
                icon={<GaugeIcon className="h-4 w-4" />}
                title={t('朗读速度', 'Speech rate', '朗讀速度')}
                desc={t(
                  '1 倍为正常语速。',
                  '1× is normal speed.',
                  '1 倍為正常語速。'
                )}
              >
                <NumberField
                  value={settings.voiceRate}
                  min={0.5}
                  max={2}
                  step={0.1}
                  fallback={1}
                  hint={t('0.5–2 倍，默认 1 倍', '0.5×–2×, default 1×', '0.5–2 倍，預設 1 倍')}
                  suffix={t('倍', '×', '倍')}
                  onChange={(next) => onChange({ voiceRate: next })}
                />
              </Row>

              <Row
                icon={<SparklesIcon className="h-4 w-4" />}
                title={t('朗读音色', 'Voice', '朗讀音色')}
                desc={t(
                  '「自动」按回答文字的语言选音色。',
                  '"Automatic" follows the language of the reply.',
                  '「自動」按回答文字的語言選音色。'
                )}
              >
                <Select
                  value={settings.voiceName}
                  placeholder={t('自动', 'Automatic', '自動')}
                  options={[
                    { value: '', label: t('自动', 'Automatic', '自動') },
                    ...voices
                      .map((voice) => ({
                        value: voice.name,
                        label: `${voice.name} · ${voice.lang} · ${
                          voice.localService ? t('本地', 'On-device', '本機') : t('在线', 'Online', '線上')
                        }`,
                        keywords: `${voice.name} ${voice.lang} ${
                          voice.localService ? '本地 offline' : '在线 online'
                        }`,
                        group: voiceGroupOf(voice),
                      }))
                      .filter(
                        (option, index, all) =>
                          all.findIndex((other) => other.value === option.value) === index
                      )
                      .sort((a, b) => {
                        if (a.value === '') return -1
                        if (b.value === '') return 1
                        const byGroup = (a.group ?? '').localeCompare(b.group ?? '')
                        return byGroup !== 0 ? byGroup : a.label.localeCompare(b.label)
                      }),
                  ]}
                  searchable
                  onChange={(next) => onChange({ voiceName: next })}
                />
              </Row>

              <Row
                icon={<GridIcon className="h-4 w-4" />}
                title={t('音色分组方式', 'Group voices by', '音色分組方式')}
                desc={t(
                  '音色列表的分类方式。',
                  'How the voice list is grouped.',
                  '音色清單的分類方式。'
                )}
              >
                <Select<VoiceGroup>
                  value={settings.voiceGroup}
                  options={[
                    { value: 'language', label: t('按语言', 'By language', '按語言') },
                    { value: 'online', label: t('按在线 / 本地', 'By online / on-device', '按線上 / 本機') },
                    { value: 'name', label: t('按音色名', 'By voice name', '按音色名') },
                  ]}
                  onChange={(next) => onChange({ voiceGroup: next })}
                />
              </Row>
            </>
          )}

          {section === 'sound' && (
            <>
              <GroupTitle
                title={t('提示音', 'Sounds', '提示音', '通知音')}
                desc={t(
                  '为不同事件分别选择提示音，可随时试听或关闭。',
                  'Pick a sound for each event; preview or turn them off any time.',
                  '為不同事件分別選擇提示音，可隨時試聽或關閉。',
                )}
              />

              <Row
                icon={<VolumeIcon className="h-4 w-4" />}
                title={t('启用提示音', 'Enable sounds', '啟用提示音')}
                desc={t('关闭后所有事件都不再响。', 'When off, no event plays a sound.', '關閉後所有事件都不再響。')}
              >
                <Toggle
                  value={settings.soundEnabled}
                  onChange={(next) => onChange({ soundEnabled: next })}
                />
              </Row>

              <Row
                icon={<VolumeIcon className="h-4 w-4" />}
                title={t('音量', 'Volume', '音量', '音量')}
                desc={t('对所有提示音生效。', 'Applies to every sound.', '對所有提示音生效。')}
              >
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(settings.soundVolume * 100)}
                    onChange={(e) => onChange({ soundVolume: Number(e.target.value) / 100 })}
                    className="w-40 accent-amber-500"
                  />
                  <span className="w-10 text-right text-xs tabular-nums text-neutral-500">
                    {Math.round(settings.soundVolume * 100)}%
                  </span>
                </div>
              </Row>

              <div className="mt-6">
                <div className="mb-1 text-sm font-medium text-neutral-200">
                  {t('按事件设置', 'Per event', '依事件設定')}
                </div>
                <p className="mb-2 text-xs text-neutral-500">
                  {t('选择「无」即该事件不响。', 'Choose "None" to keep an event silent.', '選擇「無」即該事件不響。')}
                </p>

                {SOUND_EVENTS.map((event) => (
                  <Row
                    key={event.id}
                    icon={<VolumeIcon className="h-4 w-4" />}
                    title={soundEventLabel(event.id)}
                    desc={soundEventHint(event.id)}
                  >
                    <div className="flex items-center gap-2">
                      <Select
                        value={settings.sounds[event.id]}
                        options={SOUND_IDS.map((id) => ({ value: id, label: soundLabel(id) }))}
                        onChange={(next) =>
                          onChange({
                            sounds: { ...settings.sounds, [event.id]: next as SoundId },
                          })
                        }
                      />
                      <Tooltip label={t('试听', 'Preview', '試聽', '試聴')}>
                        <OreButton status="normal"
                          onClick={() =>
                            playSound(settings.sounds[event.id], settings.soundVolume || 0.6)
                          }
                          disabled={settings.sounds[event.id] === 'none'}
                          aria-label={t('试听', 'Preview', '試聽', '試聴')}
                          className="rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-300 transition-colors hover:border-amber-600 hover:text-amber-200 disabled:opacity-40"
                        >
                          {t('试听', 'Preview', '試聽', '試聴')}
                        </OreButton>
                      </Tooltip>
                    </div>
                  </Row>
                ))}
              </div>
            </>
          )}

          {section === 'music' && (
            <>
              <GroupTitle
                title={t('音乐', 'Music', '音樂')}
                desc={t(
                  '右侧「音乐」面板的设置。所有请求都经本机执行器发出 —— 没连 companion 时面板不可用。',
                  'Settings for the Music panel on the right. All requests go through the local executor — the panel is unavailable without the companion.',
                  '右側「音樂」面板的設定。所有請求都經本機執行器發出 —— 沒連 companion 時面板不可用。',
                )}
              />

              <Row
                icon={<HeartIcon className="h-4 w-4" />}
                title={t('音乐源', 'Music source', '音樂來源')}
                desc={t(
                  '搜索用哪些音乐来源；「自动」会合并多个来源。',
                  'Which music sources to search. "Auto" merges several of them.',
                  '搜尋用哪些音樂來源；「自動」會合併多個來源。'
                )}
              >
                <Select<string>
                  value={settings.musicSource}
                  options={[
                    { value: 'auto', label: t('自动（joox + netease）', 'Auto (joox + netease)', '自動（joox + netease）') },
                    { value: 'joox', label: 'JOOX' },
                    { value: 'netease', label: 'NetEase' },
                    { value: 'tencent', label: 'QQ Music' },
                    { value: 'kuwo', label: 'Kuwo' },
                    { value: 'bilibili', label: 'Bilibili' },
                  ]}
                  onChange={(next) => onChange({ musicSource: next })}
                />
              </Row>

              <Row
                icon={<SearchIcon className="h-4 w-4" />}
                title={t('API 地址', 'API base URL', 'API 位址')}
                desc={t(
                  '留空 = 内置接口，也可以填自建地址。',
                  'Blank = built-in API; you can also point it at your own.',
                  '留空 = 內建介面，也可以填自建位址。'
                )}
              >
                <div className={W_CTRL}>
                  <input
                    value={settings.musicBase}
                    placeholder="https://music-api.gdstudio.xyz/api.php"
                    spellCheck={false}
                    onChange={(e) => onChange({ musicBase: e.target.value })}
                    className={inputClass + ' font-mono'}
                  />
                </div>
              </Row>

              <Row
                icon={<DownloadIcon className="h-4 w-4" />}
                title={t('音质', 'Audio quality', '音質')}
                desc={t(
                  '优先请求的音质，实际以音源为准（740 = 无损，999 = 更高解析）。',
                  'Preferred quality — the source decides what you actually get (740 = lossless, 999 = hi-res).',
                  '優先請求的音質，實際以音源為準（740 = 無損，999 = 更高解析）。'
                )}
              >
                <Select<string>
                  value={String(settings.musicQuality)}
                  options={[
                    { value: '128', label: '128 kbps' },
                    { value: '192', label: '192 kbps' },
                    { value: '320', label: '320 kbps' },
                    { value: '740', label: '740（无损）' },
                    { value: '999', label: '999（无损）' },
                  ]}
                  onChange={(next) => onChange({ musicQuality: Number(next) })}
                />
              </Row>
            </>
          )}

          {section === 'providers' && (
            <>
              <GroupTitle
                title={t('模型服务', 'Model providers', '模型服務')}
                desc={t(
                  '先添加提供商，再在它下面挂模型。API Key 只存在本机浏览器。',
                  'Add a provider first, then attach models to it. The API key stays in this browser.',
                  '先新增供應商，再在它下面掛模型。API Key 只存在本機瀏覽器。',
                )}
              />

              <Row
                icon={<BoxIcon className="h-4 w-4" />}
                title={t('提供商', 'Provider', '供應商')}
                desc={t(
                  '有 100+ 预设（官方 / 聚合 / 中转 / 本地），可直接搜名字或型号。',
                  '100+ presets (official / aggregator / relay / local) — search by name or model.',
                  '有 100+ 預設（官方 / 聚合 / 中轉 / 本地），可直接搜名稱或型號。',
                )}
              >
                <Select
                  searchable
                  value=""
                  placeholder={t('+ 新增提供商…', '+ Add provider…', '+ 新增供應商…')}
                  options={[
                    { value: '自定义', label: t('自定义', 'Custom', '自訂') },
                    ...PROVIDER_PRESETS.map((preset) => ({
                      value: preset.name,
                      keywords: `${preset.name} ${preset.aliases ?? ''} ${presetGroupLabel(preset.group)} ${preset.baseURL}`,
                      group: presetGroupLabel(preset.group),
                      label: preset.name,
                    })),
                  ]}
                  onChange={(next) => {
                    if (next) addProvider(next)
                  }}
                />
              </Row>

              <div className="flex flex-wrap gap-2 border-b border-neutral-800/60 pb-4">
                {settings.providers.map((p) => (
                  <button key={p.id}
                    onClick={() => selectProvider(p.id)}
                    className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                      p.id === settings.activeProviderId
                        ? 'border-amber-600/60 bg-amber-600/15 text-amber-100'
                        : 'border-neutral-700 text-neutral-400 hover:border-neutral-500'
                    }`}
                  >
                    {p.name}
                    <span className="ml-1.5 text-xs text-neutral-500">{p.models.length}</span>
                  </button>
                ))}
              </div>

              {provider && (
                <>
                  <SubTitle first>
                    {t('连接', 'Connection', '連線', '接続')}
                  </SubTitle>
                  <Row icon={<BoxIcon className="h-4 w-4" />} title={t('名称', 'Name', '名稱', '名前')}>
                    <div className={W_NUM}>
                      <input
                        value={provider.name}
                        onChange={(e) => updateProvider({ name: e.target.value })}
                        className={inputClass}
                      />
                    </div>
                  </Row>

                  <Row
                    icon={<WrenchIcon className="h-4 w-4" />}
                    title={t('接口风格', 'API style', '介面風格', 'API 形式')}
                  >
                    <Select
                      value={provider.apiStyle}
                      options={[
                        { value: 'openai' as const, label: t('OpenAI 兼容', 'OpenAI compatible', 'OpenAI 相容', 'OpenAI 互換') },
                        { value: 'anthropic' as const, label: 'Anthropic' },
                      ]}
                      onChange={(next) => updateProvider({ apiStyle: next })}
                    />
                  </Row>

                  <Row
                    icon={<TerminalIcon className="h-4 w-4" />}
                    title={t('接口地址', 'Base URL', '介面位址')}
                    desc={t(
                      '服务商给的接口地址，一般以 /v1 结尾。',
                      'The API address from your provider, usually ending in /v1.',
                      '服務商給的介面位址，一般以 /v1 結尾。'
                    )}
                  >
                    <div className={W_NUM}>
                      <input
                        value={provider.baseURL}
                        onChange={(e) => updateProvider({ baseURL: e.target.value })}
                        className={inputClass}
                      />
                    </div>
                  </Row>

                  <Row
                    icon={<PermissionsIcon className="h-4 w-4" />}
                    title={t('API Key', 'API key', 'API Key')}
                  >
                    <div className={W_NUM}>
                      <input
                        type="password"
                        value={provider.apiKey}
                        placeholder="sk-..."
                        onChange={(e) => updateProvider({ apiKey: e.target.value })}
                        className={inputClass}
                      />
                    </div>
                  </Row>

                  <Row
                    icon={<CheckCircleIcon className="h-4 w-4" />}
                    title={t('连接测试', 'Connection test', '連線測試')}
                    desc={t(
                      '用当前地址与 Key 请求一次模型列表，只验证连通性。',
                      'Requests the model list once with the current URL and key, just to check connectivity.',
                      '用目前位址與 Key 請求一次模型清單，只驗證連通性。',
                    )}
                  >
                    <OreButton status="normal"
                      onClick={() => void testConnection()}
                      disabled={testing}
                      className="rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-300 transition-colors hover:border-amber-600 hover:text-amber-200 disabled:opacity-50"
                    >
                      {testing
                        ? t('测试中…', 'Testing…', '測試中…')
                        : t('测试连接', 'Test connection', '測試連線')}
                    </OreButton>
                  </Row>
                  <FeedbackLine value={testState} />

                  <SubTitle>{t('模型', 'Models', '模型')}</SubTitle>
                  <Row
                    icon={<BoxIcon className="h-4 w-4" />}
                    title={t('模型列表', 'Model list', '模型清單')}
                    desc={
                      settings.activeModel
                        ? t(
                            `当前使用：${settings.activeModel}`,
                            `In use: ${settings.activeModel}`,
                            `目前使用：${settings.activeModel}`,
                            `使用中: ${settings.activeModel}`,
                          )
                        : t(
                            '从下面选一个，或直接手输模型名',
                            'Pick one below, or type a model name',
                            '從下面選一個，或直接手動輸入模型名',
                          )
                    }
                  >
                    <div className="flex items-center gap-2">
                      <input
                        value={manualModel}
                        placeholder={t('手输模型名', 'Type a model name', '手動輸入模型名')}
                        onChange={(e) => setManualModel(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            addModel(manualModel)
                            setManualModel('')
                          }
                        }}
                        className={inputClass + ' ' + W_CTRL}
                      />
                      <OreButton status="normal"
                        onClick={() => {
                          addModel(manualModel)
                          setManualModel('')
                        }}
                        className="inline-flex items-center gap-1 rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-300 transition-colors hover:border-amber-600 hover:text-amber-200"
                      >
                        <PlusIcon className="h-3.5 w-3.5" />
                        {t('添加', 'Add', '新增', '追加')}
                      </OreButton>
                      <OreButton status="normal"
                        onClick={identify}
                        disabled={loading}
                        className="rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-300 transition-colors hover:border-amber-600 hover:text-amber-200 disabled:opacity-50"
                      >
                        {loading
                          ? t('识别中…', 'Detecting…', '辨識中…', '取得中…')
                          : t('自动识别', 'Detect models', '自動辨識')}
                      </OreButton>
                    </div>
                  </Row>

                  {provider.models.length > 0 && (
                    <div className="border-b border-neutral-800/60 py-4">
                      <div className="mb-2 text-xs text-neutral-500">
                        {t(
                          `已添加 ${provider.models.length} 个模型 · 点星标可设为该提供商的默认模型`,
                          `${provider.models.length} model(s) added · click the star to make one the provider default`,
                          `已新增 ${provider.models.length} 個模型 · 點星號可設為該供應商的預設模型`,
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {provider.models.map((m) => {
                          const isDefault = provider.defaultModel === m.id
                          return (
                            <span
                              key={m.id}
                              className={`inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 font-mono text-xs ${
                                settings.activeModel === m.id
                                  ? 'border-amber-600/60 bg-amber-600/15 text-amber-100'
                                  : 'border-neutral-700 text-neutral-400'
                              }`}
                            >
                              <Tooltip label={m.label ? `${m.label}（${m.id}）` : m.id}>
                                <button onClick={() => onChange({ activeModel: m.id })}>
                                  {m.label ? (
                                    <>
                                      {m.label}
                                      <span className="ml-1 text-[10px] text-neutral-600">{m.id}</span>
                                    </>
                                  ) : (
                                    m.id
                                  )}
                                </button>
                              </Tooltip>
                              <Tooltip
                                label={isDefault ? t('取消默认', 'Unset default', '取消預設') : t('设为默认', 'Set as default', '設為預設')}
                              >
                                <button
                                  onClick={() => toggleDefaultModel(m.id)}
                                  aria-label={isDefault ? t('取消默认', 'Unset default', '取消預設') : t('设为默认', 'Set as default', '設為預設')}
                                  className={isDefault ? 'text-amber-400' : 'text-neutral-600 hover:text-amber-400'}
                                >
                                  {isDefault ? '★' : '☆'}
                                </button>
                              </Tooltip>
                              <Tooltip label={t('重命名显示名', 'Rename display name', '重新命名顯示名')}>
                                <button
                                  onClick={() => renameModel(m.id, m.label)}
                                  aria-label={t('重命名显示名', 'Rename display name', '重新命名顯示名')}
                                  className="text-neutral-600 hover:text-amber-300"
                                >
                                  <PencilIcon className="h-3 w-3" />
                                </button>
                              </Tooltip>
                              <Tooltip label={t('删除模型', 'Remove model', '刪除模型')}>
                                <button
                                  onClick={() => removeModel(m.id)}
                                  aria-label={t('删除模型', 'Remove model', '刪除模型')}
                                  className="text-neutral-600 hover:text-red-400"
                                >
                                  <TrashIcon className="h-3 w-3" />
                                </button>
                              </Tooltip>
                            </span>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {pending.length > 0 && (
                    <div className="border-b border-neutral-800/60 py-4">
                      <div className="mb-2 text-xs text-neutral-500">
                        {t(
                          `识别到 ${pending.length} 个未添加的模型`,
                          `${pending.length} detected model(s) not added yet`,
                          `辨識到 ${pending.length} 個未新增的模型`,
                        )}
                      </div>
                      <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
                        {pending.slice(0, 200).map((m) => (
                          <button
                            key={m.id}
                            onClick={() => addModel(m.id)}
                            className="rounded border border-neutral-700 px-2 py-0.5 font-mono text-xs text-neutral-400 hover:border-amber-600 hover:text-amber-200"
                          >
                            {m.id}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <SubSection
                    title={t('高级设置', 'Advanced', '進階設定', '詳細設定')}
                    desc={t(
                      '自定义请求头、OpenAI 兼容选项。一般不需要改，遇到接口报错再来调。',
                      'Custom headers and OpenAI compatibility options. Usually no need to touch these unless the API errors out.',
                      '自訂請求標頭、OpenAI 相容選項。一般不需要改，遇到介面報錯再來調。',
                    )}
                  >
                  <div className="border-b border-neutral-800/60 py-4">
                    <div className="mb-1 text-sm text-neutral-100">
                      {t('自定义请求头', 'Custom headers', '自訂請求標頭')}
                    </div>
                    <p className="mb-2 text-xs leading-relaxed text-neutral-500">
                      {t(
                        '随该提供商的每次请求发送，适用于需要额外鉴权头或走私有网关的情况。',
                        'Sent with every request to this provider — useful for extra auth headers or a private gateway.',
                        '隨該供應商的每次請求送出，適用於需要額外驗證標頭或走私有閘道的情況。',
                      )}
                    </p>
                    {headers.length === 0 && (
                      <p className="mb-2 text-xs text-neutral-600">
                        {t('还没有自定义请求头。', 'No custom headers yet.', '還沒有自訂請求標頭。')}
                      </p>
                    )}
                    <div className="space-y-2">
                      {headers.map((header, index) => (
                        <div key={index} className="flex items-center gap-2">
                          <input
                            value={header.key}
                            placeholder={t('Header 名，如 X-Api-Version', 'Header name, e.g. X-Api-Version', '標頭名稱，如 X-Api-Version')}
                            onChange={(e) => updateHeader(index, { key: e.target.value })}
                            className={inputClass + ' ' + W_CTRL + ' font-mono text-xs'}
                          />
                          <input
                            value={header.value}
                            placeholder={t('值', 'Value', '值', '値')}
                            onChange={(e) => updateHeader(index, { value: e.target.value })}
                            className={inputClass + ' ' + W_CTRL + ' font-mono text-xs'}
                          />
                          <button
                            onClick={() => removeHeader(index)}
                            className="text-neutral-600 hover:text-red-400"
                          >
                            <TrashIcon className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                    <OreButton status="normal"
                      onClick={addHeader}
                      className="mt-2 inline-flex items-center gap-1 rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-300 hover:border-amber-600 hover:text-amber-200"
                    >
                      <PlusIcon className="h-3.5 w-3.5" />
                      {t('添加请求头', 'Add header', '新增標頭')}
                    </OreButton>
                  </div>

                  {/* OpenAI 兼容的细节开关：不同厂商实现不一样，按需勾 */}
                  <div className="py-4">
                    <div className="mb-1 text-sm text-neutral-100">
                      {t('OpenAI 兼容选项', 'OpenAI compatibility', 'OpenAI 相容選項')}
                    </div>
                    <p className="mb-3 text-xs leading-relaxed text-neutral-500">
                      {t(
                        '各家「OpenAI 兼容」的具体实现有差异，这里按需调整。默认值能覆盖大多数服务。',
                        '“OpenAI-compatible” implementations differ; adjust as needed. Defaults work for most services.',
                        '各家「OpenAI 相容」的實作有差異，這裡按需調整。預設值能涵蓋大多數服務。',
                      )}
                    </p>

                    <div className="space-y-3">
                      <Row
                        icon={<BoxIcon className="h-4 w-4" />}
                        title={t('最大 token 字段名', 'Max-token field', '最大 token 欄位')}
                        desc={t(
                          '高级项：新版 OpenAI 推理模型用 max_completion_tokens，其他多为 max_tokens。不确定就别改。',
                          'Advanced: newer OpenAI reasoning models use max_completion_tokens; most others use max_tokens.',
                          '進階項：新版 OpenAI 推理模型用 max_completion_tokens，其他多為 max_tokens。不確定就別改。'
                        )}
                      >
                        <Select<'max_tokens' | 'max_completion_tokens'>
                          value={provider.maxTokensParam ?? 'max_tokens'}
                          options={[
                            { value: 'max_tokens', label: 'max_tokens' },
                            { value: 'max_completion_tokens', label: 'max_completion_tokens' },
                          ]}
                          onChange={(next) => updateProvider({ maxTokensParam: next })}
                        />
                      </Row>

                      <Row
                        icon={<BoxIcon className="h-4 w-4" />}
                        title={t('系统提示词角色', 'System role', '系統提示詞角色')}
                        desc={t(
                          '高级项：老接口用 system，新接口用 developer。不确定就别改。',
                          'Advanced: older APIs use system, newer ones use developer.',
                          '進階項：老介面用 system，新介面用 developer。不確定就別改。'
                        )}
                      >
                        <Select<'system' | 'developer'>
                          value={provider.systemRole ?? 'system'}
                          options={[
                            { value: 'system', label: 'system' },
                            { value: 'developer', label: 'developer' },
                          ]}
                          onChange={(next) => updateProvider({ systemRole: next })}
                        />
                      </Row>

                      <Row
                        icon={<BoxIcon className="h-4 w-4" />}
                        title={t('请求流式返回 usage', 'Request usage in stream', '請求串流回傳 usage')}
                        desc={t(
                          '高级项：关掉后不再请求用量统计。第三方中转报错时再关。',
                          'Advanced: stop requesting usage stats. Only turn this off if a relay rejects it.',
                          '進階項：關掉後不再請求用量統計。第三方中轉報錯時再關。'
                        )}
                      >
                        <Toggle
                          value={provider.streamUsage !== false}
                          onChange={(next) => updateProvider({ streamUsage: next })}
                        />
                      </Row>

                      <Row
                        icon={<BoxIcon className="h-4 w-4" />}
                        title={t('发送采样参数', 'Send sampling params', '送出取樣參數')}
                        desc={t(
                          '高级项：关掉后不发送温度 / top_p。推理模型报错时再关。',
                          'Advanced: stop sending temperature / top_p. Only turn this off if a model rejects them.',
                          '進階項：關掉後不送出溫度 / top_p。推理模型報錯時再關。'
                        )}
                      >
                        <Toggle
                          value={provider.sendSampling !== false}
                          onChange={(next) => updateProvider({ sendSampling: next })}
                        />
                      </Row>

                      <Row
                        icon={<BoxIcon className="h-4 w-4" />}
                        title={t('额外请求体（JSON）', 'Extra request body (JSON)', '額外請求內容（JSON）')}
                        desc={t(
                          '高级项：额外传给服务商的 JSON 参数。不懂就留空。',
                          'Advanced: extra JSON fields to send to the provider.',
                          '進階項：額外傳給服務商的 JSON 參數。不懂就留空。'
                        )}
                      >
                        <div className={W_CTRL}>
                          <textarea
                            value={provider.extraBody ?? ''}
                            onChange={(e) => updateProvider({ extraBody: e.target.value })}
                            rows={3}
                            spellCheck={false}
                            placeholder='{ "top_k": 40 }'
                            className={inputClass + ' resize-y font-mono text-xs'}
                          />
                          <div className="mt-1 text-[11px] text-neutral-600">
                            {extraBodyState(provider.extraBody)}
                          </div>
                        </div>
                      </Row>
                    </div>
                  </div>

                  </SubSection>

                  <SubTitle>{t('危险区', 'Danger zone', '危險區')}</SubTitle>
                  <div className="flex justify-end py-2">
                    <OreButton status="red"
                      onClick={() => removeProvider(provider.id)}
                      className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-400 hover:border-red-500 hover:text-red-400"
                    >
                      {t('删除该提供商', 'Delete this provider', '刪除此供應商')}
                    </OreButton>
                  </div>
                </>
              )}

              {error && <p className="mt-3 text-xs text-amber-400">{error}</p>}
            </>
          )}

          {section === 'backend' && (
            <>
              <GroupTitle
                title={t('执行后端', 'Execution backend', '執行後端')}
                desc={t(
                  '决定 RB Code 能做什么：浏览器沙箱只能读写你授权的目录，本机执行器可以跑系统命令。',
                  'Determines what RB Code can do: the browser sandbox only touches the folder you authorized, the local executor can run system commands.',
                  '決定 RB Code 能做什麼：瀏覽器沙箱只能讀寫你授權的目錄，本機執行器可以執行系統命令。',
                )}
              />

              <Row
                icon={<TerminalIcon className="h-4 w-4" />}
                title={t('当前连接', 'Current connection', '目前連線')}
                desc={
                  backend
                    ? isMobile
                      ? backendName(backend.kind)
                      : `${backendName(backend.kind)} · ${backend.rootLabel || t('（未指定目录）', '(no folder)', '（未指定目錄）')}`
                    : t('还没有连接后端，先在左栏「打开项目」', 'No backend connected yet — use "Open project" first', '還沒有連接後端，先在左欄「開啟專案」')
                }
              >
                <div className="flex gap-2">
                  <OreButton status="normal"
                    onClick={props.onOpenProject}
                    className="rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-300 transition-colors hover:border-amber-600 hover:text-amber-200"
                  >
                    {t('打开项目', 'Open project', '開啟專案')}
                  </OreButton>
                  {backend && (
                    <OreButton status="red"
                      onClick={props.onDisconnect}
                      className="rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-400 transition-colors hover:border-red-500 hover:text-red-400"
                    >
                      {t('断开', 'Disconnect', '中斷連線', '切断')}
                    </OreButton>
                  )}
                </div>
              </Row>

              <Row
                icon={<DownloadIcon className="h-4 w-4" />}
                title={t('下载客户端', 'Download clients', '下載用戶端')}
                desc={t(
                  '手机版 App 自带本机后端；电脑端执行器让网页能读写整机文件、跑命令、操作屏幕。',
                  'The phone app runs the local backend; the desktop companion lets the page read/write files, run commands and control the screen.',
                  '手機版 App 自帶本機後端；電腦端執行器讓網頁能讀寫整機檔案、執行命令、操作螢幕。',
                )}
              >
                <div className="flex flex-wrap justify-end gap-2">
                  <OreButton
                    status="normal"
                    href="/downloads/rbcode-companion-1.0.0-setup.exe"
                    download
                    className="inline-flex items-center gap-1.5 rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-300 transition-colors hover:border-amber-600 hover:text-amber-200"
                  >
                    <DownloadIcon className="h-3.5 w-3.5" />
                    {t('电脑端（Windows）', 'Desktop (Windows)', '電腦端（Windows）')}
                  </OreButton>
                  <OreButton
                    status="normal"
                    href="/downloads/rbcode-android-1.0.0.apk"
                    download
                    className="inline-flex items-center gap-1.5 rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-300 transition-colors hover:border-amber-600 hover:text-amber-200"
                  >
                    <DownloadIcon className="h-3.5 w-3.5" />
                    {t('手机版（Android）', 'Mobile (Android)', '手機版（Android）')}
                  </OreButton>
                </div>
              </Row>

              <Row
                icon={<SettingsIcon className="h-4 w-4" />}
                title={t('打开项目时优先使用', 'Preferred backend', '開啟專案時優先使用')}
                desc={t(
                  '会话里也可以随时用顶栏的后端徽章切换，两种方式共用同一份项目数据。',
                  'You can also switch any time with the backend badge in the header; both share the same project data.',
                  '工作階段中也可隨時用頂欄的後端徽章切換，兩種方式共用同一份專案資料。',
                )}
              >
                <Select<ExecutorKind>
                  value={settings.executor}
                  options={[
                    { value: 'auto', label: t('自动', 'Auto', '自動', '自動') },
                    { value: 'browser', label: t('浏览器沙箱', 'Browser sandbox', '瀏覽器沙箱') },
                    { value: 'companion', label: t('本机执行器', 'Local executor', '本機執行器') },
                  ]}
                  onChange={(next) => onChange({ executor: next })}
                />
              </Row>

              <Row
                icon={<WrenchIcon className="h-4 w-4" />}
                title={t('本机执行器配对令牌', 'Local executor token', '本機執行器配對權杖')}
                desc={t(
                  '在本机执行器窗口点「复制」，粘贴保存即可。',
                  'Copy it from the companion window, paste and save.',
                  '在本機執行器視窗點「複製」，貼上儲存即可。'
                )}
              >
                <div className="flex items-center gap-2">
                  <div className={W_NUM}>
                    <input
                      value={settings.companionToken}
                      placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
                      onChange={(e) => onChange({ companionToken: e.target.value })}
                      className={inputClass + ' min-w-0 font-mono text-xs'}
                    />
                  </div>
                  <OreButton status="normal"
                    onClick={() => props.onConnectCompanion(settings.companionToken)}
                    className="shrink-0 rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-300 transition-colors hover:border-amber-600 hover:text-amber-200"
                  >
                    {t('保存', 'Save', '儲存', '保存')}
                  </OreButton>
                </div>
              </Row>

              {backendError && <p className="mt-3 text-xs text-amber-400">{backendError}</p>}

              <div className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4 text-xs leading-relaxed text-neutral-500">
                <div className="mb-2 flex items-center gap-2 text-neutral-400">
                  <FolderIcon className="h-4 w-4" />
                  {t('两者的区别', 'The difference', '兩者的差別')}
                </div>
                {t(
                  '浏览器沙箱只能读写你授权的那个目录；本机执行器能运行系统命令（python / git / powershell），也能在右栏管理运行中的终端。切换后端不会丢会话。',
                  'The browser sandbox can only read and write the folder you authorized; the local executor can run system commands (python / git / powershell) and lets you manage running terminals in the right column. Switching keeps your sessions.',
                  '瀏覽器沙箱只能讀寫你授權的那個目錄；本機執行器能執行系統命令（python / git / powershell），也能在右欄管理執行中的終端。切換後端不會遺失工作階段。',
                )}
              </div>
            </>
          )}

          {section === 'mcp' && (
            <>
              <GroupTitle
                title="MCP"
                desc={t(
                  '让模型调用外部 MCP 服务器的工具。需要连接本机执行器；每个项目一份独立进程 + 独立缓存目录（<项目>/.rbcode/mcp/），互不影响。',
                  'Lets the model use tools from external MCP servers. Requires the local executor; each project gets its own process and cache directory (<project>/.rbcode/mcp/).',
                  '讓模型呼叫外部 MCP 伺服器的工具。需要連接本機執行器；每個專案一份獨立行程 + 獨立快取目錄（<專案>/.rbcode/mcp/）。',
                )}
              />

              <Row
                icon={<WrenchIcon className="h-4 w-4" />}
                title={t('内置浏览器', 'Built-in browser', '內建瀏覽器')}
                desc={t(
                  '让模型自己开网页（登录、点按、截图）。自带内核首次约需 150MB，也可用系统已装的浏览器。',
                  'Let the model drive a browser (log in, click, screenshot). The built-in engine needs ~150MB once; installed Chrome / Edge also work.',
                  '讓模型自己開網頁（登入、點按、截圖）。自帶核心首次約需 150MB，也可用系統已裝的瀏覽器。'
                )}
              >
                <Select<McpBrowser>
                  value={settings.mcpBrowser}
                  options={[
                    { value: 'chromium' as const, label: 'Chromium' },
                    { value: 'msedge' as const, label: 'Edge' },
                    { value: 'chrome' as const, label: 'Chrome' },
                    { value: 'off' as const, label: t('关闭', 'Off', '關閉') },
                  ]}
                  onChange={(next) => onChange({ mcpBrowser: next })}
                />
              </Row>

              <Row
                icon={<WrenchIcon className="h-4 w-4" />}
                title={t('无界面模式', 'Headless', '無介面模式')}
                desc={t(
                  '浏览器在后台跑，不弹窗口。关掉会弹出真的浏览器窗口 —— 需要你手动登录或过验证码时很有用。',
                  'The browser runs in the background. Turn it off to show a real browser window — handy when you need to log in or solve a captcha by hand.',
                  '瀏覽器在後台執行，不彈視窗。關掉會彈出真的瀏覽器視窗 —— 需要你手動登入或過驗證碼時很有用。',
                )}
              >
                <Toggle
                  value={settings.mcpHeadless}
                  onChange={(next) => onChange({ mcpHeadless: next })}
                />
              </Row>

              <Row
                icon={<SearchIcon className="h-4 w-4" />}
                title={t('检测', 'Check', '檢測')}
                desc={t(
                  '点一下启动该服务并列出工具（首次较慢）。自定义服务第一次要用它激活。',
                  'Starts the server and lists its tools (the first run is slower). Custom servers need this once.',
                  '點一下啟動該服務並列出工具（首次較慢）。自訂服務第一次要用它啟用。'
                )}
              >
                <OreButton status="normal"
                  onClick={() => void probeMcp()}
                  disabled={probingMcp}
                  className="rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-300 transition-colors hover:border-amber-600 hover:text-amber-200 disabled:opacity-50"
                >
                  {probingMcp ? t('检测中…', 'Checking…', '檢測中…') : t('检测', 'Check', '檢測')}
                </OreButton>
              </Row>
              <FeedbackLine value={mcpState} />

              <div className="mt-6">
                <div className="mb-1 text-sm font-medium text-neutral-200">
                  {t('自定义 MCP 服务器', 'Custom MCP servers', '自訂 MCP 伺服器')}
                </div>
                <p className="mb-3 text-xs leading-relaxed text-neutral-500">
                  {t(
                    '命令 + 参数 + 环境变量，和 Claude Desktop 的 mcpServers 类似。每个项目各起一份进程；内部缓存在 <项目>/.rbcode/mcp/<id>/（不对模型开放），产出目录是 <项目>/.mcp_output/<id>/（模型可读写）。',
                    'Command + args + env vars, like Claude Desktop’s mcpServers. Each project gets its own process; internal cache lives in <project>/.rbcode/mcp/<id>/ (not exposed to the model) and outputs go to <project>/.mcp_output/<id>/ (readable/writable by the model).',
                    '命令 + 參數 + 環境變數，和 Claude Desktop 的 mcpServers 類似。每個專案各起一份行程；內部快取在 <專案>/.rbcode/mcp/<id>/（不對模型開放），產出目錄是 <專案>/.mcp_output/<id>/（模型可讀寫）。',
                  )}
                </p>

                {settings.mcpServers.map((server) => (
                  <div key={server.id} className="mb-3 rounded-lg border border-neutral-800 p-3">
                    <div className="mb-2 flex items-center gap-2">
                      <input
                        value={server.name}
                        onChange={(e) => patchMcpServer(server.id, { name: e.target.value })}
                        placeholder={t('名称', 'Name', '名稱')}
                        className={inputClass + ' flex-1'}
                      />
                      <Toggle
                        value={server.enabled}
                        onChange={(next) => patchMcpServer(server.id, { enabled: next })}
                      />
                      <OreButton status="red"
                        onClick={() => removeMcpServer(server.id)}
                        className="shrink-0 rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-400 transition-colors hover:border-red-500 hover:text-red-400"
                      >
                        {t('删除', 'Delete', '刪除')}
                      </OreButton>
                    </div>

                    <div className="mb-1 text-[11px] text-neutral-500">
                      {t('命令', 'Command', '命令')}
                    </div>
                    <input
                      value={server.command}
                      onChange={(e) => patchMcpServer(server.id, { command: e.target.value })}
                      placeholder="npx"
                      spellCheck={false}
                      className={inputClass + ' font-mono'}
                    />

                    <div className="mt-2 mb-1 text-[11px] text-neutral-500">
                      {t('参数（每行一个）', 'Arguments (one per line)', '參數（每行一個）')}
                    </div>
                    <textarea
                      value={server.args.join('\n')}
                      onChange={(e) =>
                        patchMcpServer(server.id, { args: e.target.value.split('\n') })
                      }
                      rows={2}
                      spellCheck={false}
                      className={mcpAreaClass}
                    />

                    <div className="mt-2 mb-1 text-[11px] text-neutral-500">
                      {t(
                        '环境变量（每行 KEY=VALUE）',
                        'Env vars (one KEY=VALUE per line)',
                        '環境變數（每行 KEY=VALUE）',
                      )}
                    </div>
                    <textarea
                      value={envToText(server.env)}
                      onChange={(e) => patchMcpServer(server.id, { env: textToEnv(e.target.value) })}
                      rows={2}
                      spellCheck={false}
                      className={mcpAreaClass}
                    />
                  </div>
                ))}

                <OreButton status="normal"
                  onClick={addMcpServer}
                  className="inline-flex items-center gap-1 rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-300 transition-colors hover:border-amber-600 hover:text-amber-200"
                >
                  <PlusIcon className="h-3.5 w-3.5" />
                  {t('新增服务器', 'Add server', '新增伺服器')}
                </OreButton>
              </div>
            </>
          )}

          {section === 'skills' && (
            <>
              <div className="mb-4 flex items-start gap-4">
                <div className="min-w-0 flex-1">
                  <GroupTitle
                    title={t('技能', 'Skills', '技能')}
                    desc={t(
                      '可复用的指令包；模型遇到匹配任务会自动使用。',
                      'Reusable instruction packs; the model uses them when a task matches.',
                      '可複用的指令包；模型遇到相符任務會自動使用。'
                    )}
                  />
                </div>
                <OreButton status="normal"
                  onClick={addSkill}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 transition-colors hover:border-amber-600 hover:text-amber-200"
                >
                  <PlusIcon className="h-3.5 w-3.5" />
                  {t('添加技能', 'Add skill', '新增技能')}
                </OreButton>
              </div>

              {settings.skills.length === 0 ? (
                <div className="rounded-xl border border-dashed border-neutral-800 px-4 py-8 text-center text-xs text-neutral-600">
                  {t(
                    '还没有技能。点右上角「添加技能」新建一个。',
                    'No skills yet. Use "Add skill" at the top right.',
                    '還沒有技能。點右上角「新增技能」新增一個。',
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  {settings.skills.map((skill) => {
                    const open = openSkillId === skill.id
                    return (
                      <div
                        key={skill.id}
                        className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/40"
                      >
                        <button onClick={() => setOpenSkillId(open ? null : skill.id)}
                          className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-neutral-800/40"
                        >
                          <ChevronRightIcon
                            className={`h-3.5 w-3.5 shrink-0 text-neutral-500 transition-transform ${
                              open ? 'rotate-90' : ''
                            }`}
                          />
                          <SparklesIcon className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                          <span className="shrink-0 font-mono text-xs text-neutral-100">
                            {skill.name || t('未命名技能', 'Untitled skill', '未命名技能', '名称未設定')}
                          </span>
                          {skill.description && (
                            <span className="min-w-0 flex-1 truncate text-xs text-neutral-500">
                              · {skill.description}
                            </span>
                          )}
                          <span className="ml-auto shrink-0 text-[11px] text-neutral-600">
                            {open
                              ? t('收起', 'Collapse', '收合')
                              : t('编辑', 'Edit', '編輯', '編集')}
                          </span>
                        </button>

                        {open && (
                          <div className="anim-fade space-y-2 border-t border-neutral-800 px-3 py-3">
                            <input
                              value={skill.name}
                              placeholder={t(
                                '技能名（模型用它调用），如 code-review',
                                'Skill name (the model calls it), e.g. code-review',
                                '技能名（模型用它呼叫），如 code-review',
                              )}
                              onChange={(e) => updateSkill(skill.id, { name: e.target.value })}
                              className={inputClass + ' font-mono text-xs'}
                            />
                            <input
                              value={skill.description}
                              placeholder={t(
                                '一句话说明（会列给模型看）',
                                'One-line description (shown to the model)',
                                '一句說明（會列給模型看）',
                              )}
                              onChange={(e) =>
                                updateSkill(skill.id, { description: e.target.value })
                              }
                              className={inputClass + ' text-xs'}
                            />
                            <textarea
                              value={skill.instructions}
                              placeholder={t(
                                '调用技能时注入给模型的完整指令（可写 Markdown）',
                                'Full instructions injected when the skill is loaded (Markdown is fine)',
                                '呼叫技能時注入給模型的完整指令（可寫 Markdown）',
                              )}
                              onChange={(e) =>
                                updateSkill(skill.id, { instructions: e.target.value })
                              }
                              className={inputClass + ' h-40 resize-y leading-relaxed'}
                            />
                            <div className="flex justify-end">
                              <OreButton status="red"
                                onClick={() => removeSkill(skill.id)}
                                className="inline-flex items-center gap-1 rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-400 transition-colors hover:border-red-500 hover:text-red-400"
                              >
                                <TrashIcon className="h-3.5 w-3.5" />
                                {t('删除这个技能', 'Delete this skill', '刪除此技能')}
                              </OreButton>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              <p className="mt-4 text-xs text-neutral-600">
                {t(
                  '技能保存在本机浏览器（全局），不随项目走。',
                  'Skills are stored in this browser (global), not per project.',
                  '技能儲存在本機瀏覽器（全域），不隨專案走。',
                )}
              </p>
            </>
          )}

          {section === 'computer' && (
            <>
              <GroupTitle
                title={t('Computer use', 'Computer use', 'Computer use')}
                desc={t(
                  '让模型能看你的屏幕、动你的键鼠（只在连了本机执行器时可用）。第一次使用会按会话征求一次授权；它可能被网页里的提示注入利用，别在已登录的高价值环境里全权托付。',
                  'Lets the model see your screen and drive your mouse and keyboard (only with the local executor). The first use asks once per session. It can be abused via prompt injection, so avoid handing it full control in logged-in, high-value environments.',
                  '讓模型能看你的螢幕、動你的鍵盤滑鼠（只在連了本機執行器時可用）。第一次使用會按工作階段徵求一次授權；它可能被網頁裡的提示注入利用，別在已登入的高價值環境裡全權托付。',
                )}
              />

              <Row
                icon={<GridIcon className="h-4 w-4" />}
                title={t('启用 Computer use', 'Enable Computer use', '啟用 Computer use')}
                desc={t(
                  '关掉后 computer_use 工具会直接拒绝（模型也不会看到它）。',
                  'When off, the computer_use tool refuses outright (and is not offered to the model).',
                  '關掉後 computer_use 工具會直接拒絕（模型也不會看到它）。',
                )}
              >
                <Toggle
                  value={settings.computerEnabled}
                  onChange={(next) => onChange({ computerEnabled: next })}
                />
              </Row>

              <Row
                icon={<ImageIcon className="h-4 w-4" />}
                title={t('截图宽度上限', 'Screenshot width limit', '截圖寬度上限')}
                desc={t(
                  '给模型的截图大小。太大更慢更贵，太小点不准。默认 1280 多数够用。',
                  'Screenshot size for the model. Bigger is slower and pricier; too small and clicks miss. 1280 suits most screens.',
                  '給模型的截圖大小。太大更慢更貴，太小點不準。預設 1280 多數夠用。'
                )}
              >
                <Select<string>
                  value={String(settings.computerMaxWidth)}
                  options={[
                    { value: '1280', label: '1280（推荐）' },
                    { value: '1568', label: '1568' },
                    { value: '1920', label: '1920' },
                    { value: '0', label: t('原分辨率', 'Native', '原分辨率') },
                  ]}
                  onChange={(next) => onChange({ computerMaxWidth: Number(next) })}
                />
              </Row>
            </>
          )}

          {section === 'advanced' && (
            <>
              <GroupTitle
                title={t('系统提示词', 'System prompt', '系統提示詞')}
                desc={t(
                  '留空使用内置提示词。工作区里的 AGENTS.md 会自动附加在它后面。',
                  'Leave blank to use the built-in prompt. AGENTS.md in the workspace is appended automatically.',
                  '留空使用內建提示詞。工作區裡的 AGENTS.md 會自動附加在後面。',
                )}
              />

              <Row
                icon={<WrenchIcon className="h-4 w-4" />}
                title={t('自定义系统提示词', 'Custom system prompt', '自訂系統提示詞')}
                desc={t(
                  '替换内置的行为设定；建议先导出备份。',
                  'Replaces the built-in instructions; export a backup first.',
                  '替換內建的行為設定；建議先匯出備份。'
                )}
              >
                <OreButton status="normal"
                  onClick={() => {
                    if (!settings.systemPrompt) {
                      setError(t('当前已经是内置提示词', 'Already using the built-in prompt', '目前已經是內建提示詞'))
                      return
                    }
                    if (
                      window.confirm(
                        t(
                          '清空自定义提示词，恢复使用内置默认？',
                          'Clear the custom prompt and go back to the built-in default?',
                          '清空自訂提示詞，恢復使用內建預設？',
                        ),
                      )
                    ) {
                      onChange({ systemPrompt: '' })
                    }
                  }}
                  className="rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-300 transition-colors hover:border-amber-600 hover:text-amber-200"
                >
                  {t('恢复默认', 'Reset to default', '恢復預設')}
                </OreButton>
              </Row>

              <textarea
                value={settings.systemPrompt}
                onChange={(e) => onChange({ systemPrompt: e.target.value })}
                placeholder={t(
                  '留空则使用内置的 RB Code 提示词',
                  'Leave blank to use the built-in RB Code prompt',
                  '留空則使用內建的 RB Code 提示詞',
                )}
                className={inputClass + ' h-72 resize-y px-3 py-2.5 font-mono leading-relaxed'}
              />

              <div className="mt-4 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4 text-xs leading-relaxed text-neutral-500">
                {t(
                  '实际发出去的内容 = 上面这段（留空则用内置的）+ 执行环境说明 + 计划模式提示（开启时）+ 技能清单（有技能时）+ 工作区说明文件（AGENTS.md 等）的内容。',
                  'What is actually sent = the text above (or the built-in default) + environment note + plan-mode note (when on) + skills list (when any) + the workspace guide file (AGENTS.md and the like).',
                  '實際送出的內容 = 上面這段（留空則用內建的）+ 執行環境說明 + 計畫模式提示（開啟時）+ 技能清單（有技能時）+ 工作區說明檔案（AGENTS.md 等）的內容。',
                )}
                <span className="ml-1 text-neutral-400">
                  {t(
                    '给模型的全部文本（含工具说明）都是英文，界面是中文。',
                    'Everything sent to the model (including tool docs) is English.',
                    '給模型的全部文字（含工具說明）都是英文。',
                  )}
                </span>
              </div>
              {error && <p className="mt-3 text-xs text-amber-400">{error}</p>}
            </>
          )}

          {section === 'data' && (
            <>
              <GroupTitle
                title={t('数据与关于', 'Data & about', '資料與關於')}
                desc={t(
                  '设置保存在这台电脑的浏览器里；对话记录和可撤销的改动快照跟着项目一起存放。',
                  'Settings live in this browser; conversations and undo snapshots are kept together with each project.',
                  '設定儲存在這台電腦的瀏覽器裡；對話紀錄和可復原的改動快照跟著專案一起存放。',
                )}
              />

              <Row
                icon={<FolderIcon className="h-4 w-4" />}
                title={t('导出设置', 'Export settings', '匯出設定')}
                desc={t(
                  '把当前设置（含服务商、密钥、提示词）存成文件备份。',
                  'Save your settings (providers, keys, prompt) to a backup file.',
                  '把目前設定（含服務商、金鑰、提示詞）存成檔案備份。'
                )}
              >
                <OreButton status="normal"
                  onClick={exportSettings}
                  className="rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-300 transition-colors hover:border-amber-600 hover:text-amber-200"
                >
                  {t('导出', 'Export', '匯出')}
                </OreButton>
              </Row>

              <Row
                icon={<FolderIcon className="h-4 w-4" />}
                title={t('导入设置', 'Import settings', '匯入設定')}
                desc={t(
                  '从备份文件恢复设置，会整体覆盖当前设置。',
                  'Restores settings from a backup file. This overwrites your current settings.',
                  '從備份檔案恢復設定，會整體覆蓋目前設定。')}
              >
                <div className="flex items-center gap-2">
                  <input
                    ref={importRef}
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={importSettings}
                  />
                  <OreButton status="normal"
                    onClick={() => importRef.current?.click()}
                    className="rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-300 transition-colors hover:border-amber-600 hover:text-amber-200"
                  >
                    {t('选择文件', 'Choose file', '選擇檔案')}
                  </OreButton>
                </div>
              </Row>

              <Row
                icon={<TrashIcon className="h-4 w-4" />}
                title={t('清空会话列表缓存', 'Clear session cache', '清空工作階段清單快取')}
                desc={t(
                  `只清浏览器里的会话索引缓存（当前缓存了 ${props.sessionCacheProjects} 个项目），下次启动重新读取，不影响磁盘数据。`,
                  `Clears only the browser-side session index cache (${props.sessionCacheProjects} project(s) cached); it reloads next start and does not touch disk data.`,
                  `只清瀏覽器裡的工作階段索引快取（目前快取了 ${props.sessionCacheProjects} 個專案），下次啟動重新讀取，不影響磁碟資料。`,
                )}
              >
                <OreButton status="red"
                  onClick={clearSessionCache}
                  className="rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-400 transition-colors hover:border-red-500 hover:text-red-400"
                >
                  {t('清空', 'Clear', '清空', '消去')}
                </OreButton>
              </Row>

              <Row
                icon={<TrashIcon className="h-4 w-4" />}
                title={t('清空项目列表', 'Clear project list', '清空專案清單')}
                desc={t(
                  `移除全部 ${props.projectCount} 条项目记录与目录授权，磁盘文件与会话数据都不受影响。`,
                  `Removes all ${props.projectCount} project record(s) and folder permissions; disk files and sessions are untouched.`,
                  `移除全部 ${props.projectCount} 筆專案記錄與目錄授權，磁碟檔案與工作階段資料都不受影響。`,
                )}
              >
                <OreButton status="red"
                  onClick={clearProjects}
                  className="rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-400 transition-colors hover:border-red-500 hover:text-red-400"
                >
                  {t('清空', 'Clear', '清空', '消去')}
                </OreButton>
              </Row>

              <Row
                icon={<WrenchIcon className="h-4 w-4" />}
                title={t('恢复出厂设置', 'Factory reset', '回復出廠設定', '初期化')}
                desc={t(
                  '重置全部设置项为默认值（不影响项目与会话数据）。',
                  'Resets every setting to its default (projects and sessions are untouched).',
                  '重設全部設定項為預設值（不影響專案與工作階段資料）。',
                )}
              >
                <OreButton status="red"
                  onClick={resetSettings}
                  className="rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-400 transition-colors hover:border-red-500 hover:text-red-400"
                >
                  {t('重置', 'Reset', '重設')}
                </OreButton>
              </Row>

              <FeedbackLine value={dataState} />

              <div className="mt-6">
                <div className="mb-1 text-sm font-medium text-neutral-200">
                  {t('关于', 'About', '關於', '情報')}
                </div>

                <Row
                  icon={<BoxIcon className="h-4 w-4" />}
                  title={t('版本', 'Version', '版本')}
                  desc="RB Code"
                >
                  <span className="font-mono text-xs text-neutral-300">v{APP_VERSION}</span>
                </Row>

                <Row
                  icon={<ClipboardListIcon className="h-4 w-4" />}
                  title={t('版权与许可', 'Copyright & licences', '版權與授權')}
                  desc={t(
                    '本软件的版权声明与用到的第三方组件',
                    'Copyright notice and third-party components used by this app',
                    '本軟體的版權聲明與用到的第三方組件',
                  )}
                >
                  <OreButton
                    status="normal"
                    onClick={() => setLicenseOpen(true)}
                    className="rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-300 transition-colors hover:border-amber-600 hover:text-amber-200"
                  >
                    {t('查看', 'View', '檢視')}
                  </OreButton>
                </Row>

                <LicenseDialog open={licenseOpen} onClose={() => setLicenseOpen(false)} />

                <Row
                  icon={<TerminalIcon className="h-4 w-4" />}
                  title={t('当前后端', 'Current backend', '目前後端')}
                  desc={
                    backend
                      ? isMobile
                        ? backendName(backend.kind)
                        : backend.rootLabel || backendName(backend.kind)
                      : t('未连接', 'Not connected', '未連線', '未接続')
                  }
                >
                  <span className="text-xs text-neutral-300">
                    {backend
                      ? backendName(backend.kind)
                      : t('未连接', 'Not connected', '未連線', '未接続')}
                  </span>
                </Row>

                <Row
                  icon={<CheckCircleIcon className="h-4 w-4" />}
                  title={t('后端服务', 'Backend service', '後端服務')}
                  desc={t(
                    '检查云端服务是否在线。',
                    'Check whether the cloud service is online.',
                    '檢查雲端服務是否在線。'
                  )}
                >
                  <OreButton status="normal"
                    onClick={() => void checkHealth()}
                    className="rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-300 transition-colors hover:border-amber-600 hover:text-amber-200"
                  >
                    {t('检查', 'Check', '檢查', '確認')}
                  </OreButton>
                </Row>
                <FeedbackLine value={healthState} />

                <Row
                  icon={<LightbulbIcon className="h-4 w-4" />}
                  title={t('系统通知', 'System notifications', '系統通知')}
                  desc={t(
                    `当前权限：${notificationPermission}。窗口不在焦点时，审批 / 提问 / 计划就绪会发通知。`,
                    `Current permission: ${notificationPermission}. When the window is unfocused, approvals / questions / a ready plan raise a notification.`,
                    `目前權限：${notificationPermission}。視窗不在焦點時，審批 / 提問 / 計畫就緒會發通知。`,
                  )}
                >
                  <OreButton status="normal"
                    onClick={() => void testNotification()}
                    className="rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-300 transition-colors hover:border-amber-600 hover:text-amber-200"
                  >
                    {t('发送测试通知', 'Send a test notification', '傳送測試通知')}
                  </OreButton>
                </Row>
              </div>
            </>
          )}
        </div>
      </main>

      {isMobile && (
        <Drawer open={navOpen} side="left" onClose={() => setNavOpen(false)}>
          <div className="flex h-full w-72 max-w-[85vw] flex-col border-r border-neutral-800 bg-neutral-950">
            <div className="p-3">
              <OreButton status="normal"
                onClick={onClose}
                className="inline-flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-neutral-300 hover:bg-neutral-900 hover:text-neutral-100"
              >
                <ArrowLeftIcon className="h-4 w-4" />
                {t('返回工作区', 'Back to workspace', '返回工作區')}
              </OreButton>
            </div>
            {settingsNav}
          </div>
        </Drawer>
      )}
    </div>
  )
}
