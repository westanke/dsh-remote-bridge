# dsh-remote-bridge vs dsh-plugin-mobile-gateway 功能/能力对比分析

> 数据来源：`dsh-remote-bridge` 本地仓 v2.7.1（`src/host/server.ts`、`src/host/chat-adapter.ts`、`docs/project/API.md` 等）；`dsh-plugin-mobile-gateway` 上游 `Clarklevis1995/dsh-plugin-mobile-gateway` **v0.11.1** （`package/PROTOCOL.md`、`package/lib/index.mjs`，npm registry tarball，解压至 `/media/wangke/OFFICE/workspace/dsh-study/mobile-gateway-latest/package/`）。
>
> 注意：之前基于本地旧副本 v0.10.1 做过一次对比（commit f7b5c44，已写入 `/ws/mobile` WS 基础能力）。本文以 npm 发布最新版 **v0.11.1** 为新基准重新对比，v0.11.1 相对 v0.10.1 大幅新增：普通文件分块上传（SHA-256 校验、进度确认、取消、断线清理）、file-references-v1、deliverables/presented、assistant-stream、llm/retry 事件、session-stats、session-archives/title-changed、tasks-updated/goal-updated/projection-baseline/schedule-changed 推送、schedule 定时任务、plugin management、speech 输入、agent-team/子会话、session-create、fork、split-channels、设备名称、agent-preset 会话锁定、protocol v3、pairing v2 Base64URL。
>
> 核心结论：remote-bridge 仅把 DSH 内部事件做**单向广播**（REST 为主，WS 仅 /api/v1/events 推事件）；mobile-gateway 是一套**双向请求/响应**的移动端网关协议，WS 优先，REST 兜底，能力面远大于 remote-bridge。以下列出 remote-bridge 相对 mobile-gateway (v0.11.1) 缺失的能力，作为向 mobile-gateway 靠拢的改造清单。

---

## 1. 总览对比表

