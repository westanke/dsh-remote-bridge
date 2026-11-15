# dsh-remote-bridge 2.10.1 → DSH 0.2.2-rc.1 适配差距清单

> 一次**差距调研**，不是适配记录。回答三个问题：
> 1. 2.10.1 在 DSH 0.2.2-rc.1 上能否直接运行？哪些功能会坏？
> 2. 0.2.2 带来了哪些桥应该跟进的新能力？
> 3. 要改哪些文件、按什么优先级改？
>
> **验证状态标注**：`[已验证]` = 本机可查证据（两版 tarball 逐包 diff、实装树、本仓源码）；
> `[未验证]` = 需在实装 profile 上跑一遍（本机桌面已是 0.2.2-rc.1，可直接验）。
>
> 调研基线：
> - 本仓：`dsh-remote-bridge@2.10.1`（main `c7d3eb3`）
> - 上一轮适配基线：`DSH-0.2.1-ADAPTATION.md`（内核 0.2.1-rc.2）与 v2.9.0 复核（内核 0.2.1-rc.5，18/19 包零差异，无需改码）
> - 目标内核：`@deepseek-ai/dsh@0.2.2-rc.1`（本机实装
>   `~/.dsh-desktop/runtime/node-v24.19.0-linux-x64/lib/node_modules/@deepseek-ai/dsh`，
>   **依赖树改为 nested node_modules**，330 个 `@deepseek-ai/*` 包在 `dsh/node_modules/@deepseek-ai/`）
> - 比对方法：两版 28 个桥消费面包的 tarball 逐包 diff（npm 上已有 0.2.2-rc.3，本文以实装 rc.1 为准）

---

## 〇、结论先行

### 0.1 能否直接运行？

**能运行，但有两个 wire 破坏面会让具体功能坏，需要尽快适配。**

结构化消费面复核 `[已验证]`：

| 桥消费面 | 0.2.2-rc.1 状态 | 结论 |
|---|---|---|
| 硬注入 10 服务（`src/index.ts:64-75`） | 10/10 包在，方法签名未变 | 直接可用 |
| 订阅的 4 个 typert 事件（approval/request、user-questions/request waterfall；agent-preset/selected、api-session/status emit） | remote-events.d.ts 只增未删 | 直接可用 |
| `follow` / `page` / `prompt` / `fork` / `rename` / `search` / `selectModel` / `modelCatalog` / `updateQueue` | 全部在 | 直接可用 |
| `permissionPresets.catalog` / `userQuestions.continued+answer` / `commands.list+execute(四参)` / `llm` 四方法 / `webServer.register({kind,path,handler})` | 全部在 | 直接可用 |
| `sidebarRightTabs` slot 契约 | slots.d.ts 仅注释级变化（additive） | 直接可用 |
| `SessionProjectionStateMap`（0.2.2 删除） | 桥从未消费（grep 无命中） | 无影响 |
| `SessionProjectionUpdate` 帧改形（`{key,value,seq}`→`{changes:[{key,val}]}`） | 桥 frame-hub 不消费投影帧 | 无影响 |
| 会话列表 `projectionValues` 收窄为 summary 集 | 桥未消费 | 无影响 |

7 个可选服务包（permissionPresets/jobController/fileUploads/attachments/workingDirectory/workspaceFiles/schedule）在 0.2.2-rc.1 实装树**全部存在** `[已验证：包存在]`；
web profile 上是否真激活 `[未验证]`——`GET /dsh-workspace-api/api/v1/debug/host-services` 一次探针可定论。
workingDirectory/workspaceFiles 在 0.2.1 因 `static inject` 缺 `fs` 激活不了；0.2.2 的 bundle/profile 机制改版（`ProfileTemplate`/`PROFILE_TEMPLATES`/`official-bundles` 删除、`bundle-platform` 新增），激活结论必须重测。

### 0.2 哪些功能会坏？（P0）

1. **历史图片读取的降级路径**（`session/attachment` wire 破坏）——见 §一 **[已实施 2026-11-15：桥侧 `resolveImageRef` 历史回走 + LRU，见 §一尾]**
2. **定时任务全链路**（schedule wire schema 大改）——见 §二 **[已实施 2026-11-15：`ws-schedule.ts`/`bff-schedule.ts` 双向翻译，engines.dsh 升 `>=0.2.2-rc.1 <0.3.0`]**

---

### 0.3 npm 版本核实（2026-11-15 补）`[已验证]`

