import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DEVICE_NAME,
  describeDevice,
  parseDeviceIdentity,
} from '../src/host/device-identity.ts'

/**
 * 设备身份探测。
 *
 * 这组用例的动机是用户 2026-10-23 的反馈：鸿蒙手机在设备表里被登记成
 * 「Android 设备」。根因之一是**鸿蒙的 UA 里同时含 `Linux` 与 `Android`**
 * （兼容串），判平台时顺序错了就会重演同一个错误 —— 所以顺序相关的用例
 * 在这里是回归断言，不是补充。
 */
describe('parseDeviceIdentity', () => {
  describe('结构化上报头优先', () => {
    it('parses platform and model', () => {
      expect(parseDeviceIdentity({ 'x-dsh-device': 'harmonyos/ICL-AL10' }))
        .toEqual({ platform: 'harmonyos', model: 'ICL-AL10' })
    })

    it('accepts platform only', () => {
      expect(parseDeviceIdentity({ 'x-dsh-device': 'android' })).toEqual({ platform: 'android' })
    })

    it('keeps spaces in the model', () => {
      expect(parseDeviceIdentity({ 'x-dsh-device': 'android/Pixel 9 Pro' }))
        .toEqual({ platform: 'android', model: 'Pixel 9 Pro' })
    })

    it('is case-insensitive for the platform but preserves model case', () => {
      expect(parseDeviceIdentity({ 'x-dsh-device': 'HarmonyOS/ICL-AL10' }))
        .toEqual({ platform: 'harmonyos', model: 'ICL-AL10' })
    })

    it('drops an unknown platform entirely', () => {
      // 自造的平台值会让界面显示一个不存在的标签，不如不显示。
      expect(parseDeviceIdentity({ 'x-dsh-device': 'symbian/N95' })).toEqual({})
    })

    it('beats the User-Agent instead of merging with it', () => {
      // 鸿蒙客户端明确报 harmonyos 时，UA 里那个兼容用的 Android 不该把它盖掉。
      const identity = parseDeviceIdentity({
        'x-dsh-device': 'harmonyos',
        'user-agent': 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 ArkWeb/4.1',
      })
      expect(identity.platform).toBe('harmonyos')
    })

    it('fills the model from the header when UA has none', () => {
      const identity = parseDeviceIdentity({
        'x-dsh-device': 'android/Pixel 9',
        'user-agent': 'okhttp/4.12.0',
      })
      expect(identity).toEqual({ platform: 'android', model: 'Pixel 9' })
    })

    it('takes the first value when the header repeats', () => {
      expect(parseDeviceIdentity({ 'x-dsh-device': ['ios', 'android'] })).toEqual({ platform: 'ios' })
    })

    it('ignores an empty header value', () => {
      expect(parseDeviceIdentity({ 'x-dsh-device': '   ' })).toEqual({})
    })
  })

  describe('User-Agent 兜底', () => {
    it('recognises HarmonyOS before Android (the regression this fixes)', () => {
      // 顺序错了这里就会变成 android —— 正是用户报的那个 bug。
      const identity = parseDeviceIdentity({
        'user-agent': 'Mozilla/5.0 (Phone; OpenHarmony 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114 ArkWeb/4.1',
      })
      expect(identity.platform).toBe('harmonyos')
    })

    it('recognises HarmonyOS when the UA also says Android', () => {
      const identity = parseDeviceIdentity({
        'user-agent': 'Mozilla/5.0 (Linux; Android 12; HarmonyOS; ICL-AL10) AppleWebKit/537.36',
      })
      expect(identity.platform).toBe('harmonyos')
    })

    it('recognises Android and takes the model segment', () => {
      expect(parseDeviceIdentity({
        'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 9) AppleWebKit/537.36',
      })).toEqual({ platform: 'android', model: 'Pixel 9' })
    })

    it('reports Android without a model when the UA has none', () => {
      expect(parseDeviceIdentity({ 'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36' }))
        .toEqual({ platform: 'android' })
    })

    it('recognises iPadOS before iOS', () => {
      // iPad 的 UA 也含 `iPhone OS`，顺序反了会把 iPad 认成 iPhone。
      expect(parseDeviceIdentity({
        'user-agent': 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      }).platform).toBe('ipados')
    })

    it('recognises iOS', () => {
      expect(parseDeviceIdentity({
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      }).platform).toBe('ios')
    })

    it('recognises Windows', () => {
      expect(parseDeviceIdentity({ 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }).platform)
        .toBe('windows')
    })

    it('recognises macOS', () => {
      expect(parseDeviceIdentity({ 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }).platform)
        .toBe('macos')
    })

    it('recognises Linux', () => {
      expect(parseDeviceIdentity({ 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)' }).platform).toBe('linux')
    })

    it('returns nothing for a bare okhttp UA', () => {
      // 这是安卓客户端的**默认**情况：OkHttp 只报自己，不报系统。
      // 返回空是诚实的 —— 猜一个 android 出来就成了「编造事实」。
      expect(parseDeviceIdentity({ 'user-agent': 'okhttp/4.12.0' })).toEqual({})
    })

    it('returns nothing when there is no UA at all', () => {
      expect(parseDeviceIdentity({})).toEqual({})
    })
  })

  describe('清洗', () => {
    it('strips control characters from the model', () => {
      expect(parseDeviceIdentity({ 'x-dsh-device': 'android/Pixel\u0000 9\nPro' }))
        .toEqual({ platform: 'android', model: 'Pixel 9 Pro' })
    })

    it('truncates an over-long model', () => {
      const identity = parseDeviceIdentity({ 'x-dsh-device': `android/${'x'.repeat(200)}` })
      expect(identity.model?.length).toBe(60)
    })

    it('drops a model that is only whitespace', () => {
      expect(parseDeviceIdentity({ 'x-dsh-device': 'android/   ' })).toEqual({ platform: 'android' })
    })
  })
})

describe('describeDevice', () => {
  it('joins platform label and model', () => {
    expect(describeDevice({ platform: 'harmonyos', model: 'ICL-AL10' })).toBe('HarmonyOS · ICL-AL10')
  })

  it('returns the platform label alone when there is no model', () => {
    expect(describeDevice({ platform: 'android' })).toBe('Android')
  })

  it('returns undefined without a platform', () => {
    // 调用方据此**保留原名字**，而不是塞一个更糟的占位。
    expect(describeDevice({ model: 'Pixel 9' })).toBeUndefined()
    expect(describeDevice({})).toBeUndefined()
  })
})

describe('DEFAULT_DEVICE_NAME', () => {
  it('does not claim a platform', () => {
    // 此前是硬编码的 `'Android 设备'`，于是鸿蒙/iOS/桌面全被登记成安卓。
    expect(DEFAULT_DEVICE_NAME).toBe('Mobile device')
    expect(DEFAULT_DEVICE_NAME.toLowerCase()).not.toContain('android')
  })
})
