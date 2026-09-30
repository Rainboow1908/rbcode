import type { ComputerAction } from '../executor/types.ts'
import { t } from '../i18n.ts'
import { failure, type ToolContext, type ToolDef } from './types.ts'

/**
 * computer use：让模型看屏幕、动键鼠（和 Anthropic / OpenAI 那套命名一致）。
 *
 * 两个要点：
 *  1. **只有本机执行器**能做到（浏览器碰不到你的桌面）；没连 companion 时直接报错。
 *  2. **坐标按「上一张截图的像素」给**，这里换算成屏幕绝对坐标再发给 companion ——
 *     和主流做法一致（`display_width_px` 那套），缩放后也能点准。
 */

/** 模型可以用的动作 */
const ALLOWED = new Set([
  'screenshot',
  'mouse_move',
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'left_click_drag',
  'scroll',
  'type',
  'key',
  'wait',
])

/** 需要坐标的动作 */
const NEEDS_POINT = new Set([
  'mouse_move',
  'left_click',
  'left_click_drag',
  'right_click',
  'middle_click',
  'double_click',
  'scroll',
])

/** 最近一张截图的几何信息：截图坐标 → 屏幕绝对坐标 */
let geometry: {
  width: number
  height: number
  screenWidth: number
  screenHeight: number
  originX: number
  originY: number
} | null = null

/**
 * 按会话授权一次。key 里带上「本次页面加载」的随机值，
 * 所以切会话、刷新页面、重启后都会重新询问。
 */
const bootId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
const approvedSessions = new Set<string>()

/** 测试用：清掉记忆的几何信息与授权 */
export function resetComputerTool(): void {
  geometry = null
  approvedSessions.clear()
}

function remember(shot: {
  width: number
  height: number
  screenWidth: number
  screenHeight: number
  originX: number
  originY: number
}): void {
  geometry = {
    width: shot.width,
    height: shot.height,
    screenWidth: shot.screenWidth,
    screenHeight: shot.screenHeight,
    originX: shot.originX,
    originY: shot.originY,
  }
}

