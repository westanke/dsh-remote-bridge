# 技术债务台账（TECH-DEBT）

> 台账不是豁免，**是债务**：每条都注明在哪一阶段清掉。
> **只许收紧**：条目对应的债务消失，同一提交里删掉该条目（自证非空转）。
> **上调必须带理由**：超过行数预算只许带理由在同一提交里上调，且必须在下一阶段拆回。
>
> 制度见 `AGENTS.md` §3.2。本文件是**手工台账，暂不进 CI**
> （TS 侧无等价解析器；`docs:check` 当前只校验文档存在性与 ADR 索引）。
> 它回答「欠了多少、在往哪个方向走」，不是「谁违规了」。

## 行数预算

**当前预算：600 行/文件。**

> 比姊妹仓 `dsh-companion`（800）更紧：TS 单文件拆分成本低于 Kotlin，
> 且本仓单文件已普遍偏大。基线测量日：2026-10-15。

超预算文件必须登记在下面。

| 文件 | 行数 | 为什么是债 | 清账阶段 |
|---|---|---|---|
| `src/host/chat-adapter.ts` | 2 110 | 会话链路适配：列表/历史/发送/取消/workspace/agent-preset + 审批/提问适配全在一个文件（2026-11-17 工具调用实时透传 +163：delta 两种新 kind + tool/call、tool/result 透传分支与注释；同日 `hasReplyContent` +44：辅助函数 + 长注释，区分中途提交与最终回答；2026-11-19 issue #23 流式附件通道 +59：`DshApiProxy.sessions.uploadAttachmentStream?` 可选成员 + `DshChatAdapter.uploadAttachmentStream` 薄壳 + 为什么要用稳定 code 原样透传的注释；台账原记 1 844 已过期，按 `wc -l` 纠正） | 按端点族拆（issue #9） |
| `src/host/settings-adapter.ts` | 731 | 提供商与模型目录、通用设置命名空间两件事挤在一个类；SEC-H11 的重定向闸门也落在这里 | 拆 `providers-adapter.ts` 与 `namespaces-adapter.ts` |
| `src/host/bridge/chat.ts` | 677 | 审批桥 `ApprovalBridge` 与提问桥 `QuestionBridge` 挤在一个文件。2026-11-11（issue #13）把审批侧从「接管 = 否决下游」改成「进入即委托 + 两端竞速」，新增三类结算结果（`answered` / `aborted` / `timeout`）、内核结论判定 `isKernelApprovalOutcome`、定时器外提与三条结算分支，文件从 543 → 656（+113），**越过 600 预算**；2026-11-19 复核时台账记的 656 已过期（`wc -l` 实测 677，本轮未改这个文件） | 拆 `src/host/bridge/approval.ts` 与 `src/host/bridge/question.ts`（两个类互不依赖，只共用 `sessionIdOfAgent` / `FrameHub` / `Dsh02HostServices` 三个入参），chat.ts 退回组装门面；纯搬移不改行为 |
| `src/host/ws-handler.ts` | 882 | **`/ws/mobile` 的总装**：鉴权三入口（配对码 / 令牌 / Bearer 连接）、`handleMessage` 解码与分发、13 个域处理器委派、背压发送队列（含可重建帧挑选与 resync 补发）、hello 全在一个类里。2026-10-31 拆出 5 个基础帧到 `ws-basic.ts`、连接上限与心跳到 `ws-connection-policy.ts`（wc -l：HEAD 984 → 861，净 −123；原登记的 974 已过期）。**仍超预算**：issue #4 要求「只留鉴权 + 分发 + 发送路径」并 <600 行，而这三块实测约 430 行、加状态机/挂载/字段脚手架约 250 行，文件下限约 680 行——**`<600` 在该边界下不可达**，属 issue 估算偏乐观，不是拆分未尽 | 已拆 `ws-basic.ts` + `ws-connection-policy.ts`；下一刀：把 ping/subscribe/unsubscribe 三个连接级基础帧与协议常量（`KNOWN_UNSUPPORTED_FRAMES` / `headerValue` / `decodeBase64Utf8`）外移，估 861 → ~780，仍超 600；要真到 600 须放宽「发送路径留在主类」这条边界 |
| `src/host/ws-file-transfer.ts` | 719 | **上传/下载的文件搬运全在一个类**：`file-resolve` / `file-download-open/chunk` / `file-upload-open/chunk/finish/cancel` 六个帧的校验、spool 落盘、背压与超时回收都在这里（HEAD 已 672，本轮之前就超预算但**未入表**，按「既有文件越线，处置同新增超预算」补登）。2026-11-19 issue #23 流式附件通道 +47：`uploadFinish` 改成「先试流式、不能流式才回落 base64」+ `ChatAdapterLike` 的可选流式方法 + 头注释改写 | 拆 `src/host/ws-upload.ts`（上传三帧）与 `src/host/ws-download.ts`（下载两帧），`ws-file-transfer.ts` 退回 `file-resolve` 与分发 |
| `src/host/dsh-0.2-bridge.ts` | 629 | **0.2.x 适配层的组装根**：`createDsh02ApiProxy` 工厂把会话/模型/权限/附件/审批/提问各面装配成 `SettingsApiProxy`，内部闭包不少（HEAD 已 616，本轮之前就超预算但**未入表**，按「既有文件越线，处置同新增超预算」补登）。2026-11-19 issue #23 流式附件通道 +13：`sessions.uploadAttachmentStream` 一段 + import | 链路实现已拆到 `src/host/bridge/` 下十文件，这里只剩装配；再拆的话按「一个链路一个文件」继续外移闭包 |
| `src/host/server.ts` | 1 058 | **远程监听器的总装**：HTTP server 的建/停/重绑（`createBoundServer` / `closeCurrent` / `rebind`）、两条 WS 通道的 upgrade 分流（`/ws/mobile` 与 `/api/v1/events`）、心跳与连接上限、背压广播队列、`/dsh-workspace-api` 前缀路由注册，都在这一个类里（HEAD 已 1 040，本轮之前就超预算但**未入表**，按「既有文件越线，处置同新增超预算」补登）。2026-11-19 issue #26 阶段 0.2 实测只 +18 行（`tunnelListener` 字段 + 构造 + 起停两行 + `status()` 一行），**端口判据没有堆在这里** —— 隧道专用监听抽成了独立文件 `src/host/tunnel-listener.ts`（215 行，在预算内） | 拆 `src/host/listener.ts`（建/停/重绑与 upgrade 分流）与 `src/host/socket-registry.ts`（背压队列 + 心跳 + 连接上限），`server.ts` 退回装配根。~~阶段 0.2 的隧道端口改造要与这刀同批做~~ —— **实际做法相反且更好**：阶段 0.2 先把隧道端口整块抽到 `tunnel-listener.ts`（新文件，零存量风险），`server.ts` 只留 ~18 行接线，于是「先拆再改」变成「改出新文件」，这一刀的紧迫性下降但债本身未清 |
| `src/host/cloudflared.ts` | 707 | **隧道子进程的下载与生命周期全在一个文件**：`cloudflared` 二进制的多源下载（deb / GitHub 备源）、SHA-256 校验、平台架构判定、Quick Tunnel 子进程的拉起与地址提取、以及一组对外的错误键与阶段键（HEAD 已 707，本轮之前就超预算但**未入表**，按「既有文件越线，处置同新增超预算」补登） | 拆 `src/host/tunnel-download.ts`（下载源选择 + 校验 + 解包落盘）与 `src/host/tunnel-process.ts`（子进程拉起 + 地址提取 + 退出处理），`cloudflared.ts` 退回「编排 + 对外状态」。阶段 0.2 只改 `startQuick` 的 `--url` 指向，不动下载面 ⇒ 两刀不冲突 |
| `src/host/bff-schedule.ts` | 684 | **REST 定时任务对等面的全部实现**：`catalog/create/edit/run/view/deleteInactive` 的内核翻译、经典 cron 形态与 0.2.2 七种 `timing` kind 的双向折算、`target` 派生 `sessionId`、cron/时区两套校验器，全在一个类里（HEAD 已 684，本轮之前就超预算但**未入表**，按「既有文件越线，处置同新增超预算」补登） | 拆 `src/host/bff-schedule-timing.ts`（七种 kind ↔ 经典 cron 的折算与两个校验器）与 `src/host/bff-schedule-target.ts`（target 派生），`bff-schedule.ts` 退回端点翻译 |
| `src/client/i18n.tsx` | 675 | **中英文案表与切换控件全在一个文件**：`zh` 文案表（约 300 行）、`MessageKey` 派生类型、翻译函数、locale 的读写与订阅、以及 `LanguageToggle` 组件（HEAD 已 675，本轮之前就超预算但**未入表**，按「既有文件越线，处置同新增超预算」补登） | 拆 `src/client/i18n-zh.ts`（文案表）+ `src/client/i18n.tsx`（函数与组件）。文案表是纯数据、零依赖 ⇒ 可直接搬，不改行为 |
| `src/host/ws-protocol.ts` | 636 | **线路协议的唯一真值来源**：路径与子协议常量、大小与超时预算、`ClientFrameType` / `ServerFrameKind` 两个联合类型、40 余个帧的 TS 形状、以及编解码与 requestId 回显的纯函数，全在一个文件里（HEAD 已 636，本轮之前就超预算但**未入表**，按「既有文件越线，处置同新增超预算」补登）。**它同时是 DEBT-005 的载体** —— 两个联合类型与 handler 实际行为的差集就记在下方 | 拆 `src/host/ws-protocol-frames.ts`（帧形状与联合类型）+ `src/host/ws-protocol-consts.ts`（常量与预算），`ws-protocol.ts` 退回编解码与纯函数。**与 issue #26 阶段 1 同批做**：阶段 1 要把两个联合类型补到与 handler 一致并删掉两处契约白名单，先拆再补可以避免在一个 636 行的文件里同时改结构与内容 |
| `src/host/plugin-inventory.ts` | 605 | **插件清单的读取与启停全在一个文件**：profile 名解析、`DSH_HOME` 定位、清单读取（扫 profile 目录）、更新检查、状态判定（loaded/installed/official）、以及 `togglePlugin` 的启停实现与错误类型（HEAD 已 605，本轮之前就超预算但**未入表**，按「既有文件越线，处置同新增超预算」补登） | 拆 `src/host/plugin-inventory-read.ts`（解析 + 读取 + 状态判定）与 `src/host/plugin-inventory-toggle.ts`（启停），`plugin-inventory.ts` 退回 re-export 与编排 |

