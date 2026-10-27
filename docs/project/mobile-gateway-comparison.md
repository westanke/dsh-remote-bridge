# dsh-remote-bridge vs dsh-plugin-mobile-gateway 功能/能力对比分析

> 数据来源：`dsh-remote-bridge` 本地仓 v2.7.1（`src/host/server.ts`、`src/host/chat-adapter.ts`、`docs/project/API.md` 等）；`dsh-plugin-mobile-gateway` 上游 `Clarklevis1995/dsh-plugin-mobile-gateway` v0.10.2（`lib/index.mjs`、`PROTOCOL.md`，已编译 JS，`/media/wangke/OFFICE/workspace/dsh-study/mobile-gateway`）。
>
> 核心结论：remote-bridge 仅把 DSH 内部事件做**单向广播**（REST 为主，WS 仅 /api/v1/events 推事件）；mobile-gateway 是一套**双向请求/响应**的移动端网关协议，WS 优先，REST 兜底，能力面远大于 remote-bridge。以下列出 remote-bridge 相对 mobile-gateway 缺失的能力，作为向 mobile-gateway 靠拢的改造清单。

---

## 1. 总览对比表

| 维度 | dsh-remote-bridge (v2.7.1) | dsh-plugin-mobile-gateway (v0.10.2) | remote-bridge 缺失 |
|---|---|---|---|
| 定位 | DSH 内部 remote 协议 → 版本化 REST；WebUI「手机设置」面板（只做设置） | 移动端持久化插件：WS 长连接，双向收发，设备配对与鉴权 | 无移动端网关定位 |
| 主通道 | REST `/dsh-workspace-api/*`（设备 token / loopback admin）；WS 仅 `/api/v1/events` 单向推事件 | WS `/ws/mobile`（本机 3080 / 独立监听 3081 / 公网 wss）；REST `/mgw/*` 仅管理面 | remote-bridge WS 只推事件，不接收客户端请求 |
| WS 端点 | `/api/v1/events`（挂主 HTTP server upgrade） | `/ws/mobile`（独立监听，可共享 3080，可 Cloudflare 穿透） | 无独立 WS 路径；无公网穿透 |
| WS 子协议 | `bearer.<token>`（Sec-WebSocket-Protocol） | `dsh-mobile-v1, dsh-pair.<code>`（首次配对） / `dsh-mobile-v1, dsh-auth.<token>`（后续） | 无配对子协议；无 dsh-mobile-v1 协议标识 |
| 配对机制 | REST 配对码（`/api/v1/pairings/exchange`，设备 token） | 一次性 256-bit 配对码 + `X-DSH-Device-ID`；Base64URL 载荷；token 存 Keychain；`paired` 帧下发 token | 无 WS 配对流程；无设备持久 ID |
| 鉴权模式 | 设备 token 或 loopback admin；`principal()` 统一判据 | gatewayEnabled/gatewayMode（disabled/temporary/persistent）；requireAuth；本机可 Debug 免凭证；独立 LAN 监听始终强制鉴权 | 无 gateway mode 状态机；无 Debug 免凭证本机监听 |
| 帧格式 | JSON 文本帧（`stringifyWire`） | 全 JSON 文本帧；图片/语音标准 Base64（无 data: 前缀） | 已具备（基础） |
| 连接即推送 | `connection.ready`（能力位） | `hello`（protocol:3、能力列表、authenticated、device、port、clients） | 能力位已有，但缺 authenticated/device/port/clients |
| 心跳 | ping/pong，连续错过 2 周期 terminate | 同上（ws 底层） | 已具备 |
| 背压/溢出 | per-connection 队列；丢可重建帧；`connection.resyncRequired`；close(1013) | 同上类设计（mobile-gateway 亦有队列与背压） | 已具备（基础） |
| 设备撤销 | drain 时 refreshPrincipal；撤销 close(4001) | token 撤销即时生效 | 已具备（基础） |
| 事件过滤 | scopes (files.read/chat.read)、rootIds、sessionId 授权 | 同上类 | 已具备（基础） |
| **客户端→服务端请求** | **无**（WS 仅服务端→客户端广播） | ping/subscribe/unsubscribe/message/workspaces/sessions/history/attachment/file-*/search/host/models/commands/goal/question-answer/approval-response/… | **重大缺失：WS 无上行请求/响应** |
| 发消息（message） | 仅 REST `/api/v1/sessions/:id/messages` | WS `{type:"message"}`，sessionId 可选（省略自动创建会话）、mode queue\|steer、纯图片、clientTimeZone | **缺失：WS 发消息** |
| 自动建会话 | 无 | message 省略 sessionId → 先建新会话再发；workspaceId/cwd 放入工作区 | **缺失** |
| 会话/工作区列表 | REST | WS `{type:"workspaces"}` / `{type:"sessions"}` | **缺失：WS 查列表** |
| 历史分页 | REST | WS `{type:"history"}`（beforeSeq/maxMessages/maxBytes/view:"conversation"，hasMore+nextBeforeSeq 向后分页，默认 4 MiB） | **缺失：WS history** |
| 附件/图片 | REST upload/read | WS `{type:"attachment"}`（verified metadata + canonical base64 bytes） | **缺失：WS attachment** |
| 文件下载 | 无 | WS file-download-open/read/cancel（transferId, offset, chunk, eof, sha256；最大 512 MiB，chunk 512 KiB，最大 4 并发，idle 2 min） | **缺失：WS 文件下载** |
| 命令目录/执行 | REST | WS commands/command-options/command-select/command-execute（ui.kind immediate/input/select；source host\|skill） | **缺失：WS 命令** |
| 模型选择 | REST | WS default-model/save-default-model/select-model/providers | **缺失：WS 模型管理** |
| 目录/工作区操作 | 无 | WS directories/directory-create/workspace-create | **缺失：WS 文件系统** |
| 会话生命周期 | REST cancel/rename/archive/fork | WS session-cancel/session-archive/session-rename/fork/session-title-changed | **部分缺失（REST 有，WS 无）** |
| 队列/目标/目标控制 | 无 | WS queue-update（edit/remove/steer，move into current turn） | **缺失：WS 队列控制** |
| HITL 提问 | REST question-answer/question-cancel | WS question-answer/question-cancel + server→client question-requested/response/resolved（replay 重放） | **缺失：WS HITL** |
| HITL 审批 | REST approval-response | WS approval-response + server→client approval-requested/response/resolved（outcome allowed-once\|rejected；无“始终允许”） | **缺失：WS 审批** |
| 任务/目标投影 | REST | WS tasks/goal/goal-edit/goal-pause/goal-resume/goal-clear（asOfSeq） | **缺失：WS 目标/任务** |
| 插件管理 | 无 | WS plugin-catalog/inspect/install/settings/…（paired 控制连接） | **缺失：WS 插件管理** |
| 多网关身份 | 无 | gatewayId/gatewayName/endpoints；配对载荷/paired/hello/GET /mgw/status；Quick/Named Cloudflare Tunnel | **缺失：多网关身份与公网穿透** |
| 公网端点 | 无（仅本机/远程 REST） | Cloudflare Quick Tunnel（无账户域名）或 Named Tunnel；独立 LAN 监听端口 3081 | **缺失：公网 WS 入口** |
| 管理面 | `/manage/*`（隧道/配对/配置文本） | `/mgw/*`（gateway 状态、cloudflare、pair、status） | 管理路径不同，功能部分重叠 |

