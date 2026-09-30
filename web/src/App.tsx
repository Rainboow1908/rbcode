import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ApprovalPanel from './components/ApprovalPanel.tsx'
import AskPanel from './components/AskPanel.tsx'
import AuroraBackground from './components/AuroraBackground.tsx'
import Composer from './components/Composer.tsx'
import DirectoryPicker from './components/DirectoryPicker.tsx'
import FloatingAgent from './components/FloatingAgent.tsx'
import FloatingWindow from './components/FloatingWindow.tsx'
import ImportDialog from './components/ImportDialog.tsx'
import InspectorPanel from './components/InspectorPanel.tsx'
import OreButton from './components/OreButton.tsx'
import FilesPanel from './components/FilesPanel.tsx'
import MusicPanel from './components/MusicPanel.tsx'
import RightDock, { DOCK_PANEL_IDS, type DockPanelId } from './components/RightDock.tsx'
import TodosPanel from './components/TodosPanel.tsx'
import ContextMenu, { type MenuItem } from './components/ContextMenu.tsx'
import Dialog, { ConfirmDialog } from './components/Dialog.tsx'
import Drawer from './components/Drawer.tsx'
import MessageList from './components/MessageList.tsx'
import SettingsPage from './components/SettingsPage.tsx'
import Sidebar from './components/Sidebar.tsx'
import StatusItemIcon from './components/StatusItemIcon.tsx'
import Tooltip from './components/Tooltip.tsx'
import TodoPanel from './components/TodoPanel.tsx'
import { ChevronRightIcon, ClipboardListIcon, GridIcon, MenuIcon, PencilIcon, PlayIcon, PlusIcon, XIcon } from './components/icons.tsx'
import { useAgent } from './hooks/useAgent.ts'
import { useIsMobile } from './hooks/useIsMobile.ts'
import { SPEED_PLACEHOLDER, formatSpeed } from './lib/rate.ts'
import { setSessionTodos } from './lib/sessions.ts'
import { hydrateImages, stripInlineImages } from './lib/attachments.ts'
import {
  findImportCandidates,
  loadImportMarker,
  type ImportCandidate,
} from './lib/importSessions.ts'
import { BrowserBackend } from './lib/executor/browser.ts'
import { CompanionBackend } from './lib/executor/companion.ts'
import type { RunningShell } from './lib/executor/companion.ts'
import type { Todo } from './lib/types.ts'
import type { Backend } from './lib/executor/types.ts'
import {
  browserHandleKey,
  loadProjects,
  projectFrom,
  removeProject,
  saveProjects,
  upsertProject,
} from './lib/projects.ts'
import type { Project } from './lib/projects.ts'
import { ensureRbcodeDir } from './lib/rbcode.ts'
import {
  deleteSession,
  listSessions,
  listTrash,
  loadSession,
  purgeTrash,
  restoreSession,
  saveSession,
  sessionsDirReadable,
  setSessionForked,
  titleFromMessages,
} from './lib/sessions.ts'
import type { SessionMeta, TrashedSession } from './lib/sessions.ts'
import { loadSessionCache, saveSessionCache } from './lib/sessionCache.ts'
import { renameSession, setSessionPinned } from './lib/sessions.ts'
import { setProjectPinned } from './lib/projects.ts'
import type { SessionCache } from './lib/sessionCache.ts'
import { backendName, getLanguage, setLanguage, useT } from './lib/i18n.ts'
import { canSpeak, speakText } from './lib/speech.ts'
import { permissionLabel } from './lib/permissions.ts'
import { formatDuration, formatTokens, STATUS_ITEM_LABEL } from './lib/statusBar.ts'
import type { StatusItemId } from './lib/types.ts'
import { setThemeMode } from './lib/themeMode.ts'
import { estimateTokens } from './lib/compact.ts'
import { activeProvider, loadSettings, REASONING_EFFORT_LABEL, saveSettings } from './lib/settings.ts'
import { playSound } from './lib/sound.ts'
import { messagesToMarkdown } from './lib/text.ts'
import { initNotifications, notify } from './lib/notify.ts'
import type { ApprovalRequest, AskRequest } from './lib/tools/types.ts'
import type { AppSettings, Attachment, Message, SoundEvent, ThemeMode, UsageStats } from './lib/types.ts'

/** 一个等待用户决定的审批；面板只显示队列里的第一个 */
interface PendingApproval {
  id: string
  request: ApprovalRequest
  resolve: (approved: boolean) => void
}

/**
 * 每个「颜色」对应一套**多彩**极光调色板（三个基色，色相拉开，避免整片一个色）。
 * default = 原本的绿 / 青 / 紫。
 */
const AURORA_PALETTE: Record<string, [string, string, string]> = {
  default: ['#08ff7a', '#0ac7ff', '#801fff'],
  amber: ['#ffd166', '#ff8f3f', '#ff5d8f'],
  blue: ['#4da3ff', '#7ae0ff', '#7c5cff'],
  cyan: ['#22d3ee', '#34d399', '#7c5cff'],
  emerald: ['#34d399', '#b6f36b', '#22d3ee'],
  violet: ['#a78bfa', '#e879f9', '#4da3ff'],
  rose: ['#fb7185', '#f472b6', '#c084fc'],
}

