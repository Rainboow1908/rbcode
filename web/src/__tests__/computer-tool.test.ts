import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Backend, ComputerAction, ComputerScreen } from '../lib/executor/types.ts'
import { defaultSettings } from '../lib/settings.ts'
import { computerTool, resetComputerTool } from '../lib/tools/computer.ts'
import type { ToolContext } from '../lib/tools/types.ts'

/** 假装屏幕是 2560×1440，截图被缩到 1280×720（缩放正好 2 倍） */
const shot = (): ComputerScreen => ({
  width: 1280,
  height: 720,
  screenWidth: 2560,
  screenHeight: 1440,
  originX: 0,
  originY: 0,
  base64: 'AAAA',
})

function makeCtx(options: { approve?: boolean; actions?: unknown } = {}): ToolContext {
  const actions = vi.fn(async (params: { actions: ComputerAction[] }) => {
    options.actions = params.actions
    return { applied: params.actions.length }
  })
  const backend = {
    computerScreen: vi.fn(async () => shot()),
    computerActions: actions,
  } as unknown as Backend

  return {
    backend,
    sessionId: 'session-a',
    getTodos: () => [],
    setTodos: () => {},
    askUser: async () => '(skipped)',
    recordUndo: async () => 'undo',
    getSettings: () => defaultSettings(),
    requestApproval: async () => options.approve !== false,
  }
}

const sentActions = (ctx: ToolContext): ComputerAction[] =>
  (ctx.backend.computerActions as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].actions

describe('computer_use 工具', () => {
  beforeEach(() => resetComputerTool())

  it('没连本机执行器时直接拒绝', async () => {
    const result = await computerTool.run(
      { actions: [{ action: 'screenshot' }] },
      { ...makeCtx(), backend: {} as Backend },
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('本机执行器')
  })

  it('设置里关掉后直接拒绝', async () => {
    const ctx = makeCtx()
    ctx.getSettings = () => ({ ...defaultSettings(), computerEnabled: false })
    const result = await computerTool.run({ actions: [{ action: 'screenshot' }] }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('关闭')
  })

  it('第一次用会征求授权；拒绝就不执行', async () => {
    const ctx = makeCtx({ approve: false })
    const result = await computerTool.run({ actions: [{ action: 'screenshot' }] }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('没有授权')
    expect(ctx.backend.computerScreen).not.toHaveBeenCalled()
  })

  it('screenshot 只抓屏，不发给 companion 的 actions', async () => {
    const ctx = makeCtx()
    const result = await computerTool.run({ actions: [{ action: 'screenshot' }] }, ctx)
    expect(result.isError).toBeUndefined()
    expect(ctx.backend.computerActions).not.toHaveBeenCalled()
    expect(result.images?.[0].dataUrl).toBe('data:image/png;base64,AAAA')
    expect(result.content).toContain('1280×720')
    expect(result.content).toContain('坐标请按这张截图')
  })

  it('坐标换算成屏幕绝对坐标（截图 1280 宽 / 屏幕 2560 宽 → 2 倍）', async () => {
    const ctx = makeCtx()
    // 先拿一次几何信息
    await computerTool.run({ actions: [{ action: 'screenshot' }] }, ctx)
    // 再点截图坐标 (100, 50)
    const result = await computerTool.run(
      { actions: [{ action: 'left_click', coordinate: [100, 50] }] },
      ctx,
    )
    expect(result.isError).toBeUndefined()
    expect(sentActions(ctx)).toEqual([{ action: 'left_click', coordinate: [200, 100] }])
  })

  it('坐标原点偏移（多屏）也会带上', async () => {
    const ctx = makeCtx()
    ;(ctx.backend.computerScreen as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...shot(),
      originX: -1920,
      originY: 0,
    })
    await computerTool.run({ actions: [{ action: 'screenshot' }] }, ctx)
    await computerTool.run({ actions: [{ action: 'mouse_move', coordinate: [0, 0] }] }, ctx)
    expect(sentActions(ctx)).toEqual([{ action: 'mouse_move', coordinate: [-1920, 0] }])
  })

  it('还没截过图就给坐标 → 提示先截图', async () => {
    const ctx = makeCtx()
    const result = await computerTool.run(
      { actions: [{ action: 'left_click', coordinate: [1, 1] }] },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('先单独调用一次 computer_use')
  })

  it('不认识的动作会被拒', async () => {
    const ctx = makeCtx()
    const result = await computerTool.run({ actions: [{ action: 'rm -rf /' }] }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('不支持的动作')
  })

  it('type / key / wait 不需要坐标，原样传下去', async () => {
    const ctx = makeCtx()
    await computerTool.run(
      {
        actions: [
          { action: 'type', text: '你好' },
          { action: 'key', text: 'ctrl+s' },
          { action: 'wait', duration: 200 },
        ],
      },
      ctx,
    )
    expect(sentActions(ctx)).toEqual([
      { action: 'type', text: '你好' },
      { action: 'key', text: 'ctrl+s' },
      { action: 'wait', duration: 200 },
    ])
  })
})