| 通道 | 版本 | 发布日 | 说明 |
|---|---|---|---|
| `latest` | **0.2.2-rc.1** | 11-04 | 与本机实装一致——**调研基线就是 npm latest，§一~§六结论对「可安装版本」全部成立** |
| `next` | 0.2.2-rc.3 | 11-13 | 预发布通道（rc.2 于 11-12） |

- **npmjs 上 0.2.2 系只有 `dsh` 主包**：27 个子包在 npmjs 整体 E404（`@deepseek-ai/schedule` 任何版本都不存在，其余 26 包无任何 0.2.2 版本）；主包 rc.2/rc.3 的依赖精确钉在同名 `0.2.2-rc.2/rc.3` 子包上 → **从 npmjs 单独装不上**，桌面 runtime 是整包更新下载、不走 npm。
- **rc.1 → rc.3 主包差异对桥无影响**：lib/types 除新增 `userAgentProfile()`（RFC 9110 User-Agent 编码，遥测性质）与 source map 外零差异；plugin chunk 服务名串零差异（注入面未动）；其余为 chunk 哈希改名。桥 `engines.dsh` 为 `>=0.2.0-rc.2 <0.3.0`，rc.3 天然在范围内。
- 子包级 rc.2/rc.3 变化**无法从公开源核实**（npmjs 无、npmmirror 无）；待桌面端实装升级后按本文 §五清单复测即可——P0 两项（attachment 形状、schedule wire）以届时实装为准。

## 一、P0-1：`session/attachment` 请求形状破坏 `[已验证]`

内核 wire（`api-session-controller/typert.host.js` 的 `session/attachment`）：

- 0.2.1：`{ sessionId, attachmentId }`
- 0.2.2：`{ sessionId, attachment: ImageAttachmentRef }`，其中 `attachment` **必填**
  `attachmentId` + `mediaType`（png/jpeg/webp/gif）+ `bytes` + `width` + `height`，
  可选 `name` / `originalDimensions`。**四个新必填字段缺一即 wire 校验失败。**

桥现状：`src/host/dsh-0.2-bridge.ts:288-289` 传旧形状
`host.sessionController.attachment({ sessionId, attachmentId })`；
`src/host/bridge/kernel-services.ts:150` 的 `AttachmentStoreLike` 声明同形状；
ref 构造处 `kernel-services.ts:68` 的 `ref` 各字段为可选。

影响：`ctx.attachments` 可用时主路径（`AttachmentStoreLike.readImage`）不走此方法，不受影响；
**降级路径（attachments 服务缺失/异常时的历史图片读取）在 0.2.2-rc.1 上必坏**。
0.2.2 实装树有 `dsh-attachment-local`，但探针未验证激活——降级路径必须按能被走到来修。

修法（一处改动 + 类型收紧）：
- `AttachmentStoreLike.attachment()` 与 `dsh-0.2-bridge.ts` 调用处改传
  `attachment: { attachmentId, mediaType, bytes, width, height }`；
- ref 来源核对：0.2.2 消息 image part（`AttachmentAdmissionPart` image 变体）自带
  `{ attachment: ImageAttachmentRef, encodedBytes }`，四个必填字段都能从 part 拿到，
  需要逐个 ref 构造点确认没有字段缺省。
- 配套：wire schema 五处同步（本项是内核私有协议翻译，桥对外 REST 未变则只动适配层与测试）。

---

## 二、P0-2：schedule wire schema 大改 `[已验证]`

`@deepseek-ai/dsh-schedule` 0.2.2-rc.1 对记录与错误面做了重构：

| 维度 | 0.2.1 | 0.2.2 |
|---|---|---|
| 投递目标 | `sessionId: string` | `target`: `{kind:'session', sessionId}` \| `{kind:'new_once', sessionId, create:{cwd?, agentPreset?}}` \| `{kind:'new', create:{...}}` |
| 状态 | `active \| inactive` | `active \| paused \| ended` |
| 新增字段 | — | `involvedSessionIds` / `createdAt` / `updatedAt`（乐观并发） / `executionActive` / `deliveryFloorEndsAt` / `lastDelivery.targetSessionId` |
| 规则 | at/after/every/cron/weekly/daily | 同左 + **`RRuleScheduleRecord`**；`SCHEDULE_CHANGE_VERSION`/`CRON_SEARCH_HORIZON_YEARS`/`FoldedSchedules`/`LegacyScheduleRecord`/`decodeScheduleChange` 删除 |
| 错误码 | 内联枚举 | `ScheduleInputErrorCode` 独立类型 |

