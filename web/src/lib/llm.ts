import { t } from './i18n.ts'
import { normalizeBaseURL } from './models.ts'
import { parseSSE } from './sse.ts'
import type { LlmTarget, Message, ToolCall } from './types.ts'

/** 暴露给模型的工具声明 */
export interface ToolSchema {
  name: string
  description: string
  /** JSON Schema（object 类型） */
  parameters: Record<string, unknown>
}

export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  /** 工具参数正在生成中的实时进度 */
  | { type: 'tool_progress'; index: number; name: string; argsSoFar: string }
  | { type: 'tool_calls'; calls: ToolCall[] }
  | { type: 'usage'; usage: Usage }
  /** 本次请求正在重试（连不上 / 服务端暂时不可用） */
  | { type: 'retry'; attempt: number; max: number; delayMs: number; error: string }
  /** 模型输出被 max_tokens 截断了（这一轮很可能是半截停下的） */
  | { type: 'truncated' }
  | { type: 'done' }

/** 一次请求的用量，用于统计缓存命中率 */
export interface Usage {
  promptTokens?: number
  completionTokens?: number
  /** 命中了前缀缓存的提示词 token 数 */
  cachedTokens?: number
  /** 写入缓存的 token 数（Anthropic） */
  cacheWriteTokens?: number
}

export interface ChatOptions {
  target: LlmTarget
  /** 系统提示词，单独传（Anthropic 需要独立字段） */
  system: string
  messages: Message[]
  tools: ToolSchema[]
  signal?: AbortSignal
  onChunk: (chunk: StreamChunk) => void
}

/** 向模型发起一次流式对话；工具调用通过 onChunk 回调交付 */
export async function chatStream(opts: ChatOptions): Promise<void> {
  if (!opts.target.model)
    throw new Error(t('请先选择模型', 'Pick a model first', '請先選擇模型', '先にモデルを選択してください'))
  if (opts.target.apiStyle === 'anthropic') {
    await anthropicStream(opts)
  } else {
    await openaiStream(opts)
  }
}

/** 把设置里配的采样参数写进请求体；没配的不发，交给接口默认值 */
function applySampling(target: LlmTarget, payload: Record<string, unknown>): void {
  // 部分推理模型不接受采样参数，显式关掉就不发
  if (target.sendSampling !== false) {
    if (typeof target.temperature === 'number' && Number.isFinite(target.temperature)) {
      payload.temperature = target.temperature
    }
    if (typeof target.topP === 'number' && Number.isFinite(target.topP)) {
      payload.top_p = target.topP
    }
  }
  if (typeof target.maxTokens === 'number' && target.maxTokens > 0) {
    // 新版 OpenAI 推理模型要 max_completion_tokens，其余仍用 max_tokens
    payload[target.maxTokensParam ?? 'max_tokens'] = target.maxTokens
  }
}

/** Anthropic 扩展思考的预算（token）；off 不启用 */
const ANTHROPIC_THINKING_BUDGET: Record<'low' | 'medium' | 'high', number> = {
  low: 2048,
  medium: 8192,
  high: 16384,
}

/** 提供商配置的自定义请求头（去掉空 key） */
function extraHeaders(target: LlmTarget): Record<string, string> {
  const out: Record<string, string> = {}
  for (const header of target.headers ?? []) {
    const key = header.key.trim()
    if (key) out[key] = header.value
  }
  return out
}

/* ---------------------- 网络抖动 / 服务暂时不可用时的重试 ---------------------- */

/** 最多重试几次（用户要求 10 次） */
const RETRY_MAX = 10
/** 首次等待时长；之后随次数变长，封顶 RETRY_CAP_MS */
const RETRY_BASE_MS = 3_000
const RETRY_CAP_MS = 20_000

export interface RetryInfo {
  attempt: number
  max: number
  delayMs: number
  error: string
}

