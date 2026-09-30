import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Tooltip from './Tooltip.tsx'
import OreButton from './OreButton.tsx'
import { useT, getLanguage } from '../lib/i18n.ts'
import { canRecognize, startDictation, type Dictation } from '../lib/speech.ts'
import { useIsMobile } from '../hooks/useIsMobile.ts'
import type { Backend } from '../lib/executor/types.ts'
import { permissionHint, permissionLabel } from '../lib/permissions.ts'
import { REASONING_EFFORT_LABEL } from '../lib/settings.ts'
import type {
  Attachment,
  PermissionMode,
  Provider,
  ReasoningEffort,
} from '../lib/types.ts'
import {
  ArrowUpIcon,
  AtSignIcon,
  CheckIcon,
  ChevronRightIcon,
  ClipboardListIcon,
  CommandIcon,
  FileIcon,
  GaugeIcon,
  LoaderIcon,
  MicIcon,
  PermissionsIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SparklesIcon,
  StopIcon,
  XIcon,
} from './icons.tsx'

export interface QueuedMessage {
  id: string
  text: string
  attachments: Attachment[]
}
interface Props {
  disabled: boolean
  disabledHint: string
  running: boolean
  compacting: boolean
  backend: Backend | null
  permission: PermissionMode
  /** 计划模式（只读） */
  planMode: boolean
  onTogglePlan: () => void
  /** 所有提供商（模型弹层用） */
  providers: Provider[]
  activeProviderId: string
  activeModel: string
  reasoningEffort: ReasoningEffort
  queue: QueuedMessage[]
  onSend: (text: string, attachments: Attachment[]) => void
  onStop: () => void
  onPermissionChange: (mode: PermissionMode) => void
  onSelectModel: (providerId: string, modelId: string) => void
  onReasoningChange: (effort: ReasoningEffort) => void
  onOpenSettings: () => void
  onRemoveQueued: (id: string) => void
  /** 把队列里的消息立刻插到当前工具之后 */
  onInsertNow: (id: string) => void
  /** 外部预填到输入框的内容（例如点「修改计划」） */
  inputSeed: { id: number; text: string } | null
  /** 显示语音输入按钮（设置里开） */
  voiceInput: boolean
}

interface Suggestion {
  kind: 'file' | 'command'
  query: string
  start: number
}

const PERMISSION_MODES: PermissionMode[] = ['readonly', 'auto', 'full']

const COMMANDS: { name: string; desc: [string, string, string, string] }[] = [
  { name: 'clear', desc: ['清空当前会话', 'Clear this session', '清空目前工作階段', 'このセッションをクリア'] },
  { name: 'new', desc: ['新建会话', 'New session', '新增工作階段', '新しいセッション'] },
  {
    name: 'undo',
    desc: ['撤销最近一次文件改动', 'Undo the last file change', '復原最近一次檔案改動', '直近のファイル変更を元に戻す'],
  },
  { name: 'compact', desc: ['立即压缩上下文', 'Compact context now', '立即壓縮上下文', '今すぐコンテキストを圧縮'] },
  { name: 'plan', desc: ['开 / 关计划模式', 'Toggle plan mode', '開 / 關計畫模式', '計画モードのオン / オフ'] },
  { name: 'stop', desc: ['停止当前生成', 'Stop generating', '停止目前生成', '生成を停止'] },
  {
    name: 'export',
    desc: ['导出当前会话为 Markdown', 'Export this session as Markdown', '匯出目前工作階段為 Markdown', 'このセッションを Markdown で書き出す'],
  },
  { name: 'copy', desc: ['复制最后一条回答', 'Copy the last reply', '複製最後一則回答', '最後の回答をコピー'] },
  {
    name: 'theme',
    desc: ['切换主题 / 颜色', 'Switch theme / color', '切換主題 / 顏色', 'テーマ / カラーを切り替え'],
  },
  { name: 'sound', desc: ['开 / 关提示音', 'Toggle sounds', '開 / 關提示音', '通知音のオン / オフ'] },
  { name: 'settings', desc: ['打开设置', 'Open settings', '開啟設定', '設定を開く'] },
  { name: 'help', desc: ['查看可用指令', 'Show available commands', '查看可用指令', '使用できるコマンドを表示'] },
]

const MAX_FILE_INDEX = 3000

const MIN_INPUT_HEIGHT = 44
const MAX_INPUT_HEIGHT = 420
const HEIGHT_KEY = 'rbcode.composerHeight'

function loadInputHeight(): number {
  try {
    const value = Number(localStorage.getItem(HEIGHT_KEY))
    if (Number.isFinite(value) && value >= MIN_INPUT_HEIGHT && value <= MAX_INPUT_HEIGHT) {
      return value
    }
  } catch {
    // 忽略读取失败
  }
  return MIN_INPUT_HEIGHT
}

