/**
 * 设备身份的自动识别：从请求头推断「这是台什么设备」。
 *
 * ## 为什么需要它
 *
 * 起因（用户 2026-10-23 反馈）：鸿蒙手机在设备表里被登记成「Android 设备」。
 * 根因是配置文本路径的 `deviceName` 缺省值硬编码成 `'Android 设备'` ——
 * 那条路径**在生成配置文本时**就把设备行写进库了，而那时桥对「将来谁来用
 * 这个令牌」一无所知。桌面端/隧道一键生成的配置全顶包这个名字，设备表里
 * 躺着 8 条一模一样的「Android 设备」，谁也认不出谁。
 *
 * 正确的时序是「先有连接，再有身份」：配对时桥只知道「有个设备要连」，
 * 真正的平台与型号要等设备**第一次发请求**时才知道。所以这里做两件事：
 *
 * 1. 定义一个结构化上报头（`X-Dsh-Device: <platform>/<model>`），客户端
 *    愿意报就报 —— 这是唯一准确的信息源。
 * 2. 客户端没报时，从 `User-Agent` 兜底推断平台。型号在 UA 里常常拿不到，
 *    拿不到就**留空**，不猜。
 *
 * ## 为什么不用 UA 硬解析型号
 *
 * okhttp（安卓）与 ArkWeb（鸿蒙）默认 UA 里都**没有**机型。硬从 UA 抠一个
 * 型号出来只会得到错的东西，而错的型号比没有型号更糟：用户会以为那是真的。
 * 所以 UA 只用于判平台，型号只认结构化上报。
 *
 * ## 安全边界
 *
 * 这两个字段是**客户端自称**的，不是可信身份。它们只用于界面显示与排查，
 * 绝不参与任何授权判断（授权只看 `scopes` / `rootIds`）。因此这里对长度与
 * 字符集做裁剪（防止往界面里塞控制字符或超长串），但不做「验真」。
 */

/** 已知平台。`unknown` 表示「认出来了但不属于下面任何一个」，不是「没认出来」。 */
export const DEVICE_PLATFORMS = [
  'android',
  'harmonyos',
  'ios',
  'ipados',
  'web',
  'windows',
  'macos',
  'linux',
] as const

export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number]

export interface DeviceIdentity {
  platform?: DevicePlatform
  model?: string
}

/** 型号的最大长度。超过就截断 —— 它只用于显示，不需要完整。 */
const MAX_MODEL_LENGTH = 60

/** 结构化上报头。格式 `platform/model`，model 可省。 */
export const DEVICE_HEADER = 'x-dsh-device'

/**
 * 配对时设备名的占位值。
 *
 * **刻意平台无关**：此前这里（以及隧道路径）硬编码成 `'Android 设备'`，于是
 * 鸿蒙、iOS、桌面上配对的设备全被登记成安卓。桥在生成配置文本时根本不知道
 * 将来是谁来用这个令牌，所以占位名不该声称任何平台。
 *
 * 与 `database.ts` 的 `exchangePairing` 兜底（`'Mobile device'`）取同一个值：
 * 两条路都是「我还不知道这是啥」，不该给出两个不同的说法。
 *
 * 这个占位名会被标记为 `nameSource: 'default'`，设备第一次带身份连上来时
 * 自动换成「平台 · 型号」—— 所以它通常只在设备表里短暂出现。
 */
export const DEFAULT_DEVICE_NAME = 'Mobile device'

function isPlatform(value: string): value is DevicePlatform {
  return (DEVICE_PLATFORMS as readonly string[]).includes(value)
}

/**
 * 清洗型号：去掉控制字符、压缩空白、裁剪长度。
 *
 * 不做 HTML 转义 —— 那是渲染层的事，在这一层转义会让「存进库里的值与
 * 客户端报的不一样」，排查时反而更难对上。React 默认转义文本节点。
 */
function cleanModel(raw: string): string | undefined {
  const stripped = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (stripped === '') return undefined
  return stripped.length > MAX_MODEL_LENGTH ? stripped.slice(0, MAX_MODEL_LENGTH) : stripped
}

