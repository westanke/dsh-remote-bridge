import type { HandoffRoot } from './attachments.ts'

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
}
