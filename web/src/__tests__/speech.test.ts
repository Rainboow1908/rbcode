import { describe, expect, it } from 'vitest'
import { detectSpeechLang, mathToSpeech, plainTextForSpeech, speechLang, voiceGroupLabel } from '../lib/speech.ts'

describe('朗读：把回答洗成适合念的文本', () => {
  it('公式按人话念：三分之二、x 的平方', () => {
    expect(mathToSpeech('\\frac{2}{3}')).toContain('3分之2')
    expect(mathToSpeech('x^2')).toContain('的平方')
    expect(mathToSpeech('x^{3}')).toContain('的立方')
    expect(mathToSpeech('x^{n}')).toContain('的n次方')
    expect(mathToSpeech('x_i')).toContain('下标 i')
    expect(mathToSpeech('\\sqrt{a+b}')).toContain('根号')
    expect(mathToSpeech('a \\times b')).toContain('乘')
    expect(mathToSpeech('a \\le b')).toContain('小于等于')
    expect(mathToSpeech('\\alpha + \\pi')).toContain('阿尔法')
  })

  it('行内 / 块级公式都会被念出来（不是跳过）', () => {
    const out = plainTextForSpeech('计算 $(\\frac{2}{3})^2$ 得到结果。')
    expect(out).toContain('3分之2')
    expect(out).toContain('的平方')
    expect(out).not.toContain('\\frac')
  })

  it('代码块整段跳过', () => {
    const out = plainTextForSpeech('先看代码：\n\n```js\nconst a = 1\n```\n\n就这样。')
    expect(out).not.toContain('const a')
    expect(out).toContain('就这样')
  })

  it('表格按「列名 + 值」念出来', () => {
    const out = plainTextForSpeech('| 姓名 | 年龄 |\n| --- | --- |\n| 张三 | 30 |\n| 李四 | 25 |')
    expect(out).toContain('姓名 张三')
    expect(out).toContain('年龄 30')
    expect(out).not.toContain('---')
    expect(out).not.toContain('|')
  })

  it('标题 / 加粗 / 链接 / 行内代码的标记都去掉', () => {
    expect(plainTextForSpeech('## 标题')).toBe('标题')
    expect(plainTextForSpeech('**重点**')).toBe('重点')
    expect(plainTextForSpeech('看 [文档](https://example.test) 就好')).toBe('看 文档 就好')
    expect(plainTextForSpeech('用 `npm test` 跑测试')).toContain('npm test')
  })

  it('语言标签跟界面语言走', () => {
    expect(speechLang('zh')).toBe('zh-CN')
    expect(speechLang('tw')).toBe('zh-TW')
    expect(speechLang('en')).toBe('en-US')
  })

  it('「自动」音色按回答文字的语言挑', () => {
    expect(detectSpeechLang('这是一段中文回答，应该用中文音色来念。')).toBe('zh-CN')
    expect(detectSpeechLang('This is an English reply that should use an English voice.')).toBe('en-US')
    expect(detectSpeechLang('12345 + 67')).toBe('')
  })

  it('音色列表的分组名', () => {
    expect(voiceGroupLabel('zh-CN')).toBe('中文')
    expect(voiceGroupLabel('zh-TW')).toBe('中文')
    expect(voiceGroupLabel('en-US')).toBe('English')
    expect(voiceGroupLabel('ja-JP')).toContain('其他语言')
  })
})
