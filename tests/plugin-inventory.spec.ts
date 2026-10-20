import {mkdir, mkdtemp, writeFile} from 'node:fs/promises'
import { TestCleanup } from './test-cleanup.ts'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readPluginInventory,
  resolveDshHome,
  resolveProfileName,
  togglePlugin,
} from '../src/host/plugin-inventory.ts'

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

async function makeProfile(options: {
  profile?: string
  dependencies?: Record<string, string>
  bundles?: string[]
  installed?: Record<string, string>
} = {}): Promise<{ dshHome: string; profile: string }> {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'daw-plugins-'))
  cleanup.dir(dshHome)
  const profile = options.profile ?? 'web'
  const profilePath = path.join(dshHome, 'profiles', profile)
  await mkdir(profilePath, { recursive: true })
  await writeFile(
    path.join(profilePath, 'package.json'),
    JSON.stringify({
      name: `dsh-profile-${profile}`,
      private: true,
      dependencies: options.dependencies ?? {},
      dsh: { profile: { bundles: options.bundles ?? [] } },
    }),
  )
  for (const [name, version] of Object.entries(options.installed ?? {})) {
    const modulePath = path.join(profilePath, 'node_modules', ...name.split('/'))
    await mkdir(modulePath, { recursive: true })
    await writeFile(path.join(modulePath, 'package.json'), JSON.stringify({ name, version }))
  }
  return { dshHome, profile }
}

