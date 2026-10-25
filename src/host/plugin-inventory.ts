import { readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type {
  PluginEntry,
  PluginInventory,
  PluginState,
  PluginToggleResult,
} from '../shared/contracts.ts'

/**
 * 这四个类型**定义在 `src/shared/contracts.ts`**，不在这里。
 *
 * 原因：手机端的插件卡片要按 `state` 上色、按 `toggleable` 决定给不给启停按钮，
 * 浏览器半边必须能 import 它们；而 `client/` → `host/` 是明令禁止的依赖方向
 * （`docs/project/STRUCTURE.md`「禁止的依赖方向」）。共享层是唯一合法落点。
 *
 * 这里保留 re-export，是为了让 `src/host/router.ts` 与既有测试的 import 路径不变。
 */
export type { PluginEntry, PluginInventory, PluginState, PluginToggleResult }

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


/**
 * 读包清单时的并发上限。
 *
 * 为什么不是 `Promise.all` 全放：`names` 的长度由用户装了多少插件决定，
 * 理论上可以几十上百；一把放出去在慢盘/网络盘上反而更慢，而且失败时更难定位。
 * 6 与 `withUpdateCheck` 的网络并发同值，本仓已经验证过。
 */
const INVENTORY_READ_CONCURRENCY = 6



/** 判定 profile 名所需的输入，显式传入以便单测（不直接读全局状态）。 */
export interface ProfileResolutionInput {
  env?: NodeJS.ProcessEnv
  argv?: readonly string[]
  homeDir?: string
}

/**
 * 把 profile 标识归一化成 profile 名。
 *
 * 内核接受**两种**写法，两者都合法：
 *
 * - `--profile web` —— profile 名；
 * - `--profile /home/u/.dsh/profiles/web` —— profile 的绝对目录。内核启动器文档里
 *   写的正是 `--profile ${basename(profileDir)}`，**内核自己会取 basename**。
 *
 * 本插件此前只认第一种，于是把第二种的**整条路径**当成了 profile 名。而 `path.join`
 * 并不会因为后面一段是绝对路径就重置（那是 `path.resolve` 的行为），于是拼出：
 *
 *   /home/u/.dsh/profiles/home/u/.dsh/profiles/desktop
 *
 * —— 必然 ENOENT。**官方 Electron 桌面版恰好用第二种启动内核**，所以在桌面版里，
 * 手机上只会看到「服务器读不出插件清单：package.json 可能损坏、缺失或没有读取权限」，
 * 而磁盘上的 package.json 完好无损、权限也对。web 版（`dsh web` / `--profile web`）
 * 走的是名字形式，不受影响 —— 这就是这个 bug 能潜伏到桌面版才暴露的原因。
 *
 * 归一化只做一件事：**含路径分隔符时取最后一段**；不含则原样返回。于是
 * 「名字」「绝对目录」「相对目录」「Windows 反斜杠路径」「末尾带斜杠」五者同归一条规则。
 */
export function normalizeProfileName(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  // 不含分隔符：本来就是名字，原样用（`web`、`desktop`、`rescue`…）。
  if (!/[/\\]/.test(trimmed)) return trimmed
  // 含分隔符：按路径取最后一段。末尾分隔符先剥掉，`/profiles/web/` 也要得到 `web`。
  const withoutTrailing = trimmed.replace(/[/\\]+$/, '')
  if (withoutTrailing === '') return null
  const cut = Math.max(withoutTrailing.lastIndexOf('/'), withoutTrailing.lastIndexOf('\\'))
  const base = withoutTrailing.slice(cut + 1)
  return base === '' ? null : base
}

/**
 * 解析当前 profile 名。
 *
 * 依次尝试：`DSH_PROFILE` 环境变量 → `--profile=<name>` → `--profile <name>`
 * → **子命令简写**（`dsh web` 等价于 `dsh --profile web`）。
 * 都拿不到时返回 null（调用方不要猜，猜错会读到另一个 profile 的清单）。
 *
 * **四个取值来源一律过 `normalizeProfileName`**：它们都可能装着一个 profile 目录
 * 而不是名字（官方 Electron 桌面版就是），见该函数的说明。
 *
 * 最后那条简写路径是补上的一个真 bug：内核的启动器文档写得很清楚 ——
 *
 * > `dsh <name>` abbreviates `dsh --profile <name>`；`dsh web` boots the web
 * > profile (same as: `dsh --profile web`)
 *
 * 而此前这里只认 `--profile` 两种写法。于是**用 `dsh web` 启动的用户会看到
 * 「服务器判定不出当前使用的插件档案」** —— 明明 profile 就在那儿、插件也正常
 * 加载着，只有这个页面读不出来。这不是「用户没带参数」，是插件漏了一条启动形式。
 */
export function resolveProfileName(input: ProfileResolutionInput = {}): string | null {
  const env = input.env ?? process.env
  const argv = input.argv ?? process.argv

  const fromEnv = env.DSH_PROFILE?.trim()
  if (fromEnv) return normalizeProfileName(fromEnv)

  for (const arg of argv) {
    if (arg.startsWith('--profile=')) {
      const value = arg.slice('--profile='.length).trim()
      if (value) return normalizeProfileName(value)
    }
  }
  const index = argv.indexOf('--profile')
  if (index >= 0) {
    const value = argv[index + 1]?.trim()
    // 防止把下一个选项当成 profile 名（`--profile --port 3080`）。
    //
    // 取值非法时**直接返回 null，不再退回子命令简写**：用户明确写了 `--profile`
    // 只是写错了，这时候去猜「那大概是想用 web 吧」是在替用户做决定 ——
    // 而猜错的后果是读到另一个 profile 的清单，比老实报错更难排查。
    if (value && !value.startsWith('-')) return normalizeProfileName(value)
    return null
  }
  return profileFromSubcommand(argv)
}

/**
 * 从子命令简写里取 profile 名（`dsh web` → `web`）。
 *
 * 判据照抄内核启动器的解析规则：**跳过所有选项，第一个非选项 token 就是子命令**。
 * 需要绕开两类 token：
 *
 * - 选项本身（以 `-` 开头）—— 例如 `dsh --port 3080 web` 里要先跳过 `--port`；
 * - **选项的取值** —— 上面那个 `3080` 不是选项也不是子命令，只是 `--port` 的值。
 *   不跳它的话会把 `3080` 当成 profile 名。内核的选项都是「一个旗标接一个值」的
 *   单值形式（`--port 3080` / `--patch a.yml`），所以看到选项就把它的下一个 token
 *   一起跳过，是安全的。
 *
 * `plugin` 单独排除：`dsh plugin add xxx` 是管理插件依赖的命令，
 * 它**不启动任何 profile**，把它当 profile 名会去读一个不存在的目录。
 *
 * 取到的 token 同样过 `normalizeProfileName`：桌面版可能把这个位置填成 profile
 * 目录的绝对路径（`--profile <dir>` 的等价位置参数写法）。
 */
function profileFromSubcommand(argv: readonly string[]): string | null {
  const start = argv.findIndex((arg) => /(^|[/\\])dsh(\.js|\.cjs|\.mjs)?$/.test(arg))
  let i = start >= 0 ? start + 1 : 0
  while (i < argv.length) {
    const arg = argv[i]
    if (arg === undefined || arg === '') {
      i += 1
      continue
    }
    if (arg.startsWith('-')) {
      // `--flag=value` 自带取值；`--flag value` 要连值一起跳。
      i += arg.includes('=') ? 1 : 2
      continue
    }
    // 第一个真正的非选项 token：这就是子命令。
    return arg === 'plugin' ? null : normalizeProfileName(arg)
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

  // **受控并发**：修复前对每个包串行 `readFile(package.json)` —— 十几二十个包
  // 就是十几二十次连续的小文件读。单次很快（毫秒级），但串起来会让「打开插件页」
  // 多出一次可感知的等待，而它们之间**毫无依赖**。
  //
  // 并发 6 直接复用本文件 `withUpdateCheck` 已经用过、也验证过的量级
  // （见下方 `workers` 那段）：网络请求是 6，本地小文件读更保守没有坏处。
  //
  // 注意：结果必须按 `names` 的原顺序拼回（`Promise.all` 保序，所以直接用）。
  const items: PluginEntry[] = []
  const manifests = new Map<string, Record<string, unknown> | null>()
  for (let offset = 0; offset < names.length; offset += INVENTORY_READ_CONCURRENCY) {
    const batch = names.slice(offset, offset + INVENTORY_READ_CONCURRENCY)
    const rows = await Promise.all(batch.map(async (name) => ({
      name,
      manifest: await readPackageManifest(profilePath, name),
    })))
    for (const row of rows) manifests.set(row.name, row.manifest)
  }
  for (const name of names) {
    const pkgManifest = manifests.get(name) ?? null
    const installedRaw = pkgManifest?.version
    const installed = typeof installedRaw === 'string' && installedRaw.trim() ? installedRaw : null
    const loaded = bundles.includes(name)
    const declared = dependencies[name] ?? null
    const official = name.startsWith('@deepseek-ai/')
    const description = typeof pkgManifest?.description === 'string' && pkgManifest.description.trim()
      ? pkgManifest.description.trim()
      : null
    items.push({
      name,
      declared,
      installed,
      loaded,
      official,
      state: resolveState({ loaded, installed, official }),
      description,
      homepage: readHomepage(pkgManifest),
      // 默认不查更新：查一次要给每个包发一个 registry 请求，十几二十个包的清单
      // 会从「毫秒级」变成「好几秒」。要查的话由调用方显式开（见 checkUpdates），
      // 那时只对**真的装在 profile 里**的包查，官方包与缺失包没必要问。
      updateAvailable: null,
      latestVersion: null,
      // 官方包动不了；没装进 profile 的包也不该在手机上「启用」（那该走安装流程）。
      toggleable: !official && installed !== null,
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
 * 查 npm registry 上的最新版本（可选功能，默认不开）。
 *
 * 为什么默认关：每个包一次 HTTP 请求，清单会从毫秒级变成好几秒，而用户点进
 * 「插件」页十次里九次只是想看看「装了啥、哪个没启用」。要查更新得显式开。
 *
 * 两个刻意的取舍：
 * - **超时短**（5 秒）：一个包查不动不该拖住整张清单，超时就当「查不到」。
 * - **失败即 null**，不重试：这是锦上添花的信息，为了它排队重试不值当。
 *   界面拿到 null 会说「未检查」，而不是谎称「已是最新」。
 */
async function fetchLatestVersion(packageName: string): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5_000)
  try {
    const response = await fetch(`https://registry.npmjs.org/${packageName.replace('/', '%2F')}/latest`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return null
    const body = (await response.json()) as { version?: unknown }
    return typeof body.version === 'string' && body.version.trim() ? body.version.trim() : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 给清单里的插件补上「有没有新版本」。
 *
 * 只查**确实装在 profile 里**的第三方包：官方包随运行时发布、用户装不了（查了也没用），
 * 缺失包连本地版本都没有（无从比较）。
 *
 * 并发度限制在 6：十几个包全放出去对 registry 不礼貌，也容易触发限流 ——
 * 而限流之后拿到的 null 会被界面显示成「未检查」，白跑一趟。
 */
export async function withUpdateCheck(inventory: PluginInventory): Promise<PluginInventory> {
  const targets = inventory.items.filter((item) => !item.official && item.installed !== null)
  const latest = new Map<string, string | null>()
  const queue = [...targets]
  const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift()
      if (next === undefined) return
      latest.set(next.name, await fetchLatestVersion(next.name))
    }
  })
  await Promise.all(workers)

  return {
    ...inventory,
    items: inventory.items.map((item) => {
      if (!latest.has(item.name)) return item
      const newest = latest.get(item.name) ?? null
      return {
        ...item,
        latestVersion: newest,
        // `newest` 为 null（查不到）时保持 updateAvailable = null，不谎报「已是最新」。
        updateAvailable: newest === null || item.installed === null ? null : newest !== item.installed,
      }
    }),
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
  const manifest = await readPackageManifest(profilePath, packageName)
  const version = manifest?.version
  return typeof version === 'string' && version.trim() ? version : null
}

/**
 * 读 `node_modules/<name>/package.json` 的整份内容。
 *
 * 读不到就返回 null（包没装、或装了一半）。刻意不抛：这是展示用的元数据，
 * 某个包读不出来不该让整张清单失败。
 */
async function readPackageManifest(
  profilePath: string,
  packageName: string,
): Promise<Record<string, unknown> | null> {
  const modulePath = path.join(profilePath, 'node_modules', ...packageName.split('/'))
  return readJson(path.join(modulePath, 'package.json'))
}

/**
 * 从 package.json 里取一个人类可读的主页地址。
 *
 * 三种写法都见过：`homepage` 是字符串、`repository` 是字符串、`repository` 是
 * `{ type, url }` 对象。GitHub 那种 `git+https://…git` 前缀与 `.git` 后缀要剥掉，
 * 否则直接点开是个 git 协议地址，浏览器打不开。
 */
function readHomepage(manifest: Record<string, unknown> | null): string | null {
  if (!manifest) return null
  const raw = typeof manifest.homepage === 'string'
    ? manifest.homepage
    : (() => {
        const repo = manifest.repository
        if (typeof repo === 'string') return repo
        if (typeof repo === 'object' && repo !== null) {
          const url = (repo as Record<string, unknown>).url
          if (typeof url === 'string') return url
        }
        return null
      })()
  if (!raw) return null
  const cleaned = raw.trim().replace(/^git\+/, '').replace(/\.git$/, '')
  return cleaned.startsWith('http') ? cleaned : null
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

/**
 * 启用 / 停用插件（「插件」页的写操作）。
 *
 * ## 为什么不是调 `dsh plugin`
 *
 * `dsh plugin <anything>` 会**原样转发给 pnpm**。实测踩过一次：本想查
 * `dsh plugin enable --help`，结果 pnpm 直接进入安装流程（打出 `Packages: +4 -85`）——
 * 它在**动依赖树**。启用/停用插件根本不需要碰依赖（包已经在 `node_modules` 里了），
 * 走 pnpm 等于为了挪一个字符串去重算整棵依赖，风险与收益完全不成比例。
 *
 * ## 真正该改的是什么
 *
 * 只改 **`dsh.profile.bundles` 数组**。内核源码注释写明：
 *
 * > stack its patch layers (bundle layers in `dsh.profile.bundles` order …)
 *
 * 也就是说这个数组**就是加载清单，且顺序即加载顺序**。加一个名字 = 启用，
 * 删一个名字 = 停用。依赖声明（`dependencies`）原封不动 —— 包仍在磁盘上，
 * 随时可以再启用，不必重新下载。
 *
 * ## 三道安全阀
 *
 * 1. **拒绝改官方包**（`@deepseek-ai/` 前缀）：它们随 DSH 主包安装、不由 profile 管理，
 *    改了 bundles 也加载不出来，反而把清单搞成与实际不符。
 * 2. **写前必备份**：`package.json.bak-<时间戳>` 落在同目录。profile 的 package.json
 *    一旦写坏，dsh 下次**起不来**，而用户此刻在手机上、够不着电脑 —— 备份是唯一退路。
 * 3. **先写临时文件再 rename**：`rename` 在同分区是原子的。直接写原文件的话，
 *    写到一半断电/被杀会留下一个残缺的 JSON，后果同上。
 *
 * ## 必须重启才生效
 *
 * bundles 只在**启动时**读一次。改了文件不等于改了运行中的进程 —— 这一点会原样
 * 回给调用方（`restartRequired: true`），由界面明确告诉用户，别让人以为点了没反应。
 */

export class PluginToggleError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'PluginToggleError'
  }
}

/** 包名合法性白名单：npm 包名允许的字符集，外加 scope 的 `/`。 */
const PACKAGE_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i

/**
 * 启用（`enable=true`）或停用（`enable=false`）一个插件。
 *
 * @throws PluginToggleError 带着稳定的 `code`，供路由层映射成 HTTP 状态与错误码。
 */
export async function togglePlugin(
  name: string,
  enable: boolean,
  input: ProfileResolutionInput = {},
): Promise<PluginToggleResult> {
  const trimmed = name.trim()
  // 先做形状校验再碰文件系统：包名会参与拼路径，脏输入不该有机会走到 path.join。
  if (!PACKAGE_NAME.test(trimmed)) {
    throw new PluginToggleError('PLUGIN_NAME_INVALID', `Not a valid package name: ${name}`)
  }
  if (trimmed.startsWith('@deepseek-ai/')) {
    throw new PluginToggleError(
      'PLUGIN_OFFICIAL_IMMUTABLE',
      'Official DSH packages ship with the runtime and are not managed by the profile.',
    )
  }

  const profile = resolveProfileName(input)
  if (!profile) throw new PluginToggleError('PROFILE_UNKNOWN', 'Cannot determine the active profile.')

  const profilePath = path.join(resolveDshHome(input), 'profiles', profile)
  const manifestPath = path.join(profilePath, 'package.json')
  const raw = await readFile(manifestPath, 'utf8').catch(() => null)
  if (raw === null) {
    // 不回显 `manifestPath`：这条 message 会被 router 的顶层 catch 原样写进响应体，
    // 而绝对路径会泄露部署方的用户名与目录结构（AGENTS.md「系统错误不回显绝对路径」）。
    // 定位靠 code + profile 名：profile 是用户自己起的名字，不构成信息泄露。
    throw new PluginToggleError(
      'MANIFEST_UNREADABLE',
      `Cannot read the manifest of profile "${profile}".`,
    )
  }

  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw new PluginToggleError('MANIFEST_UNREADABLE', 'The profile manifest is not valid JSON.')
  }

  const dependencies = stringRecord(manifest.dependencies)
  const dshSection = typeof manifest.dsh === 'object' && manifest.dsh !== null
    ? (manifest.dsh as Record<string, unknown>)
    : {}
  const profileSection = typeof dshSection.profile === 'object' && dshSection.profile !== null
    ? (dshSection.profile as Record<string, unknown>)
    : {}
  const bundles = stringArray(profileSection.bundles)

  if (enable && dependencies[trimmed] === undefined && !bundles.includes(trimmed)) {
    // 启用一个 profile 里根本没有的包，会得到一个「声明加载但找不到」的条目，
    // 而用户看到的现象是「打不开的那个页面/插件没了」—— 说不清是哪一步错了。
    // 这种情况该走「安装」，不该走「启用」，所以在入口拦下。
    throw new PluginToggleError(
      'PLUGIN_NOT_INSTALLED',
      'This package is not installed in the profile; install it first.',
    )
  }

  const next = enable
    ? (bundles.includes(trimmed) ? bundles : [...bundles, trimmed])
    : bundles.filter((item) => item !== trimmed)

  if (next.length === bundles.length) {
    // 幂等：本来就是目标状态，不动文件、不产生备份 —— 重复点不该在磁盘上堆一串备份。
    return {
      name: trimmed,
      loaded: enable,
      backupName: '',
      bundleCount: bundles.length,
      restartRequired: true,
    }
  }

  const backupName = `package.json.bak-${timestamp()}`
  await writeFile(path.join(profilePath, backupName), raw, { mode: 0o600 })

  profileSection.bundles = next
  dshSection.profile = profileSection
  manifest.dsh = dshSection
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`

  // 先写临时文件再 rename：同分区 rename 是原子的，避免留下写到一半的 JSON。
  const tempPath = path.join(profilePath, `.package.json.tmp-${process.pid}`)
  await writeFile(tempPath, serialized, { mode: 0o600 })
  await rename(tempPath, manifestPath)

  return {
    name: trimmed,
    loaded: enable,
    backupName,
    bundleCount: next.length,
    restartRequired: true,
  }
}

/** 备份文件名用的时间戳：`20261013-133045`，本地时区、可直接读。 */
function timestamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
