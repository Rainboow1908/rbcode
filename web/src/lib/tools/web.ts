import { t } from '../i18n.ts'
import type { WebSearchEngine } from '../types.ts'
import {
  failure,
  optionalNumber,
  optionalString,
  requireString,
  text,
  type ToolContext,
  type ToolDef,
} from './types.ts'

/**
 * 联网访问（搜索 / 抓取），**全部走本机执行器**：
 * 请求从用户本机发出，既不容易被反爬封，也能用上设置里的代理。
 *
 * 没连本机执行器时两个工具都直接报错 —— 不再回退到 Worker
 * （Worker 在 Cloudflare 上，够不到你本机的代理，出口 IP 也容易被封）。
 */

/** 设置里配的代理（空 = 直连）；只对本机执行器发出的联网请求生效 */
function proxySetting(ctx: ToolContext): string | undefined {
  const value = ctx.getSettings?.()?.proxy
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

export const webFetchTool: ToolDef = {
  readOnly: true,
  schema: {
    name: 'web_fetch',
    description:
      'Fetch a URL and return its main text content. Useful for docs, issues and blog posts. Requires the local executor: the request is sent from the user’s own machine and honours their proxy setting, so it is unavailable in the browser sandbox.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL starting with http:// or https://' },
      },
      required: ['url'],
    },
  },
  async run(args, ctx) {
    const url = requireString(args, 'url')

    // 抓取也必须从用户本机发出（能用本机代理；数据中心出口容易被站点/风控拒绝）
    if (!ctx.backend.webFetch) {
      return failure(
        t(
          '抓取网页需要连接本机执行器（请求必须从你本机发出）。请在「设置 → 执行后端」里连接 companion。',
          'Fetching a page requires the local executor — the request must come from your own machine. Connect the companion in Settings → Execution backend.',
          '抓取網頁需要連接本機執行器（請求必須從你本機發出）。請在「設定 → 執行後端」裡連接 companion。',
        ),
      )
    }

    try {
      const data = await ctx.backend.webFetch(url, proxySetting(ctx))
      const header = `${data.title || '(untitled)'}\n${data.url} (HTTP ${data.status})`
      return text(`${header}\n\n${data.text ?? ''}`)
    } catch (err) {
      return failure(`Fetch failed: ${(err as Error).message}`)
    }
  },
}

export const webSearchTool: ToolDef = {
  readOnly: true,
  schema: {
    name: 'web_search',
    description:
      'Search the web and return titles, links and snippets. Use it for recent information or facts you are unsure about. Requires the local executor: the request is sent from the user’s own machine, so it is unavailable in the browser sandbox.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        engine: {
          type: 'string',
          enum: ['auto', 'bing', 'duckduckgo'],
          description:
            'Which search engine to use. "auto" (default) follows the user’s configured engine, or falls back Bing → DuckDuckGo when that is also auto. Pass "bing" or "duckduckgo" to force one.',
        },
        max_results: { type: 'number', description: 'Maximum results. Default 6' },
      },
      required: ['query'],
    },
  },
  async run(args, ctx) {
    const query = requireString(args, 'query')
    const max = optionalNumber(args, 'max_results') ?? 6

    // 搜索必须从用户本机发出（本机执行器），否则搜索引擎会把 CF 数据中心的出口 IP 当成爬虫封掉
    if (!ctx.backend.webSearch) {
      return failure(
        t(
          '联网搜索需要连接本机执行器（搜索请求必须从你本机发出，以避免搜索引擎封禁数据中心 IP）。请在「设置 → 执行后端」里连接 companion，或直接告诉我你想查什么、让我换个方式。',
          'Web search requires the local executor — the request must come from your own machine so search engines do not block datacenter IPs. Connect the companion in Settings → Execution backend.',
          '聯網搜尋需要連接本機執行器（搜尋請求必須從你本機發出，以免搜尋引擎封鎖資料中心 IP）。請在「設定 → 執行後端」裡連接 companion。',
        ),
      )
    }

    // 模型没传或传 auto 时，用设置里手动指定的默认源
    const raw = optionalString(args, 'engine')
    const requested: WebSearchEngine =
      raw === 'bing' || raw === 'duckduckgo' || raw === 'auto' ? raw : 'auto'
    const engine = requested === 'auto' ? (ctx.getSettings?.().webSearchEngine ?? 'auto') : requested

    try {
      const data = await ctx.backend.webSearch(query, engine, proxySetting(ctx))
      if (!data.results?.length) {
        return text(data.note ?? `No results for "${query}"`)
      }

      const body = data.results
        .slice(0, max)
        .map((hit, i) => `${i + 1}. ${hit.title}\n   ${hit.url}\n   ${hit.snippet}`)
        .join('\n\n')
      return text(`Results for "${query}" (source: ${data.engine}):\n\n${body}`)
    } catch (err) {
      return failure(`Search failed: ${(err as Error).message}`)
    }
  },
}
