import { describe, expect, it, vi } from 'vitest'
import type { Backend } from '../lib/executor/types.ts'
import {
  convertTranscript,
  findImportCandidates,
  importCandidate,
  projectSlug,
  readRawMessages,
} from '../lib/importSessions.ts'

/** 一个内存里的假文件系统后端 */
function fsBackend(files: Record<string, string>): Backend {
  const map = { ...files }
  return {
    kind: 'companion',
    label: '本机执行器',
    capabilities: {},
    exists: vi.fn(async (path: string) => path in map),
    mkdir: vi.fn(async () => {}),
    writeFile: vi.fn(async (path: string, content: string) => {
      map[path] = content
    }),
    readFile: vi.fn(async (path: string) => {
      if (!(path in map)) throw new Error(`no file: ${path}`)
      return map[path]
    }),
    remove: vi.fn(async () => {}),
    readFileBase64: vi.fn(async () => ({ base64: 'AAAA', size: 3 })),
    writeFileBase64: vi.fn(async () => ({ bytes: 3 })),
    list: vi.fn(async (dir: string) => {
      const prefix = `${dir.replace(/[\\/]+$/, '')}\\`
      const seen = new Set<string>()
      const entries: { path: string; name: string; kind: 'file' | 'dir'; size: number }[] = []
      for (const path of Object.keys(map)) {
        if (!path.startsWith(prefix)) continue
        const rest = path.slice(prefix.length)
        const [head, ...tail] = rest.split('\\')
        if (!head || seen.has(head)) continue
        seen.add(head)
        const isDir = tail.length > 0
        entries.push({
          path: isDir ? `${prefix}${head}` : path,
          name: head,
          kind: isDir ? 'dir' : 'file',
          size: isDir ? 0 : (map[path]?.length ?? 0),
        })
      }
      return entries
    }),
    __files: map,
  } as unknown as Backend
}

describe('项目路径 → 目录名', () => {
  it('每个非字母数字字符都变成分隔符并小写', () => {
    expect(projectSlug('D:\\36629\\Desktop\\Reasonix\\blog')).toBe(
      'd--36629-desktop-reasonix-blog',
    )
  })
})

describe('消息转换', () => {
  it('丢掉 system，带上思考，工具调用按内置表映射', () => {
    const { messages, unknownTools } = convertTranscript([
      { role: 'system', content: '外部系统提示' },
      {
        role: 'assistant',
        content: '我先看看',
        reasoning_content: 'We need to look',
        tool_calls: [
          { id: 'c1', function: { name: 'run_command', arguments: '{"command":"ls"}' } },
        ],
      },
      { role: 'tool', content: '文件列表' },
    ])

    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('assistant')
    expect(messages[0].reasoning).toBe('We need to look')
    expect(messages[0].toolCalls?.[0]).toEqual({ id: 'c1', name: 'bash', args: { command: 'ls' } })
    // 结果按位置配对：拿到同一个 id 和工具名
    expect(messages[1].role).toBe('tool')
    expect(messages[1].toolCallId).toBe('c1')
    expect(messages[1].toolName).toBe('bash')
    expect(messages[1].content).toBe('文件列表')
    expect(unknownTools).toEqual([])
    // 时间递增，顺序稳定
    expect(messages[1].createdAt).toBeGreaterThan(messages[0].createdAt)
  })

  it('认不出的工具：原名保留 + 结果加一行标记', () => {
    const { messages, unknownTools } = convertTranscript([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'x', function: { name: 'remember', arguments: '{}' } }],
      },
      { role: 'tool', content: '记住啦' },
    ])

    expect(messages[0].toolCalls?.[0].name).toBe('remember')
    expect(messages[1].toolName).toBe('remember')
    expect(messages[1].content).toBe('[未识别的工具：remember]\n记住啦')
    expect(unknownTools).toEqual(['remember'])
  })

  it('消息里提到的附件会被挂到那条消息上', () => {
    const { messages, pendingImages } = convertTranscript(
      [{ role: 'user', content: '看这张 clipboard-1.png 对不对' }],
      { attachmentNames: new Set(['clipboard-1.png']) },
    )
    expect(messages[0].attachments?.[0].name).toBe('clipboard-1.png')
    expect(pendingImages).toHaveLength(1)
  })
})