/** 值得重试的状态码：限流、网关抖动、服务端暂时不可用 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
}

/** 可被 AbortSignal 打断的 sleep */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 带重试的 fetch：连不上 / 5xx / 429 时等几秒再试，最多 RETRY_MAX 次。
 * 用户点「停止」会带 AbortSignal —— 这种情况立刻退出，不重试。
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  onRetry: ((info: RetryInfo) => void) | undefined,
): Promise<Response> {
  let lastError: unknown = null
  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    try {
      const res = await fetch(url, init)
      if (!isRetryableStatus(res.status) || attempt === RETRY_MAX) return res
      lastError = new Error(`HTTP ${res.status}`)
      // 把响应体丢掉，释放连接
      await res.body?.cancel().catch(() => undefined)
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err
      if (attempt === RETRY_MAX) throw err
      lastError = err
    }
    const delayMs = Math.min(RETRY_BASE_MS * attempt, RETRY_CAP_MS)
    onRetry?.({
      attempt,
      max: RETRY_MAX,
      delayMs,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    })
    await sleep(delayMs, signal)
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/* ---------------------- 模型不支持图片时自动降级 ---------------------- */

/** 已知「不接受图片输入」的模型（key = baseURL|model）：碰到一次就记住，之后不再发图。 */
const noImageModels = new Set<string>()

function modelKey(target: LlmTarget): string {
  return `${normalizeBaseURL(target.baseURL)}|${target.model}`
}

function imageUnsupported(body: string): boolean {
  return /unsupported image|image.{0,40}(not supported|unsupported|invalid)|invalid.{0,20}image/i.test(body)
}

/** 去掉图片附件（保留文字与文件引用）；「只有图片」的消息换成一句说明。 */
function withoutImages(messages: Message[]): Message[] {
  return messages.map((message) => {
    const attachments = message.attachments ?? []
    if (!attachments.some((a) => a.kind === 'image')) return message
    const rest = attachments.filter((a) => a.kind !== 'image')
    const content =
      message.content && message.content.trim()
        ? message.content
        : '[图片已省略：当前模型不支持图片输入]'
    return { ...message, content, attachments: rest.length > 0 ? rest : undefined }
  })
}

/**
 * 发一次请求；如果因为「模型不支持图片」被拒，就记住这个模型、去掉图片再试一次。
 * 这样 computer use 的截图不会把整轮对话卡死（顶多模型看不到画面）。
 */
async function postJson(
  target: LlmTarget,
  url: string,
  headers: Record<string, string>,
  messages: Message[],
  build: (messages: Message[]) => Record<string, unknown>,
  signal?: AbortSignal,
  onRetry?: (info: RetryInfo) => void,
): Promise<Response> {
  const key = modelKey(target)
  const firstMessages = noImageModels.has(key) ? withoutImages(messages) : messages
  let res = await fetchWithRetry(
    url,
    { method: 'POST', headers, body: JSON.stringify(build(firstMessages)), signal },
    signal,
    onRetry,
  )
  if (res.ok) return res

  let body = await res.text().catch(() => '')
  if (!noImageModels.has(key) && imageUnsupported(body)) {
    noImageModels.add(key)
    res = await fetchWithRetry(
      url,
      { method: 'POST', headers, body: JSON.stringify(build(withoutImages(messages))), signal },
      signal,
      onRetry,
    )
    if (res.ok) return res
    body = await res.text().catch(() => '')
  }
  throw new Error(
    t(
      `模型接口返回 HTTP ${res.status}：${body.slice(0, 500) || res.statusText}`,
      `The model API returned HTTP ${res.status}: ${body.slice(0, 500) || res.statusText}`,
      `模型介面回傳 HTTP ${res.status}：${body.slice(0, 500) || res.statusText}`,
      `モデル API が HTTP ${res.status} を返しました: ${body.slice(0, 500) || res.statusText}`,
    ),
  )
}

/* ---------------------------------- OpenAI 兼容 ---------------------------------- */

interface OpenAIToolCallDelta {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

function toOpenAIMessage(msg: Message): Record<string, unknown> {
  switch (msg.role) {
    case 'assistant': {
      const out: Record<string, unknown> = {
        role: 'assistant',
        content: msg.content || null,
      }
      if (msg.toolCalls?.length) {
        out.tool_calls = msg.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
        }))
        // DeepSeek 思考模式：带 tool_calls 的 assistant 消息必须把 reasoning_content
        // 一并回传，否则下一次请求直接 400（"must be passed back to the API"）。
        // 只在确实有 reasoning 时带上，普通模型 / 普通回答不受影响。
        if (msg.reasoning) out.reasoning_content = msg.reasoning
      }
      return out
    }
    case 'tool':
      return { role: 'tool', tool_call_id: msg.toolCallId, content: msg.content }
    case 'user': {
      const attachments = msg.attachments ?? []
      const images = attachments.filter((a) => a.kind === 'image' && a.dataUrl)
      // @ 引用的文件以文本形式告知模型路径
      const refs = attachments
        .filter((a) => a.kind === 'file')
        .map((a) => `[referenced file] ${a.path ?? a.name}`)
      const prefix = msg.inserted
        ? '[Inserted by the user mid-task; take it into account before continuing]\n'
        : ''
      const text = [prefix + msg.content, ...refs].filter(Boolean).join('\n')

      if (images.length === 0) return { role: 'user', content: text }

      return {
        role: 'user',
        content: [
          { type: 'text', text: text || '(see the attached images)' },
          ...images.map((image) => ({ type: 'image_url', image_url: { url: image.dataUrl } })),
        ],
      }
    }
    default:
      return { role: msg.role, content: msg.content }
  }
}

