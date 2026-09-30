import { useState, type ReactNode } from 'react'
import type { ApprovalRequest, AskRequest } from '../lib/tools/types.ts'
import { useT } from '../lib/i18n.ts'
import { formatDuration } from '../lib/statusBar.ts'
import ApprovalPanel from './ApprovalPanel.tsx'
import AskPanel from './AskPanel.tsx'
import { StopIcon, XIcon } from './icons.tsx'
import OreButton from './OreButton.tsx'

interface Props {
  running: boolean
  rounds: number
  startedAt: number | null
  /** 权限审批：网页版那个组件原样搬过来（倒计时、实时参数都一样） */
  approval: ApprovalRequest | null
  approvalTimeout: number
  approvalLiveDetail: string | null
  onDecideApproval: (approved: boolean) => void
  /** 模型的提问：同样是网页版那个组件（多题分步 / 多选 / 自定义 / 跳过都在） */
  ask: AskRequest | null
  onAnswerAsk: (answer: string) => void
  /** 往对话里插一句 */
  onInsert: (text: string) => void
  /** 终止当前这一轮 */
  onStop: () => void
  onClose: () => void
  /** 主对话区：App 传进来的那个 MessageList（和网页版同一份 JSX / props） */
  children: ReactNode
}

/**
 * 悬浮窗里的迷你版界面 —— 框架是这里写的，内容**全部**是网页版的原件：
 *
 *   - 中间主对话区 = 同一个 `MessageList`（思考折叠、工具卡片、撤销、自动翻滚、
 *     回到最新、点工具看参数……全部继承，不用重写）
 *   - 权限审批 = 同一个 `ApprovalPanel`，模型的提问 = 同一个 `AskPanel`
 *   - 只有外面这圈「状态条 + 插话框」是为了小窗另写的
 *
 * 主题由 FloatingWindow 复制过来的样式表 + 镜像的 <html> 类决定，这里只用语义色。
 */
export default function FloatingAgent({
  running,
  rounds,
  startedAt,
  approval,
  approvalTimeout,
  approvalLiveDetail,
  onDecideApproval,
  ask,
  onAnswerAsk,
  onInsert,
  onStop,
  onClose,
  children,
}: Props) {
  const t = useT()

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-200">
      {/* 状态条 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-800 px-2.5 py-1.5">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${running ? 'bg-amber-400' : 'bg-neutral-600'}`} />
        <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-300">
          {running
            ? t(`运行中 · 第 ${rounds} 轮`, `Running · round ${rounds}`, `執行中 · 第 ${rounds} 輪`)
            : t('空闲', 'Idle', '閒置')}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-neutral-500">
          {startedAt ? formatDuration(startedAt) : ''}
        </span>
        {running && (
          <button
            onClick={onStop}
            aria-label={t('终止', 'Stop', '終止')}
            className="flex h-6 shrink-0 items-center gap-1 rounded border border-neutral-700 px-1.5 text-[10px] text-neutral-300 transition-colors hover:border-red-500 hover:text-red-400"
          >
            <StopIcon className="h-3 w-3" />
            {t('终止', 'Stop', '終止')}
          </button>
        )}
        <button
          onClick={onClose}
          aria-label={t('关闭', 'Close', '關閉')}
          className="rb-nohover flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 主对话区：网页版那个 MessageList，自带滚动 / 自动翻滚 / 回到最新 */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>

      {/* 权限审批 / 模型提问：原样复用网页版组件，贴在插话框上方 */}
      <ApprovalPanel
        request={approval}
        timeoutSeconds={approvalTimeout}
        liveDetail={approvalLiveDetail}
        onDecide={onDecideApproval}
      />
      <AskPanel request={ask} onAnswer={onAnswerAsk} />

      {/* 插话 */}
      <FloatingComposer onInsert={onInsert} />
    </div>
  )
}

/** 插话框：小窗专属（Enter 发送、Shift+Enter 换行），样式跟网页版输入框一套 */
function FloatingComposer({ onInsert }: { onInsert: (text: string) => void }) {
  const t = useT()
  const [text, setText] = useState('')

  const submit = () => {
    const value = text.trim()
    if (!value) return
    onInsert(value)
    setText('')
  }

  return (
    <div className="flex shrink-0 items-end gap-1.5 border-t border-neutral-800 px-2.5 py-2">
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            submit()
          }
        }}
        rows={2}
        placeholder={t('插一句…（Enter 发送）', 'Say something… (Enter to send)', '插一句…（Enter 傳送）')}
        className="rb-field min-h-0 flex-1 resize-none rounded-md bg-neutral-800/60 px-2 py-1.5 text-[11px] text-neutral-100 outline-none placeholder:text-neutral-600 focus-visible:ring-1 focus-visible:ring-neutral-600"
      />
      <OreButton status="normal"
        onClick={submit}
        disabled={text.trim() === ''}
        className="shrink-0 rounded-md border border-neutral-700 px-2.5 py-1.5 text-[11px] text-neutral-300 transition-colors hover:border-amber-600 hover:text-amber-200 disabled:opacity-40"
      >
        {t('发送', 'Send', '傳送')}
      </OreButton>
    </div>
  )
}
