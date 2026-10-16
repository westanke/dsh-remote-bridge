import { describe, expect, it } from 'vitest'
import { sanitizeLoneSurrogates, stringifyWire } from '../src/host/wire-json.ts'

/** 判定一个字符串里是否还有孤立代理项（测试自己的独立实现，不复用被测代码）。 */
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i += 1
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

describe('wire JSON sanitization', () => {
  it('keeps well-formed surrogate pairs untouched', () => {
    // 🐳 = U+1F433，在 UTF-16 里是一对合法代理项
    const whale = 'DSH 🐳 伴侣'
    expect(hasLoneSurrogate(whale)).toBe(false)
    expect(sanitizeLoneSurrogates(whale)).toBe(whale)
    expect(JSON.parse(stringifyWire({ text: whale }))).toEqual({ text: whale })
  })

  it('replaces a lone high surrogate with U+FFFD', () => {
    // 模拟「按字符数截断，正好切掉低代理」的内核输出
    const truncated = `工具输出 ${'🐳'.slice(0, 1)}`
    expect(hasLoneSurrogate(truncated)).toBe(true)
    const fixed = sanitizeLoneSurrogates(truncated)
    expect(fixed).toBe('工具输出 \uFFFD')
    expect(hasLoneSurrogate(fixed)).toBe(false)
  })

  it('replaces a lone low surrogate with U+FFFD', () => {
    const lone = `abc${'🐳'.slice(1)}def`
    expect(hasLoneSurrogate(lone)).toBe(true)
    const fixed = sanitizeLoneSurrogates(lone)
    expect(fixed).toBe('abc\uFFFDdef')
    expect(hasLoneSurrogate(fixed)).toBe(false)
  })

  it('fixes only the broken pair when good and bad pairs are mixed', () => {
    const mixed = `a🐳b${'🐳'.slice(0, 1)}c🐳d`
    const fixed = sanitizeLoneSurrogates(mixed)
    expect(fixed).toBe('a🐳b\uFFFDc🐳d')
    expect(hasLoneSurrogate(fixed)).toBe(false)
  })

  it('returns the same reference when there is nothing to fix', () => {
    // 快路径：广播热路径上不该为零缺陷输入分配新字符串
    const clean = 'x'.repeat(1000)
    expect(sanitizeLoneSurrogates(clean)).toBe(clean)
  })

  it('serializes nested structures without leaving lone surrogates on the wire', () => {
    const payload = {
      type: 'chat.message.committed',
      data: {
        list: ['ok', `${'🐳'.slice(0, 1)}`, { deep: ['\ud800', 'fine'] }],
      },
    }
    const encoded = stringifyWire(payload)
    // 原生的 JSON.stringify 会把它转义成 \ud800 —— 那正是 Foundation 拒绝整帧的形态
    expect(JSON.stringify(payload)).toContain('\\ud800')
    expect(encoded).not.toContain('\\ud800')
    expect(hasLoneSurrogate(encoded)).toBe(false)
    const decoded = JSON.parse(encoded) as { data: { list: unknown[] } }
    expect(decoded.data.list[0]).toBe('ok')
    expect(decoded.data.list[1]).toBe('\uFFFD')
  })

  it('matches native JSON.stringify exactly for clean payloads', () => {
    const clean = { a: 1, b: ['x', { c: true }], d: null, e: '中文🐳' }
    expect(stringifyWire(clean)).toBe(JSON.stringify(clean))
  })

  it('handles the pathological input the regex approach used to choke on', () => {
    // 契约里的替代实现（带重复分组的正则 / 后向断言）在长串上会退化甚至爆栈；
    // 扫描版必须是线性且无栈增长 —— 这里用「能跑完」把回归钉住。
    const long = `${'🐳'.slice(0, 1)}${'x'.repeat(200_000)}`
    const started = Date.now()
    const fixed = sanitizeLoneSurrogates(long)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(fixed.startsWith('\uFFFD')).toBe(true)
    expect(hasLoneSurrogate(fixed)).toBe(false)
  })
})
