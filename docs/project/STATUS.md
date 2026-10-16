# 当前状态

- 日期：2026-10-16
- 阶段：`dsh-remote-bridge` **v2.3.7**（**已提交，未推送未发版**）
- 当前任务：**v2.3.7 = 审批与提问卡片在手机端全灭的第二个病根**
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
- 最近验证：`pnpm typecheck` 通过 · `pnpm test` **30 个测试文件 / 226 个用例全绿** · `pnpm docs:check` 通过 · `pnpm build` 两个 entry（host / client）构建完成。**实装目录本轮未同步**（其路径在工作区之外、属只读挂载，助手提权被拒后按规矩停手）：需用户手动把 `lib/` 三个文件拷入真正被加载的 profile 目录，再**重启 dsh**（插件为进程内加载）。另有 **4 个浏览器层用例**（Playwright 用真实浏览器量计算样式），4/4 通过
- 界面截图：桌面界面截图**已删除**（那是改名前的旧界面，含 v1.0.0 徽章与旧的 1400px 文件树对话框）。重录需要能驱动插件面板的浏览器环境，目前不具备；二维码另有 SVG/PNG 资产。桌面文件工作区界面（独立页）已于 2.2.0 删除，不再有对应截图需求
- 仓库：`https://github.com/westanke/dsh-remote-bridge`，topic 包含 `dsh-plugin`
- Release：**v2.3.6** —— Gitee `https://gitee.com/westanke/dsh-remote-bridge/releases/tag/v2.3.6`（自传 3 资产 + 平台自动生成的 zip / tar.gz，下载回读**逐字节一致**）；GitHub `https://github.com/westanke/dsh-remote-bridge/releases/tag/v2.3.6`（3 资产，tgz 309,399 字节与本地一致）。上一版为 v2.3.5
- **GitHub 站补建说明**：核对时发现 GitHub 上此前**只有 `v1.0.0` 一个 Release**，`v2.0.4`~`v2.3.3` 的 Release 实际只建在 Gitee（tag 两端都在）—— 旧记载的「双站 Release」与事实不符。`v2.3.4` 起两站齐发
- Release 历史：`v2.0.0` / `v2.0.1` 为已知缺陷版，`v2.0.2` / `v2.0.3` 从未发布；v2.3.2 未单独发版，其修复并入 v2.3.3 的 Release notes；npm 现为 **v2.3.6**
- 正式产物：`artifacts/dsh-remote-bridge-v2.3.6.tgz`，**309,399 字节（约 0.29 MB）**，SHA-256 `d2ead6c256cdfc116caaa499c24155afee3a358b18c0cdd52687f725262d3a5e`（`npm pack` 生成，**已发布**：npm 与双站 Release 均上传完成，Gitee 侧下载回读哈希与本地一致）。上一版 `artifacts/dsh-remote-bridge-v2.3.5.tgz`（308,510 字节，SHA-256 `592fdac116faec7b9442d7ed67a799b6aacbb2197716ce2f47f24cccd02bf922`）已发布，按「发新版 → 上传 → 回读校验 → 再删上一版本地包」的规矩**暂不删除**
- 分发：npm [`dsh-remote-bridge`](https://www.npmjs.com/package/dsh-remote-bridge)（官方源 + npmmirror 均有），`dsh plugin --profile web add dsh-remote-bridge` 可用
- 阻塞项：Android 与 DSH WebUI 的后续完整能力对等仍按 `PARITY-001` 推进