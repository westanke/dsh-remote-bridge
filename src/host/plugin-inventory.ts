import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * 插件清单（plugin inventory）。
 *
 * ## 为什么需要它
 *
 * 用户在手机上使用时的反馈是「功能单调点，无法查看装的插件情况」：想知道这台机器上
 * 装了哪些插件、有没有出问题的，必须回到电脑前的 WebUI。
 *
 * 而插件的 API 面（`/api/v1`）此前有 10 个端点，**没有任何一个与插件相关**；
 * loopback 管理面（`/manage/status`）也只回 `remote` / `roots` / `devices`。
 * 于是这个信息在远程侧完全不可见。本模块补上这个缺口。
 *
 * ## 数据源为什么是这两个文件
 *
 * DSH 把每个 profile 的插件状态放在两个地方，缺一不可：
 *
 * - `<profiledir>/package.json` 的 `dependencies`：**装了哪些包**（含版本声明）；
 * - 同一个 `package.json` 的 `dsh.profile.bundles`：**实际加载了哪些包**。
 *
 * 两者之差是有意义的信息，而不是噪声：
 *
 * - 在 `dependencies` 里但不在 `bundles` 里 → **装了但没启用**（例如用户装了备用插件先不加载）；
 * - 在 `bundles` 里但 `node_modules` 下找不到 → **声明加载却缺失**，这通常意味着启动会出问题，
 *   是用户最需要被提前告知的状态。
 *
 * 另外，`node_modules/<name>/package.json` 里的 `version` 才是**实际装上的版本**。
 * 只看 `dependencies` 的 `^0.4.5` 无法回答「我现在跑的是哪个版本」。
 *
 * ## 安全边界
 *
 * 本模块只读两个位置的文件，并把结果**限制为**「包名 + 版本 + 状态」三种信息，
 * 不回传任何文件内容、绝对路径之外的系统信息、或 `.env` / 凭据相关内容。
 * `profilePath` 会返回，因为用户需要它来定位问题，且它本来就是本机路径。
 */

/** 单个插件的状态。 */
export type PluginState =
  /** 已声明加载，且能在 profile 的 node_modules 里找到。 */
  | 'loaded'
  /**
   * 官方包（`@deepseek-ai/` 前缀），由 DSH 运行时自带。
   *
   * 它们出现在 `dsh.profile.bundles` 里，但**不会**装在 profile 的 `node_modules` 下
   * （随 DSH 主包一起安装）。这不是异常 —— 早期实现把它误判成 `declared-missing`，
   * 在真实机器上一次性产生 5 条假警报，所以必须与「真的缺失」区分开。
   */
  | 'runtime-provided'
  /** 装了（在 dependencies 里）但不在加载列表里 —— 通常是有意为之，值得展示但不必报错。 */
  | 'installed-not-loaded'
  /** 非官方包，声明要加载但 profile 里找不到 —— 这通常意味着启动会出问题。 */
  | 'declared-missing'

export interface PluginEntry {
  name: string
  /** `dependencies` 里的版本声明，例如 `^0.4.5`；没有则为 null。 */
  declared: string | null
  /** `node_modules/<name>/package.json` 里实际装上的版本；找不到则为 null。 */
  installed: string | null
  /** 是否出现在 `dsh.profile.bundles` 中。 */
  loaded: boolean
  /** 是否 DSH 官方包（`@deepseek-ai/` 前缀）。 */
  official: boolean
  state: PluginState
}

export interface PluginInventory {
  /** 当前 profile 名；无法判定时为 null。 */
  profile: string | null
  /** profile 目录绝对路径；无法判定时为 null。 */
  profilePath: string | null
  /** 是否成功读到 package.json。 */
  available: boolean
  /** 读不到时的原因（供界面提示，不含敏感信息）。 */
  reason: string | null
  /** 已加载的插件数量（含运行时自带的官方包）。 */
  loadedCount: number
  /** 需要用户注意的条目数量：装了没启用、或非官方包声明加载却缺失。 */
  problemCount: number
  items: PluginEntry[]
}

/** 判定 profile 名所需的输入，显式传入以便单测（不直接读全局状态）。 */
export interface ProfileResolutionInput {
  env?: NodeJS.ProcessEnv
  argv?: readonly string[]
  homeDir?: string
}

/**
 * 解析当前 profile 名。
 *
 * 依次尝试：`DSH_PROFILE` 环境变量 → `--profile=<name>` → `--profile <name>`。
 * 都拿不到时返回 null（调用方不要猜，猜错会读到另一个 profile 的清单）。
 */
