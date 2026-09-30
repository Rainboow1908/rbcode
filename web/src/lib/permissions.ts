import { t } from './i18n.ts'
import type { PermissionMode } from './types.ts'

/**
 * 危险操作特征：删除类命令。
 *
 * 这是**文本启发式**，用于 auto 档位下决定要不要先问用户、以及要不要留撤销快照。
 * 启发式不可能穷尽（例如 RB Code 自己写个脚本再执行），所以系统提示词里仍然要求优先用 delete_path。
 */
const DESTRUCTIVE_COMMAND = new RegExp(
  [
    // rm / rmdir / del / erase / unlink / rd / rimraf
    String.raw`\b(rm|rmdir|del|erase|unlink|rd|rimraf)\s`,
    String.raw`remove-item`,
    // [System.IO.File]::Delete / [IO.Directory]::Delete()
    String.raw`\[(system\.)?io\.(file|directory)\]::delete`,
    // Get-ChildItem ... | Remove-Item
    String.raw`(get-childitem|gci|get-item|dir)\b[^|;&]*\|\s*(remove-item|del|ri)\b`,
    // 各种语言里的删除调用
    String.raw`\.unlink(sync)?\s*\(`,
    String.raw`\.(deletefile|delete)(sync)?\s*\(`,
    String.raw`\b(rmtree|removeall)\s*\(`,
    String.raw`shutil\.rmtree`,
    String.raw`os\.(remove|unlink)\s*\(`,
    String.raw`fs\.(rm|rmdir|unlink)(sync)?\s*\(`,
    // find . -delete
    String.raw`-delete\b`,
  ].join('|'),
  'i',
)

/**
 * 当前权限档位下，这次操作是否需要先请求用户批准。
 * @param mode 权限档位
 * @param dangerous 是否属于危险操作（删除）
 */
export function needsApproval(mode: PermissionMode, dangerous: boolean): boolean {
  if (mode === 'full') return false
  if (mode === 'auto') return dangerous
  // readonly：任何写操作都要问
  return true
}

/** 粗略判断一条 shell 命令是否包含删除动作 */
export function isDangerousCommand(command: string): boolean {
  return DESTRUCTIVE_COMMAND.test(command)
}

export const PERMISSION_LABEL: Record<PermissionMode, string> = {
  readonly: '只读',
  auto: '自动',
  full: '完全',
}

export const PERMISSION_HINT: Record<PermissionMode, string> = {
  readonly: 'AI 每次要改动文件都会先征求你的同意',
  auto: '普通改动直接执行，只有删除文件才需要你确认',
  full: '全部直接执行，不做任何询问',
}

/** 多语言版本的权限名 / 说明（按当前界面语言） */
export function permissionLabel(mode: PermissionMode): string {
  switch (mode) {
    case 'readonly':
      return t('只读', 'Read-only', '唯讀', '読み取り専用')
    case 'auto':
      return t('自动', 'Auto', '自動', '自動')
    default:
      return t('完全', 'Full', '完全', '完全')
  }
}

export function permissionHint(mode: PermissionMode): string {
  switch (mode) {
    case 'readonly':
      return t(
        'AI 每次要改动文件都会先征求你的同意',
        'The AI asks before every file change',
        'AI 每次要改動檔案都會先徵求你的同意',
        'ファイルを変更する前に毎回確認します',
      )
    case 'auto':
      return t(
        '普通改动直接执行，只有删除文件才需要你确认',
        'Normal changes run directly; only deletions need approval',
        '一般改動直接執行，只有刪除檔案才需要確認',
        '通常の変更は直接実行、削除のみ確認します',
      )
    default:
      return t(
        '全部直接执行，不做任何询问',
        'Everything runs without asking',
        '全部直接執行，不進行任何詢問',
        'すべて確認なしで実行します',
      )
  }
}
