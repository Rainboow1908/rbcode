import { afterEach, describe, expect, it } from 'vitest'
import { loadSessionCache, saveSessionCache } from '../lib/sessionCache.ts'

const KEY = 'rbcode.sessionCache.v1'

afterEach(() => {
  localStorage.clear()
})

describe('会话索引缓存', () => {
  it('存一轮再读回来内容一致', () => {
    const cache = {
      'companion:D:/demo/a': [
        { id: 'a1', title: '第一个会话', createdAt: 1, updatedAt: 2, messageCount: 3 },
      ],
    }
    saveSessionCache(cache)
    expect(loadSessionCache()).toEqual(cache)
  })

  it('缓存坏了也不会影响启动', () => {
    localStorage.setItem(KEY, '{ 这不是 json')
    expect(loadSessionCache()).toEqual({})

    localStorage.setItem(KEY, '"只是个字符串"')
    expect(loadSessionCache()).toEqual({})

    localStorage.setItem(
      KEY,
      JSON.stringify({ p1: '不是数组', p2: [{ id: 'x' }, null, { 没有id: 1 }] }),
    )
    expect(loadSessionCache()).toEqual({ p2: [{ id: 'x' }] })
  })

  it('每个项目最多留 200 条，避免撑爆 localStorage', () => {
    const many = Array.from({ length: 260 }, (_, i) => ({
      id: `s${i}`,
      title: `t${i}`,
      createdAt: i,
      updatedAt: i,
      messageCount: 1,
    }))
    saveSessionCache({ p1: many })
    expect(loadSessionCache().p1?.length).toBe(200)
  })
})
