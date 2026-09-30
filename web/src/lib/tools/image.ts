import { formatBytes } from '../executor/path.ts'
import { failure, requireString, type ToolDef, type ToolImage } from './types.ts'
import { hitsRbcodePath, rbcodeRefusal } from './rbcode.ts'

/**
 * 查看工作区里的图片文件。
 *
 * 图片要真的让模型「看到」，所以工具结果里带上 images，上层会把它作为一条附了图片的
 * 消息追加给模型（只给文件路径是没用的）。
 *
 * 读二进制走 Backend.readFileBase64：companion 的 fs.read 是 UTF-8 文本，直接读图片会坏，
 * 所以那边专门加了 fs.readBase64 接口。
 */

/** 单张图片上限，和粘贴图片保持一致 */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
}

const IMAGE_HINT =
  'The image is attached to this conversation — look at it directly. ' +
  'If your model cannot read images, ignore it and rely on the tool output text instead.'

function mimeOf(path: string): string | null {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  return MIME_BY_EXT[ext] ?? null
}

export const viewImageTool: ToolDef = {
  readOnly: true,
  schema: {
    name: 'view_image',
    description:
      `Look at an image file in the workspace (png / jpg / jpeg / gif / webp, at most ${formatBytes(MAX_IMAGE_BYTES)}). ` +
      'The image is attached to the conversation so you can actually see it — use it to check a screenshot the ' +
      'user made, a diagram, or rendered output. Ask the user to save the image into the workspace first.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the image, relative to the working directory' },
      },
      required: ['path'],
    },
  },
  async run(args, ctx) {
    const path = requireString(args, 'path')
    if (hitsRbcodePath(path)) return failure(rbcodeRefusal(path))
    const mime = mimeOf(path)
    if (!mime) {
      return failure(`Unsupported image type: ${path} (expected png / jpg / jpeg / gif / webp)`)
    }
    if (!ctx.backend.readFileBase64) {
      return failure('This backend cannot read image files. Paste the image into the chat instead.')
    }
    if (!(await ctx.backend.exists(path))) {
      return failure(`Image not found: ${path}`)
    }

    let base64: string
    let size: number
    try {
      const read = await ctx.backend.readFileBase64(path)
      base64 = read.base64
      size = read.size
    } catch (err) {
      return failure(`Failed to read ${path}: ${(err as Error).message}`)
    }

    if (!base64) return failure(`Failed to read ${path}: no image data returned`)
    if (size > MAX_IMAGE_BYTES) {
      return failure(
        `${path} is too large: ${formatBytes(size)} (limit ${formatBytes(MAX_IMAGE_BYTES)})`,
      )
    }

    const image: ToolImage = {
      name: path.split('/').pop() ?? 'image',
      dataUrl: `data:${mime};base64,${base64}`,
    }
    return {
      content: `Attached ${path} (${formatBytes(size)}). ${IMAGE_HINT}`,
      images: [image],
    }
  },
}
