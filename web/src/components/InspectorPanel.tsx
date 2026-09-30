import { useRef, useState } from 'react'
import { estimateTokens } from '../lib/compact.ts'
import type { RunningShell } from '../lib/executor/companion.ts'
import type { UsageStats } from '../hooks/useAgent.ts'
import { useT, t } from '../lib/i18n.ts'
import type { Message } from '../lib/types.ts'
import Collapse from './Collapse.tsx'
import Tooltip from './Tooltip.tsx'
import XtermTerminal from './XtermTerminal.tsx'
import { cleanTerminalText } from '../lib/ansi.ts'
import { ChevronRightIcon, GaugeIcon, TerminalIcon, XCircleIcon } from './icons.tsx'

interface Props {
  messages: Message[]
  contextWindow: number
  compactThreshold: number
  running: boolean
  rounds: number
  requests: number
  usage: UsageStats
  modelName: string
  backendLabel: string
  startedAt: number | null
  /** 本机正在执行的命令（只有 companion 后端才有；已过滤掉结束的） */
  shells: RunningShell[]
  /** 当前会话 id：据此把终端分成「当前会话」和「后台」两组 */
  activeSessionId: string | null
  /** 会话 id → 标题，用来标注后台命令是哪个会话起的 */
  sessionTitles: Record<string, string>
  onKillShell: (id: string) => void
  /** 每条命令的实时输出（id → 文本），终端栏里显示 */
  shellLogs?: Record<string, string>
  /** 打开/复用常驻会话终端 */
  onOpenConsole?: () => void
  /** 往常驻会话终端写一段 */
  onWriteConsole?: (id: string, data: string) => void
  /** 拖动阈值竖线时回调（70–95）；不传就不显示竖线 */
  onChangeThreshold?: (next: number) => void
  /** 放进工作台抽屉时用：不再依赖 lg 断点隐藏，始终显示 */
  inDrawer?: boolean
  /** 自定义宽度（经典布局下可拖动调整）；不传用默认 w-72 */
  width?: number
  /** 右侧标签栏把「上下文」和「终端」拆成两个面板时用；默认全渲染 */
  view?: 'all' | 'context' | 'terminals'
  /** 嵌进标签栏当面板内容用：不再自带边框/宽度，改成撑满父容器 */
  embedded?: boolean
}

function elapsedLabel(startedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  if (seconds < 60) return t(`${seconds} 秒`, `${seconds}s`, `${seconds} 秒`, `${seconds} 秒`)
  return t(
    `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`,
    `${Math.floor(seconds / 60)}m ${seconds % 60}s`,
    `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`,
    `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`,
  )
}

