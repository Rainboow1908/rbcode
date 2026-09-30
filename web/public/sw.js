// 通知的点击处理：把用户点的按钮回传给页面，并把窗口拉到前台
self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('notificationclick', (event) => {
  const notification = event.notification
  const action = event.action || 'open'
  const tag = notification.tag || ''
  const data = notification.data || {}
  notification.close()

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          client.postMessage({
            type: 'rbcode-notify-action',
            tag: data.tag || tag,
            action,
          })
          if ('focus' in client) return client.focus()
        }
        return self.clients.openWindow('/')
      }),
  )
})
