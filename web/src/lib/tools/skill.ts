import { failure, optionalString, text, type ToolDef } from './types.ts'

/**
 * 调用技能：用户在设置里准备好的「可复用指令」。
 * 系统提示词里会列出技能名与说明，模型判断任务匹配时用这个工具把它们加载进上下文。
 * 调用本身不改变磁盘上的任何东西。
 */
export const skillTool: ToolDef = {
  readOnly: true,
  schema: {
    name: 'skill',
    description:
      'Load a skill: reusable instructions the user prepared in Settings. Call it with the exact skill name ' +
      'when the current task matches one of the skills listed in your system prompt; the returned instructions ' +
      'then tell you how to do the work. Loading a skill changes nothing on disk.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The exact skill name to load.' },
      },
      required: ['name'],
    },
  },
  async run(args, ctx) {
    const skills = ctx.getSettings?.().skills ?? []
    if (skills.length === 0) {
      return failure(
        'No skills are configured. Tell the user to add one under Settings → Skills.',
      )
    }

    const wanted = (optionalString(args, 'name') ?? '').trim()
    const skill = skills.find((item) => item.name.toLowerCase() === wanted.toLowerCase())
    if (!skill) {
      const list = skills.map((item) => `- ${item.name}: ${item.description || '(no description)'}`)
      return failure(`Unknown skill "${wanted}". Available skills:\n${list.join('\n')}`)
    }

    return text(`# Skill: ${skill.name}\n\n${skill.instructions}`)
  },
}