/** 判断光标前是否正在输入 @文件 或 /指令 */
function detectTrigger(value: string, caret: number): Suggestion | null {
  const before = value.slice(0, caret)
  const at = /(?:^|\s)@([^\s@]*)$/.exec(before)
  if (at) return { kind: 'file', query: at[1], start: caret - at[1].length - 1 }
  const slash = /(?:^|\s)\/([^\s/]*)$/.exec(before)
  if (slash) return { kind: 'command', query: slash[1], start: caret - slash[1].length - 1 }
  return null
}

export default function Composer({
  disabled,
  disabledHint,
  running,
  compacting,
  backend,
  permission,
  planMode,
  onTogglePlan,
  providers,
  activeProviderId,
  activeModel,
  reasoningEffort,
  queue,
  onSend,
  onStop,
  onPermissionChange,
  onSelectModel,
  onReasoningChange,
  onOpenSettings,
  onRemoveQueued,
  onInsertNow,
  inputSeed,
  voiceInput,
}: Props) {
  const t = useT()
  const isMobile = useIsMobile()
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [files, setFiles] = useState<string[]>([])
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null)
  const [dragging, setDragging] = useState(false)
  const [resizing, setResizing] = useState(false)
  const [attachError, setAttachError] = useState<string | null>(null)
  /** 语音输入：正在听写时持有会话，可随时停 */
  const [dictating, setDictating] = useState(false)
  const dictationRef = useRef<Dictation | null>(null)
  /** 开始听写前输入框里已有的内容（识别结果接在它后面） */
  const dictationBase = useRef('')
  const [inputHeight, setInputHeight] = useState(loadInputHeight)
  const [activeIndex, setActiveIndex] = useState(0)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [modelQuery, setModelQuery] = useState('')
  const [effortMenuOpen, setEffortMenuOpen] = useState(false)
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const heightRef = useRef(inputHeight)
  heightRef.current = inputHeight

  // 外部预填内容（例如点「修改计划」）
  useEffect(() => {
    if (!inputSeed) return
    setText(inputSeed.text)
    const el = textareaRef.current
    if (el) {
      el.focus()
      el.setSelectionRange(inputSeed.text.length, inputSeed.text.length)
    }
    // 只在 seed 变化时触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputSeed?.id])

  // 补全菜单随输入重新筛选时，选中项回到第一个
  useEffect(() => {
    setActiveIndex(0)
  }, [suggestion])

  /** 拖动输入区上边缘调整高度，松手后记住 */
  const startResize = (event: React.MouseEvent) => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = heightRef.current
    setResizing(true)

    const onMove = (moveEvent: MouseEvent) => {
      const next = Math.min(
        MAX_INPUT_HEIGHT,
        Math.max(MIN_INPUT_HEIGHT, startHeight - (moveEvent.clientY - startY)),
      )
      setInputHeight(next)
    }
    const onUp = () => {
      setResizing(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      try {
        localStorage.setItem(HEIGHT_KEY, String(heightRef.current))
      } catch {
        // 忽略写入失败
      }
    }

    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // 缓存项目文件列表，用于 @ 补全
  useEffect(() => {
    if (!backend) {
      setFiles([])
      return
    }
    let cancelled = false
    backend
      .glob('**/*')
      .then((matches) => {
        if (cancelled) return
        setFiles(matches.filter((m) => !m.endsWith('/')).slice(0, MAX_FILE_INDEX))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [backend])

  const filtered = useMemo(() => {
    if (!suggestion) return []
    const query = suggestion.query.toLowerCase()
    if (suggestion.kind === 'command') {
      return COMMANDS.filter((c) => c.name.startsWith(query)).map((c) => ({
        key: c.name,
        display: `/${c.name}`,
        insert: `/${c.name} `,
        hint: t(c.desc[0], c.desc[1], c.desc[2], c.desc[3]),
      }))
    }
    return files
      .filter((f) => f.toLowerCase().includes(query))
      .slice(0, 12)
      .map((f) => ({ key: f, display: f, insert: `${f} `, hint: '' }))
  }, [suggestion, files])

  const applySuggestion = useCallback(
    (insert: string) => {
      if (!suggestion) return
      const el = textareaRef.current
      const caret = el?.selectionStart ?? text.length
      const prefix = text.slice(0, suggestion.start)
      const suffix = text.slice(caret)

      // 文件引用：和「拖入文件」完全一样 —— 生成引用附件，正文里不留 @xxx
      if (suggestion.kind === 'file') {
        const path = insert.trim()
        if (path) {
          setAttachments((prev) => [
            ...prev,
            { id: crypto.randomUUID(), kind: 'file', name: path, path },
          ])
        }
        setText(`${prefix}${suffix}`)
        setSuggestion(null)
        requestAnimationFrame(() => {
          el?.focus()
          el?.setSelectionRange(prefix.length, prefix.length)
        })
        return
      }

      // 指令：照旧把 /xxx 插进正文
      const next = `${prefix}${insert}${suffix}`
      setText(next)
      setSuggestion(null)
      requestAnimationFrame(() => {
        const pos = prefix.length + insert.length
        el?.focus()
        el?.setSelectionRange(pos, pos)
      })
    },
    [suggestion, text],
  )

  function handleChange(value: string, caret: number) {
    setText(value)
    setSuggestion(detectTrigger(value, caret))
  }

  async function addImageFile(file: File) {
    const MAX_BYTES = 4 * 1024 * 1024
    if (file.size > MAX_BYTES) {
      setAttachError(
        t(
          `图片 ${(file.size / 1024 / 1024).toFixed(1)}MB 超过 4MB 上限，请先压缩再粘贴`,
          `Image is ${(file.size / 1024 / 1024).toFixed(1)}MB, over the 4MB limit — compress it before pasting`,
          `圖片 ${(file.size / 1024 / 1024).toFixed(1)}MB 超過 4MB 上限，請先壓縮再貼上`,
          `画像は ${(file.size / 1024 / 1024).toFixed(1)}MB で 4MB の上限を超えています。圧縮してから貼り付けてください`,
        ),
      )
      return
    }
    setAttachError(null)
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
    setAttachments((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        kind: 'image',
        name: file.name || t('粘贴的图片', 'Pasted image', '貼上的圖片', '貼り付けた画像'),
        dataUrl,
      },
    ])
  }

  /** 非图片文件：做成「文件引用」(@路径)，而不是塞二进制 */
  function addFileReference(file: File) {
    const name = file.name
    // 尽量在项目文件列表里找到同名项（唯一命中才采用它的相对路径）
    const matches = files.filter((f) => f === name || f.endsWith(`/${name}`))
    const path = matches.length === 1 ? matches[0] : name
    setAttachments((prev) => [
      ...prev,
      { id: crypto.randomUUID(), kind: 'file', name: path, path },
    ])
  }

  /** 拖/选进来的文件：图片当附件，其余当文件引用 */
  function addDroppedFile(file: File) {
    if (file.type.startsWith('image/')) void addImageFile(file)
    else addFileReference(file)
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(e.clipboardData.items).filter((item) =>
      item.type.startsWith('image/'),
    )
    if (items.length === 0) return
    e.preventDefault()
    for (const item of items) {
      const file = item.getAsFile()
      if (file) void addImageFile(file)
    }
  }

  function submit() {
    const value = text.trim()
    if (running) {
      // 回答期间发送的内容进入队列
      if (value || attachments.length > 0) {
        onSend(value, attachments)
        setText('')
        setAttachments([])
      }
      return
    }
    if (disabled) return
    if (!value && attachments.length === 0) return
    onSend(value, attachments)
    setText('')
    setAttachments([])
    setSuggestion(null)
  }

  /**
   * 运行中点「插入」：**走和电脑端完全一样的 onSend**，也就是进待发送队列。
   * （以前这里走 onInsert → urgent 列表，那个列表是「已经交给模型」的，所以
   *  里面的「立即插入」按钮必然 no-op —— 两端行为不一致的根源。）
   * 队列里可以随时「立即插入」或「移除」。
   */
  function insertInput() {
    const value = text.trim()
    if (!value && attachments.length === 0) return
    onSend(value, attachments)
    setText('')
    setAttachments([])
    setSuggestion(null)
  }

  /** 模型弹层：按提供商分组，按关键字过滤 */
  const modelGroups = useMemo(() => {
    const query = modelQuery.trim().toLowerCase()
    return providers
      .map((provider) => ({
        provider,
        models: provider.models.filter((model) =>
          query ? `${model.label ?? ''} ${model.id}`.toLowerCase().includes(query) : true,
        ),
      }))
      .filter((group) => group.models.length > 0)
  }, [providers, modelQuery])

  const activeProvider = providers.find((p) => p.id === activeProviderId)
  const activeModelEntry = activeProvider?.models.find((m) => m.id === activeModel)
  const activeModelLabel = activeModelEntry?.label ?? activeModel

  const statusLabel = compacting
    ? t('压缩上下文', 'Compacting', '壓縮上下文', 'コンテキスト圧縮中')
    : running
      ? t('生成中', 'Generating', '生成中', '生成中')
      : disabled
        ? t('未就绪', 'Not ready', '未就緒', '未準備')
        : t('就绪', 'Ready', '就緒', '準備完了')

  /** 开始 / 结束语音输入：识别结果实时接到输入框已有内容后面 */
  const toggleDictation = useCallback(() => {
    const running = dictationRef.current
    if (running) {
      running.stop()
      dictationRef.current = null
      setDictating(false)
      return
    }
    dictationBase.current = text.trim() ? `${text.trim()} ` : ''
    const session = startDictation({
      lang: getLanguage(),
      onText: (spoken) => setText(`${dictationBase.current}${spoken}`),
      onEnd: () => {
        dictationRef.current = null
        setDictating(false)
      },
    })
    if (!session) {
      setAttachError(t('这个浏览器不支持语音输入，Chrome / Edge 上可用', 'Voice input is not supported in this browser — try Chrome or Edge', '這個瀏覽器不支援語音輸入，Chrome / Edge 上可用'))
      return
    }
    dictationRef.current = session
    setDictating(true)
  }, [t, text])

  // 组件卸载 / 停止生成时把听写收掉
  useEffect(() => {
    return () => {
      dictationRef.current?.stop()
      dictationRef.current = null
    }
  }, [])

  useEffect(() => {
    if (running && dictationRef.current) {
      dictationRef.current.stop()
      dictationRef.current = null
      setDictating(false)
    }
  }, [running])

  /** 输入框里有内容（文本或附件）——运行中据此把「停止」换成「插入」 */
  const hasContent = text.trim() !== '' || attachments.length > 0

  return (
    <div className="px-4 pt-2 pb-2 sm:pt-3 sm:pb-3">
      <div className="mx-auto max-w-3xl">
        {attachError && (
          <div className="mb-2 rounded-lg border border-amber-800/60 bg-amber-950/30 px-3 py-1.5 text-xs text-amber-300">
            {attachError}
          </div>
        )}

        {/* 待发送队列：电脑和手机**同一段代码、同一个框**。
            手机上的「插入」按钮也走 onSend → 进这个队列，所以这里的两个按钮都有效。 */}
        {queue.length > 0 && (
          <div className="mb-2 flex flex-col gap-1 rounded-lg border border-neutral-800 bg-neutral-900/60 p-2">
            {queue.map((item) => (
              <div key={item.id} className="flex items-center gap-1.5">
                {/* 这里不再叠一层悬浮提示：内容跟这一行完全一样，重复且挡视线 */}
                <span className="min-w-0 flex-1 truncate text-left text-xs text-neutral-300">
                  {item.text || t('(仅图片)', '(image only)', '（僅圖片）', '（画像のみ）')}
                </span>
                <Tooltip label={t('立即插入', 'Insert now', '立即插入', '今すぐ挿入')}>
                  <button
                    onClick={() => onInsertNow(item.id)}
                    aria-label={t('立即插入', 'Insert now', '立即插入', '今すぐ挿入')}
                    className="rb-nohover shrink-0 rounded p-1 text-amber-300 transition-colors hover:bg-amber-500/10"
                  >
                    <ArrowUpIcon className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
                <Tooltip label={t('移除', 'Remove', '移除', '削除')}>
                  <button
                    onClick={() => onRemoveQueued(item.id)}
                    aria-label={t('移除', 'Remove', '移除', '削除')}
                    className="rb-nohover shrink-0 rounded p-1 text-neutral-500 transition-colors hover:text-red-400"
                  >
                    <XIcon className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
              </div>
            ))}
          </div>
        )}

        {/* 补全菜单：指令 / 项目文件，支持 ↑↓ 选择、Enter 确认 */}
        {suggestion && filtered.length > 0 && (
          <div className="anim-pop mb-2 max-h-64 overflow-y-auto rounded-xl border border-neutral-700 bg-neutral-900/95 shadow-2xl">
            <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-neutral-800 bg-neutral-900/95 px-3 py-1.5 text-[11px] text-neutral-500 backdrop-blur">
              {suggestion.kind === 'command' ? (
                <CommandIcon className="h-3 w-3" />
              ) : (
                <AtSignIcon className="h-3 w-3" />
              )}
              <span>
                {suggestion.kind === 'command'
                  ? t('指令', 'Commands', '指令', 'コマンド')
                  : t('项目文件', 'Project files', '專案檔案', 'プロジェクトのファイル')}
              </span>
              <span className="ml-auto hidden sm:inline">
                {t(
                  '↑↓ 选择 · Enter 确认 · Esc 关闭',
                  '↑↓ select · Enter confirm · Esc close',
                  '↑↓ 選擇 · Enter 確認 · Esc 關閉',
                  '↑↓ 選択 · Enter 確定 · Esc 閉じる',
                )}
              </span>
            </div>
            {filtered.map((item, index) => {
              const active = index === activeIndex
              return (
                <button
                  key={item.key}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => applySuggestion(item.insert)}
                  className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors ${
                    active ? 'bg-neutral-800' : 'hover:bg-neutral-800/60'
                  }`}
                >
                  <span
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors ${
                      active ? 'bg-amber-500/20 text-amber-300' : 'bg-neutral-800 text-neutral-500'
                    }`}
                  >
                    {suggestion.kind === 'command' ? (
                      <CommandIcon className="h-3.5 w-3.5" />
                    ) : (
                      <FileIcon className="h-3.5 w-3.5" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs text-neutral-100">
                      {item.display}
                    </span>
                    {item.hint && (
                      <span className="mt-0.5 block truncate text-[11px] text-neutral-500">
                        {item.hint}
                      </span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        )}

        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            for (const file of Array.from(e.dataTransfer.files)) addDroppedFile(file)
          }}
          className={`relative rounded-xl border bg-neutral-900/70 transition-colors ${
            dragging ? 'border-amber-500' : 'border-neutral-700'
          }`}
        >
          {/* 悬停（或正在拖动）输入框上边缘时，才露出小拖动柄；不再占中间的空隙 */}
          <div
            onMouseDown={startResize}
            title={t('上下拖动调整输入区高度', 'Drag up/down to resize the input', '上下拖曳調整輸入區高度', '上下にドラッグして入力欄の高さを調整')}
            className="group/resize absolute -top-1.5 left-0 z-10 flex h-3 w-full cursor-row-resize items-center justify-center"
          >
            <div
              className={`h-1 w-10 rounded-full bg-amber-500/80 transition-opacity ${
                resizing ? 'opacity-100' : 'opacity-0 group-hover/resize:opacity-100'
              }`}
            />
          </div>

          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 border-b border-neutral-800 p-2">
              {attachments.map((item) => (
                <div key={item.id} className="group relative">
                  {item.kind === 'image' ? (
                    <img
                      src={item.dataUrl}
                      alt={item.name}
                      className="h-16 w-16 rounded border border-neutral-700 object-cover"
                    />
                  ) : (
                    <span className="rounded border border-neutral-700 px-2 py-1 font-mono text-xs text-neutral-400">
                      @{item.name}
                    </span>
                  )}
                  <button
                    onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== item.id))}
                    className="absolute -top-1.5 -right-1.5 hidden h-4 w-4 items-center justify-center rounded-full bg-neutral-700 text-[10px] text-white group-hover:flex"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={text}
            style={{ height: inputHeight }}
            disabled={disabled && !running}
            placeholder={
              disabled && !running
                ? disabledHint
                : isMobile
                  ? t(
                      '描述你想让 RB Code 做什么',
                      'Tell RB Code what to do',
                      '描述你想讓 RB Code 做什麼',
                      'RB Code にしてほしいことを入力',
                    )
                  : t(
                      '描述你想让 RB Code 做什么（Enter 发送，Shift+Enter 换行，@ 引用文件，/ 指令）',
                      'Tell RB Code what to do (Enter to send, Shift+Enter for a new line, @ to reference files, / for commands)',
                      '描述你想讓 RB Code 做什麼（Enter 傳送，Shift+Enter 換行，@ 引用檔案，/ 指令）',
                      'RB Code にしてほしいことを入力（Enter で送信、Shift+Enter で改行、@ でファイル参照、/ でコマンド）',
                    )
            }
            className="w-full resize-none bg-transparent px-3.5 py-3 text-sm text-neutral-100 outline-none placeholder:text-neutral-600"
            onChange={(e) => handleChange(e.target.value, e.target.selectionStart)}
            onKeyDown={(e) => {
              const menuOpen = Boolean(suggestion && filtered.length > 0)
              if (menuOpen) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setActiveIndex((i) => (i + 1) % filtered.length)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length)
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  applySuggestion(filtered[Math.min(activeIndex, filtered.length - 1)].insert)
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setSuggestion(null)
                  return
                }
              }
              if (e.key === 'Escape') setSuggestion(null)
              if (e.key === 'Enter' && !e.shiftKey && !suggestion) {
                e.preventDefault()
                submit()
              }
            }}
            onPaste={handlePaste}
          />

          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-2.5 pt-1 pb-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                for (const file of Array.from(e.target.files ?? [])) addDroppedFile(file)
                e.target.value = ''
              }}
            />
            <Tooltip label={t('添加图片', 'Add image', '新增圖片', '画像を追加')}>
              <button
                onClick={() => fileInputRef.current?.click()}
                aria-label={t('添加图片', 'Add image', '新增圖片', '画像を追加')}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-neutral-700 text-neutral-400 transition hover:border-neutral-500 hover:text-neutral-200 active:scale-90"
              >
                <PlusIcon className="h-3.5 w-3.5" />
              </button>
            </Tooltip>

            {/* 权限：点击展开菜单（手机端收成纯图标，给发送键腾地方） */}
            <div className="relative">
              <Tooltip label={t('权限档位', 'Permission level', '權限等級', '権限レベル')}>
                <button
                  onClick={() => setPermissionMenuOpen((value) => !value)}
                  aria-label={t('权限档位', 'Permission level', '權限等級', '権限レベル')}
                  className={
                    isMobile
                      ? 'inline-flex h-7 w-7 items-center justify-center rounded-md border border-neutral-700 text-neutral-400 transition-colors hover:border-neutral-500 hover:text-neutral-200'
                      : 'inline-flex h-7 items-center gap-1 rounded-md border border-neutral-700 px-2.5 text-[11px] text-neutral-400 transition-colors hover:border-neutral-500 hover:text-neutral-200'
                  }
                >
                  {isMobile ? (
                    <PermissionsIcon className="h-3.5 w-3.5" />
                  ) : (
                    <>
                      <span>{permissionLabel(permission)}</span>
                      <ChevronRightIcon
                        className={`h-3 w-3 shrink-0 text-neutral-600 transition-transform ${
                          permissionMenuOpen ? '-rotate-90' : 'rotate-90'
                        }`}
                      />
                    </>
                  )}
                </button>
              </Tooltip>

              {permissionMenuOpen && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setPermissionMenuOpen(false)} />
                  <div className="anim-pop absolute bottom-full left-0 z-30 mb-2 w-40 overflow-hidden rounded-xl border rb-menu border-neutral-700/70 p-1 shadow-2xl">
                    {PERMISSION_MODES.map((mode) => {
                      const active = permission === mode
                      return (
                        <Tooltip key={mode} block label={permissionHint(mode)}>
                          <button
                            onClick={() => {
                              onPermissionChange(mode)
                              setPermissionMenuOpen(false)
                            }}
                            className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors ${
                              active ? 'bg-neutral-100/10' : 'hover:bg-neutral-100/[0.06]'
                            }`}
                          >
                            <span className="min-w-0 flex-1 truncate text-xs text-neutral-100">
                              {permissionLabel(mode)}
                            </span>
                            {active && (
                              <CheckIcon className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                            )}
                          </button>
                        </Tooltip>
                      )
                    })}
                  </div>
                </>
              )}
            </div>

            {/* 模型切换：点开就是搜索 + 分组列表 + 思考强度（手机端收成纯图标） */}
            <div className="relative">
              <Tooltip label={t('切换模型', 'Switch model', '切換模型', 'モデルを切り替え')}>
                <button
                  onClick={() => {
                    setModelMenuOpen((value) => !value)
                    setModelQuery('')
                  }}
                  aria-label={t('切换模型', 'Switch model', '切換模型', 'モデルを切り替え')}
                  className={
                    isMobile
                      ? 'inline-flex h-7 w-7 items-center justify-center rounded-md border border-neutral-700 text-neutral-400 transition-colors hover:border-neutral-500 hover:text-neutral-200'
                      : 'inline-flex h-7 max-w-40 items-center gap-1 rounded-md border border-neutral-700 px-2.5 font-mono text-[11px] text-neutral-400 transition-colors hover:border-neutral-500 hover:text-neutral-200 sm:max-w-52'
                  }
                >
                  {isMobile ? (
                    <SparklesIcon className="h-3.5 w-3.5" />
                  ) : (
                    <>
                      <span className="truncate">
                        {activeModelLabel ||
                          t('未选择模型', 'No model', '未選擇模型', 'モデル未選択')}
                      </span>
                      <ChevronRightIcon
                        className={`h-3 w-3 shrink-0 text-neutral-600 transition-transform ${
                          modelMenuOpen ? '-rotate-90' : 'rotate-90'
                        }`}
                      />
                    </>
                  )}
                </button>
              </Tooltip>

              {modelMenuOpen && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setModelMenuOpen(false)} />
                  <div className="anim-pop absolute bottom-full left-0 z-30 mb-2 w-80 max-w-[calc(100vw-1.5rem)] max-md:max-w-[64vw] overflow-hidden rounded-xl border rb-menu border-neutral-700 shadow-2xl">
                    <div className="relative border-b border-neutral-800 p-2">
                      <SearchIcon className="absolute top-1/2 left-4 h-3.5 w-3.5 -translate-y-1/2 text-neutral-600" />
                      <input
                        autoFocus
                        value={modelQuery}
                        onChange={(e) => setModelQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            e.preventDefault()
                            setModelMenuOpen(false)
                          }
                        }}
                        placeholder={t('搜索模型', 'Search models', '搜尋模型', 'モデルを検索')}
                        className="w-full rounded-lg border border-neutral-700 bg-neutral-950/60 py-1.5 pr-2 pl-8 text-xs text-neutral-200 outline-none focus:border-amber-600"
                      />
                    </div>

                    <div className="max-h-64 overflow-y-auto py-1">
                      {modelGroups.length === 0 && (
                        <p className="px-3 py-2 text-xs text-neutral-600">
                          {t('没有匹配的模型', 'No matching models', '沒有符合的模型', '一致するモデルがありません')}
                        </p>
                      )}
                      {modelGroups.map(({ provider, models }) => (
                        <div key={provider.id} className="mb-0.5">
                          <div className="px-3 py-1 text-[11px] text-neutral-500">
                            {provider.name}
                          </div>
                          {models.map((model) => {
                            const selected =
                              provider.id === activeProviderId && model.id === activeModel
                            const free = /free/i.test(`${model.label ?? ''} ${model.id}`)
                            return (
                              <button
                                key={model.id}
                                onClick={() => {
                                  onSelectModel(provider.id, model.id)
                                  setModelMenuOpen(false)
                                }}
                                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                                  selected ? 'bg-neutral-800' : 'hover:bg-neutral-800/60'
                                }`}
                              >
                                <span className="min-w-0 flex-1 truncate text-xs text-neutral-100">
                                  {model.label ?? model.id}
                                </span>
                                {model.label && (
                                  <span className="shrink-0 font-mono text-[10px] text-neutral-600">
                                    {model.id}
                                  </span>
                                )}
                                {free && (
                                  <span className="shrink-0 rounded border border-emerald-700/50 px-1 text-[10px] text-emerald-400">
                                    {t('免费', 'Free', '免費', '無料')}
                                  </span>
                                )}
                                {selected && (
                                  <CheckIcon className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                                )}
                              </button>
                            )
                          })}
                        </div>
                      ))}
                    </div>

                    <button
                      onClick={() => {
                        setModelMenuOpen(false)
                        onOpenSettings()
                      }}
                      className="flex w-full items-center gap-2 border-t border-neutral-800 px-3 py-2 text-left text-xs text-neutral-300 transition-colors hover:bg-neutral-800"
                    >
                      <SettingsIcon className="h-3.5 w-3.5 text-neutral-500" />
                      {t('管理模型', 'Manage models', '管理模型', 'モデルを管理')}
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* 思考强度：单独一个下拉，不再塞在模型弹层里（手机端收成纯图标） */}
            <div className="relative">
              <Tooltip label={t('思考强度', 'Reasoning effort', '思考強度', '思考の強度')}>
                <button
                  onClick={() => setEffortMenuOpen((value) => !value)}
                  aria-label={t('思考强度', 'Reasoning effort', '思考強度', '思考の強度')}
                  className={
                    isMobile
                      ? 'inline-flex h-7 w-7 items-center justify-center rounded-md border border-neutral-700 text-neutral-400 transition-colors hover:border-neutral-500 hover:text-neutral-200'
                      : 'inline-flex h-7 items-center gap-1 rounded-md border border-neutral-700 px-2.5 text-[11px] text-neutral-400 transition-colors hover:border-neutral-500 hover:text-neutral-200'
                  }
                >
                  {isMobile ? (
                    <GaugeIcon className="h-3.5 w-3.5" />
                  ) : (
                    <>
                      <span>
                        {reasoningEffort === 'off'
                          ? 'Default'
                          : REASONING_EFFORT_LABEL[reasoningEffort]}
                      </span>
                      <ChevronRightIcon
                        className={`h-3 w-3 shrink-0 text-neutral-600 transition-transform ${
                          effortMenuOpen ? '-rotate-90' : 'rotate-90'
                        }`}
                      />
                    </>
                  )}
                </button>
              </Tooltip>

              {effortMenuOpen && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setEffortMenuOpen(false)} />
                  <div className="anim-pop absolute bottom-full left-0 z-30 mb-2 w-40 overflow-hidden rounded-xl border rb-menu border-neutral-700/70 p-1 shadow-2xl">
                    {(['off', 'low', 'medium', 'high'] as ReasoningEffort[]).map((effort) => {
                      const selected = reasoningEffort === effort
                      return (
                        <button
                          key={effort}
                          onClick={() => {
                            onReasoningChange(effort)
                            setEffortMenuOpen(false)
                          }}
                          className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
                            selected
                              ? 'bg-neutral-800 text-neutral-100'
                              : 'text-neutral-300 hover:bg-neutral-800/60'
                          }`}
                        >
                          <span className="flex-1">{REASONING_EFFORT_LABEL[effort]}</span>
                          {selected && <CheckIcon className="h-3.5 w-3.5 text-amber-400" />}
                        </button>
                      )
                    })}
                  </div>
                </>
              )}
            </div>

            {/* 计划模式：电脑显示文字、手机只显示图标（原来在顶栏，挪进输入区） */}
            <Tooltip
              label={t(
                '计划模式下只能读取和搜索，不能修改文件',
                'In plan mode RB Code can only read and search, not modify files',
                '計畫模式下只能讀取和搜尋，不能修改檔案',
                '計画モードでは読み取りと検索のみで、ファイルは変更できません',
              )}
            >
              <button
                onClick={onTogglePlan}
                aria-label={t('计划模式', 'Plan mode', '計畫模式', '計画モード')}
                className={`inline-flex h-7 shrink-0 items-center justify-center rounded-md border transition-colors ${
                  isMobile ? 'w-7' : 'gap-1 px-2.5 text-[11px]'
                } ${
                  planMode
                    ? 'border-amber-500/60 bg-amber-500/15 text-amber-300'
                    : 'border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200'
                }`}
              >
                {isMobile ? (
                  <ClipboardListIcon className="h-3.5 w-3.5" />
                ) : (
                  <>
                    {t('计划模式', 'Plan mode', '計畫模式', '計画モード')}{' '}
                    {planMode ? t('app.on') : t('app.off')}
                  </>
                )}
              </button>
            </Tooltip>

            <div className="ml-auto flex items-center gap-2">
              <span
                key={statusLabel}
                className="anim-fade hidden text-[11px] text-neutral-500 md:inline"
              >
                {statusLabel}
              </span>
              {/* 语音输入：点一下开始听写、再点一下结束（识别结果实时填进输入框） */}
              {voiceInput && canRecognize() && !running && (
                <Tooltip
                  label={
                    dictating
                      ? t('结束语音输入', 'Stop dictating', '結束語音輸入')
                      : t('语音输入', 'Voice input', '語音輸入')
                  }
                >
                  <button
                    onClick={toggleDictation}
                    aria-label={
                      dictating
                        ? t('结束语音输入', 'Stop dictating', '結束語音輸入')
                        : t('语音输入', 'Voice input', '語音輸入')
                    }
                    className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-transform active:scale-90 ${
                      dictating
                        ? 'animate-pulse border-red-500/70 bg-red-500/15 text-red-300'
                        : 'border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200'
                    }`}
                  >
                    <MicIcon className="h-4 w-4" />
                  </button>
                </Tooltip>
              )}
              {/* 运行中且输入框有内容：在「停止」旁边多出一个纯图标的「插入」按钮
                  （点一下直接插进当前会话，插完输入框清空、这个按钮自动消失）。
                  「停止」始终都在，不会被覆盖。 */}
              {/* 运行中且输入框有内容：点「插入」直接插进当前会话（插完输入框清空、按钮消失）。
                  「停止」始终都在，不会被覆盖。 */}
              {running && hasContent && (
                <Tooltip
                  label={t(
                    '加入待发送队列（可在队列里立即插入或移除）',
                    'Add to the queue (insert now or remove it there)',
                    '加入待傳送佇列（可在佇列裡立即插入或移除）',
                    'キューに追加（そこで即挿入／削除できます）',
                  )}
                >
                  <button
                    onClick={insertInput}
                    aria-label={t('插入', 'Insert', '插入', '挿入')}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-amber-600/70 text-amber-300 transition-transform hover:bg-amber-500/10 active:scale-90"
                  >
                    <ArrowUpIcon className="h-4 w-4" />
                  </button>
                </Tooltip>
              )}
              {running ? (
                <>
                  <LoaderIcon className="h-4 w-4 shrink-0 animate-spin text-amber-400" />
                  <Tooltip label={t('停止生成', 'Stop', '停止生成', '停止')}>
                    <OreButton
                      status="red"
                      onClick={onStop}
                      aria-label={t('停止生成', 'Stop', '停止生成', '停止')}
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-red-500/60 text-red-400 transition-transform hover:bg-red-500/10 active:scale-90"
                    >
                      <StopIcon className="h-4 w-4" />
                    </OreButton>
                  </Tooltip>
                </>
              ) : (
                <Tooltip label={t('发送', 'Send', '傳送', '送信')}>
                  <OreButton
                    status="green"
                    onClick={submit}
                    disabled={disabled || (!text.trim() && attachments.length === 0)}
                    aria-label={t('发送', 'Send', '傳送', '送信')}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-amber-600 text-white transition-transform hover:bg-amber-500 active:scale-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ArrowUpIcon className="h-4 w-4" />
                  </OreButton>
                </Tooltip>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