---

## 2. remote-bridge 相对 mobile-gateway 的缺失能力（按优先级排序）

### P0 —— WS 双向请求/响应（核心，用户强调「ws 优先，REST 兜底」）

remote-bridge 的 WS 目前是**单向广播**：服务端订阅内部事件，推给已连接客户端；客户端不能通过 WS 发任何请求。所有业务（发消息、查历史、选模型、执行命令、回复审批/提问）都要走 REST。

mobile-gateway 的 WS 是双向 RPC 风格：客户端发 `{type: …}` 帧，服务端回 `{kind: …}` 响应帧，并可主动推送 `event`/`question-requested`/`approval-requested` 等。

**缺失清单（P0）：**
1. WS 子协议 `dsh-mobile-v1`（当前只有 `bearer.<token>`）。
2. 首次配对子协议 `dsh-pair.<code>` + `X-DSH-Device-ID`，返回 `paired`（token + device）。
3. 后续连接用 `dsh-auth.<token>` 或 `Authorization: Bearer <token>`。
4. 连接即推 `hello`（protocol:3、capabilities、authenticated、device、port、clients）。
5. 客户端→服务端请求帧：`ping`/`subscribe`/`unsubscribe`/`message`/`workspaces`/`sessions`/`history`/`attachment`/`file-list`/`file-download-*`/`search`/`host`/`default-model`/`save-default-model`/`models`/`providers`/`commands`/`command-execute`/`command-options`/`command-select`/`select-model`/`permission-options`/`permission`/`context-usage`/`session-stats`/`tasks`/`goal`/`goal-edit`/`goal-pause`/`goal-resume`/`goal-clear`/`plugin-*`/`agent-presets`/`defaults`/`set-default`/`question-answer`/`question-cancel`/`approval-response`。
6. 服务端→客户端响应/推送帧：`pong`/`subscribed`/`sent`/`workspaces`/`sessions`/`history`/`search`/`commands`/`command-options`/`command-executed`/`command-selected`/`attachment`/`file-list`/`file-download-opened/chunk/cancelled`/`session-cancelled`/`queue-item-updated`/`session-queues`/`session-queue`/`session-archived`/`session-renamed`/`session-archives`/`session-title-changed`/`error`/`event`/`tasks`/`goal`/`goal-*`/`tasks-updated`/`goal-updated`/`question-*`/`approval-*`。
7. `message` 帧：sessionId 可选（省略自动创建新会话）、mode queue\|steer、支持纯图片、clientTimeZone、workspaceId/cwd 放入工作区。
8. `history` 帧：beforeSeq/maxMessages/maxBytes、view:"conversation"、hasMore+nextBeforeSeq 向后分页、默认 4 MiB 上限。
9. HITL：WS 双向 question-answer/approval-response，server 主动推 question-requested/approval-requested，replay 重放待处理项。

