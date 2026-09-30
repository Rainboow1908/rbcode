/**
 * 系统通知。
 * 带操作按钮的通知必须走 Service Worker 的 showNotification（普通 new Notification 不支持 actions），
 * 所以这里优先注册 /sw.js，失败时退回普通通知（点击通知本身也能回到页面）。
 */

export interface NotifyAction {
  action: string
  title: string
}

export interface NotifyOptions {
  title: string
  body: string
  /** 通知上的快捷按钮（最多 2 个） */
  actions?: NotifyAction[]
  /** 点击通知或某个按钮时触发 */
  onAction?: (action: string) => void
  /** 相同 tag 的通知会覆盖旧的 */
  tag?: string
}

const handlers = new Map<string, (action: string) => void>()
let registration: ServiceWorkerRegistration | null = null
let initialized = false

/** 注册通知用 Service Worker，并接管它的点击回调 */
export async function initNotifications(): Promise<void> {
  if (initialized) return
  initialized = true
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return

  try {
    registration = await navigator.serviceWorker.register('/sw.js')
  } catch {
    registration = null
  }

  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string; tag?: string; action?: string } | undefined
    if (data?.type !== 'rbcode-notify-action') return
    const key = data.tag ?? ''
    const handler = handlers.get(key)
    if (handler) {
      handler(data.action ?? 'open')
      handlers.delete(key)
    }
  })
}

/** 窗口不在焦点时才发通知，避免打扰 */
export async function notify(options: NotifyOptions): Promise<void> {
  if (typeof Notification === 'undefined' || typeof document === 'undefined') return
  if (document.hasFocus()) return

  if (Notification.permission === 'default') {
    try {
      await Notification.requestPermission()
    } catch {
      // 忽略
    }
  }
  if (Notification.permission !== 'granted') return

  const tag = options.tag ?? `rbcode-${Date.now()}`
  if (options.onAction) handlers.set(tag, options.onAction)

  const payload: NotificationOptions = {
    body: options.body,
    tag,
    // 不自动消失，否则来不及点按钮
    requireInteraction: true,
    data: { tag },
  }

  if (registration && 'showNotification' in registration) {
    try {
      await registration.showNotification(options.title, {
        ...payload,
        ...(options.actions?.length ? { actions: options.actions } : {}),
      } as NotificationOptions & { actions?: NotifyAction[] })
      return
    } catch {
      // 退回普通通知
    }
  }

  const fallback = new Notification(options.title, payload)
  fallback.onclick = () => {
    try {
      window.focus()
    } catch {
      // 忽略
    }
    const handler = handlers.get(tag)
    if (handler) {
      handler('open')
      handlers.delete(tag)
    }
    fallback.close()
  }
}
