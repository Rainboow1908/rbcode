/**
 * 只在「安全上下文」（HTTPS / localhost）里可用的 Web API 的补丁。
 *
 * 手机通过局域网 http://<ip>:5173 打开开发服务器时，不是安全上下文，
 * `crypto.randomUUID` 会是 undefined —— 而它在初始渲染里就会被调用
 * （loadSettings → createProvider），直接让整个应用崩成白屏。
 * 这里用始终可用的 `crypto.getRandomValues` 补一个等价实现。
 */
if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function') {
  Object.defineProperty(crypto, 'randomUUID', {
    configurable: true,
    writable: true,
    value: () => {
      const bytes = crypto.getRandomValues(new Uint8Array(16))
      bytes[6] = (bytes[6] & 0x0f) | 0x40 // version 4
      bytes[8] = (bytes[8] & 0x3f) | 0x80 // variant 10
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    },
  })
}

export {}
