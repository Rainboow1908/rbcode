/**
 * `.rbcode` 保护：这是应用自己的数据目录（会话、撤销快照、回收站、MCP 缓存），
 * 模型既不该看到它，也不该读写它。
 *
 * 判定严格按**路径整段**来 —— 只有某一段恰好等于 `.rbcode` 才算命中：
 *   命中：`.rbcode/sessions/a.json`、`src/../.rbcode/x`、`D:\p\.rbcode\x`、`.RBCODE`
 *   不命中：`rbcode/`（项目根目录本身可能就叫这个）、`.rbcodex`、`foo.rbcode`、`.mcp_output`
 */

const SEGMENT = '.rbcode'

/** 去掉 file:// 前缀，统一成 `/` 分隔（后面所有判断都基于这一份） */
function normalize(raw: string): string {
  return raw.replace(/^file:\/{2,}/i, '').replace(/\\/g, '/')
}

/** 路径里是否存在 `.rbcode` 这一段 */
export function hitsRbcodePath(raw: string | undefined | null): boolean {
  if (!raw) return false
  return normalize(raw)
    .split('/')
    .some((segment) => segment.toLowerCase() === SEGMENT)
}

/**
 * 命令行里是否碰了 `.rbcode`：先按「路径里不可能出现的字符」切成 token，再逐 token 看路径段。
 * 这样 `cat .rbcode/x`、`cd ..\.rbcode`、`D:\p\.rbcode\x` 都能抓到，
 * 而 `cd rbcode`（项目根就叫 rbcode）、`foo.rbcode`、`.rbcodex` 不会被误伤。
 *
 * 说明：这是尽力而为的字符串检查 —— 变量拼接、编码、脚本里动态拼路径都能绕过。
 */
export function hitsRbcodeCommand(command: string | undefined | null): boolean {
  if (!command) return false
  return normalize(command)
    .split(/[^\w.:/+-]+/)
    .some((token) => hitsRbcodePath(token))
}

/** 统一的拒绝信息：说清是什么目录、别再试了 */
export function rbcodeRefusal(target: string): string {
  const shown = target.trim() || '.rbcode'
  return (
    `Access denied: ${shown} is inside .rbcode — this workspace's application data directory ` +
    '(chat sessions, undo snapshots, recycle bin, MCP caches). It is not part of the project and no tool ' +
    'can read or change it. Work with the real project files instead; if the user asks about .rbcode, ' +
    'tell them it is app data and you cannot open it.'
  )
}