describe('resolveProfileName', () => {
  it('prefers the DSH_PROFILE environment variable', () => {
    expect(resolveProfileName({ env: { DSH_PROFILE: 'desktop' }, argv: ['node', 'dsh', '--profile=web'] }))
      .toBe('desktop')
  })

  it('reads --profile=<name>', () => {
    expect(resolveProfileName({ env: {}, argv: ['node', 'dsh', '--profile=web'] })).toBe('web')
  })

  it('reads the separate --profile <name> form', () => {
    expect(resolveProfileName({ env: {}, argv: ['node', 'dsh', '--profile', 'rescue'] })).toBe('rescue')
  })

  it('does not mistake the next option for a profile name', () => {
    // `--profile --port 3080` 不能把 `--port` 当 profile 名，否则会去读一个不存在的 profile。
    expect(resolveProfileName({ env: {}, argv: ['node', 'dsh', '--profile', '--port', '3080'] })).toBeNull()
  })

  it('returns null when nothing indicates a profile', () => {
    expect(resolveProfileName({ env: {}, argv: ['node', 'dsh', '--port', '3080'] })).toBeNull()
  })

  it('ignores a blank environment value', () => {
    expect(resolveProfileName({ env: { DSH_PROFILE: '   ' }, argv: [] })).toBeNull()
  })

  // ── 子命令简写 `dsh <name>` ≡ `dsh --profile <name>` ──
  //
  // 这组是一条真 bug 的回归防护：内核启动器文档写明 `dsh web` 等价于
  // `dsh --profile web`，而此前只认 `--profile` 两种写法 —— 于是**用 `dsh web`
  // 启动的用户会看到「服务器判定不出当前使用的插件档案」**，明明 profile 就在那儿。
  // 出问题的机器上实测 argv 就是 `['node', '/usr/local/nodejs/bin/dsh', 'web']`。

  it('reads the profile from the `dsh <name>` subcommand shorthand', () => {
    expect(resolveProfileName({ env: {}, argv: ['node', '/usr/local/nodejs/bin/dsh', 'web'] })).toBe('web')
  })

  it('reads the shorthand even with a bare `dsh` token', () => {
    expect(resolveProfileName({ env: {}, argv: ['node', 'dsh', 'rescue'] })).toBe('rescue')
  })

  it('skips launcher flags before the subcommand', () => {
    // `dsh --port 3080 web`：要跳过 `--port` **和它的取值** `3080`，
    // 否则会把 `3080` 当成 profile 名，去读一个叫 “3080” 的目录。
    expect(resolveProfileName({ env: {}, argv: ['node', 'dsh', '--port', '3080', 'web'] })).toBe('web')
  })

  it('skips `--flag=value` before the subcommand', () => {
    expect(resolveProfileName({ env: {}, argv: ['node', 'dsh', '--patch=a.yml', 'web'] })).toBe('web')
  })

  it('does not treat the `plugin` subcommand as a profile', () => {
    // `dsh plugin add xxx` 管理依赖、**不启动 profile**，把它当 profile 名
    // 会去读一个不存在的目录，比返回 null 更糟（null 至少会老实报错）。
    expect(resolveProfileName({ env: {}, argv: ['node', 'dsh', 'plugin', 'add', 'foo'] })).toBeNull()
  })

  it('lets an explicit --profile win over the subcommand', () => {
    // 显式旗标永远优先：内核允许 `dsh --profile tui --resume abc` 这种写法。
    expect(resolveProfileName({ env: {}, argv: ['node', 'dsh', '--profile', 'tui', 'web'] })).toBe('tui')
  })

  // ── profile 目录当参数：官方 Electron 桌面版的启动形式 ──
  //
  // 这条是桌面版线上回归的防护。内核接受 `--profile <profileDir>` 并**自己取
  // basename**（启动器文档：`--profile ${basename(profileDir)}`），而插件此前把整条
  // 路径当 profile 名用。`path.join` 不会因后段是绝对路径而重置，于是拼出
  // `<dshHome>/profiles/home/u/.dsh/profiles/desktop` —— 必然 ENOENT，
  // 手机端表现就是「服务器读不出插件清单」，而磁盘上一切正常。
  //
  // 出问题的机器上实测响应：profile 字段 = `/home/wangke/.dsh/profiles/desktop`，
  // profilePath = `/home/wangke/.dsh/profiles/home/wangke/.dsh/profiles/desktop`。

  it('normalizes a profile directory into its name (desktop launcher form)', () => {
    const dir = '/home/u/.dsh/profiles/desktop'
    expect(resolveProfileName({ env: {}, argv: ['node', 'dsh', '--profile', dir] })).toBe('desktop')
    expect(resolveProfileName({ env: {}, argv: ['node', 'dsh', `--profile=${dir}`] })).toBe('desktop')
    expect(resolveProfileName({ env: { DSH_PROFILE: dir }, argv: [] })).toBe('desktop')
  })

  it('normalizes profile directories in the subcommand and on Windows', () => {
    // 子命令位置也可能被填成目录；Windows 路径用反斜杠。
    expect(resolveProfileName({ env: {}, argv: ['node', '/usr/local/bin/dsh', '/home/u/.dsh/profiles/web'] }))
      .toBe('web')
    expect(resolveProfileName({ env: { DSH_PROFILE: 'C:\\Users\\u\\.dsh\\profiles\\desktop' }, argv: [] }))
      .toBe('desktop')
  })

  it('tolerates a trailing separator and relative forms', () => {
    expect(resolveProfileName({ env: { DSH_PROFILE: '/home/u/.dsh/profiles/web/' }, argv: [] })).toBe('web')
    expect(resolveProfileName({ env: { DSH_PROFILE: 'profiles/web' }, argv: [] })).toBe('web')
  })

  it('returns null for a path with no usable last segment', () => {
    // `/` 归一化后没有名字：宁可老实报「判定不出」，也不去读一个叫 “” 的目录。
    expect(resolveProfileName({ env: { DSH_PROFILE: '/' }, argv: [] })).toBeNull()
  })

  it('still treats a bare name as-is (no regression on web form)', () => {
    expect(resolveProfileName({ env: { DSH_PROFILE: 'desktop' }, argv: [] })).toBe('desktop')
    expect(resolveProfileName({ env: {}, argv: ['node', 'dsh', 'web'] })).toBe('web')
  })
})

describe('resolveDshHome', () => {
  it('prefers DSH_HOME', () => {
    expect(resolveDshHome({ env: { DSH_HOME: '/srv/dsh' }, homeDir: '/home/u' })).toBe('/srv/dsh')
  })

  it('falls back to <home>/.dsh', () => {
    expect(resolveDshHome({ env: {}, homeDir: '/home/u' })).toBe(path.join('/home/u', '.dsh'))
  })
})

