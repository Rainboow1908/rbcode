import { describe, expect, it } from 'vitest'
import { RepetitionWatcher, detectRepetition } from '../lib/repetition.ts'

/** 一段「正常」的说明文字：没有连续重复 */
const NORMAL = [
  '先把项目结构看一遍，确认入口文件在哪里，然后再决定改哪几个模块。',
  '第一步：读 package.json，看依赖与脚本，确认构建方式与运行方式。',
  '第二步：读 src/index.ts，理清模块的加载顺序与初始化流程。',
  '第三步：跑一遍现有测试，确认改动之前基线是绿的。',
  '最后把结论写成简短的计划，交给用户确认之后再动手改代码。',
].join('\n')

describe('重复内容检测', () => {
  it('同一句话连续重复到阈值 → 命中', () => {
    const unit = '这段文字被模型原封不动地重复了三遍，明显是卡住了。'
    const text = `先正常说一句。${unit}${unit}${unit}`
    const hit = detectRepetition(text, unit.length, 3)
    expect(hit).not.toBeNull()
    expect(hit!.count).toBeGreaterThanOrEqual(3)
    expect(hit!.unit).toBe(unit)
    // at 指向重复开始处：裁掉它就能得到干净的内容
    expect(text.slice(0, hit!.at)).toBe('先正常说一句。')
    expect(text.slice(hit!.at)).toBe(unit.repeat(hit!.count))
  })

  it('整段（多行）连续重复 → 命中', () => {
    const block = '## 结论\n这一段是重复出现的，里面有两行内容，长度也够。'
    const text = `上面是正常内容。\n${block}\n${block}\n${block}\n`
    const hit = detectRepetition(text, 16, 3)
    expect(hit).not.toBeNull()
    expect(hit!.count).toBeGreaterThanOrEqual(3)
  })

  it('正常文字不误报', () => {
    expect(detectRepetition(NORMAL, 20, 3)).toBeNull()
    expect(detectRepetition('好的，我明白了。', 8, 3)).toBeNull()
    expect(detectRepetition('', 20, 3)).toBeNull()
  })

  it('连续空行 / 无意义的字符排比不算（避免把排版当卡带）', () => {
    expect(detectRepetition('\n\n\n\n\n\n', 8, 3)).toBeNull()
    // 只有两三种字符在打转：标点排比、表格分隔行，不该当成卡带
    expect(detectRepetition('好。'.repeat(20), 8, 3)).toBeNull()
    expect(detectRepetition('| --- | --- | --- |'.repeat(4), 8, 3)).toBeNull()
  })

  it('阈值调高就不报（灵敏度可调）', () => {
    const unit = '同一段内容只重复两遍，按阈值 2 才算异常。'
    const text = `${unit}${unit}`
    expect(detectRepetition(text, unit.length, 3)).toBeNull()
    expect(detectRepetition(text, unit.length, 2)).not.toBeNull()
  })

  it('检测范围：只看正文时不管思考过程', () => {
    const flat = { minUnit: 16, threshold: 3, checkEvery: 1 }
    const textScope = new RepetitionWatcher({ ...flat, scope: 'text' })
    const unit = '这是一段会在思考里重复出现的很长的句子内容。'
    expect(textScope.covers('reasoning')).toBe(false)
    expect(textScope.feed('reasoning', unit.repeat(3))).toBeNull()
    expect(textScope.feed('text', unit.repeat(3))).not.toBeNull()

    const reasoningScope = new RepetitionWatcher({ ...flat, scope: 'reasoning' })
    expect(reasoningScope.covers('text')).toBe(false)
    expect(reasoningScope.covers('reasoning')).toBe(true)

    const all = new RepetitionWatcher({ ...flat, scope: 'all' })
    expect(all.covers('tool')).toBe(true)
  })

  it('工具参数：短重复放过，长重复才报', () => {
    const watcher = new RepetitionWatcher({ scope: 'all', minUnit: 16, threshold: 3, checkEvery: 1 })
    const short = '| a | b | c | d | e | f |'.repeat(3)
    expect(watcher.feed('tool', short)).toBeNull()
    const block = Array.from(
      { length: 5 },
      (_, i) => `第${i + 1}段内容：模型在写工具参数时把同一段反反复复地吐了出来，说明它已经卡住了。`,
    ).join('')
    const long = `${block}${block}${block}`
    expect(long.length).toBeGreaterThan(240)
    expect(watcher.feed('tool', long)).not.toBeNull()
  })

  it('按长度节流：追加得太少就先不算', () => {
    const unit = '这段内容够长，重复三遍应该被抓到。'
    const watcher = new RepetitionWatcher({
      scope: 'text',
      minUnit: unit.length,
      threshold: 3,
      checkEvery: 40,
    })
    expect(watcher.feed('text', unit.repeat(3).slice(0, 10))).toBeNull()
    expect(watcher.feed('text', unit.repeat(3))).not.toBeNull()
  })
})