async function openaiStream(opts: ChatOptions): Promise<void> {
  const { target, system, messages, tools, signal, onChunk } = opts
  const base = normalizeBaseURL(target.baseURL)

  const build = (msgs: Message[]): Record<string, unknown> => {
    const payload: Record<string, unknown> = {
      model: target.model,
      messages: [
        // 系统提示词的角色可配：老接口用 system，o 系列 / 新接口用 developer
        ...(system ? [{ role: target.systemRole ?? 'system', content: system }] : []),
        ...msgs.map(toOpenAIMessage),
      ],
      stream: true,
    }
    // 有些网关不认 stream_options，允许关掉
    if (target.streamUsage !== false) {
      payload.stream_options = { include_usage: true }
    }
    if (tools.length) {
      payload.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }))
    }
    applySampling(target, payload)
    // 思考强度：OpenAI 兼容风格用 reasoning_effort（不支持的接口会忽略）
    if (target.reasoningEffort && target.reasoningEffort !== 'off') {
      payload.reasoning_effort = target.reasoningEffort
    }
    // 额外请求体：浅合并，放最后（可以覆盖上面任何字段，兜住各厂商私有参数）
    if (target.extraBody) Object.assign(payload, target.extraBody)
    return payload
  }

  const res = await postJson(
    target,
    `${base}/chat/completions`,
    {
      'Content-Type': 'application/json',
      ...extraHeaders(target),
      ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
    },
    messages,
    build,
    signal,
    (info) => onChunk({ type: 'retry', ...info }),
  )

  const pending = new Map<number, { id: string; name: string; args: string }>()
  /** 输出被长度上限截断（finish_reason = length） */
  let truncated = false
  /** 当前正在累积的槽位；服务不返回 index 时靠它把同一个调用的分片接在一起 */
  let cursor = -1
  const nextSlot = () => (pending.size > 0 ? Math.max(...pending.keys()) + 1 : 0)

  for await (const evt of parseSSE(res)) {
    if (evt.data === '[DONE]') break
    let json: {
      choices?: {
        /** 'length' 表示被 max_tokens 截断 */
        finish_reason?: string | null
        delta?: {
          content?: string | null | ({ type?: string; text?: string } | string)[]
          reasoning_content?: string | null
          reasoning?: string | null
          tool_calls?: OpenAIToolCallDelta[]
        }
      }[]
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        prompt_tokens_details?: { cached_tokens?: number }
        /** DeepSeek 风格的缓存命中 / 未命中 */
        prompt_cache_hit_tokens?: number
        prompt_cache_miss_tokens?: number
      }
      error?: { message?: string }
    }
    try {
      json = JSON.parse(evt.data)
    } catch {
      continue
    }
    if (json.error) throw new Error(json.error.message ?? 'model returned an error')

    if (json.usage) {
      const usage = json.usage
      onChunk({
        type: 'usage',
        usage: {
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          // 缓存命中：OpenAI 用 prompt_tokens_details.cached_tokens，
          // DeepSeek 用 prompt_cache_hit_tokens，兼容两边
          cachedTokens:
            usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens,
          cacheWriteTokens: usage.prompt_cache_miss_tokens,
        },
      })
    }

    if (json.choices?.[0]?.finish_reason === 'length') truncated = true
    const delta = json.choices?.[0]?.delta
    if (!delta) continue

    // content 可能是字符串，也可能是分段数组（有些网关会这么返回）
    if (typeof delta.content === 'string' && delta.content) {
      onChunk({ type: 'text', text: delta.content })
    } else if (Array.isArray(delta.content)) {
      const text = delta.content
        .map((part) => (typeof part === 'string' ? part : (part?.text ?? '')))
        .join('')
      if (text) onChunk({ type: 'text', text })
    }
    const reasoning = delta.reasoning_content ?? delta.reasoning
    if (typeof reasoning === 'string' && reasoning) {
      onChunk({ type: 'reasoning', text: reasoning })
    }

    for (const tc of delta.tool_calls ?? []) {
      if (typeof tc.index === 'number') {
        cursor = tc.index
      } else {
        // 有些兼容服务不带 index，这时只能靠旁证判断是不是新调用：
        //   1. 出现了一个没见过的 id
        //   2. 函数名和当前槽位不同
        //   3. 当前槽位的参数已经是完整的 JSON —— 它又带着新参数，说明这是在开下一个调用
        const current = cursor >= 0 ? pending.get(cursor) : undefined
        const newById = Boolean(tc.id && (!current || (current.id !== '' && current.id !== tc.id)))
        const newByName = Boolean(
          !tc.id && tc.function?.name && current?.name && current.name !== tc.function.name,
        )
        const newByCompleteArgs = Boolean(
          current && tc.function?.arguments && isCompleteJsonText(current.args),
        )
        if (cursor === -1 || newById || newByName || newByCompleteArgs) cursor = nextSlot()
      }
      const cur = pending.get(cursor) ?? { id: '', name: '', args: '' }
      if (tc.id) cur.id = tc.id
      if (tc.function?.name) cur.name = tc.function.name
      if (tc.function?.arguments) cur.args += tc.function.arguments
      pending.set(cursor, cur)
      // 实时把“正在生成的工具参数”报给界面
      onChunk({ type: 'tool_progress', index: cursor, name: cur.name, argsSoFar: cur.args })
    }
  }

  if (pending.size) {
    const calls: ToolCall[] = [...pending.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c]) => ({
        id: c.id || crypto.randomUUID(),
        name: c.name,
        args: parseArgs(c.args),
      }))
      .filter((c) => c.name)
    if (calls.length) onChunk({ type: 'tool_calls', calls })
  }

  if (truncated) onChunk({ type: 'truncated' })
  onChunk({ type: 'done' })
}

