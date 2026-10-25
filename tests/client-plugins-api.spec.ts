import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceApi, WorkspaceApiError } from '../src/client/api.ts'

/**
 * 浏览器半边插件方法的契约测试。
 *
 * 为什么单独测这一层：`plugin-inventory-api.spec.ts` 证明的是**服务端**端点通，
 * 而手机面板真正调用的是 `src/client/api.ts` 里这两个方法。它们的失败模式与服务端无关 ——
 * 路径拼错、方法写错、body 少了字段、`?checkUpdates=1` 拼成 `?checkUpdates`，
 * 服务端测试一条都抓不到，界面上却只会显示「操作失败」。
 *
 * 用 stub 的 `fetch` 而不是起真服务器：这里要钉的是**请求形状**，不是 HTTP 栈。
 */

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

/** 记录一次请求，并回一个指定的 JSON 体。 */
function stubFetch(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  globalThis.fetch = spy as unknown as typeof fetch
  ;(spy as unknown as { calls: typeof calls }).calls = calls
  return spy as unknown as ReturnType<typeof vi.fn>
}

function api(): WorkspaceApi {
  return new WorkspaceApi('/dsh-workspace-api/api/v1', '/dsh-workspace-api/manage', undefined, true)
}

describe('WorkspaceApi plugin methods', () => {
  it('reads the inventory without the update check by default', async () => {
    const spy = stubFetch({ profile: 'web', available: true, items: [] })
    await api().pluginInventory()
    const call = (spy as unknown as { calls: { url: string; init?: RequestInit }[] }).calls[0]!
    // 版本检查要打 npm registry，默认绝不能顺手带上 —— 设置页一打开就会白等一次网络。
    expect(call.url).toBe('/dsh-workspace-api/api/v1/settings/plugins')
  })

  it('adds the update-check query only when asked', async () => {
    const spy = stubFetch({ profile: 'web', available: true, items: [] })
    await api().pluginInventory(true)
    const call = (spy as unknown as { calls: { url: string; init?: RequestInit }[] }).calls[0]!
    expect(call.url).toBe('/dsh-workspace-api/api/v1/settings/plugins?checkUpdates=1')
  })

  it('PATCHes { name, loaded } so the host can flip exactly one bundle', async () => {
    const spy = stubFetch({ name: 'dsh-ffmpeg', loaded: false, backupName: 'package.json.bak-1', bundleCount: 16, restartRequired: true })
    const result = await api().togglePlugin('dsh-ffmpeg', false)
    const call = (spy as unknown as { calls: { url: string; init?: RequestInit }[] }).calls[0]!
    expect(call.url).toBe('/dsh-workspace-api/api/v1/settings/plugins')
    expect(call.init?.method).toBe('PATCH')
    expect(JSON.parse(String(call.init?.body))).toEqual({ name: 'dsh-ffmpeg', loaded: false })
    // 服务端恒回 true：bundles 只在启动时读一次。客户端不该把它抹成 false。
    expect(result.restartRequired).toBe(true)
  })

  it('surfaces PLUGIN_OFFICIAL_IMMUTABLE as a typed error the panel can translate', async () => {
    stubFetch({ error: { code: 'PLUGIN_OFFICIAL_IMMUTABLE', message: 'official' } }, 400)
    await expect(api().togglePlugin('@deepseek-ai/dsh-ffmpeg', false)).rejects.toMatchObject({
      status: 400,
      code: 'PLUGIN_OFFICIAL_IMMUTABLE',
    })
  })

  it('keeps PROFILE_UNKNOWN distinct so the panel can say "nothing was written"', async () => {
    stubFetch({ error: { code: 'PROFILE_UNKNOWN', message: 'no profile' } }, 503)
    const failure = await api().togglePlugin('dsh-ffmpeg', true).catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(WorkspaceApiError)
    expect((failure as WorkspaceApiError).code).toBe('PROFILE_UNKNOWN')
    expect((failure as WorkspaceApiError).status).toBe(503)
  })
})