| 维度 | dsh-remote-bridge (v2.7.1) | dsh-plugin-mobile-gateway (v0.11.1) | remote-bridge 缺失 |
|---|---|---|---|
| 定位 | DSH 内部 remote 协议 → 版本化 REST；WebUI「手机设置」面板（只做设置） | 移动端持久化插件：WS 长连接，双向收发，设备配对与鉴权 | 无移动端网关定位 |
| 主通道 | REST `/dsh-workspace-api/*`（设备 token / loopback admin）；WS 仅 `/api/v1/events` 单向推事件 | WS `/ws/mobile`（本机 3080 / 独立监听 3081 / 公网 wss）；REST `/mgw/*` 仅管理面 | remote-bridge WS 只推事件，不接收客户端请求 |
| WS 端点 | `/api/v1/events`（挂主 HTTP server upgrade） | `/ws/mobile`（独立监听，可共享 3080，可 Cloudflare 穿透） | 无独立 WS 路径；无公网穿透 |
| WS 子协议 | `bearer.<token>`（Sec-WebSocket-Protocol） | `dsh-mobile-v1, dsh-pair.<v2>`（首次配对） / `dsh-mobile-v1, dsh-auth.<token>`（后续） | 无配对子协议；无 dsh-mobile-v1 协议标识 |
| 配对机制 | REST 配对码（`/api/v1/pairings/exchange`，设备 token） | 一次性 256-bit 配对码 + `X-DSH-Device-ID`；pairing v2 Base64URL 载荷（{version:2, publicUrl, pairingCode, expiresAt}）；token 存 Keychain；`paired` 帧下发 token（只发一次） | 无 WS 配对流程；无设备持久 ID；无 pairing v2 |
| 鉴权模式 | 设备 token 或 loopback admin；`principal()` 统一判据 | gatewayEnabled/gatewayMode（disabled/temporary/persistent）；requireAuth；本机可 Debug 免凭证；独立 LAN 监听始终强制鉴权；close code 4003/4004 | 无 gateway mode 状态机；无 Debug 免凭证本机监听；无 WS close code 4003/4004 |
| 帧格式 | JSON 文本帧（`stringifyWire`） | 全 JSON 文本帧；图片/语音标准 Base64（无 data: 前缀） | 已具备（基础） |
| 连接即推送 | `connection.ready`（能力位） | `hello`（protocol:3、能力列表、authenticated、device、port、clients） | 能力位已有，但缺 authenticated/device/port/clients |
| 分信道 | 无 | split-channels（X-DSH-Channel control/conversation，control 连接做配置/插件/语音/定时任务，conversation 连接做消息/会话） | 无分信道 |
| 设备名称 | 无 | X-DSH-Device-Name（Base64 UTF-8 设备名称） | 无设备名称 |
| 心跳 | ping/pong，连续错过 2 周期 terminate | 同上（ws 底层） | 已具备 |
| 背压/溢出 | per-connection 队列；丢可重建帧；`connection.resyncRequired`；close(1013) | 同上类设计 | 已具备（基础） |
| 设备撤销 | drain 时 refreshPrincipal；撤销 close(4001) | token 撤销即时生效 | 已具备（基础） |
| 事件过滤 | scopes (files.read/chat.read)、rootIds、sessionId 授权 | 同上类 | 已具备（基础） |
| **客户端→服务端请求** | **无**（WS 仅服务端→客户端广播） | ping/subscribe/unsubscribe/message/workspaces/sessions/history/attachment/file-*/search/host/models/commands/goal/question-answer/approval-response/… | **重大缺失：WS 无上行请求/响应** |
| 发消息（message） | 仅 REST `/api/v1/sessions/:id/messages` | WS `{type:"message"}`，sessionId 可选（省略自动创建会话）、mode queue\|steer、纯图片、clientTimeZone、workspaceId/cwd | **缺失：WS 发消息** |
| 自动建会话 | 无 | message 省略 sessionId → 先建新会话再发；workspaceId/cwd 放入工作区 | **缺失** |
| 会话/工作区列表 | REST | WS `{type:"workspaces"}` / `{type:"sessions"}`（sessions 轻量投影：sessionId/updatedAt/running/blank/cwd/agentPreset/parentSessionId/origin/projections{asOfSeq,values.title}） | **缺失：WS 查列表** |
| 历史分页 | REST | WS `{type:"history"}`（beforeSeq/maxMessages/maxBytes/view:"conversation"，hasMore+nextBeforeSeq 向后分页，默认 4 MiB，historyFormatVersion 4） | **缺失：WS history** |
| 附件/图片 | REST upload/read | WS `{type:"attachment"}`（verified metadata + canonical base64 bytes，images Base64 无 data: 前缀，单图约 3.5 MiB，单条总 100 MiB） | **缺失：WS attachment** |
| 文件下载 | 无 | WS file-download-open/read/cancel（transferId, offset, chunk, eof, sha256；最大 512 MiB，chunk 256 KiB，最大 4 并发，idle 2 min，超时 180s） | **缺失：WS 文件下载** |
| 文件上传（v0.11.1 新增） | 无 | WS file-upload-open/chunk/finish/cancel（SHA-256 校验、receiptId、progress、断线清理；单文件 512 MiB、块 256 KiB、4 并发、空闲 2 min，uploadEnabled 独立开关） | **缺失：WS 文件上传** |
| 命令目录/执行 | REST | WS commands/command-options/command-select/command-execute（ui.kind immediate/input/select；source host\|skill；model/permission 走官方命令） | **缺失：WS 命令** |
| 模型管理 | REST | WS models/providers/select-model/default-model/save-default-model（sessionId 可选，带=会话目录 current+routable+groups，不带=全局 groups+failures） | **缺失：WS 模型管理** |
| 默认值 | 无 | WS defaults/set-default（agentPresetDefault/permissionDefault/permissionDefaultOptions/modeSelectionEnabled） | **缺失：WS 默认值** |
| 目录/工作区操作 | 无 | WS directories/directory-create/workspace-create（父路径必须绝对且存在；目录不存在 directory-create-failed；已存在 directory-exists） | **缺失：WS 文件系统** |
| 会话生命周期 | REST cancel/rename/archive/fork | WS session-create/session-cancel/session-archive/session-rename/fork/session-title-changed/session-archives | **部分缺失（REST 有，WS 无）** |
| 分支/子会话 | REST fork | WS fork（sessionId+atSeq+historyFormatVersion，子会话继承 cwd/模型/血缘/标题/工作区）；session-create 提前创建空会话 | **缺失：WS fork/session-create** |
| 队列/目标控制 | 无 | WS queue-update（edit/remove/steer，move into current turn）；session-queues/session-queue 推送 | **缺失：WS 队列控制** |
| HITL 提问 | REST question-answer/question-cancel | WS question-answer/question-cancel + server→client question-requested/response/resolved（replay 重放；rpcId 去重；bad-response 不能重发为普通聊天消息） | **缺失：WS HITL 提问** |
| HITL 审批 | REST approval-response | WS approval-response + server→client approval-requested/response/resolved（outcome allowed-once\|rejected；无“始终允许”；displayReason 多语言；replay 重放） | **缺失：WS 审批** |
| 任务/目标投影 | REST | WS tasks/goal/goal-edit/goal-pause/goal-resume/goal-clear（asOfSeq）；tasks-updated/goal-updated 推送；turn-outline-updated | **缺失：WS 目标/任务** |
| 统计 | 无 | WS session-stats（turns/steps/llmMs/toolMs/ttftMs/ttftSteps/decodeMs/decodeTokens/lastTurn/openStep/pendingCalls/tokenUsage/contextUsage） | **缺失：WS 统计** |
| 插件管理 | 无 | WS plugin-catalog/registries/inspect/install/install-status/install-cancel/bundle-set-enabled/entry-set-enabled/remove/settings/settings-mutate/version-exemptions（paired 控制连接，plugin-management-v1 能力，requestId 必填） | **缺失：WS 插件管理** |
| 官方语音输入（v0.11.1 新增） | 无 | WS speech-catalog/subscribe/unsubscribe/configure/prepare/cancel-preparation/transcribe/cancel（speech-input-v1，control 连接，16kHz 单声道 PCM16 WAV Base64，4 MiB，180s 超时，每连接最多一个活动转写，总共最多四个） | **缺失：WS 语音输入** |
| 智能体团队与子会话（v0.11.1 新增） | 无 | WS agent-team/subagents（agent-team-v1/subagent-conversations-v1，parentSessionId+subagentMode，projectionState ready|unavailable|migration-required；投影键 agentTeam/subagentCatalog/subagent/subagentTiming） | **缺失：WS 智能体团队** |
| 定时任务 | 无 | WS schedule-catalog/list/history/update/delete（控制连接，需 expected 完整记录，change at/every/daily/weekly/cron） | **缺失：WS 定时任务** |
| 事件推送（server→client） | file.changed/file.trashed/chat.message.delta/committed/session.status/session.snapshot/deliverables.presented/approval.requested/resolved/turn.failed/connection.ready/resyncRequired/userQuestions/requested | paired/hello/event/session-queues/session-queue/session-archives/session-title-changed/tasks-updated/goal-updated/projection-baseline/turn-outline-updated/schedule-changed/question/approval requested-resolved/pong/subscribed/sent；event 类型覆盖 user/message/assistant/message/assistant/attempt/session/title/tool/call/deliverables/presented/tool/result/turn/start\|end/step/start\|end/llm/retry/llm/retry-started | **部分缺失（event 类型不全）** |
| 多网关身份 | 无 | gatewayId/gatewayName/endpoints；配对载荷/paired/hello/GET /mgw/status；Quick/Named Cloudflare Tunnel | **缺失：多网关身份与公网穿透** |
| 公网端点 | 无（仅本机/远程 REST） | Cloudflare Quick Tunnel（无账户域名）或 Named Tunnel；独立 LAN 监听端口 3081 | **缺失：公网 WS 入口** |
| 管理面 | `/manage/*`（隧道/配对/配置文本） | `/mgw/*`（gateway 状态、cloudflare、pair、status） | 管理路径不同，功能部分重叠 |

