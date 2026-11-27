# 当前状态

- 日期：2026-11-27（**已发版 v2.17.5：帧上限失败体验、后台任务三帧、待处理提问 `questions` 帧、内核 RPC 超时归一**；上一版 v2.17.4 是 IPv6 支持、设备名同步与 App 下载二维码收口，v2.16.0 是多路配置码 + `open_tunnel_config` 回执改形，v2.15.0 是 dsh-Go 原生界面 + kernel-call 白名单放行 `skills/list`）
- **v2.17.5（2026-11-27）· 帧上限失败体验 + `questions` 帧 + 后台任务拉取帧**：
  `/ws/mobile` 入站单帧超过 `maxFrameBytes` 时，先发 `kind:'error'`（`code:'FRAME_TOO_LARGE'`、
  `retryable:true`、`details.limitBytes`）再以 `1009` 关闭；close reason 为
  `FRAME_TOO_LARGE limitBytes=…`。`/api/v1/events` 的帧格式没有 `kind:'error'`，只带 close reason。
  `hello.maxFrameBytes` 仍是唯一权威值，默认保持 1 MiB（未调大）。
  `questions` 帧与后台任务三帧使当前词表为**客户端 91 / 服务端 94 / 去重 129**；
  测试集 97 文件 / **1112 用例**（`npx vitest list`）。**验证**：`npx tsc --noEmit` 通过；
  相关 WS/协议 spec 通过；`docs:check` 四段通过。

- **已发版（v2.16.0，2026-11-22）· 多路配置码：一个 DSH1 同时带隧道 / LAN / 虚拟网**（`MOB-016`，
  issue IKX5K7）：用户提出「一个配置码支持多种链接，优先 LAN，再 P2P，不通再 Relay，最后隧道」。
  做法是把 `endpoints` 从「一个地址」变成**有序候选列表**：新增
  `composeCandidates({ port, tunnelUrl, tunnelLabel, explicit })`（`src/host/config-text.ts`），
  隧道排第一、其后本机探测到的 LAN / 虚拟网、地址去重；三个生成点（`/manage/config/text`、
  `/manage/cloudflare/create` 搭车 `configText`、IM `/tunnel` 复用分支）统一走它，不再「只塞隧道」。
  `POST /manage/config/text` 新增 body `includeTunnel`（缺省 `false`：只读动作不许偷偷拉起公网入口；
  没启用隧道回 `400 TUNNEL_DISABLED`、12 秒无地址回 `504 TUNNEL_URL_TIMEOUT`）。探测端口改为
  **实际监听端口优先**（原来回落 `3090`，改过端口的机器上候选全是死地址）。
  **顺序口径**：隧道在前是因为 `dsh-Chat` 的 `decodeDsh1` 只取 `endpoints[0]`（老装机量在），
  隧道在家在外都通；真正的「局域网优先」由客户端探活排序实现 —— `dsh-companion` 的
  `EndpointSelection.rank` 已是「LAN 延迟 ≤ 最快 ×1.5 即优先，其余按延迟」。
  **P2P 打洞与 TURN/Relay 不做**（桥是明文 HTTP/WS，拿不到 WebRTC P2P 通道；Relay 必须有服务器，
  用户口径「需要自建服务器就跳过」）；今天可用的直连是自备公网可达地址（DDNS + 端口映射 / IPv6）
  与虚拟网（`100.64/10`）。
  **`open_tunnel_config` 回执（issue IKX5N7）**：描述里加硬要求「把结果里那一行 `DSH1:` 原样放
  到回复第一行，不要代码块、不要重新折行，说明最多两句」；`output.render` 两块对调，第一块改成
  配置文本本身。起因是 2026-11-22 真机反馈：客户端新对话里 `/tunnel` 被当普通消息交给智能体
  （dsh-Chat#IKX5MV），模型先写一大段说明，配置码被挤到很后面，用户以为「没回配置码」。
  验收：`composeCandidates` 7 例 + `/manage/config/text` 与隧道搭车 4 例 + 隧道搭车改为多路断言 +
  `im-tunnel-command` 两例（render 首块是配置文本、描述含 verbatim / no code fences），
  95 文件 / **1073 用例**全绿。**真机部分验过**：dsh-Chat 已有会话里 `/tunnel` 直接回完整配置码
  （`command/done` 两条带全文），新对话里落回智能体是客户端短路；`dsh-companion` 在家选 LAN、
  出门落隧道的实际表现在客户端改完后待跑。
  客户端侧：`dsh-Chat` 仍只认 `endpoints[0]`，已单列 `MOB-017` 等客户端改探活排序。

