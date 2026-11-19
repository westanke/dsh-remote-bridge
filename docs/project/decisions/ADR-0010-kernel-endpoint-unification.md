# ADR-0010：内核端点归一 —— 桥不再持有内核端点的 DTO 副本，内核没有的语义永久留桥

- 状态：accepted（2026-11-19 拟并采纳；施工中 —— 状态行不带 markdown 标记，与其它 ADR 一致，`docs:check` 按纯文本匹配）
- 日期：2026-11-19

> 这条 ADR 记的是**一个方向**，不是一份施工图。方案全文与逐阶段施工卡在
> [issue #26](https://github.com/westanke/dsh-remote-bridge/issues/26)（正文 + 附录 1/2/3）；
> 本文只把「为什么是这个方向、哪些东西明确不上移」钉成可被后来者复核的断言。
>
> **选项命名**：A = 维持现状；**B1** = 手机直调内核端点（桥的现有面全部退役）；
> **B2** = 桥内全量换源（手机协议零改动）—— **本 ADR 采纳 B2**。

## 背景

桥今天把 DSH 内核的端点语义**手抄了一遍**：`src/host/dsh-0.2-bridge.ts`（629 行，
DEBT 台账在册）里重建了 0.1.x 的 `apiProxy` 门面 —— `sessions` / `workspace` /
`agentPresets` / `permissionPresets` / `userQuestions` / `settings` / `credentials` /
`llm` / `events` 九个分组、**34 个**内核端点名（`grep -oE "call\('[a-zA-Z]+\.[a-zA-Z]+'"`
去重实测；另有 `approvals.respond`、`userQuestions.pendingAll`、`events.mux`、
`events.host` 四处不走 `call()` 的入口）。抄的代价是双份的：

- 每接一个内核端点，桥就多一份「内核哪天改字段名」的副本；
- 桥已登记为债（629 行 ≈ 超 600 行预算），且它是另外两条债（`ws-handler.ts` 882、
  `ws-file-transfer.ts` 719）的共同根；
- 桥侧还配套养了一份 **592 行**的 host service 类型声明（`src/host/bridge/kernel-services.ts`）。

与此同时，内核已经把同一份语义**生成好了**：本机 0.2.2-rc.4 的 39 个
`lib/typert.host.js` 生成清单里共有 **224 个方法端点 / 43 个命名空间**
（判据：条目块含 `invocation:` 或 `parameters:`），全部是 strict codec
（`mode:'strict'` 847 次、`mode:'src-json'` 0 次）—— 带 zod 校验、
带 per-parameter JSON Schema、带 wire 键名、带描述符。另有 655 个事件条目。

也就是说：**桥在抄的东西，内核已经有一份机器可读的。**

> **口径更正**：此前流传的「436 个端点 / 33 个命名空间」是把 `service:` 行与条目混算的结果。
> 本 ADR 一律用「**224 方法端点 / 43 命名空间**」（条目块判据，已与独立脚本交叉验证）。

## 逐条核账

| # | 问题 | 我方现状 | 内核能不能给 | 可证性 |
|---|---|---|---|---|
| ① | 内核端点语义 | 手抄 35 个内核语义入口（34 个 `call('x.y')` 端点名 + `approvals.respond`） | **能**：描述符含 wire 键 + zod + JSON Schema | 可证（`dsh-typert-protocol/.../types.d.ts:276-291/299-351`；`dsh-api-gateway/src/index.ts:1630-1657`） |
| ② | 端点集合 | 静态写死 | **能**：`ctx.typert.local.list()` 自动发现 | 可证（`dsh-typert-registry/src/service.ts:177/536`） |
| ③ | 手机够不够用 | 桥声明帧 114（客户端 70 + 服务端 66），App 实现 33（交集 33，App 独有仅 `fork`）⇒ 覆盖 ≈29% | 无关 —— 缺的是 App 侧，不是桥侧 | 可证（`src/host/ws-protocol.ts` 联合类型 vs `WsFrames.kt` 常量，逐字比对） |
| ④ | 设备授权根（`rootIds`） | 桥独有：7 scope + 授权根 + 撤销 + 审计 | **不能**：`PrincipalMap` 只有一条 `owner` | 可证（`dsh-typert-protocol/.../types.d.ts:363-368`） |
| ⑤ | HITL 竞速 | 桥独有：自持 pending 表 + 单胜方（ADR-0009） | 语义更弱：先答者赢、后答者静默丢弃无错误帧 | 可证（`dsh-api-gateway/src/index.js:1149`） |
| ⑥ | 文件分块断点续传 | 桥独有：8 帧状态机 + spool 0600 + 末块 SHA-256 | **不能**（内核 one-shot base64） | 可证（`src/host/ws-file-transfer.ts`） |
| ⑦ | 隧道与背压 | 桥独有：隧道 + 队列上限（阶段 0.2 起为**端口分离**的专用数据端口） | **不能**（内核 `RemoteEventQueue` 无界） | 可证（`src/host/cloudflared.ts`、`src/host/tunnel-listener.ts`） |
| ⑧ | 接入面 | 桥自己的 HTTP server + `/ws/mobile` 子协议 | 能挂独立 RPC 通道，但 `/api` 已被内核占用 | 可证（`dsh-client-connection/src/rpc-host.ts:253-301`） |
| ⑨ | 最低内核版本 | `engines.dsh` `>=0.2.2-rc.1 <0.3.0`；CI 矩阵**已在阶段 0.1 对齐为 0.2.2-rc.1 + 0.2.2-rc.4 两档**（此前停在 `687f282e` = 0.2.1-rc.2） | —— | 可证（`.github/workflows/ci.yml`） |
| ⑩ | 审批应答 | 桥独有：`ApprovalBridge.respond`（pending 表 + 单胜方 + 10 分钟超时） | **不能**：内核审批**零方法端点**，只有 Cordis waterfall + `approval/asked`/`approval/decided`/`approval/policy` 事件 | 可证（`dsh-user-approval/src/index.ts:259/308`；`dsh-user-approval/lib/` 下无 `typert.host.js`） |
| ⑪ | 流式上传 | 桥独有：Cordis 服务方法 `fileUploads.uploadStream(...)`，100 MiB 内存峰值 2.5 MiB | **不能**：`fileUploads` 命名空间只有 `upload`（base64） | 可证（`dsh-client-file-upload/src/index.ts`；生成清单里 `fileUploads` 只有 `upload`） |
| ⑫ | 「服务方法 ≠ 内核端点」 | 桥侧有 4 处只能走 host service 的语义 | `userQuestions.continued`（private）、`llm.resolveModelInfo`（无 `@Remote`）、`fileUploads.uploadStream`、`sessionController.resolveAgent` **都没有端点** | 可证（`dsh-user-questions/src/index.ts:152-154`；`dsh-llm/src/index.ts:775-781`） |

**承重的一条**：`assertExactArguments` 对**多余和缺失**的 wire 键都抛
`gateway/arguments-invalid` ⇒ 通用面必须知道**确切的 wire 键集合**。
它就在描述符里（`descriptor.parameters[].wire`），可自动推导 ——
但手写一定错：`session/list` 的 wire 键是 `_request`，不是空对象；
`settings/mutate` 是**三个顶层参**（`ns`/`ops`/`expectedRevision`），不是一个 `{request:{...}}`。

## 选项

### 选项 A：维持现状（继续手抄端点语义）

每加一个手机可达能力：手写 DTO → 加 2~4 个帧 → 改五处契约 → 跨仓同步 SDK。
优点：零新增架构。缺点：桥与内核的语义副本持续扩大，DEBT 台账只紧不松；
且 App 侧只实现 114 个声明帧里的 33 个，**桥多抄一份并没有换来 App 多一个能力**。

### 选项 B1：手机直调内核端点（桥的现有面全部退役）

白名单放开后，手机直接按内核的 `namespace/method` 调端点。
优点：概念最干净，手机端获得内核全部 224 个方法端点。缺点：**11 条用户可见的现象会变差**：

| # | 现象 | 机制 |
|---|---|---|
| ① | 大文件上传 OOM | `fileUploads/upload` 只有 base64 ⇒ 内存放大 **5.67×**（100 MiB→567 MiB） |
| ② | 流式上传能力消失 | 客户端可选方法与 `FILE_UPLOAD_STREAM_UNSUPPORTED` 错误码无处安放 |
| ③ | 模型容量字段消失 | `contextWindow`/`maxTokens` 来自非端点的 `llm.resolveModelInfo` |
| ④ | **App 预设列表整个打不开** | 内核 `agentPresets/list` 没有 `trust` 字段，Android 严格 kotlinx 解码缺字段即整份失败 |
| ⑤ | 手机出现打不开的会话 | 内核 `session/list` 会把 `origin:'subagent'` 的子会话也列出来 |
| ⑥ | **前台提问卡片消失、流程卡死** | 内核 `userQuestions` 投影只覆盖带 `timeout` 的提问，桥接管的前台阻塞式提问在内核之外 |
| ⑦ | 纯文本模型发图从「变文本提示」变成「发送失败」 | 内核 strict 拒桥自加的 `locale`（`gateway/arguments-invalid`）与未改写的图片（`session/attachment-invalid`） |
| ⑧ | 客户端协议要变 + 引用校验消失 | 内核 `session/attachment` 要五字段完整 ref；内核 0.2.2 不校验引用关系 |
| ⑨ | 投影面板变空 / 子会话地址被拒 | 丢投影合并回退；`kind:'subagent'` 地址拼错被 `validateAddress()` 拒收 |
| ⑩ | 可见范围可能变小 | `workspace/follow` 按 `remoteAccess.allows` 过滤 |
| ⑪ | 每次调用都报参数错 | `session/prompt` 的 `requestId`、`session/follow`/`page` 的 `request.address` 必填 |

⇒ B1 不是「成本高一点」，是**搬完手机端会有新的 bug**。

### 选项 B2：桥内全量换源（**本 ADR 提议**）

- 桥内 **35 个**内核语义入口逐条核账：**31 条**换成「内核端点 + 描述符驱动」，
  **4 条**内核没有等价物、永久留桥（审批应答 / 提问取消 / 图片交接 / 流式上传）；
- 换源改的是**桥的内部实现**（手抄 DTO + 进程内直调 ⇒ 描述符驱动的统一调用封装），
  **不是手机协议** ⇒ 手机一行不改、App 不用发版、REST 路径零改动、帧名零改动；
- 11 条 COMPOSED 的内核缺失语义（subagent 过滤、`trust` 字段、容量字段、冷会话短路、
  子会话地址构造、`beforeSeq` 分页、`locale` 剥离、图片交接改写、错误码映射、引用补齐、
  `active` 标记）作为**纯函数 delta** 留在桥，逐条点名、逐条可测；
- ④⑤⑥⑦ 与 ⑩⑪⑫ 的语义**一步不退**。

### 选项 C：只对增量归零（v1 提议，已被本 ADR 取代）

- **新增**的手机可达能力一律走通用调用面；
- **存量** 35 个手写端点**保留在桥里**，不迁移。

被取代的理由：v1 的核心论点「存量迁移不产生任何用户可见收益」在本次逐条核账后**不再成立** ——
桥的 DTO 副本是**升级时必炸**的债源，而它恰好也是 `ws-handler.ts` 882、
`ws-file-transfer.ts` 719、`kernel-services.ts` 592 三条债的共同根。
存量不迁 = 债不消。且本次核账证明**换源本身可以不产生用户可见变化**（B2 的 11 条 delta 就是证据）。

## 选项比较

| 维度 | A 维持 | B1 手机直调 | **B2 桥内全量换源** | C 只对增量归零（v1） |
|---|---|---|---|---|
| 升级成本 | 持续上升 | 归零 | **归零** | 增量归零，存量保持 |
| 用户可见风险 | 无 | **高**（11 条现象变差） | **低**（11 条 delta 保留 ⇒ 现象不变） | 低 |
| 手机端改动 | 无 | **大**（协议要变、要发版） | **零** | 无 |
| 桥的代码量 | 继续长 | 大幅缩（但能力缩水） | **缩**（629 → ≤450；`kernel-services.ts` 592 → ~180） | 增（新增 3 个文件，≈850 行） |
| 债的处置 | 债继续在册 | 债消失但换成新债 | **债消**（两条 DEBT 一起松） | 债继续在册 |
| 概念一致性 | 差（一直手抄） | 好 | **好**（内核没有的才留桥） | 中（两种方式，边界明确） |
| 落地成本 | 0 | 30~45 人日 + 跨仓发版 | **≈14.5 人日**（9 阶段） | ≈8 人日 |

## 决议

**采纳选项 B2**（2026-11-19 定稿为 `accepted`，随 issue #26 分阶段落地）。

三条不可动的约束：

1. **内核没有的语义不上移** —— 设备授权根、HITL 竞速、文件分块断点、隧道与背压**一步不退**；
   另有 4 条**永久留桥**并在此点名：**审批应答（`approvals.respond`）**、
   **提问取消（`userQuestions.cancel`）**、**图片交接（`sessions.readHandoffImage`）**、
   **流式上传（`sessions.uploadAttachmentStream`）**。
   ⇒ 内核审批**零方法端点**；`userQuestions` 无 cancel；`workspaceFiles/readBytes` 够不到交接目录；
   `fileUploads/upload` 只 base64。搬过去必然变差 ⇒ 留。
2. **接入面不换宿主** —— 不改挂内核 webServer（内核拒绝 wildcard 绑定，
   而桥的存在意义就是 `0.0.0.0:3090` + 设备 token），不接管 `/api`（内核已占用）；
   通用面就挂在今天的 `/ws/mobile` 上，靠子协议集合判定分流（`ws` 库自带
   `handleProtocols` 钩子 ⇒ 老 App 零改动）。
3. **白名单是唯一执法点** —— 手机可达面 = 桥的 owner 权限；白名单外默认拒绝
   （照抄官方 `ds-harness-remote` 的 `assertAllowed`），高危命名空间钉本地，
   每个白名单端点声明所需 scope，kernel-call 路径不得产生任何审批或提问交互；
   且**白名单不得包含桥已有的 35 个入口**（单一路径原则，避免同一能力两条路两个结果）。

配套动作（登记为 ROADMAP `MOB-001`..`MOB-012`，见 [ROADMAP.md](../ROADMAP.md)）：
先修 CI 矩阵与 `engines.dsh` 的不一致（矩阵原先停在 0.2.1-rc.2，阶段 0.1 已改为
0.2.2-rc.1 + 0.2.2-rc.4 两档），再收紧帧联合类型（收口 DEBT-005），
然后上描述符驱动的统一调用封装、分 4 批把 31 条存量换源、
把 4 条永久语义登记成不可上移清单，最后才上通用调用面。

## 永久留桥的 4 条（落地登记，2026-11-19 阶段 4）

上面第 1 条约束点名的 4 条，在阶段 3a~3d 把 31 条存量换成内核端点之后**仍然留在桥里**。
每条都给一条可证伪的断言与一个认领它的测试 —— 断言写进
[SECURITY.md](../SECURITY.md) §内核端点归一，测试名字在这里点名：

| 留桥入口 | 内核为什么顶不上 | 可证伪断言 | 认领测试 |
|---|---|---|---|
| `approvals.respond` | 内核审批**零方法端点**（`dsh-user-approval` 只有 `approval/request` 瀑布与事件）；桥 `prepend` 注册且进入即 `next()`，多答者竞速搬不成一次方法调用 | 审批应答仍由桥的挂起表结算，且不出现第二条结算路径 | `tests/dsh-0.2-bridge.spec.ts` › claims an approval request, republishes it, and settles from respond() |
| `userQuestions.cancel` | 内核 `userQuestions` 只有 `answer` / `attachWait`，没有 cancel | 取消后手机端收到 `userQuestions/dismissed` 帧，卡片消失而不是变陈旧 | `tests/dsh-0.2-bridge.spec.ts` › cancels a bridged front-of-house question through userQuestions.cancel |
| `sessions.readHandoffImage` | `workspaceFiles/readBytes` 语义不同、够不到图片交接目录；6 条守门条件（Host 回环、跨站 403、文件名正则、魔术字节一致、体积上限、扩展名一致）留桥 | 交接地读取仍逐条过守门条件，越界一律拒绝 | `tests/handoff-hardening.spec.ts` › reads the bytes of an existing handoff file and reports the sniffed-compatible media type |
| `sessions.uploadAttachmentStream` | `fileUploads/upload` 只吃 base64；流式把 100 MiB 上传的内存峰值压在 2.5 MiB，回落 base64 会放大 5.67× | 宿主持有 `uploadStream` 时走字节流，缺席时才回落 base64 | `tests/ws-file-transfer.spec.ts` › hands the kernel a byte stream instead of a base64 string / falls back to the base64 path when the host cannot stream file uploads |

第四条断言（「桥不再持有内核端点的 DTO 副本」）由机检认领：`tests/kernel-deltas.spec.ts`
› machine check 两例（门面 ≤450 行；门面里没有任何数组/对象常量把两个以上端点名收在一起）。

## 相关

- 施工卡与方案全文：[issue #26](https://github.com/westanke/dsh-remote-bridge/issues/26)
- 信任边界的现状与残余风险：[SECURITY.md](../SECURITY.md) §管理面的信任边界 / §残余风险 /
  §隧道数据面的端口分离
- 坑位：[PITFALLS.md](../PITFALLS.md) §隧道让回环判据失效
- 依赖的前序决策：[ADR-0009](ADR-0009-single-winner-interactions.md)（HITL 单胜方）