---

## 2. remote-bridge 相对 mobile-gateway (v0.11.1) 的缺失能力（按优先级排序）

### P0 —— WS 双向请求/响应（核心，用户强调「ws 优先，REST 兜底」）

remote-bridge 的 WS 目前是**单向广播**：服务端订阅内部事件，推给已连接客户端；客户端不能通过 WS 发任何请求。所有业务（发消息、查历史、选模型、执行命令、回复审批/提问）都要走 REST。

mobile-gateway 的 WS 是双向 RPC 风格：客户端发 `{type: …}` 帧，服务端回 `{kind: …}` 响应帧，并可主动推送 `event`/`question-requested`/`approval-requested` 等。

**缺失清单（P0）：**

1. WS 子协议 `dsh-mobile-v1`（当前只有 `bearer.<token>`）。
2. 首次配对子协议 `dsh-pair.<code>` + `X-DSH-Device-ID`，返回 `paired`（token + device，pairing v2 Base64URL）。
3. 后续连接用 `dsh-auth.<token>` 或 `Authorization: Bearer <token>`。
4. 分信道：`X-DSH-Channel` 控制/会话分离（control 做配置/插件/语音/定时任务，conversation 做消息/会话）。
5. 连接即推 `hello`（protocol:3、capabilities、authenticated、device、port、clients）。
6. 客户端→服务端请求帧：`ping`/`subscribe`/`unsubscribe`/`message`/`workspaces`/`sessions`/`history`/`attachment`/`file-list`/`file-download-*`/`file-upload-*`/`search`/`host`/`default-model`/`save-default-model`/`models`/`providers`/`commands`/`command-execute`/`command-options`/`command-select`/`select-model`/`permission-options`/`permission`/`context-usage`/`session-stats`/`tasks`/`goal`/`goal-edit`/`goal-pause`/`goal-resume`/`goal-clear`/`plugin-*`/`agent-presets`/`defaults`/`set-default`/`question-answer`/`question-cancel`/`approval-response`/`session-create`/`fork`/`session-cancel`/`session-archive`/`session-rename`。
7. 服务端→客户端响应/推送帧：`pong`/`subscribed`/`sent`/`workspaces`/`sessions`/`history`/`search`/`commands`/`command-options`/`command-executed`/`command-selected`/`attachment`/`file-list`/`file-download-opened/chunk/cancelled`/`file-upload-opened/chunk/finish/cancelled`/`session-cancelled`/`queue-item-updated`/`session-queues`/`session-queue`/`session-archived`/`session-renamed`/`session-archives`/`session-title-changed`/`error`/`event`/`tasks`/`goal`/`goal-*`/`tasks-updated`/`goal-updated`/`question-*`/`approval-*`。
8. `message` 帧：sessionId 可选（省略自动创建新会话）、mode queue\|steer、支持纯图片、clientTimeZone、workspaceId/cwd 放入工作区。
9. `history` 帧：beforeSeq/maxMessages/maxBytes、view:"conversation"、hasMore+nextBeforeSeq 向后分页、默认 4 MiB 上限。
10. HITL：WS 双向 question-answer/approval-response，server 主动推 question-requested/approval-requested，replay 重放待处理项。

