import type { HandoffRoot } from './attachments.ts'
import type { KernelEndpointCatalog } from './kernel-endpoints.ts'
import type { KernelCaller } from './kernel-invoke.ts'

/**
 * 内核端点网关（issue #26 阶段 3 起门面的正路）。
 *
 * `caller` 是 owner peer 上的 `typertGateway`（见 `ws-host-services.ts`），
 * `catalog` 是同一份 Typert 登记表的只读投影。两者成对传入：**没有目录就没有
 * wire 键**，光有 caller 只会把「手抄参数」从门面搬到调用点。
 */
export interface KernelGateway {
  readonly caller: KernelCaller
  readonly catalog: KernelEndpointCatalog
}

/**
 * `createDsh02ApiProxy` 的调参口（原工厂签名里的内联对象类型，#2 拆分时
 * 原样搬出成命名类型，语义不变）。
 */
export interface CreateDsh02ApiProxyOptions {
  /** 图片交接总开关。默认开；关掉就完全按老样子发（内核会照旧拒收纯文本模型的图片）。 */
  imageHandoff?: boolean
  /**
   * 授权根（id + realPath），用于把图片落到会话工作目录。
   * 没有 / 匹配不上时退回 [imageHandoffDir]。
   *
   * 收数组或 getter：设置页新增授权根之后，同一进程里紧接着发的那张图就该落到新根里，
   * 快照一份数组会让「刚授权完还是落到旧地方」。getter 每次调用现读，代价是一次数组映射。
   */
  handoffRoots?: readonly HandoffRoot[] | (() => readonly HandoffRoot[])
  /** 解析不出工作目录时的兜底落地目录。默认 `~/.dsh/image-handoff`。 */
  imageHandoffDir?: string
  /**
   * 当前的**识图路径**（交接子目录名）。
   *
   * 用 getter 而不是字符串：设置面板改完就该立刻生效，不必重启 dsh。默认
   * [DEFAULT_HANDOFF_SUBDIR]（`.dsh-images`），也就是设置里那栏只读的「当前默认」。
   */
  handoffSubdir?: () => string
  /**
   * 内核端点网关（issue #26 阶段 3 起门面的正路）：`typertGateway` owner peer 的
   * 调用面 + 同一份登记表的目录投影。
   *
   * 不给时门面退回**进程内传输**（`bridge/kernel-local.ts`）：端点名、参数校验、
   * 错误归一、取消透传都一样，只是最后一跳直接调宿主服务。存在的理由见该文件头 ——
   * 一句话：`typertGateway` 是可选服务，而会话读取是手机主路径。
   */
  kernel?: KernelGateway
}
