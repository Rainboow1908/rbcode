import { t } from './i18n.ts'
import type { ApiStyle, ModelInfo, RequestHeader } from './types.ts'

/** 去掉结尾斜杠，避免拼出 //models */
export function normalizeBaseURL(url: string): string {
  return url.trim().replace(/\/+$/, '')
}
/** 拉取模型列表所需的最小连接信息 */
export interface ModelListTarget {
  baseURL: string
  apiKey: string
  apiStyle: ApiStyle
  /** 提供商配置的自定义请求头 */
  headers?: RequestHeader[]
}

/** 鉴权头：Anthropic 用 x-api-key，其余用 Bearer；自定义头先铺底，鉴权头可覆盖同名项 */
function authHeaders(target: ModelListTarget): Record<string, string> {
  const extra: Record<string, string> = {}
  for (const header of target.headers ?? []) {
    const key = header.key.trim()
    if (key) extra[key] = header.value
  }
  if (target.apiStyle === 'anthropic') {
    return {
      ...extra,
      'x-api-key': target.apiKey,
      'anthropic-version': '2023-06-01',
      // Anthropic 默认禁止浏览器直连，需要显式开启
      'anthropic-dangerous-direct-browser-access': 'true',
    }
  }
  return { ...extra, Authorization: `Bearer ${target.apiKey}` }
}

interface RawModel {
  id?: string
  owned_by?: string
  created?: number
  created_at?: string
  display_name?: string
}

function toModelInfo(raw: RawModel): ModelInfo | null {
  if (!raw?.id) return null
  const created =
    typeof raw.created === 'number'
      ? raw.created
      : raw.created_at
        ? Math.floor(new Date(raw.created_at).getTime() / 1000)
        : undefined
  return { id: raw.id, ownedBy: raw.owned_by ?? raw.display_name, created }
}

/**
 * 拉取供应商可用模型列表。
 * OpenAI 兼容：GET {base}/models
 * Anthropic：  GET {base}/models（带 anthropic-version 头）
 */
export async function listModels(
  target: ModelListTarget,
  signal?: AbortSignal,
): Promise<ModelInfo[]> {
  const base = normalizeBaseURL(target.baseURL)
  if (!base)
    throw new Error(
      t('请先填写接口地址（baseURL）', 'Enter the API base URL first', '請先填寫介面網址（baseURL）', '先に API のベース URL を入力してください'),
    )

  const url = `${base}/models`
  let res: Response
  try {
    res = await fetch(url, { headers: authHeaders(target), signal })
  } catch (err) {
    throw new Error(
      t(
        `请求 ${url} 失败：${(err as Error).message}。可能是网络不通，或该接口不允许浏览器跨域直连。`,
        `Request to ${url} failed: ${(err as Error).message}. The network may be unreachable, or the endpoint may not allow direct cross-origin browser access.`,
        `請求 ${url} 失敗：${(err as Error).message}。可能是網路不通，或該介面不允許瀏覽器跨域直連。`,
        `${url} へのリクエストに失敗しました: ${(err as Error).message}。ネットワークが不通か、この API がブラウザからの直接アクセス（CORS）を許可していない可能性があります。`,
      ),
    )
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(
      t(
        `拉取模型列表失败 HTTP ${res.status}：${body.slice(0, 300) || res.statusText}`,
        `Failed to fetch the model list: HTTP ${res.status} — ${body.slice(0, 300) || res.statusText}`,
        `取得模型列表失敗 HTTP ${res.status}：${body.slice(0, 300) || res.statusText}`,
        `モデル一覧の取得に失敗しました: HTTP ${res.status} — ${body.slice(0, 300) || res.statusText}`,
      ),
    )
  }

  const json = (await res.json()) as { data?: RawModel[] } | RawModel[]
  const list = Array.isArray(json) ? json : (json.data ?? [])
  return list.map(toModelInfo).filter((m): m is ModelInfo => m !== null)
}