### P1 —— 配对与鉴权状态机

mobile-gateway 有 gatewayEnabled/gatewayMode（disabled/temporary/persistent）状态机，5 min 临时开启自动超时，Debug 模式本机免凭证，独立 LAN 监听始终强制鉴权，token 撤销即时生效，close code 4003/4004。

**缺失：** gateway mode 状态机、配对 TTL、设备持久 ID、Debug 免凭证本机监听、独立 LAN 监听端口、WS close code 4003/4004 语义、pairing v2 Base64URL 载荷。

### P2 —— 文件上传/下载与目录操作

mobile-gateway 支持 WS 文件下载（分片、sha256 校验、最大 512 MiB）和**文件上传**（SHA-256 校验、进度确认、取消、断线清理）、目录列表/创建/工作区创建。

**缺失：** WS file-download-*、WS file-upload-*、directories/directory-create/workspace-create。

### P3 —— 公网穿透与多网关身份

mobile-gateway 支持 Cloudflare Quick/Named Tunnel 一键公网 WS 入口，gatewayId/gatewayName/endpoints 多网关身份，配对载荷携带 publicUrl/endpoints。

**缺失：** Cloudflare Tunnel 集成、多网关身份、公网 WS 端点。

### P4 —— v0.11.1 新增能力（长期规划）

mobile-gateway v0.11.1 新增：智能体团队与子会话、官方语音输入、插件管理、定时任务、session-stats、会话统计投影。

**缺失：** WS agent-team/subagents、WS speech-*、WS plugin-*、WS schedule-*、WS session-stats。

---

## 3. remote-bridge 现有的 WS 基础（可复用）

以下能力 remote-bridge 已有，可直接复用到新 WS 端点，无需从零构建：

