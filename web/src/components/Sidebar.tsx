import Tooltip from './Tooltip.tsx'
import { useT, t } from '../lib/i18n.ts'
import type { Project } from '../lib/projects.ts'
import type { SessionMeta } from '../lib/sessions.ts'
import OreButton from './OreButton.tsx'
import {
  BranchIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderPlusIcon,
  LoaderIcon,
  LogoIcon,
  PinIcon,
  PlusIcon,
  SettingsIcon,
  TrashIcon,
} from './icons.tsx'

interface Props {
  projects: Project[]
  activeProjectId: string | null
  /** 展开了会话列表的项目 id（与选中状态无关） */
  expandedIds: string[]
  sessions: SessionMeta[]
  /** 每个项目各自缓存的会话列表（只读，用于展开非当前项目时显示） */
  sessionCache: Record<string, SessionMeta[]>
  /** 正在生成的会话 id */
  runningSessionIds: string[]
  activeSessionId: string | null
  loadingSessions: boolean
  onNewChat: () => void
  onOpenProject: () => void
  onSelectProject: (project: Project) => void
  onToggleExpand: (projectId: string) => void
  onSelectSession: (id: string, projectId: string) => void
  onDeleteSession: (id: string) => void
  onRemoveProject: (id: string) => void
  onOpenSettings: () => void
  /** 右键会话（删除 / 置顶 / 重命名） */
  onSessionMenu: (event: React.MouseEvent, session: SessionMeta, projectId: string) => void
  /** 右键项目（删除记录 / 置顶 / 在文件资源管理器显示） */
  onProjectMenu: (event: React.MouseEvent, project: Project) => void
  /** 在某个项目下新建会话 */
  onNewSession: (project: Project) => void
  /** 打开回收站 */
  onOpenTrash: () => void
  /** 回收站里的条目数（0 时不显示角标） */
  trashCount: number
  /** 自定义宽度（经典布局下可拖动调整）；不传用默认 w-64 */
  width?: number
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return t('刚刚', 'just now', '剛剛', 'たった今')
  if (minutes < 60) return t(`${minutes} 分钟`, `${minutes} min`, `${minutes} 分鐘`, `${minutes} 分`)
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t(`${hours} 小时`, `${hours} h`, `${hours} 小時`, `${hours} 時間`)
  const days = Math.floor(hours / 24)
  if (days < 30) return t(`${days} 天`, `${days} d`, `${days} 天`, `${days} 日`)
  return new Date(ts).toLocaleDateString()
}

