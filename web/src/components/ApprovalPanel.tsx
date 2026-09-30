import { useEffect, useState } from 'react'
import type { ApprovalRequest } from '../lib/tools/types.ts'
import { useT } from '../lib/i18n.ts'
import { AlertIcon, CheckIcon, TerminalIcon, WrenchIcon, XCircleIcon } from './icons.tsx'
import OreButton from './OreButton.tsx'

interface Props {
  request: ApprovalRequest | null
  /** 等待秒数，超时视为拒绝 */
  timeoutSeconds: number
  /** 模型还在生成参数时，实时显示已生成的部分 */
  liveDetail?: string | null
  onDecide: (approved: boolean) => void
}

/**
 * 权限审批：内联显示在输入框上方（不弹窗）。
 * 模型一提出工具调用就会先问，参数生成过程中实时展示，不必等它写完。
 */
export default function ApprovalPanel({
  request,
  timeoutSeconds,
  liveDetail,
  onDecide,
}: Props) {
  const t = useT()
  const [remaining, setRemaining] = useState(timeoutSeconds)
  /** 0 = 不限时：一直等你决定，不自动拒绝 */
  const noTimeout = !(timeoutSeconds > 0)

  useEffect(() => {
    if (!request) return
    if (!(timeoutSeconds > 0)) return
    setRemaining(timeoutSeconds)
    const tick = setInterval(() => setRemaining((prev) => Math.max(0, prev - 1)), 1000)
    const timeout = setTimeout(() => onDecide(false), timeoutSeconds * 1000)
    return () => {
      clearInterval(tick)
      clearTimeout(timeout)
    }
  }, [request, timeoutSeconds, onDecide])

  if (!request) return null

  const Icon = request.tool === 'bash' ? TerminalIcon : WrenchIcon
  const detail = liveDetail ?? request.detail

  return (
    <div
      className={`anim-rise border-t ${
        request.dangerous ? 'border-red-900/60 bg-red-950/25' : 'border-amber-900/60 bg-amber-950/20'
      }`}
    >
      <div className="mx-auto max-w-3xl px-4 py-2.5">
        <div className="mb-2 flex items-start gap-2">
          <Icon
            className={`mt-0.5 h-4 w-4 shrink-0 ${
              request.dangerous ? 'text-red-400' : 'text-amber-400'
            }`}
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`text-xs font-medium ${
                  request.dangerous ? 'text-red-200' : 'text-amber-200'
                }`}
              >
                {request.dangerous ? t('approval.danger') : t('approval.needConfirm')}
              </span>
              <span className="inline-flex items-center gap-1 text-[11px] text-neutral-500">
                <AlertIcon className="h-3 w-3" />
                {noTimeout
                  ? t('不限时，等你决定', 'No time limit', '不限時，等你決定', '時間制限なし')
                  : remaining > 0
                    ? `${remaining} ${t('approval.autoReject')}`
                    : t('approval.timedOut')}
              </span>
            </div>
            <p className="mt-0.5 text-sm break-words text-neutral-100">{request.summary}</p>
          </div>
        </div>

        {detail && (
          <pre className="mb-2 max-h-40 overflow-auto rounded-md border border-neutral-800 bg-neutral-950/70 p-2.5 font-mono text-[11px] whitespace-pre-wrap text-neutral-400">
            {detail}
            {liveDetail && (
              <span className="text-neutral-600">
                {'\n'}▍{t('（模型仍在生成…）', '(the model is still generating…)', '（模型仍在生成…）', '（モデルがまだ生成中…）')}
              </span>
            )}
          </pre>
        )}

        <div className="flex justify-end gap-2">
          <OreButton
            status="normal"
            onClick={() => onDecide(false)}
            className="inline-flex items-center gap-1.5 rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:border-neutral-500"
          >
            <XCircleIcon className="h-3.5 w-3.5" />
            {t('approval.reject')}
          </OreButton>
          <OreButton
            status={request.dangerous ? 'red' : 'green'}
            onClick={() => onDecide(true)}
            className={`inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-xs font-medium text-white ${
              request.dangerous ? 'bg-red-600 hover:bg-red-500' : 'bg-amber-600 hover:bg-amber-500'
            }`}
          >
            <CheckIcon className="h-3.5 w-3.5" />
            {t('approval.allow')}
          </OreButton>
        </div>
      </div>
    </div>
  )
}