### P1 —— 配对与鉴权状态机

mobile-gateway 有 gatewayEnabled/gatewayMode（disabled/temporary/persistent）状态机，5 min 临时开启自动超时，Debug 模式本机免凭证，独立 LAN 监听始终强制鉴权，token 撤销即时生效，close code 4003/4004。

**缺失：** gateway mode 状态机、配对 TTL、设备持久 ID、Debug 免凭证本机监听、独立 LAN 监听端口、WS close code 4003/4004 语义。

### P2 —— 文件下载与目录操作

mobile-gateway 支持 WS 文件下载（分片、sha256 校验、最大 512 MiB）和目录列表/创建/工作区创建。

**缺失：** WS file-download-*、directories/directory-create/workspace-create。

### P3 —— 公网穿透与多网关身份

mobile-gateway 支持 Cloudflare Quick/Named Tunnel 一键公网 WS 入口，gatewayId/gatewayName/endpoints 多网关身份，配对载荷携带 publicUrl/endpoints。

**缺失：** Cloudflare Tunnel 集成、多网关身份、公网 WS 端点。

---

## 3. remote-bridge 现有的 WS 基础（可复用）

以下能力 remote-bridge 已有，可直接复用到新 WS 端点，无需从零构建：

- `src/host/server.ts`：`WebSocketServer`（noServer, clientTracking:false, maxPayload 1 MiB）、`handleUpgrade`（子协议 `bearer.<token>` → `Authorization` 头、`principal()` 鉴权、`allowAdmin: true`、连接上限 32、鉴权后才计数）、`connection.ready` 帧、`replayPendingInteractions`（重放 pending approvals/questions）、per-connection 队列 + drain（背压 highWaterMark 4 MiB、连续 2 次越线 close(1013)）、`isRebuildable`（只丢 `chat.message.delta`）、`connection.resyncRequired`、心跳 ping/pong（连续错过 2 周期 terminate）、`refreshPrincipal`（devicesRevision 增量刷新）、设备撤销 close(4001)、`eventAllowed`（scopes/rootIds/sessionId 授权）。
- `src/host/chat-adapter.ts`：`replayPendingApprovals`/`replayPendingQuestions`（供重放）、`isSessionAuthorized`、`listSessions`/`listWorkspaces`/`createWorkspace`/`renameWorkspace`/`deleteWorkspace`、`createSession`/`history`/`prompt`/`uploadAttachment`/`readAttachment`/`readHandoffImage`/`cancel`/`renameSession`/`forkSession`/`archiveSession`、`listAgentPresets`/`selectAgentPreset`、`listPermissionPresets`、`models`/`selectModel`、`listCommands`/`executeCommand`、`listUserQuestions`/`answerUserQuestion`、`decideApproval`/`listPendingApprovals`/`replayPendingApprovals`/`replayPendingQuestions`、`startEvents`。
- `src/shared/contracts.ts`：`Principal`、`DevicePrincipal`、`WorkspaceEvent`、`DeviceScope` 等类型。
- `src/host/capabilities.ts`：`connectionReadyData()`（能力位）。

