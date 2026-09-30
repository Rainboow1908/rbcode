import { useCallback, useEffect, useState } from 'react'
import type { CompanionBackend } from '../lib/executor/companion.ts'
import type { FileNode } from '../lib/executor/types.ts'
import ContextMenu, { type MenuItem } from './ContextMenu.tsx'
import { ConfirmDialog } from './Dialog.tsx'
import Tooltip from './Tooltip.tsx'
import { useT } from '../lib/i18n.ts'
import { ArrowLeftIcon, ChevronRightIcon, FolderIcon, LoaderIcon, PlusIcon, RefreshIcon, XIcon } from './icons.tsx'
import OreButton from './OreButton.tsx'

interface Props {
  open: boolean
  companion: CompanionBackend
  onClose: () => void
  onSelect: (path: string) => void
}

interface Shortcut {
  key: string
  label: string
  path: string
}

const SHORTCUT_LABELS: Record<string, [string, string, string, string]> = {
  desktop: ['桌面', 'Desktop', '桌面', 'デスクトップ'],
  downloads: ['下载', 'Downloads', '下載', 'ダウンロード'],
  documents: ['文档', 'Documents', '文件', 'ドキュメント'],
  pictures: ['图片', 'Pictures', '圖片', 'ピクチャ'],
  videos: ['视频', 'Videos', '影片', 'ビデオ'],
  music: ['音乐', 'Music', '音樂', 'ミュージック'],
  home: ['主目录', 'Home', '主目錄', 'ホーム'],
}

/**
 * 用 Windows 的「已知文件夹」API 解析这些目录的真实位置
 * （资源管理器里把桌面/文档重定向到别的盘时，也能拿到正确的路径）。
 */
const SHORTCUT_COMMAND = [
  "$p=[Environment]",
  "$s=New-Object -ComObject Shell.Application",
  '"desktop|$($p::GetFolderPath(\'Desktop\'))"',
  '"downloads|$($s.NameSpace(\'shell:Downloads\').Self.Path)"',
  '"documents|$($p::GetFolderPath(\'MyDocuments\'))"',
  '"pictures|$($p::GetFolderPath(\'MyPictures\'))"',
  '"videos|$($p::GetFolderPath(\'MyVideos\'))"',
  '"music|$($p::GetFolderPath(\'MyMusic\'))"',
  '"home|$($p::GetFolderPath(\'UserProfile\'))"',
].join('; ')

/** 把绝对路径拆成可点击的面包屑 */
function crumbs(path: string): { label: string; value: string }[] {
  if (!path) return []
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  const out: { label: string; value: string }[] = []
  let acc = ''
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part
    out.push({ label: part, value: acc.endsWith(':') ? `${acc}\\` : acc })
  }
  return out
}

/** 修改时间：照资源管理器显示成 2026/09/24 15:30；旧版 companion 没这个字段就显示 — */
function formatDate(ms?: number): string {
  if (!ms) return '—'
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function parentOf(path: string): string | null {  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[a-zA-Z]:$/.test(normalized)) return null
  const idx = normalized.lastIndexOf('/')
  if (idx <= 0) return null
  const parent = normalized.slice(0, idx)
  return /^[a-zA-Z]:$/.test(parent) ? `${parent}\\` : parent
}

