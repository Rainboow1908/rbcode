import { invoke } from '@tauri-apps/api/core'
import { useCallback, useEffect, useState, type ReactNode } from 'react'

interface Status {
  token: string
  port: number
  root: string
  autostart: boolean
  requests: number
}

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export default function App() {
  const [status, setStatus] = useState<Status | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!isTauri) return
    try {
      const next = await invoke<Status>('get_status')
      setStatus(next)
      setError(null)
    } catch (err) {
      setError(String(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(refresh, 2000)
    return () => clearInterval(timer)
  }, [refresh])

  const flash = (text: string) => {
    setNotice(text)
    setTimeout(() => setNotice(null), 2000)
  }

  async function copyToken() {
    if (!status) return
    try {
      await navigator.clipboard.writeText(status.token)
      flash('令牌已复制')
    } catch {
      flash('复制失败，请手动选择文本')
    }
  }

  async function toggleAutostart(enabled: boolean) {
    try {
      await invoke('set_autostart', { enabled })
      flash(enabled ? '已开启开机自启' : '已关闭开机自启')
      await refresh()
    } catch (err) {
      setError(String(err))
    }
  }

  async function regenerate() {
    try {
      await invoke('regenerate_token')
      flash('已生成新令牌，请在网页里重新填写')
      await refresh()
    } catch (err) {
      setError(String(err))
    }
  }

  if (!isTauri) {
    return (
      <Shell>
        <p className="text-sm text-amber-400">
          这是 companion 的界面，需要通过 Tauri 运行（npm run tauri:dev）。
        </p>
      </Shell>
    )
  }

  return (
    <Shell>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-neutral-400">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
            正在监听 127.0.0.1:{status?.port ?? '…'}
          </div>
          <span className="text-xs text-neutral-600">
            已处理 {status?.requests ?? 0} 次调用
          </span>
        </div>

        <section className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-xs font-medium text-neutral-400">配对令牌</label>
            <div className="flex gap-2">
              <button
                onClick={copyToken}
                className="rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300 hover:border-blue-500 hover:text-blue-300"
              >
                复制
              </button>
              <button
                onClick={regenerate}
                className="rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-400 hover:border-amber-500 hover:text-amber-300"
              >
                重新生成
              </button>
            </div>
          </div>
          <code className="block overflow-x-auto rounded bg-neutral-950 px-2 py-1.5 font-mono text-sm tracking-wide text-emerald-300">
            {status?.token ?? '—'}
          </code>
          <p className="mt-1.5 text-xs text-neutral-500">
            在网页的「设置 → 执行后端」里填入这串令牌。
          </p>
        </section>

        <section className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
          <div>
            <div className="text-xs font-medium text-neutral-300">开机自启动</div>
            <div className="text-xs text-neutral-500">登录 Windows 后自动在后台启动本执行器</div>
          </div>
          <button
            onClick={() => toggleAutostart(!status?.autostart)}
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
              status?.autostart ? 'bg-blue-600' : 'bg-neutral-700'
            }`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                status?.autostart ? 'left-4.5' : 'left-0.5'
              }`}
            />
          </button>
        </section>

        {notice && <p className="text-xs text-emerald-400">{notice}</p>}
        {error && <p className="text-xs text-red-400">{error}</p>}

        <section className="rounded-lg border border-neutral-800 p-3 text-xs text-neutral-500">
          <div className="mb-1 font-medium text-neutral-400">使用步骤</div>
          <ol className="list-inside list-decimal space-y-0.5">
            <li>保持本程序在运行（关掉窗口会缩到系统托盘，不会退出）</li>
            <li>打开 RB Code 网页，在「设置 → 执行后端」里粘贴上面的配对令牌</li>
            <li>点网页左上角「打开项目」，在弹出的目录浏览器里选一个文件夹</li>
          </ol>
        </section>
      </div>
    </Shell>
  )
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-full bg-neutral-950 p-5 text-neutral-100">
      <header className="mb-4">
        <h1 className="text-sm font-semibold">RB Code 本机执行器</h1>
        <p className="mt-0.5 text-xs text-neutral-500">
          让网页里的 agent 能够在你这台电脑上真实执行命令、读写文件
        </p>
      </header>
      {children}
    </div>
  )
}