export default function Sidebar({
  projects,
  activeProjectId,
  expandedIds,
  sessions,
  sessionCache,
  runningSessionIds,
  activeSessionId,
  loadingSessions,
  onOpenProject,
  onSelectProject,
  onToggleExpand,
  onSelectSession,
  onDeleteSession,
  onRemoveProject,
  onOpenSettings,
  onSessionMenu,
  onProjectMenu,
  onNewSession,
  onOpenTrash,
  trashCount,
  width,
}: Props) {
  const t = useT()
  return (
    <aside
      style={width ? { width } : undefined}
      className="flex w-64 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950"
    >
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-1">
        <LogoIcon className="h-6 w-6 shrink-0" />
        <span className="text-sm font-semibold tracking-tight text-neutral-100">RB Code</span>
      </div>

      <div className="p-3">
        <OreButton status="normal"
          onClick={onOpenProject}
          className="flex w-full items-center gap-2 rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-200 hover:border-amber-600 hover:bg-neutral-900"
        >
          <FolderPlusIcon className="h-4 w-4" />
          {t('新增项目', 'New Project', '新增專案', '新しいプロジェクト')}
        </OreButton>
      </div>

      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-xs text-neutral-500">
          {t('项目', 'Projects', '專案', 'プロジェクト')}
        </span>
        <Tooltip label={t('打开一个目录作为项目', 'Open a folder as a project', '開啟資料夾作為專案', 'フォルダをプロジェクトとして開く')}>
          <button
            onClick={onOpenProject}
            aria-label={t('打开一个目录作为项目', 'Open a folder as a project', '開啟資料夾作為專案', 'フォルダをプロジェクトとして開く')}
            className="rb-nohover rounded p-0.5 text-neutral-500 transition-colors hover:text-neutral-200"
          >
            <FolderPlusIcon className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {projects.length === 0 ? (
          <p className="px-2 py-3 text-xs text-neutral-600">
            {t(
              '还没有项目。点右上角的图标打开一个目录。',
              'No projects yet. Use the icon at the top right to open a folder.',
              '尚無專案。點右上角的圖示開啟資料夾。',
              'プロジェクトがありません。右上のアイコンでフォルダを開いてください。',
            )}
          </p>
        ) : (
          projects.map((project) => {
            const isActive = project.id === activeProjectId
            const isOpen = expandedIds.includes(project.id)
            // 统一用缓存：当前项目和非当前项目都能正确显示自己的会话
            const items = sessionCache[project.id] ?? (isActive ? sessions : [])
            const loading = isActive && loadingSessions
            return (
              <div key={project.id} className="mb-0.5">
                <div
                  onContextMenu={(event) => onProjectMenu(event, project)}
                  className={`group flex items-center gap-1 rounded-md pr-1 transition-colors ${
                    isActive
                      ? 'bg-neutral-800/70 text-neutral-100'
                      : 'text-neutral-400 hover:bg-neutral-800/50'
                  }`}
                >
                  {/* 箭头：只负责展开/折叠，不影响选中 */}
                  <Tooltip
                    label={
                      isOpen
                        ? t('折叠会话', 'Collapse sessions', '收合工作階段', 'セッションを折りたたむ')
                        : t('展开会话', 'Expand sessions', '展開工作階段', 'セッションを展開')
                    }
                  >
                    <button
                      onClick={() => onToggleExpand(project.id)}
                      aria-label={
                        isOpen
                          ? t('折叠会话', 'Collapse sessions', '收合工作階段', 'セッションを折りたたむ')
                          : t('展开会话', 'Expand sessions', '展開工作階段', 'セッションを展開')
                      }
                      className="rb-nohover shrink-0 rounded p-1 text-neutral-600 hover:text-neutral-300"
                    >
                      <ChevronRightIcon
                        className={`h-3 w-3 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                      />
                    </button>
                  </Tooltip>

                  {/* 名字：只负责选中项目 */}
                  <button
                    onClick={() => onSelectProject(project)}
                    title={t('打开项目 ', 'Open project ', '開啟專案 ', 'プロジェクトを開く ') + project.name}
                    className="rb-nohover flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left text-sm hover:text-neutral-100"
                  >
                    <FolderIcon className="h-3.5 w-3.5 shrink-0" />
                    {project.pinnedAt ? (
                      <PinIcon className="h-3 w-3 shrink-0 text-amber-500" />
                    ) : null}
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  </button>

                  {/* 新建会话（在这个项目下） */}
                  <Tooltip
                    label={t('在该项目下新建会话', 'New session in this project', '在此專案新增工作階段', 'このプロジェクトに新規セッション')}
                    className="ml-1"
                  >
                    <button
                      onClick={() => onNewSession(project)}
                      aria-label={t('在该项目下新建会话', 'New session in this project', '在此專案新增工作階段', 'このプロジェクトに新規セッション')}
                      className="rb-nohover hidden shrink-0 rounded p-0.5 text-neutral-600 transition-colors hover:text-neutral-200 group-hover:block"
                    >
                      <PlusIcon className="h-3.5 w-3.5" />
                    </button>
                  </Tooltip>

                  <Tooltip
                    label={t('归档项目（不会删除磁盘文件）', 'Archive project (keeps files on disk)', '歸檔專案（不會刪除磁碟檔案）', 'アーカイブ（ファイルは残ります）')}
                  >
                    <button
                      onClick={() => onRemoveProject(project.id)}
                      aria-label={t('归档项目（不会删除磁盘文件）', 'Archive project (keeps files on disk)', '歸檔專案（不會刪除磁碟檔案）', 'アーカイブ（ファイルは残ります）')}
                      className="rb-nohover hidden shrink-0 rounded p-0.5 text-neutral-600 transition-colors hover:text-red-400 group-hover:block"
                    >
                      <TrashIcon className="h-3 w-3" />
                    </button>
                  </Tooltip>
                </div>

                {isOpen && (
                  <div className="mt-0.5 ml-3 space-y-0.5 border-l border-neutral-800 pl-2">
                    {loading ? (
                      <div className="flex items-center gap-1.5 px-2 py-1 text-xs text-neutral-600">
                        <LoaderIcon className="h-3 w-3 animate-spin" />
                        {t('正在加载…', 'Loading…', '載入中…', '読み込み中…')}
                      </div>
                    ) : items.length === 0 ? (
                      <p className="px-2 py-1 text-xs text-neutral-600">
                        {t('暂无会话', 'No sessions', '尚無工作階段', 'セッションなし')}
                      </p>
                    ) : (
                      items.map((session) => (
                        <div
                          key={session.id}
                          onContextMenu={(event) => onSessionMenu(event, session, project.id)}
                          className={`group flex items-center gap-1 rounded px-2 py-1 text-xs ${
                            session.id === activeSessionId
                              ? 'bg-neutral-800 text-neutral-200'
                              : 'text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300'
                          }`}
                        >
                          <button
                            onClick={() => onSelectSession(session.id, project.id)}
                            className="rb-nohover flex min-w-0 flex-1 items-center gap-1.5 text-left"
                          >
                            {session.pinnedAt ? (
                              <PinIcon className="h-3 w-3 shrink-0 text-amber-500" />
                            ) : null}
                            {session.forkedAt ? (
                              <span
                                className="shrink-0 text-sky-400/80"
                                title={t('由其它会话分叉而来', 'Branched from another session', '由其它工作階段分叉而來', '他のセッションから分岐')}
                              >
                                <BranchIcon className="h-3 w-3" />
                              </span>
                            ) : null}
                            <span className="min-w-0 flex-1 truncate">{session.title}</span>
                            {runningSessionIds.includes(session.id) ? (
                              <span
                                className="shrink-0"
                                title={t('正在生成', 'Generating', '正在生成', '生成中')}
                              >
                                <LoaderIcon className="h-3 w-3 animate-spin text-amber-400" />
                              </span>
                            ) : (
                              <span className="shrink-0 text-[10px] text-neutral-600">
                                {relativeTime(session.updatedAt)}
                              </span>
                            )}
                          </button>
                          <Tooltip label={t('归档该会话', 'Archive this session', '歸檔工作階段', 'セッションをアーカイブ')}>
                            <button
                              onClick={() => onDeleteSession(session.id)}
                              aria-label={t('归档该会话', 'Archive this session', '歸檔工作階段', 'セッションをアーカイブ')}
                              className="rb-nohover hidden shrink-0 text-neutral-600 hover:text-red-400 group-hover:block"
                            >
                              <TrashIcon className="h-3 w-3" />
                            </button>
                          </Tooltip>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      <div className="border-t border-neutral-800 p-2">
        <button onClick={onOpenTrash}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300"
        >
          <TrashIcon className="h-3.5 w-3.5" />
          {t('回收站', 'Trash', '回收筒', 'ゴミ箱')}
          {trashCount > 0 && (
            <span className="ml-auto rounded-full bg-neutral-800 px-1.5 text-[10px] leading-4 text-neutral-400">
              {trashCount}
            </span>
          )}
        </button>
        <button onClick={onOpenSettings}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300"
        >
          <SettingsIcon className="h-3.5 w-3.5" />
          {t('设置', 'Settings', '設定', '設定')}
        </button>
      </div>
    </aside>
  )
}
