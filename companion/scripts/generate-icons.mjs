/**
 * 生成 companion 所需的图标（PNG + ICO），无需任何第三方依赖。
 * 用法：node scripts/generate-icons.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'src-tauri', 'icons')

/* --------------------------------- PNG 编码 --------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = -1
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function encodePNG(size, rgba) {
  const stride = size * 4 + 1
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ----------------------------------- 绘制 ----------------------------------- */

// 在归一化坐标（0..1）上判断覆盖度，再用超采样抗锯齿
const BG_TOP = [59, 130, 246] // #3b82f6
const BG_BOTTOM = [29, 78, 216] // #1d4ed8
const FG = [255, 255, 255]

const RADIUS = 0.225
const GLYPH_WIDTH = 0.082

function insideRoundedRect(x, y, radius) {
  const inset = 0
  const minX = inset
  const maxX = 1 - inset
  const cx = Math.min(Math.max(x, minX + radius), maxX - radius)
  const cy = Math.min(Math.max(y, minX + radius), maxX - radius)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= radius * radius
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax
  const vy = by - ay
  const wx = px - ax
  const wy = py - ay
  const len = vx * vx + vy * vy
  const t = len === 0 ? 0 : Math.min(1, Math.max(0, (wx * vx + wy * vy) / len))
  const dx = px - (ax + t * vx)
  const dy = py - (ay + t * vy)
  return Math.sqrt(dx * dx + dy * dy)
}

function sample(x, y) {
  if (!insideRoundedRect(x, y, RADIUS)) return null

  // 终端提示符 ">" 和光标下划线 "_"
  const upper = distanceToSegment(x, y, 0.3, 0.31, 0.5, 0.5)
  const lower = distanceToSegment(x, y, 0.5, 0.5, 0.3, 0.69)
  const inChevron = Math.min(upper, lower) <= GLYPH_WIDTH / 2
  const inCursor = x >= 0.56 && x <= 0.72 && y >= 0.62 && y <= 0.7

  if (inChevron || inCursor) return FG

  const t = y
  return [
    Math.round(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t),
    Math.round(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t),
    Math.round(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t),
  ]
}

function render(size, supersample = 3) {
  const out = Buffer.alloc(size * size * 4)
  const step = 1 / (size * supersample)

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < supersample; sy++) {
        for (let sx = 0; sx < supersample; sx++) {
          const x = (px * supersample + sx + 0.5) * step
          const y = (py * supersample + sy + 0.5) * step
          const color = sample(x, y)
          if (color) {
            r += color[0]
            g += color[1]
            b += color[2]
            a += 255
          }
        }
      }
      const samples = supersample * supersample
      const index = (py * size + px) * 4
      if (a > 0) {
        const covered = a / 255
        out[index] = Math.round(r / covered)
        out[index + 1] = Math.round(g / covered)
        out[index + 2] = Math.round(b / covered)
        out[index + 3] = Math.round(a / samples)
      }
    }
  }
  return out
}

/* ----------------------------------- ICO ----------------------------------- */

function buildIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  const entries = []
  let offset = 6 + images.length * 16
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16)
    entry[0] = size >= 256 ? 0 : size
    entry[1] = size >= 256 ? 0 : size
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += data.length
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)])
}

/* ----------------------------------- 输出 ----------------------------------- */

mkdirSync(outDir, { recursive: true })

const sizes = [16, 32, 48, 64, 128, 256]
const pngs = new Map()
for (const size of sizes) {
  pngs.set(size, encodePNG(size, render(size)))
}

writeFileSync(join(outDir, '32x32.png'), pngs.get(32))
writeFileSync(join(outDir, '128x128.png'), pngs.get(128))
writeFileSync(join(outDir, '128x128@2x.png'), pngs.get(256))
writeFileSync(join(outDir, 'icon.png'), pngs.get(256))
writeFileSync(
  join(outDir, 'icon.ico'),
  buildIco([16, 32, 48, 64, 128, 256].map((size) => ({ size, data: pngs.get(size) }))),
)

console.log(`已生成图标到 ${outDir}`)