/* ----------------------------------- Anthropic ----------------------------------- */

function parseDataUrl(dataUrl: string): { mediaType: string; data: string } | null {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl)
  if (!match) return null
  return { mediaType: match[1], data: match[2] }
}

function toAnthropicMessages(messages: Message[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const msg of messages) {
    if (msg.role === 'system') continue // 由顶层 system 字段承载
    if (msg.role === 'assistant') {
      const blocks: Record<string, unknown>[] = []
      if (msg.content) blocks.push({ type: 'text', text: msg.content })
      for (const call of msg.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args ?? {} })
      }
      if (blocks.length) out.push({ role: 'assistant', content: blocks })
      continue
    }
    if (msg.role === 'tool') {
      out.push({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: msg.toolCallId, content: msg.content || '(无输出)' },
        ],
      })
      continue
    }

    const attachments = msg.attachments ?? []
    const images = attachments.filter((a) => a.kind === 'image' && a.dataUrl)
    const refs = attachments
      .filter((a) => a.kind === 'file')
      .map((a) => `[referenced file] ${a.path ?? a.name}`)
    const prefix = msg.inserted
      ? '[Inserted by the user mid-task; take it into account before continuing]\n'
      : ''
    const text = [prefix + msg.content, ...refs].filter(Boolean).join('\n')

    const blocks: Record<string, unknown>[] = []
    if (text) blocks.push({ type: 'text', text })
    for (const image of images) {
      const parsed = parseDataUrl(image.dataUrl as string)
      if (parsed) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data },
        })
      }
    }
    out.push({ role: 'user', content: blocks.length ? blocks : [{ type: 'text', text: '(empty)' }] })
  }
  return out
}

