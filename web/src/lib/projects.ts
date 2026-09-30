/** 一个已经打开过的工作目录 */
export interface Project {
  id: string
  /** 展示名（通常是目录名） */
  name: string
  /** companion 后端是绝对路径；浏览器后端是用户选择的目录名，仅作展示 */
  path: string
  backendKind: 'browser' | 'companion'
  createdAt: number
  lastOpenedAt: number
  /** 置顶时间：有值的排在项目列表最前面 */
  pinnedAt?: number
}

/** 项目排序：置顶的在前，其余按创建时间 */
export function sortProjects(projects: Project[]): Project[] {
  return projects.sort((a, b) => {
    const ap = a.pinnedAt ?? 0
    const bp = b.pinnedAt ?? 0
    if (ap !== bp) return bp - ap
    return a.createdAt - b.createdAt
  })
}

const STORAGE_KEY = 'rbcode.projects.v1'

export function loadProjects(): Project[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Project[]
    if (!Array.isArray(parsed)) return []
    return sortProjects(
      parsed.filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string'),
    )
  } catch {
    return []
  }
}

export function saveProjects(projects: Project[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(projects))
  } catch {
    // 忽略写入失败
  }
}

/** 加入或更新一个项目；列表按“创建时间”排列，点击/切换不会改变顺序 */
export function upsertProject(projects: Project[], project: Project): Project[] {
  const exists = projects.some((p) => p.id === project.id)
  const next = exists
    ? // 保留最初的 createdAt 与置顶状态，否则重新打开会重置顺序
      projects.map((p) =>
        p.id === project.id
          ? { ...p, ...project, createdAt: p.createdAt, pinnedAt: p.pinnedAt }
          : p,
      )
    : [...projects, project]
  return sortProjects(next)
}

/** 置顶 / 取消置顶某个项目 */
export function setProjectPinned(projects: Project[], id: string, pinned: boolean): Project[] {
  return sortProjects(
    projects.map((p) =>
      p.id === id ? { ...p, pinnedAt: pinned ? Date.now() : undefined } : p,
    ),
  )
}

/** 浏览器后端的目录句柄 key：直接用 id，不再二次加工，避免同目录出现两把钥匙 */
export function browserHandleKey(projectId: string): string {
  return projectId.replace(/^browser:/, '')
}

export function removeProject(projects: Project[], id: string): Project[] {
  return projects.filter((p) => p.id !== id)
}

/** 用后端信息构造一个项目条目 */
export function projectFrom(
  backend: { kind: 'browser' | 'companion'; rootLabel: string },
  id?: string,
): Project {
  const name = backend.rootLabel.split(/[\\/]/).filter(Boolean).pop() ?? backend.rootLabel
  return {
    id: id ?? `${backend.kind}:${backend.rootLabel}`,
    name: name || '未命名项目',
    path: backend.rootLabel,
    backendKind: backend.kind,
    createdAt: Date.now(),
    lastOpenedAt: Date.now(),
  }
}