describe('readPluginInventory', () => {
  it('classifies loaded, installed-not-loaded and declared-missing', async () => {
    const { dshHome, profile } = await makeProfile({
      dependencies: {
        'dsh-ffmpeg': '^0.4.5',
        'dsh-remotion': '^0.3.4',
        'dsh-workspace': 'file:/tmp/x.tgz',
      },
      bundles: ['dsh-ffmpeg', 'dsh-workspace', 'dsh-ghost'],
      installed: {
        'dsh-ffmpeg': '0.4.7',
        'dsh-remotion': '0.3.4',
        'dsh-workspace': '1.0.0',
      },
    })

    const inventory = await readPluginInventory({ env: { DSH_HOME: dshHome, DSH_PROFILE: profile }, argv: [] })

    expect(inventory.available).toBe(true)
    expect(inventory.profile).toBe('web')
    expect(inventory.profilePath).toBe(path.join(dshHome, 'profiles', 'web'))

    const byName = Object.fromEntries(inventory.items.map((item) => [item.name, item]))

    // 声明加载 + 存在 → loaded，且 installed 是真实版本而不是依赖声明里的范围。
    expect(byName['dsh-ffmpeg']).toMatchObject({ state: 'loaded', declared: '^0.4.5', installed: '0.4.7', loaded: true })

    // 装了但不在 bundles 里 → installed-not-loaded。
    expect(byName['dsh-remotion']).toMatchObject({ state: 'installed-not-loaded', loaded: false, installed: '0.3.4' })

    // 声明加载但 node_modules 里没有 → declared-missing。
    expect(byName['dsh-ghost']).toMatchObject({ state: 'declared-missing', loaded: true, installed: null, declared: null })

    // bundles 里有三项（ffmpeg / workspace / ghost），ghost 虽然缺失仍计入「声明要加载」。
    expect(inventory.loadedCount).toBe(3)
    // remotion（未加载）与 ghost（缺失）都算需要用户注意的问题项。
    expect(inventory.problemCount).toBe(2)
  })

  it('expands scoped package names when reading installed versions', async () => {
    const { dshHome, profile } = await makeProfile({
      dependencies: { '@deepseek-ai/dsh-base': '0.2.0-rc.2' },
      bundles: ['@deepseek-ai/dsh-base'],
      installed: { '@deepseek-ai/dsh-base': '0.2.0-rc.2' },
    })

    const inventory = await readPluginInventory({ env: { DSH_HOME: dshHome, DSH_PROFILE: profile }, argv: [] })
    const entry = inventory.items.find((item) => item.name === '@deepseek-ai/dsh-base')

    expect(entry).toMatchObject({ installed: '0.2.0-rc.2', state: 'loaded', official: true })
  })

  it('treats an official bundle without node_modules as runtime-provided, not missing', async () => {
    // 真实机器上的回归：官方内核包随 DSH 主包安装，**不会**出现在 profile 的 node_modules 下。
    // 早期实现把它们判成 declared-missing，一次性产生 5 条假警报。
    const { dshHome, profile } = await makeProfile({
      dependencies: {},
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      installed: {},
    })

    const inventory = await readPluginInventory({ env: { DSH_HOME: dshHome, DSH_PROFILE: profile }, argv: [] })

    for (const item of inventory.items) {
      expect(item).toMatchObject({ state: 'runtime-provided', official: true, installed: null })
    }
    expect(inventory.problemCount).toBe(0)
    expect(inventory.loadedCount).toBe(2)
  })

  it('still reports a non-official bundle that is genuinely missing', async () => {
    const { dshHome, profile } = await makeProfile({
      dependencies: {},
      bundles: ['dsh-someone-elses-plugin'],
      installed: {},
    })

    const inventory = await readPluginInventory({ env: { DSH_HOME: dshHome, DSH_PROFILE: profile }, argv: [] })
    expect(inventory.items[0]).toMatchObject({ state: 'declared-missing', official: false })
    expect(inventory.problemCount).toBe(1)
  })

  it('marks non-official packages as unofficial', async () => {
    const { dshHome, profile } = await makeProfile({
      dependencies: { 'dsh-ffmpeg': '0.4.5' },
      bundles: ['dsh-ffmpeg'],
      installed: { 'dsh-ffmpeg': '0.4.5' },
    })

    const inventory = await readPluginInventory({ env: { DSH_HOME: dshHome, DSH_PROFILE: profile }, argv: [] })
    expect(inventory.items[0]?.official).toBe(false)
  })

  it('sorts items by name for a stable UI', async () => {
    const { dshHome, profile } = await makeProfile({
      dependencies: { zebra: '1.0.0', alpha: '1.0.0', middle: '1.0.0' },
      bundled: undefined,
      bundles: [],
      installed: {},
    } as never)

    const inventory = await readPluginInventory({ env: { DSH_HOME: dshHome, DSH_PROFILE: profile }, argv: [] })
    expect(inventory.items.map((item) => item.name)).toEqual(['alpha', 'middle', 'zebra'])
  })

  it('reports PROFILE_UNKNOWN instead of guessing a profile', async () => {
    const inventory = await readPluginInventory({ env: {}, argv: [] })
    expect(inventory).toMatchObject({ available: false, reason: 'PROFILE_UNKNOWN', profile: null, items: [] })
  })

  it('reads the manifest when the launcher passes a profile directory', async () => {
    // 桌面版线上回归的端到端复现：只需把 profile 参数从名字换成目录，
    // 修复前必然得到 available:false + MANIFEST_UNREADABLE（磁盘上文件其实好好的）。
    const { dshHome, profile } = await makeProfile({
      dependencies: { 'dsh-ffmpeg': '0.4.5' },
      bundles: ['dsh-ffmpeg'],
      installed: { 'dsh-ffmpeg': '0.4.5' },
    })
    const profileDir = path.join(dshHome, 'profiles', profile)

    const inventory = await readPluginInventory({
      env: { DSH_HOME: dshHome },
      argv: ['node', '/usr/local/nodejs/bin/dsh', '--profile', profileDir],
    })

    expect(inventory.available).toBe(true)
    expect(inventory.profile).toBe(profile)
    expect(inventory.profilePath).toBe(profileDir)
    expect(inventory.loadedCount).toBe(1)
  })

  it('reads the manifest when DSH_PROFILE carries a directory', async () => {
    // 同一个坑的另一条入口：环境变量里放的是目录而不是名字。
    const { dshHome, profile } = await makeProfile({ bundles: ['dsh-ffmpeg'] })
    const inventory = await readPluginInventory({
      env: { DSH_HOME: dshHome, DSH_PROFILE: path.join(dshHome, 'profiles', profile) },
      argv: [],
    })

    expect(inventory.available).toBe(true)
    expect(inventory.profile).toBe(profile)
  })

  it('reports MANIFEST_UNREADABLE when the profile has no package.json', async () => {
    const dshHome = await mkdtemp(path.join(os.tmpdir(), 'daw-plugins-'))
    cleanup.dir(dshHome)
    const inventory = await readPluginInventory({ env: { DSH_HOME: dshHome, DSH_PROFILE: 'web' }, argv: [] })

    expect(inventory).toMatchObject({ available: false, reason: 'MANIFEST_UNREADABLE', profile: 'web' })
    expect(inventory.items).toEqual([])
  })

  it('survives a malformed manifest without throwing', async () => {
    const dshHome = await mkdtemp(path.join(os.tmpdir(), 'daw-plugins-'))
    cleanup.dir(dshHome)
    const profilePath = path.join(dshHome, 'profiles', 'web')
    await mkdir(profilePath, { recursive: true })
    await writeFile(path.join(profilePath, 'package.json'), '{ this is not json')

    const inventory = await readPluginInventory({ env: { DSH_HOME: dshHome, DSH_PROFILE: 'web' }, argv: [] })
    expect(inventory.available).toBe(false)
    expect(inventory.reason).toBe('MANIFEST_UNREADABLE')
  })

  it('tolerates a manifest without a dsh.profile.bundles section', async () => {
    const dshHome = await mkdtemp(path.join(os.tmpdir(), 'daw-plugins-'))
    cleanup.dir(dshHome)
    const profilePath = path.join(dshHome, 'profiles', 'web')
    await mkdir(profilePath, { recursive: true })
    await writeFile(path.join(profilePath, 'package.json'), JSON.stringify({ dependencies: { a: '1.0.0' } }))

    const inventory = await readPluginInventory({ env: { DSH_HOME: dshHome, DSH_PROFILE: 'web' }, argv: [] })
    expect(inventory.available).toBe(true)
    expect(inventory.items[0]).toMatchObject({ name: 'a', loaded: false, state: 'installed-not-loaded' })
  })

  it('never leaks file contents beyond name, version and state', async () => {
    const { dshHome, profile } = await makeProfile({
      dependencies: { 'dsh-ffmpeg': '0.4.5' },
      bundles: ['dsh-ffmpeg'],
      installed: { 'dsh-ffmpeg': '0.4.5' },
    })
    const inventory = await readPluginInventory({ env: { DSH_HOME: dshHome, DSH_PROFILE: profile }, argv: [] })

    // 返回字段被限制在已知集合内，避免将来有人顺手把整个 manifest 塞进去。
    //
    // v2.3.2 扩了详情字段（description / homepage / updateAvailable / latestVersion /
    // toggleable），都是**展示用**的固定几项、不转发 manifest 原文 —— 白名单照旧成立，
    // 这里同步登记，防止下次有人「顺手」再加一个字段而不更新这条边界。
    for (const item of inventory.items) {
      expect(Object.keys(item).sort()).toEqual([
        'declared', 'description', 'homepage', 'installed', 'latestVersion',
        'loaded', 'name', 'official', 'state', 'toggleable', 'updateAvailable',
      ])
    }
    expect(Object.keys(inventory).sort()).toEqual([
      'available', 'items', 'loadedCount', 'problemCount', 'profile', 'profilePath', 'reason',
    ])
  })
})