export function resolveProfileName(input: ProfileResolutionInput = {}): string | null {
  const env = input.env ?? process.env
  const argv = input.argv ?? process.argv

  const fromEnv = env.DSH_PROFILE?.trim()
  if (fromEnv) return fromEnv

  for (const arg of argv) {
    if (arg.startsWith('--profile=')) {
      const value = arg.slice('--profile='.length).trim()
      if (value) return value
    }
  }
  const index = argv.indexOf('--profile')
  if (index >= 0) {
    const value = argv[index + 1]?.trim()
    // 防止把下一个选项当成 profile 名（`--profile --port 3080`）。
    if (value && !value.startsWith('-')) return value
  }
  return null
}

/** 解析 `$DSH_HOME`，缺省为 `~/.dsh`。 */
export function resolveDshHome(input: ProfileResolutionInput = {}): string {
  const env = input.env ?? process.env
  const configured = env.DSH_HOME?.trim()
  if (configured) return configured
  return path.join(input.homeDir ?? os.homedir(), '.dsh')
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') out[key] = raw
  }
  return out
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/**
 * 读取插件清单。
 *
 * 任何读取失败都不抛异常，而是返回 `available: false` 与 `reason` ——
 * 一个只读的信息端点不该因为文件缺失就让整个请求 500，用户更需要看到「读不到，原因是什么」。
 */
export async function readPluginInventory(input: ProfileResolutionInput = {}): Promise<PluginInventory> {
  const profile = resolveProfileName(input)
  if (!profile) {
    return unavailable(null, null, 'PROFILE_UNKNOWN')
  }

  const dshHome = resolveDshHome(input)
  const profilePath = path.join(dshHome, 'profiles', profile)
  const manifest = await readJson(path.join(profilePath, 'package.json'))
  if (!manifest) return unavailable(profile, profilePath, 'MANIFEST_UNREADABLE')

  const dependencies = stringRecord(manifest.dependencies)
  const dshSection = typeof manifest.dsh === 'object' && manifest.dsh !== null
    ? (manifest.dsh as Record<string, unknown>)
    : {}
  const profileSection = typeof dshSection.profile === 'object' && dshSection.profile !== null
    ? (dshSection.profile as Record<string, unknown>)
    : {}
  const bundles = stringArray(profileSection.bundles)

  // 并集：dependencies 与 bundles 任一方出现的包都要列出来，否则「装了没启用」与
  // 「声明加载却缺失」这两种状态就看不到了。
  const names = [...new Set([...Object.keys(dependencies), ...bundles])].sort()

  const items: PluginEntry[] = []
  for (const name of names) {
    const installed = await readInstalledVersion(profilePath, name)
    const loaded = bundles.includes(name)
    const declared = dependencies[name] ?? null
    const official = name.startsWith('@deepseek-ai/')
    items.push({
      name,
      declared,
      installed,
      loaded,
      official,
      state: resolveState({ loaded, installed, official }),
    })
  }

  return {
    profile,
    profilePath,
    available: true,
    reason: null,
    loadedCount: items.filter((item) => item.loaded).length,
    // `runtime-provided` 是正常状态，不能计入问题项 —— 否则真实机器上会稳定报出 5 条假警报。
    problemCount: items.filter(
      (item) => item.state === 'declared-missing' || item.state === 'installed-not-loaded',
    ).length,
    items,
  }
}

/**
 * 判定条目状态。
 *
 * 顺序很重要：**先判「官方包 + 未落盘」**，否则它们会被判成 `declared-missing` ——
 * 这正是在真实机器上踩到的问题（5 个官方内核包一次性变成假警报）。
 */
export function resolveState(input: { loaded: boolean; installed: string | null; official: boolean }): PluginState {
  if (!input.loaded) return 'installed-not-loaded'
  if (input.installed) return 'loaded'
  if (input.official) return 'runtime-provided'
  return 'declared-missing'
}

/** 读 `node_modules/<name>/package.json` 的 version；包名含 scope 时要按路径展开。 */
async function readInstalledVersion(profilePath: string, packageName: string): Promise<string | null> {
  const modulePath = path.join(profilePath, 'node_modules', ...packageName.split('/'))
  const manifest = await readJson(path.join(modulePath, 'package.json'))
  const version = manifest?.version
  return typeof version === 'string' && version.trim() ? version : null
}

function unavailable(profile: string | null, profilePath: string | null, reason: string): PluginInventory {
  return {
    profile,
    profilePath,
    available: false,
    reason,
    loadedCount: 0,
    problemCount: 0,
    items: [],
  }
}