- `src/host/server.ts`：`WebSocketServer`（noServer, clientTracking:false, maxPayload 1 MiB）、`handleUpgrade`（子协议 `bearer.<token>` → `Authorization` 头、`principal()` 鉴权、`allowAdmin: true`、连接上限 32、鉴权后才计数）、`connection.ready` 帧、`replayPendingInteractions`（重放 pending approvals/questions）、per-connection 队列 + drain（背压 highWaterMark 4 MiB、连续 2 次越线 close(1013)）、`isRebuildable`（只丢 `chat.message.delta`）、`connection.resyncRequired`、心跳 ping/pong（连续错过 2 周期 terminate）、`refreshPrincipal`（devicesRevision 增量刷新）、设备撤销 close(4001)、`eventAllowed`（scopes/rootIds/sessionId 授权）。
- `src/host/chat-adapter.ts`：`replayPendingApprovals`/`replayPendingQuestions`（供重放）、`isSessionAuthorized`、`listSessions`/`listWorkspaces`/`createWorkspace`/`renameWorkspace`/`deleteWorkspace`、`createSession`/`history`/`prompt`/`uploadAttachment`/`readAttachment`/`readHandoffImage`/`cancel`/`renameSession`/`forkSession`/`archiveSession`、`listAgentPresets`/`selectAgentPreset`、`listPermissionPresets`、`models`/`selectModel`、`listCommands`/`executeCommand`、`listUserQuestions`/`answerUserQuestion`、`decideApproval`/`listPendingApprovals`/`replayPendingApprovals`/`replayPendingQuestions`、`startEvents`。
- `src/shared/contracts.ts`：`Principal`、`DevicePrincipal`、`WorkspaceEvent`、`DeviceScope` 等类型。
- `src/host/capabilities.ts`：`connectionReadyData()`（能力位）。
- `src/host/ws-protocol.ts`（阶段 1 已新增）：WS 线路协议常量与类型（WS_PATH='/ws/mobile'、WS_PROTOCOL='dsh-mobile-v1'、ClientFrameType/ServerFrameKind、encodeFrame/decodeFrame/makeServerFrame/makeErrorFrame）。
- `src/host/ws-handler.ts`（阶段 1 已新增）：MobileGatewayWsHandler，连接管理、子协议鉴权（dsh-pair/dsh-auth/Bearer）、hello、ping/subscribe/unsubscribe/message/attachment，发送队列背压（512），stop()。

---

## 4. 改造方案：把 remote-bridge 向 mobile-gateway 靠拢（WS 优先，REST 兜底）

### 4.1 指导原则

1. **WS 优先，REST 兜底**：新增 WS `/ws/mobile` 端点，客户端业务（发消息、查历史、选模型、回复审批/提问、执行命令、文件下载/上传）优先走 WS；REST 保留作为兜底和管理面（`/manage/*`）。
2. **复用现有鉴权**：WS 子协议 `dsh-auth.<token>` / `Authorization: Bearer <token>` 复用 `principal()`；首次配对用 `dsh-pair.<code>` + `X-DSH-Device-ID`，复用 `database.createPairing`。
3. **不改既有契约**：`/dsh-workspace-api` 前缀、端口 3090、状态目录 `dsh-workspace` 保持不动（AGENTS §1 三条不可动契约）。
4. **先改文档，再改代码**（AGENTS §3.4 机检锚点）：API.md → INTERFACES.md → STRUCTURE.md，同一提交内同步。
5. **按 PITFALLS §4 安全纪律**：新增对外端点未带凭据须 401/403；越权 scope 须 403；系统错误不回显绝对路径；图片/文件路由免令牌守门条件保留断言；`@patch` 四要素齐全且测试存在。

### 4.2 分层设计

```
src/host/
  server.ts           ← 已有：HTTP server + /api/v1/events WS（单向广播，保留）
  ws-protocol.ts      ← 已有（阶段 1）：wire 帧类型定义、帧编解码（与 mobile-gateway 帧名对齐）
  ws-handler.ts       ← 已有（阶段 1）：/ws/mobile WS 端点（双向请求/响应，mobile-gateway 对齐）
  ws-auth.ts          ← 新增（阶段 2）：dsh-pair/dsh-auth 子协议鉴权、gateway mode 状态机、配对 TTL、pairing v2
  ws-sessions.ts      ← 新增（阶段 2）：会话/历史/附件/文件下载 WS 业务（调用 chat-adapter + file-service）
  ws-hitl.ts          ← 新增（阶段 2）：HITL（question/approval）WS 双向 + replay
  ws-files.ts         ← 新增（阶段 3）：文件下载分片、文件上传分片、目录操作（file-service）
  ws-commands.ts      ← 新增（阶段 2）：命令目录/执行 WS（commandServices）
  ws-models.ts        ← 新增（阶段 2）：模型/默认模型/提供商 WS
  ws-goals.ts         ← 新增（阶段 2）：任务/目标投影 WS
  ws-plugins.ts       ← 新增（阶段 4，可选）：插件管理 WS（plugin-management-v1）
  ws-speech.ts        ← 新增（阶段 4，可选）：官方语音输入 WS（speech-input-v1）
  ws-schedule.ts      ← 新增（阶段 4，可选）：定时任务 WS
  ws-agentteam.ts     ← 新增（阶段 4，可选）：智能体团队与子会话 WS
  ws-stats.ts         ← 新增（阶段 3）：session-stats WS
  ws-tunnel.ts        ← 新增（阶段 4，可选）：Cloudflare Tunnel 公网穿透
```

