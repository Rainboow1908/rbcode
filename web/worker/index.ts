/**
 * Cloudflare Worker 入口。
 * 只做两件事：`/api/health` + 把其余请求交给静态资源（SPA）。
 *
 * 联网搜索和网页抓取都**不在这里**：它们都由用户本机的执行器发起
 * （参见 companion 的 `web.search` / `web.fetch`）。
 * 原因：请求从 Cloudflare 数据中心的出口 IP 发出时，很容易被搜索引擎 / 站点风控
 * 当成爬虫封掉；而且放在本机才能用上用户自己配的代理（比如 Clash 的 127.0.0.1:7897）。
 */

interface Fetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>
}

export interface Env {
  ASSETS: Fetcher
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, ts: Date.now() })
    }

    if (url.pathname.startsWith('/api/')) {
      return Response.json({ error: `unknown API endpoint: ${url.pathname}` }, { status: 404 })
    }

    return env.ASSETS.fetch(request)
  },
}