async function anthropicStream(opts: ChatOptions): Promise<void> {
  const { target, system, messages, tools, signal, onChunk } = opts
  const base = normalizeBaseURL(target.baseURL)

  const build = (msgs: Message[]): Record<string, unknown> => {
    const payload: Record<string, unknown> = {
      model: target.model,
      max_tokens: target.maxTokens && target.maxTokens > 0 ? target.maxTokens : 8192,
      messages: toAnthropicMessages(msgs),
      stream: true,
    }
    applySampling(target, payload)
    // 思考强度：Anthropic 用扩展思考（thinking），预算按档位取，
    // 且 max_tokens 必须大于预算，必要时自动抬高。
    if (target.reasoningEffort && target.reasoningEffort !== 'off') {
      const budget = ANTHROPIC_THINKING_BUDGET[target.reasoningEffort]
      payload.thinking = { type: 'enabled', budget_tokens: budget }
      const current = typeof payload.max_tokens === 'number' ? payload.max_tokens : 8192
      payload.max_tokens = Math.max(current, budget + 2048)
    }
    // 把 system 标成可缓存：配合工具列表末尾的缓存断点，长对话能显著提高命中率
    if (system) {
      payload.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
    }
    if (tools.length) {
      const mapped: Record<string, unknown>[] = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }))
      mapped[mapped.length - 1] = {
        ...mapped[mapped.length - 1],
        cache_control: { type: 'ephemeral' },
      }
      payload.tools = mapped
    }
    return payload
  }

  const res = await postJson(
    target,
    `${base}/messages`,
    {
      'Content-Type': 'application/json',
      ...extraHeaders(target),
      'x-api-key': target.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    messages,
    build,
    signal,
    (info) => onChunk({ type: 'retry', ...info }),
  )

  const calls: ToolCall[] = []
  let current: { id: string; name: string; json: string } | null = null

  for await (const evt of parseSSE(res)) {
    let json: {
      type?: string
      index?: number
      content_block?: { type?: string; id?: string; name?: string }
      delta?: { type?: string; text?: string; partial_json?: string; thinking?: string }
      message?: {
        usage?: {
          input_tokens?: number
          output_tokens?: number
          cache_read_input_tokens?: number
          cache_creation_input_tokens?: number
        }
      }
      usage?: { output_tokens?: number }
      error?: { message?: string }
    }
    try {
      json = JSON.parse(evt.data)
    } catch {
      continue
    }
    if (json.type === 'error') throw new Error(json.error?.message ?? 'Anthropic returned an error')

    if (json.type === 'message_start' && json.message?.usage) {
      const usage = json.message.usage
      onChunk({
        type: 'usage',
        usage: {
          promptTokens: usage.input_tokens,
          cachedTokens: usage.cache_read_input_tokens,
          cacheWriteTokens: usage.cache_creation_input_tokens,
        },
      })
    } else if (json.type === 'message_delta' && json.usage) {
      onChunk({ type: 'usage', usage: { completionTokens: json.usage.output_tokens } })
    }

    if (json.type === 'content_block_start' && json.content_block?.type === 'tool_use') {
      current = { id: json.content_block.id ?? '', name: json.content_block.name ?? '', json: '' }
    } else if (json.type === 'content_block_delta') {
      const d = json.delta
      if (d?.type === 'text_delta' && d.text) onChunk({ type: 'text', text: d.text })
      else if (d?.type === 'thinking_delta' && d.thinking)
        onChunk({ type: 'reasoning', text: d.thinking })
      else if (d?.type === 'input_json_delta' && current && d.partial_json) {
        current.json += d.partial_json
        onChunk({
          type: 'tool_progress',
          index: calls.length,
          name: current.name,
          argsSoFar: current.json,
        })
      }
    } else if (json.type === 'content_block_stop' && current) {
      calls.push({
        id: current.id || crypto.randomUUID(),
        name: current.name,
        args: parseArgs(current.json),
      })
      current = null
    }
  }

  if (calls.length) onChunk({ type: 'tool_calls', calls })
  onChunk({ type: 'done' })
}

/* ------------------------------------ 工具函数 ------------------------------------ */

/** 非流式的单次补全，用于摘要/压缩等内部调用 */
export async function complete(
  target: LlmTarget,
  system: string,
  messages: Message[],
  signal?: AbortSignal,
): Promise<string> {
  let out = ''
  await chatStream({
    target,
    system,
    messages,
    tools: [],
    signal,
    onChunk: (chunk) => {
      if (chunk.type === 'text') out += chunk.text
    },
  })
  return out.trim()
}

function parseArgs(raw: string): Record<string, unknown> {
  const text = raw.trim()
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return { __raw: text }
  }
}

/**
 * 文本是否已经是一个完整的 JSON 值。
 * 用来判断「不带 index 的流」里，上一个工具调用的参数是不是已经写完了。
 */
function isCompleteJsonText(text: string): boolean {
  if (!text.trim()) return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}
