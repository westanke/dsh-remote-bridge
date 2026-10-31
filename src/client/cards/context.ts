/**
 * 卡片共享上下文：`AdminPanel` 拆成 `cards/*.tsx` 之后，各卡不再共用一个巨型函数作用域，
 * 而是从这里取「大家都要用」的东西。
 *
 * ## 为什么用 context 而不是逐层传 props
 *
 * 七张卡共享的是**同一份状态**，不是各自的副本：`error` 红条要跨卡显示、`refresh()` 一次
 * 刷新所有分区、`openCards` 决定展开态。逐层传 props 会让 `AdminPanel` 重新长成一张巨大的
 * 中转表（每个 prop 出现七八遍），跟没拆一样。context 把「谁给的」这件事收敛到一处。
 *
 * ## 放进来的判据
 *
 * **至少两张卡要用**，才进这里。只有一张卡用的状态留在那个文件里，不往上提 ——
 * 否则 context 会变成第二个巨型组件，只是换了个写法。
 *
 * ## 不放进来的东西
 *
 * 各卡自己的草稿态（根目录输入框里还没提交的路径、识图目录名草稿）刻意留在卡片内：
 * 它们不需要跨卡共享，提上来只会让「这张卡正在编辑什么」泄漏到全局。
 */
import { createContext, useContext } from 'react'

import type { DeviceScope, ImageHandoffSettings, RootView } from '../../shared/contracts.ts'
import type { CloudflareTunnelActivity, CloudflareTunnelState, ConfigTextResult, WorkspaceApi } from '../api.ts'
import type { MessageKey, Translate } from '../i18n.tsx'

/** 一张卡的标识。与 `workspace.tsx` 的 `AdminTab` 同源，这里不重复定义。 */
export type CardTab = 'roots' | 'remote' | 'tunnel' | 'devices' | 'image' | 'trash' | 'plugins' | 'app-download'

/** 成功反馈条（UI-07）：与 `error` 分开存，互不覆盖，3.5s 后自己退场。 */
export interface Notice {
  id: number
  key: MessageKey
  params?: Record<string, string | number>
}

export interface CardsContextValue {
  api: WorkspaceApi
  t: Translate
  locale: string

  // ── 共享数据 ───────────────────────────────────────────────────────────
  /**
   * `/manage/status` 的整份回包。类型从 `WorkspaceApi['status']` 推导而不是另立一个别名 ——
   * 别名一旦和实现漂移，这里就会「编译通过但运行时字段对不上」，那是最难查的一类。
   */
  status: Awaited<ReturnType<WorkspaceApi['status']>> | undefined
  /**
   * 授权根目录。注意是 `RootView & { realPath }` 而不是裸 `RootView`：管理面回包带
   * `realPath`（真实路径），卡片列表要显示它 —— 只显示用户起的 label 会让人分不清
   * 到底授权了哪个目录。
   */
  roots: readonly (RootView & { realPath: string })[]
  /** 管理面是否被隧道锁住。写操作要据此禁用，否则用户点了只会拿到 403。 */
  managementLocked: boolean

  // ── 共享动作 ───────────────────────────────────────────────────────────
  /** 拉一遍全部分区数据。**注意**：它按 `openCards` 懒加载，只拉展开着的卡。 */
  refresh(): Promise<void>
  notify(key: MessageKey, params?: Record<string, string | number>): void
  copyText(text: string): Promise<'done' | 'manual'>

  /**
   * 操作轮询回包写回。**必须是全局 status**，不能是卡片本地镜像。
   *
   * 为什么它要出现在共享层：`poll()` 住在 remote 卡（它跑 `configureListener` /
   * `disableRemote` / `enableRemote` 三个操作），但回包里带的是整份 status。
   * 尤其 `enableRemote` 的 `.then(result => poll(result.id))` **后面没有 refresh()** ——
   * 成功后 `remoteEnabled` 由 false 翻 true、界面从「启用配对」切成「关闭远程 + 新配对码」，
   * 全靠 poll 里这一句 `setStatus(next)`。丢了这个写回，按完启用按钮界面不会变。
   */
  setStatus(next: Awaited<ReturnType<WorkspaceApi['status']>>): void

  // ── 报错通道 ───────────────────────────────────────────────────────────
  error: unknown
  setError(cause: unknown): void

  // ── 隧道：remote 与 tunnel 两张卡共享，状态只能住在 AdminPanel ──────────
  //
  // 为什么状态不能搬进卡片文件：`AdminPanel.refresh()` 必须**先于、独立于** `/manage/status`
  // 拉隧道状态（见那里的长注释），而且 `managementLocked` 要由它算出来喂给**所有**卡的禁用态。
  // 状态一旦住进 tunnel.tsx，主壳就算不出这个值了。
  //
  // 但 `remote` 卡也吃这些字段：它的「一键开隧道并自动出令牌」按钮要 `tunnel`、
  // `configTextBusy`、`tunnelBusy`、`tunnelConfigClick`，配对后的配置文本要用
  // `configText` / `configEndpoint` 渲染。这不是耦合失误 —— 这个按钮的产品语义就是
  // 「配好监听后顺手把隧道也开了」，它属于 remote 的流程收尾。
  //
  // 所以：**状态与动作体留在主壳，经这里下发给两张卡**。谁都不搬，谁都能用。
  tunnel: CloudflareTunnelState | undefined
  tunnelBusy: boolean
  /** 隧道创建/下载二进制时的进度。`percent === null` 表示不确定进度，界面铺流动高光。 */
  activity: CloudflareTunnelActivity | undefined
  configText: ConfigTextResult | undefined
  configTextBusy: boolean
  /**
   * 写回配置文本。**必须打回全局**：这一对状态被两处写 —— tunnel 卡的
   * `generateConfigForUrl()`，以及 remote 卡里那个手动「生成配置文件」按钮。
   * 卡片本地镜像会让另一边读到陈旧值（症状：remote 手动生成后 ConfigTextPanel 不出，
   * 或 tunnel 出令牌后 remote 面板不刷新）。
   */
  setConfigText(value: ConfigTextResult | undefined): void
  setConfigTextBusy(value: boolean): void
  configEndpoint: string
  setConfigEndpoint(value: string): void
  createTunnel(opts?: { thenGenConfig?: boolean }): Promise<void>
  stopTunnel(): Promise<void>
  /** remote 卡上那枚「开隧道并出令牌」按钮：先在隧道侧创建/重启，再生成配置文本。 */
  tunnelConfigClick(): Promise<void>
  /** 由隧道地址生成 `DSH1:` 配置文本。返回是否成功。 */
  generateConfigForUrl(baseUrl: string, noticeKey?: MessageKey): Promise<boolean>
}

const CardsContext = createContext<CardsContextValue | undefined>(undefined)

export const CardsProvider = CardsContext.Provider

export function useCards(): CardsContextValue {
  const value = useContext(CardsContext)
  if (value === undefined) throw new Error('useCards 必须在 CardsProvider 内使用 —— 卡片没有拿到共享上下文')
  return value
}