桥受影响面：
- `src/host/ws-schedule.ts`（schedule-list/history/update/delete 五帧，`EXPECTED` 字段透传清单）；
  App 端 schedule UI 期望旧形状（`sessionId`/`status:'inactive'`）。
- `src/host/bff-schedule.ts`（`ctx.schedule` 集成）：创建/更新参数按新 schema 变化；
  `updatedAt` 乐观并发的 `expectedUpdatedAt` 语义要透传。
- **wire schema 五处同步**：REST/WS 的 schedule 对外契约变化必须同批改
  `API.md` + `openapi.yaml` + `asyncapi.yaml` + `kotlin-sdk` + 测试。
- 新能力（顺带获得）：`new_once`/`new` 目标 = 定时任务可创建新会话；
  App 可暴露「每次投递开新会话」的选项。

---

## 三、P1：行为变化与对齐项

1. **`dsh.client.inject` 死引用** `[已验证]`：四包中的 `@deepseek-ai/dsh-client-runtime`
   在 npm（0.2.1-rc.5/0.2.2-rc.1 均无此包）与 0.2.2-rc.1 实装树都不存在；三个 client-ui 包都在。
   面板在 0.2.1 上渲染正常 → 内核对缺失 inject 宽松处理（`dsh-client-modules/lib/client.js`
   `arriveGraphRow`：graph row 不存在的 inject 项静默跳过），死引用**已清理 2026-11-15**
   （`package.json` inject 只留三个实装的 client-ui 包；桥 client bundle 自包含、仅 external react，
   不 import 这四者任何一个）。面板在 0.2.2-rc.1 的渲染 `[未验证]`。
2. **`page().throughSeq` 变可选** `[已验证]`：省略 = 观察到的日志末端。
   **已对齐 2026-11-15**：`SessionControllerLike.page` 类型改 `throughSeq?: number`，
   但桥**保留锚定** follow 首帧 cursor——页窗口是 `(beforeSeq, throughSeq]`，省略会让
   follow 打开后的新流量挤占窗口、把切片推离调用方已知的最旧记录（`attachments.ts`
   的回走同理）。新 `session/events` 是 `page` 的正式名（page 为 deprecated 别名），
   wire 形状一致，桥刻意继续用 `page`（少一次重命名，回滚面小）。
3. **`follow` 新增 `activate?: boolean`**（省略 = passive read）`[已验证]`：
   桥 v2.9.0 的只读窄口语义与新默认一致，确认即可；不传就是 passive。**已确认 2026-11-15**：
   桥所有 `follow` 调用只传 `address/maxMessages/assistantStream`，不传 `activate` ——
   默认即 passive，语义正好一致，无需改码。
4. **user-questions 新 `kind:'approval'` 问型** `[已验证]`：阻塞式权限决策卡片
   （approve/reject/always + subject/display 本地化）。桥 ws-hitl 走自己的
   approval-response 协议，不识别该 kind 也不炸；如要统一体验可后续对齐。
5. **`PrincipalMap` 新增 `share-viewer`** `[已验证]`：桥鉴权面按结构判定 admin 的路径
   （`auth.ts` 四层回环判据）不依赖 PrincipalMap；但桥对外端点要确认 share-viewer
   身份不会经任何桥路径获得 admin（安全纪律：改桥必测安全）。**已复核 2026-11-15**：
   桥 Principal 只有 `kind:'admin'|'device'`（`src/shared/contracts.ts`），admin 走
   `adminRefusal` 四层传输判据（回环 socket + 回环 Host/Origin + 无转发头 + 隧道关门），
   device 走 Bearer 配对令牌 —— 两者都与内核 PrincipalMap 无关；`share-viewer` 只存在于
   内核 remote 会话面，没有任何桥路径把它映射成桥侧 admin。无需改码。
6. **`commands` 内置命令身份** `[已验证]`：新 `lib/types/builtin.d.ts` 暴露
   `BUILTINS`（goal/plan/feedback/compact/permission/export）与中英 token；
   `Agent` 接口新增 `readonly model: Model{current(),select()}`（selectModel 的 host 侧对应）。
   桥 commands 面可透出 builtin 身份供 App 命令面板分组/本地化。
7. **`agent-preset-registry.presetForSession(session)`** 新增 `[已验证]`（含不在名册的历史选择）。
8. **gateway：Remote WebSocket 默认 per-message deflate**（`websocketCompression` 配置，默认 `'deflate'`）
   `[已验证]`：桥自己的 WS 是自建 server，不受影响；桥订阅 typertGateway 事件走进程内。
