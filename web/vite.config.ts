import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    // MathJax 的 components/version.js 在 PACKAGE_VERSION 未定义时会 eval('require') 去读
    // package.json —— 浏览器里直接抛 "require is not defined"，整个按需 chunk 加载失败。
    // 给一个编译期常量把这条 Node 分支短路掉。
    PACKAGE_VERSION: JSON.stringify('3.2.1'),
  },
  server: {
    // 开发时前端跑在 vite(5173)，把 /api 转发给本地 wrangler dev(8787)
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    // 渲染整棵 App 的用例在 jsdom 里本来就慢（KaTeX 之后更慢），给宽一点
    testTimeout: 30_000,
    setupFiles: ['./src/__tests__/setup.ts'],
  },
})