---

## 4. 改造方案：把 remote-bridge 向 mobile-gateway 靠拢（WS 优先，REST 兜底）

### 4.1 指导原则

1. **WS 优先，REST 兜底**：新增 WS `/ws/mobile` 端点，客户端业务（发消息、查历史、选模型、回复审批/提问、执行命令、文件下载）优先走 WS；REST 保留作为兜底和管理面（`/manage/*`）。
2. **复用现有鉴权**：WS 子协议 `dsh-auth.<token>` / `Authorization: Bearer <token>` 复用 `principal()`；首次配对用 `dsh-pair.<code>` + `X-DSH-Device-ID`，复用 `database.createPairing`。
3. **不改既有契约**：`/dsh-workspace-api` 前缀、端口 3090、状态目录 `dsh-workspace` 保持不动（AGENTS §1 三条不可动契约）。
4. **先改文档，再改代码**（AGENTS §3.4 机检锚点）：API.md → INTERFACES.md → STRUCTURE.md，同一提交内同步。
5. **按 PITFALLS §4 安全纪律**：新增对外端点未带凭据须 401/403；越权 scope 须 403；系统错误不回显绝对路径；图片/文件路由免令牌守门条件保留断言；`@patch` 四要素齐全且测试存在。

### 4.2 分层设计

```
src/host/
  server.ts           ← 已有：HTTP server + /api/v1/events WS（单向广播，保留）
  ws-handler.ts       ← 新增：/ws/mobile WS 端点（双向请求/响应，mobile-gateway 对齐）
  ws-protocol.ts      ← 新增：wire 帧类型定义、帧编解码（与 mobile-gateway 帧名对齐）
  ws-auth.ts          ← 新增：dsh-pair/dsh-auth 子协议鉴权、gateway mode 状态机、配对 TTL
  ws-sessions.ts      ← 新增：会话/历史/附件/文件下载 WS 业务（调用 chat-adapter + file-service）
  ws-hitl.ts          ← 新增：HITL（question/approval）WS 双向 + replay
  ws-files.ts         ← 新增：文件下载分片、目录操作（file-service）
  ws-commands.ts      ← 新增：命令目录/执行 WS（commandServices）
  ws-models.ts        ← 新增：模型/默认模型/提供商 WS
  ws-goals.ts         ← 新增：任务/目标投影 WS
  ws-plugins.ts       ← 新增：插件管理 WS（可选，P3）
  ws-tunnel.ts        ← 新增：Cloudflare Tunnel 公网穿透（可选，P3）
```