/** 截图坐标 → 屏幕绝对坐标 */
function toScreenPoint(point: unknown): [number, number] | null {
  if (!Array.isArray(point) || point.length < 2 || !geometry) return null
  const x = Number(point[0])
  const y = Number(point[1])
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null

  const scaleX = geometry.screenWidth / Math.max(1, geometry.width)
  const scaleY = geometry.screenHeight / Math.max(1, geometry.height)
  return [
    Math.round(geometry.originX + x * scaleX),
    Math.round(geometry.originY + y * scaleY),
  ]
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const computerTool: ToolDef = {
  // 会真的操作电脑，绝不算只读
  readOnly: false,
  schema: {
    name: 'computer_use',
    description:
      'Control the user’s computer: take a screenshot, move the mouse, click, drag, scroll, type text and press keys. Requires the local executor, and the user is asked once per session. Coordinates are in the pixels of the most recent screenshot (its size is reported in every result), not in screen pixels. Actions run in order and stop at the first failure; a fresh screenshot is returned afterwards.',
    parameters: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          description:
            'Ordered actions. Coordinates refer to the last screenshot. Supported: screenshot, mouse_move, left_click, right_click, middle_click, double_click, left_click_drag, scroll, type, key, wait.',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string' },
              coordinate: {
                type: 'array',
                items: { type: 'number' },
                description: '[x, y] in the last screenshot',
              },
              start_coordinate: {
                type: 'array',
                items: { type: 'number' },
                description: 'Drag start [x, y] in the last screenshot',
              },
              text: { type: 'string', description: 'Text to type, or a key combo like "ctrl+c"' },
              direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
              amount: { type: 'number', description: 'Scroll notches (default 3)' },
              duration: { type: 'number', description: 'Milliseconds, for wait (default 500)' },
            },
            required: ['action'],
          },
        },
      },
      required: ['actions'],
    },
  },
  async run(args, ctx: ToolContext) {
    if (!ctx.backend.computerScreen || !ctx.backend.computerActions) {
      return failure(
        t(
          'computer use 需要连接本机执行器（要抓你的屏幕、动你的键鼠）。',
          'Computer use needs the local executor — it has to capture your screen and drive your keyboard and mouse.',
          'computer use 需要連接本機執行器（要抓你的螢幕、動你的鍵盤滑鼠）。',
        ),
      )
    }

    const settings = ctx.getSettings?.()
    if (settings && settings.computerEnabled === false) {
      return failure(
        t(
          'computer use 已在设置里关闭（设置 → 高级 → computer use）。',
          'Computer use is turned off in Settings (Settings → Advanced → computer use).',
          'computer use 已在設定裡關閉（設定 → 進階 → computer use）。',
        ),
      )
    }

    const raw = Array.isArray(args.actions) ? args.actions : []
    if (raw.length === 0) {
      return failure(t('actions 不能为空，先给一个 screenshot。', 'actions must not be empty — start with a screenshot.', 'actions 不能為空，先給一個 screenshot。'))
    }
    if (raw.length > 50) {
      return failure(t('一次最多 50 个动作。', 'At most 50 actions per call.', '一次最多 50 個動作。'))
    }

    // 按会话授权一次（「完全」权限档不打扰）
    const sessionKey = `${bootId}:${ctx.sessionId ?? 'default'}`
    if (settings?.permission !== 'full' && !approvedSessions.has(sessionKey)) {
      const summary = t(
        '允许 computer use：抓屏 + 移动/点击鼠标 + 键入',
        'Allow computer use: screenshots + mouse and keyboard control',
        '允許 computer use：抓屏 + 移動/點擊滑鼠 + 鍵入',
      )
      const detail = t(
        `本次要执行 ${raw.length} 个动作：${raw
          .map((item) => String((item as { action?: unknown })?.action ?? '?'))
          .join(', ')}\n\n通过后本次会话内不再逐个询问；切会话或刷新页面后会重新问。`,
        `This call runs ${raw.length} action(s): ${raw
          .map((item) => String((item as { action?: unknown })?.action ?? '?'))
          .join(', ')}\n\nOnce approved, later calls in this session won't ask again; a new session or a page reload asks again.`,
        `本次要執行 ${raw.length} 個動作：${raw
          .map((item) => String((item as { action?: unknown })?.action ?? '?'))
          .join(', ')}\n\n通過後本次工作階段內不再逐個詢問；切換工作階段或重新整理頁面後會重新問。`,
      )
      const ok = ctx.requestApproval
        ? await ctx.requestApproval({ tool: 'computer', summary, detail, dangerous: true })
        : false
      if (!ok) {
        return failure(
          t('用户没有授权这次 computer use。', 'The user did not approve computer use.', '使用者沒有授權這次 computer use。'),
        )
      }
      approvedSessions.add(sessionKey)
    }

    // 校验 + 换算坐标
    // 需要坐标但还没截过图 → 先提示（要在换算之前判断，否则报的是「坐标不对」）
    const wantsPoint = raw.some((item) =>
      NEEDS_POINT.has(String((item as { action?: unknown })?.action ?? '')),
    )
    if (wantsPoint && !geometry) {
      return failure(
        t(
          '还没有屏幕尺寸：先单独调用一次 computer_use（actions: [{ action: "screenshot" }]），再按截图里的像素给坐标。',
          'No screen size yet: call computer_use once with actions: [{ action: "screenshot" }] first, then pass coordinates in screenshot pixels.',
          '還沒有螢幕尺寸：先單獨呼叫一次 computer_use（actions: [{ action: "screenshot" }]），再按截圖裡的像素給座標。',
        ),
      )
    }

    const actions: ComputerAction[] = []
    let needsPoint = false
    const described: string[] = []

    for (const item of raw) {
      const source = (item ?? {}) as Record<string, unknown>
      const name = String(source.action ?? '')
      if (!ALLOWED.has(name)) {
        return failure(t(`不支持的动作：${name}`, `Unsupported action: ${name}`, `不支援的動作：${name}`))
      }
      // screenshot 交给「跑完自动再抓一张」处理，不发给 companion（它没有这个动作）
      if (name === 'screenshot') {
        described.push('screenshot')
        continue
      }
      needsPoint = needsPoint || NEEDS_POINT.has(name)

      const action: ComputerAction = { action: name }
      if (NEEDS_POINT.has(name)) {
        const point = toScreenPoint(source.coordinate)
        if (!point) return failure(t('坐标不对：要先有一次 screenshot，坐标按截图里的像素给 [x, y]。', 'Bad coordinate: take a screenshot first and pass [x, y] in screenshot pixels.', '座標不對：要先有一次 screenshot，座標按截圖裡的像素給 [x, y]。'))
        action.coordinate = point
      }
      if (name === 'left_click_drag') {
        const start = toScreenPoint(source.start_coordinate)
        if (!start) return failure(t('拖拽要同时给 start_coordinate。', 'Drag needs start_coordinate too.', '拖曳要同時給 start_coordinate。'))
        action.start_coordinate = start
      }
      if (source.text !== undefined) action.text = String(source.text)
      if (source.direction !== undefined) {
        action.direction = String(source.direction) as ComputerAction['direction']
      }
      if (source.amount !== undefined) action.amount = numberOr(source.amount, 3)
      if (source.duration !== undefined) action.duration = numberOr(source.duration, 500)
      actions.push(action)
      described.push(name)
    }

    try {
      let applied = 0
      if (actions.length > 0) {
        const result = await ctx.backend.computerActions({ actions })
        applied = result.applied
      }

      // 跑完再抓一张，让模型看到效果（主流也是这么循环的）
      const shot = await ctx.backend.computerScreen({
        maxWidth: settings?.computerMaxWidth ?? 1280,
      })
      remember(shot)

      const header = t(
        `已执行 ${applied} 个动作（${described.join(' → ')}）`,
        `Ran ${applied} action(s) (${described.join(' → ')})`,
        `已執行 ${applied} 個動作（${described.join(' → ')}）`,
      )
      const meta = t(
        `截图 ${shot.width}×${shot.height}（屏幕 ${shot.screenWidth}×${shot.screenHeight}）——坐标请按这张截图的像素给。`,
        `Screenshot ${shot.width}×${shot.height} (screen ${shot.screenWidth}×${shot.screenHeight}) — give coordinates in this screenshot's pixels.`,
        `截圖 ${shot.width}×${shot.height}（螢幕 ${shot.screenWidth}×${shot.screenHeight}）——座標請按這張截圖的像素給。`,
      )

      return {
        content: `${header}\n${meta}`,
        images: [{ name: 'screen.png', dataUrl: `data:image/png;base64,${shot.base64}` }],
      }
    } catch (err) {
      return failure(
        t(
          `computer use 失败：${(err as Error).message}`,
          `Computer use failed: ${(err as Error).message}`,
          `computer use 失敗：${(err as Error).message}`,
        ),
      )
    }
  },
}
