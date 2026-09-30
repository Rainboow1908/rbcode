/**
 * 把终端输出的「字节流」处理成能安全放进 <pre> 的文本。
 * 后端给的是终端语义：ANSI 转义、\r 覆盖、退格……直接显示就是乱码 / 空白。
 * 这里做最小处理：去转义、按 \r 取每行最后一版、清掉其它控制字符。
 */
export function cleanTerminalText(input: string): string {
  if (!input) return ''
  let text = input
    // OSC（如设置标题）：ESC ] ... BEL 或 ST
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    // CSI：ESC [ 参数 中间 终止
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // 其它两字符转义
    .replace(/\u001b[@-Z\\-_]/g, '')
  // 退格：吃掉前一个字符
  text = text.replace(/[^\n]\u0008/g, '').replace(/\u0008/g, '')
  // 回车覆盖：同一行只保留最后一版（进度条/覆盖式刷新就是这个）
  text = text
    .split('\n')
    .map((line) => (line.includes('\r') ? (line.split('\r').pop() ?? '') : line))
    .join('\n')
  // 剩余控制字符（保留 \n \t）
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  return text
}