每个新文件 ≤ 600 行（AGENTS §3.2 债务台账行数预算）。

### 4.3 阶段实施

- **阶段 1（P0，本轮）**：新增 `ws-handler.ts`（连接管理、子协议鉴权、hello、subscribe/unsubscribe、message 自动建会话、history 分页、attachment），挂载到 server.ts `/ws/mobile` 升级路由；更新 API.md/INTERFACES.md/STRUCTURE.md；跑 `pnpm check` 绿。
- **阶段 2（P0 续）**：HITL（question/approval）WS 双向 + replay；任务/目标投影；命令/模型 WS。
- **阶段 3（P1/P2）**：gateway mode 状态机、配对 TTL、设备持久 ID、文件下载分片、目录操作。
- **阶段 4（P3）**：Cloudflare Tunnel、多网关身份、公网 WS 端点。

每阶段结束都跑 `pnpm check`（typecheck + test + docs:check + build），并按 AGENTS §4 安全纪律复核。

---

## 5. 待决问题与风险

1. **WS 与 /api/v1/events 并存**：server.ts 当前 `handleUpgrade` 只允许 `/api/v1/events`，其余 `socket.destroy()`。新增 `/ws/mobile` 需在 `handleUpgrade` 中分流，或新建独立 WebSocketServer 监听同一 HTTP server 的不同 pathname。建议：在 `handleUpgrade` 按 `url.pathname` 分派（`/api/v1/events` 走原逻辑，`/ws/mobile` 走新 ws-handler）。
2. **子协议并存**：现有 `bearer.<token>` 与新增 `dsh-pair.`/`dsh-auth.`/`dsh-mobile-v1` 需同时解析，互不干扰。
3. **会话授权过滤**：WS `message`/`history` 等涉及 sessionId 时，须复用 `isSessionAuthorized` 做 per-connection 过滤（与 `eventAllowed` 一致）。
4. **文件下载大帧**：mobile-gateway 单帧 144 MiB 上限，remote-bridge 当前 1 MiB；分片下载需调整 `maxPayloadBytes` 或改用多帧 chunk（推荐后者，避免改全局帧上限）。
5. **跨仓影响**：Kotlin SDK（`kotlin-sdk/`）与 dsh-companion 若要消费新 WS 帧，需同步 wire schema（API.md + openapi.yaml + asyncapi.yaml + kotlin-sdk + 合约测试，AGENTS §3.1 五处同步）。本轮先只改 TS 侧，跨仓后续跟进。

---

## 6. 验收标准

- [ ] `pnpm check` 全绿（typecheck + test + docs:check + build）。
- [ ] 新增 WS `/ws/mobile` 端点可建连、握手鉴权（`dsh-auth.<token>` / `dsh-pair.<code>`）。
- [ ] 连接即推 `hello`（protocol:3、capabilities、authenticated、device、port、clients）。
- [ ] WS `{type:"message"}` 可发消息（sessionId 可选、自动建会话、mode queue\|steer、图片 base64）。
- [ ] WS `{type:"history"}` 可分页拉历史（beforeSeq/maxBytes，hasMore+nextBeforeSeq）。
- [ ] WS `{type:"workspaces"}`/`{type:"sessions"}` 可查列表（受 session 授权过滤）。
- [ ] WS `{type:"attachment"}` 可取附件 base64。
- [ ] WS HITL：question-answer/approval-response 双向；server 主动推 question-requested/approval-requested；replay 重放。
- [ ] 未带凭据 WS 连接返回 401；越权 scope 返回 403；系统错误不回显绝对路径。
- [ ] `pnpm test` 中 security 相关 spec（websocket-security / database-auth / device-revocation / path-policy / admin-loopback-escalation / token-storage / handoff-extension-consistency / rate-limit-tunnel）全绿。
- [ ] API.md / INTERFACES.md / STRUCTURE.md 机检锚点一致（`pnpm docs:check` 绿）。