> 这几个是**已登记的债，不是许可**。新增超预算文件必须先入本表再写码。
>
> **2026-11-19 issue #26 阶段 0.4 台账补登**（`wc -l` 实测，`find src -name '*.ts' -o -name '*.tsx' | xargs wc -l`）：
> 本轮把**漏登的 6 个超预算文件**补进上表 —— `server.ts` 1 040 / `cloudflared.ts` 707 /
> `bff-schedule.ts` 684 / `i18n.tsx` 675 / `ws-protocol.ts` 636 / `plugin-inventory.ts` 605。
> 补登前，上表只覆盖 12 个文件里的 6 个，另 6 个一直**不在账上** ⇒
> 按 `AGENTS.md` §3.2「新增超预算文件必须先入台账再写码」，纪律对它们是不生效的
> （看不见的债等于没有债）。
> 补登后 `src/` 下**全部 >600 行的文件都已入表**（12 个）：
> `chat-adapter.ts` 2 110 / `server.ts` 1 040 / `ws-handler.ts` 882 / `settings-adapter.ts` 731 /
> `ws-file-transfer.ts` 719 / `cloudflared.ts` 707 / `bff-schedule.ts` 684 / `bridge/chat.ts` 677 /
> `i18n.tsx` 675 / `ws-protocol.ts` 636 / `dsh-0.2-bridge.ts` 629 / `plugin-inventory.ts` 605；
> 其余最大的是 `bridge/kernel-services.ts` 592，在预算内不入表。
> **清账阶段与 issue #26 的阶段一一对应**：`ws-protocol.ts` → 阶段 1，`server.ts` →
> 阶段 0.2，`dsh-0.2-bridge.ts` → 阶段 4，`chat-adapter.ts` → 阶段 9（issue #9）。
> 另 4 个（`cloudflared.ts` / `bff-schedule.ts` / `i18n.tsx` / `plugin-inventory.ts`）与
> issue #26 的阶段无直接耦合，清账阶段单列在本表各行。
> 预算（600 行/文件）**未变** —— 本轮补的是**可见性**，不是放宽。>
> **2026-10-17 按事实更新行数**（原来是 1 730 / 1 245 / 1 233）：C 批四项改动分别落在
> `chat-adapter.ts`（连接即重放、归档列表查询、`historyFormatVersion`，+139）、
> `dsh-0.2-bridge.ts`（能力位核对与 `seq` 隔离的说明注释、`pendingAll`，+56）、
> `router.ts`（`?archived=true` 与两处注释，+5）。
> **2026-10-17 Cloudflare 隧道接入后复核**（行数为 `wc -l` 实测）：`router.ts` 1 293（+28：
> 三个 `/manage/cloudflare/*` 端点与其注释，续在既有 404 之前）、`dsh-0.2-bridge.ts` 1 818
> （其间又 +32 的既有增长）、`chat-adapter.ts` 1 409（+37 的既有增长）、`cloudflared.ts` 221
> （新文件，未超预算不入表，只在此留痕）。
> **2026-10-23 SEC-H11 修复与设备身份后复核**（`wc -l` 实测）：`router.ts` 1 293 → **1 931**
> （设备改名通道、`devices/self` 身份回传、三处 provider 审计字段、注释扩写），
> `database.ts` 865 → **1 005**（设备身份三列迁移、`recordDeviceIdentity`、`renameDevice`），
> `settings-adapter.ts` 588 → **731**（三入口地址策略接线、凭据重定向闸门、`effectiveBaseURL`）。
> **新登记两条**：`database.ts` 与 `settings-adapter.ts` 本轮越线，按「新增超预算文件必须先入表
> 再写码」的纪律补登（严格说是既有文件越线，处置相同：可见、带清账阶段）。
> `provider-url-policy.ts`（186）与 `device-identity.ts`（180）是两个新文件，
> **刻意拆出去就是为了不把既有超预算文件推得更高**。
> **2026-10-24 v2.7.0 四项能力提升后复核**（`wc -l` 实测）：`src/client/workspace.tsx` 660 → **1 225**
> （插件清单卡片与其四态文案、`pluginInventory`/`togglePlugin` 两个调用、五条插件错误码映射），
> `chat-adapter.ts` 1 409 → **1 663**（`reuseBlank` 复用空白会话 + `CreateSessionOptions`；
> 注：台账原记 1 409 已过期，中间几轮改动未回填，本轮按 `wc -l` 一次性纠正），
> `dsh-0.2-bridge.ts` 1 818 → **2 682**（模型容量补齐 `modelCapacityOf` / `enrichModelGroups`；
> 同上，原记 1 818 亦为过期值），`router.ts` 1 931 → **1 934**（`reuseBlank` 透传）。
> **新登记一条**：`src/client/workspace.tsx` 本轮越线，按纪律补登。
> 新增的 `src/client/plugins.tsx`（201）**刻意独立成文件**就是为了不把 `workspace.tsx` 推得更高 ——
> 与 `provider-url-policy.ts` / `device-identity.ts` 同一处置。
> **预算（600 行/文件）未变，清账阶段未变** —— 变的只是「事实数字」。
> 本文件第 41 行自己写着「旧值会骗人」，这次就是被它抓到：上一轮我引用台账时，
> 记的还是几个月前的数字。
> **2026-10-28 REST BFF 三项后复核**（`wc -l` 实测）：`router.ts` 1 934 → **2 062**（+128：
> 分块上传 / 定时任务 / 官方语音的 9 段瘦分发与 `bff` 字段、`dispose()`、构造期装配）。
> **业务逻辑刻意没往 router 里塞**：新增约 1 570 行全在 `bff-rest.ts`(333) /
> `bff-upload.ts`(360) / `bff-schedule.ts`(580) / `bff-speech.ts`(298) 四个新文件里，
> router 只增了分发与装配 —— 与 `provider-url-policy.ts` 同一处置。
> 预算（600 行/文件）未变；这四个新文件都在预算内。
> **2026-10-31 按 capability 拆分清账**（issue #3，`wc -l` 实测）：`router.ts` 2 094 →
> **345**（组合根：imports + 选项类型 + handle/dispatch 的三个保留门 + openTunnelForCommand
> 委托 + `matchJobRoute`/`decodePathSegment` re-export），能力块拆
> `src/host/routes/{chat,cloudflare,devices,files,plugins,settings,shared,registry}.ts`
> 8 个文件（54–517 行，全部 <600）。纯搬移：URL/method/status/error code/body 不变，
> `openapi.yaml` 未动、契约测试零改动；`routes/registry.ts` 是 path → handler 的一屏总览
> （`routes` 字面量为文档性，动态段以 handler 内分支为准）。同一提交删本表 `router.ts` 行。
> **2026-10-29 `/ws/mobile` requestId 统一回显后复核**（`wc -l` 实测）：`src/host/ws-handler.ts`
> 769 → **837**（+68：`AsyncLocalStorage` 请求上下文、`handleMessage` 拆出 `routeFrame`
> 承载原分发链、`reportFrameError` 兜底分发异常；`sendFrame` 只在 `encodeFrame` 前多一次
> `withRequestIdEcho`，背压队列未动），`src/host/ws-protocol.ts` 514 → **583**（+69：
> `REQUEST_ID_ECHO_EXCLUDED_KINDS` 排除集合 + `requestIdOf` / `withRequestIdEcho` 两个纯函数，
> 仍在预算内，不入表只留痕）。

