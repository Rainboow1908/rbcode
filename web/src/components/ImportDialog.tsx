import { useState } from 'react'
import { useT } from '../lib/i18n.ts'
import type { Backend } from '../lib/executor/types.ts'
import {
  importCandidate,
  loadImportMarker,
  saveImportMarker,
  type ImportCandidate,
} from '../lib/importSessions.ts'
import Dialog from './Dialog.tsx'
import { CheckIcon, LoaderIcon } from './icons.tsx'
import OreButton from './OreButton.tsx'

interface Props {
  open: boolean
  backend: Backend | null
  projectRoot: string
  candidates: ImportCandidate[]
  onClose: () => void
  /** 导完之后通知外面刷新会话列表 */
  onImported: () => void
}

const KIND_LABEL: Record<ImportCandidate['kind'], [string, string, string]> = {
  project: ['本项目', 'this project', '本專案'],
  local: ['项目内', 'in project', '專案內'],
  legacy: ['旧版目录', 'legacy folder', '舊版目錄'],
  global: ['全局', 'global', '全域'],
  archive: ['归档', 'archive', '封存'],
}

function formatDay(at: number, t: (zh: string, en: string, tw: string) => string): string {
  if (!at) return t('时间未知', 'time unknown', '時間未知')
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/**
 * 兼容导入：列出磁盘上扫到的会话，勾选后导进 `.rbcode`。
 * 只读源文件；导入过的会在项目里打标记，不会再重复出现。
 */
export default function ImportDialog({
  open,
  backend,
  projectRoot,
  candidates,
  onClose,
  onImported,
}: Props) {
  const t = useT()
  const [picked, setPicked] = useState<string[]>(() => candidates.map((item) => item.key))
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')

  if (!open) return null

  const toggle = (key: string) =>
    setPicked((prev) => (prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]))

  const run = async () => {
    if (!backend || picked.length === 0) return
    setBusy(true)
    const marker = await loadImportMarker(backend)
    let done = 0
    for (const candidate of candidates) {
      if (!picked.includes(candidate.key)) continue
      setProgress(
        t(
          `正在导入 ${done + 1}/${picked.length}…`,
          `Importing ${done + 1}/${picked.length}…`,
          `正在匯入 ${done + 1}/${picked.length}…`,
        ),
      )
      try {
        const sessionId = await importCandidate(backend, projectRoot, candidate)
        marker[candidate.key] = { importedAt: Date.now(), sessionId }
        done += 1
      } catch {
        // 某一个坏了就跳过，别挡住其余的
      }
    }
    await saveImportMarker(backend, marker)
    setBusy(false)
    setProgress('')
    onImported()
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!busy) onClose()
      }}
      className="w-[600px] max-w-[94vw]"
    >
      <div className="p-4">
        <div className="text-sm font-medium text-neutral-100">
          {t(
            `发现 ${candidates.length} 个可导入的会话`,
            `Found ${candidates.length} session(s) to import`,
            `發現 ${candidates.length} 個可匯入的工作階段`,
          )}
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
          {t(
            '这些对话记录在磁盘上（来自本机其他编程工具）。导入后会成为本项目的会话，工具调用会一并转换；源文件只读，不会被改动或删除。',
            'These conversations live on disk (from another local coding tool). Importing adds them as sessions of this project, tool calls included. Source files are read-only and never modified.',
            '這些對話記錄在磁碟上（來自本機其他程式設計工具）。匯入後會成為本專案的工作階段，工具呼叫會一併轉換；來源檔案唯讀，不會被改動或刪除。',
          )}
        </p>

        <div className="mt-3 max-h-[46vh] overflow-y-auto rounded-md border border-neutral-800">
          {candidates.map((candidate) => {
            const active = picked.includes(candidate.key)
            const [zh, en, tw] = KIND_LABEL[candidate.kind]
            return (
              <button
                key={candidate.key}
                type="button"
                disabled={busy}
                onClick={() => toggle(candidate.key)}
                className={`flex w-full items-start gap-2 border-b border-neutral-800/60 px-2.5 py-2 text-left transition-colors last:border-b-0 ${
                  active ? 'bg-amber-500/10' : 'hover:bg-neutral-800/40'
                }`}
              >
                <span
                  className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
                    active ? 'border-amber-500 bg-amber-500' : 'border-neutral-600'
                  }`}
                >
                  {active && <CheckIcon className="h-2.5 w-2.5 text-neutral-950" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-neutral-200">{candidate.title}</span>
                  <span className="mt-0.5 block text-[10px] text-neutral-600">
                    {t(zh, en, tw)} · {formatDay(candidate.updatedAt, t)}
                  </span>
                </span>
              </button>
            )
          })}
        </div>

        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-[11px] text-neutral-500">
            {busy ? (
              <span className="inline-flex items-center gap-1.5">
                <LoaderIcon className="h-3.5 w-3.5 animate-spin" />
                {progress}
              </span>
            ) : (
              t(`已选中 ${picked.length} 个`, `${picked.length} selected`, `已選取 ${picked.length} 個`)
            )}
          </span>
          <span className="flex items-center gap-2">
            <OreButton
              status="normal"
              type="button"
              disabled={busy}
              onClick={onClose}
              className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 transition-colors hover:border-neutral-500 disabled:opacity-40"
            >
              {t('稍后', 'Later', '稍後')}
            </OreButton>
            <OreButton
              status="green"
              type="button"
              disabled={busy || picked.length === 0}
              onClick={() => void run()}
              className="rounded-md bg-amber-600 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t(`导入选中的 ${picked.length} 个`, `Import ${picked.length}`, `匯入選取的 ${picked.length} 個`)}
            </OreButton>
          </span>
        </div>
      </div>
    </Dialog>
  )
}
