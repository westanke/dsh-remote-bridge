import { describe, expect, it } from 'vitest'
import { normalizePermissionCatalog } from '../src/host/dsh-0.2-bridge.ts'

/**
 * 权限档位目录 BFF 的回归测试。
 *
 * 盯的是 `normalizePermissionCatalog` —— 它挡住的是**真机上「权限档位菜单根本不渲染」**
 * 那一类症状（Android 客户端 v2.2.44 验收实测）。
 *
 * ## 为什么要有这个函数
 *
 * 内核 `dsh-permission-presets` 把候选项放在一个**独立的远程服务**上
 * （`@Remote('catalog')` → `permissionPresets.catalog()`），
 * 而会话投影里那条同名 wire 视图只产 `{ currentValue }`（`wire.view: state => ({ currentValue })`），
 * **两者没有任何交叉引用**：客户端能读到「当前档位」，却列不出候选。
 *
 * 所以插件必须自己把这个 catalog 透出来，而透出来之前先在这里把形状收敛掉 ——
 * 内核那一侧是 `zod` 校验过的类型，跨进程之后没有任何保证。
 */
describe('permission preset catalog', () => {
  it('passes a well-formed catalog through unchanged', () => {
    const catalog = normalizePermissionCatalog({
      options: [
        { value: 'workspace-write', name: '工作区写入', description: '只写工作区' },
        { value: 'danger-full-access', name: '完全访问' },
      ],
      defaultOptions: [{ value: 'workspace-write', name: '工作区写入' }],
      defaultPreset: 'workspace-write',
    })

    expect(catalog.options).toEqual([
      { value: 'workspace-write', name: '工作区写入', description: '只写工作区' },
      { value: 'danger-full-access', name: '完全访问' },
    ])
    expect(catalog.defaultPreset).toBe('workspace-write')
  })

  it('falls back to the value when a preset has no usable name', () => {
    // 内核的 `custom` 档位只保证有 value；名字缺失时若原样透传，
    // 客户端菜单里会出现一行**没有文字**的选项（kotlinx 的 name 是非空串要求，
    // 严格解码器会整页解析失败）。
    const catalog = normalizePermissionCatalog({
      options: [{ value: 'custom' }, { value: 'auto', name: 'Auto' }],
      defaultPreset: 'custom',
    })

    expect(catalog.options.map(option => option.name)).toEqual(['custom', 'Auto'])
  })

  it('drops rows without a usable value instead of forwarding them', () => {
    const catalog = normalizePermissionCatalog({
      options: [
        { name: '没有 value' },
        { value: '', name: '空 value' },
        null,
        'garbage',
        { value: 'read-only', name: '只读' },
      ],
      defaultPreset: 'read-only',
    })

    expect(catalog.options).toEqual([{ value: 'read-only', name: '只读' }])
  })

  it('survives a catalog that is not an object at all', () => {
    // 内核服务没挂上 / 远程调用返回了别的东西时，客户端不该整个崩掉：
    // 空清单 + 一个说得过去的默认值，界面就是「档位菜单里只有默认那一档」。
    expect(normalizePermissionCatalog(undefined)).toEqual({ options: [], defaultPreset: 'workspace-write' })
    expect(normalizePermissionCatalog(null)).toEqual({ options: [], defaultPreset: 'workspace-write' })
    expect(normalizePermissionCatalog('nope')).toEqual({ options: [], defaultPreset: 'workspace-write' })
  })

  it('falls back to the first option when defaultPreset is missing or blank', () => {
    expect(normalizePermissionCatalog({
      options: [{ value: 'first', name: 'First' }, { value: 'second', name: 'Second' }],
      defaultPreset: '',
    }).defaultPreset).toBe('first')

    expect(normalizePermissionCatalog({ options: [] }).defaultPreset).toBe('workspace-write')
  })

  it('keeps description optional rather than emitting an empty string', () => {
    // `description: ''` 与「没有 description」在客户端是两种显示：
    // 前者会渲染出一段空的副标题行。
    const catalog = normalizePermissionCatalog({
      options: [{ value: 'a', name: 'A', description: '' }],
      defaultPreset: 'a',
    })

    expect('description' in catalog.options[0]!).toBe(false)
  })
})