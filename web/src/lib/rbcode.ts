import type { Backend } from './executor/types.ts'

/** 与项目绑定的数据目录，所有快照和会话都放在工作区下的 .rbcode 里 */
export const RBC_DIR = '.rbcode'

/**
 * 确保 .rbcode 及其子目录存在。
 * 打开项目时调用，这样用户能立刻看到目录被创建。
 */
export async function ensureRbcodeDir(backend: Backend): Promise<void> {
  await backend.mkdir(RBC_DIR)
  await backend.mkdir(`${RBC_DIR}/sessions`)
  await backend.mkdir(`${RBC_DIR}/undo`)
}