每个新文件 ≤ 600 行（AGENTS §3.2 债务台账行数预算）。

### 4.3 阶段实施

- **阶段 1（P0，已完成 commit f7b5c44）**：新增 `ws-protocol.ts`+`ws-handler.ts`（连接管理、子协议鉴权、hello、ping/subscribe/unsubscribe/message/attachment），挂载到 server.ts `/ws/mobile` 升级路由；更新 API.md/INTERFACES.md；跑 `pnpm check` 绿。
- **阶段 2（P0 续）**：HITL（question/approval）WS 双向 + replay；会话/历史 WS；命令/模型 WS；目标/任务投影 WS；gateway mode 状态机、配对 TTL、pairing v2；分信道。
- **阶段 3（P1/P2）**：文件下载分片、文件上传分片（SHA-256、receiptId、进度、取消、断线清理）、目录操作；session-stats。
- **阶段 4（P3/P4）**：Cloudflare Tunnel、多网关身份、公网 WS 端点；插件管理；语音输入；定时任务；智能体团队与子会话。

每阶段结束都跑 `pnpm check`（typecheck + test + docs:check + build），并按 AGENTS §4 安全纪律复核。

---

## 5. 待决问题与风险

1. **WS 与 /api/v1/events 并存**：server.ts 当前 `handleUpgrade` 只允许 `/api/v1/events`，其余 `socket.destroy()`。新增 `/ws/mobile` 需在 `handleUpgrade` 中分派，或新建独立 WebSocketServer 监听同一 HTTP server 的不同 pathname。建议：在 `handleUpgrade` 按 `url.pathname` 分派（`/api/v1/events` 走原逻辑，`/ws/mobile` 走新 ws-handler）。
2. **子协议并存**：现有 `bearer.<token>` 与新增 `dsh-pair.`/`dsh-auth.`/`dsh-mobile-v1` 需同时解析，互不干扰。
3. **会话授权过滤**：WS `message`/`history` 等涉及 sessionId 时，须复用 `isSessionAuthorized` 做 per-connection 过滤（与 `eventAllowed` 一致）。
4. **文件下载/上传大帧**：mobile-gateway 单帧 144 MiB 上限，remote-bridge 当前 1 MiB；分片下载/上传需调整 `maxPayloadBytes` 或改用多帧 chunk（推荐后者，避免改全局帧上限）。
5. **跨仓影响**：Kotlin SDK（`kotlin-sdk/`）与 dsh-companion 若要消费新 WS 帧，需同步 wire schema（API.md + openapi.yaml + asyncapi.yaml + kotlin-sdk + 合约测试，AGENTS §3.1 五处同步）。本轮先只改 TS 侧，跨仓后续跟进。

---

## 6. 验收标准

