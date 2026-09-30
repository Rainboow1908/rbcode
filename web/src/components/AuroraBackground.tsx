import { useEffect, useRef } from 'react'

/**
 * 极光背景：WebGL2 片元着色器（fbm 噪声光帘 + 星空 + 天空穹顶）。
 * 参考自一个独立的 WebGL 极光 demo，这里改造成应用背景：
 * - 去掉拖拽/缩放交互，改成相机缓慢自转
 * - 只在「极光」主题下运行；分辨率按比例降低、限 30fps、切走标签页暂停、
 *   prefers-reduced-motion 时只画一帧静态的
 */

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main(){
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;
out vec4 outColor;
in vec2 v_uv;
uniform vec2 u_res;
uniform float u_time;
/* 极光的三个基色（每个「颜色」选项自带一套多彩调色板） */
uniform vec3 u_c1;
uniform vec3 u_c2;
uniform vec3 u_c3;

#define PI 3.14159265359

float hash21(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec2(13.1, 7.7);
    a *= 0.5;
  }
  return v;
}

float stars(vec2 uv){
  vec2 p = uv * vec2(u_res.x / u_res.y, 1.0) * 95.0;
  vec2 id = floor(p), f = fract(p) - 0.5;
  float h = hash21(id);
  float s = exp(-28.0 * dot(f, f)) * step(0.992, h);
  float tw = 0.55 + 0.45 * sin(u_time * (1.2 + 4.0 * h) + h * 30.0);
  return s * tw;
}

/* 相机缓慢自转的天空方向 */
vec3 skyDir(vec2 uv){
  vec2 p = (uv - 0.5);
  p.x *= u_res.x / u_res.y;
  float yaw = u_time * 0.03;
  float pitch = -0.06;
  float cp = cos(pitch), sp = sin(pitch);
  float cy = cos(yaw), sy = sin(yaw);
  vec3 d = normalize(vec3(p.x, p.y * 0.72 + 0.18, 1.25));
  d = vec3(d.x, d.y * cp - d.z * sp, d.y * sp + d.z * cp);
  d = vec3(d.x * cy + d.z * sy, d.y, -d.x * sy + d.z * cy);
  return d;
}

float aurora(vec2 p, float t, float band){
  float n = fbm(p * vec2(1.15, 1.7) + vec2(t * 0.035, -t * 0.018));
  float n2 = fbm(p * vec2(2.8, 5.0) + vec2(-t * 0.06, t * 0.025));
  float ridge = 0.5 + 0.5 * sin(p.x * 2.15 + n * 4.8 + sin(p.x * 0.85 + t * 0.16) * 1.5);
  float center = 0.36 + 0.16 * sin(p.x * 0.72 + t * 0.10 + n * 2.0) + 0.13 * n;
  float y = p.y - center - band * 0.22;
  float width = 0.055 + 0.07 * n;
  float core = exp(-y * y / (width * width));
  float curtains = core * (0.35 + 0.65 * n2) * (0.35 + 0.65 * ridge);
  curtains += exp(-abs(y) * 26.0) * n2 * 0.24;
  return max(0.0, curtains);
}