describe('读原始消息：两代格式', () => {
  it('新式：优先从事件日志的 replace 里取完整消息', async () => {
    const backend = fsBackend({
      'C:\\r\\s\\a.events.jsonl': [
        JSON.stringify({ type: 'replace', messages: [{ role: 'user', content: '第一句' }] }),
        JSON.stringify({ type: 'append', message: { role: 'assistant', content: '后加的' } }),
      ].join('\n'),
      'C:\\r\\s\\a.jsonl': JSON.stringify({ role: 'user', content: '派生缓存' }),
    })
    const raw = await readRawMessages(backend, {
      key: 'C:\\r\\s\\a.jsonl',
      kind: 'project',
      file: 'C:\\r\\s\\a.jsonl',
      eventsFile: 'C:\\r\\s\\a.events.jsonl',
      title: 'a',
      updatedAt: 0,
    })
    expect(raw).toHaveLength(1)
    expect((raw[0] as { content: string }).content).toBe('第一句')
  })

  it('老式：一行一条消息', async () => {
    const backend = fsBackend({
      'C:\\r\\s\\b.jsonl': [
        JSON.stringify({ role: 'user', content: '问题' }),
        JSON.stringify({ role: 'assistant', content: '回答' }),
      ].join('\n'),
    })
    const raw = await readRawMessages(backend, {
      key: 'C:\\r\\s\\b.jsonl',
      kind: 'legacy',
      file: 'C:\\r\\s\\b.jsonl',
      title: 'b',
      updatedAt: 0,
    })
    expect(raw).toHaveLength(2)
  })
})

describe('扫描候选', () => {
  const paths = { home: 'C:\\Users\\me', appData: 'C:\\Users\\me\\AppData\\Roaming' }
  const project = 'D:\\work\\proj'
  const slug = projectSlug(project)

  const files = {
    [`C:\\Users\\me\\AppData\\Roaming\\reasonix\\projects\\${slug}\\sessions\\20260101-1-deepseek.jsonl`]:
      JSON.stringify({ role: 'user', content: '项目内的问题' }),
    [`C:\\Users\\me\\AppData\\Roaming\\reasonix\\projects\\${slug}\\sessions\\20260101-1-deepseek.jsonl.meta`]:
      JSON.stringify({ topic_title: '项目会话标题', updated_at: '2026-01-01T00:00:00Z' }),
    'C:\\Users\\me\\AppData\\Roaming\\reasonix\\sessions\\global-1.jsonl': JSON.stringify({
      role: 'user',
      content: '全局会话',
    }),
    'C:\\Users\\me\\.reasonix\\sessions\\old-1.jsonl': JSON.stringify({ role: 'user', content: '老会话' }),
    'C:\\Users\\me\\.reasonix\\sessions\\old-1.meta.json': JSON.stringify({ workspace: project }),
  }

  it('默认只列出这个项目的（老会话按 meta 里的 workspace 归属）', async () => {
    const found = await findImportCandidates(fsBackend(files), paths, project, 'project')
    const titles = found.map((item) => item.title)
    expect(titles).toContain('项目会话标题')
    expect(titles).toContain('old-1')
    expect(titles.some((title) => title.includes('global-1'))).toBe(false)
  })

  it('放宽后连全局会话一起列出', async () => {
    const found = await findImportCandidates(fsBackend(files), paths, project, 'all')
    expect(found.some((item) => item.kind === 'global')).toBe(true)
  })
})

describe('导入一个会话', () => {
  it('写进 .rbcode/sessions，并带上未识别工具的标记', async () => {
    const backend = fsBackend({
      'C:\\r\\s\\a.jsonl': [
        JSON.stringify({ role: 'user', content: '帮我看下' }),
        JSON.stringify({
          role: 'assistant',
          content: '好',
          tool_calls: [{ id: 'c1', function: { name: 'remember', arguments: '{}' } }],
        }),
        JSON.stringify({ role: 'tool', content: '记住了' }),
      ].join('\n'),
    })

    const id = await importCandidate(backend, 'D:\\work\\proj', {
      key: 'C:\\r\\s\\a.jsonl',
      kind: 'project',
      file: 'C:\\r\\s\\a.jsonl',
      title: '某个会话',
      updatedAt: 1_700_000_000_000,
    })

    expect(id.startsWith('imp-')).toBe(true)
    const written = JSON.parse(
      await (backend as unknown as { readFile(path: string): Promise<string> }).readFile(
        `.rbcode/sessions/${id}.json`,
      ),
    ) as { title: string; messages: { role: string; content: string }[] }
    expect(written.title).toContain('某个会话')
    expect(written.messages).toHaveLength(3)
    expect(written.messages[2].content).toContain('[未识别的工具：remember]')
  })
})