9. **app-boot bundle 机制改版** `[已验证]`：桥是 out-of-tree 插件经 `cordis.patch.yml` 注入，
   `engines.dsh` 判定不涉这些常量；插件在 0.2.2-rc.1 上的激活 `[未验证]`（真机 apply 一次即知）。

## 四、P2：新能力跟进（机会清单）

> **2026-11-15 更新**：A–E 五项已按用户指令「现在做」全部实施（均 additive，
> 详见 CHANGELOG-DEV「三、P2 机会清单 A–E」）：✅session/wait 长轮询（REST `/wait`
> + WS `session-wait/session-waited` 帧对）；✅附件元数据透出（`POST /attachments`
> 加 `attachment` 字段——注：`uploadImage` host 侧是 AsyncIterable 仅进程内、
> 网关不可达，正式图片两步流未做）；✅`llm/models-updated`→`chat.models.updated`
> 推送（badge 随 models 接口自然透出）；✅内置命令词条（`builtinTokens`/
> `definitionId`/`builtin`）；✅schedule timing/target 透传（item 恒回 `kind`、
> 非 cron 不隐藏、POST/PATCH 收 `timing`、`target` 支持 new_once/new）。
> 以下原始清单保留作对照。

| 能力 | 内核面 | 桥可做什么 |
|---|---|---|
| 被动会话状态/等待 | `session/state`、`session/wait`（`SessionState{cursor,active,running,queue,pendingInput}`；`reason:'idle'\|'input-required'\|'timeout'`）、`session/observeState/observeEvent/observeProjections` | 手机端「等待回复完成」「查看排队消息/待审批」可用官方等待 API 重写，比事件桥稳 |
| 图片两步流 | host 侧 `fileUploads.uploadImage(sessionId, data, mediaType, …)` → `{receiptId, image}`；`resolve` 返回 `StagedAttachment`；`AttachmentAdmissionPart` 新增 image 变体 | App 大图上传摆脱 base64 内联与体积上限（v2.5.5 的 12MB 缓解被正式通道替代） |
| 模型目录热更新 | 新事件 `llm/models-updated(provider)`；`LlmModelBadge{text,tone}` | ws-models 订阅事件推送刷新，替代轮询；模型列表透传 badge |
| 内置命令 | `builtinCommandTokens`（目标/计划/反馈/压缩/权限/导出） | App 命令面板本地化与分组 |
| schedule 新目标 | `new_once`/`new`、RRule | App 定时任务支持新会话目标 |
| webserver 进程内资源 | `WebResource`/`WebResourceRoute`/`WebServer.readResource`、`index-inject` 事件新增 peer 参数（additive） | 桥暂无需迁移（handler 形态不变） |
| 文件变更监听 | `workspaceFiles` 若在 0.2.2 web profile 真激活（A1 前提） | A1（文件预览与变更监听）可排期 |
| 工作目录真服务 | `workingDirectory` 若真激活 | 桥的只读投影路线可升级为服务调用 |

## 五、真机验证清单（本机桌面已是 0.2.2-rc.1，装桥即验）

1. `GET /dsh-workspace-api/api/v1/debug/host-services`：7 可选服务 resolvable？（§0.1、§四）
2. 历史图片读取：打开一条带图历史会话（降级路径实况，§一）
3. `schedule-list`：新记录形状透传实况（§二）
4. WebUI 手机设置面板渲染（client.inject 死引用实况，§三.1）
5. 插件 apply 是否正常激活（bundle 改版实况，§三.9）
6. 安全回归：`pnpm test` 全量（改 attachment/schedule 后按 §3.4 表复核鉴权与降级守门）

## 六、建议的 issue 拆分

| # | 主题 | 级别 |
|---|---|---|
| 1 | attachment 请求形状适配 + ref 必填字段核对 | P0 |
| 2 | schedule wire 适配（ws-schedule/bff-schedule/REST/五处同步/SDK） | P0 |
| 3 | client.inject 清理 dsh-client-runtime 死引用 | P1 |
| 4 | throughSeq 可选 + session/events 切换（简化 kernel-services） | P1 |
| 5 | session/wait、uploadImage、llm/models-updated、builtin commands 等新能力跟进 | P2 |
| 6 | 真机探针验证（§五清单跑一遍并回填本文验证状态） | 前置 |

> 调研产物：本文件 + 会话内逐包 diff 记录（28 包 tarball 在 `~workspace/.dhs-diff/`，可清理）。