export default function DirectoryPicker({ open, companion, onClose, onSelect }: Props) {
  const t = useT()
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<FileNode[]>([])
  const [drives, setDrives] = useState<string[]>([])
  const [shortcuts, setShortcuts] = useState<Shortcut[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  /** 右键菜单：位置 + 命中的目录项（点在空白处则没有 entry） */
  const [menu, setMenu] = useState<{ x: number; y: number; entry?: FileNode } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<FileNode | null>(null)

  const browse = useCallback(
    async (target: string) => {
      setLoading(true)
      setError(null)
      try {
        const list = await companion.listDir(target)
        setEntries(list)
        setPath(target)
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setLoading(false)
      }
    },
    [companion],
  )

  const loadDrives = useCallback(async () => {
    try {
      const list = await companion.drives()
      setDrives(list)
      return list
    } catch {
      setDrives([])
      return [] as string[]
    }
  }, [companion])

  /** 刷新：在根目录时重列驱动器，否则重读当前目录 */
  const refresh = useCallback(async () => {
    if (path) await browse(path)
    else await loadDrives()
  }, [browse, loadDrives, path])

  useEffect(() => {
    if (!open) return
    setError(null)
    setPath('')
    void loadDrives()
    // 快捷文件夹：解析失败就静默忽略（非 Windows 之类）
    void companion
      .shell(SHORTCUT_COMMAND)
      .then((result) => {
        const items: Shortcut[] = []
        for (const line of result.stdout.split('\n')) {
          const [key, ...rest] = line.trim().split('|')
          const value = rest.join('|').trim()
          if (!key || !value) continue
          const entry = SHORTCUT_LABELS[key]
          if (entry) items.push({ key, label: t(entry[0], entry[1], entry[2], entry[3]), path: value })
        }
        setShortcuts(items)
      })
      .catch(() => setShortcuts([]))
  }, [companion, loadDrives, open])

  if (!open) return null

  const parent = parentOf(path)
  const currentCrumbs = crumbs(path)

  async function createFolder() {
    const name = newName.trim()
    if (!name || !path) return
    try {
      // Windows 用反斜杠、Android/Linux 用正斜杠，按当前路径判断
      const sep = path.includes('\\') ? '\\' : '/'
      await companion.mkdir(`${path.replace(/[\\/]+$/, '')}${sep}${name}`)
      setNewName('')
      setCreating(false)
      await browse(path)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function removeEntry(entry: FileNode) {
    try {
      await companion.remove(entry.path, { recursive: true })
      await browse(path)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  /** 右键菜单项：目录项上是一套，空白处是另一套 */
  const menuItems: MenuItem[] = !menu
    ? []
    : menu.entry
      ? [
          {
            label: t('打开', 'Open', '開啟', '開く'),
            onClick: () => void browse(menu.entry!.path),
          },
          {
            label: t('选择此目录', 'Use this folder', '選擇此目錄', 'このフォルダを選択'),
            onClick: () => onSelect(menu.entry!.path),
          },
          {
            label: t('在此新建文件夹', 'New folder inside', '在此新增資料夾', 'この中に新しいフォルダ'),
            onClick: () => {
              const target = menu.entry!.path
              void browse(target).then(() => setCreating(true))
            },
          },
          { label: '-', onClick: () => {}, separator: true },
          {
            label: t('删除', 'Delete', '刪除', '削除'),
            danger: true,
            onClick: () => setPendingDelete(menu.entry!),
          },
        ]
      : [
          { label: t('新建文件夹', 'New folder', '新增資料夾', '新しいフォルダ'), onClick: () => setCreating(true) },
          { label: t('刷新', 'Refresh', '重新整理', '更新'), onClick: () => void refresh() },
        ]

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
      <div className="rb-solid flex h-[72vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-neutral-700/70 bg-neutral-950/70 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-3">
          <FolderIcon className="h-4 w-4 text-neutral-400" />
          <h2 className="text-sm font-semibold text-neutral-100">
            {t('选择一个目录作为项目', 'Choose a folder as the project', '選擇一個目錄作為專案', 'プロジェクトにするフォルダを選択')}
          </h2>
          <div className="ml-auto flex items-center gap-1">
            <Tooltip label={t('刷新', 'Refresh', '重新整理', '更新')}>
              <button
                onClick={() => void refresh()}
                aria-label={t('刷新', 'Refresh', '重新整理', '更新')}
                className="rb-nohover rounded-md p-1.5 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
              >
                <RefreshIcon className="h-4 w-4" />
              </button>
            </Tooltip>
            <Tooltip label={t('关闭', 'Close', '關閉', '閉じる')}>
              <button
                onClick={onClose}
                aria-label={t('关闭', 'Close', '關閉', '閉じる')}
                className="rb-nohover rounded-md p-1.5 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
              >
                <XIcon className="h-4 w-4" />
              </button>
            </Tooltip>
          </div>
        </div>

        {/* 工具栏：上一级 / 新建文件夹 / 刷新（照系统文件管理器的位置） */}
        <div className="flex items-center gap-1 border-b border-neutral-800 px-3 py-2">
          <Tooltip label={t('上一级', 'Up one level', '上一層', '一つ上へ')}>
            <OreButton status="normal"
              onClick={() => parent != null && void browse(parent)}
              disabled={!parent}
              aria-label={t('上一级', 'Up one level', '上一層', '一つ上へ')}
              className="rb-nohover inline-flex items-center gap-1 rounded-md border border-neutral-700/70 px-2 py-1 text-xs text-neutral-300 transition-colors hover:border-neutral-500 disabled:opacity-40"
            >
              <ArrowLeftIcon className="h-3.5 w-3.5" />
              {t('上一级', 'Up', '上一層', '上へ')}
            </OreButton>
          </Tooltip>

          <OreButton status="normal"
            onClick={() => setCreating((v) => !v)}
            disabled={!path}
            className="rb-nohover inline-flex items-center gap-1 rounded-md border border-neutral-700/70 px-2 py-1 text-xs text-neutral-300 transition-colors hover:border-amber-600 hover:text-amber-200 disabled:opacity-40"
          >
            <PlusIcon className="h-3.5 w-3.5" />
            {t('新建文件夹', 'New folder', '新增資料夾', '新しいフォルダ')}
          </OreButton>

          <Tooltip label={t('刷新', 'Refresh', '重新整理', '更新')}>
            <OreButton status="normal"
              onClick={() => void refresh()}
              aria-label={t('刷新', 'Refresh', '重新整理', '更新')}
              className="rb-nohover inline-flex items-center gap-1 rounded-md border border-neutral-700/70 px-2 py-1 text-xs text-neutral-300 transition-colors hover:border-neutral-500"
            >
              <RefreshIcon className="h-3.5 w-3.5" />
              {t('刷新', 'Refresh', '重新整理', '更新')}
            </OreButton>
          </Tooltip>
        </div>

        {/* 面包屑 */}
        <div className="flex flex-wrap items-center gap-1 border-b border-neutral-800 px-4 py-2 text-xs">
          <button
            onClick={() => {
              setPath('')
              setEntries([])
            }}
            className="rb-nohover rounded px-1.5 py-0.5 text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
          >
            {t('此电脑', 'This PC', '本機', 'PC')}
          </button>
          {currentCrumbs.map((crumb, index) => (
            <span key={crumb.value} className="flex items-center gap-1">
              <ChevronRightIcon className="h-3 w-3 text-neutral-600" />
              <button
                onClick={() => void browse(crumb.value)}
                className={`rb-nohover rounded px-1.5 py-0.5 transition-colors hover:bg-neutral-800 ${
                  index === currentCrumbs.length - 1
                    ? 'text-neutral-200'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 快捷位置 */}
          <aside className="w-28 shrink-0 overflow-y-auto border-r border-neutral-800 p-2 sm:w-40">
            {shortcuts.length > 0 && (
              <>
                <p className="px-2 py-1 text-[11px] text-neutral-600">
                  {t('常用位置', 'Places', '常用位置', 'よく使う場所')}
                </p>
                {shortcuts.map((item) => (
                  <button key={item.key}
                    onClick={() => void browse(item.path)}
                    className="rb-nohover flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-neutral-300 transition-colors hover:bg-neutral-800"
                  >
                    <FolderIcon className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
                    <span className="min-w-0 truncate">{item.label}</span>
                  </button>
                ))}
              </>
            )}

            <p className="mt-3 px-2 py-1 text-[11px] text-neutral-600 first:mt-0">
              {t('驱动器', 'Drives', '磁碟機', 'ドライブ')}
            </p>
            {drives.map((drive) => (
              <button key={drive}
                onClick={() => void browse(drive)}
                className="rb-nohover flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-neutral-300 transition-colors hover:bg-neutral-800"
              >
                <FolderIcon className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
                {drive}
              </button>
            ))}
          </aside>

          {/* 目录列表（右键空白处 / 右键目录项 都有菜单） */}
          <div
            className="min-h-0 flex-1 overflow-y-auto p-2"
            onContextMenu={(event) => {
              event.preventDefault()
              const row = (event.target as HTMLElement).closest(
                '[data-dir-entry]',
              ) as HTMLElement | null
              const entryPath = row?.dataset.dirEntry
              const entry = entryPath ? entries.find((item) => item.path === entryPath) : undefined
              setMenu({ x: event.clientX, y: event.clientY, entry })
            }}
          >
            {loading && (
              <div className="flex items-center gap-2 px-2 py-3 text-xs text-neutral-500">
                <LoaderIcon className="h-3 w-3 animate-spin" />
                {t('读取中…', 'Loading…', '讀取中…', '読み込み中…')}
              </div>
            )}

            {!loading && !path && (
              <p className="px-2 py-3 text-xs text-neutral-600">
                {t(
                  '左边选一个常用位置或驱动器，也可以在下面直接粘贴路径。',
                  'Pick a place or drive on the left, or paste a path below.',
                  '左邊選一個常用位置或磁碟機，也可以在下面直接貼上路徑。',
                  '左から場所やドライブを選ぶか、下にパスを貼り付けてください。',
                )}
              </p>
            )}

            {!loading && path && (
              <>
                {/* 表头：照系统文件管理器的列 */}
                <div className="flex items-center gap-3 border-b border-neutral-800 px-3 py-1.5 text-[11px] text-neutral-500">
                  <span className="min-w-0 flex-1">{t('名称', 'Name', '名稱', '名前')}</span>
                  <span className="hidden w-36 shrink-0 sm:block">{t('修改日期', 'Date modified', '修改日期', '更新日時')}</span>
                  <span className="hidden w-14 shrink-0 sm:block">{t('类型', 'Type', '類型', '種類')}</span>
                </div>
                {parent && (
                  <button onClick={() => void browse(parent)}
                    className="rb-nohover flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm text-neutral-400 transition-colors hover:bg-neutral-800"
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <FolderIcon className="h-4 w-4 shrink-0 text-neutral-600" />
                      ..
                    </span>
                    <span className="hidden w-36 shrink-0 text-[11px] text-neutral-600 sm:block">—</span>
                    <span className="hidden w-14 shrink-0 text-[11px] text-neutral-600 sm:block">
                      {t('文件夹', 'Folder', '資料夾', 'フォルダ')}
                    </span>
                  </button>
                )}
                {entries.length === 0 ? (
                  <p className="px-2 py-3 text-xs text-neutral-600">
                    {t('这个目录下没有子目录', 'No subfolders here', '這個目錄下沒有子目錄', 'このフォルダにサブフォルダはありません')}
                  </p>
                ) : (
                  entries.map((entry) => (
                    <button key={entry.path}
                      data-dir-entry={entry.path}
                      onClick={() => void browse(entry.path)}
                      className="rb-nohover flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm text-neutral-300 transition-colors hover:bg-neutral-800"
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <FolderIcon className="h-4 w-4 shrink-0 text-neutral-500" />
                        <span className="min-w-0 truncate">{entry.name}</span>
                      </span>
                      <span className="hidden w-36 shrink-0 truncate text-[11px] text-neutral-500 sm:block">
                        {formatDate(entry.modified)}
                      </span>
                      <span className="hidden w-14 shrink-0 text-[11px] text-neutral-500 sm:block">
                        {entry.kind === 'dir'
                          ? t('文件夹', 'Folder', '資料夾', 'フォルダ')
                          : t('文件', 'File', '檔案', 'ファイル')}
                      </span>
                    </button>
                  ))
                )}
              </>
            )}

            {error && <p className="px-2 py-3 text-xs text-amber-400">{error}</p>}
          </div>
        </div>

        {/* 底部：新建文件夹 / 路径 / 打开 / 选择 */}
        <div className="border-t border-neutral-800 px-4 py-3">
          {creating && (
            <div className="anim-fade mb-2 flex items-center gap-2">
              <PlusIcon className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void createFolder()
                  if (e.key === 'Escape') setCreating(false)
                }}
                placeholder={t('新文件夹名称', 'New folder name', '新資料夾名稱', '新しいフォルダ名')}
                className="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-200 outline-none focus:border-amber-500"
              />
              <OreButton status="normal"
                onClick={() => void createFolder()}
                className="shrink-0 rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-300 transition-colors hover:border-amber-600 hover:text-amber-200"
              >
                {t('创建', 'Create', '建立', '作成')}
              </OreButton>
            </div>
          )}

          <div className="flex items-center gap-2">
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && path) void browse(path)
              }}
              placeholder={t('也可以直接粘贴一个绝对路径', 'Or paste an absolute path', '也可以直接貼上絕對路徑', '絶対パスを貼り付けても構いません')}
              className="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 font-mono text-xs text-neutral-200 outline-none focus:border-amber-500"
            />

            <OreButton
              status="normal"
              onClick={() => path && void browse(path)}
              disabled={!path}
              className="shrink-0 rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 transition-colors hover:border-neutral-500 disabled:opacity-40"
            >
              {t('打开', 'Open', '開啟', '開く')}
            </OreButton>
            <OreButton
              status="green"
              onClick={() => onSelect(path)}
              disabled={!path}
              className="shrink-0 rounded-md bg-amber-600 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-500 disabled:opacity-40"
            >
              {t('选择此目录', 'Use this folder', '選擇此目錄', 'このフォルダを選択')}
            </OreButton>
          </div>
        </div>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('删除这个文件夹？', 'Delete this folder?', '刪除這個資料夾？', 'このフォルダを削除しますか？')}
        message={t(
          `会连同里面的所有内容一起删除，且不可撤销：\n${pendingDelete?.name ?? ''}`,
          `Everything inside will be deleted too, and this cannot be undone:\n${pendingDelete?.name ?? ''}`,
          `會連同裡面的所有內容一起刪除，且無法復原：\n${pendingDelete?.name ?? ''}`,
          `中身ごと削除され、元に戻せません：\n${pendingDelete?.name ?? ''}`,
        )}
        confirmLabel={t('删除', 'Delete', '刪除', '削除')}
        danger
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete
          setPendingDelete(null)
          if (target) void removeEntry(target)
        }}
      />
    </div>
  )
}
