import {mkdir, mkdtemp,} from 'node:fs/promises'
import { TestCleanup } from './test-cleanup.ts'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceDatabase } from '../src/host/database.ts'
import { DEVICE_SCOPES } from '../src/shared/contracts.ts'
import { readFileSync } from 'node:fs'

/**
 * 配对权限由用户在「远程访问」里勾选，而不是写死全量。
 *
 * 回归起因：用户在设置里点权限勾选框没有反应。追下去发现这条链路里三个版本都错过一次 ——
 *  - 第一版写死 `checked readOnly`：七个框全勾且点不动；
 *  - 第二版改成取「第一台设备的权限」：可**只有没设备时才会走到这一步**，于是七个框全灰；
 *  - 第三版才是它本来该有的样子：可交互的 state，值随配对请求一起发出去。
 *
 * 这里钉住服务端那一半：`createPairing(scopes)` 必须如实使用调用方给的权限集合 ——
 * 无论是子集、单元素还是空集。UI 那一半由源码契约测（见下），不依赖 jsdom。
 */

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

async function scratch(prefix: string): Promise<string> {
  const container = path.join(process.cwd(), '.local-backup', 'test-tmp')
  await mkdir(container, { recursive: true })
  const base = await mkdtemp(path.join(container, `${prefix}-`))
  cleanup.dir(base)
  return base
}

describe('pairing carries the scopes the user picked', () => {
  it('grants exactly the requested subset, not everything', async () => {
    const base = await scratch('scope-subset')
    const project = path.join(base, 'project')
    await mkdir(project)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    try {
      const root = await database.addRoot(project, 'P')
      // 只勾了「读聊天」和「读文件」—— 手机不该拿到别的。
      const picked = ['chat.read', 'files.read'] as const
      const pairing = database.createPairing([root.id], [...picked])
      const exchanged = database.exchangePairing(pairing.code, '我的手机')

      expect(exchanged.device.scopes.sort()).toEqual([...picked].sort())
      // 落库的设备也必须是这一份，不能悄悄变回全量。
      expect(database.getActiveDevice(exchanged.device.id)?.scopes.sort()).toEqual([...picked].sort())
      // 没勾的权限，认证结果里不能出现。
      expect(exchanged.device.scopes).not.toContain('files.delete')
      expect(exchanged.device.scopes).not.toContain('settings.write')
    } finally {
      database.close()
    }
  })

  it('accepts a single scope and an empty set without throwing', async () => {
    const base = await scratch('scope-edge')
    const project = path.join(base, 'project')
    await mkdir(project)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    try {
      const root = await database.addRoot(project, 'P')

      const one = database.createPairing([root.id], ['files.read'])
      expect(database.exchangePairing(one.code, 'P1').device.scopes).toEqual(['files.read'])

      // 空集合：用户取消全选时点不了配对（UI 已禁用按钮），但服务端本身不该炸。
      const none = database.createPairing([root.id], [])
      expect(database.exchangePairing(none.code, 'P2').device.scopes).toEqual([])
    } finally {
      database.close()
    }
  })

  it('rejects an unknown scope instead of silently ignoring it', async () => {
    const base = await scratch('scope-invalid')
    const project = path.join(base, 'project')
    await mkdir(project)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    try {
      const root = await database.addRoot(project, 'P')
      // 打错一个字符（比如 `file.read`）必须报错。静默忽略会让用户以为授权成功了，
      // 而手机端什么也做不了 —— 那种失败方式最难查。
      expect(() => database.createPairing([root.id], ['file.read' as never])).toThrowError(/unknown device scope/i)
    } finally {
      database.close()
    }
  })
})

/**
 * UI 那一半的源码契约。
 *
 * 不引 React 组件（vitest 没配 jsdom），改为从源码里查三件事 —— 这三件正好对应历史上
 * 三个版本各自错在哪，改动任意一处都会让这个测试变红：
 * 1. 勾选框**不能**带 `readOnly`（第一版的错：点不动）；
 * 2. `checked` 必须来自**可交互的 state**，不能来自「第一台设备的权限」（第二版的错：
 *    没设备时全灰，而没设备正是唯一需要它的时刻）；
 * 3. `enableRemote` / `createPairing` 必须传**用户选的那个变量**，不能写死 `DEVICE_SCOPES`
 *    （否则勾了也白发）。
 */
describe('the scope picker in the settings panel', () => {
  // 读**拼接**结果而不是单个固定文件：权限选择器 2026-10-31 随设置页拆卡从
  // workspace.tsx 搬进了 cards/remote.tsx（设备侧的授权网格在 cards/devices.tsx），
  // 而这条用例的语义是「这个客户端里的选择器是可交互的」，它不该关心代码住在哪个文件。
  //
  // 写死单文件会造出误导性的失败：搬家后报「enableRemote 没找到」/「没有 grantedScopes」，
  // 读的人会以为功能被删了，而它只是在隔壁文件里。拼接后断言强度不变 ——
  // 真的没有可交互选择器、或真的传了 DEVICE_SCOPES，仍然会红。
  const source = ['workspace.tsx', 'cards/remote.tsx', 'cards/devices.tsx']
    .map(file => readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8'))
    .join('\n')

  it('is interactive rather than read-only', () => {
    const picker = /daw-scope-grid[\s\S]{0,400}?scopeLabel\(locale, scope\)/.exec(source)
    expect(picker).not.toBeNull()
    expect(picker![0]).not.toContain('readOnly')
    expect(picker![0]).toContain('onChange')
  })

  it('reads its checked state from a pickable set, not from a paired device', () => {
    // 没有「从 devices[0] 取权限」这种写法，才不会在没设备时全灰。
    expect(source).not.toMatch(/devices\?\.\[0\]\?\.scopes/)
    expect(source).toMatch(/grantedScopes/)
    expect(source).toMatch(/useState<DeviceScope\[\]>/)
  })

  it('sends the picked scopes instead of the full list', () => {
    // 取到**整个实参串**：括号里还有 `root => root.id` 的箭头函数，非贪婪正则会截断在第一个 `)`，
    // 于是永远只看到第一个参数。必须按括号配平取完整内容。
    const takeArgs = (call: string): string => {
      const start = source.indexOf(`${call}(`)
      if (start < 0) return ''
      const open = start + call.length
      let depth = 0
      for (let i = open; i < source.length; i += 1) {
        if (source[i] === '(') depth += 1
        else if (source[i] === ')') {
          depth -= 1
          if (depth === 0) return source.slice(open + 1, i)
        }
      }
      return ''
    }
    for (const call of ['enableRemote', 'createPairing']) {
      const args = takeArgs(call)
      expect(args.length, `${call} 没找到`).toBeGreaterThan(0)
      expect(args).toContain('grantedScopes')
      expect(args).not.toContain('DEVICE_SCOPES')
    }
  })

  it('offers every scope, so nothing is unreachable from the picker', () => {
    expect(source).toContain('DEVICE_SCOPES.map(scope')
    expect(DEVICE_SCOPES.length).toBe(7)
  })
})