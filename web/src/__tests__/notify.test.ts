import { afterEach, describe, expect, it, vi } from 'vitest'

/** 假的 Notification：记录被创建出来的实例，便于断言 */
class FakeNotification {
  static permission: NotificationPermission = 'granted'
  static requestPermission = vi.fn(async () => 'granted' as NotificationPermission)

  static instances: FakeNotification[] = []

  onclick: (() => void) | null = null
  close = vi.fn()

  constructor(
    public title: string,
    public options: NotificationOptions,
  ) {
    FakeNotification.instances.push(this)
  }
}

afterEach(() => {
  FakeNotification.instances = []
  FakeNotification.permission = 'granted'
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('系统通知', () => {
  it('窗口有焦点时不打扰', async () => {
    vi.stubGlobal('Notification', FakeNotification)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)

    const { notify } = await import('../lib/notify.ts')
    await notify({ title: 'T', body: 'B' })

    expect(FakeNotification.instances.length).toBe(0)
  })

  it('窗口失焦、且已授权时发出通知', async () => {
    vi.stubGlobal('Notification', FakeNotification)
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)

    const { notify } = await import('../lib/notify.ts')
    await notify({ title: '需要确认', body: '写入 a.txt', tag: 'rbcode-approval' })

    expect(FakeNotification.instances.length).toBe(1)
    expect(FakeNotification.instances[0].title).toBe('需要确认')
    expect(FakeNotification.instances[0].options.requireInteraction).toBe(true)
  })

  it('没有授权时不发通知', async () => {
    FakeNotification.permission = 'denied'
    vi.stubGlobal('Notification', FakeNotification)
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)

    const { notify } = await import('../lib/notify.ts')
    await notify({ title: 'T', body: 'B' })

    expect(FakeNotification.instances.length).toBe(0)
  })

  it('点击通知会触发对应回调', async () => {
    vi.stubGlobal('Notification', FakeNotification)
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)

    const { notify } = await import('../lib/notify.ts')
    const onAction = vi.fn()
    await notify({ title: 'T', body: 'B', tag: 'rbcode-plan', onAction })

    FakeNotification.instances[0].onclick?.()
    expect(onAction).toHaveBeenCalledWith('open')
  })

  it('有 Service Worker 时用 showNotification，按钮点击会回传', async () => {
    const showNotification = vi.fn(
      async (_title: string, _options?: NotificationOptions & { actions?: unknown[] }) => {},
    )
    const messageHandlers: ((event: { data: unknown }) => void)[] = []

    vi.stubGlobal('navigator', {
      serviceWorker: {
        register: vi.fn(async () => ({ showNotification })),
        addEventListener: (type: string, fn: (event: { data: unknown }) => void) => {
          if (type === 'message') messageHandlers.push(fn)
        },
      },
    })
    vi.stubGlobal('Notification', FakeNotification)
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)

    const { initNotifications, notify } = await import('../lib/notify.ts')
    await initNotifications()

    const onAction = vi.fn()
    await notify({
      title: 'T',
      body: 'B',
      tag: 'rbcode-approval',
      actions: [
        { action: 'approve', title: '允许' },
        { action: 'deny', title: '拒绝' },
      ],
      onAction,
    })

    expect(showNotification).toHaveBeenCalledTimes(1)
    expect(showNotification.mock.calls[0][1]?.actions).toEqual([
      { action: 'approve', title: '允许' },
      { action: 'deny', title: '拒绝' },
    ])
    // 普通 Notification 不该被用到
    expect(FakeNotification.instances.length).toBe(0)

    // 用户点了通知上的「允许」：SW 把动作回传页面
    messageHandlers[0]?.({ data: { type: 'rbcode-notify-action', tag: 'rbcode-approval', action: 'approve' } })
    expect(onAction).toHaveBeenCalledWith('approve')
  })
})
