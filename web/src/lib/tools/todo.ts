import type { Todo, TodoStatus } from '../types.ts'
import { text, type ToolDef } from './types.ts'

const STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed']

function parseTodos(raw: unknown): Todo[] {
  if (!Array.isArray(raw)) return []
  return raw.map((item) => {
    const entry = (item ?? {}) as { content?: unknown; status?: unknown }
    const status = STATUSES.includes(entry.status as TodoStatus)
      ? (entry.status as TodoStatus)
      : 'pending'
    return {
      id: crypto.randomUUID(),
      content: String(entry.content ?? '').trim() || '(unnamed step)',
      status,
    }
  })
}

export function renderTodos(todos: Todo[]): string {
  if (todos.length === 0) return 'Plan is empty'
  const icon: Record<TodoStatus, string> = {
    pending: '[ ]',
    in_progress: '[~]',
    completed: '[x]',
  }
  return todos.map((t) => `${icon[t.status]} ${t.content}`).join('\n')
}

export const todoWriteTool: ToolDef = {
  // Only affects the in-memory plan, so it is allowed in plan mode too
  readOnly: true,
  schema: {
    name: 'todo_write',
    description:
      'Create or update the task plan. List the steps before starting complex work and update statuses as you go (at most one step in_progress at a time). Each call replaces the whole list.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The complete plan',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Step description' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: 'Step status',
              },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  },
  async run(args, ctx) {
    const todos = parseTodos(args.todos)
    ctx.setTodos(todos)
    return text(`Plan updated (${todos.length} items)\n${renderTodos(todos)}`)
  },
}

export const todoReadTool: ToolDef = {
  readOnly: true,
  schema: {
    name: 'todo_read',
    description: 'Read the current task plan.',
    parameters: { type: 'object', properties: {} },
  },
  async run(_args, ctx) {
    return text(renderTodos(ctx.getTodos()))
  },
}
