import { useEffect, useState } from 'react'
import type { Backend, FileNode } from '../lib/executor/types.ts'
import { useT } from '../lib/i18n.ts'
import { ChevronRightIcon, FileIcon, FolderIcon, LoaderIcon, RefreshIcon } from './icons.tsx'

interface Props {
  backend: Backend | null
  /** 换项目（换工作目录）时重新加载 */
  rootLabel: string
}

/** 文件树面板：懒加载目录，点击展开/折叠 */
export default function FilesPanel({ backend, rootLabel }: Props) {
  const t = useT()
  const [children, setChildren] = useState<Record<string, FileNode[]>>({})
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = async (path: string) => {
    if (!backend) return
    setLoading(path)
    setError(null)
    try {
      const nodes = await backend.list(path)
      setChildren((prev) => ({ ...prev, [path]: nodes }))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(null)
    }
  }

  // 换项目 / 换后端：清空重来
  useEffect(() => {
    setChildren({})
    setOpen({})
    setError(null)
    if (backend) void load('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, rootLabel])

  const toggle = (path: string) => {
    const next = !open[path]
    setOpen((prev) => ({ ...prev, [path]: next }))
    if (next && !children[path]) void load(path)
  }

  const renderLevel = (path: string, depth: number) => {
    const nodes = children[path] ?? []
    return nodes.map((node) => {
      const childPath = node.path
      const isDir = node.kind === 'dir'
      const expanded = Boolean(open[childPath])
      return (
        <div key={childPath}>
          <button
            onClick={() => (isDir ? toggle(childPath) : undefined)}
            style={{ paddingLeft: `${8 + depth * 12}px` }}
            className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs transition-colors ${
              isDir ? 'text-neutral-300 hover:bg-neutral-800/50' : 'text-neutral-400 hover:bg-neutral-800/30'
            }`}
          >
            {isDir ? (
              <ChevronRightIcon
                className={`h-3 w-3 shrink-0 text-neutral-600 transition-transform ${expanded ? 'rotate-90' : ''}`}
              />
            ) : (
              <span className="w-3 shrink-0" />
            )}
            {isDir ? (
              <FolderIcon className="h-3.5 w-3.5 shrink-0 text-amber-500/70" />
            ) : (
              <FileIcon className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
            )}
            <span className="min-w-0 flex-1 truncate">{node.name}</span>
            {isDir && loading === childPath && <LoaderIcon className="h-3 w-3 shrink-0 animate-spin text-neutral-600" />}
          </button>
          {isDir && expanded && renderLevel(childPath, depth + 1)}
        </div>
      )
    })
  }

  if (!backend) {
    return (
      <p className="p-3 text-xs text-neutral-500">
        {t('先打开一个项目', 'Open a project first', '先開啟一個專案')}
      </p>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-neutral-800 px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-500">{rootLabel || '—'}</span>
        <button
          onClick={() => {
            setChildren({})
            setOpen({})
            void load('')
          }}
          aria-label={t('刷新', 'Refresh', '重新整理')}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-500 transition-colors hover:text-neutral-200"
        >
          <RefreshIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      {error && <p className="px-2 py-1 text-[11px] text-amber-400">{error}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto p-1">{renderLevel('', 0)}</div>
    </div>
  )
}
