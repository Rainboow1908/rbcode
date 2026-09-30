import { useEffect, useState } from 'react'
import type { AskRequest } from '../lib/tools/types.ts'
import { useT } from '../lib/i18n.ts'
import { CheckIcon, ChevronRightIcon, HelpCircleIcon, SkipIcon } from './icons.tsx'
import OreButton from './OreButton.tsx'

interface Props {
  request: AskRequest | null
  onAnswer: (answer: string) => void
}

/**
 * 模型的提问：内联显示在输入框上方，与输入框同一套浮动卡片，可收起 / 展开。
 * 多个问题时**一次只显示一个**，答完点「下一题」再看下一个，不会一次全铺出来。
 * 每题支持多选、自定义输入、跳过。
 */
export default function AskPanel({ request, onAnswer }: Props) {
  const t = useT()
  const [step, setStep] = useState(0)
  /**
   * 每题一份草稿。skipped 单独记一笔 —— 否则「跳过」不留痕迹，
   * 回头再看这题时既没答案、也不能前进（「下一题」会一直禁用）。
   */
  const [answers, setAnswers] = useState<
    Record<number, { picked: string[]; custom: string; skipped: boolean }>
  >({})
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    setStep(0)
    setAnswers({})
    setCollapsed(false)
  }, [request])

  if (!request) return null

  const { questions } = request
  const total = questions.length
  const index = Math.min(step, Math.max(0, total - 1))
  const question = questions[index]
  if (!question) return null

  const answer = answers[index] ?? { picked: [], custom: '', skipped: false }

  /** 用户有实际动作（选/输入）就清掉「跳过」标记 */
  function setCurrent(next: Partial<{ picked: string[]; custom: string; skipped: boolean }>) {
    setAnswers((prev) => ({
      ...prev,
      [index]: { ...answer, ...next, skipped: next.skipped ?? false },
    }))
  }

  function toggle(label: string) {
    const picked = answer.picked.includes(label)
      ? answer.picked.filter((item) => item !== label)
      : question.multiSelect
        ? [...answer.picked, label]
        : [label]
    setCurrent({ picked })
  }

  /** 把已答的整理成给模型的文本 */
  function buildAnswer(overrides?: Record<number, string>): string {
    return questions
      .map((item, i) => {
        if (overrides && overrides[i] !== undefined) {
          return `Q: ${item.question}\nA: ${overrides[i]}`
        }
        const value = answers[i]
        const parts = [...(value?.picked ?? [])]
        const custom = (value?.custom ?? '').trim()
        if (custom) parts.push(custom)
        if (parts.length === 0 && value?.skipped) {
          return `Q: ${item.question}\nA: (skipped)`
        }
        return `Q: ${item.question}\nA: ${parts.length ? parts.join(', ') : '(no answer)'}`
      })
      .join('\n\n')
  }

  /** 有内容、或已经明确跳过，都算这题处理完了，可以前进 */
  const handled = answer.picked.length > 0 || answer.custom.trim() !== '' || answer.skipped
  const isLast = index === total - 1
  /** 进度只数真正处理过的题；输入清空、取消勾选后要跟着回退 */
  const doneCount = Object.values(answers).filter(
    (item) => item.picked.length > 0 || item.custom.trim() !== '' || item.skipped,
  ).length

  function skip() {
    setCurrent({ skipped: true })
    if (isLast) onAnswer(buildAnswer({ [index]: '(skipped)' }))
    else setStep(index + 1)
  }

  return (
    <div className="anim-rise px-4 pt-2">
      <div className="mx-auto max-w-3xl">
        <div className="rounded-xl border border-amber-700/50 bg-neutral-900/70 shadow-lg">
          {/* 头部：点整行收起 / 展开 */}
          <button
            onClick={() => setCollapsed((value) => !value)}
            className="rb-nohover group flex w-full items-center gap-2 rounded-t-xl px-3 py-2.5 text-left"
          >
            <ChevronRightIcon
              className={`h-3.5 w-3.5 shrink-0 text-neutral-500 transition-transform ${
                collapsed ? '' : 'rotate-90'
              }`}
            />
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500/15">
              <HelpCircleIcon className="h-3 w-3 text-amber-400" />
            </span>
            <span className="shrink-0 text-xs font-medium text-neutral-200">
              {t('模型在等你回答', 'The model is waiting for your answer', '模型正在等你回答', 'モデルが回答を待っています')}
            </span>
            {total > 1 && (
              <span className="shrink-0 rounded-full bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
                {t('第', 'Q', '第', '第')} {index + 1}/{total} {t('题', '', '題', '問')}
              </span>
            )}
            {collapsed ? (
              <span className="min-w-0 flex-1 truncate text-xs text-neutral-500">
                {`· ${question.question}`}
              </span>
            ) : (
              <>
                {total > 1 && (
                  <span className="ml-auto shrink-0 text-[11px] text-neutral-500">
                    {doneCount}/{total} {t('已处理', 'done', '已處理', '完了')}
                  </span>
                )}
              </>
            )}
            <span
              className={`shrink-0 text-[11px] text-neutral-600 transition-colors group-hover:text-neutral-400 ${
                collapsed ? 'ml-auto' : total > 1 ? 'ml-3' : 'ml-auto'
              }`}
            >
              {collapsed
                ? t('展开', 'Expand', '展開', '展開')
                : t('收起', 'Collapse', '收合', '折りたたむ')}
            </span>
          </button>

          <div
            className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${
              collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'
            }`}
          >
            <div className="min-h-0 overflow-hidden">
              <div className="max-h-[45vh] overflow-y-auto px-3 pb-3">
              {/* 多题时用分段条表示进度 */}
              {total > 1 && (
                <div className="mb-2.5 flex gap-1">
                  {questions.map((_, i) => (
                    <span
                      key={i}
                      className={`h-1 flex-1 rounded-full transition-colors ${
                        i <= index ? 'bg-amber-500/70' : 'bg-neutral-800'
                      }`}
                    />
                  ))}
                </div>
              )}

              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-sm leading-relaxed break-words whitespace-pre-wrap text-neutral-100">
                  {question.question}
                </span>
                {question.options.length > 0 && (
                  <span className="text-[11px] text-neutral-500">
                    {question.multiSelect
                      ? t('可多选', 'multi-select', '可多選', '複数選択')
                      : t('单选', 'single choice', '單選', '単一選択')}{' '}
                    · {t('也可自己输入', 'or type your own', '也可自行輸入', '自分で入力も可')}
                  </span>
                )}
              </div>

              {question.options.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {question.options.map((option) => {
                    const active = answer.picked.includes(option.label)
                    return (
                      <button
                        key={option.label}
                        onClick={() => toggle(option.label)}
                        className={`flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors ${
                          active
                            ? 'border-amber-600/60 bg-amber-500/10'
                            : 'border-neutral-800 bg-neutral-950/40 hover:border-neutral-600 hover:bg-neutral-900/60'
                        }`}
                      >
                        <span
                          className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors ${
                            active ? 'border-amber-500 bg-amber-500' : 'border-neutral-600'
                          }`}
                        >
                          {active && <CheckIcon className="h-3 w-3 text-neutral-950" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm text-neutral-100">{option.label}</span>
                          {option.description && (
                            <span className="mt-0.5 block text-xs text-neutral-500">
                              {option.description}
                            </span>
                          )}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}

              {/* 自己输入永远是用户的退路，不受模型参数影响 */}
              <input
                value={answer.custom}
                autoFocus={!collapsed && question.options.length === 0}
                onChange={(e) => setCurrent({ ...answer, custom: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  e.preventDefault()
                  if (isLast) onAnswer(buildAnswer())
                  else setStep(index + 1)
                }}
                placeholder={
                  question.options.length > 0
                    ? t('补充或自定义答案', 'Add or write your own answer', '補充或自訂答案', '補足または独自の回答')
                    : t('输入你的回答', 'Type your answer', '輸入你的回答', '回答を入力')
                }
                className="mt-2.5 w-full rounded-lg border border-neutral-700 bg-neutral-950/60 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-amber-600"
              />

              <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2">
                {/* 「跳过」也一样：用户总得有条退路 */}
                <OreButton
                  status="normal"
                  onClick={skip}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
                >
                  <SkipIcon className="h-3.5 w-3.5" />
                  {isLast
                    ? t('跳过并提交', 'Skip and submit', '跳過並提交', 'スキップして送信')
                    : t('跳过这题', 'Skip this question', '跳過這題', 'この質問をスキップ')}
                </OreButton>

                {index > 0 && (
                  <OreButton
                    status="normal"
                    onClick={() => setStep(index - 1)}
                    className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
                  >
                    {t('上一题', 'Previous', '上一題', '前へ')}
                  </OreButton>
                )}

                <OreButton
                  status="green"
                  onClick={() => {
                    if (isLast) onAnswer(buildAnswer())
                    else setStep(index + 1)
                  }}
                  disabled={!handled}
                  title={
                    handled
                      ? undefined
                      : t('先作答，或点「跳过」', 'Answer first, or click "Skip"', '請先作答，或點「跳過」', '先に回答するか「スキップ」を押してください')
                  }
                  className="rounded-lg bg-amber-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {isLast ? t('提交', 'Submit', '提交', '送信') : t('下一题', 'Next', '下一題', '次へ')}
                </OreButton>
              </div>
              </div>
            </div>
          </div>
          {collapsed && <div className="h-1" />}
        </div>
      </div>
    </div>
  )
}