- **已发版（v2.15.0，2026-11-22）· dsh-Go 原生界面：只读「接入」面板 + 状态条**（`MOB-015`）：
  `package.json` 新增 `dshGo` 清单（协议 v1、`panels.access` placement `features`、
  `composer.strip.remote` 点击开面板），新增 `src/host/dsh-go-panel.ts` —— 面板画监听地址/端口、
  `detectEndpoints()` 的接入地址、隧道状态与地址、授权根数量、已授权设备清单（名字/平台/型号/
  最近活跃），唯一动作是「复制接入信息」；`apply` 尾部 `ctx.inject(['dshGo'], …)` 注册，
  宿主无注入器 / 没装桥接 / 桥接拒绝注册三种情况只 warn，不让 `apply` 抛错。
  **只读是刻意设计**：dsh-Go 连接身份是内核客户端，与本插件设备表没有映射，放写操作等于让任意
  dsh-Go 客户端绕过管理面鉴权改安全状态（`SECURITY.md`）。数据来源是 10 秒轮询 + 内容签名去重，
  因为设备/隧道变化不在 `WorkspaceEventBus` 上广播，也不值得为只读面板改事件总线。
  验收：`tests/dsh-go-panel.spec.ts` 35 例；App 侧 `node sdk/plugin-kit/bin/check.mjs <插件目录>`
  判「原生界面能显示（状态条 1 · 面板 1）」，中英视图各自单检亦通过。**dsh-Go App 真机未联调**。
  **市场提交**：`plugins/dsh-remote-bridge.json` → 市场仓 PR
  [ccch1mneyyy/dsh-go-market#108](https://github.com/ccch1mneyyy/dsh-go-market/pull/108)（市场侧
  `scripts/check.mjs` 对本条目 `passed`、`dshGo.adapted: true`（`native-slots`）、risk `medium`；
  PR 上 `catalog` 绿，`auto-merge` 因 CodeRabbit 未跑完时 GraphQL 报 unstable 而失败 —— 与 #25/#60
  同一时序问题，等维护者手动合并）。**市场条目生效要等该 PR 合并后 publish 工作流重建索引**。

- **已完成（未发布，2026-11-20）· 协议面两级制：帧是唯一落点，REST 进弃用表**：
  按用户 2026-11-20 的口径（「REST 协议将逐步下线」）把文档制度补齐：`AGENTS.md` 新增 §1.1
  （四条铁律 + 三步弃用法 + 最早移除 3.0.0），§3.5 由方向说明改写为施工口径；`API.md` 新增
  「协议面状态与弃用表」（已弃用 21 条 REST → 替代帧 / 迁移中 13 条 / 永久例外 / 迁移指引）；
  `openapi.yaml` 给这 21 个 operation 标 `deprecated` + `x-dsh-replaced-by` +
  `x-dsh-removal-not-before`；`COMPATIBILITY.md` 加迁移矩阵；BFF 契约与 README 双站同步口径，
  `mobile-gateway-comparison.md` 标历史文档。**纯文档/契约标注，运行时零改动**。
  验收：`docs:check` 三段全绿（12 文档 / 53 tasks / 10 ADR / 锚点 134·145 双向一致），
  `capabilities` / `mobile-frame-contract` / `kernel-allowlist` 42 用例通过。
- **已完成（未发布，2026-11-20）· 客户端清单并列收录 dsh-Chat**：
  桥先前只承认 dsh-companion 一个受信任客户端。按「同一个桥、多个客户端」的定位补上第二个：
  `README.md`/`README.en.md` 客户端清单与下载页扩成两客户端（各 GitHub + Gitee 两条），
  `AGENTS.md` §1「与谁配」加「并列收录」一段（Flutter `app/` + HarmonyOS ArkTS `harmony/`、
  协议基线 ≥ 2.10.0、子协议 `dsh-mobile-v1`），`docs/project/COMPATIBILITY.md` 运行矩阵加
  dsh-Chat 行并**如实标「与 bridge 2.12.1 联调待实测」**，`docs/project/INTERFACES.md` 的
  `AppQrCode` 增加 `client` 字段。二维码由 `scripts/generate-app-qr.mjs` 生成（`qrcode` 编码 +
  `jsqr` 反解自验证，生成幂等），`TARGETS` 从 2 条扩到 4 条，新增
  `assets/app-qr-chat-{github,gitee}.{svg,png}`；「App 下载」卡改成两客户端两列，i18n 加
  `appDownloadClientsHint` 与带 `{client}` 的 alt 模板。验收：`pnpm check` exit 0（92 文件 /
  **1 003** 用例，docs:check 12 文档 / 53 tasks / 10 ADR、STRUCTURE 134 锚点、INTERFACES 145
  锚点双向一致），e2e 9/9，`assets/screenshots/panel-app-download.png` 重新生成。
- **已完成（未发布，2026-11-19 真机测试）· 安卓真机跑通内核调用面，并修掉两个「单测发现不了」的 bug**：
  ①**桥侧｜apply 期读目录，把「空」钉成事实**：`src/index.ts` 在 apply 期调一次
  `createKernelEndpointCatalog(...)`，而桥的 apply 早于各 `dsh-api-*` 注册 `@Remote` 端点
  （实测 0.2.2-rc.4）⇒ 目录读到空，并被钉进构造期 `capabilities` and
  `attachMobileRemoteServices(remote, catalog)`，`kernel-endpoint-catalog-v1` /
  `kernel-call-v1` 永远不发、`kernel-endpoints` 永远不推。修法：惰性解析（读到空不缓存）+
  `setCapabilityResolver`，`hello` 的能力位每次现算；`/ws/mobile` 的 hello 由 ws-handler 自己发，
  所以 `server.ts` 与 `ws-handler.ts` 两侧都要注入（只改 server 时用例仍红）。
  ②**伴生仓｜能力位竞态**：客户端能力位只来自 `connection.ready`，而 WS 事件通道一旦接管就关掉
  `/api/v1/events` 这条广播 WS —— 真机上出现过「WS 先接管，`connection.ready` 永远没送到」的时序，
  结果是内核调用入口整段不显示（桥明明宣告了）。修法：`MobileWsTransport` 把 `hello.capabilities`
  也交上去兜底（`onHelloCapabilities`），ViewModel 侧取**并集**。
  ③**伴生仓｜结果看不见**：内核调用的结果原本渲染在 23 条端点列表末尾（几千像素外），
  点完以为没反应；改为 args 下方渲染 + 结果到达自动回顶。
  ④**真机验收（vivo V2080A / Android 11 / 真内核 0.2.2-rc.4）**：hello 含两位能力位 →
  紧随 `kernel-endpoints`（23 条）→ 设置页出现「内核调用」节 → 调
  `pluginManager/listBundles` 得到真实 bundles、`pluginManager/registries` 正常回包；
  旧桥（3090）连接时该节按能力位隐藏（反证有效）。`session/search` 在本机部署被
  `session-query index openAt "never"` 关闭，如实记录为部署限制而非桥缺陷。
  ⑤**验收**：`pnpm check` exit 0（92 文件 / **1 002** 用例）；新增
  `tests/mobile-gateway-ws.spec.ts` ›「answers hello from the runtime resolver instead of the
  construction snapshot」；伴生仓 `:app:testDebugUnitTest` 全绿（`MobileWsTransportTest`
  新增「hello 宣告的能力位立刻交给界面兜底」）。
- **已完成（未发布，issue #26 完工检修，2026-11-19）· 对照竞品与三份审计的缺陷修复**：
  ①**S1 严重｜kernel-call 缺授权根维度**：白名单原来只有 `scope` 一维，桥用 owner peer ⇒
  内核 `remoteAccess.allows()` 对 owner 恒真（`dsh-typert-protocol` 的 `principalOf(owner)` 为
  undefined），默认配对设备（含 `chat.read`）可跨根读 `session/state` / `session/search` 与会话级
  `messageFeedback/*`。修法：白名单条目加 `sessions`/`filtersSessions` 第二维 +
  `KernelCallGuard.sessionVisible`（= `chat.isSessionAuthorized`）；不可见回
  `chat/session-not-found` 且不碰内核，`session/search` 结果逐条过滤。同批把
  `session/workspacePathApplications` 移出白名单（`chat.read` 可探测任意宿主路径存在性），
  白名单 **24 → 23**。
  ②**幂等三修**：键加 endpoint、只缓存成功、24 h 窗口由读取侧判（此前清理器在生产上没有调用方）。
  ③**`plugin-install-status` 的 `installId` 有来源了**：帧层 `requiredPayload` + `plugin-install`
  把 `installId` 落到 `options.requestId`，缺参回 `BAD_REQUEST`。
  ④**设备撤销/降权即时生效**：`handleMessage` 每帧复核 principal，撤销即 `close(4001,'Device revoked')`。
  ⑤**换源回归两处**：`isKernelServiceUnavailable` 同时认 `gateway/service-unavailable` 与
  `kernel/endpoint-unknown`（原先后者会让权限档位/提问回答整块 500）；
  目录为空时**回退进程内传输**（原先会把所有换源入口变成 `kernel/endpoint-unknown`）。
  ⑥**取消/超时语义**：`cancel()` 只对声明 `cancellation` 的端点生效（其余 `call/not-found`），
  单次调用 30 s 硬上限（`call/timeout`）。
  ⑦**验收**：`npx tsc --noEmit` exit 0；`npx vitest run` **92 文件 / 1 001 用例全绿**；
  `docs:check` 三段绿（STRUCTURE 134 / INTERFACES 145）；新增回归用例 9 条
  （kernel-call 22 / ws-kernel-frames 10 / dsh-0.2-bridge 59 / kernel-deltas 15 /
  mobile-gateway-ws 101）。⚠️ **真机未跑、REST 逐字段快照未做**，未通过前不得宣称已验证。
  ⑧**未修但已确认（下批候选）**：`session/search` 帧仍不在词表（内核有端点、竞品有帧）、
  子会话写、`defaults`/`set-default`、插件 4 条（`cancelInstall`/版本豁免/setPluginEnabled）、
  `agentTeams/setEnabled`、device-tools（竞品 29 工具 / 8 帧，属独立里程碑）。
  ~~队列读写~~ 已于 2026-11-21 落地（见下条 issue IKX1ZM）。
- **已完成（v2.14.0，issue IKX1ZM / `MOB-014`，2026-11-21）· 队列帧 + 目标 activation（dsh-Chat 对齐）**：
  ①**队列（能力位 `mobile-queue-v1`）**：新增 `src/host/ws-queues.ts` —— `session-queues` 读会话投影
  `inbox`（`next-turn`/`next-step`）归一成 `QueueEntry[]`（`inboxId`/`slot`/`mode`/`text`/`resendable`/
  `sourceKind`），`queue-update` 代理内核 `session/updateQueue`（`remove`/`steer`/`edit`），成功回
  `queue-updated` 带重读的整份队列；内核错误码原样透传，老内核回 `unsupported`。**不用
  `session/state`**：冷会话那里 `queue` 是 `null`，投影才是唯一稳定来源。
  ②**目标 activation（能力位 `mobile-goal-activation-v1`）**：`ws-goals.ts` 新增 `goals-get`（代理
  内核 `goals/get`，回 `GoalView | null` + 顶层 `activation`）；`goal-clear` 现在把内核返回的墓碑
  `ref`（revision = 清除前 + 1）与 `clearedAt` 一并回给客户端。
  ③**推送**：新增 `src/host/ws-pushes.ts` 的 `SessionPushes` —— 按会话去抖 80 ms 后整份重读、
  按连接签名去重、按订阅集合过滤、逐连接授权判定；`queue-item-updated` 随 turn start/end/failed、
  消息提交、`agent/inbox/spliced`、本地写成功与新订阅首屏；`goal-updated` 随 `goal/*` 事件与写成功，
  并带移动端最关心的 `activation`；`goal-clear` 之后用**墓碑**（同 id 且 revision ≤ 墓碑）把
  迟到的旧快照压成 `goal:null` + `clearedAt`，客户端不闪回。
  ④**顺带修的既有 bug**：`GoalsHandler.mutateGoal` 的越权检查写成了
  `if (!this.chat.isSessionAuthorized(...))`（漏 `await`，`!Promise` 恒 false ⇒ goal 写从来没做过
  会话授权判定），已改为 `if (!(await ...))`。
  ⑤**首屏**：`history` 在 `beforeSeq` 缺省时额外带 `queue`，翻页不带。
  ⑥**验收**：`npx tsc --noEmit` exit 0；`npx vitest run` **93 文件 / 1 021 用例全绿**（新增
  `tests/ws-queues.spec.ts` 9 例 + `mobile-gateway-ws.spec.ts` 队列/目标 9 例）；`docs:check` 三段绿
  （STRUCTURE 136 / INTERFACES 145）。⚠️ **真机 dsh-Chat 未跑**，四步排队/目标回归未做，未通过前不得宣称已验证。
- **已完成（未发布，issue #26 阶段 9 / `MOB-013`，承接旧 issue #9）· `chat-adapter.ts` 按端点族拆分**：
  ①**纯搬移、零行为变化**：2 110 行单文件 → 装配根 `src/host/chat-adapter.ts`（**92**）+
  `src/host/chat-contracts.ts`（**570**）+ `src/host/chat/` 五族（`access.ts` 555 / `sessions.ts` 515 /
  `hitl.ts` 374 / `content.ts` 204 / `models-commands.ts` 163），**六个模块全部 ≤600 行**。
  ②**公开面没有变宽**：每族是 `export const xxxMethods = { async m(this: ChatAdapterInternals, …) }`
  对象，装配根在 class 之后 `Object.assign` 到原型；`interface DshChatAdapter` 的合并声明只含
  五个 `*Methods` 的公开方法 —— 13 个原 `private` 辅助只能在 `ChatAdapterInternals` /
  `*InternalMethods` 上见到。类名、构造签名、公开方法签名逐字不变；31 个 `src/` + 25 个
  `tests/` 导入方**一行未改**，对外仍可从 `chat-adapter.ts` 导入全部旧导出（`export *` +
  具名 re-export；旧 34 个导出 0 缺失，新增 12 个只是可见性放开）。
  ③**验收**：`npx tsc --noEmit` exit 0；`npx vitest run` **92 文件 / 987 用例全绿**、
  **未改任何 `tests/` 文件**；搬运校验脚本逐块归一化比对 **65 项一致 / 0 项不一致**
  （49 个类方法 + 10 个家族内 helper + contracts 顶层 478 行 + 5 个纯函数），类头块与原
  484–518 行**逐字节相同**（`sessionVisibility` 的 2 秒 TTL 长注释原样保留）；
  `npx tsx scripts/check-project-docs.ts` 双向锚点零差异。**未做**：真机（本阶段无 wire 改动），
  Kotlin SDK 无改动。
- **已完成（未发布，issue #26 阶段 8 / `MOB-012`）· 收敛：删掉只回 `NOT_IMPLEMENTED` 的 5 个声明**：
  ①**删的是声明不是功能**：`search` / `defaults` / `set-default` / `queue-update` / `directories`
  在词表里活了几个阶段，行为一直是「结构化 `NOT_IMPLEMENTED` + REST 兜底指引」。声明一个永远不工作的帧
  等于把「能力暂缺」当承诺，客户端会据此生成一个点不动的入口 —— 阶段 8 把它们从 `ClientFrameType`
  与 AsyncAPI enum 删除，再发送与拼错帧同路，回 `UNKNOWN_TYPE`。`ws-handler.ts` 的
  `KNOWN_UNSUPPORTED_FRAMES` 随之清空（保留空表与注释：阶段 8 后没有兜底帧；插件族仍可能回
  `NOT_IMPLEMENTED`，缺的是连接/宿主能力）。
  ②**帧面（实测）**：客户端 88 → **83**、服务端 **84**（不变）、去重 123 → **118**；union 与 AsyncAPI
  enum **双向零差异**（解析脚本与 `docs:check` 的帧对账段口径一致）。
  ③**契约与文档同批**：`asyncapi.yaml`（enum −5、channel 描述改写为「阶段 8 移除」、顺带修正
  「`error` 帧都带 `requestType`」这处既有过度表述）、`API.md`（删 `search`/`queue-update` 两整行、
  `agent-presets` 与目录合并行收回说明、服务端表括注同步、表后加「阶段 8 删掉的声明」）、
  `mobile-gateway-comparison.md` 待办措辞同步；`tests/mobile-gateway-ws.spec.ts` 改成
  「5 个已删名字断言 `UNKNOWN_TYPE` + `plugin-catalog` 仍断言 `NOT_IMPLEMENTED` 且带 `requestType`」。
  ④**验收**：`npx tsc --noEmit` exit 0；`npx tsx scripts/check-project-docs.ts` 三段全绿
  （帧对账 client 83 / server 84 双向零差异）；`npx vitest run tests/mobile-frame-contract.spec.ts
  tests/mobile-gateway-ws.spec.ts` 122 例全绿（22 + 100）。**未做**：真机（本阶段无行为面）；
  Kotlin SDK 无改动（`grep` 证明 SDK 本就没有发送这 5 个帧的入口），因此**不得宣称已在手机上验证**。
- **已完成（未发布，issue #26 阶段 7 / `MOB-011`）· 补齐插件与排程帧**：
  ①**帧词表**：客户端 +11（插件 `plugin-detail`/`plugin-install-status`/`plugin-remove`/
  `plugin-update`/`plugin-versions`/`plugin-registries` + 排程 `schedule-create`/`schedule-edit`/
  `schedule-view`/`schedule-run`/`schedule-delete-inactive`）→ **88**；服务端 +15 同名应答 kind
  （请求与应答共用词表，`data` 统一 `{ok,value}` / `{ok,error:{code,message}}`）→ **84**；去重 **123**。
  ②**通用面落地，不抄第二套语义**：`kernel-allowlist.ts` 的 `KERNEL_FRAME_CALLS` 是「帧 → 内核端点」
  的唯一映射（十个插件帧 → `pluginManager/*`），处理器 `KernelFrameHandler` 经**同一个**
  `KernelCallService`（默认拒绝 + 设备 scope 判据 + 在飞表 + 幂等）—— 白名单同时扩到 24 条。
  排程五帧走 `ws-schedule.ts` 的直通表，`{request}` 原样进内核。
  ③`plugin-catalog`/`plugin-inspect`/`plugin-install`/`plugin-settings` 四条从结构化
  `NOT_IMPLEMENTED` 升级为真实现；旧连接（未协商 `dshrb-v1`）仍拿到 `NOT_IMPLEMENTED`，
  与阶段 5 的 `kernel-call` 面同一判据。④**验收**：`pnpm check` 全绿（92 文件 / 987 用例），
  `docs:check` 帧对账 client 88 / server 84 双向零差异。**未做**：REST 逐字段快照对比与 6 项真机清单
  （本机无真机、无内核 CLI 会话），因此**不得宣称已在手机上验证**。
- **已完成（未发布，issue #26 阶段 6 / `MOB-010`）· 契约同步与跨仓**：
  ①**本仓五处同步**：`docs/api/asyncapi.yaml` 两个 enum 各 +2 成员、4 个帧 schema 与
  「`dshrb-v1` only」说明；`docs/project/API.md` 四行帧表 + 能力位判据改成「白名单 ∩ 内核目录 非空」
  + `kernel-call-result` 不回显 `requestId` 的理由；`docs/project/INTERFACES.md` §3.5 补
  `dshrb-v1` 协商段与 `hello` 后目录帧的时序。**OpenAPI 一行未动**（本阶段不新增 REST 端点）。
  ②**Kotlin SDK**：`MobileGatewayClient.kt` 444 → 779 行 —— 四帧 + `MOBILE_PROTOCOL_KERNEL`、
  `supportsKernelCall()`（读 `hello.capabilities`）、`awaitKernelEndpoints()`、`callKernel()` /
  `cancelKernelCall()`；三个前置条件都在**发帧之前**判（缺能力位抛
  `IllegalStateException("kernel-call-v1 is not advertised by this bridge")`，不静默挂起），
  `args` 为空时整段省略。`DshWorkspaceClient.kt`（REST）无改动。
  ③**姊妹仓 `dsh-companion`**（工作树改动，**未提交**）：`WsFrames.kt` 两进两出四帧 +
  `WsSubprotocol` 追加 `dshrb-v1`（首项仍是 `dsh-mobile-v1`）、新增 `KernelCallClient`
  （自建 `callId → Deferred` 配对表）、设置页「内核调用」节（缺 `kernel-call-v1` 时**整节不组合**）、
  单测 +21 例、计数同步 93 类 / 991 例。
  ④**坑位**：`PITFALLS.md` +5 条、`AGENTS.md` §6 索引同步（双向机检绿）。第 4 条已如实写明
  「`agentPresets.select` 的先 `agentFor` 目前无用例认领」这一缺口。
  ⑤**验收**：`pnpm check` exit 0（90 文件 / 969 用例，无新增 TS 用例）；Kotlin `compileKotlin`
  BUILD SUCCESSFUL；姊妹仓 `bash scripts/build.sh :app:testDebugUnitTest` BUILD SUCCESSFUL。
  **未做**：6 项真机清单；姊妹仓改动未提交未推送 —— 未跑之前不得宣称已验证。
- **已完成（未发布，issue #26 阶段 5 / `MOB-009`）· 通用内核调用面**：
  ①**唯一执法点** `src/host/bridge/kernel-allowlist.ts`（205 行）：14 条 unary 白名单，12 个
  高危命名空间（terminal/sandbox/dynamicCordisRunner/workspaceFiles/fileUploads/settings/
  credentials/account/liveshareShares/cuaAccess/forgePanel/agentTeams）钉死在内核里调不到；
  `authorizeKernelEndpoint` **先默认拒绝、再查 scope** —— 顺序反过来就等于送一个免费的存在性探针。
  ②**执行器** `src/host/bridge/kernel-call.ts`（262 行）：授权 → 幂等回放 → 同 `callId` 在飞行拒绝
  → 目录查找 → 本地参数校验 → `invoke`/`stream` → 归一错误；流式端点收集到 64 帧（`truncated`），
  取消/中止结算为 `call/cancelled`（**不进幂等**，重试应真重试）。
  ③**四个新帧** `kernel-call` / `kernel-call-cancel` / `kernel-call-result` / `kernel-endpoints`
  （`ws-protocol.ts` 客户端 75→77、服务端 67→69），**只在 `dshrb-v1` 子协议下启用**：
  `ws-kernel-call.ts`（131 行）按连接一套（取消与在飞行表天然隔离），`hello` 之后推一帧目录；
  清单里没有 `dshrb-v1` 的连接发这两帧只会拿到 `NOT_IMPLEMENTED`，能力面与行为与今天逐字相同。
  ④**能力位 `kernel-call-v1` 开始发**：内核网关与连接服务都在**且**白名单里至少一条在内核目录中；
  只是目录非空不发位（「能调但每次被拒」比不声明更糟）。
  ⑤**验收**：`tests/kernel-allowlist.spec.ts` 10 例 / `tests/kernel-call.spec.ts` 14 例 /
  `tests/ws-kernel-call.spec.ts` 11 例 / `tests/mobile-gateway-ws.spec.ts` 新增 3 例端到端
  （hello→目录顺序、白名单拒、老连接 `NOT_IMPLEMENTED`）；`pnpm check` exit 0。
  **未做**：REST 响应逐字段快照（本阶段没有 REST 变更）与 §1.4 的 6 项真机清单 —— 未跑之前不得宣称已验证。
- **已完成（未发布，issue #26 阶段 4 / `MOB-008`）· delta 收口 + 永久留桥登记 + 门面瘦身**：
  ①**11 条 delta 逐条命名**：新增 `src/host/bridge/kernel-deltas.ts`（263 行），过滤子会话、补
  `trust:'system'`、`active` 标记、容量字段、冷会话短路、子会话地址、`beforeSeq` 分页、投影回退、
  摘 `locale`、图片交接、错误码映射各一个纯函数，`tests/kernel-deltas.spec.ts` 14 例逐条断言。
  ②**门面瘦身**：端点视图搬进 `src/host/bridge/kernel-views.ts`（429 行），`*Like` 契约搬进
  `src/host/bridge/kernel-contracts.ts`（474 行），`kernel-services.ts` 592 → **122 行**，
  门面 `src/host/dsh-0.2-bridge.ts` 775 → **304 行**（目标 ≤450）。`TECH-DEBT.md` 里门面那一行
  **按「债务消失即删条目」移除**（表 12 → 11 行）。
  ③**4 条永久留桥登记**：`ADR-0010` 改 `accepted` 并加落地登记表；`SECURITY.md` 新增
  §内核端点归一（4 条留桥 + 5 条可证伪断言），每条都点名认领测试。`userQuestions.cancel`
  此前没有专门用例，本阶段补 `tests/dsh-0.2-bridge.spec.ts` ›「cancels a bridged front-of-house
  question through userQuestions.cancel」（撤销的可观测证据是 `userQuestions/dismissed` 帧）。
  ④**机检**：TypeScript AST 扫门面 —— 数组字面量或对象属性值里凑出 ≥2 个端点名即红；
  箭头函数体跳过（端点名作为调用参数出现是正常写法，第一版误判过整个 `bridge` 对象）。
  ⑤**未做的验收**：REST 逐字段快照与 6 项真机清单本机无法执行，与前几批同样标注，**不算通过**。

- **已完成（未发布，issue #26 阶段 3d / `MOB-007`）· 附件/prompt/models/userQuestions 换源**：
  ①**换源**：`sessions.uploadAttachment` → `fileUploads/upload`、`sessions.readAttachment` →
  `session/attachment`、`sessions.prompt` → `session/prompt`、`sessions.models` 的两读 →
  `session/modelCatalog` + `session/projections`、`userQuestions.answer` → `userQuestions/answer`。
  ②**`prompt` 删掉与内核重复的绑定**：桥此前自己做 `bindPrompt` → `commit`，内核 `commands.prompt`
  内部已经做了同一件事，双重绑定必须消失；桥仍保留 `requestId` 铸造、`locale` 摘除与
  `handoffImagesForTextOnlyModel` 的图片交接改写。
  ③**`readAttachment` 两层留桥**：内核只认完整五字段 ref 且**不校验引用关系**，所以
  `resolveImageRef` 补齐 + 「本会话历史引用过」判定仍在桥（App 契约不变）。
  ④**`models` 留桥**：冷会话 `resolveAgent` 前置（命令发现依赖它）、`current` 选择语义、
  容量字段 `enrichModelGroups`。
  ⑤**`userQuestions` 半留桥**：`answer` 走端点，前台挂起表那半留着；端点找不到 `callId` 时
  **返回 `false` 不抛**，桥据此转挂起表；服务缺席（`gateway/service-unavailable`）静默走挂起表。
  ⑥**已知行为变化**：`uploadAttachment` 不再在门面预解析 Agent（否则同一个 `resolveAgent` 跑两遍），
  冷会话上传的错误码从桥的 `session/agent-unavailable` 变成内核的解析错误 —— 真机要重点看
  「冷会话上传附件」这条。
  ⑦**测试**：`tests/dsh-0.2-bridge.spec.ts` 56 例里仅「binds file receipts…」一条被改写
  （它断言的正是本批删掉的重复绑定），其余 55 例一行未改；`kernel-local` 目录 31 条。
  ⑧**未做的验收**：REST 逐字段快照与 6 项真机清单本机无法执行，**开真机前不算通过**。
- **已完成（未发布，issue #26 阶段 3c / `MOB-006`）· 模型目录与预设面 6 条换源**：
  ①**换源清单**：`llm.providers` → `llm/listConfigurableProviders` + `llm/listProviders`（并发取、id 求交得
  `active`）、`llm.models` → `session/modelCatalog`、`llm.discoverModels` → 同名端点（两顶层参 + cancellation）、
  `agentPresets.list` → `agentPresets/list`、`agentPresets.select` → 同名端点（**scope=agent**，`agentId` 装会话 id）、
  `permissionPresets.catalog` → 同名端点（无参）。
  ②**保留的三个语义**：`trust:'system'` 补齐（缺了 Android 预设列表整份解码失败）；`contextWindow`/`maxTokens`
  仍由 `enrichModelGroups` 从 `llm.resolveModelInfo` 补（**它不是端点**；用 `llm/discoverModels` 顶替不等价）；
  `agentPresets.select` 仍先 `agentFor` 要求 live Agent —— 内核端点的 agent lookup 会**隐式 resume 冷会话**，
  这是一条**已知行为差异**，3c 刻意不放开来（真机重点看冷/热两种路径）。
  ③**新增 `isKernelServiceUnavailable(error)`**（`bridge/kernel-invoke.ts`）：真网关与进程内传输在「服务整条
  缺席」时抛同一个码 `gateway/service-unavailable`，`permissionPresets.catalog` 据此走
  `FALLBACK_PERMISSION_CATALOG` 降级，其余错误照旧上抛。
  ④**既有用例一行未改**：6 个 spec / 98 例全绿（含权限档位降级/以内核为准两条方向用例、preset 的 trust 用例）。
  ⑤**未做的验收**：REST 逐字段快照与 6 项真机清单本机无法执行，**开真机前不算通过**。
- **已完成（未发布，issue #26 阶段 3b / `MOB-005`）· 写侧与设置面 9 条换源**：
  ①**换源清单**：`workspace.create`/`rename`/`delete`/`archiveSession` → 四个同名写侧端点（单参），
  `settings.describe` → `settings/describe`（**无参**，走 `invokeBareEndpoint`）、`settings.mutate` →
  `settings/mutate`（**三个顶层参** `ns`/`ops`/`expectedRevision`）、`credentials.describe` →
  `credentials/describe`（顶层数组 `refs`）、`credentials.set` → `{ref, value}`、`credentials.unset` → `{ref}`。
  ②**本批第一次实战「参数不是一个 request 对象」**：wire 键全部由描述符给，调用点只提供值；键名写错
  会在桥内被 `assertKernelArguments` 当场拒，不会拖到内核才炸。
  ③**`kernel-local.ts` 从 payload 化改成 args 化**（20 条表项）：原来进程内传输只收单个 wire 键，
  3b 起的端点有 2~3 个顶层参，故改成「按描述符把参数集交给宿主方法」，并补 `assertWires` 做与内核
  `assertExactArguments` 同一条「拒多余键」判定 —— 少了它，「多传一个键」会在单测里假绿。
  ④**既有用例一行未改**：`dsh-0.2-bridge` / `settings-adapter` / `approval-timeout` /
  `frame-hub-backpressure` / `handoff-hardening` / `kernel-local` 6 个 spec、98 例全绿。
  ⑤**`workspace.archiveSession` 的 delta**：`stopActivity` 缺省语义仍由内核判（缺省报
  `workspace/session-active`），桥不替它决定。
  ⑥**未做的验收**：同 3a —— REST 逐字段快照与 6 项真机清单本机无法执行，**开真机前不算通过**。
- **已完成（未发布，issue #26 阶段 3a / `MOB-004`）· 会话/工作区读侧 10 条换源：桥不再直接调宿主方法**：
  ①**换源清单**：`sessions.list` → `session/list`（wire 键是 `_request`）、`sessions.create` →
  `session/create`、`sessions.history` → `session/follow`（流式取首帧 snapshot，带 `beforeSeq` 时改走
  `session/page`）、`sessions.projections`/`wait`/`selectModel`/`rename`/`fork`/`cancel` → 同名端点、
  `workspace.list` → `workspace/follow`（流式取首帧 `baseline` 后**立刻 abort**，不挂常驻 follower）。
  换源点只写端点名，wire 键由描述符给 —— 调用点不再出现 `{ _request: payload }` 这种手抄。
  ②**保留的 delta**（逐条写在调用点注释里）：`list` 过滤 `origin === 'subagent'`；`history` 的子会话
  地址构造 + 投影读不到的兜底；`wait` 的 `timeoutMs` 仍 +5 s（外层 RPC 超时必须比内核宽）；`workspace.list`
  的 `archivedSessionIds` 空集时仍从注册表补一次。
  ③**新增 `src/host/bridge/kernel-local.ts`（进程内传输）**：`typertGateway` 是可选服务，单测里更是从不存在；
  缺它时把**同一套端点语义**直连宿主服务（`createLocalKernelGateway(host)`），参数校验/错误归一/取消透传
  仍走 `kernel-invoke.ts` 一条实现。**两条传输、一套语义** —— 换源点不感知走哪条。没有这条路，既有的
  62 处 `createDsh02ApiProxy(host)` 就都得改成自己搭假网关（那等于让断言迁就实现）。
  ④**既有用例一行未改**：`tests/dsh-0.2-bridge.spec.ts` / `approval-timeout` / `frame-hub-backpressure` /
  `handoff-hardening` 4 个 spec、78 例全绿。这是施工卡的硬验收项 —— 换源不许靠改断言变绿。
  ⑤**防漂移**：本地表的 wires 是手写的，`tests/kernel-local.spec.ts` 在本机装了内核时逐条比对
  「本地表 vs `typert.host.js` 描述符」的 wires/stream/cancellation（CI 无内核整段 skip）；首轮就抓出
  `session/list` 漏写 cancellation。
  ⑥**未做的验收**：施工卡要求的「该族 REST 响应逐字段快照相等」与「§1.4 的 6 项真机清单」本机无法执行
  ——**没有真机、也没有上一版本可比对的响应快照**。这两项在开真机前不算通过，不得对外说「换源已验证」。
- **已完成（未发布，issue #26 阶段 2 / `MOB-003`）· 描述符驱动的统一调用封装（不改任何端点行为）**：
  ①**目录只读**：`src/host/bridge/kernel-endpoints.ts` 从 Typert 登记表（`ctx.typert.local.list()`，
  经 `ctx.reflect.get('typert', false)` 取 —— `inject` 一行没加）抽 `KernelEndpoint`：endpoint /
  namespace / method / **wire 键** / JSON Schema / 是否流式 / 是否声明 cancellation。`optional` 的判定
  与内核 `assertExactArguments` 的 `acceptsMissing` 逐字一致（`source === 'json'` 且
  `acceptsUndefined === true || codec.mode === 'src-json'`），否则「可省略」两边会吵架。读取**永不抛**：
  登记表缺席、`list()` 抛错一律回空目录 —— 目录读崩不能把插件的 `apply` 带下水。
  ②**本机 224 个端点逐条自证**：`tests/kernel-endpoints.spec.ts` 动态 import 全部
  `@deepseek-ai/dsh-api-*/lib/typert.host.js` 的 `TYPERT.invocations`（18 个包），断言「目录条目数 ===
  描述符数」且 20 条代表端点的 wire 键/流式/cancellation 与硬编码期望逐条相等（`session/list` 的
  wire 键是 `_request`、`settings/mutate` 是三个顶层参 —— 手抄就会错在这两处）。内核不在机器上时
  该段整体 `skipIf`，CI 不受影响。
  ③**调用封装**：`src/host/bridge/kernel-invoke.ts` 提供 `assertKernelArguments`（多传/漏传在**进内核前**
  本地拦下，文案与错码 `gateway/arguments-invalid` 与内核逐字一致）、`wrapRequestArgument`、
  `kernelCallSignal`（只有描述符声明了 cancellation 才把 `AbortSignal` 下传）、`invokeKernelEndpoint` /
  `streamKernelEndpoint`、`kernelRpcError`（**直接委托** `bridge/rpc.ts` 的 `toRpcError`，错误码与今天
  `call()` 逐条等价只有一份实现）。20 个用例，含「参数被拦时 `caller.calls` 为空」——证明拦截发生在
  本地而不是靠内核兜底。
  ④**能力位随探测给**：`kernel-endpoint-catalog-v1`（目录非空才发）与 `kernel-call-v1`（白名单未落地，
  **恒不发** —— 声明一个没人能服务的面比不声明更糟）。规则收在 `kernelCapabilityFlags()` 一个函数里，
  两侧测试钉住「探测不到 ⇒ 不给位、给位 ⇒ 目录非空」。
  ⑤**子协议位置无关**：`server.ts` 的 `handleProtocols` 用 `pickMobileSubprotocol` 从客户端清单里挑
  `dsh-mobile-v1`（协商结果恒为该值）。此前要求「首项必须是它」，而 `ws` 默认回**首项** —— 客户端
  只要排过一次序（把 `dsh-auth.*` 排前面）就被 4001 掉。**踩坑**：直接返回 `false` 会让 `ws` 不发
  `Sec-WebSocket-Protocol` 响应头，客户端拿到的是握手失败（1006）而不是 4001，等于把可控拒绝变成
  连接异常；正确做法是挑不出认识的协议时**退回原行为**（回首项），再由 `onConnection` 关 4001。
  `pnpm check` exit 0；`vitest run` **85 文件 / 907 用例**全绿（新增 `kernel-endpoints` 17 例、
  `kernel-invoke` 20 例、能力位 2 例、子协议 2 例 + 既有 4001 用例未改一行）；
  `docs:check` 12 文档 / 53 tasks / 10 ADR / STRUCTURE 119 锚点 / INTERFACES 104 锚点。
- **已完成（未发布，issue #26 阶段 1 / `MOB-002`）· 帧词表收口：`SendFrame` 从 `{kind: string}` 收成真联合类型**：
  基线实测 `ClientFrameType` 70 / `ServerFrameKind` 66 / 去重 114，与 issue 的起点一致；`asyncapi.yaml` 的
  client enum 75、server enum 78 —— **契约比实现宽**，而 `tsc` 完全看不见（发帧回调的签名就是 `string`）。
  ①**发帧签名只有一个来源**：`ws-protocol.ts` 新增 `export type SendFrame = (frame: ServerFrame) => void`
  与 `ServerFrame { kind: ServerFrameKind; data?: unknown }`（原 `kind: string` + 索引签名）；13 个域处理器
  各自声明的 `(frame: { kind: string; data?: unknown }) => void`（含 `TransferSendFrame` / `MobileFrameSink`）
  全部删掉改成导入 —— 现在「发一条没声明的帧」是**编译错误**，不再等客户端把未知 kind 丢掉才发现。
  ②**两侧对齐**：服务端删 11 个「声明但从没发过」的死声明（`question-requested` / `question-resolved` /
  `approval-requested` / `tasks-updated` / `goal-updated` / `session-title-changed` / `queue-item-updated` /
  `session-archives` / `session-queues` / `session-queue` / `search`），补 12 个「真发但未声明」的
  （`paired` / `host` / `models` / `default-model` / `providers` / `permission` / `permission-options` /
  `agent-presets` / `fork` / `workspace-create` / `session-stats` / `context-usage`）；客户端补 5 个
  （`fork` / `workspace-create` / `file-list` / `directory-create` / `directories`）。**收口后 75 / 67 / 去重 108**，
  与契约 enum 逐条零差异（脚本双向核对：code-only 空、contract-only 空）。
  ③**issue 的计数差一帧**：issue 把 `connection-resync-required` 也当成死声明（目标 66 / 107），但它是真发的
  —— `ws-handler.ts:827` 在反压溢出后用 `RESYNC_REQUIRED_KIND` 补发，`tests/mobile-gateway-ws.spec.ts:2209`
  的用例正断言它。按「行为才是真值」保留该帧，故为 67 / 108；issue 的验收口径（两个白名单为空、两侧零差异）
  不受影响。
  ④**顺带清掉两处同类漂移**：`REQUEST_ID_ECHO_EXCLUDED_KINDS` 里挂着 7 个永不发生的 kind、
  `REBUILDABLE_SERVER_KINDS` 里 4 个（只剩 `event` 真的可重建）；两张表改成 `readonly ServerFrameKind[]`
  字面量 + `Set`，写错名字以后是类型错误。`RESYNC_REQUIRED_KIND` 也标成 `ServerFrameKind`。
  ⑤**白名单清空**：`scripts/check-project-docs.ts` 与 `tests/mobile-frame-contract.spec.ts` 两处
  `MOBILE_*_ONLY_IN_CONTRACT` 都改成空数组，「只许变短」的断言保留 —— 谁再往契约里加代码没有的帧，
  就得先补联合类型。`TECH-DEBT.md` 的 **DEBT-005 按清账删除**（不是标「已修」）。
  **手机协议零改动**：换源阶段不让 App 感知，本阶段只是让类型与既有契约对齐；删掉的死声明从来没发到过线上。
  `pnpm check` exit 0；`vitest run` **83 文件 / 866 用例**全绿（`tests/mobile-frame-contract.spec.ts` 22 例断言集合未变、
  白名单断言仍在）；`docs:check` 12 文档 / 53 tasks / 10 ADR / STRUCTURE 117 锚点 / INTERFACES 92 锚点。
  **真机端到端未做**（本阶段不动 wire 形状，风险面在类型层）。
- **已完成（未发布，issue #26 阶段 0 / `MOB-001`）· 地基四件：CI 矩阵对齐、隧道端口分离、手机状态核对、债务台账补登**：
  ①**CI 矩阵与 `engines.dsh` 不一致**：`package.json` 声明 `>=0.2.2-rc.1 <0.3.0`，集成 job 却 checkout
  上游 `687f282e`（0.2.1-rc.2）—— 声明区间与实测区间对不上，任何依赖新内核服务的改动都会在 CI 上「假绿」。
  已改成 **0.2.2-rc.1 + 0.2.2-rc.4 两档矩阵**（钉 commit 不钉 tag），并同步 README 双站的「开发基线」措辞。
  ②**隧道把管理面暴露到公网**：cloudflared 原来整端口转发主监听（`--url http://127.0.0.1:3090`），
  隧道下 `/manage/**` 与数据面同源可达，只能靠「隧道开着就禁用管理面」这一条进程状态判据挡；
  而外部反代 / SSH 转发绕得过去（判据 0 不知道它在跑）。已改：新增只绑回环、端口由系统分配的
  **隧道专用数据端口**（`src/host/tunnel-listener.ts`，215 行），只放行 `/api/v1/**` 与 `/ws/mobile`，
  `/manage/**` 在该端口上**根本没有路由**（`404`，不是 403 —— 403 等于承认路由存在）；
  进入分派前剥掉 `X-Dsh-Workspace-Admin` ⇒ 经隧道永远拿不到回环管理员身份。cloudflared 只指向它，
  端口号由代码定死（`status().tunnelPort`），`create` 不接受调用方指定；端口未就绪回 `503 TUNNEL_PORT_UNAVAILABLE`。
  放行 `/api/v1/**` 而不是只放 WS 是刻意的：手机端用**同一个基地址**承载 REST 与 WebSocket，
  只放 `/ws/mobile` 会让经隧道的 REST 全挂。
  ③**手机状态附消息**：桥侧早已就位（`ws-basic.ts` 的 `clientTimeZone`/`locale` 透传）⇒ 桥零改动，App 侧待改。
  ④**债务台账漏登 6 个超预算文件**（`server.ts` 1040 / `cloudflared.ts` 707 / `bff-schedule.ts` 684 /
  `i18n.tsx` 675 / `ws-protocol.ts` 636 / `plugin-inventory.ts` 605）：看不见的债等于没有债，
  已按 `wc -l` 实测补登「为什么是债」+「清账阶段」，`src/` 下全部 >600 行文件（12 个）现已入表。
  **手机协议零改动**（阶段 0 不动 REST 路径、不动帧名、App 不用发版）。
  回归用例：`tests/admin-loopback-escalation.spec.ts` 17 → **20 例**（新增「隧道端口上管理面一律 404」
  与「隧道端口上数据面照旧可用（含 `/ws/mobile` 握手收到 `hello`）」）。全量 `vitest run` 83 files / 866 tests 绿。
  **真机端到端未做**（隧道端口经真实 cloudflared 的连通性未验证）。
- **已完成（v2.12.1，2026-11-19）· 大文件上传改走内核流式附件通道（issue #23）**：
  100 MiB 上传把桥所在进程（= 宿主进程）的内存峰值推到 **5.67 倍**（100 MiB → 567 MiB）——
  不报错、不掉连接、不留日志，只是安静吃内存然后 OOM。根因两处「全量化」：
  `ws-file-transfer.ts` 的 `uploadFinish` 校验 SHA-256 后 `readFile(spool).toString('base64')`，
  `bff-upload.ts` 的 `complete` 逐块 `readFile` → `Buffer.concat` → `toString('base64')`
  （结构下限 ≈4.67N）。内核早有流式入口 `ctx.fileUploads.uploadStream(...)`
  （`attachments.saveFileStream` 逐块写临时文件、内存有界），桥一直没用。已改：两个入口都
  「先试流式、不能流式才回落 base64」，回落由**还握着字节的那一层**做（WS spool / REST 分块文件
  可重读），内核适配层拿到一次性 `AsyncIterable` 只能报稳定 code
  `FILE_UPLOAD_STREAM_UNSUPPORTED`；流式 RPC 超时放宽到 10 分钟（不能设无限）。
  100 MiB 实测峰值超基线 WS **327.1 → 2.5 MiB**、REST **435.2 → 46.6 MiB**（量 `VmHWM`）。
  **App 零改动**（`file-upload-completed` 帧字段与 `receiptId`/`attachmentId`/`bytes` 照旧）；
  回归用例 `tests/ws-file-transfer.spec.ts` 2 条 + `tests/bff-rest.spec.ts` 1 条。
  **真机端到端未做。**
- **已完成（v2.12.1，2026-11-19）· 隧道工具的 `output.schema` 回到内核接受的子集（issue #22）**：
  IM 里让 agent「开个隧道」，工具在**模型可见列表里根本没有**，插件日志只有一行 warn。
  根因：`im-command.ts` 的 `createTunnelTool` 把 `required: true`（布尔）写在**属性节点**上，
  而内核 `ToolsService.register` 无条件调 `assertSupportedJsonSchema` —— `required` 只能出现在
  `type:'object'` 节点上、顶层 `required` 必须是属性名字符串数组，两条都违反 → 注册抛错 →
  插件侧吞成 warn → 工具静默消失。已改：属性节点去掉 `required`、顶层改成
  `required: ['url','text','deviceName']`（三个返回值字段仍全必填）。
  回归用例 `tests/im-tunnel-command.spec.ts` 新 1 条（内联最小判据，不 import `@deepseek-ai/*`）。
  **真机 IM 调用未做。**
- **已完成（v2.12.0，2026-11-17）· 工具调用实时事件透传（`chat.tool.call` / `chat.tool.result` / delta kind 扩展）**：
  `normalizeDshEvent` 此前把 `tool-call-delta` 与 `tool/call`/`tool/result` 全部落兜底分支丢
  `event.data`——App 工具行无 preparing 态、失败无内核错误分类、结果靠防抖重拉历史。已改：
  delta 扩 `tool-call`/`tool-call-end` 两种 kind（宽容透传），tool 两类事件 `data` 原样透传；
  exit code 不做协议字段（官方从结果文本尾部标记解析）；「始终允许」键不做（内核 OUTCOMES 无
  always、官方未接线）。五处契约面同步（API.md/asyncapi/INTERFACES/kotlin-sdk 注释 +
  chat-adapter.spec 新 2 组用例）；详见 CHANGELOG-DEV v2.12.0 段。**已随 v2.12.0 发版并推送**
  （Git + npm 双渠道）；dsh-Chat 两端客户端消费见另一仓库同日提交。
- **已完成（v2.12.0，2026-11-17）· `chat.message.committed` 补 `hasReplyContent`**：
  内核在工具执行前就把只含 `tool-call` 块的 assistant 消息 settle 落库，一次带工具的回合提交
  **多条** assistant 消息、只有最后那条带正文；桥此前只送 `role`，客户端收到第一条就清流
  + 收起过程组 + 停掉工具行刷新（而工具还没开始跑）。新增 `hasReplyContent` 布尔字段，判据与
  官方 WebUI 的 `hasAssistantReplyContent` 逐字同义（reasoning/tool-call 不算、text 按 trim
  判空、其余算正文），`user/message` 不带。老客户端忽略即退回原行为。契约面：asyncapi
  `ChatMessageCommitted` + API.md 新段 + CHANGELOG-DEV v2.12.0 段追加 + spec 新 1 组用例。
  **已随 v2.12.0 发版并推送**。
- **进行中（2026-11-15）· DSH 0.2.2-rc.1 适配（调研报告 [DSH-0.2.2-ADAPTATION.md](DSH-0.2.2-ADAPTATION.md) → 按报告 §六顺序改码）**：
  - **P0-1 已完成**：`session/attachment` 0.2.2 不再代查引用且请求改收完整 `ImageAttachmentRef`
    （五必填字段）——桥 `bridge/attachments.ts` 新增 `resolveImageRef`（历史 records 递归摘 ref +
    模块级 LRU 512 条 + `page` 回走有界 4 轮，未找到 404 `ATTACHMENT_NOT_FOUND`），
    `dsh-0.2-bridge.ts` 调用点与 `kernel-services.ts` 类型同步改；App 契约不变（仍只传 attachmentId）。
  - **P0-2 已完成**：schedule Remote 换方法面（catalog 裸数组/create/edit 替代 update+delete/
    `expectedUpdatedAt` 乐观并发/`patch.active` 暂停恢复/记录面 sessionId 移入 `target`）——
    `ws-schedule.ts` 重写（双向翻译，App 帧契约不变：记录仍 `sessionId`+`active|inactive`，
    paused/ended→inactive，新字段透传）；`bff-schedule.ts` 改走远程 create/edit（宿主 `ctx.schedule`
    端口与 `ScheduleCreatePort` 删除），暂停/恢复可用（ended 恢复仍 409 `SCHEDULE_ENDED`），
    `createdAt` 回真实 epoch；`index.ts`/`router.ts`/`capabilities.ts` 接线同步（`chat-schedules-v1`
    改随 typertGateway 同生死）；**engines.dsh 升 `>=0.2.2-rc.1 <0.3.0`**（schedule 面只认 0.2.2+）。
    五处契约面：API.md/BFF-REST-CONTRACT/INTERFACES 已同步（openapi/asyncapi 的 schedule 帧
    payload 开放、无需改；kotlin-sdk 无 schedule 帧模型）。
  - **P1-3 已完成**：`dsh.client.inject` 死引用清理——0.2.2 内核 loader 对缺失 graph row 的
    inject 项静默跳过（`dsh-client-modules/lib/client.js` `arriveGraphRow`），桥 client bundle
    自包含（仅 external react），`package.json` inject 只留三个实装的 client-ui 包。
  - **P1-4 已完成**：`page().throughSeq` 0.2.2 可选化——`SessionControllerLike` 类型对齐内核真值，
    桥**保留锚定** follow 首帧 cursor（页窗口 `(beforeSeq, throughSeq]`，省略会被新流量挤占窗口）；
    `session/events` 别名暂不切换。
  - **P2 A–E 已完成（2026-11-15，用户指令「现在做」，均 additive）**：
    A `llm/models-updated`→`chat.models.updated {provider}` 推送（frame-hub 中继 + chat-adapter
    规范化，badge 经 models 接口自然透出）；B 内置命令词条 `BUILTIN_COMMAND_IDS`/`BUILTIN_COMMAND_TOKENS`
    （en/zh 六条）透出到 commands REST 响应与 WS 帧（`definitionId`/`builtin`/`builtinTokens`）；
    C `session/wait` 长轮询——REST `POST /chat/sessions/{sessionId}/wait`（timeoutMs 钳
    1–120000 缺省 30000、RPC 超时按请求放宽）+ WS `session-wait`/`session-waited` 帧对；
    D `POST /attachments` 响应 additive `attachment:{attachmentId,name,bytes}`（0.2.2 upload
    结果的 file 元数据）；E schedule timing/target 透传——item 恒回 `kind`，非 cron kind
    回 `cron:null`+规则字段（不再隐藏），`POST`/`PATCH` 收 `timing` 七种原样，`POST` 可带
    `target`（new_once/new 内核建会话）。五处契约面同步（API.md/openapi/asyncapi/
    BFF-REST-CONTRACT/INTERFACES + CHANGELOG-DEV）。
  - issue 后补（用户已同意先改码——Gitee token 缺 issues scope，POST 回 Not Found Project）。
  - 真机验证清单见调研报告 §五（bridge 未装回实装目录前全部未验）。
- **进行中 REL-006（2026-11-11）· npm 可信发布者（OIDC）自动发布**：
  `.github/workflows/publish.yml` 已写好（tag `v*` 触发、`id-token: write`、OIDC 换短时效令牌、
  仓库里不存任何 npm 凭据），配套文档已同步（`RELEASE.md` §2.1、`STRUCTURE.md` §3.6/§5、
  `PITFALLS.md` 新坑位）。**当前卡在 npm 网页端**：账号需补一把可交互 2FA 设备
  （security key 或 TOTP 认证器 App；**邮箱验证码不算 2FA 设备**，配好前
  `POST /-/package/<pkg>/trust` 恒回 403 `Please enable 2fa for your account`），
  之后还要在 npm 网页登记「可信的发布者」（工作流文件名 `publish.yml`）。
  **自动发布尚未跑通一次**；当前实际在用的发布路径仍是本机令牌
  （`dsh-local`，2027-02-09 到期）走 `bash scripts/release.sh`。
- **已发版 v2.10.1（2026-11-11）**：①审批侧从「接管 = 否决下游」改成「进入即委托 + 竞速」
  （#13）——电脑端官方 WebUI 的审批卡立刻出现，不再等 10 分钟超时；②Cloudflare 隧道
  create 时两个请求互相删对方的 deb（#11，临时文件名加随机后缀）。
  **wire schema、REST 契约、Kotlin SDK 均未变。**
  已发到 npm（`dsh-remote-bridge@2.10.1`，latest tag）+ Gitee/AtomGit 双站 Release + GitHub 从站自动同步；
  实装目录已升到 2.10.1，**需重启 DSH 宿主**才会加载新产物。**真机复验未做**。
- **已发版 v2.9.0（2026-10-31）**：**团队成员（子会话）历史 —— 受成员关系校验的只读窄口**。
  - 真机痛点：`dsh-companion` 团队面板能列出成员与子会话，但点开任何一个都读不到内容。根因是双重设限：
    `sessions.list` 在 `dsh-0.2-bridge.ts:2327` 把 `origin === 'subagent'` 的行整批滤掉，于是子会话 id
    打 `/messages` 必然 404；即使绕过可见性，内核 `validateAddress()` 也要求
    `{ kind:'subagent', parentSessionId, childSessionId, mode }` 判别联合寻址。
  - 方案：不动 `sessions.list` 过滤、不放宽 `requireSession()` 通用规则，新增只读窄口。授权两步 ——
    ① Lead 会话必须对设备可见（沿用 `requireSession(leadSessionId)`）；② 成员关系必须由内核投影背书
    （`subagentCatalog[].id` 或 `agentTeam.members[].id`）。两步都过才直读历史，刻意不再调
    `requireSession(subagentId)`。非 GET 一律 405。
  - 新增端点 `GET /api/v1/chat/sessions/{leadSessionId}/subagents/{subagentId}/messages`
    （参数 `beforeSeq` / `maxMessages`，响应同 `listMessages`）；错误码 `SUBAGENT_NOT_FOUND`（404，
    刻意不区分「不存在」与「不是成员」）；能力位 `subagent-history-v1`；Kotlin SDK `listSubagentMessages`。
  - 技术核心：`dsh-0.2-bridge.ts` 新增 `SessionAddressLike` 判别联合，`follow()` / `page()` 的 `address`
    从写死 `{kind:'session'}` 放宽；`sessions.history` 从 payload 读 `parentSessionId`/`subagentMode` 拼地址。
    `mode` 必须从 catalog 原样取（内核会比对，不符抛 `subagent/unauthorized`）；子会话不能硬问
    `readSessionProjections`（会 500），用 follow 快照自带的 projections。
  - 门禁：`pnpm check` 全绿 —— 80 文件 / **834 用例**，`tsc` / `docs:check` / `build`。
  - **同时复核 DSH 0.2.1-rc.2 → 0.2.1-rc.5 兼容性**：逐包 diff `lib/` 产物，桥依赖 19 个包中 18 个
    零差异，唯一差异是一行 KDoc 注释；rc.5 实跑 834 用例全绿。结论无需改代码。
- **已发版 v2.8.2（2026-10-30）**：修复审批决策恒 409（`captureApproval` 取了 FrameHub 外层随机
  `rpcId` 而非 `payload.rpcId` 结算句柄）。79 文件 / 829 用例全绿。
- **历史在途记录（2026-10-28，已随 v2.8.0 发版）**：REST 对等面 —— 分块上传 / 定时任务 / 官方语音。
  - 依据 `docs/project/BFF-REST-CONTRACT.md` 新增九条只增不改的 `/api/v1` 端点
    （六个分块上传、四个定时任务、三个语音操作，共 13 个 operation），全部按
    「读取 `chat.read` / 动作 `chat.write`」过 `requireScope`，不新增 scope。
  - 逻辑拆在 `src/host/bff-rest.ts`（薄分发）、`bff-upload.ts`（1 MiB 切片 / 1 小时票据 /
    `alreadyReceived` 续传 / 缺块 409）、`bff-schedule.ts`（五段 Vixie + IANA 时区自校验、
    内核记录 ↔ cron 视图）、`bff-speech.ts`（复用 `ws-speech.ts` 的 4 MiB / 180 s / 目录归一，
    缺服务回 200 `available:false`）；`router.ts` 只留 9 段瘦分发。
  - 三条契约要求无法照字面落地，已显式降级并在 `CHANGELOG-DEV.md` 与 `API.md` 写明：
    ① `POST /chat/schedules` 内核 Remote 无 create → 走宿主 `ctx.schedule.create`，取不到 503；
    ② `Schedule.createdAt` 内核无此字段 → 恒 `null`；③ `PATCH {enabled:false}` 内核无暂停 →
    400 `ENABLED_UNSUPPORTED`（删除才是停）。
  - 能力位：新增 `attachment-chunked-upload-v1` / `chat-schedules-v1` / `speech-transcription-v1`，
    均在 `tests/capabilities.spec.ts` 有 OpenAPI 依据；`chat-schedules-v1` 随宿主 `ctx.schedule`
    缺席而剔除，`speech-transcription-v1` 只在 typert Gateway 缺席时剔除（没装语音包仍发位，
    目录回 `200 available:false`，「支持但没配」与「不支持」必须可区分）。
  - 门禁：`tsc` 0 / `vitest` 含新增合约测试 / `docs:check`（72 + 87 锚点）/ `build`。
  - **未提交、未升版本、未推送**：等 Lead 复核 diff 后统一处理。
- **已发版 v2.7.1（2026-10-27）**：**修「发文件永远失败」—— 解包内核的 `{agent}` / `{error}` 包装对象**。
  - 根因：`host.sessionController.resolveAgent()` 返回的是包装对象而非 Agent 本体
    （`dsh-api-session-controller/lib/index.js:365-368` 的 `liveAgent()` 与 `:221-246` 的
    `resolve()` 都是 `{agent}` / `{error}` 形状），`agentFor()` 直接把包装对象当 Agent 传给
    `fileUploads.upload()`，内核读 `agent.session.header.origin` 炸成
    `DSH_TYPEERROR: Cannot read properties of undefined (reading 'header')`。真机表现是
    「发文件永远 400/500，报错完全指不到原因」，附件上传与 agent preset 选择两条路径都挂。
  - 修法：识别包装形状 → 成功解 `.agent`、失败原样抛 `.error`（保留内核稳定 code，
    「会话不存在」不被压成「会话没在跑」），并保留裸对象兼容。新增 3 条回归用例钉住三种形状。
  - 门禁：`tsc` 0 / `vitest` **76 files 701 tests** / `docs:check` / `build` 全绿。
- **已发版 v2.7.0（2026-10-25）**：**对齐 DSH 0.2.1-rc.3 的四项能力提升**。
  - **模型目录容量**：`contextWindow` / `maxTokens` 此前声明了却永不赋值（内核
    `ModelCatalogModel` 不含这两项，只在 `llm.resolveModelInfo` 的 `context` /
    `defaultMaxTokens` 里）。新增 `modelCapacityOf`：按 `provider + model` 缓存 10 分钟、
    失败不缓存、并发查、内核给了不覆盖，接入 `sessions.models` 与 `llm.models` 两处门面。
    wire schema 无需改（`openapi.yaml` 早有这两个字段）。
  - **插件右侧栏形态**：成为 `SidebarRightTabDefinition` 提供方（tab id
    `dsh-remote-bridge-plugins`，guide 条目 `order: 40`），rc.3 起可 pin；rc.2 的 `GuideBody`
    无 pin/More 菜单，正常显示但不可 pin（预期降级）。用 `ctx.inject(['sidebarRightTabs'], …)`
    动态注入，避免可选依赖变硬依赖。
  - **`reuseBlank`**：`POST /chat/sessions` 新增可选字段，省略即 `true`（对齐 0.2.1 桌面
    「新会话回到工作区已有空白会话」），判据与官方 `createInWorkspace` 同义并额外跳过
    preset 不符的空白；老的 `rootId + path` 入口退化为「同 cwd 且空白」。
  - **设置页插件卡片**：补齐 `WorkspaceApi.pluginInventory` / `togglePlugin`，第七张卡
    （清单 / 启停 / 检查更新）+「打开插件列表」按钮（`openList` 在 rc.2 不存在，
    做特性检测而非版本判断）。插件四类型迁到 `src/shared/contracts.ts`（`client/` → `host/`
    是禁止的依赖方向）。
  - 门禁：`tsc` 0 / `vitest` 76 files 698 tests / `docs:check` 51+55 锚点 / `build` 通过。
    rc.3 隔离实例实测通过（插件清单 14/16、容量已填、`reuseBlank` 四语义、客户端 bundle 757 kB）。
- **已发版 v2.6.1（2026-10-23）**：**SEC-H11 安全修复 + 设备身份自动识别**。
  - **SEC-H11（高危）**：供应商 `baseURL` 的三个入口（`createProvider` / `updateProvider` /
    `discover`）此前不做任何校验，持 `settings.write` 的设备可把 baseURL 指向自己的服务器，
    内核会带**该供应商的真实 API key** 请求 `/models`。攻击链是实测确认的（假端点抓到
    `Authorization: Bearer`），不是静态推理。修复为三道闸门：协议白名单、私网默认拒绝
    （`allowPrivateProviderHosts` 显式放行，支持带端口钉住）、换 host 且已有凭据时必须同时给新 key。
    新文件 `src/host/provider-url-policy.ts`（纯函数，含 `::ffff:7f00:1` 十六进制映射的绕过修复）。
  - **配对默认权限收窄**：七档 → 五档（去掉 `settings.write` 与 `files.delete`），
    新增 `DEFAULT_DEVICE_SCOPES` 供三条路径共用。此前默认全勾与本仓 `SECURITY.md`
    把 `llm-*` 定为只读、`CHANGELOG-DEV` 写明 settings.write「是用户显式要求才给的」两处声明矛盾。
  - **设备身份**：新增 `src/host/device-identity.ts`，从 `X-Dsh-Device` 头（UA 兜底判平台）
    识别平台与型号，自动把配对占位名换成「平台 · 型号」；新增 `PATCH /manage/devices/{id}` 的
    改名通道。`nameSource` 三态（`default`/`detected`/`declared`）保证手动改过的名字永不被覆盖。
    修掉鸿蒙被登记成「Android 设备」的根因（UA 判定顺序：`harmonyos` 必须先于 `android`）。
  - 门验：`pnpm check` 四道门全绿（**74 文件 / 682 用例**、docs:check、build）。
  - 未部署：本次只发版，未同步到运行中的 profile（部署要重启桥，会断手机连接）。

- 日期：2026-10-19
- **已发版 v2.4.2（2026-10-19）**：**history 带投影 + 权限档位 BFF + 斜杠命令执行修复**。
  - **history 透传投影**：新增 `readSessionProjections()`，`sessions.history` 两条分支都把
    `sessionController.projections()` 并进响应（`@patch history-projections-passthrough`）。
    此前 `messages` 顶层只有 `events`/`hasMore`/`historyFormatVersion`，客户端连
    「当前权限档位」都读不到 —— 这是 dsh-companion F1「权限 Pill 从不渲染」的上游根因。
  - **新增 `GET /chat/permission-presets`** 透出内核 `permissionPresets.catalog()`
    （候选项只在这个独立远程服务上）。端点**容错读取**：该服务在本 profile 不可注入时
    （`without inject` = 压根没有，不是时机问题）返回内核默认档位，而不是让端点 500。
  - **修斜杠命令执行**：`commands.execute` 少传 `submittedAttachments`（内核四参签名），
    导致 signal 位错、所有斜杠命令报 `reading 'aborted'`。测试桩补上第三、四参断言。
  - 门验：40 文件 / 305 用例 / 0 失败；`docs:check` 10 文档一致。
  - 真机复验：投影带上 `permissions.currentValue`，App 权限 Pill 与菜单权限项正常显示；
    `/permission workspace-write` 返回 success，档位可切换。

- 日期：2026-10-17
- **在途（未发版、无版本号变更）**：三项（两项传输层加固 + 一项交互可靠性）——
  ① **出网 JSON 消毒**：新增 `src/host/wire-json.ts`（孤立 UTF-16 代理项 → U+FFFD），
  接入两个出网口（WS 的 `connection.ready`/`broadcast`、HTTP 的 `sendJson`）。
  动因是内核按字符数截断会留下半个代理项，`JSON.stringify` 照样转义，
  而 **Swift/Foundation 拒绝整帧** —— 一个坏字符就能静默打死一条连接
  （对标第三方网关的 `lib/wire-json.mjs`，见 `PITFALLS.md` §孤立代理项打死整条连接）。
  ② **历史响应字节预算**：新增 `src/host/history-budget.ts`（单次 2 MiB / 单条 512 KiB；
  整份超限从最旧端丢并置 `hasMore`，单条超限对超长字符串首尾保留并标 `bridgeTruncated`；
  真动手才追加 `truncated` + `bytes`），`chat-adapter.history()` 出网前调用；
  契约面同步到 `API.md` 的「历史与分页」与 OpenAPI 的 `listMessages` 200。
  ③ **连接即重放（待处理审批）**：WS 升级成功后把仍待处理的审批**只补推给这一条连接**
  （`chat-adapter.replayPendingApprovals` + `server.ts`，逐会话授权过滤、不 await、失败静默，
  事件带 `data.replayed = true`）。动因是「连接后主动刷新」属于**客户端的选择**，
  协议不该依赖它：客户端若只在收到事件时刷新，重连窗口里的审批会静默消失，
  而内核一直阻塞着等。重放把它变成服务端保证（对我方 App 是幂等冗余）。
  契约面同步 AsyncAPI 与 `API.md`。
  **提问侧同日一并重放**（走既有事件类型 `chat.userQuestions/requested`，字段与实时一致）。
  ④ **能力发现 + 历史格式版本**：`connection.ready` 带上 `bridgeVersion` 与**能力位清单**（2026-10-17 依次补 `session-archive-list-v1`、`session-snapshot-v1`）
  （清单与数量以 `src/host/capabilities.ts` 的 `BRIDGE_CAPABILITIES` 源码为准，文档不抄数字；每项都能指出契约依据，`tests/capabilities.spec.ts` 逐条核对）；
  `GET …/messages` 总是带 `historyFormatVersion`（**只声明不校验**，强制会打断已发布客户端的
  `beforeSeq` 分页）。**客户端尚未接入**（仍在硬比版本号）。
  ⑤ **已归档会话可列**：`GET /chat/sessions?archived=true` 只列已归档的那批（默认行为不变），
  能力位新增 `session-archive-list-v1`。**恢复（取消归档）不做** —— 内核是否提供 unarchive
  **从本仓不可证**（`node_modules` 下没有 `@deepseek-ai/*`），按 §空结果的来源要验证 只写「不可证」。
  ⑥ **`seq` 语义单一化**（ADR-0008）：`assistant-stream` 路径推 mux 的 `assistant/chunk`
  **不再带 `seq`**（它是会话持久事件序号，而 chunk 只有流内 `index`）。动手前逐个核过消费者
  （kotlin-sdk 未建模 delta / chat.html 不读 / App 的 `ChatDelta` 无 seq 字段 / AsyncAPI 中非必填），
  故「不再输出」对现有实现零影响。AsyncAPI 标 deprecated 而非删除。**不加能力位**（无需分支）。
  门验：**34 文件 / 264 用例全绿**、`docs:check`（10 文档 / 39 任务 / **8 ADR**）。
  ⑦ **订阅基线不再丢弃**（`chat.session.snapshot`）：`SessionEventRelay.pump` 接出
  `snapshot` 分支，`cursor` 是这条订阅接增量的起点 —— 客户端据此可判断「REST 拉取」与
  「WS 订阅」之间有没有漏事件（此前那一帧被 `continue` 丢掉，手机端**无从判断**）。
  **正文刻意不发**（双通道会造出两份基线，先后无法保证）；不可证字段不给。
  能力位新增 `session-snapshot-v1`。门验：**35 文件 / 269 用例**、`docs:check`（8 ADR）。
  客户端消费归入下一项「断档检测与 resync」。
  ⑧ **单胜方交互的核账**（ADR-0009，状态 **accepted**）：报告拆出的四件事里，
  我方**已有两件**（②身份比对、④迟到响应 `not-pending`，且都有测试钉住），
  另两件（①并行下发、③abort 下游收起 WebUI 弹窗）原为**待拍板** —— 其中 ③ 依赖
  `req.signal` 的可写性与宿主 fan-out，**本仓不可证**。
  **①已于 2026-11-11 落地（#13）**：`ApprovalBridge` 从「接管 = 否决下游」改成
  **进入即委托 + 两端竞速**（与提问侧同范式），电脑端审批卡立刻出现；
  ③ 仍不可证，由「用户点掉陈旧卡 + 409 `not-pending`」兜底（ADR-0009 决议一节）。
  附一个低成本验证实验（让一次审批的 `req.signal` abort，
  看官方 WebUI 弹窗是否自行收起）—— 仍未做，官方客户端无外部撤销通道。
  ⑨ **文件卡片实时事件**（`chat.deliverables.presented`）：内核 `present` 工具的
  `deliverables/presented` 在**历史**里一直原样透传（客户端文件卡片早已在读），
  但实时那一路此前落进默认分支、被规范化成客户端不认识的名字 —— 新交付物要等下次消息完成
  才出现。现已给它正式事件名，`files` 原样透传。**不加能力位**（客户端只是"收到就刷新"，
  没有它仅晚一点，不是分支关系）。
  ⑩ **能力位消费者审计**（能力位总数以 `src/host/capabilities.ts` 源码为准）：**只有 3 项**
  是我方客户端的分支判据
  （`approvals-v1`/`questions-v1`/`session-archive-list-v1`），其余各项是**对外声明**
  （服务任何客户端，含第三方）—— 「某个客户端没用到」≠「没人用」，删掉等于撤回对外承诺。
  新增跨仓钉子：能力位清单必须保留客户端必需的两个名字。
  见 `CHANGELOG-DEV.md` 2026-10-17 十条。见 `CHANGELOG-DEV.md` 2026-10-17 七条。
  门验：`tsc --noEmit` exit 0、**34 文件 / 264 用例全绿**、`docs:check`（10 文档 / 39 任务 / 9 ADR）、
  `tsdown` build 通过。
  ⑪ **Cloudflare WAN 隧道接入**（一次性把「人已出门、只有手机」也能连回家打通）：
  新增 `cloudflared.ts`（`ensureCloudflared` 落盘 + `CloudflaredTunnelManager` 起 Quick Tunnel、
  从 stdout 正则抓 `https://<host>.trycloudflare.com`），router 加三个回环管理端点
  `/manage/cloudflare/{status,create,stop}`，`api.ts` 加 `tunnelStatus/Create/Stop`，
  WebUI「📱 手机设置」远程卡叠加一块隧道分区（状态、地址、创建/停止、「用隧道地址生成配置文本」）。
  **红线未踩**：电脑端 config-text 直连、扫码/配对码路径与七张卡片一字未动。端点对外统一为
  `https://`（客户端拼 wss 时自行升级，坑位 §wss 端点必须归一成 https）。Quick 隧道地址
  临时会漂移。门验：`pnpm check` 四道门全绿（**38 文件 / 286 用例**、docs:check、build）。
  新坑位三条已入 `PITFALLS.md` 与 AGENTS §6 索引。
  - **真机验证（2026-10-17）**：用真实 cloudflared（官方 `pkg.cloudflare.com` deb 解包）实测
    宿主侧闭环保真跑通——`ensureCloudflared`(复用/下载解包) → Quick Tunnel 创建成功 →
    抓到 `https://*.trycloudflare.com` → 生成 DSH1 配置、往返解码 baseUrl 一致 → stop 干净退出。
    另验证了新增 `deb+` 下载源：`CLOUDFLARED_MIRROR=deb+https://pkg.cloudflare.com/cloudflared/pool/main/c/cloudflared/cloudflared_2026.10.1_amd64.deb`
    在本机（GitHub 直连被墙）能真实下载解包并成功起隧道。门验随之更新为 **38 文件 / 288 用例**。
    `src/host/cloudflared.ts` 注释已从「诚实声明无镜像」改为「真实择源」。
  - ⚠️ ~~本机 `pnpm` 已坏~~（`unable to open database file`）：**2026-10-17 Cloudflare 接入时
    `pnpm check` 已恢复正常**，四道门（typecheck → test 38/288 → docs:check → build）由一条命令
    逐段跑通（`prepack` 可正常触发）。此条作废。
- 阶段：`dsh-remote-bridge` **v2.4.1**（**已双推 origin+gitee、已打 tag、双站 Release 与 npm 均已发布**）—— **`turn/end` 的 `reason` 透传**（客户端「回答被截断」提示的双端配套；上一版 **v2.4.0** 为 Cloudflare WAN 隧道接入 + 远程卡 UI 调整，发布提交 `b9f08a2`）。
  - **云端**：新增 `src/host/cloudflared.ts`（`ensureCloudflared` 复用/下载解包 + `CloudflaredTunnelManager` 起 Quick Tunnel、正则抓 `https://<host>.trycloudflare.com`），
    router 加回环管理端点 `/manage/cloudflare/{status,create,stop}` + `/manage/cloudflare/activity`（下载进度），`api.ts` 加 `tunnelStatus/Create/Stop/Activity`。
    端点对外统一为 `https://`（客户端拼 wss 时自行升级，坑位 §wss 端点必须归一成 https）；Quick 隧道地址临时会漂移。
  - **真机已验证**（2026-10-17）：`pkg.cloudflare.com` 官方 deb 在本机（GitHub 直连被墙）能真实下载解包并成功起隧道，手机端确认可访问。
  - **UI 调整（本轮）**：① 隧道主体区（标题/状态/安全警告/开关/进度/地址）上移到「选择权限」之上、「远程访问已启用」之下；
    ② 创建/停止合并为单按钮，按隧道状态切换文案「开启云隧道 / 停止云隧道」；
    ③ 「用隧道地址生成配置文本」按钮移到主「生成配置文本」按钮之后，按状态显示「生成隧道配置文件 / 隧道未开启」（未开启态点击等同开启）；
    ④ 开启云隧道（含隧道未开启态触发）弹安全确认，UI 常驻安全警告。
  - **红线未踩**：电脑端 config-text 直连、扫码/配对码、其余六张卡片一字未动（仅隧道区 UI 重排）。
  - 门验：`pnpm check` 四道门全绿（**38 文件 / 290 用例**、docs:check、build）+ e2e 4 样式契约。新坑位扫过 `PITFALLS.md`。
  - **端到端复核通过（2026-10-20，补记）**：真实触发一次 max-tokens 截断（内核会话日志
    `session.v4.jsonl.zstd` 中 `turn/end` 带 `reason.kind == 'max-tokens'`），运行中的
    2.4.3（含本透传）把 `reason` 送到了 App（companion 2.2.46），「回答被截断」黄条
    **用户真机实测可见** —— 双端配套就此闭环（App 侧记录见姊妹仓 `STATUS.md` 2026-10-20 条目）。
- v2.3.9（delta 帧始终带 turn/step）——**已提交并推送两仓 + tag 已打**（`1c75aca`）：`assistant-stream` 的 start 帧
  turn/step 兜底 0 不再留 undefined，修复「客户端静默丢帧」。
- 上一版 v2.3.8（对标补强 C 批）**已提交**（`d6c4298`）：`seq` 单一语义、订阅基线、连接即重放、Unicode 消毒、字节预算、交付物实时事件、26 项能力位、两条机检门禁。详见下方「在途」记录。
- 前几批历史：v2.3.7（waterfall 不 prepend）、v2.3.6（归档 + 审批/提问卡片）等见下方各节与 `CHANGELOG-DEV.md`。
  （即 `PITFALLS.md` §waterfall 不 prepend 就等于没注册）。
  **真机已验证**（2026-10-16，用户重启 dsh 后实测）：改前 plan 模式评审卡片只有电脑端弹、
  手机端零卡片；改后**手机端与电脑端同时正常弹出**，电脑端行为一字未变（未抢答，红线未踩）。
  待推送 origin + gitee 与双站 Release（**等用户明确同意**）。
- 上一版 v2.3.6 的「实装目录未同步」记录**已作废** —— 该目录现已可写，v2.3.7 已同步至
  `~/.dsh/profiles/{desktop,web}/node_modules/dsh-remote-bridge/lib/index.js`
  （各留一份 `index.js.bak-before-prepend` 供回滚），并经用户重启 dsh 后确认生效。
- v2.3.7 详情见下方「2.3.7（waterfall 不 prepend）」节。
- awesome-dsh-plugin 投稿（2026-10-15，基于 `contributing.md` 逐项整改）：
  - **收录范围**：只投 `dsh-remote-bridge`。`dsh-companion` 是纯 Kotlin/Gradle 的 Android 工程，仓库内**没有 `package.json`**，因此无法声明 CI 强制要求的 `dsh.bundle` manifest —— 按文档第 2 项检查必然被拒，硬造一个 Node 外壳只会命中「占位仓库」条款。客户端改由 remote-bridge 的 README「连接 Android App 或其他客户端」一节引用（GitHub / Gitee 双链接 + 双二维码）。
  - **新增 `screenshots.json`**（4 张，市场详情页展示）：`assets/screenshots/panel-roots.png` / `panel-remote.png` / `panel-devices.png` / `panel-app-download.png`。截图由 `scripts/generate-screenshots.ts` 生成，DOM 与 `WORKSPACE_CSS` 均从 `src/client/` 导入，与 `e2e/styles.spec.ts` 同一产出来源（那一层本就在量这些样式的计算值），**不是手工画的示意图**。未连接真实内核，故面板呈现「刚装好、远程访问未启用」的自然状态。
  - **条目 YAML**（`data/plugins/westanke__dsh-remote-bridge.yml`，投稿侧）：`category: remote`；`tarball` 指向 GitHub Release 的 v2.3.6 资产（钉版本 tag，不用 `latest/download/` —— 文档明确警告带版本名的资产名会在下次发版时 404）；描述中英双语，只陈述功能不带营销词，数字均经代码核对（七张卡片 = `ADMIN_TABS.length`）。
  - **本地已验证**：`node scripts/check-submission.mjs --only-list …`（CI 同款）→ `ok: true`、0 failures、0 incomplete；`generate-readme.mjs --check` 一致；README 中英 diff 各 **+1/-0**（不动任何既有条目，符合评审第 6 条）；`pnpm check` 全绿（226 用例）。
  - **既有 PR**：`awesome-dsh-plugin` PR **#6968**（2026-10-09 创建，CI 两项 success，`mergeable_state: clean`）已在队列中等评审；本轮把 `tarball`、`screenshots.json` 与更克制的描述补进同一分支，**不新开 PR、不 force-push**。
- DSH 基线：`master` / `47f943859bef60e4160492346772ded9b24f765a`
- 插件路径：本仓库（历史上游为 `Hakunm/dsh-workspace`，v1.0.0 保持原样不动）
- 已完成：Host/Client 外置插件、授权根与回收站、独立 listener、设备授权、聊天/审批/命令/模型 BFF、OpenAPI/AsyncAPI、Kotlin SDK、中英双语和版本展示
- 2.2.3 / 2.2.4（纯文本模型发图）：内核以 `MODEL_DOES_NOT_SUPPORT_IMAGES` 拒收纯文本模型会话里的图片，插件按内核自己的 `llm.resolveModelInfo()` 判定并把图片落成工作区文件（`<会话工作目录>/.dsh-images/<sha256>.<ext>`，内容寻址、0700/0600），消息里留两行：第一行给人看（当前值可配置的识图路径），第二行 `[Image: source: <绝对路径>]` 给机器；解析不出工作目录时退回 `<dataDir>/image-handoff`。手机端用 `GET /api/v1/image-handoff` 把图取回去显示，历史图片走 `sessionController.attachment`
- 2.2.4 实装 + 本轮待发版内容（`IMAGE-001`）：设置页新增「识图」分区 —— 识图路径（交接目录名）可改、存 `settings.image_handoff_subdir`、改完立即生效；「当前默认」`.dsh-images` 与兜底目录为只读栏。dsh-image-paths 0.3.1 的宿主路由与浏览器图集并入本插件：只读路由 `GET /plugin/dsh-remote-bridge/raw?sessionId=…&name=…`（回环 + 同源 + 裸文件名白名单 + 字节自证 + 32 MiB 上限，目录由宿主按会话推出），图集挂在 `conversation.chat.turnTail`，只认用户消息里的交接行首标记
- **待办**：① 真机验证（重启 dsh 后：会话里「加载更早消息」能否翻出更早记录；「插件」页是否不再报判定不出 profile；**启停一个插件看是否要重启才生效、备份文件是否落地**）；② 停用独立 `image-paths` 插件那一行 —— 两个插件会把同一张图在 Turn 尾画两遍，本插件已自带该能力
- 2.3.7（waterfall 不 prepend —— 手机端交互卡片全灭的**第二个**病根）：
  - **现象**：v2.3.6 修好 `sessionIdOfAgent` 之后，plan 模式的评审卡片在**电脑端正常弹出、
    手机端依然零卡片**。用户 2026-10-16 重启 dsh 后实测确认。
  - **根因**：`approval/request` 与 `user-questions/request` 是 **waterfall** 链，而本插件
    注册钩子时**没传 `{ prepend: true }`**。Cordis 4.0.2（`vendor/cordis/src/events.ts`）
    `:143`/`:255` 是 `const method = options.prepend ? 'unshift' : 'push'` —— 不传就是
    `push` 到**链尾**；`:225-228` 的 waterfall 语义明写「a listener that does not call
    `next()` vetoes the rest of the chain」。于是本插件排在官方 WebUI 的监听器**之后**，
    WebUI 自己处理掉就不调 `next()`，**本钩子永远不被调用**——表现与「压根没注册」一样，
    且失败**完全静默**（两侧日志都不说一句话）。
  - **为什么这么隐蔽**：提问钩子的源码注释里**早就写对了这段机理**（「我们必须在链的最外层……
    排在后面的话，前面那家一旦不调 next（veto 整条链），我们根本不会被调用」）——
    **知道该怎么做，只是注册时漏了这个选项**。参照来源是第三方实现 Whaleness 的网关插件
    `dsh-plugin-mobile-gateway`（`lib/index.mjs:3182`、`:3214` 两个钩子都带 `{ prepend: true }`）。
  - **修法**：两处 `host.on(…, listener)` 补第三参 `{ prepend: true }`；
    `Dsh02HostServices.on` 的 TS 签名同步加 `options?: { prepend?: boolean }`；
    两处各加 `@patch` 四要素（id `approval-hook-prepend` / `question-hook-prepend`）。
  - **测**：`tests/dsh-0.2-bridge.spec.ts` 的 `makeHost().on` 改为**忠实模拟** Cordis 的
    `unshift`/`push`（原桩忽略第三个参数，`{ prepend: true }` 写错或被删都不会红——那正是
    这bug 能活到今天的原因之一）；新增回归用例「registers both interaction hooks at the
    head of the waterfall chain」。**反向验证**：临时删掉两处 prepend，该用例如期变红
    （`expected [AsyncFunction Mock] not to be [AsyncFunction Mock]`），恢复后 45 用例全绿。
  - **真机验证（2026-10-16）**：用户重启 dsh 后，plan 模式评审 —— **手机端弹出卡片，
    电脑端 WebUI 同时正常弹出**。红线「不得抢答、不得让电脑端卡片消失」**未踩**。
    回滚预案留档 `docs/project/ROLLBACK-prepend-2026-10-16.md`，
    实装目录各留 `lib/index.js.bak-before-prepend`。
  - **未做**（本轮刻意只改一件事，避免说不清是哪件起的作用）：① 学Whaleness 加
    `hasInteractionClient` 在线判据（有 id 但没手机连就`next()` 放行，防止劫持电脑端）；
    ② 学它用 `AbortSignal.any` 在答完后主动 abort 下游；③ `sessionIdOfAgent` 链序把
    `id` 提到第一位（`agent.sessionId` 根本不存在，第一格永远走不到）。
  - **产物**：`artifacts/dsh-remote-bridge-v2.3.7.tgz`，**532,529 字节**，
    SHA-256 `0e9d76bb8ad7d9b7a8c97cf6e8331fdf02f752911a7df1a1ec74c815cf921603`，
    npm shasum `6c5a4d17ed357907a5169f59d93ecb8a603e8934`（与 `npm pack` 输出一致）。
    打包命令 `npm pack --pack-destination artifacts`（**不用 `pnpm pack`**，见
    `PITFALLS.md` §npm pack 与 pnpm pack）。
- 2.3.6（归档点了没反应 + 手机端交互卡片全灭）：
  - **现象**：手机 App 会话列表里点「归档」→ 确认 → 请求返回 200，但该会话照旧留在列表里，像是什么都没发生。
  - **根因（写入通、读取断）**：App `POST /chat/sessions/{id}/archive` → router → chat-adapter → 桥接 `workspaceController.archiveSession`，内核确实把会话写进**注册表级**归档集合（`WorkspaceRegistry.archivedSessionIds`，持久化在 workspace state）。但读这一侧，`chat-adapter.listSessions` 靠 `api.workspace.list().archivedSessionIds` 过滤，而桥接 `workspace.list` **把它硬编码成 `[]`**（原注释：「注册表没有插件侧归档的概念」—— 对「插件自建存储」成立，但归档根本不是插件侧状态，`archiveSession` 写的正是注册表本身）。过滤集恒空 → `continue` 一次都不执行 → 归档成功却被自己抹掉。
  - **修法**：`workspace.list` 改从 `host.workspaceRegistry.archivedSessionIds` 透传真实集合；`WorkspaceRegistryLike` 补声明该 getter；新增 `readArchivedSessionIds()`，getter 缺失（老内核 / 测试替身）时退化成空集合，只让过滤失效、不让列表读崩。
  - **未做**：不动 App 侧（其调用与重拉列表本就正确）；不引入插件自己的归档存储（内核已有唯一真源）；不自动传 `stopActivity` —— 归档**正在运行**的会话内核会拒绝（`WorkspaceActiveSessionError`，App 显示为错误），是否顺带停会话由用户拍板。
  - **测**：桥接新增 2 条用例（① 归档集合原样透传 —— 把修复回退成 `[]` 即失败，已实测；② getter 缺失时退化为空集合）；HTTP 端到端新增 1 条断言（`POST /archive` 后同一 `GET /chat/sessions` 不再返回该会话：归档前 2 条、归档后只剩 fork 那条）。
  - **同版的第二个缺陷：手机端审批与提问卡片一张都不显示**（用户报「这个又没显示」，追问后确认审批也没看到、那次是在电脑端操作的）。逻辑闭环：两类在电脑端都正常、手机端都空白，而 `ApprovalBridge` 是「接管＝否决下游」——它真接住了电脑端反而不会有卡片。故只剩一个解释：**监听器压根没进链**。
  - **根因**：两个桥共用 `sessionIdOfAgent()`，它只查 `agent.sessionId` 与 `agent.session.id`，而内核里这两条都不存在 —— `Agent` 的身份字段就是 `id`（`dsh-agent/lib/types/types.d.ts:11-14`，运行时 `this.id = id`），`agent.session` 是 class `Session`、id 挂在 `header.id`。签名里声明了 `id?: unknown` 却从未使用，于是每条审批/提问都在第一行被判「定位不到会话」后**静默让给电脑端**。
  - **修法**：`sessionIdOfAgent` 补齐 `id` 与 `session.header.id`（顺序 `sessionId → id → session.id → session.header.id`）；审批测试桩从 `{ sessionId }` 改为内核真实形状 `{ id }`（桩比现实宽容正是漏网原因）；新增提问桥用例 3 条（此前该桥零测试）。回退这两条解析，3 条用例如期失败（已实测）。
  - **未做**：不改 App（App 订阅/拉取/渲染都对）；不加「从历史猜提问」的兜底（根因修好后实时链路即恢复，加猜测只会多一条会过期的路径）。
  - 六处版本号战场同步（package.json / version.ts / openapi / asyncapi / kotlin-sdk / healthz 断言）
- 2.3.5（会话补 `cwdAbsolute`，救活手机端 `@` 补全）：
  - **现象**：手机 App 会话里打 `@`，面板只显示「读不到这个会话的工作目录」，一个文件都列不出来。
  - **根因（三层）**：① 会话工作目录 = 授权根本身时 `wireRelative` 返回**空字符串**（`path.relative(root, root) === ''`），App 把它当成「没有工作目录」；② App 把**相对根**的 `cwd` 当**绝对路径**送去 `/roots/resolve`，而该端点对相对路径硬拒绝（`PATH_NOT_ABSOLUTE`）——**这一步翻译纯属多余**，会话里本来就有 `rootId`；③ App 没有根的 realPath（`RootView` 刻意不含），拼不出绝对路径。**结果是这个补全从实现起从未列出过任何文件。**
  - **修法（本服务端承担第 ③ 层）**：`ChatSessionView` 新增**可选** `cwdAbsolute`；`listSessions` 把绝对 cwd 收进局部变量供 `matchRoot` 与 `cwdAbsolute` 共用。该值本就在服务端手里，且会话必落在**本设备已授权**的根内（不匹配的会话不会出现在列表里），故不扩大可见范围。
  - **未做**：不动 `cwd` 语义（改回绝对会破坏已发布客户端并铺开机器路径）；不新增 reason 枚举值（老 App 会掉进更模糊的兜底文案）。
  - **安全断言**：`chat-adapter.spec.ts` 那条「响应不含根真实路径」的断言**没有拆掉**，只把例外精确摘出去（按 key 过滤 `cwdAbsolute` 再验），防线收窄到一处。
  - 新增 1 条用例：会话目录 = 授权根本身时 `cwd === ''` 且 `cwdAbsolute` = 根真实路径。
  - 配套 App 侧（dsh-companion 2.2.33）：去掉 `resolvePath` 改直用 `rootId`+`cwd`；`MentionQuery.absolute` 从「拼接」改为正确的**换前缀**语义；`@` 面板文案分三态（读取中 / 读不到 / 真的是空的）。
- 2.3.4（修桌面版读不出插件清单）：
  - **现象**：桌面版（官方 Electron 壳）里打开手机 App 的「插件」页，红条报「服务器读不出插件清单：package.json 可能损坏、缺失或没有读取权限」，但 `/home/wangke/.dsh/profiles/desktop/package.json` 存在、`0644` 可读、JSON 合法 —— 提示里的三种可能**一种都不成立**。
  - **根因**：内核接受 `--profile <名>` 与 `--profile <profile 目录>` **两种**写法（启动器文档：`--profile ${basename(profileDir)}`，**内核自己取 basename**），而 `resolveProfileName()` 只认第一种。桌面版用第二种启动内核，于是整条路径被当成 profile 名；`path.join` 不会因后段是绝对路径而重置，拼出 `/home/wangke/.dsh/profiles/home/wangke/.dsh/profiles/desktop`，必然 `ENOENT` → 被 `readJson()` 的 `catch` 吞成 `MANIFEST_UNREADABLE`。
  - **定位手法**：不走「猜文件」，而是读运行中插件的真实响应（`3090` 监听 / `36079` 内嵌，只读请求走 loopback 管理通道）。响应里 `profile` 字段是路径而非 `desktop`，与 `path.join` 公式**逐字吻合**，根因当场坐实。
  - **修法**：新增 `normalizeProfileName()`（含分隔符取最后一段），`resolveProfileName()` 的 **4 个入口全部归一化**；`togglePlugin()` 共用该判定，手机上「启用 / 停用」写错路径的问题一并修好。
  - **兼容性**：字段零增删改；字段白名单测试原样通过；web 版（名字形式）行为不变；不新增 reason 枚举值（新增会让老 App 掉进更模糊的 `else` 文案）。
  - 新增 8 条用例，含「桌面版启动形式」的端到端复现。
- 2.3.3（「插件」页详情增强 + 手机上直接启停）：
  - **官方机制摸清**：`dsh plugin <x>` 会**原样转发给 pnpm**（实测误触发过一次安装流程，打出 `Packages: +4 -85`，所幸 package.json 与 node_modules 未变）。内核 `profile-boot` 注释确认：**`dsh.profile.bundles` 数组就是加载清单，顺序即加载顺序**。所以启停 = 加/删一个名字，**完全不必碰依赖**。
  - **B 详情增强**：每项新增 `description` / `homepage`（剥 `git+` 与 `.git`）/ `updateAvailable` / `latestVersion` / `toggleable`。`updateAvailable` **是三态**（null = 没查，与 false「已是最新」不同）。版本检查默认关（`?checkUpdates=1` 开），只查确实装在 profile 里的第三方包，并发 6 / 超时 5s / 失败即 null。
  - **A 启停写操作**：`PATCH /settings/plugins`，`{ name, loaded }`，需 `settings.write`。三道安全阀 —— ① 拒官方包（`@deepseek-ai/`，运行时自带、改了没用）；② **写前必备份**（`package.json.bak-<时间戳>`，写坏了 dsh 起不来而用户在手机上够不着电脑，备份是唯一退路）；③ **先写临时文件再 rename**（同分区原子，避免残缺 JSON）。另：幂等不产生备份垃圾；启用未安装的包会被拒（该走安装流程）。响应固定带 `restartRequired: true`（bundles 只在启动时读）。
  - 新增 8 条 `togglePlugin` 用例；字段白名单测试如期失败一次后同步登记。
  - OpenAPI 补登 `/settings/plugins` 的 GET+PATCH 及三个 schema（**该端点此前根本没进 OpenAPI**，属旧遗漏）。
- 2.3.2（修「插件」页判定不出 profile）：
  - **根因**：`resolveProfileName()` 只认 `DSH_PROFILE` / `--profile=` / `--profile <name>` 三种来源，**漏了子命令简写**。用户实际启动命令是 `argv = ["node", "/usr/local/nodejs/bin/dsh", "web"]`（无 `--profile`、无环境变量）→ 返回 null → 页面报「判定不出」。
  - 而内核启动器文档（`@deepseek-ai/dsh/args`）写明 **`dsh <name>` 就是 `dsh --profile <name>` 的简写**（`dsh web` same as `dsh --profile web`）—— 这是**插件的疏漏**，不是用户没带参数，而 `dsh web` 恰是文档里的第一个示例。
  - **修法**：补第四条来源「子命令简写」。照抄内核解析规则：跳过所有选项，第一个非选项 token 即子命令；跳 `--flag value` 时**要连取值一起跳**（`--port 3080` 的 `3080` 不是子命令）；`plugin` 子命令单独排除（它管理依赖、不启动 profile）。
  - 另补一条**明确不猜**的边界：写了 `--profile` 但取值非法时**直接返回 null**，不退回简写 —— 猜错会读到另一个 profile 的清单，比老实报错难排查。
  - 新增 6 条单测（该 describe 共 12 条），直接复刻出问题机器的真实 argv。
- 2.3.1（修「加载更早消息」无反应）：
  - **根因**：`history()`（`src/host/dsh-0.2-bridge.ts`）从来只用 `follow()` 开场帧取历史，**把 `beforeSeq` 整个忽略** —— 客户端传不传都返回同一窗，合并去重后自然「什么都没多出来」
  - **修法**：带 `beforeSeq` 时改走内核 `page()` —— 先取开场帧的 `cursor` 当 `throughSeq`（内核要求该值必须取自对应 follow 开场帧，硬编码会返回 HTTP 200 + 空页这种静默失败），再调 `sessionController.page({ address, throughSeq, beforeSeq, maxMessages })`；`SessionControllerLike` 补 `page()` 声明
  - **实测**：第一页 261 事件（seq 104~364，hasMore: true）→ 带 `beforeSeq=104` 返回 104 事件（seq 0~103，hasMore: false），修复前两次都是同一窗
  - 六处版本号战场同步（package.json / version.ts / openapi / asyncapi / kotlin-sdk / healthz 断言）
- 2.3.0（设置面板重做 + 识图并入 + 默认根 + 设备清理）：
  - **设置面板换成 Vision Router 式折叠卡片**：删除顶部分区导航栏，七张卡片平铺、各自折叠、可多张同时展开；配色改挂 DSH 原生 `--dsw-alias-*` 令牌（深浅色自动跟随）；清理文件工作区遗留死样式，样式表 12.6 KB → 6.2 KB
  - **识图路径并入**（原 dsh-image-paths 0.3.1，ADR-0007）：只读图片路由 `GET /plugin/dsh-remote-bridge/raw?sessionId=…&name=…` + Turn 尾图集；设置页新增「识图」分区，交接目录名可改、存 `settings.image_handoff_subdir`
  - **默认根**：启动时把 DSH 当前工作区登记为 `builtin = 1` 的授权根（不可删除、可正常访问）；`roots` 表加 `builtin` 列并**移除 `real_path` 的 UNIQUE**（默认根与用户自加的同目录根是两条独立记录）；不劫持用户已有配置，不影响已配对设备
  - **设备撤销改为真删除**（`DELETE` 而非打标记）：`device_roots` 级联清除，`audit.actor_id` 非外键所以审计保留；启动时 `purgeRevokedDevices()` 清理历史标记行（本机曾堆 32 条）；权限码中文化
  - **权限可在配对前勾选**：`grantedScopes` state 取代写死的 `[...DEVICE_SCOPES]`，值随 `enableRemote` / `createPairing` 一起发出；配置文本仍固定最小权限不跟随
  - 六处版本号战场同步（package.json / version.ts / openapi / asyncapi / kotlin-sdk / healthz 断言）
- 2.0.0（DSH 0.2.x 下游适配）：host bridge 从 `apiProxy` 迁到 host services；新增插件清单 `GET /api/v1/settings/plugins`（`PLUGIN-001`）、配置文本 `POST /manage/config/text`（`CFG-001`）、绝对路径解析 `GET /api/v1/roots/resolve`（`FS-003`）、会话附件读取 `GET /api/v1/attachments/:id`
- 2.0.1 / 2.0.2 / 2.0.3：**已知有缺陷，不建议安装**。2.0.1 把 cordis 注入属性的读取提前到 `apply` 期间导致插件整个激活失败；2.0.2 只给 `attachments` 加了容错、漏了 `fileUploads`；2.0.3 才把两者一并处理
- 2.0.4：改名 `dsh-workspace` → `dsh-remote-bridge`（旧名比内容窄）；桌面端入口收敛为**纯设置面板**，文件树与编辑器移出桌面面板、保留在独立页 `/dsh-workspace`
- 2.1.0–2.1.3（桌面设置）：入口从侧栏齿轮按钮**删除**，改为注册 `settings.section`（`id: dsh-remote-bridge`、`order: 2`，紧跟 pocket-relay 的「📱 手机访问」），面板标题改「手机设置」，**在设置页内联渲染**（2.1.1 修正了 2.1.0 那个「只有一句话」的启动器）；导航改横排并修好白字白底的隐形按钮（2.1.2）；新增「App 下载」页与二维码资产、回收站来路说明（2.1.3）
- 二维码资产：提交进仓库并由 `tests/app-qr.spec.ts` 解码校验，指向 Releases **列表页**（非具体文件），因此发新版不需重新生成
- 2.2.0（删独立页 + 瘦身）：删除独立页 `/dsh-workspace`（文件树 + CodeMirror 6 编辑器）及 `src/standalone/`、`assets/workspace.html`、`src/client/editor.tsx`、`workspace.tsx` 中的 `WorkspaceApp`/`DirectoryNode`/`CommandDialog`/`AdminOverlay`、`scripts/test-server.ts`，以及 8 个 `@codemirror/*` 与 `@lezer/highlight` 依赖；同时关闭 tsdown source map（映射本身约 5 MB，而插件发的是预构建 bundle、包内又没有原始 TS 源码，消费者根本用不上）。理由：手机 App 的文件页已原生覆盖同一套能力，桌面端这个页面无人使用。发布包 **1.72 MB → 0.25 MB**；`/dsh-workspace-api` 代理前缀与全部 REST 文件端点未动，App 不受影响
- 附件能力边界：会话历史图片需要宿主提供 `ctx.attachments` 服务；缺失时插件照常激活，读取接口返回 `ATTACHMENT_STORE_UNAVAILABLE`，附件类上传返回 `FILE_UPLOADS_UNAVAILABLE`
- 最近验证：`pnpm typecheck` 通过 · `pnpm test` **38 个测试文件 / 291 个用例全绿** · `pnpm docs:check` 通过（10 文档 / 39 任务 / 9 ADR） · `pnpm build` 两个 entry（host / client）构建完成 · `npm pack`（触发 `prepack → pnpm check` 全闸）通过。**实装目录在发布时同步**（`cp` 把 `lib/` 三个文件拷入 `desktop` 与 `web` 两个 profile，逐文件 SHA-256 校验）：插件为进程内加载，需**重启 dsh** 才生效，浏览器还需 Ctrl+Shift+R 强刷。另有 **4 个浏览器层用例**（Playwright 用真实浏览器量计算样式），4/4 通过
- 界面截图：桌面界面截图**已删除**（那是改名前的旧界面，含 v1.0.0 徽章与旧的 1400px 文件树对话框）。重录需要能驱动插件面板的浏览器环境，目前不具备；二维码另有 SVG/PNG 资产。桌面文件工作区界面（独立页）已于 2.2.0 删除，不再有对应截图需求
- 仓库：`https://github.com/westanke/dsh-remote-bridge`，topic 包含 `dsh-plugin`
- Release：**v2.4.1** —— Gitee `https://gitee.com/westanke/dsh-remote-bridge/releases/tag/v2.4.1`（自传 2 资产 `dsh-remote-bridge-2.4.1.tgz` + `SHA256SUMS.txt`，另平台自动生成 zip / tar.gz）；GitHub `https://github.com/westanke/dsh-remote-bridge/releases/tag/v2.4.1`（2 资产，tgz 555,503 字节）。两站上一版均为 **v2.4.0**（其内容为 Cloudflare WAN 隧道接入；再往前 v2.3.7 为两站齐发的上上版）
- **GitHub 站早期缺口**：GitHub 上的 Release 最早是 `v2.2.0`（2026-10-09），`v2.0.4` ~ `v2.1.3` 只建在 Gitee（tag 两端都在）；`v2.2.0` 起两站齐发
- Release 历史：`v2.0.0` / `v2.0.1` 为已知缺陷版，`v2.0.2` / `v2.0.3` 从未发布；v2.3.2 未单独发版，其修复并入 v2.3.3 的 Release notes；npm 现为 **v2.4.1**
- 正式产物：`artifacts/dsh-remote-bridge-2.4.1.tgz`，**555,503 字节（约 0.53 MB）**，SHA-256 `ad44dbaff25bbd4c6a1ead9ece3b4f08c2bba8dc4dd22c2f350e54cf3b88198d`（`npm pack` 生成；npm dist.integrity `sha512-2wsGPPucDvj9Y…cAXseb2HrHInA==`、shasum `451a71384a4e663214d3b1120cdd4ff2283befab`）。**`artifacts/` 只留本版 2.4.1 一个 tgz**（上一版 v2.4.0 的本地包按「发新版 → 上传 → 回读校验 → 再删上一版本地包」的规矩删除；仓库根另有一个 `dsh-remote-bridge-2.1.3.tgz` 历史包、未被 git 跟踪，勿删）
- 分发：npm [`dsh-remote-bridge`](https://www.npmjs.com/package/dsh-remote-bridge)（官方源 + npmmirror 均有），`dsh plugin --profile web add dsh-remote-bridge` 可用
- 阻塞项：Android 与 DSH WebUI 的后续完整能力对等仍按 `PARITY-001` 推进