/**
 * 从结构化上报头解析。
 *
 * 格式宽松：`android/Pixel 9`、`harmonyos`（只报平台）、`harmonyos/ICL-AL10`。
 * 平台必须在白名单里，否则整条丢弃 —— 一个自造的 `platform` 值会让界面
 * 显示一个不存在的平台标签，不如不显示。
 */
function parseDeviceHeader(raw: string | undefined): DeviceIdentity {
  if (raw === undefined) return {}
  const value = raw.trim()
  if (value === '') return {}
  const slash = value.indexOf('/')
  const platform = (slash === -1 ? value : value.slice(0, slash)).trim().toLowerCase()
  if (!isPlatform(platform)) return {}
  const model = slash === -1 ? undefined : cleanModel(value.slice(slash + 1))
  return model === undefined ? { platform } : { platform, model }
}

/**
 * 从 User-Agent 兜底推断平台。
 *
 * 顺序有讲究：鸿蒙的 UA 里同时含 `Linux` 与 `Android`（兼容串），必须先判
 * 鸿蒙再判安卓，否则鸿蒙会被认成安卓 —— 那正是这次要修的那个错误。
 */
function parseUserAgent(raw: string | undefined): DeviceIdentity {
  if (raw === undefined) return {}
  const ua = raw.trim()
  if (ua === '') return {}

  // 鸿蒙：ArkWeb 内核或显式 HarmonyOS/OpenHarmony。必须排在 Android 之前。
  if (/harmonyos|openharmony|arkweb/i.test(ua)) return { platform: 'harmonyos' }
  // iPad 必须先于 iPhone 判（iPad 的 UA 也含 `iPhone OS`）。
  if (/ipad/i.test(ua)) return { platform: 'ipados' }
  if (/iphone|ipod/i.test(ua)) return { platform: 'ios' }

  const android = /android[^;)]*;\s*([^;)]+?)\s*[;)]/i.exec(ua)
  if (/android/i.test(ua)) {
    // UA 里的机型段（`Android 14; Pixel 9` 的第二段）是 UA 里唯一可信的型号来源。
    // 它常见但**不保证**存在，取不到就只报平台。
    const model = android === null ? undefined : cleanModel(android[1] ?? '')
    return model === undefined ? { platform: 'android' } : { platform: 'android', model }
  }
  if (/windows nt/i.test(ua)) return { platform: 'windows' }
  if (/macintosh|mac os x/i.test(ua)) return { platform: 'macos' }
  if (/x11|linux/i.test(ua)) return { platform: 'linux' }
  return {}
}

/**
 * 解析一次请求的设备身份。结构化头优先，UA 只补缺。
 *
 * 「补缺」而不是「合并」：客户端明确报了 `harmonyos` 时，UA 里那个兼容用的
 * `Android` 不该把它盖掉。
 */
export function parseDeviceIdentity(headers: Record<string, string | string[] | undefined>): DeviceIdentity {
  const header = headers[DEVICE_HEADER]
  const declared = parseDeviceHeader(Array.isArray(header) ? header[0] : header)
  const fallback = parseUserAgent(
    Array.isArray(headers['user-agent']) ? headers['user-agent'][0] : headers['user-agent'],
  )
  return {
    ...(declared.platform !== undefined
      ? { platform: declared.platform }
      : fallback.platform === undefined ? {} : { platform: fallback.platform }),
    ...(declared.model !== undefined
      ? { model: declared.model }
      : fallback.model === undefined ? {} : { model: fallback.model }),
  }
}

/**
 * 用探测到的身份拼一个设备显示名，格式 `平台 · 型号`（与用户手工改的
 * `HarmonyOS · ICL-AL10` 一致）。拿不到平台时返回 `undefined` —— 调用方
 * 应当保留原名字，而不是塞一个更糟的占位。
 */
export function describeDevice(identity: DeviceIdentity): string | undefined {
  const platform = identity.platform
  if (platform === undefined) return undefined
  const label = PLATFORM_LABEL[platform]
  return identity.model === undefined ? label : `${label} · ${identity.model}`
}

const PLATFORM_LABEL: Record<DevicePlatform, string> = {
  android: 'Android',
  harmonyos: 'HarmonyOS',
  ios: 'iOS',
  ipados: 'iPadOS',
  web: 'Web',
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
}