function formatTokens(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`
  return String(value)
}

function formatDuration(startedAt: number | null): string {
  if (!startedAt) return '—'
  const seconds = Math.floor((Date.now() - startedAt) / 1000)
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m > 0
    ? t(`${m}分${s}秒`, `${m}m ${s}s`, `${m}分${s}秒`, `${m}分${s}秒`)
    : t(`${s}秒`, `${s}s`, `${s}秒`, `${s}秒`)
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-neutral-800 bg-neutral-800/40 p-3">
      <h3 className="mb-2 text-xs font-medium text-neutral-400">{title}</h3>
      {children}
    </section>
  )
}

/** 终端里的一条命令：实时显示输出（不再只写「正在运行」）；展开看完整命令；跑着的可以「结束」 */
function ShellItem({
  shell,
  log,
  onKill,
}: {
  shell: RunningShell
  log: string
  onKill: (id: string) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded border border-neutral-800 bg-neutral-800/30">
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="rb-nohover flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <ChevronRightIcon
            className={`h-3 w-3 shrink-0 text-neutral-600 transition-transform ${open ? 'rotate-90' : ''}`}
          />
          <TerminalIcon className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-300">
            {shell.command}
          </span>
        </button>
        {shell.pid > 0 && (
          <span className="shrink-0 text-[10px] text-neutral-600">PID {shell.pid}</span>
        )}
        <Tooltip label={t('结束这条命令', 'Stop this command', '結束這條命令', 'このコマンドを停止')}>
          <button
            type="button"
            onClick={() => onKill(shell.id)}
            aria-label={t('结束这条命令', 'Stop this command', '結束這條命令', 'このコマンドを停止')}
            className="inline-flex shrink-0 items-center gap-1 rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-400 transition-colors hover:border-red-500 hover:text-red-400"
          >
            <XCircleIcon className="h-3 w-3" />
            {t('结束', 'Stop', '結束', '停止')}
          </button>
        </Tooltip>
      </div>
      <Collapse open={open}>
        <div className="border-t border-neutral-800 px-2 py-1.5 pl-6">
          <pre className="font-mono text-[11px] break-all whitespace-pre-wrap text-neutral-400">
            {shell.command}
          </pre>
          <div className="mt-1 text-[10px] text-neutral-600">
            {t(`已运行 ${elapsedLabel(shell.startedAt)}`, `Running for ${elapsedLabel(shell.startedAt)}`, `已執行 ${elapsedLabel(shell.startedAt)}`, `実行中 ${elapsedLabel(shell.startedAt)}`)}
          </div>
        </div>
      </Collapse>
      <pre className="mx-2 mb-2 max-h-32 overflow-y-auto rounded bg-black/40 p-1.5 font-mono text-[10px] leading-relaxed break-all whitespace-pre-wrap text-neutral-400">
        {cleanTerminalText(log) || t('（等待输出…）', '(waiting for output…)', '（等待輸出…）', '（出力待ち…）')}
      </pre>
    </div>
  )
}

/** 常驻会话终端：一直开着、命令写进它的 stdin，手动关才没（和模型的一次性命令不同） */
function ConsoleCard({
  shell,
  log,
  onWrite,
  onClose,
}: {
  shell: RunningShell
  log: string
  onWrite: (id: string, data: string) => void
  onClose: (id: string) => void
}) {
  const t = useT()
  return (
    <div className="rounded-lg border border-emerald-900/60 bg-neutral-800/40">
      <div className="flex items-center gap-1.5 border-b border-neutral-800 px-2 py-1.5">
        <TerminalIcon className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-neutral-300">
          {t('终端', 'Terminal', '終端')}
        </span>
        {shell.pid > 0 && (
          <span className="shrink-0 text-[10px] text-neutral-600">PID {shell.pid}</span>
        )}
        <button
          type="button"
          onClick={() => onClose(shell.id)}
          className="shrink-0 rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-400 transition-colors hover:border-red-500 hover:text-red-400"
        >
          {t('关闭', 'Close', '關閉')}
        </button>
      </div>
      {/* 终端本体：显示和输入都由 xterm 管，按键直接写进后端 shell 的 stdin */}
      <div className="mx-2 mt-2 h-64 overflow-hidden rounded bg-black/60 p-1">
        <XtermTerminal
          text={log}
          onInput={(data) => onWrite(shell.id, data)}
          localEcho={shell.pty !== true}
          className="h-full w-full"
        />
      </div>
    </div>
  )
}

export default function InspectorPanel({
  messages,
  contextWindow,
  compactThreshold,
  running,
  rounds,
  requests,
  usage,
  modelName,
  backendLabel,
  startedAt,
  shells,
  activeSessionId,
  sessionTitles,
  onKillShell,
  shellLogs,
  onOpenConsole,
  onWriteConsole,
  onChangeThreshold,
  inDrawer = false,
  width,
  view = 'all',
  embedded = false,
}: Props) {
  const t = useT()
  /** 「终端」之外的内容都属于「上下文」面板 */
  const showContext = view !== 'terminals'
  const showTerminals = view !== 'context'
  const barRef = useRef<HTMLDivElement>(null)
  const consoleShell = shells.find((shell) => shell.console === true)
  const groups: { key: string; title: string; items: RunningShell[] }[] = []
  for (const shell of shells) {
    // 常驻会话终端单独一块显示，不混进模型命令的分组里
    if (shell.console === true) continue
    const key = shell.sessionId ?? 'unknown'
    let group = groups.find((g) => g.key === key)
    if (!group) {
      group = {
        key,
        title:
          key === 'unknown' ? t('未知来源', 'Unknown source', '未知來源', '不明なソース') : (sessionTitles[key] ?? key),
        items: [],
      }
      groups.push(group)
    }
    group.items.push(shell)
  }
  groups.sort((a, b) => {
    if (a.key === activeSessionId) return -1
    if (b.key === activeSessionId) return 1
    return a.title.localeCompare(b.title)
  })

  const used = estimateTokens(messages)
  const limit = Math.max(1, contextWindow)
  const usedPercent = Math.min(100, Math.round((used / limit) * 100))
  const thresholdAt = Math.round((contextWindow * compactThreshold) / 100)
  const untilCompact = Math.max(0, thresholdAt - used)
  const hitRate = usage.promptTokens > 0 ? (usage.cachedTokens / usage.promptTokens) * 100 : 0

  const toolCalls = messages.reduce((sum, m) => sum + (m.toolCalls?.length ?? 0), 0)
  const userMessages = messages.filter((m) => m.role === 'user').length

  return (
    <div
      style={embedded || !width ? undefined : { width }}
      className={
        embedded
          ? 'flex min-h-0 w-full flex-1 flex-col gap-3 overflow-y-auto p-3'
          : `${
              inDrawer ? 'flex h-full' : 'hidden lg:flex'
            } w-72 shrink-0 flex-col gap-3 overflow-y-auto border-l border-neutral-800 bg-neutral-950 p-3`
      }
    >
      {showContext && (
        <>
      <Card title={t('上下文窗口', 'Context window', '上下文視窗', 'コンテキストウィンドウ')}>
        <div className="mb-2 flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5 text-xs text-neutral-300">
            <GaugeIcon className="h-3.5 w-3.5 text-emerald-500" />
            {usedPercent >= compactThreshold
              ? t('接近压缩', 'Near compaction', '接近壓縮', '圧縮が近い')
              : t('上下文充足', 'Plenty of context', '上下文充足', 'コンテキストに余裕')}
          </span>
          <span className="font-mono text-xs text-neutral-300">
            {formatTokens(used)}/{formatTokens(limit)}
          </span>
        </div>
        <div ref={barRef} className="relative h-1.5 w-full rounded-full bg-neutral-800">
          <div
            className={`h-full rounded-full ${
              usedPercent >= compactThreshold ? 'bg-amber-500' : 'bg-emerald-500'
            }`}
            style={{ width: `${Math.max(usedPercent, 1)}%` }}
          />
          {/* 压缩阈值竖线：拖动即可调整（70–95%） */}
          {onChangeThreshold && (
            <Tooltip
              label={t(
                `压缩阈值 ${compactThreshold}%（拖动调整，70–95%）`,
                `Compaction threshold ${compactThreshold}% (drag to change, 70–95%)`,
                `壓縮門檻 ${compactThreshold}%（拖曳調整，70–95%）`,
                `圧縮しきい値 ${compactThreshold}%（ドラッグで変更、70–95%）`,
              )}
            >
              <button
                type="button"
                aria-label={t('拖动调整压缩阈值', 'Drag to change the threshold', '拖曳調整壓縮門檻', 'ドラッグでしきい値を変更')}
                onPointerDown={(event) => {
                  event.preventDefault()
                  event.currentTarget.setPointerCapture(event.pointerId)
                }}
                onPointerMove={(event) => {
                  if (event.buttons === 0) return
                  const el = barRef.current
                  if (!el) return
                  const rect = el.getBoundingClientRect()
                  if (rect.width === 0) return
                  const ratio = (event.clientX - rect.left) / rect.width
                  const percent = Math.round(Math.min(95, Math.max(70, ratio * 100)))
                  if (percent !== compactThreshold) onChangeThreshold(percent)
                }}
                className="absolute top-1/2 flex h-4 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center px-1"
                style={{ left: `${Math.min(100, Math.max(0, compactThreshold))}%` }}
              >
                <span className="block h-3.5 w-0.5 rounded bg-amber-400" />
              </button>
            </Tooltip>
          )}
        </div>
        <div className="mt-2 flex items-center justify-between text-[11px]">
          <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-300">
            {t('已用', 'Used', '已用', '使用')} {usedPercent}%
          </span>
          <span className="text-neutral-500">
            {t('阈值', 'Threshold', '門檻', 'しきい値')} {compactThreshold}%
          </span>
        </div>
        <div className="mt-2 text-[11px] text-neutral-500">
          {t(
            `距压缩还有 ${formatTokens(untilCompact)} token`,
            `${formatTokens(untilCompact)} tokens until compaction`,
            `距壓縮還有 ${formatTokens(untilCompact)} token`,
            `圧縮まで ${formatTokens(untilCompact)} トークン`,
          )}
        </div>
      </Card>

      <Card title={t('本轮', 'This turn', '本輪', 'このターン')}>
        <dl className="space-y-1.5 text-xs">
          <div className="flex justify-between">
            <dt className="text-neutral-500">{t('消息', 'Messages', '訊息', 'メッセージ')}</dt>
            <dd className="font-mono text-neutral-300">{messages.length}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-neutral-500">{t('其中用户', 'From user', '其中使用者', 'うちユーザー')}</dt>
            <dd className="font-mono text-neutral-300">{userMessages}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-neutral-500">{t('工具调用', 'Tool calls', '工具呼叫', 'ツール呼び出し')}</dt>
            <dd className="font-mono text-neutral-300">{toolCalls}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-neutral-500">{t('状态', 'Status', '狀態', '状態')}</dt>
            <dd className={running ? 'text-amber-400' : 'text-neutral-300'}>
              {running
                ? t(`进行中（第 ${rounds} 轮）`, `Running (round ${rounds})`, `進行中（第 ${rounds} 輪）`, `実行中（第 ${rounds} ラウンド）`)
                : t('空闲', 'Idle', '閒置', '待機中')}
            </dd>
          </div>
        </dl>
      </Card>
        </>
      )}

      {showTerminals && (
        <div className="rounded-lg border border-neutral-800 bg-neutral-800/40">
          <div className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-neutral-400">
            <TerminalIcon className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
            {t(
              `终端（${shells.length} 个运行中）`,
              `Terminals (${shells.length} running)`,
              `終端（${shells.length} 個執行中）`,
              `ターミナル（${shells.length} 実行中）`,
            )}
          </div>
          <div className="space-y-2 border-t border-neutral-800 p-2">
            {consoleShell ? (
              onWriteConsole && (
                <ConsoleCard
                  shell={consoleShell}
                  log={shellLogs?.[consoleShell.id] ?? ''}
                  onWrite={onWriteConsole}
                  onClose={onKillShell}
                />
              )
            ) : (
              <div className="space-y-2">
                {onOpenConsole && (
                  <button
                    type="button"
                    onClick={onOpenConsole}
                    className="w-full rounded-md border border-neutral-700 bg-neutral-800/50 px-2 py-2 text-xs font-medium text-neutral-200 transition-colors hover:border-emerald-700 hover:text-emerald-300"
                  >
                    {t('打开终端', 'Open terminal', '開啟終端')}
                  </button>
                )}
              </div>
            )}
            {groups.length === 0 ? (
              <p className="px-1 text-[11px] text-neutral-500">
                {t(
                  '模型跑的命令会出现在这里（结束即移除）。',
                  "The model's commands show up here (removed when they finish).",
                  '模型跑的命令會出現在這裡（結束即移除）。',
                )}
              </p>
            ) : (
              groups.map((group) => (
                <div key={group.key} className="space-y-1.5">
                  <div className="truncate px-1 text-[10px] text-neutral-500">{group.title}</div>
                  {group.items.map((shell) => (
                    <ShellItem
                      key={shell.id}
                      shell={shell}
                      log={shellLogs?.[shell.id] ?? ''}
                      onKill={onKillShell}
                    />
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {showContext && (
        <>
      <Card title={t('缓存与用量', 'Cache & usage', '快取與用量', 'キャッシュと使用量')}>
        <dl className="space-y-1.5 text-xs">
          <div className="flex justify-between">
            <dt className="text-neutral-500">{t('缓存命中率', 'Cache hit rate', '快取命中率', 'キャッシュ命中率')}</dt>
            <dd className={`font-mono ${hitRate >= 50 ? 'text-emerald-400' : 'text-neutral-300'}`}>
              {usage.promptTokens > 0 ? `${hitRate.toFixed(1)}%` : '—'}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-neutral-500">{t('命中 / 提示词', 'Cached / prompt', '命中 / 提示詞', 'ヒット / プロンプト')}</dt>
            <dd className="font-mono text-neutral-300">
              {formatTokens(usage.cachedTokens)} / {formatTokens(usage.promptTokens)}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-neutral-500">{t('输出 token', 'Output tokens', '輸出 token', '出力トークン')}</dt>
            <dd className="font-mono text-neutral-300">{formatTokens(usage.completionTokens)}</dd>
          </div>
          {usage.cacheWriteTokens > 0 && (
            <div className="flex justify-between">
              <dt className="text-neutral-500">{t('写入缓存', 'Cache writes', '寫入快取', 'キャッシュ書き込み')}</dt>
              <dd className="font-mono text-neutral-300">{formatTokens(usage.cacheWriteTokens)}</dd>
            </div>
          )}
        </dl>
        {usage.promptTokens === 0 && (
          <p className="mt-2 text-[11px] text-neutral-600">
            {t(
              '接口还没返回 usage 字段（部分第三方服务不返回，命中率无法统计）',
              'The API has not returned a usage field yet (some third-party services omit it, so the hit rate cannot be computed)',
              '介面還沒回傳 usage 欄位（部分第三方服務不支援，命中率無法統計）',
              'API がまだ usage を返していません（一部のサードパーティは返さないため、命中率を算出できません）',
            )}
          </p>
        )}
      </Card>

      <Card title={t('会话指标', 'Session metrics', '工作階段指標', 'セッション指標')}>
        <dl className="space-y-1.5 text-xs">
          <div className="flex justify-between">
            <dt className="text-neutral-500">{t('请求数', 'Requests', '請求數', 'リクエスト数')}</dt>
            <dd className="font-mono text-neutral-300">{requests}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-neutral-500">{t('运行时间', 'Elapsed', '執行時間', '経過時間')}</dt>
            <dd className="font-mono text-neutral-300">{formatDuration(startedAt)}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="shrink-0 text-neutral-500">{t('模型', 'Model', '模型', 'モデル')}</dt>
            <dd className="truncate font-mono text-neutral-300" title={modelName}>
              {modelName || '—'}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="shrink-0 text-neutral-500">{t('后端', 'Backend', '後端', 'バックエンド')}</dt>
            <dd className="truncate text-neutral-300" title={backendLabel}>
              {backendLabel}
            </dd>
          </div>
        </dl>
      </Card>
        </>
      )}
    </div>
  )
}