> **2026-10-29 `/ws/mobile` 补齐心跳/连接上限/背压告知后复核**（`wc -l` 实测）：
> `src/host/ws-handler.ts` 837 → **974**（+137：`startHeartbeat`/`clearHeartbeat` 心跳循环、
> `connectionLimit()`、`enqueue` 按可重建性选牺牲者、`drain` 排空后补 `connection-resync-required`、
> `MobileGatewayOptions` 三个可注入参数）。这一轮是**把文档承诺补成实现**（API.md 一直写着
> 「30 s 心跳 / 32 连接 / 溢出优先丢可重建帧 + resync 通知」，`/ws/mobile` 一条都没做），
> 膨胀量全部来自兑现承诺与它们的 KDoc，不是新功能扩张。清账阶段追加一条：心跳与连接上限
> 政策可独立抽成 `ws-connection-policy.ts`。
> **新登记一条**：`src/host/ws-handler.ts` 自 `/ws/mobile` 网关那一轮起就超预算且从未入表，
> 属既有欠账（本轮之前已经是 769 行），按「既有文件越线，处置同新增超预算」补登。
> 预算（600 行/文件）未变；清账阶段未变。

> **2026-10-31 database.ts 按表族拆完后复核**（`wc -l` 实测）：`src/host/database.ts`
> 1 005 → **411**（组合根：连接/PRAGMA/迁移装配/跨表族事务 + 全部公开方法的一行委托），
> 表族拆到 `src/host/db/` 下九个文件（devices 423 / migrations 163 / roots 158 /
> audit 113 / pairings 73 / trash 73 / idempotency 33 / secrets 14），**全部在预算内**。
> `database.ts` 条目**按「清账」删掉**：行数债已消失，不是许可。
> 拆法要点：表族依赖叶子朝上（secrets → audit → roots → devices → pairings），
> 跨族依赖走构造注入（`RootLookup` 只读口 + `bumpRevision` 回调），
> 跨表族事务（`exchangePairing`）留在组合根 —— SQLite 事务挂在连接上。
> 对外 API 零改动：12 处 import 与全部 database spec 原样通过。

