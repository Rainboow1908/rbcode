import { text, type AskOption, type AskQuestion, type ToolDef } from './types.ts'

/** Hard limits so one question call cannot flood the interface */
export const MAX_QUESTIONS = 5
export const MAX_OPTIONS = 4

export const askUserTool: ToolDef = {
  // Asking changes nothing, so it is allowed in plan mode too
  readOnly: true,
  schema: {
    name: 'ask_user',
    description:
      'Ask the user one or more questions and wait for the answers. Use it when the request is ambiguous, when you must choose between approaches, or when you need key facts (language, framework, directory...). ' +
      `At most ${MAX_QUESTIONS} questions per call, at most ${MAX_OPTIONS} options per question. The user can always type their own answer and can always skip a question — those are not yours to control. Do not ask about trivia and do not decide on the user's behalf.`,
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: `Questions to ask (1-${MAX_QUESTIONS})`,
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'The question text' },
              options: {
                type: 'array',
                description: `Choices (at most ${MAX_OPTIONS}); omit to let the user type freely`,
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: 'Option text' },
                    description: { type: 'string', description: 'Extra note (optional)' },
                  },
                  required: ['label'],
                },
              },
              multi_select: { type: 'boolean', description: 'Allow multiple choices. Default false' },
            },
            required: ['question'],
          },
        },
      },
      required: ['questions'],
    },
  },
  async run(args, ctx) {
    const rawQuestions = Array.isArray(args.questions) ? args.questions : []
    if (rawQuestions.length === 0) {
      return text('No question was provided.')
    }

    const questions: AskQuestion[] = rawQuestions
      .slice(0, MAX_QUESTIONS)
      .map((item) => {
        const entry = (item ?? {}) as {
          question?: unknown
          options?: unknown
          multi_select?: unknown
        }
        const rawOptions = Array.isArray(entry.options) ? entry.options : []
        const options: AskOption[] = rawOptions
          .slice(0, MAX_OPTIONS)
          .map((option) => {
            const item = (option ?? {}) as { label?: unknown; description?: unknown }
            return {
              label: String(item.label ?? '').trim(),
              description:
                item.description === undefined || item.description === null
                  ? undefined
                  : String(item.description),
            }
          })
          .filter((option) => option.label !== '')

        return {
          question: String(entry.question ?? '').trim() || '(empty question)',
          options,
          multiSelect: entry.multi_select === true,
        }
      })
      .filter((question) => question.question !== '')

    if (questions.length === 0) {
      return text('No valid question was provided.')
    }

    const answer = await ctx.askUser({ questions })
    return text(answer)
  },
}