void main(){
  vec2 uv = v_uv;
  vec3 d = skyDir(uv);

  float horizon = smoothstep(-0.18, 0.48, d.y);
  vec3 col = mix(vec3(0.004, 0.007, 0.022), vec3(0.012, 0.025, 0.075), horizon);
  col += vec3(0.006, 0.012, 0.025) * pow(max(d.y, 0.0), 2.0);

  col += stars(uv) * vec3(0.45, 0.75, 1.0);

  float skyMask = smoothstep(-0.02, 0.32, d.y);
  vec2 p = vec2(d.x * 2.8, d.y * 2.1 + 0.03);

  float a1 = aurora(p, u_time, 0.0);
  float a2 = aurora(p * vec2(0.82, 1.13) + vec2(1.2, -0.28), u_time * 1.08 + 4.0, 0.22);
  float a3 = aurora(p * vec2(1.45, 0.72) + vec2(-2.0, 0.35), u_time * 0.86 - 3.0, -0.18);

  vec3 green = u_c1;
  vec3 cyan = u_c2;
  vec3 violet = u_c3;

  col += skyMask * a1 * (green * 1.1 + cyan * 0.6);
  col += skyMask * a2 * (cyan * 0.8 + green * 0.55);
  col += skyMask * a3 * violet * 0.45;

  float glow = pow(max(d.y, 0.0), 1.7) * 0.075;
  col += glow * (u_c1 * 0.10 + u_c2 * 0.06);

  float hz = exp(-abs(d.y + 0.015) * 75.0);
  col += hz * (u_c1 * 0.05 + u_c2 * 0.03);

  col = 1.0 - exp(-col * 1.25);
  col = pow(col, vec3(0.92));

  vec2 q = uv - 0.5;
  col *= 1.0 - 0.22 * dot(q, q) * 1.8;

  outColor = vec4(col, 1.0);
}`

/** 默认极光配色（原本的绿 / 青 / 紫） */
const DEFAULT_COLORS: [string, string, string] = ['#08ff7a', '#0ac7ff', '#801fff']

/** hex → 0..1 的 rgb */
function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '')
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value
  const num = Number.parseInt(full, 16)
  return [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255]
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, src)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return null
  }
  return shader
}

/** 渲染分辨率倍率：极光是柔光，用低分辨率再放大看不出来，但省很多 GPU */
const RESOLUTION_SCALE = 0.6
/** 限帧：背景动画 30fps 足够 */
const FRAME_MS = 33

export default function AuroraBackground({
  active,
  colors,
}: {
  active: boolean
  /** 极光的三个基色（hex）。不给就用原本的绿/青/紫 */
  colors?: [string, string, string]
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  /** 只在配色字符串变化时重建（避免数组字面量导致每帧重建） */
  const palette = (colors ?? DEFAULT_COLORS).join(',')

  useEffect(() => {
    if (!active) return
    const canvas = canvasRef.current
    if (!canvas) return

    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      powerPreference: 'low-power',
    })
    if (!gl) return

    const vs = compile(gl, gl.VERTEX_SHADER, VERT)
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
    if (!vs || !fs) return
    const program = gl.createProgram()
    if (!program) return
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return

    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    )

    const posLoc = gl.getAttribLocation(program, 'a_pos')
    const resLoc = gl.getUniformLocation(program, 'u_res')
    const timeLoc = gl.getUniformLocation(program, 'u_time')
    const c1Loc = gl.getUniformLocation(program, 'u_c1')
    const c2Loc = gl.getUniformLocation(program, 'u_c2')
    const c3Loc = gl.getUniformLocation(program, 'u_c3')
    const [hex1, hex2, hex3] = palette.split(',')
    const [r1, g1, b1] = hexToRgb(hex1)
    const [r2, g2, b2] = hexToRgb(hex2)
    const [r3, g3, b3] = hexToRgb(hex3)

    let frame = 0
    let last = 0
    let paused = document.hidden
    const start = performance.now()

    const draw = (now: number) => {
      // 关了动效就只画一帧静态极光，不持续刷新
      if (!reduce) frame = requestAnimationFrame(draw)
      if (paused && !reduce) return
      if (now - last < FRAME_MS && !reduce) return
      last = now

      const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
      const w = Math.max(1, Math.floor(canvas.clientWidth * dpr * RESOLUTION_SCALE))
      const h = Math.max(1, Math.floor(canvas.clientHeight * dpr * RESOLUTION_SCALE))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
        gl.viewport(0, 0, w, h)
      }

      gl.useProgram(program)
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.enableVertexAttribArray(posLoc)
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0)
      gl.uniform2f(resLoc, canvas.width, canvas.height)
      gl.uniform1f(timeLoc, (now - start) * 0.001)
      gl.uniform3f(c1Loc, r1, g1, b1)
      gl.uniform3f(c2Loc, r2, g2, b2)
      gl.uniform3f(c3Loc, r3, g3, b3)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }

    frame = requestAnimationFrame(draw)

    const onVisibility = () => {
      paused = document.hidden
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [active, palette])

  return <canvas ref={canvasRef} className="rb-aurora-canvas" aria-hidden="true" />
}