> **2026-10-31 dsh-0.2-bridge.ts 按链路拆完复核**（`wc -l` 实测）：2 796 →
> **594**（组装根：`createDsh02ApiProxy` 工厂 + `bridge/` re-export 面），
> 链路拆到 `src/host/bridge/` 下十文件（kernel-services 523 / chat 543 /
> attachments 362 / frame-hub 361 / rpc 174 / host-reads 134 / models 126 /
> permissions 108 / projections 87 / proxy-options 29），**全部在预算内**。
> 条目**按「清账」删掉**：行数债已消失，不是许可。拆法要点：纯搬移 +
> 两处工厂内联闭包包装成显式参数函数（`wireSessionRegistryRelay`/
> `createAgentResolver`，行为不变）+ 签名内联 options 类型抽出命名类型；
> 对外 re-export 面零改动（15 处 import 原样）；7 处 `@patch` 随链路整段
> 搬移，`patch-discipline.spec` 断言未动照常通过。

## 已知结构性债务

| ID | 债务 | 位置 | 为什么现在不动 | 清账条件 |
|---|---|---|---|---|
| DEBT-001 | 0.2.x 兼容层与 0.1.x 面容双轨并存 | `src/host/bridge/`（组装根 `dsh-0.2-bridge.ts`） | 用户内核版本跨度大（0.1.x / 0.2.x 都要能跑） | 上游明确只支持 0.2.x，或本项目发布 3.0 只支持 0.2.x |
| DEBT-002 | README 双站无自动对账 | `README.md` / `README.en.md` | `docs:check` 不覆盖 README；TS 侧无 README 解析器 | `docs:check` 扩展：校验版本号/插件基线/测试数双站一致 |
| DEBT-003 | `@patch` 四要素无脚本校验 | 全仓 | 制度已立（`AGENTS.md` §3.3），尚无扫描器 | `docs:check` 或独立脚本：扫 `// @patch` 块验四要素齐全 + `test` 指向的测试真实存在 |
| DEBT-004 | 历史兼容补丁未全部自报 | `src/host/bridge/` 等 | 存量补丁一次清完会动到刚真机验收过的逻辑 | 按代际分批收编；**可以不再无声增长** |
| DEBT-005 | `/ws/mobile` 的帧联合类型未收录 handler 实际处理的全部帧 | `src/host/ws-protocol.ts` 的 `ClientFrameType` / `ServerFrameKind` | `asyncapi.yaml` 是按**实际行为**写的契约（handler 认哪些帧、发哪些帧），两个联合类型是早期按域分批加的，缺了后来补的帧。补齐要逐个核对 handler 分支，且补完必须同步删掉契约白名单（`scripts/check-project-docs.ts` 与 `tests/mobile-frame-contract.spec.ts` 两处），一次做不完容易两处不同步 | 把 `ws-protocol.ts` 两个联合类型补到与 handler 实际行为一致；同一提交删掉 `MOBILE_CLIENT_ONLY_IN_CONTRACT` / `MOBILE_SERVER_ONLY_IN_CONTRACT` 两个白名单里的对应项（白名单只许变短，测试会盯） |

