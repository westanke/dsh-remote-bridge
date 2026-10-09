import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readPluginInventory, resolveDshHome, resolveProfileName } from '../src/host/plugin-inventory.ts'

const cleanup: string[] = []

afterEach(async () => {
  for (const target of cleanup.splice(0)) await rm(target, { recursive: true, force: true })
})

async function makeProfile(options: {
  profile?: string
  dependencies?: Record<string, string>
  bundles?: string[]
  installed?: Record<string, string>
} = {}): Promise<{ dshHome: string; profile: string }> {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'daw-plugins-'))
  cleanup.push(dshHome)
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

  it('reports MANIFEST_UNREADABLE when the profile has no package.json', async () => {
    const dshHome = await mkdtemp(path.join(os.tmpdir(), 'daw-plugins-'))
    cleanup.push(dshHome)
    const inventory = await readPluginInventory({ env: { DSH_HOME: dshHome, DSH_PROFILE: 'web' }, argv: [] })

    expect(inventory).toMatchObject({ available: false, reason: 'MANIFEST_UNREADABLE', profile: 'web' })
    expect(inventory.items).toEqual([])
  })

  it('survives a malformed manifest without throwing', async () => {
    const dshHome = await mkdtemp(path.join(os.tmpdir(), 'daw-plugins-'))
    cleanup.push(dshHome)
    const profilePath = path.join(dshHome, 'profiles', 'web')
    await mkdir(profilePath, { recursive: true })
    await writeFile(path.join(profilePath, 'package.json'), '{ this is not json')

    const inventory = await readPluginInventory({ env: { DSH_HOME: dshHome, DSH_PROFILE: 'web' }, argv: [] })
    expect(inventory.available).toBe(false)
    expect(inventory.reason).toBe('MANIFEST_UNREADABLE')
  })

  it('tolerates a manifest without a dsh.profile.bundles section', async () => {
    const dshHome = await mkdtemp(path.join(os.tmpdir(), 'daw-plugins-'))
    cleanup.push(dshHome)
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
    for (const item of inventory.items) {
      expect(Object.keys(item).sort()).toEqual(['declared', 'installed', 'loaded', 'name', 'official', 'state'])
    }
    expect(Object.keys(inventory).sort()).toEqual([
      'available', 'items', 'loadedCount', 'problemCount', 'profile', 'profilePath', 'reason',
    ])
  })
})