export default function App() {
  const t = useT()
  const [settings, setSettings] = useState<AppSettings>(loadSettings)
  // 语言在渲染前同步一次（变了才通知订阅者，避免不必要的重渲染）
  setLanguage(settings.language)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** 主页提示条（没配模型之类）：可关闭，不再强行把用户塞进设置页 */
  const [appNotice, setAppNotice] = useState<string | null>(null)
  const [backend, setBackend] = useState<Backend | null>(null)
  const backendRef = useRef<Backend | null>(null)
  backendRef.current = backend
  const [backendError, setBackendError] = useState<string | null>(null)
  /** 连不上本机执行器时挂在这儿：后台每 3 秒重连一次，连上就自动接回该项目 */
  const [pendingCompanion, setPendingCompanion] = useState<{ project: Project; token: string } | null>(
    null,
  )
  const [planMode, setPlanMode] = useState(false)
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null)
  const [pickerCompanion, setPickerCompanion] = useState<CompanionBackend | null>(null)
  const [todosCollapsed, setTodosCollapsed] = useState(() => {
    try {
      return localStorage.getItem('rbcode.todosCollapsed') === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem('rbcode.todosCollapsed', todosCollapsed ? '1' : '0')
    } catch {
      // 忽略
    }
  }, [todosCollapsed])

  /** 用户把计划清单整个关掉了（全局生效，自己决定要不要看） */
  const [todosHidden, setTodosHidden] = useState(() => {
    try {
      return localStorage.getItem('rbcode.todosHidden') === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('rbcode.todosHidden', todosHidden ? '1' : '0')
    } catch {
      // 存不进去也不影响使用
    }
  }, [todosHidden])

  const [projects, setProjects] = useState<Project[]>(loadProjects)
  // 刷新后要能回到刚才那个项目，否则侧栏没有活动项目、会话列表是空的
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() =>
    localStorage.getItem('rbcode.activeProjectId'),
  )
  const [expandedIds, setExpandedIds] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('rbcode.expandedProjects')
      const parsed = raw ? (JSON.parse(raw) as unknown) : []
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem('rbcode.expandedProjects', JSON.stringify(expandedIds))
    } catch {
      // 忽略
    }
  }, [expandedIds])
  /**
   * 会话列表与“它属于哪个项目”一起存。
   * 只按 id 匹配才渲染，避免切换项目时把上一个项目的会话显示出来（会话窜项目）。
   */
  const [sessionState, setSessionState] = useState<{
    projectId: string | null
    items: SessionMeta[]
  }>({ projectId: null, items: [] })
  const sessions = sessionState.projectId === activeProjectId ? sessionState.items : []
  /** 每个项目各自缓存一份会话列表，这样展开别的项目也能看到它的会话 */
  const [sessionCache, setSessionCache] = useState<SessionCache>(loadSessionCache)

  useEffect(() => {
    if (activeProjectId) localStorage.setItem('rbcode.activeProjectId', activeProjectId)
    else localStorage.removeItem('rbcode.activeProjectId')
  }, [activeProjectId])

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [loadingSessions, setLoadingSessions] = useState(false)
  /** 正在载入的会话：大文件/多图时给个进度，别让人以为卡死 */
  const [sessionLoading, setSessionLoading] = useState<{
    label: string
    done: number
    total: number
  } | null>(null)

  const [pendingAsk, setPendingAsk] = useState<AskRequest | null>(null)
  const [inputSeed, setInputSeed] = useState<{ id: number; text: string } | null>(null)
  const [planApprovalPending, setPlanApprovalPending] = useState(false)
  const [shells, setShells] = useState<RunningShell[]>([])
  /** 终端栏里每条命令的实时输出（命令 id → 已累计的文本） */
  const [shellLogs, setShellLogs] = useState<Record<string, string>>({})
  const shellLogsRef = useRef<Record<string, string>>({})
  /** 右键菜单：位置 + 菜单项 */
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [backendMenuOpen, setBackendMenuOpen] = useState(false)
  const [leftDrawerOpen, setLeftDrawerOpen] = useState(false)
  const [rightDrawerOpen, setRightDrawerOpen] = useState(false)
  /** 工作台布局里打开的会话标签页 */
  const [openTabs, setOpenTabs] = useState<string[]>([])
  /** 正在拖动的标签 id */
  const [dragTabId, setDragTabId] = useState<string | null>(null)

  // 右侧标签栏：打开的面板顺序 + 当前选中（记住，下次打开还在）
  const [dockTabs, setDockTabs] = useState<DockPanelId[]>(() => {
    try {
      const raw = localStorage.getItem('rbcode.dockTabs')
      const parsed: unknown = raw ? JSON.parse(raw) : null
      if (Array.isArray(parsed)) {
        const valid = parsed.filter(
          (id): id is DockPanelId => DOCK_PANEL_IDS.includes(id as DockPanelId),
        )
        if (valid.length > 0) return valid
      }
    } catch {
      // 坏数据就用默认
    }
    return ['context', 'terminals']
  })
  const [activeDock, setActiveDock] = useState<DockPanelId | null>(() => {
    const raw = localStorage.getItem('rbcode.dockActive')
    return raw && DOCK_PANEL_IDS.includes(raw as DockPanelId) ? (raw as DockPanelId) : 'context'
  })
  /** 经典布局左右两栏的宽度（可拖动调整，记住） */
  const [leftWidth, setLeftWidth] = useState(() => {
    const value = Number(localStorage.getItem('rbcode.leftWidth'))
    return Number.isFinite(value) && value >= 180 && value <= 560 ? value : 256
  })
  const [rightWidth, setRightWidth] = useState(() => {
    const value = Number(localStorage.getItem('rbcode.rightWidth'))
    return Number.isFinite(value) && value >= 180 && value <= 560 ? value : 288
  })

  useEffect(() => {
    try {
      localStorage.setItem('rbcode.leftWidth', String(leftWidth))
    } catch {
      // 忽略
    }
  }, [leftWidth])

  useEffect(() => {
    try {
      localStorage.setItem('rbcode.rightWidth', String(rightWidth))
    } catch {
      // 忽略
    }
  }, [rightWidth])

  /** 归档会话的确认、回收站 */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [pendingPurge, setPendingPurge] = useState<string | null>(null)
  const [trash, setTrash] = useState<TrashedSession[]>([])
  const [trashOpen, setTrashOpen] = useState(false)

  /** 待决定的审批队列（可能同时有多个），以及当前面板上显示的那个 */
  const approvalQueue = useRef<PendingApproval[]>([])
  const pendingApprovalRef = useRef<PendingApproval | null>(null)
  pendingApprovalRef.current = pendingApproval
  /** 给系统通知的按钮用，避免把 decideApproval 塞进 requestApproval 的依赖里 */
  const decideApprovalRef = useRef<(approved: boolean) => void>(() => {})
  const askResolver = useRef<((answer: string) => void) | null>(null)
  const planNotified = useRef(false)

  /** 提示音：从最新 settings 读开关与配置，避免回调里的闭包过期 */
  const soundRef = useRef(settings)
  soundRef.current = settings
  const playEvent = useCallback((event: SoundEvent) => {
    const current = soundRef.current
    if (!current.soundEnabled) return
    playSound(current.sounds[event] ?? 'none', current.soundVolume)
  }, [])

  /** 模型提问：在输入框上方等待用户回答 */
  const askUser = useCallback((request: AskRequest) => {
    return new Promise<string>((resolve) => {
      askResolver.current = resolve
      setPendingAsk(request)
      playEvent('ask')
      void notify({
        title: t('RB Code 有个问题要问你', 'RB Code has a question', 'RB Code 有個問題要問你', 'RB Code から質問があります'),
        body:
          request.questions[0]?.question ??
          t('模型有问题要问你', 'The model has a question for you', '模型有問題要問你', 'モデルからの質問です'),
        tag: 'rbcode-ask',
        actions: [
          {
            action: 'answer',
            title: t('去回答', 'Answer', '去回答', '回答する'),
          },
        ],
        onAction: () => {
          try {
            window.focus()
          } catch {
            // 忽略
          }
        },
      })
    })
  }, [playEvent])

  const answerAsk = useCallback((answer: string) => {
    const resolve = askResolver.current
    askResolver.current = null
    setPendingAsk(null)
    resolve?.(answer)
  }, [])

  /**
   * 请求一次操作批准。模型可能在一轮里同时发出多个需要确认的工具调用，
   * 所以这里排队：面板一次只显示一个，前一个决定完再显示下一个。
   * 不能用「一个 resolver 反复覆盖」的写法 —— 那样先发出的那个 Promise
   * 永远不会结束，整个工具循环就卡死了。
   */
  const requestApproval = useCallback((request: ApprovalRequest) => {
    return new Promise<boolean>((resolve) => {
      const item: PendingApproval = { id: crypto.randomUUID(), request, resolve }
      const isFirst = approvalQueue.current.length === 0
      approvalQueue.current.push(item)
      setPendingApproval((current) => current ?? item)
      // 只给队列里的第一个发通知，避免一口气弹一堆
      if (!isFirst) return
      playEvent('approval')
      void notify({
        title: t('RB Code 需要你确认', 'RB Code needs your confirmation', 'RB Code 需要你確認', 'RB Code が確認を求めています'),
        body: request.summary,
        tag: 'rbcode-approval',
        actions: [
          { action: 'approve', title: t('允许', 'Allow', '允許', '許可') },
          { action: 'deny', title: t('拒绝', 'Reject', '拒絕', '拒否') },
        ],
        onAction: (action) => decideApprovalRef.current(action === 'approve'),
      })
    })
  }, [playEvent])

  /** 决定面板上显示的那一个（点按钮、超时、点通知都走这里） */
  const decideApproval = useCallback((approved: boolean) => {
    const current = pendingApprovalRef.current
    if (!current) return
    const index = approvalQueue.current.findIndex((item) => item.id === current.id)
    if (index === -1) return // 已经决定过了
    approvalQueue.current.splice(index, 1)
    current.resolve(approved)
    setPendingApproval(approvalQueue.current[0] ?? null)
  }, [])
  decideApprovalRef.current = decideApproval

  /** 把还没决定的审批一次性按结果处理掉（停会话时否掉、切到「完全」时放行） */
  const resolvePendingApprovals = useCallback((approved: boolean) => {
    const items = approvalQueue.current
    if (items.length === 0) return
    approvalQueue.current = []
    setPendingApproval(null)
    for (const item of items) item.resolve(approved)
  }, [])

  // 会话 → 元信息（用于按会话保存）
  const sessionMeta = useRef<Map<string, { projectId: string | null; createdAt: number }>>(new Map())
  const saveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const savedOnce = useRef<Set<string>>(new Set())
  const projectIdRef = useRef<string | null>(null)
  projectIdRef.current = activeProjectId

  /** 某个会话的消息有变化：落盘（新会话立刻存一次，之后走防抖） */
  const handleSessionMessages = useCallback(
    (sessionId: string, messages: Message[], usage: UsageStats, todos: Todo[]) => {
    const currentBackend = backendRef.current
    if (!currentBackend) return

    // 待办单独落盘（和下面的消息保存分开，互不覆盖）：引用没变就跳过，
    // 这样每个流式分片都不会白写一次。刷新 / 换执行后端后能从会话文件里恢复。
    if (savedTodos.current.sessionId !== sessionId || savedTodos.current.todos !== todos) {
      savedTodos.current = { sessionId, todos }
      void setSessionTodos(currentBackend, sessionId, todos)
    }

    const write = () => {
      const meta = sessionMeta.current.get(sessionId)
      const projectId = meta?.projectId ?? projectIdRef.current
      void saveSession(currentBackend, {
        id: sessionId,
        title: titleFromMessages(messages),
        createdAt: meta?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
        messageCount: messages.length,
        // 图片已经落到 .rbcode/images/：会话文件里只留引用，不再塞 base64
        messages: stripInlineImages(messages),
        // 待办跟着会话一起存（清空会话时自然写空数组）——不然消息保存会把待办冲掉
        todos,
        usage,
      })
        .then((items) => {
          if (projectId) setSessionCache((prev) => ({ ...prev, [projectId]: items }))
          setSessionState((prev) => (prev.projectId === projectId ? { projectId, items } : prev))
        })
        .catch(() => undefined)
    }

    // 第一次见到这个会话就立刻写盘：
    // 否则它要等流式结束（防抖）才出现在侧栏，正在跑的会话在侧栏里看不到。
    // 清空会话（messages 为空）时也要立刻写，不然磁盘上还留着旧消息。
    if (!savedOnce.current.has(sessionId) || messages.length === 0) {
      savedOnce.current.add(sessionId)
      write()
      return
    }

    const timers = saveTimers.current
    const existing = timers.get(sessionId)
    if (existing) clearTimeout(existing)
    timers.set(
      sessionId,
      setTimeout(() => {
        timers.delete(sessionId)
        write()
      }, 600),
    )
  }, [])

  const agent = useAgent({
    settings,
    backend,
    planMode,
    activeSessionId,
    requestApproval,
    askUser,
    onSessionMessages: handleSessionMessages,
    onTaskEnd: (_sessionId, outcome) => {
      playEvent(outcome === 'error' ? 'error' : 'taskDone')
      // 自动朗读（设置 → 语音，默认关）：一轮正常结束后，把最后一条回答念出来
      if (outcome !== 'done') return
      const latest = settings
      if (!latest.voiceOutput || !latest.voiceAutoRead || !canSpeak()) return
      const last = [...agent.messages]
        .reverse()
        .find((message) => message.role === 'assistant' && message.content.trim() !== '')
      if (!last) return
      speakText(last.id, last.content, {
        lang: getLanguage(),
        rate: latest.voiceRate,
        voiceName: latest.voiceName,
      })
    },
  })
  const provider = activeProvider(settings)

  // 计划确认：先退出计划模式，等这次状态更新生效后再把「开始执行」发给模型
  useEffect(() => {
    if (!planApprovalPending) return
    setPlanApprovalPending(false)
    if (activeSessionId)
      agent.send(
        activeSessionId,
        t(
          '计划已确认，请按这个计划开始执行。',
          'The plan is confirmed — start executing it.',
          '計畫已確認，請照這個計畫開始執行。',
          '計画を承認しました。この計画で実行を始めてください。',
        ),
        [],
      )
  }, [planApprovalPending, activeSessionId, agent])

  const approvePlan = useCallback(() => {
    setPlanMode(false)
    setPlanApprovalPending(true)
  }, [])

  const revisePlan = useCallback(() => {
    setInputSeed({
      id: Date.now(),
      text: t('请修改计划：', 'Revise the plan: ', '請修改計畫：', '計画を修正してください: '),
    })
  }, [])

  // 计划就绪时提醒（窗口不在焦点才会真的发通知）
  useEffect(() => {
    const ready = planMode && !agent.running && agent.todos.length > 0
    if (!ready) {
      planNotified.current = false
      return
    }
    if (planNotified.current) return
    planNotified.current = true
    playEvent('plan')
    void notify({
      title: t('RB Code 计划已就绪', 'RB Code plan is ready', 'RB Code 計畫已就緒', 'RB Code の計画ができました'),
      body: t(
        `已列出 ${agent.todos.length} 个步骤，确认后开始执行`,
        `${agent.todos.length} steps listed — confirm to start`,
        `已列出 ${agent.todos.length} 個步驟，確認後開始執行`,
        `${agent.todos.length} 件の手順を提示しました。確認すると実行します`,
      ),
      tag: 'rbcode-plan',
      actions: [
        { action: 'run', title: t('开始执行', 'Start', '開始執行', '実行する') },
        { action: 'open', title: t('查看', 'View', '查看', '表示') },
      ],
      onAction: (action) => {
        try {
          window.focus()
        } catch {
          // 忽略
        }
        if (action === 'run') {
          setPlanMode(false)
          setPlanApprovalPending(true)
        }
      },
    })
  }, [agent.running, agent.todos.length, planMode, playEvent])

  useEffect(() => {
    saveSettings(settings)
  }, [settings])

  // 注册通知用 Service Worker（带按钮的系统通知需要它）
  useEffect(() => {
    void initNotifications()
  }, [])

  // 主题：在 <html> 上切换 light / aurora / oreui 类；color-scheme 让滚动条等原生控件跟随
  // 主题 + 配色：挂在 <html> 上（light/aurora/oreui 类触发主题；rb-color-* 覆盖强调色变量）
  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('light', settings.theme === 'light')
    root.classList.toggle('aurora', settings.theme === 'aurora')
    root.classList.toggle('oreui', settings.theme === 'oreui')
    // 组件要知道当前是不是 OreUI 主题（决定按钮用哪套类名）
    setThemeMode(settings.theme)
    for (const name of ['amber', 'blue', 'cyan', 'emerald', 'violet', 'rose']) {
      root.classList.toggle(`rb-color-${name}`, settings.color === name)
    }    root.style.colorScheme = settings.theme === 'light' ? 'light' : 'dark'
  }, [settings.theme, settings.color])

  useEffect(() => {
    saveProjects(projects)
  }, [projects])

  // 会话索引缓存：刷新后侧栏也能显示各个项目上次看到的会话
  useEffect(() => {
    saveSessionCache(sessionCache)
  }, [sessionCache])

  const hasKey = settings.providers.some((p) => p.apiKey)
  useEffect(() => {
    // 没有可用的提供商就弹一条可关闭的主页提示（以前是直接打开设置页，每次访问都弹）
    if (hasKey) {
      setAppNotice(null)
      return
    }
    setAppNotice(
      t(
        '还没有配置模型：打开设置 → 模型服务，添加一个提供商并选好模型；要用本机执行器的话，在 执行后端 里填令牌。',
        'No model configured yet — open Settings → Model providers to add a provider and pick a model. For the local executor, add its token under Execution backend.',
        '還沒有設定模型：開啟設定 → 模型服務，新增一個供應商並選好模型；要用本機執行器就在 執行後端 填權杖。',
        'モデルが未設定です：設定 → モデルサービスでプロバイダーを追加しモデルを選んでください。ローカル実行環境を使う場合は「実行バックエンド」でトークンを入力します。',
      ),
    )
  }, [hasKey])

  /** 读取某个后端对应项目的会话索引（连同项目 id 一起记录） */
  const refreshSessions = useCallback(async (target: Backend, projectId: string | null) => {
    setLoadingSessions(true)
    let items: SessionMeta[] = []
    try {
      items = await listSessions(target)
    } catch {
      items = []
    }
    setSessionState({ projectId, items })
    if (projectId) {
      setSessionCache((prev) => ({ ...prev, [projectId]: items }))
    }
    setLoadingSessions(false)
  }, [])

  const clearSessions = useCallback(() => {
    setSessionState({ projectId: null, items: [] })
  }, [])

  /** 切换到已有项目 */
  const selectProject = useCallback(
    // tokenOverride：刚在设置里改完令牌时，用新令牌立刻重连（此时 state 还是旧的）
    async (project: Project, tokenOverride?: string): Promise<Backend | null> => {
      setBackendError(null)
      setPendingCompanion(null)
      setActiveProjectId(project.id)
      // 同步更新一份 ref：同一轮里紧接着要用的流程（比如 openSession）读 state 还是旧值
      projectIdRef.current = project.id
      // 选中就展开：否则要先点一次箭头才能看到会话
      setExpandedIds((prev) => (prev.includes(project.id) ? prev : [...prev, project.id]))
      setActiveSessionId(null)
      // 先清空会话列表：任何失败路径都不会残留上一个项目的会话
      clearSessions()

      if (project.backendKind === 'companion') {
        const token = (tokenOverride ?? settings.companionToken).trim()
        const companion = await CompanionBackend.discover(token)
        if (!companion) {
          setBackend(null)
          // 连不上别放弃：挂到后台自动重连，连上会自己接回来
          setPendingCompanion({ project, token })
          setBackendError(
            t(
              '未发现本机执行器，正在自动重连…（请确认 companion 已启动）',
              'Local executor not found — reconnecting automatically… (make sure the companion is running)',
              '未發現本機執行器，正在自動重連…（請確認 companion 已啟動）',
              'ローカル実行環境が見つかりません。自動再接続中…（companion が起動しているか確認してください）',
            ),
          )
          return null
        }
        try {
          await companion.setRoot(project.path)
        } catch (err) {
          setBackend(null)
          setBackendError(
          t(
            `切换工作目录失败：${(err as Error).message}`,
            `Failed to switch the working folder: ${(err as Error).message}`,
            `切換工作目錄失敗：${(err as Error).message}`,
            `作業フォルダの切り替えに失敗しました: ${(err as Error).message}`,
          ),
        )
          return null
        }
        setProjects((prev) => upsertProject(prev, { ...project, lastOpenedAt: Date.now() }))
        setBackend(companion)
        await refreshSessions(companion, project.id)
        return companion
      }

      const restored = await BrowserBackend.restore(browserHandleKey(project.id))
      if (!restored) {
        setBackend(null)
        setBackendError(
          t(
            '找不到该目录的授权记录，请用顶栏的后端徽章或「打开项目」重新选择一次。',
            'No stored permission for this folder — re-select it from the backend badge or "Open project".',
            '找不到該目錄的授權記錄，請用頂欄的後端徽章或「開啟專案」重新選擇一次。',
            'このフォルダの許可記録がありません。ヘッダーのバックエンドバッジか「プロジェクトを開く」で選び直してください。',
          ),
        )
        return null
      }
      if (!(await restored.ensurePermission(true))) {
        setBackend(null)
        setBackendError(
          t(
            '需要重新授权该目录的访问权限。',
            'This folder needs to be re-authorized.',
            '需要重新授權該目錄的存取權限。',
            'このフォルダへのアクセスを再許可してください。',
          ),
        )
        return null
      }
      setProjects((prev) => upsertProject(prev, { ...project, lastOpenedAt: Date.now() }))
      setBackend(restored)
      await refreshSessions(restored, project.id)
      return restored
    },
    [clearSessions, refreshSessions, settings.companionToken],
  )

  // 连不上本机执行器时不要停：每 3 秒重连一次，连上就自动接回该项目
  useEffect(() => {
    if (!pendingCompanion) return
    let cancelled = false
    const attempt = async () => {
      const found = await CompanionBackend.discover(pendingCompanion.token).catch(() => null)
      if (cancelled || !found) return
      setPendingCompanion(null)
      await selectProject(pendingCompanion.project, pendingCompanion.token)
    }
    const timer = setInterval(() => void attempt(), 3_000)
    void attempt()
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [pendingCompanion, selectProject])

  // 已经在用本机执行器时也盯着它：探活失败就重新发现、换上新实例（不打断当前会话）
  useEffect(() => {
    if (!backend || backend.kind !== 'companion') return
    const companion = backend as CompanionBackend
    const project = projects.find((item) => item.id === activeProjectId)
    if (!project) return
    let cancelled = false
    const timer = setInterval(async () => {
      const alive = await companion.ping()
      if (cancelled || alive) return
      // 掉线了（可能重启换了端口）：一直找，找到就换上，不放弃
      const found = await CompanionBackend.discover(settings.companionToken.trim()).catch(() => null)
      if (cancelled || !found) return
      await found.setRoot(project.path).catch(() => undefined)
      if (cancelled) return
      setBackend(found)
      setBackendError(null)
    }, 15_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [backend, activeProjectId, projects, settings.companionToken])

  /** 展开/折叠某个项目的会话列表，与选中状态互不影响 */
  const toggleExpand = useCallback((projectId: string) => {
    setExpandedIds((prev) =>
      prev.includes(projectId) ? prev.filter((id) => id !== projectId) : [...prev, projectId],
    )
  }, [])

  /** 让某个客户端成为当前项目 */
  const adoptProject = useCallback(
    async (next: Backend, project: Project) => {
      setProjects((prev) => upsertProject(prev, { ...project, lastOpenedAt: Date.now() }))
      setActiveProjectId(project.id)
      setExpandedIds((prev) => (prev.includes(project.id) ? prev : [...prev, project.id]))
      setBackend(next)
      setActiveSessionId(null)
      clearSessions()
      await ensureRbcodeDir(next).catch(() => undefined)
      await refreshSessions(next, project.id)
    },
    [clearSessions, refreshSessions],
  )

  /** 打开一个目录作为项目 */
  const openProject = useCallback(async () => {
    setBackendError(null)
    try {
      const wantsCompanion = settings.executor !== 'browser' && settings.companionToken.trim()
      if (wantsCompanion) {
        const companion = await CompanionBackend.discover(settings.companionToken.trim())
        if (companion) {
          setSettingsOpen(false)
          setPickerCompanion(companion)
          return
        }
        if (settings.executor === 'companion') {
          setBackendError(
          t(
            '未发现本机执行器，请先启动 companion 程序。',
            'Local executor not found — start the companion app first.',
            '未發現本機執行器，請先啟動 companion 程式。',
            'ローカル実行環境が見つかりません。先に companion を起動してください。',
          ),
        )
          return
        }
      }

      const next = await BrowserBackend.pick()
      const projectId = `browser:${next.rootLabel}`
      await adoptProject(next, projectFrom({ kind: 'browser', rootLabel: next.rootLabel }, projectId))
      setSettingsOpen(false)
    } catch (err) {
      setBackendError((err as Error).message)
    }
  }, [adoptProject, settings.companionToken, settings.executor])

  /** 目录选择器确认后连上 companion */
  const attachCompanion = useCallback(
    async (companion: CompanionBackend, path: string) => {
      setPickerCompanion(null)
      try {
        await companion.setRoot(path)
      } catch (err) {
        setBackendError(
          t(
            `设置工作目录失败：${(err as Error).message}`,
            `Failed to set the working folder: ${(err as Error).message}`,
            `設定工作目錄失敗：${(err as Error).message}`,
            `作業フォルダの設定に失敗しました: ${(err as Error).message}`,
          ),
        )
        return
      }
      await adoptProject(companion, projectFrom({ kind: 'companion', rootLabel: path }))
    },
    [adoptProject],
  )


  const newChat = useCallback(() => {
    // 只切到空白会话，不打断原来那个（它会在后台继续跑）
    setActiveSessionId(null)
  }, [])

  /**
   * 从某条消息分叉：新建一个会话并切过去。
   * - 从 AI 输出分叉：把这条（最终输出）也带上，新会话从「已完成的回答」接着聊；
   * - 修改消息：不带这一条（它的文字会填回输入框，改完再发）。
   */
  const forkAt = useCallback(
    (messageId: string, editText?: string) => {
      const target = backendRef.current
      const source = agent.messages as Message[]
      const index = source.findIndex((message) => message.id === messageId)
      // 至少要有「该点之前」的内容才有意义
      if (!target || index <= 0) return
      const kept = source
        .slice(0, editText === undefined ? index + 1 : index)
        .map((message) => ({ ...message }))
      const id = crypto.randomUUID()
      sessionMeta.current.set(id, { projectId: activeProjectId, createdAt: Date.now() })
      agent.seedSession(id, kept)
      setActiveSessionId(id)
      if (editText !== undefined) setInputSeed({ id: Date.now(), text: editText })
      // 给新会话打个「分叉」标记（侧栏显示图标）
      void setSessionForked(target, id)
        .then((items) => {
          if (!activeProjectId) return
          setSessionCache((prev) => ({ ...prev, [activeProjectId]: items }))
          setSessionState((prev) =>
            prev.projectId === activeProjectId ? { projectId: activeProjectId, items } : prev,
          )
        })
        .catch(() => undefined)
    },
    [activeProjectId, agent],
  )

  /**
   * 打开一个会话。
   * 点的是别的项目下的会话时，先把那个项目接上（selectProject 会切工作目录、刷新列表），
   * 否则会拿当前项目的后端去读，读不到就静默失败 —— 看起来就像“点了没反应”。
   */
  const openSession = useCallback(
    async (id: string, clickedProjectId?: string, backendOverride?: Backend) => {
      const project = clickedProjectId
        ? (projects.find((item) => item.id === clickedProjectId) ?? null)
        : null
      // backendOverride 是给启动恢复用的：那时刚 setBackend，backendRef 还没跟上
      let target = backendOverride ?? backendRef.current
      if (project && project.id !== projectIdRef.current) {
        target = await selectProject(project)
      }
      if (!target) return
      setSessionLoading({ label: t('读取会话文件…', 'Reading session file…', '讀取工作階段檔案…'), done: 0, total: 0 })
      const session = await loadSession(target, id)
      if (!session) {
        // 会话目录都读不到 —— 多半不是文件丢了，而是本机执行器断了 / 重启后令牌变了，
        // 这时候报「找不到该会话文件」会让人以为数据没了。
        setSessionLoading(null)
        const readable = await sessionsDirReadable(target)
        // 没有活动会话时 agent.setNotice 会被直接丢掉，所以走顶栏那条提示
        setBackendError(
          readable
            ? t(
                `找不到该会话文件：${id}`,
                `Session file not found: ${id}`,
                `找不到該工作階段檔案：${id}`,
              )
            : t(
                '读不到会话目录：本机执行器可能已断开，或它重启后令牌变了。点顶栏的后端徽章重新连接这个项目再试（会话文件本身没丢）。',
                'Cannot read the sessions folder — the local executor may be disconnected, or its token changed after a restart. Reconnect this project from the backend badge and try again (your session files are safe).',
                '讀不到工作階段目錄：本機執行器可能已中斷，或它重啟後權杖變了。點頂欄的後端徽章重新連接這個專案再試（工作階段檔案本身沒丟）。',
              ),
        )
        return
      }
      sessionMeta.current.set(id, {
        projectId: project?.id ?? projectIdRef.current,
        createdAt: session.createdAt,
      })
      setActiveSessionId(id)
      // 会话里只存了图片引用，载入时读回 data URL；读图失败也绝不能影响打开会话
      const hydrated = await hydrateImages(target, session.messages ?? [], (done, total) =>
        setSessionLoading({
          label: t('载入会话图片…', 'Loading session images…', '載入工作階段圖片…'),
          done,
          total,
        }),
      )
        .catch(() => session.messages)
        .finally(() => setSessionLoading(null))
      // 待办跟着会话一起恢复：刷新 / 换执行后端之后还在
      agent.loadMessages(id, hydrated, session.usage, session.todos ?? [])
      // 刚载入的这份就是已落盘状态，别再多写一次
      savedTodos.current = { sessionId: id, todos: session.todos ?? [] }
    },
    [agent, projects, selectProject],
  )

  /** 工作台：切换项目时清空标签页 */
  useEffect(() => {
    setOpenTabs([])
  }, [activeProjectId])

  /** 工作台：当前会话变了就确保它有一个标签页（新会话首次发送、点侧栏会话都走这里） */
  useEffect(() => {
    if (!activeSessionId) return
    setOpenTabs((prev) => (prev.includes(activeSessionId) ? prev : [...prev, activeSessionId]))
  }, [activeSessionId])

  /** 关闭标签页：只关标签，不删会话；关的是当前标签就切到相邻的一个 */
  const closeTab = useCallback(
    (id: string) => {
      const index = openTabs.indexOf(id)
      const next = openTabs.filter((tab) => tab !== id)
      setOpenTabs(next)
      if (id !== activeSessionId) return
      const fallback = next[Math.max(0, index - 1)]
      if (fallback) void openSession(fallback)
      else setActiveSessionId(null)
    },
    [activeSessionId, openTabs, openSession],
  )

  /** 拖动标签排序 */
  const moveTab = useCallback((from: string, to: string) => {
    setOpenTabs((prev) => {
      const fromIndex = prev.indexOf(from)
      const toIndex = prev.indexOf(to)
      if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return prev
      const next = [...prev]
      next.splice(fromIndex, 1)
      next.splice(toIndex, 0, from)
      return next
    })
  }, [])

  /** 拖动调整经典布局里左 / 右两栏的宽度 */
  const startColumnResize = useCallback(
    (event: React.MouseEvent, side: 'left' | 'right') => {
      event.preventDefault()
      const startX = event.clientX
      const startWidth = side === 'left' ? leftWidth : rightWidth
      const onMove = (moveEvent: MouseEvent) => {
        const delta = moveEvent.clientX - startX
        const raw = side === 'left' ? startWidth + delta : startWidth - delta
        const next = Math.min(560, Math.max(180, raw))
        if (side === 'left') setLeftWidth(next)
        else setRightWidth(next)
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.style.userSelect = ''
      }
      document.body.style.userSelect = 'none'
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [leftWidth, rightWidth],
  )

  /** 在某个项目下新建会话（必要时先切到那个项目） */
  const handleNewSession = useCallback(
    async (project: Project) => {
      if (project.id !== projectIdRef.current) await selectProject(project)
      newChat()
    },
    [newChat, selectProject],
  )

  /* --------------------------------- 回收站 --------------------------------- */

  const refreshTrash = useCallback(async () => {
    const target = backendRef.current
    if (!target) {
      setTrash([])
      return
    }
    setTrash(await listTrash(target).catch(() => []))
  }, [])

  useEffect(() => {
    void refreshTrash()
  }, [backend, refreshTrash])

  const restoreFromTrash = useCallback(
    async (id: string) => {
      const target = backendRef.current
      if (!target) return
      await restoreSession(target, id)
      await refreshSessions(target, projectIdRef.current)
      await refreshTrash()
    },
    [refreshSessions, refreshTrash],
  )

  const purgeFromTrash = useCallback(
    async (id: string) => {
      const target = backendRef.current
      if (!target) return
      await purgeTrash(target, id)
      await refreshTrash()
    },
    [refreshTrash],
  )

  const removeSession = useCallback(
    async (id: string) => {
      if (!backend) return
      const items = await deleteSession(backend, id)
      setSessionState({ projectId: activeProjectId, items })
      if (activeProjectId) setSessionCache((prev) => ({ ...prev, [activeProjectId]: items }))
      agent.drop(id)
      setOpenTabs((prev) => prev.filter((tab) => tab !== id))
      if (id === activeSessionId) setActiveSessionId(null)
      void refreshTrash()
    },
    [activeSessionId, activeProjectId, agent, backend, refreshTrash],
  )

  /** 归档会话先弹二次确认（归档进回收站，可找回） */
  const requestRemoveSession = useCallback((id: string) => setPendingDelete(id), [])

  const dropProject = useCallback(
    async (id: string) => {
      const target = projects.find((p) => p.id === id)
      setProjects((prev) => removeProject(prev, id))
      if (target?.backendKind === 'browser') await BrowserBackend.forget(id).catch(() => undefined)
      if (activeProjectId === id) {
        setBackend(null)
        clearSessions()
        setActiveProjectId(null)
        setExpandedIds((prev) => prev.filter((item) => item !== id))
        setActiveSessionId(null)
      }
    },
    [activeProjectId, agent, clearSessions, projects],
  )

  /** 清空「各项目会话索引」的内存缓存与 localStorage（不动磁盘上的 .rbcode） */
  const clearSessionCache = useCallback(() => {
    setSessionCache({})
    try {
      localStorage.removeItem('rbcode.sessionCache.v1')
    } catch {
      // 忽略
    }
  }, [])

  /** 清空项目列表：只删浏览器里的记录与目录授权，不碰磁盘文件与会话数据 */
  const clearProjects = useCallback(() => {
    for (const project of projects) {
      if (project.backendKind === 'browser') {
        void BrowserBackend.forget(browserHandleKey(project.id)).catch(() => undefined)
      }
    }
    sessionMeta.current.clear()
    setProjects([])
    try {
      localStorage.removeItem('rbcode.projects.v1')
    } catch {
      // 忽略
    }
    setBackend(null)
    clearSessions()
    setActiveProjectId(null)
    setExpandedIds([])
    setActiveSessionId(null)
  }, [clearSessions, projects])

  const runCommand = useCallback(
    (text: string) => {
      const name = text.slice(1).split(/\s+/)[0] ?? ''
      switch (name) {
        case 'clear':
          if (activeSessionId) agent.clear(activeSessionId)
          else agent.setNotice(t('当前没有会话可清空', 'No session to clear', '目前沒有工作階段可清空', 'クリアするセッションがありません'))
          break
        case 'new':
          newChat()
          break
        case 'undo': {
          const last = [...agent.messages].reverse().find((m) => m.undoId)
          if (last?.undoId && activeSessionId) void agent.undo(activeSessionId, last.undoId)
          else agent.setNotice(t('没有可撤销的文件改动', 'No file change to undo', '沒有可復原的檔案改動', '元に戻せる変更がありません'))
          break
        }
        case 'compact':
          if (activeSessionId) void agent.compactNow(activeSessionId)
          else agent.setNotice(t('先开始一个会话再压缩', 'Start a session first', '先開始一個工作階段再壓縮', '先にセッションを開始してください'))
          break
        case 'plan':
          setPlanMode((value) => !value)
          break
        case 'stop':
          if (activeSessionId && agent.running) agent.stop(activeSessionId)
          else agent.setNotice(t('当前没有正在生成的回答', 'Nothing is generating right now', '目前沒有正在生成的回答', '現在生成中の応答はありません'))
          break
        case 'export': {
          const markdown = messagesToMarkdown(agent.messages)
          if (!markdown.trim()) {
            agent.setNotice(t('当前会话还没有内容', 'This session is empty', '目前工作階段還沒有內容', 'このセッションはまだ空です'))
            break
          }
          const blob = new Blob([markdown], { type: 'text/markdown' })
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          link.download = `rbcode-session-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`
          link.click()
          URL.revokeObjectURL(url)
          agent.setNotice(t('已导出当前会话为 Markdown', 'Session exported as Markdown', '已匯出目前工作階段為 Markdown', 'セッションを Markdown として書き出しました'))
          break
        }
        case 'copy': {
          const last = [...agent.messages]
            .reverse()
            .find((m) => m.role === 'assistant' && m.content.trim() !== '')
          if (!last) {
            agent.setNotice(t('还没有可复制的回答', 'No reply to copy yet', '還沒有可複製的回答', 'コピーできる回答がありません'))
            break
          }
          void navigator.clipboard.writeText(last.content).then(
            () => agent.setNotice(t('已复制最后一条回答', 'Copied the last reply', '已複製最後一則回答', '最後の回答をコピーしました')),
            () => agent.setNotice(t('复制失败（浏览器未授权剪贴板）', 'Copy failed (clipboard not allowed)', '複製失敗（瀏覽器未授權剪貼簿）', 'コピーに失敗しました（クリップボードが許可されていません）')),
          )
          break
        }
        case 'theme': {
          // 依次轮换：默认 → 浅色 → 极光 → OreUI → 默认
          const order: ThemeMode[] = ['dark', 'light', 'aurora', 'oreui']
          setSettings((prev) => ({
            ...prev,
            theme: order[(order.indexOf(prev.theme) + 1) % order.length],
          }))
          break
        }
        case 'sound':
          setSettings((prev) => ({ ...prev, soundEnabled: !prev.soundEnabled }))
          break
        case 'settings':
          setSettingsOpen(true)
          break
        case 'help':
          agent.setNotice(
            t(
              '可用指令：/clear 清空 ｜ /new 新建 ｜ /undo 撤销改动 ｜ /compact 压缩上下文 ｜ /plan 计划模式 ｜ /stop 停止生成 ｜ /export 导出 Markdown ｜ /copy 复制回答 ｜ /theme 切换主题 ｜ /sound 提示音 ｜ /settings 设置',
              'Commands: /clear ｜ /new ｜ /undo ｜ /compact ｜ /plan ｜ /stop ｜ /export ｜ /copy ｜ /theme ｜ /sound ｜ /settings',
              '可用指令：/clear 清空 ｜ /new 新增 ｜ /undo 復原改動 ｜ /compact 壓縮上下文 ｜ /plan 計畫模式 ｜ /stop 停止生成 ｜ /export 匯出 Markdown ｜ /copy 複製回答 ｜ /theme 切換主題 ｜ /sound 提示音 ｜ /settings 設定',
              'コマンド: /clear ｜ /new ｜ /undo ｜ /compact ｜ /plan ｜ /stop ｜ /export ｜ /copy ｜ /theme ｜ /sound ｜ /settings',
            ),
          )
          break
        default:
          agent.setNotice(
            t(
              `未知指令：/${name}（输入 /help 查看全部）`,
              `Unknown command: /${name} (type /help to see all)`,
              `未知指令：/${name}（輸入 /help 查看全部）`,
              `不明なコマンド: /${name}（/help で一覧を表示）`,
            ),
          )
      }
    },
    [agent, newChat],
  )

  const handleSend = useCallback(
    (text: string, attachments: Attachment[]) => {
      if (text.startsWith('/') && !text.includes(' ')) {
        runCommand(text)
        return
      }
      let target = activeSessionId
      if (!target) {
        target = crypto.randomUUID()
        sessionMeta.current.set(target, { projectId: activeProjectId, createdAt: Date.now() })
        setActiveSessionId(target)
      }
      agent.send(target, text, attachments)
    },
    [activeProjectId, activeSessionId, agent, runCommand],
  )

  // 只有 companion 后端才有终端可以管理
  useEffect(() => {
    if (!backend || backend.kind !== 'companion') {
      setShells([])
      setShellLogs({})
      shellLogsRef.current = {}
      return
    }
    const companion = backend as CompanionBackend
    let cancelled = false
    /** 每条命令已经读到哪个字节，下一轮接着读 */
    const offsets: Record<string, number> = {}
    const poll = async () => {
      let list: RunningShell[]
      try {
        list = await companion.listShells()
      } catch {
        // 执行器可能刚好在重启，忽略这一轮
        return
      }
      if (cancelled) return
      // 界面上只关心还在跑的：结束掉的、被 kill 的、超时的都不放进卡片
      const running = list.filter((item) => item.done !== true)
      setShells(running)
      // 再拉一次增量输出，让终端栏显示「实时输出」而不是干等
      const logs: Record<string, string> = {}
      await Promise.all(
        running.map(async (item) => {
          const offset = offsets[item.id] ?? 0
          try {
            const out = await companion.shellOutput(item.id, offset)
            offsets[item.id] = out.nextOffset
            const prev = shellLogsRef.current[item.id] ?? ''
            // 只留最后 200000 字符（终端要保留足够回滚；太短会频繁整屏重画）
            logs[item.id] = `${prev}${out.output}`.slice(-200_000)
          } catch {
            logs[item.id] = shellLogsRef.current[item.id] ?? ''
          }
        }),
      )
      if (cancelled) return
      shellLogsRef.current = logs
      setShellLogs(logs)
    }
    void poll()
    const timer = setInterval(poll, 1500)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [backend])

  /**
   * 启动时先把「上次在看的那个会话」留给下面的恢复流程，之后才允许状态变化往 localStorage 写。
   * 否则挂载时 activeSessionId 还是 null，这个 effect 会立刻把它删掉，
   * 恢复流程就再也找不到上次的对话了。
   */
  const [booted, setBooted] = useState(false)
  useEffect(() => {
    if (!booted) return
    if (activeSessionId) localStorage.setItem('rbcode.activeSessionId', activeSessionId)
    else localStorage.removeItem('rbcode.activeSessionId')
  }, [activeSessionId, booted])

  /**
   * 启动时把上次的项目重新接上，并打开上次那个对话。
   * 只在首次挂载跑一次：如果放进依赖里，每次打开项目都会再触发一次，
   * 把刚建立的状态（选中会话、消息）冲掉。
   */
  const bootedRef = useRef(false)
  useEffect(() => {
    if (bootedRef.current) return
    bootedRef.current = true
    const savedProjectId = localStorage.getItem('rbcode.activeProjectId')
    const savedSessionId = localStorage.getItem('rbcode.activeSessionId')
    const project = savedProjectId ? projects.find((item) => item.id === savedProjectId) : undefined
    if (!project) {
      setBooted(true)
      return
    }
    void (async () => {
      try {
        const restored = await selectProject(project)
        if (!restored || !savedSessionId) return
        // 带上刚连上的 backend：backendRef 要等下次渲染才更新
        await openSession(savedSessionId, project.id, restored)
      } finally {
        setBooted(true)
      }
    })()
    // 只在挂载时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 启动后顺便把「其它项目」的会话索引也读一遍。
   * 用绝对路径直接读各自工作区的 `.rbcode/sessions/index.json`，
   * 所以不会去改 companion 当前的工作目录；读不到的（没授权、没有索引）就沿用缓存。
   */
  useEffect(() => {
    if (!booted) return
    const others = projects.filter((project) => project.id !== activeProjectId)
    if (others.length === 0) return

    let cancelled = false
    void (async () => {
      const companion = others.some((project) => project.backendKind === 'companion')
        ? await CompanionBackend.discover(settings.companionToken.trim()).catch(() => null)
        : null

      for (const project of others) {
        if (cancelled) return
        try {
          let raw: string
          if (project.backendKind === 'companion') {
            if (!companion) continue
            raw = await companion.readFile(`${project.path}/.rbcode/sessions/index.json`)
          } else {
            const restored = await BrowserBackend.restore(browserHandleKey(project.id))
            if (!restored || !(await restored.ensurePermission(false))) continue
            raw = await restored.readFile('.rbcode/sessions/index.json')
          }
          if (cancelled) return
          const parsed = JSON.parse(raw) as SessionMeta[]
          if (!Array.isArray(parsed)) continue
          setSessionCache((prev) => ({ ...prev, [project.id]: parsed }))
        } catch {
          // 这个项目暂时读不到（没有 .rbcode / 索引缺失 / 没授权），保留现有缓存
        }
      }
    })()

    return () => {
      cancelled = true
    }
    // boot 完成后跑一次即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booted])

  /** 右键会话：归档 / 置顶（只影响本项目列表）/ 重命名 */
  const openSessionMenu = useCallback(
    (event: React.MouseEvent, session: SessionMeta, projectId: string) => {
      event.preventDefault()
      const pinned = !!session.pinnedAt
      const apply = (task: (target: Backend) => Promise<unknown>) => {
        const target = backend
        if (!target) return
        void (async () => {
          try {
            await task(target)
            await refreshSessions(target, projectId)
          } catch (err) {
            setBackendError(
              t(
                `操作失败：${(err as Error).message}`,
                `Operation failed: ${(err as Error).message}`,
                `操作失敗：${(err as Error).message}`,
                `操作に失敗しました: ${(err as Error).message}`,
              ),
            )
          }
        })()
      }
      setMenu({
        x: event.clientX,
        y: event.clientY,
        items: [
          {
            label: t('app.rename'),
            onClick: () => {
              const input = window.prompt(t('app.renameSession'), session.title)
              if (input === null) return
              const title = input.trim()
              if (!title || title === session.title) return
              apply((target) => renameSession(target, session.id, title))
            },
          },
          {
            label: pinned ? t('app.unpin') : t('app.pin'),
            onClick: () => apply((target) => setSessionPinned(target, session.id, !pinned)),
          },
          { label: '', separator: true, onClick: () => {} },
          {
            label: t('app.deleteSession'),
            danger: true,
            // 走确认 + 回收站流程（会同步缓存、丢掉运行里的那个会话）
            onClick: () => requestRemoveSession(session.id),
          },
        ],
      })
    },
    [backend, refreshSessions, requestRemoveSession],
  )

  /** 磁盘上扫到、还没导入过的外部会话（有就弹窗让用户挑） */
  const [importCandidates, setImportCandidates] = useState<ImportCandidate[]>([])
  /** 导入弹窗对应的项目：右键手动触发时可能不是当前项目 */
  const [importProject, setImportProject] = useState<Project | null>(null)

  /** 扫磁盘上属于某个项目的外部会话（自动扫描和右键「导入」共用） */
  const scanImportCandidates = useCallback(
    async (project: Project, onlyFresh: boolean, quiet = false): Promise<ImportCandidate[]> => {
      const target = backend
      if (!target || target.kind !== 'companion') {
        if (!quiet) {
          setBackendError(
            t(
              '只有本机执行器能读取磁盘上的会话（浏览器沙箱读不到本机文件）。',
              'Reading sessions from disk needs the local executor (the browser sandbox cannot).',
              '只有本機執行器能讀取磁碟上的工作階段（瀏覽器沙箱讀不到本機檔案）。',
              'ディスク上のセッションを読むには本機実行器が必要です。',
            ),
          )
        }
        return []
      }
      if (!target.paths) {
        if (!quiet) {
          setBackendError(
            t(
              '要读取磁盘上的会话，需要更新版本机执行器（装好配套程序后重新打开本项目）。',
              'Reading sessions from disk needs an updated companion — install it and reopen this project.',
              '要讀取磁碟上的工作階段，需要更新版本機執行器（裝好配套程式後重新開啟本專案）。',
              'ディスク上のセッションを読むには companion の更新が必要です。',
            ),
          )
        }
        return []
      }
      const paths = await target.paths()
      const marker = await loadImportMarker(target)
      const found = await findImportCandidates(target, paths, project.path, settings.importScope)
      return onlyFresh ? found.filter((candidate) => !marker[candidate.key]) : found
    },
    [backend, settings.importScope, t],
  )

  /** 右键项目 →「导入 Reasonix 会话」：手动扫一次，把结果丢给导入弹窗 */
  const openImportFor = useCallback(
    async (project: Project) => {
      setBackendError(null)
      try {
        const found = await scanImportCandidates(project, true)
        if (found.length === 0) {
          setBackendError(
            t(
              '没有发现新的可导入会话（该项目里没有 .reasonix，或者都已经导入过了）。',
              'No new sessions to import (no .reasonix in this project, or everything was already imported).',
              '沒有發現新的可匯入工作階段（該專案沒有 .reasonix，或都已經匯入過）。',
            ),
          )
          return
        }
        setImportProject(project)
        setImportCandidates(found)
      } catch (err) {
        setBackendError(
          t(
            `扫描可导入会话失败：${(err as Error).message}`,
            `Failed to scan for importable sessions: ${(err as Error).message}`,
            `掃描可匯入工作階段失敗：${(err as Error).message}`,
          ),
        )
      }
    },
    [scanImportCandidates],
  )

  /** 右键项目：归档记录（不动磁盘）/ 置顶 / 在文件资源管理器显示 */
  const openProjectMenu = useCallback(
    (event: React.MouseEvent, project: Project) => {
      event.preventDefault()
      const pinned = !!project.pinnedAt
      setMenu({
        x: event.clientX,
        y: event.clientY,
        items: [
          {
            label: t('app.reveal'),
            onClick: () => {
              const target = backend
              if (!target || target.kind !== 'companion') {
                setBackendError(t('app.revealOnlyCompanion'))
                return
              }
              // 手机端：交给浏览器/WebView 打开这个路径（file:// 让系统处理），不走后端 Intent
              if ((target as CompanionBackend).platform === 'android') {
                window.open(`file://${project.path}`, '_blank')
                return
              }
              void (target as CompanionBackend)
                .reveal(project.path)
                .catch((err: Error) =>
                  setBackendError(
                    t(
                      `打开失败：${err.message}`,
                      `Failed to open: ${err.message}`,
                      `開啟失敗：${err.message}`,
                      `開くのに失敗しました: ${err.message}`,
                    ),
                  ),
                )
            },
          },
          {
            label: t(
              '导入 Reasonix 会话',
              'Import Reasonix sessions',
              '匯入 Reasonix 工作階段',
              'Reasonix セッションを読み込む',
            ),
            onClick: () => void openImportFor(project),
          },
          {
            label: pinned ? t('app.unpin') : t('app.pinProject'),
            onClick: () => setProjects((prev) => setProjectPinned(prev, project.id, !pinned)),
          },
          { label: '', separator: true, onClick: () => {} },
          {
            label: t('app.removeProject'),
            danger: true,
            onClick: () => void dropProject(project.id),
          },
        ],
      })
    },
    [backend, dropProject, openImportFor],
  )

  const killShell = useCallback(
    async (id: string) => {
      if (!backend || backend.kind !== 'companion') return
      try {
        await (backend as CompanionBackend).killShell(id)
        // 轮询那边只收「还在跑」的命令，所以这里直接移除即可，下一轮不会再拉回来。
        setShells((prev) => prev.filter((item) => item.id !== id))
      } catch (err) {
        setBackendError(
          t(
            `结束命令失败：${(err as Error).message}`,
            `Failed to stop the command: ${(err as Error).message}`,
            `結束命令失敗：${(err as Error).message}`,
            `コマンドの停止に失敗しました: ${(err as Error).message}`,
          ),
        )
      }
    },
    [backend],
  )

  /** 打开（或复用）常驻会话终端：一直开着，手动关才没 */
  const openConsole = useCallback(async () => {
    if (!backend || backend.kind !== 'companion') return
    const companion = backend as CompanionBackend
    if (!companion.openConsole) return
    try {
      const info = await companion.openConsole(activeSessionId ?? undefined)
      // Windows 的 cmd 默认会把读到的输入行回显出来，和我们的本地回显重复；
      // 关掉它（实测 echo off 之后就不再回显）。
      if (companion.platform === 'windows' && companion.writeShell) {
        await companion.writeShell(info.id, 'echo off\r\n', activeSessionId ?? undefined)
      }
    } catch (err) {
      setBackendError(
        t(
          `打开会话终端失败：${(err as Error).message}`,
          `Failed to open the console: ${(err as Error).message}`,
          `開啟會話終端失敗：${(err as Error).message}`,
        ),
      )
    }
  }, [backend, activeSessionId])

  /** 往会话终端写一条命令 */
  const writeConsole = useCallback(
    async (id: string, data: string) => {
      if (!backend || backend.kind !== 'companion') return
      const companion = backend as CompanionBackend
      if (!companion.writeShell) return
      try {
        // xterm 回车只给 \r；cmd 的 stdin 不认单个 \r（会当续行，命令不执行），
        // Linux/guest 的 sh 则不认 \r\n。按平台规范成正确的行结束符。
        const platform = companion.platform
        const toLf = data.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
        const normalized =
          platform === 'windows'
            ? toLf.replace(/\n/g, '\r\n')
            : toLf
        await companion.writeShell(id, normalized, activeSessionId ?? undefined)
      } catch (err) {
        setBackendError(
          t(
            `写入会话终端失败：${(err as Error).message}`,
            `Failed to write to the console: ${(err as Error).message}`,
            `寫入會話終端失敗：${(err as Error).message}`,
          ),
        )
      }
    },
    [backend, activeSessionId],
  )

  /** 在会话界面直接换后端：项目 id 不变，所以 .rbcode 里的会话是共享的 */
  const switchBackend = useCallback(
    async (kind: 'browser' | 'companion') => {
      const project = projects.find((p) => p.id === activeProjectId)
      setBackendMenuOpen(false)
      setBackendError(null)

      if (kind === 'browser') {
        const key = project ? browserHandleKey(project.id) : 'default'
        try {
          const restored = await BrowserBackend.restore(key)
          if (restored && (await restored.ensurePermission(true))) {
            setBackend(restored)
            setProjects((prev) =>
              project ? upsertProject(prev, { ...project, backendKind: 'browser' }) : prev,
            )
            await refreshSessions(restored, project?.id ?? null)
            return
          }
          const picked = await BrowserBackend.pick(key)
          setBackend(picked)
          setProjects((prev) =>
            project ? upsertProject(prev, { ...project, backendKind: 'browser' }) : prev,
          )
          await refreshSessions(picked, project?.id ?? null)
        } catch (err) {
          setBackendError((err as Error).message)
        }
        return
      }

      const companion = await CompanionBackend.discover(settings.companionToken.trim())
      if (!companion) {
        setBackendError(
            t(
              '未发现本机执行器，请先启动 companion 并在设置里填入配对令牌。',
              'Local executor not found — start the companion app and enter its token in Settings.',
              '未發現本機執行器，請先啟動 companion 並在設定裡填入配對權杖。',
              'ローカル実行環境が見つかりません。companion を起動し、設定でトークンを入力してください。',
            ),
          )
        return
      }
      // 项目里有绝对路径就直接切过去，否则让用户选目录
      const hasAbsolutePath = /^[a-zA-Z]:[\\/]/.test(project?.path ?? '')
      if (project && hasAbsolutePath) {
        try {
          await companion.setRoot(project.path)
        } catch (err) {
          setBackendError(
          t(
            `切换工作目录失败：${(err as Error).message}`,
            `Failed to switch the working folder: ${(err as Error).message}`,
            `切換工作目錄失敗：${(err as Error).message}`,
            `作業フォルダの切り替えに失敗しました: ${(err as Error).message}`,
          ),
        )
          return
        }
        setBackend(companion)
        setProjects((prev) => upsertProject(prev, { ...project, backendKind: 'companion' }))
        await refreshSessions(companion, project.id)
        return
      }
      setPickerCompanion(companion)
    },
    [activeProjectId, projects, refreshSessions, settings.companionToken],
  )

  const ready = backend !== null && settings.activeModel !== ''
  const hint = !backend
    ? t('app.hintOpenProject')
    : t('app.hintPickModel')

  const emptyHint = backend ? t('app.emptyProject') : t('app.emptyNoProject')

  const backendLabel = backend
    ? `${backendName(backend.kind)}${backend.rootLabel ? ` · ${backend.rootLabel}` : ''}`
    : t('app.notConnected')

  // 右栏统计只算真正发给模型的历史（压缩归档的、仅界面展示的都不算）
  const contextMessages = useMemo(
    () =>
      (agent.messages as Message[]).filter(
        (message) => !message.compacted && !message.uiOnly,
      ),
    [agent.messages],
  )

  /**
   * 速度是「最近几秒」的瞬时值，得有人推着重算：跑着的时候每秒 tick 一次，
   * 这样空闲（在跑工具 / 等审批）时数字会自己掉下来，而不是停在上一次的值。
   */
  const [speedTick, setSpeedTick] = useState(0)
  useEffect(() => {
    if (!agent.running) return
    const timer = setInterval(() => setSpeedTick((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [agent.running])

  /** 工作台底部状态栏：按设置挑出要显示的项，算好值再渲染 */

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null

  const statusBarEntries = useMemo(() => {
    const now = Date.now()
    const used = estimateTokens(contextMessages)
    const thresholdAt = Math.round((settings.contextWindow * settings.compactThreshold) / 100)
    const hitRate =
      agent.usage.promptTokens > 0
        ? (agent.usage.cachedTokens / agent.usage.promptTokens) * 100
        : null
    // 当前速度：只看最近几秒收到的 token（滑动窗口）。工具执行、等审批、等用户回答
    // ask 这些空闲时间会自然滑出窗口，所以不会被平均拖低；没在生成时显示 "-" 占位。
    const speed = agent.running ? formatSpeed(agent.speed()) : SPEED_PLACEHOLDER
    const todosDone = agent.todos.filter((todo) => todo.status === 'completed').length
    const runningShells = shells.filter((shell) => shell.done !== true).length
    // 固定尺寸的图标盒：SVG 默认是 inline，会按文字基线对齐、和旁边文字不在一条水平线上
    const icon = (id: StatusItemId) => (
      <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-neutral-500">
        <StatusItemIcon id={id} className="h-3 w-3" />
      </span>
    )

    const defs: Record<StatusItemId, { icon: React.ReactNode; value: string | null }> = {
      project: { icon: icon('project'), value: activeProject?.name ?? null },
      backend: {
        icon: icon('backend'),
        value: backend ? backend.label : null,
      },
      model: {
        icon: icon('model'),
        value: settings.activeModel || null,
      },
      permission: {
        icon: icon('permission'),
        value: permissionLabel(settings.permission),
      },
      reasoning: {
        icon: icon('reasoning'),
        value: REASONING_EFFORT_LABEL[settings.reasoningEffort],
      },
      cacheHit: {
        icon: icon('cacheHit'),
        value: hitRate === null ? null : `${hitRate.toFixed(1)}%`,
      },
      contextUsed: { icon: icon('contextUsed'), value: formatTokens(used) },
      contextTotal: {
        icon: icon('contextTotal'),
        value: formatTokens(settings.contextWindow),
      },
      untilCompact: {
        icon: icon('untilCompact'),
        value: formatTokens(Math.max(0, thresholdAt - used)),
      },
      compactThreshold: {
        icon: icon('compactThreshold'),
        value: `${settings.compactThreshold}%`,
      },
      speed: {
        icon: icon('speed'),
        // 没有实时速率就是 "-"（不隐藏、也不显示 0.0）
        value: speed,
      },
      outputTokens: {
        icon: icon('outputTokens'),
        value: formatTokens(agent.usage.completionTokens),
      },
      requests: { icon: icon('requests'), value: String(agent.usage.requests) },
      rounds: { icon: icon('rounds'), value: String(agent.rounds) },
      messages: {
        icon: icon('messages'),
        value: String(agent.messages.length),
      },
      todos: {
        icon: icon('todos'),
        value: agent.todos.length > 0 ? `${todosDone}/${agent.todos.length}` : null,
      },
      elapsed: {
        icon: icon('elapsed'),
        value: agent.startedAt ? formatDuration(agent.startedAt, now) : null,
      },
      shells: {
        icon: icon('shells'),
        value: runningShells > 0 ? String(runningShells) : null,
      },
    }

    return settings.statusItems
      .map((id) => ({ id, ...defs[id] }))
      .filter((entry) => entry.value !== null)
  }, [
    activeProject,
    agent.messages,
    agent.rounds,
    agent.startedAt,
    agent.todos,
    agent.usage,
    backend,
    contextMessages,
    settings.activeModel,
    settings.compactThreshold,
    settings.contextWindow,
    settings.permission,
    settings.reasoningEffort,
    settings.statusItems,
    shells,
    // 速度是滑动窗口的瞬时值：每秒 tick 一次逼它重算（含衰减）
    speedTick,
  ])

  // 会话 id → 标题：终端卡片用它标注后台命令是哪个会话起的
  const sessionTitles: Record<string, string> = {}
  for (const items of Object.values(sessionCache)) {
    for (const item of items) sessionTitles[item.id] = item.title
  }
  for (const item of sessions) sessionTitles[item.id] = item.title

  const workbench = settings.layout === 'workbench'
  /**
   * 手机端：不再渲染三栏，左右两栏收进抽屉，中栏占满整屏。
   * 顶部也复用工作台那条「菜单 / 标签 / 右栏」的顶栏。
   */
  const isMobile = useIsMobile()
  const drawers = workbench || isMobile

  /* ------------------------------ 右侧标签栏 ------------------------------ */

  useEffect(() => {
    try {
      localStorage.setItem('rbcode.dockTabs', JSON.stringify(dockTabs))
      localStorage.setItem('rbcode.dockActive', activeDock ?? '')
    } catch {
      // 存不进去也不影响使用
    }
  }, [dockTabs, activeDock])

  /** 「上下文」和「终端」两个面板共用同一份数据 */
  const inspectorProps = {
    messages: contextMessages,
    contextWindow: settings.contextWindow,
    compactThreshold: settings.compactThreshold,
    running: agent.running,
    rounds: agent.rounds,
    requests: agent.usage.requests,
    usage: agent.usage,
    modelName: settings.activeModel,
    backendLabel,
    startedAt: agent.startedAt,
    shells,
    shellLogs,
    activeSessionId,
    sessionTitles,
    onKillShell: killShell,
    onOpenConsole: openConsole,
    onWriteConsole: writeConsole,
    onChangeThreshold: (next: number) =>
      setSettings((prev) => ({ ...prev, compactThreshold: next })),
  }

  const renderDockPanel = (id: DockPanelId) => {
    if (id === 'context' || id === 'terminals') {
      return <InspectorPanel embedded view={id} {...inspectorProps} />
    }
    if (id === 'music') return <MusicPanel backend={backend} settings={settings} />
    if (id === 'files') {
      return <FilesPanel backend={backend} rootLabel={backend?.rootLabel ?? ''} />
    }
    return <TodosPanel todos={agent.todos} />
  }

  const dockProps = {
    open: dockTabs,
    active: activeDock,
    onSelect: (id: DockPanelId) => setActiveDock(id),
    onOpen: (id: DockPanelId) => {
      setDockTabs((prev) => (prev.includes(id) ? prev : [...prev, id]))
      setActiveDock(id)
    },
    onClose: (id: DockPanelId) => {
      const next = dockTabs.filter((item) => item !== id)
      // 至少留一个面板，不然右边会全空
      if (next.length === 0) return
      setDockTabs(next)
      if (activeDock === id) setActiveDock(next[next.length - 1] ?? null)
    },
    onMove: (from: DockPanelId, to: DockPanelId) => {
      setDockTabs((prev) => {
        const fromIndex = prev.indexOf(from)
        const toIndex = prev.indexOf(to)
        if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return prev
        const next = [...prev]
        const [moved] = next.splice(fromIndex, 1)
        if (!moved) return prev
        next.splice(toIndex, 0, moved)
        return next
      })
    },
    renderPanel: renderDockPanel,
  }

  /* ------------------------------- 悬浮窗 ------------------------------- */

  /**
   * 主对话区（消息列表）。网页版和悬浮窗用的是**同一份 JSX**，props 也一模一样，
   * 所以思考折叠、工具卡片、撤销、自动翻滚这些行为两边永远一致，不会各写一套再走样。
   */
  const conversation = (
    <MessageList
      key={activeSessionId ?? 'empty'}
      messages={agent.messages}
      running={agent.running}
      undone={agent.undone}
      toolDraft={agent.toolDraft}
      onUndo={(undoId) => activeSessionId && agent.undo(activeSessionId, undoId)}
      emptyHint={emptyHint}
      reasoningExpanded={settings.reasoningExpanded}
      onForkMessage={(messageId: string) => forkAt(messageId)}
      onEditMessage={(message: Message) => forkAt(message.id, message.content)}
      onRevertMessage={(messageId: string, scope: 'conversation' | 'files' | 'both') => {
        if (activeSessionId) void agent.revert(activeSessionId, messageId, scope)
      }}
      compactActivity={settings.activityMode !== 'default'}
      resultOnly={settings.activityMode === 'result'}
      speech={{ enabled: settings.voiceOutput, rate: settings.voiceRate, voiceName: settings.voiceName }}
    />
  )

  const closeFloating = useCallback(() => {
    setSettings((prev) => ({ ...prev, floatingWindow: false }))
  }, [])

  /** 已经落盘过的待办：只在引用真的变化时才写，避免每个流式分片都写一遍 */
  const savedTodos = useRef<{ sessionId: string; todos: Todo[] | null }>({
    sessionId: '',
    todos: null,
  })

  /* ------------------------------ 兼容导入 ------------------------------ */

  const scannedForImport = useRef(new Set<string>())

  useEffect(() => {
    const project = activeProject
    const target = backend
    if (!project || !target) return
    const scanKey = `${project.id}:${settings.importScope}`
    if (scannedForImport.current.has(scanKey)) return
    scannedForImport.current.add(scanKey)
    void (async () => {
      try {
        // 只对带 .reasonix 的项目自动弹；想手动触发就右键项目 →「导入 Reasonix 会话」
        if (!(await target.exists(`${project.path}/.reasonix`))) return
        const fresh = await scanImportCandidates(project, true)
        if (fresh.length > 0) {
          setImportProject(project)
          setImportCandidates(fresh)
        }
      } catch {
        // 扫不动就当没有，别打扰用户
      }
    })()
  }, [activeProject, backend, settings.importScope, scanImportCandidates])

  /** 后端徽章（经典头部与工作台顶栏共用同一份，避免重复） */
  const backendBadge = (
    <div className="relative min-w-0">
      <Tooltip label={t('app.backendSwitch')}>
        <button
          onClick={() => setBackendMenuOpen((v) => !v)}
          className="inline-flex h-7 min-w-0 max-w-[46vw] items-center gap-1.5 rounded-md px-2 text-xs text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200 sm:max-w-none"
        >
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${backend ? 'bg-emerald-500' : 'bg-amber-500'}`}
          />
          <span className="min-w-0 max-w-full truncate sm:max-w-64">
            {isMobile && backend ? backendName(backend.kind) : backendLabel}
          </span>
          <ChevronRightIcon
            className={`h-3 w-3 shrink-0 transition-transform ${
              backendMenuOpen ? '-rotate-90' : 'rotate-90'
            }`}
          />
        </button>
      </Tooltip>
      {backendMenuOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setBackendMenuOpen(false)} />
          <div className="rb-menu anim-pop absolute top-full right-0 z-20 mt-1 w-64 rounded-lg border border-neutral-700 p-1 shadow-xl">
            <button onClick={() => void switchBackend('browser')}
              className="block w-full rounded px-2.5 py-1.5 text-left text-xs text-neutral-300 hover:bg-neutral-800"
            >
              {backendName('browser')}
              <span className="mt-0.5 block text-[10px] text-neutral-600">
                {t('app.browserSandboxHint')}
              </span>
            </button>
            <button onClick={() => void switchBackend('companion')}
              className="block w-full rounded px-2.5 py-1.5 text-left text-xs text-neutral-300 transition-colors hover:bg-neutral-800"
            >
              {backendName('companion')}
              <span className="mt-0.5 block text-[10px] text-neutral-600">
                {t('app.localExecutorHint')}
              </span>
            </button>
          </div>
        </>
      )}
    </div>
  )

  return (
    <div className={`rb-app-bg flex h-full bg-neutral-950 text-neutral-100${workbench ? ' rb-workbench' : ''}${isMobile ? ' rb-mobile' : ''}${settings.flatBorders && settings.theme !== 'oreui' ? ' rb-flat' : ''}`}>
      {/* 极光主题的背景（WebGL 着色器；其它主题下不运行） */}
      <div className="rb-aurora" aria-hidden="true">
        {settings.theme === 'aurora' && (
          <AuroraBackground active colors={AURORA_PALETTE[settings.color] ?? AURORA_PALETTE.default} />
        )}
      </div>

      {!drawers && (
        <>
          <Sidebar
            projects={projects}
            activeProjectId={activeProjectId}
            expandedIds={expandedIds}
            sessions={sessions}
            sessionCache={sessionCache}
            runningSessionIds={agent.runningSessionIds}
            activeSessionId={activeSessionId}
            loadingSessions={loadingSessions}
            onNewChat={newChat}
            onOpenProject={openProject}
            onSelectProject={selectProject}
            onToggleExpand={toggleExpand}
            onSelectSession={openSession}
            onDeleteSession={requestRemoveSession}
            onRemoveProject={dropProject}
            onOpenSettings={() => setSettingsOpen(true)}
            onSessionMenu={openSessionMenu}
            onProjectMenu={openProjectMenu}
            onNewSession={handleNewSession}
            onOpenTrash={() => setTrashOpen(true)}
            trashCount={trash.length}
            width={leftWidth}
          />
          <div
            onMouseDown={(event) => startColumnResize(event, 'left')}
            title={t('拖动调整宽度', 'Drag to resize', '拖曳調整寬度', 'ドラッグで幅を調整')}
            className="w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-amber-500/40"
          />
        </>
      )}

      <main className="rb-main flex min-w-0 flex-1 flex-col">
        {drawers ? (
          <div className="flex items-center gap-1 border-b border-neutral-800 px-2 py-1.5">
            <Tooltip label={t('项目与会话', 'Projects & sessions', '專案與工作階段', 'プロジェクトとセッション')}>
              <button
                onClick={() => setLeftDrawerOpen(true)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
              >
                <MenuIcon className="h-4 w-4" />
              </button>
            </Tooltip>
            <Tooltip label={t('上下文与终端', 'Context & terminals', '上下文與終端', 'コンテキストとターミナル')}>
              <button
                onClick={() => setRightDrawerOpen(true)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
              >
                <GridIcon className="h-4 w-4" />
              </button>
            </Tooltip>

            <div className="mx-1 h-5 w-px shrink-0 bg-neutral-800" />

            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
              {openTabs.map((id) => {
                const active = id === activeSessionId
                return (
                  <div
                    key={id}
                    draggable
                    onDragStart={() => setDragTabId(id)}
                    onDragOver={(e) => {
                      e.preventDefault()
                      if (dragTabId && dragTabId !== id) moveTab(dragTabId, id)
                    }}
                    onDragEnd={() => setDragTabId(null)}
                    onClick={() => void openSession(id, activeProjectId ?? undefined)}
                    className={`group flex max-w-40 shrink-0 cursor-grab items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors active:cursor-grabbing md:max-w-60 ${
                      dragTabId === id ? 'opacity-50' : ''
                    } ${
                      active
                        ? 'bg-neutral-800 text-neutral-100'
                        : 'text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-200'
                    }`}
                  >
                    <span className="min-w-0 truncate">
                      {sessionTitles[id] ?? t('会话', 'Session', '工作階段', 'セッション')}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        closeTab(id)
                      }}
                      title={t('关闭标签', 'Close tab', '關閉分頁', 'タブを閉じる')}
                      className={`rb-nohover shrink-0 text-neutral-500 transition-opacity hover:text-neutral-200 ${
                        isMobile && active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                      }`}
                    >
                      <XIcon className="h-3 w-3" />
                    </button>
                  </div>
                )
              })}
              {!activeSessionId && (
                <div className="flex max-w-40 shrink-0 items-center rounded-md bg-neutral-800 px-2.5 py-1 text-xs text-neutral-100 md:max-w-60">
                  {t('新会话', 'New session', '新增工作階段', '新しいセッション')}
                </div>
              )}
              <button
                onClick={newChat}
                title={t('新会话', 'New session', '新增工作階段', '新しいセッション')}
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
              >
                <PlusIcon className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {backendBadge}
            </div>
          </div>
        ) : (
          <header className="flex items-center gap-2 border-b border-neutral-800 px-4 py-2">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <h1 className="shrink-0 truncate text-sm leading-5 font-semibold">
                {activeProject?.name ?? 'RB Code'}
              </h1>
              {activeProject && (
                <span
                  className="min-w-0 truncate font-mono text-xs leading-5 text-neutral-500"
                  title={activeProject.path}
                >
                  {activeProject.path}
                </span>
              )}
              {backendBadge}
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {provider && (
                <span className="flex h-7 items-center rounded-md bg-neutral-800/60 px-2 text-xs leading-none text-neutral-400">
                  {provider.name}
                </span>
              )}
            </div>
          </header>
        )}

        {backendError && (
          <div
            key="backend-error"
            className="border-b border-amber-900/50 bg-amber-950/30 px-4 py-1.5 text-xs text-amber-300"
          >
            {backendError}
          </div>
        )}

        {agent.notice && (
          <div key="agent-notice" className="flex justify-center px-4 pt-2">
            <div className="anim-pop flex max-w-2xl items-center gap-2 rounded-full border border-emerald-800/60 bg-emerald-950/70 px-3.5 py-1.5 text-xs text-emerald-200 shadow-lg backdrop-blur">
              <span className="min-w-0 truncate">{agent.notice}</span>
              <button
                onClick={agent.clearNotice}
                aria-label={t('app.close')}
                title={t('app.close')}
                className="shrink-0 rounded-full p-0.5 text-emerald-300/70 transition-colors hover:bg-emerald-900/70 hover:text-emerald-100"
              >
                <XIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        {appNotice && (
          <div key="app-notice" className="flex justify-center px-3 pt-2">
            <div className="anim-pop flex w-full max-w-xl items-center gap-2 rounded-2xl border border-amber-800/60 bg-amber-950/70 px-3.5 py-2 text-xs text-amber-200 shadow-lg backdrop-blur">
              <span className="min-w-0 flex-1 break-words">{appNotice}</span>
              <OreButton
                status="green"
                onClick={() => setSettingsOpen(true)}
                className="shrink-0 rounded-full border border-amber-700/70 px-2 py-0.5 text-amber-100 transition-colors hover:bg-amber-900/60"
              >
                {t('打开设置', 'Open settings', '開啟設定', '設定を開く')}
              </OreButton>
              <button
                onClick={() => setAppNotice(null)}
                aria-label={t('app.close')}
                title={t('app.close')}
                className="shrink-0 rounded-full p-0.5 text-amber-300/70 transition-colors hover:bg-amber-900/70 hover:text-amber-100"
              >
                <XIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        {conversation}

        {/* 权限审批：贴在输入框上方 */}
        <ApprovalPanel
          key="approval"
          request={pendingApproval?.request ?? null}
          timeoutSeconds={settings.approvalTimeout}
          liveDetail={
            pendingApproval && agent.toolDraft && agent.toolDraft.name === pendingApproval.request.tool
              ? agent.toolDraft.argsSoFar.slice(0, 3000)
              : null
          }
          onDecide={decideApproval}
        />

        {/* 模型的提问：贴在输入框上方 */}
        <AskPanel key="ask" request={pendingAsk} onAnswer={answerAsk} />

        {/* 计划模式下列出计划后，让用户决定是否开干 */}
        {planMode && !agent.running && agent.todos.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t border-amber-900/60 bg-amber-950/30 px-4 py-2">
            <ClipboardListIcon className="h-4 w-4 shrink-0 text-amber-400" />
            <span className="text-xs text-amber-200">
              {t(
                `计划已列出（${agent.todos.length} 步），确认后开始执行吗？`,
                `Plan ready (${agent.todos.length} steps) — start executing?`,
                `計畫已列出（${agent.todos.length} 步），確認後開始執行嗎？`,
                `計画を提示しました（${agent.todos.length} ステップ）。実行を開始しますか？`,
              )}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <OreButton
                status="green"
                onClick={approvePlan}
                className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-500"
              >
                <PlayIcon className="h-3.5 w-3.5" />
                {t('开始执行', 'Start', '開始執行', '実行する')}
              </OreButton>
              <OreButton
                status="normal"
                onClick={revisePlan}
                className="inline-flex items-center gap-1.5 rounded-md border border-amber-800/70 px-3 py-1 text-xs text-amber-200 hover:border-amber-600"
              >
                <PencilIcon className="h-3.5 w-3.5" />
                {t('修改计划', 'Revise plan', '修改計畫', '計画を修正')}
              </OreButton>
            </div>
          </div>
        )}

        {/* 手机上待办一展开就会把输入框上方的「待发送队列」挤出屏幕，
            所以有待发送消息时先把待办收起来 */}
        {!todosHidden && (
          <TodoPanel
            todos={agent.todos}
            collapsed={todosCollapsed || (isMobile && agent.queue.length > 0)}
            onToggle={() => setTodosCollapsed((v) => !v)}
            onClose={() => setTodosHidden(true)}
          />
        )}
        {todosHidden && agent.todos.length > 0 && (
          <div className="px-4 pt-1">
            <div className="mx-auto max-w-3xl">
              <button type="button"
                onClick={() => setTodosHidden(false)}
                className="inline-flex items-center gap-1 rounded-full border border-neutral-800 px-2.5 py-0.5 text-[10px] text-neutral-500 transition-colors hover:text-neutral-300"
              >
                <ChevronRightIcon className="h-2.5 w-2.5" />
                {t('显示计划清单', 'Show plan', '顯示計畫清單')}
              </button>
            </div>
          </div>
        )}

        <Composer
          disabled={!ready}
          disabledHint={hint}
          running={agent.running}
          compacting={agent.compacting}
          backend={backend}
          permission={settings.permission}
          planMode={planMode}
          onTogglePlan={() => setPlanMode((v) => !v)}
          providers={settings.providers}
          activeProviderId={settings.activeProviderId}
          activeModel={settings.activeModel}
          reasoningEffort={settings.reasoningEffort}
          onSelectModel={(providerId, modelId) =>
            setSettings((prev) => ({ ...prev, activeProviderId: providerId, activeModel: modelId }))
          }
          onReasoningChange={(effort) =>
            setSettings((prev) => ({ ...prev, reasoningEffort: effort }))
          }
          queue={agent.queue}
          onSend={handleSend}
          onStop={() => {
            if (activeSessionId) agent.stop(activeSessionId)
            resolvePendingApprovals(false)
          }}
          onPermissionChange={(mode) => {
            setSettings((prev) => ({ ...prev, permission: mode }))
            // 切到「完全」时，已经弹出来的审批就别再问了（agent 那边也是实时读权限的）
            if (mode === 'full') resolvePendingApprovals(true)
          }}
          onOpenSettings={() => setSettingsOpen(true)}
          onRemoveQueued={(id) => activeSessionId && agent.removeQueued(activeSessionId, id)}
          onInsertNow={(id) => activeSessionId && agent.insertNow(activeSessionId, id)}
          inputSeed={inputSeed}
          voiceInput={settings.voiceInput}
        />

        {(settings.statusBar ?? true) && (
          <div className="flex items-center gap-3 overflow-x-auto border-t border-neutral-800 px-3 py-1 text-[11px] leading-none text-neutral-600">
            {statusBarEntries.length === 0 && (
              <span className="shrink-0 text-neutral-700">
                {t(
                  '状态栏没显示任何项（设置 → 个性化 → 状态栏）',
                  'Nothing shown in the status bar (Settings → Personalization → Status bar)',
                  '狀態欄沒有顯示任何項目（設定 → 個人化 → 狀態欄）',
                  'ステータスバーに表示する項目がありません（設定 → 個人化 → ステータスバー）',
                )}
              </span>
            )}
            {statusBarEntries.map((entry) => (
              <span
                key={entry.id}
                className="inline-flex h-4 shrink-0 items-center gap-1.5 leading-none"
              >
                {entry.icon}
                {settings.statusStyle === 'text' && (
                  <span className="leading-none text-neutral-500">
                    {t(STATUS_ITEM_LABEL[entry.id])}
                  </span>
                )}
                <span className="font-mono leading-none tabular-nums text-neutral-400">
                  {entry.value}
                </span>
              </span>
            ))}
          </div>
        )}
      </main>

      {!drawers && (
        <>
          <div
            onMouseDown={(event) => startColumnResize(event, 'right')}
            title={t('拖动调整宽度', 'Drag to resize', '拖曳調整寬度', 'ドラッグで幅を調整')}
            className="w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-amber-500/40"
          />
          <RightDock {...dockProps} width={rightWidth} />
        </>
      )}

      {drawers && (
        <>
          <Drawer open={leftDrawerOpen} side="left" onClose={() => setLeftDrawerOpen(false)}>
            <Sidebar
              projects={projects}
              activeProjectId={activeProjectId}
              expandedIds={expandedIds}
              sessions={sessions}
              sessionCache={sessionCache}
              runningSessionIds={agent.runningSessionIds}
              activeSessionId={activeSessionId}
              loadingSessions={loadingSessions}
              onNewChat={newChat}
              onOpenProject={openProject}
              onSelectProject={selectProject}
              onToggleExpand={toggleExpand}
              onSelectSession={openSession}
              onDeleteSession={requestRemoveSession}
              onRemoveProject={dropProject}
              onOpenSettings={() => setSettingsOpen(true)}
              onSessionMenu={openSessionMenu}
              onProjectMenu={openProjectMenu}
              onNewSession={handleNewSession}
              onOpenTrash={() => setTrashOpen(true)}
              trashCount={trash.length}
            />
          </Drawer>
          <Drawer open={rightDrawerOpen} side="right" onClose={() => setRightDrawerOpen(false)}>
            <RightDock {...dockProps} inDrawer />
          </Drawer>
        </>
      )}

      <FloatingWindow
        open={settings.floatingWindow}
        theme={settings.theme}
        color={settings.color}
        onClose={closeFloating}
        onError={(message) => {
          setBackendError(message)
          setSettings((prev) => ({ ...prev, floatingWindow: false }))
        }}
      >
        <FloatingAgent
          running={agent.running}
          rounds={agent.rounds}
          startedAt={agent.startedAt}
          approval={pendingApproval?.request ?? null}
          approvalTimeout={settings.approvalTimeout}
          approvalLiveDetail={
            pendingApproval && agent.toolDraft && agent.toolDraft.name === pendingApproval.request.tool
              ? agent.toolDraft.argsSoFar.slice(0, 3000)
              : null
          }
          onDecideApproval={decideApproval}
          ask={pendingAsk}
          onAnswerAsk={answerAsk}
          onInsert={(text) => {
            if (activeSessionId) agent.send(activeSessionId, text)
          }}
          onStop={() => {
            if (activeSessionId) agent.stop(activeSessionId)
          }}
          onClose={closeFloating}
        >
          {/* 主对话区：和网页版是同一个组件、同一份 props */}
          {conversation}
        </FloatingAgent>
      </FloatingWindow>

      {/* 载入会话的进度：大文件 / 图片多的时候别让人以为卡死 */}
      {sessionLoading && (
        <div className="anim-fade pointer-events-none fixed top-3 left-1/2 z-[95] w-[340px] max-w-[92vw] -translate-x-1/2 rounded-lg border border-neutral-700 bg-neutral-900/95 px-3 py-2 shadow-xl">
          <div className="flex items-center justify-between gap-2 text-[11px] text-neutral-300">
            <span className="truncate">{sessionLoading.label}</span>
            {sessionLoading.total > 0 && (
              <span className="shrink-0 font-mono text-neutral-500">
                {sessionLoading.done}/{sessionLoading.total}
              </span>
            )}
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-neutral-800">
            <div
              className={`h-full rounded-full bg-amber-500 transition-[width] duration-200 ${
                sessionLoading.total > 0 ? '' : 'w-1/3 animate-pulse'
              }`}
              style={
                sessionLoading.total > 0
                  ? {
                      width: `${Math.round((sessionLoading.done / sessionLoading.total) * 100)}%`,
                    }
                  : undefined
              }
            />
          </div>
        </div>
      )}

      {importCandidates.length > 0 && importProject && (
        <ImportDialog
          open
          backend={backend}
          projectRoot={importProject.path}
          candidates={importCandidates}
          onClose={() => {
            setImportCandidates([])
            setImportProject(null)
          }}
          onImported={() => {
            setImportCandidates([])
            setImportProject(null)
            // 导的是当前项目才刷新会话列表；别的项目等切过去时自然会读到
            if (backend && importProject.id === activeProjectId) {
              void refreshSessions(backend, activeProjectId)
            }
          }}
        />
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={() => setMenu(null)}
        />
      )}

      {/* 归档会话：二次确认（归档进回收站，可找回） */}
      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('app.deleteTitle')}
        message={t('app.deleteMessage')}
        confirmLabel={t('app.deleteConfirm')}
        danger
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const id = pendingDelete
          setPendingDelete(null)
          if (id) void removeSession(id)
        }}
      />

      {/* 回收站：恢复 / 彻底删除 */}
      <Dialog open={trashOpen} onClose={() => setTrashOpen(false)} className="max-w-lg">
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
          <span className="text-sm font-medium text-neutral-100">
            {t('app.trash')}
            {trash.length > 0 && (
              <span className="ml-2 text-xs text-neutral-500">
                {trash.length} {t('app.trashCount')}
              </span>
            )}
          </span>
          <Tooltip label={t('app.close')}>
            <button
              onClick={() => setTrashOpen(false)}
              aria-label={t('app.close')}
              className="rb-nohover rounded p-1 text-neutral-500 transition-colors hover:text-neutral-200"
            >
              <XIcon className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>
        <div className="max-h-80 overflow-y-auto p-2">
          {trash.length === 0 ? (
            <p className="px-3 py-8 text-center text-xs text-neutral-600">{t('app.trashEmpty')}</p>
          ) : (
            trash.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-2 rounded-lg px-3 py-2 transition-colors hover:bg-neutral-800/40"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs text-neutral-200">
                    {item.title || t('未命名会话', 'Untitled session', '未命名工作階段', '無題のセッション')}
                  </div>
                  <div className="mt-0.5 text-[11px] text-neutral-600">
                    {new Date(item.deletedAt).toLocaleString()} · {item.messages?.length ?? 0}{' '}
                    {t('app.messagesCount')}
                  </div>
                </div>
                <Tooltip label={t('common.restore')}>
                  <OreButton status="normal"
                    onClick={() => void restoreFromTrash(item.id)}
                    aria-label={t('common.restore')}
                    className="shrink-0 rounded-md border border-neutral-700 px-2.5 py-1 text-xs text-neutral-300 transition-colors hover:border-amber-600 hover:text-amber-200"
                  >
                    {t('common.restore')}
                  </OreButton>
                </Tooltip>
                <Tooltip label={t('common.purge')}>
                  <OreButton status="red"
                    onClick={() => setPendingPurge(item.id)}
                    aria-label={t('common.purge')}
                    className="shrink-0 rounded-md border border-neutral-700 px-2.5 py-1 text-xs text-neutral-400 transition-colors hover:border-red-500 hover:text-red-400"
                  >
                    {t('common.purge')}
                  </OreButton>
                </Tooltip>
              </div>
            ))
          )}
        </div>
      </Dialog>

      {/* 彻底删除再确认一次 */}
      <ConfirmDialog
        open={pendingPurge !== null}
        title={t('app.purgeTitle')}
        message={t('app.purgeMessage')}
        confirmLabel={t('common.purge')}
        danger
        onCancel={() => setPendingPurge(null)}
        onConfirm={() => {
          const id = pendingPurge
          setPendingPurge(null)
          if (id) void purgeFromTrash(id)
        }}
      />

      <SettingsPage
        open={settingsOpen}
        settings={settings}
        onChange={(patch) => setSettings((prev) => ({ ...prev, ...patch }))}
        onClose={() => setSettingsOpen(false)}
        backend={backend}
        backendError={backendError}
        onOpenProject={openProject}
        projectCount={projects.length}
        sessionCacheProjects={Object.keys(sessionCache).length}
        onClearSessionCache={clearSessionCache}
        onClearProjects={clearProjects}
        onConnectCompanion={async (token) => {
          const trimmed = token.trim()
          setSettings((prev) => ({ ...prev, companionToken: trimmed }))
          if (!trimmed) {
            setBackendError(null)
            return
          }

          // 当前项目就走本机执行器时，直接拿新令牌重连一次。
          // 否则内存里的旧 backend 还拿着旧令牌（companion 每次启动都会换令牌），
          // 切会话会读不到文件、报「找不到该会话文件」。
          const current = projects.find((project) => project.id === activeProjectId)
          if (current?.backendKind === 'companion') {
            const previous = activeSessionId
            setBackendError(null)
            const next = await selectProject(current, trimmed)
            if (next && previous) await openSession(previous, undefined, next)
            return
          }

          setBackendError(
            t(
              '令牌已保存。点「打开项目」或顶栏的后端徽章即可连接。',
              'Token saved. Use "Open project" or the backend badge to connect.',
              '權杖已儲存。點「開啟專案」或頂欄的後端徽章即可連線。',
            ),
          )
        }}
        onDisconnect={() => {
          setBackend(null)
          setBackendError(null)
        }}
      />

      {pickerCompanion && (
        <DirectoryPicker
          open
          companion={pickerCompanion}
          onClose={() => setPickerCompanion(null)}
          onSelect={(path) => void attachCompanion(pickerCompanion, path)}
        />
      )}
    </div>
  )
}
