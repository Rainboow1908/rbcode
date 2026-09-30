export interface SSEEvent {
  event?: string
  data: string
}

/**
 * 解析 text/event-stream 响应流，逐条产出事件。
 * 兼容 \n\n 与 \r\n\r\n 分隔，以及多行 data: 的拼接。
 */
export async function* parseSSE(response: Response): AsyncGenerator<SSEEvent> {
  const body = response.body
  if (!body) return

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let boundary = findBoundary(buffer)
      while (boundary) {
        const block = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary.length)
        const evt = parseBlock(block)
        if (evt) yield evt
        boundary = findBoundary(buffer)
      }
    }

    buffer += decoder.decode()
    const tail = buffer.trim()
    if (tail) {
      const evt = parseBlock(tail)
      if (evt) yield evt
    }
  } finally {
    reader.releaseLock()
  }
}

function findBoundary(text: string): { index: number; length: number } | null {
  const lf = text.indexOf('\n\n')
  const crlf = text.indexOf('\r\n\r\n')
  if (lf === -1 && crlf === -1) return null
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) return { index: crlf, length: 4 }
  return { index: lf, length: 2 }
}

function parseBlock(block: string): SSEEvent | null {
  const lines = block.split(/\r?\n/)
  let event: string | undefined
  const dataLines: string[] = []

  for (const line of lines) {
    if (line.startsWith(':')) continue
    if (line.startsWith('event:')) {
      event = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''))
    }
  }

  if (dataLines.length === 0) return null
  return { event, data: dataLines.join('\n') }
}