- [x] `pnpm check` 全绿（typecheck + test + docs:check + build）。
- [x] 新增 WS `/ws/mobile` 端点可建连、握手鉴权（`dsh-auth.<token>` / `dsh-pair.<code>`）。
- [x] 连接即推 `hello`（protocol:3、capabilities、authenticated、device；port/clients 字段暂缺，不影响鉴权）。
- [x] WS `{type:"message"}` 可发消息（sessionId 可选、自动建会话、mode queue\|steer、图片 base64）。
- [x] WS `{type:"history"}` 可分页拉历史（beforeSeq/maxMessages；maxBytes 已接线，hasMore+nextBeforeSeq）。
- [x] WS `{type:"workspaces"}`/`{type:"sessions"}` 可查列表（受 session 授权过滤）。
- [x] WS `{type:"attachment"}` 可传/取附件。
- [x] WS HITL：question-answer/approval-response 双向；server 经事件桥主动推 `{kind:'event'}` 的 requested；连接建立 replay 重放（replayed:true）。
- [x] WS 会话生命周期：session-create/cancel/archive/rename、fork、workspace-create（幂等）。
- [x] WS 命令/模型/预设：commands/command-execute、models/select-model（带 sessionId）、agent-presets；无会话的全局模型目录仍走 REST 兜底。
- [x] 未带凭据 WS 连接关闭 4001；URL query 偷带 token 关闭 4001；越权 scope 不推送；系统错误不回显绝对路径。
- [x] `pnpm test` 全绿（713 tests，含 websocket-security 等既有安全 spec 与新增 mobile-gateway-ws 12 例）。
- [x] API.md / INTERFACES.md / STRUCTURE.md 机检锚点一致（`pnpm docs:check` 绿）。

---

## 7. 落地状态（2026-10-28）

已按「WS 优先、REST 兜底」落地 P0 主干，分 5 个提交（均本地，未 push）：

| 提交 | 内容 |
|---|---|
| `f7b5c44` | `/ws/mobile` 端点：子协议 `dsh-mobile-v1` + `dsh-pair.<code>`/`dsh-auth.<token>`，hello、配对一次性交换、双向请求/响应；server.ts upgrade 分派（与 `/api/v1/events` 并存） |
| `38e6f3b` | 拆域处理器：ws-sessions/ws-hitl/ws-models/ws-commands/ws-presets/ws-goals，对齐 v0.11.1 帧命名 |
| `847de6a` | **WS 优选核心闭环**：ws-event-bridge 订阅进程内事件总线，按主体 scope/root/session 三层授权过滤后主动推 `{kind:'event',data:event}`；实时 approval/question/delta 全走 WS |
| `a7ab580` | fork、workspace-create（双侧 realpath 归一 + 幂等 created:false）双向帧 |
| `10796a3` | 连接建立重放待处理 approval/question（与 /api/v1/events 同保证，replayed:true） |
| `1991147` | file-list（授权根内列举+分页+双侧 realpath 防逃逸）、全局模型目录/providers/permission-options 走 WS |
| `f1dd82b` | **P4 三块落地**：`ws-team.ts`（agent-team/subagents 读会话投影，projectionState 三态）、`ws-schedule.ts`（schedule-* 代理内核 schedule Remote）、`ws-speech.ts`（speech-* 代理内核 speech Remote，4 MiB/全局 4 并发/180s/连接关闭清理）、`ws-host-services.ts`（typertGateway+owner peer 可选封装，缺失即降级）；新增 chat-adapter `sessionProjections()` + apiProxy `sessions.projections` |
| `d854c05` | **任务/目标/统计落地**：`ws-goals.ts` 重写——`tasks`/`goal`/`session-stats`/`context-usage` 读会话投影（todos/goal/sessionStats/tokenUsage/contextPressure，缺失键回 null），`goal-edit/pause/resume/clear` 代理内核 `goals` Remote（namespace `goals`，`{agentId,ref,request?}`，CAS 校验 ref.id+revision），无 Remote 回 `unsupported` 指引 REST；新增能力位 mobile-tasks-v1/mobile-goal-read-v1/mobile-session-stats-v1；8 个新合约测试 |
| 本次（未提交） | **v0.11.1 分块文件传输落地**：新增 `ws-file-transfer.ts`（597 行）——下载 `file-download-open/read/cancel`（会话 cwd 定位授权根、path 禁 `..`、双侧 realpath 归一 + O_NOFOLLOW、严格顺序 offset、随机读 512 KiB 块、末块附 SHA-256、size 复核、4 并发/连接）；上传 `file-upload-open/chunk/finish/cancel`（name 叶子名白名单、size/sha256 预检、256 KiB 块顺序写入 `<dataDir>/uploads/<uploadId>` 0600 spool、busy 串行、finish 校验 SHA-256 后读回走内核 `uploadAttachment` 换 `receiptId`、连接关闭/空闲回收清理）；连接隔离 + 传输归属校验。5 个新合约测试（端到端下载跨块校验/scope 拒绝/上传 receiptId/校验和不符/路径名与 scope） |

