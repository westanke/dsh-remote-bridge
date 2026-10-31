// 插件清单与开关路由块 —— 从 router.ts 纯搬移（issue #3）。
import { ApiError } from '../errors.ts'
import { PluginToggleError, readPluginInventory, togglePlugin, withUpdateCheck } from '../plugin-inventory.ts'
import { readJson, sendJson, type ApiRouteCtx } from './shared.ts'

// pluginRoutes：/api/v1/settings/plugins（原 router.ts dispatch 块，issue #3 纯搬移）
export async function pluginRoutes(ctx: ApiRouteCtx): Promise<boolean> {
  const { method, pathname, principal, req, res, url, requestId, options, bff } = ctx

  // 插件清单：让手机端能看到这台机器装了哪些插件、跑的是哪个版本、有没有加载失败。
  // 此前 /api/v1 的 10 个端点里没有任何一个与插件相关，用户在手机上无法自查插件状况。
  if (method === 'GET' && pathname === '/api/v1/settings/plugins') {
    options.auth.requireScope(principal, 'settings.read')
    const inventory = await readPluginInventory()
    // 版本检查是可选的重活（每个包一次 registry 请求，清单会从毫秒级变成好几秒），
    // 得显式开 —— 用户点进这页十次里九次只想看「装了啥、哪个没启用」。
    const checkUpdates = url.searchParams.get('checkUpdates') === '1'
    sendJson(res, 200, checkUpdates ? await withUpdateCheck(inventory) : inventory)
    return true
  }


  // 启用 / 停用插件（写操作）。
  //
  // 要求 `settings.write`：这会改 profile 的 package.json —— 写坏了 dsh 下次起不来，
  // 而用户此刻在手机上、够不着电脑。门槛与「改设置」同级是合理的。
  if (method === 'PATCH' && pathname === '/api/v1/settings/plugins') {
    options.auth.requireScope(principal, 'settings.write')
    let payload: { name?: unknown; loaded?: unknown }
    try {
      payload = (await readJson(req, 8_000)) as { name?: unknown; loaded?: unknown }
    } catch {
      throw new ApiError(400, 'REQUEST_INVALID', 'The request body must be valid JSON.')
    }
    const name = typeof payload.name === 'string' ? payload.name : ''
    const loaded = payload.loaded
    if (name.trim() === '' || typeof loaded !== 'boolean') {
      throw new ApiError(400, 'REQUEST_INVALID', 'Expected { name: string, loaded: boolean }.')
    }
    try {
      sendJson(res, 200, await togglePlugin(name, loaded))
    } catch (error) {
      if (error instanceof PluginToggleError) {
        // 已知的业务性拒绝（官方包 / 没装 / 名字非法）→ 400 + 稳定错误码，
        // 让手机端按码给本地化文案，而不是把英文原句端给用户。
        const status = error.code === 'PROFILE_UNKNOWN' || error.code === 'MANIFEST_UNREADABLE' ? 503 : 400
        throw new ApiError(status, error.code, error.message)
      }
      throw error
    }
    return true
  }
  return false
}
