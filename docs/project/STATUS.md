# 当前状态

- 日期：2026-10-25
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
  ⑧ **单胜方交互的核账**（ADR-0009，状态 **proposed**）：报告拆出的四件事里，
  我方**已有两件**（②身份比对、④迟到响应 `not-pending`，且都有测试钉住），
  另两件（①并行下发、③abort 下游收起 WebUI 弹窗）**待拍板** —— 其中 ③ 依赖
  `req.signal` 的可写性与宿主 fan-out，**本仓不可证**。**未改代码**：串行 vs 并行是产品行为，
  且硬做可能留下「永远挂着的弹窗」。附一个低成本验证实验（让一次审批的 `req.signal` abort，
  看官方 WebUI 弹窗是否自行收起）。
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