模块文件（均 ≤600 行，STRUCTURE/INTERFACES 锚点已登记）：
`ws-protocol.ts`（协议常量/帧类型/编解码）、`ws-handler.ts`（握手/鉴权/分发/背压/HITL 重放）、
`ws-event-bridge.ts`（事件总线→授权过滤→主动推送）、`ws-sessions.ts`、`ws-hitl.ts`、
`ws-models.ts`、`ws-commands.ts`、`ws-presets.ts`、`ws-goals.ts`（tasks/goal/stats 读投影 + goal 写代理）、
`ws-team.ts`、`ws-schedule.ts`、`ws-speech.ts`、`ws-host-services.ts`、`ws-settings.ts`（全局模型目录/providers/权限选项）、
`ws-files.ts`（file-list 浏览）、`ws-file-transfer.ts`（分块下载/上传）。

设计要点：
- **WS 优选**：App 连上后，消息/列表/历史/附件/文件分块传输/HITL 决策/命令/模型/事件推送全部走单条 WS；
  **REST 兜底**：无会话全局模型目录、插件管理，以及目标写操作遇老内核 goals Remote 缺失时回 `unsupported`，仍可用 `/api/v1/*`。
- 授权全程复用既有 `principal()` + `isSessionAuthorized`，事件桥授权判定异步隔离，
  单连接判定失败不拖累其它连接，异常保守不推（宁可不送，不可越权）。
- 分块传输不动 WS 单帧 1 MiB 上限：每块 base64 后 ≤ ~700 KiB（下载 512 KiB 原始 / 上传 256 KiB 原始），
  spool 落盘避免大文件占内存，文件名绝不解释为宿主路径。

仍待办（按优先级）：
1. gateway mode 状态机、独立 LAN 监听、pairing v2 Base64URL、split-channels（`X-DSH-Device-Name` 设备名头已做，仅校验不落库；hello 的 `port`/`clients`、`pong.at` 已对齐）。
2. ~~queue 编辑/删除/steer（queue-update）~~ 已结构化回 `NOT_IMPLEMENTED`（内核无按 itemId 编辑 RPC，指引 `mode:'steer'`）；~~search~~ 同兜底；~~directories/directory-create~~ directory-create 已实现（授权根内），directories 因与本桥授权根模型冲突回兜底指引 file-list；session-title-changed 主动推送仍待办。
3. tasks-updated/goal-updated/projection-baseline/schedule-changed 主动推送、turn-outline、llm/retry 事件透传。
4. Cloudflare Tunnel 管理面 WS 化、多网关身份、插件管理 WS 化（plugin-*）。
5. 跨仓 kotlin-sdk / dsh-companion 消费新 WS 帧（wire schema 五处同步，见 §5 风险 5）。

已完成的 v0.11.1 新增面：agent-team/subagents（只读会话投影，三态 projectionState）、
speech-*（8 帧，纯代理官方 speech Remote；catalog 不可用时回 available:false）、schedule-*
（5 帧，代理 schedule Remote；不可用时回 schedule/unavailable）、**file-download/file-upload 七帧
（分块 + SHA-256 + receiptId + spool 清理）**、file-resolve（预览元数据不取字节）、
command-options/command-select（model/permission 通用二级菜单）、permission 帧、host 快照、
subscribe 会话白名单过滤（缺省全授权、订阅后白名单、unsubscribe 恢复、订阅补推该会话 HITL 重放）、
question-cancel（仅可作废本桥接管的前台提问）。都遵循「内核有就 WS 代理，没有就结构化降级指引
REST 兜底」，不自带识别模型或调度器。

---

> 文档来源声明：对比数据来自 `dsh-plugin-mobile-gateway` v0.11.1 `package/PROTOCOL.md`（1467 行）与 `package/lib/index.mjs`，下载自 npm registry tarball `https://registry.npmjs.org/dsh-plugin-mobile-gateway/-/dsh-plugin-mobile-gateway-0.11.1.tgz`（sha512 je77m6JXDNFz371PvhwtHpWNVnJk5OnSyH5+ke8bZM5zukE1wE4ve1LW8f9oxZQX7kToy1LNwfcQQO3x+HpEhg==），解压至 `/media/wangke/OFFICE/workspace/dsh-study/mobile-gateway-latest/package/`。GitHub 仓库无 release/tag，页面抓取超时，故以 npm 发布版为准。
