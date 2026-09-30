import { afterEach, describe, expect, it, vi } from 'vitest'
import { chatStream } from '../lib/llm.ts'
import type { StreamChunk } from '../lib/llm.ts'
import type { Message } from '../lib/types.ts'

/* ------------------------------ SSE 响应构造 ------------------------------ */

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

const data = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`

const target = {
  baseURL: 'https://example.test/v1',
  apiKey: 'k',
  apiStyle: 'openai' as const,
  model: 'm',
}

async function collect(chunks: string[]): Promise<StreamChunk[]> {
  const events: StreamChunk[] = []
  vi.stubGlobal('fetch', vi.fn(async () => sseResponse(chunks)))
  await chatStream({
    target,
    system: '',
    messages: [{ id: 'u1', role: 'user', content: 'hi', createdAt: 0 }],
    tools: [],
    onChunk: (chunk) => events.push(chunk),
  })
  return events
}

function toolCallsOf(events: StreamChunk[]) {
  const event = events.find((item) => item.type === 'tool_calls')
  return event && event.type === 'tool_calls' ? event.calls : null
}

const delta = (toolCalls: unknown[]) => data({ choices: [{ delta: { tool_calls: toolCalls } }] })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OpenAI 流式工具调用解析', () => {
  it('带 index 时按 index 归并分片', async () => {
    const events = await collect([
      delta([{ index: 0, id: 'call_a', type: 'function', function: { name: 'write_file', arguments: '{"path":"a' } }]),
      delta([{ index: 0, function: { arguments: '.txt"}' } }]),
      delta([{ index: 1, id: 'call_b', type: 'function', function: { name: 'list_dir', arguments: '{}' } }]),
      'data: [DONE]\n\n',
    ])

    expect(toolCallsOf(events)).toEqual([
      { id: 'call_a', name: 'write_file', args: { path: 'a.txt' } },
      { id: 'call_b', name: 'list_dir', args: {} },
    ])
  })

  it('不带 index 时不会把两个调用合并成一个', async () => {
    const events = await collect([
      delta([{ id: 'call_a', type: 'function', function: { name: 'write_file', arguments: '{"path":"one' } }]),
      delta([{ function: { arguments: '.txt","content":"ONE"}' } }]),
      delta([{ id: 'call_b', type: 'function', function: { name: 'write_file', arguments: '{"path":"two' } }]),
      delta([{ function: { arguments: '.txt","content":"TWO"}' } }]),
      'data: [DONE]\n\n',
    ])

    expect(toolCallsOf(events)).toEqual([
      { id: 'call_a', name: 'write_file', args: { path: 'one.txt', content: 'ONE' } },
      { id: 'call_b', name: 'write_file', args: { path: 'two.txt', content: 'TWO' } },
    ])
  })

  it('不带 index、每帧都重复同一个 id 时仍然只算一个调用', async () => {
    const events = await collect([
      delta([{ id: 'call_a', type: 'function', function: { name: 'write_file', arguments: '{"path":"a' } }]),
      delta([{ id: 'call_a', type: 'function', function: { name: 'write_file', arguments: '.txt"}' } }]),
      'data: [DONE]\n\n',
    ])

    expect(toolCallsOf(events)).toEqual([
      { id: 'call_a', name: 'write_file', args: { path: 'a.txt' } },
    ])
  })

  it('不带 index / id 时，靠「上一个参数已完整」也能区分同名工具的两个调用', async () => {
    const events = await collect([
      delta([{ function: { name: 'write_file', arguments: '{"path":"one.txt","content":"ONE"}' } }]),
      delta([{ function: { name: 'write_file', arguments: '{"path":"two.txt","content":"TWO"}' } }]),
      'data: [DONE]\n\n',
    ])

    const calls = toolCallsOf(events)
    expect(calls?.length).toBe(2)
    expect(calls?.[0].name).toBe('write_file')
    expect(calls?.[0].args).toEqual({ path: 'one.txt', content: 'ONE' })
    expect(calls?.[1].args).toEqual({ path: 'two.txt', content: 'TWO' })
  })

  it('流式期间的 tool_progress 只报当前调用在生成参数', async () => {
    const events = await collect([
      delta([{ id: 'call_a', type: 'function', function: { name: 'bash', arguments: '{"comm' } }]),
      delta([{ function: { arguments: 'and":"ls"}' } }]),
      delta([{ id: 'call_b', type: 'function', function: { name: 'glob', arguments: '{"pat' } }]),
      'data: [DONE]\n\n',
    ])

    const progress = events.filter((item) => item.type === 'tool_progress')
    expect(progress.map((item) => (item.type === 'tool_progress' ? item.index : -1))).toEqual([0, 0, 1])
  })

  it('模型拒绝图片时自动去掉图片重试一次（不会把整轮对话打崩）', async () => {
    const imageMessage: Message = {
      id: 'u1',
      role: 'user',
      content: 'hi',
      createdAt: 0,
      attachments: [
        { id: 'a1', kind: 'image', name: 'screen.png', dataUrl: 'data:image/png;base64,AAAA' },
      ],
    }
    const bodies: string[] = []
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(String(init.body))
      if (bodies.length === 1) {
        return new Response(JSON.stringify({ error: { message: 'You have uploaded an unsupported image.' } }), {
          status: 400,
        })
      }
      return sseResponse([data({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n'])
    })
    vi.stubGlobal('fetch', fetchMock)

    const events: StreamChunk[] = []
    await chatStream({
      target: { ...target, model: 'image-model' },
      system: '',
      messages: [imageMessage],
      tools: [],
      onChunk: (chunk) => events.push(chunk),
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(bodies[0]).toContain('image_url')
    expect(bodies[1]).not.toContain('image_url')
    expect(events.some((event) => event.type === 'text' && event.text === 'ok')).toBe(true)
  })
})