describe('togglePlugin', () => {
  /** 读回 profile 的 package.json，方便断言磁盘上的真实状态。 */
  async function readManifest(dshHome: string, profile: string): Promise<Record<string, unknown>> {
    const { readFile } = await import('node:fs/promises')
    const raw = await readFile(path.join(dshHome, 'profiles', profile, 'package.json'), 'utf8')
    return JSON.parse(raw) as Record<string, unknown>
  }

  function bundlesOf(manifest: Record<string, unknown>): string[] {
    const dsh = manifest.dsh as { profile?: { bundles?: string[] } } | undefined
    return dsh?.profile?.bundles ?? []
  }

  it('enables a plugin by appending it to bundles', async () => {
    const { dshHome, profile } = await makeProfile({
      dependencies: { 'dsh-ffmpeg': '0.4.5' },
      bundles: [],
      installed: { 'dsh-ffmpeg': '0.4.5' },
    })
    const result = await togglePlugin('dsh-ffmpeg', true, { env: { DSH_HOME: dshHome, DSH_PROFILE: profile }, argv: [] })

    expect(result.loaded).toBe(true)
    expect(result.restartRequired).toBe(true)
    expect(result.bundleCount).toBe(1)
    expect(bundlesOf(await readManifest(dshHome, profile))).toEqual(['dsh-ffmpeg'])
  })

  it('disables a plugin by removing it from bundles', async () => {
    const { dshHome, profile } = await makeProfile({
      dependencies: { 'dsh-ffmpeg': '0.4.5' },
      bundles: ['dsh-ffmpeg', 'dsh-vision-router'],
      installed: { 'dsh-ffmpeg': '0.4.5' },
    })
    await togglePlugin('dsh-ffmpeg', false, { env: { DSH_HOME: dshHome, DSH_PROFILE: profile }, argv: [] })

    // 关键：只摘名字，**别的 bundle 与依赖声明一律不动**（顺序也是加载顺序）。
    const manifest = await readManifest(dshHome, profile)
    expect(bundlesOf(manifest)).toEqual(['dsh-vision-router'])
    expect((manifest.dependencies as Record<string, string>)['dsh-ffmpeg']).toBe('0.4.5')
  })

  it('writes a backup before touching the manifest', async () => {
    const { dshHome, profile } = await makeProfile({
      dependencies: { 'dsh-ffmpeg': '0.4.5' },
      bundles: [],
      installed: { 'dsh-ffmpeg': '0.4.5' },
    })
    const result = await togglePlugin('dsh-ffmpeg', true, { env: { DSH_HOME: dshHome, DSH_PROFILE: profile }, argv: [] })

    // 备份是唯一退路：package.json 写坏了 dsh 下次起不来，而用户此刻在手机上。
    expect(result.backupName).not.toBe('')
    const { readFile } = await import('node:fs/promises')
    const backup = await readFile(path.join(dshHome, 'profiles', profile, result.backupName), 'utf8')
    expect(JSON.parse(backup).dsh.profile.bundles).toEqual([])
  })

  it('is idempotent and does not pile up backups', async () => {
    const { dshHome, profile } = await makeProfile({
      dependencies: { 'dsh-ffmpeg': '0.4.5' },
      bundles: ['dsh-ffmpeg'],
      installed: { 'dsh-ffmpeg': '0.4.5' },
    })
    const result = await togglePlugin('dsh-ffmpeg', true, { env: { DSH_HOME: dshHome, DSH_PROFILE: profile }, argv: [] })

    // 本来就是目标状态：不动文件、不产生备份 —— 重复点不该在磁盘上堆一串备份。
    expect(result.backupName).toBe('')
    const { readdir } = await import('node:fs/promises')
    const files = await readdir(path.join(dshHome, 'profiles', profile))
    expect(files.filter((f) => f.startsWith('package.json.bak-'))).toEqual([])
  })

  it('refuses to toggle official packages', async () => {
    const { dshHome, profile } = await makeProfile({ bundles: ['@deepseek-ai/dsh-base'] })
    await expect(
      togglePlugin('@deepseek-ai/dsh-base', false, { env: { DSH_HOME: dshHome, DSH_PROFILE: profile }, argv: [] }),
    ).rejects.toMatchObject({ code: 'PLUGIN_OFFICIAL_IMMUTABLE' })
  })

  it('refuses a package that is not installed in the profile', async () => {
    const { dshHome, profile } = await makeProfile({ bundles: [] })
    // 启用一个不存在的包会得到「声明加载却找不到」，而用户看到的是「插件没了」，
    // 说不清哪一步错了 —— 该走安装流程，不该在入口放过去。
    await expect(
      togglePlugin('dsh-nonexistent', true, { env: { DSH_HOME: dshHome, DSH_PROFILE: profile }, argv: [] }),
    ).rejects.toMatchObject({ code: 'PLUGIN_NOT_INSTALLED' })
  })

  it('rejects malformed package names before touching the filesystem', async () => {
    const { dshHome, profile } = await makeProfile({ bundles: [] })
    for (const bad of ['../evil', 'a b', '', 'x/y/z']) {
      await expect(
        togglePlugin(bad, true, { env: { DSH_HOME: dshHome, DSH_PROFILE: profile }, argv: [] }),
      ).rejects.toMatchObject({ code: 'PLUGIN_NAME_INVALID' })
    }
  })

  it('writes the right manifest when the launcher passes a profile directory', async () => {
    // 写操作和读操作共用同一个 profile 判定：读不到的那个 bug 同样会让「启停」
    // 把 package.json 写到一个不存在的多层目录上去。手机上点「启用」只会报错。
    const { dshHome, profile } = await makeProfile({
      dependencies: { 'dsh-ffmpeg': '0.4.5' },
      bundles: [],
      installed: { 'dsh-ffmpeg': '0.4.5' },
    })

    await togglePlugin('dsh-ffmpeg', true, {
      env: { DSH_HOME: dshHome },
      argv: ['node', 'dsh', '--profile', path.join(dshHome, 'profiles', profile)],
    })

    expect(bundlesOf(await readManifest(dshHome, profile))).toEqual(['dsh-ffmpeg'])
  })

  it('reports PROFILE_UNKNOWN instead of guessing', async () => {
    const { dshHome } = await makeProfile({ bundles: [] })
    await expect(
      togglePlugin('dsh-ffmpeg', true, { env: { DSH_HOME: dshHome }, argv: ['node', 'dsh'] }),
    ).rejects.toMatchObject({ code: 'PROFILE_UNKNOWN' })
  })
})