> **DEBT-005 的白名单是台账不是豁免**：`scripts/check-project-docs.ts` 与
> `tests/mobile-frame-contract.spec.ts` 各有一份「契约里有、联合类型里还没有」的白名单，
> 两处必须同步；两边都断言白名单与联合类型**不相交**，所以谁把联合类型补齐却忘了删白名单，
> 测试会直接红。当前白名单：客户端 `fork`/`workspace-create`/`file-list`/`directory-create`/`directories`；
> 服务端 `paired`/`fork`/`workspace-create`/`host`/`models`/`default-model`/`providers`/`permission`/
> `permission-options`/`agent-presets`/`session-stats`/`context-usage`。

## 账怎么记

- **新增**：写码前先入表，注明「为什么是债」与「清账阶段」。
- **清账**：同一提交里删条目 + 在 `CHANGELOG-DEV.md` 记一条（基于什么/为什么/干了什么/测了什么）。
- **收紧**：行数下降时更新数字，不留旧值（旧值会骗人）。

> 判据不是「有没有债」——**债可见且方向向下，比假装没有债更可信。**
> 这与 `dsh-web-mobile` 的债务台账是同一条制度：它的 `sidebar-swipe.ts` 还有 1 593 行，
> 但每条都带变迁史与清账阶段。
