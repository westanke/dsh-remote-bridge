# 接口说明（契约与签名）

本文回答：**对外接口长什么样、模块之间怎么调用、改接口要同步什么**。

- **外部 REST/流的权威仍在** [`docs/api/openapi.yaml`](../api/openapi.yaml) +
  [`docs/api/asyncapi.yaml`](../api/asyncapi.yaml) + [API.md](API.md)。
  本文与它们**不互为替代**：那三份是给客户端与第三方看的正式契约，本文是给
  改代码的人（与 AI）看的**模块调用地图**。两者冲突时以源码为准，然后两边都改。
- 签名一律**逐字照抄源码**。本文没写到的符号不代表不存在 —— 只收「跨模块会用到」的那些。
- 目录与分层见 [STRUCTURE.md](STRUCTURE.md)；设计动机见 [ARCHITECTURE.md](ARCHITECTURE.md)。

> **同步纪律**：改导出符号、签名、REST 路由或流事件字段，**同一提交**内更新本文与文末锚点，
> 否则 `pnpm docs:check` 变红（见 [AGENTS.md](../../AGENTS.md) §3.4）。

---

## 1. 接口分层总览

| 层 | 代表接口 | 权威文件 |
| --- | --- | --- |
| 对外 REST（设备/第三方） | `GET /api/v1/…`、`POST /api/v1/…` | `docs/api/openapi.yaml`、[API.md](API.md) |
| 对外管理面（仅回环） | `GET/POST /manage/…` | 本文 §3.2、`workspace.tsx` 调用处 |
| 事件流（WebSocket） | `/api/v1/events` 的 `WorkspaceEvent` | `docs/api/asyncapi.yaml` |
| 只读图片路由 | `GET /plugin/dsh-remote-bridge/raw` | [ARCHITECTURE.md](ARCHITECTURE.md)、`image-handoff.ts` |
| 跨仓 SDK | `kotlin-sdk` 的 `DshWorkspaceClient` | `kotlin-sdk/README.md` |
| 内部模块 | 各 adapter / 服务类的导出 | 本文 §4 |

### 1.1 wire schema 五处同步（跨仓铁律）

改任何 REST 形状或事件字段，**五处一起改**，缺一处就是下游静默失配：

1. `docs/project/API.md`（文字说明）
2. `docs/api/openapi.yaml` / `docs/api/asyncapi.yaml`（机器契约，`docs:check` 核对路径与版本）
3. `kotlin-sdk/`（给 App 的 SDK）
4. `tests/` 的合约测试（`http-api` / `approval-api` / `command-api` / `job-api` 等）
5. 本文 [INTERFACES.md](INTERFACES.md) 的正文与文末锚点

---

## 2. 对外 REST：路径前缀与鉴权

### 2.1 两个入口，两套信任模型

| 入口 | 前缀 | 挂载方式 | 鉴权 |
| --- | --- | --- | --- |
| 版本化 API | `/api/v1` | 独立监听器（默认 `3090`）+ DSH 同源嵌入 `/dsh-workspace-api` | 设备 token 或 loopback admin |
| 回环管理面 | `/manage` | 同上 | **必须是本机来源**（四层判据，见 2.1.1） |
| 只读图片 | `/plugin/dsh-remote-bridge/raw` | 只挂 DSH 同源嵌入 | 回环 + 同源 + 裸文件名白名单 + 字节自证 |

- **`/dsh-workspace-api` 前缀是已发布 App 写死的契约，不可改**（`server.ts:320` 注释）。
  嵌入路由把它在 DSH WebUI 同源上再暴露一次，`stripPrefix` 后走同一套 router。
- 鉴权头：`Authorization: Bearer <device-token>`；回环管理用 `X-Dsh-Workspace-Admin: 1`。
- 能力位与 `connection.ready` 见 §3.4。

#### 2.1.1 「本机管理请求」的四层判据（v2.5.1 起）

实现在 `src/host/auth.ts` 的 `adminRefusal` / `isLocalAdminRequest`，
`requireAdmin`（`/manage`）与 `principal({allowAdmin})`（`/api/v1`）**共用同一份** ——
一严一松就是这次修复要消灭的那类 bug。

| # | 判据 | 拒绝时的 `error.code` |
| --- | --- | --- |
| 0 | 没有自管隧道在运行（`CloudflaredTunnelManager.tunnelActive === false`） | `TUNNEL_MODE_ADMIN_DISABLED` |
| 1 | 不带任何转发头（`forwarded` / `x-forwarded-for` / `x-forwarded-host` / `x-forwarded-proto` / `x-real-ip`） | `ADMIN_PROXY_FORWARDED` |
| 2 | `Host` 是回环（`127.0.0.1` / `localhost` / `[::1]`；**缺失也拒**） | `ADMIN_HOST_NOT_LOOPBACK` |
| 3 | socket 来源回环；`Origin` 存在时必须回环（**缺失仍放行**，见下） | `ADMIN_LOOPBACK_REQUIRED` |

- **`Origin` 缺失仍放行是刻意的**：它不再构成信任来源，真正确立信任的是判据 0/1/2。
  翻严只会打死 `curl` 与本机脚本调试，挡不住隧道（隧道流量先撞判据 0）。
- **豁免判据 0 的端点**：`GET /manage/cloudflare/status|activity`（只读、无副作用）与
  `POST /manage/cloudflare/stop`（v2.5.2 起，唯一豁免的写操作——它只会把管理面重新锁回，
  且判据 1 仍挡住边缘调用）。前两个让本机面板读到「隧道开着」这个信号；判据 1/2/3 对三者
  **照旧生效**，所以隧道来源的请求连它们也是 403（读不到隧道地址、也停不了隧道）。
  详见 `SECURITY.md` §管理面的信任边界。
- 隧道模式下 `POST /manage/cloudflare/create` 与 `POST /manage/config/text` **仍然 403**
  （create 只能在隧道起来之前调用；config/text 能签发令牌，绝不豁免）。一键「开隧道并出令牌」
  改由 create 请求体 `configText:true` 在隧道启动前的同一调用里搭车完成。

### 2.2 REST 路由总表

`auth` 列的取值：`—` 无鉴权 · `token` 设备 token · `admin` 回环 admin ·
`scope:<x>` 需要该 scope · `root` 还需请求的 rootId 在该设备授权范围内。

| 方法 | 路径 | auth | 说明 | handler |
| --- | --- | --- | --- | --- |
| GET | `/api/v1/healthz` | — | 存活探针，只回 `{ok,version,pluginVersion}` | `router.ts` dispatch 健康探针分支 |
| GET | `/api/v1/debug/host-services` | `scope:settings.read` | 宿主服务注入面报告（不可用时 404）。2.5.2 起移到鉴权之后（SEC-H1） | `router.ts` dispatch host-services 分支 |
| POST | `/api/v1/pairings/exchange` | — | 配对码换设备 token（按对端限流） | `router.ts` dispatch pairing 分支 |
| GET | `/api/v1/devices/self` | token | 当前设备身份与 scope（admin 得 `rootIds:'all'`）；设备另有 `platform` / `model` / `nameSource` | `router.ts` dispatch devices 分支 |
| GET | `/api/v1/roots` | `scope:files.read` | **只含 id/label/createdAt**，刻意不返回绝对路径 | `router.ts` dispatch roots 分支 |
| GET | `/api/v1/roots/resolve?path=` | `scope:files.read` | 绝对路径 → `{rootId,path,kind,size,modifiedAt,contentType}`；非绝对路径 400，越界 404 | `router.ts` dispatch resolve 分支 |
| GET | `/api/v1/roots/{rootId}/entries?path=&limit=&cursor=` | `scope:files.read`+root | 列目录（分页） | `dispatchEntries` |
| POST | `/api/v1/roots/{rootId}/entries` | `scope:files.write`+root | 新建文件/目录 `{path, kind}` | `dispatchEntries` |
| PATCH | `/api/v1/roots/{rootId}/entries` | `scope:files.write`+root | 移动/改名 `{path, destinationPath}` | `dispatchEntries` |
| DELETE | `/api/v1/roots/{rootId}/entries?path=` | `scope:files.delete`+root | 移入回收站 | `dispatchEntries` |
| GET | `/api/v1/roots/{rootId}/content?path=` | `scope:files.read`+root | 读文件（支持 Range / ETag） | `dispatchContent` |
| PUT | `/api/v1/roots/{rootId}/content?path=` | `scope:files.write`+root | 写文件（`If-Match` / `If-None-Match`） | `dispatchContent` |
| GET | `/api/v1/trash` | `scope:files.read` | 回收站列表（按设备 root 过滤） | `router.ts` dispatch trash 分支 |
| POST | `/api/v1/trash/{trashId}/restore` | `scope:files.delete` | 恢复 | `router.ts` dispatch restore 分支 |
| GET | `/api/v1/image-handoff?sessionId=&name=` | `scope:files.read` | 取交接图片字节（`name` 为裸文件名，哈希+扩展白名单） | `router.ts` dispatch image-handoff 分支 |
| GET | `/api/v1/attachments/{attachmentId}?sessionId=` | `scope:files.read` | 取会话附件字节。attachmentId 通常是 `sha256:<hex>`，冒号必须 percent-encode（`sha256%3A…`） | `router.ts` dispatch attachment 分支 |
| POST | `/api/v1/chat/sessions/{sessionId}/attachments` | `scope:chat.write` | 上传附件：body `{data: base64, name?}`（≤24 MiB），回 `{receiptId,name}` | `router.ts` dispatch attachments 分支 |
| GET | `/api/v1/chat/workspaces` | `scope:chat.read` | 工作区列表（按设备可见范围） | `router.ts` dispatch workspaces 分支 |
| POST | `/api/v1/chat/workspaces` | `scope:chat.write` | 新建工作区 `{rootId, path}` | 同上 |
| PATCH | `/api/v1/chat/workspaces/{workspaceId}` | `scope:chat.write` | 改名 `{title}` | `router.ts` workspaceRoute 块 |
| DELETE | `/api/v1/chat/workspaces/{workspaceId}` | `scope:chat.write` | 删除工作区 | 同上 |
| GET | `/api/v1/chat/agent-presets` | `scope:chat.read` | 智能体预设清单 | `router.ts` dispatch agent-presets 分支 |
| GET | `/api/v1/chat/permission-presets` | `scope:chat.read` | 权限档位清单 + 默认档 | `router.ts` dispatch permission-presets 分支 |
| GET | `/api/v1/chat/sessions` | `scope:chat.read` | 会话列表（`archived=true` 列出归档） | `router.ts` dispatch sessions 分支 |
| POST | `/api/v1/chat/sessions` | `scope:chat.write` | 新建会话（`clientRequestId` 幂等） | 同上 |
| PATCH | `/api/v1/chat/sessions/{sessionId}` | `scope:chat.write` | 改名 `{title}` | `router.ts` sessionRoute 块 |
| POST | `/api/v1/chat/sessions/{sessionId}/fork` | `scope:chat.write` | 从 `atSeq` 分叉 | `router.ts` fork 分支 |
| POST | `/api/v1/chat/sessions/{sessionId}/archive` | `scope:chat.write` | 归档 | `router.ts` archive 分支 |
| GET | `/api/v1/chat/sessions/{sessionId}/jobs` | `scope:chat.read` | 后台任务 roster | `matchJobRoute` 消费处 |
| GET | `/api/v1/chat/sessions/{sessionId}/jobs/{jobId}/output` | `scope:chat.read` | 任务输出（增量） | 同上 |
| POST | `/api/v1/chat/sessions/{sessionId}/jobs/{jobId}/kill` | `scope:chat.write` | 人类取消 | 同上 |
| GET | `/api/v1/chat/sessions/{sessionId}/messages` | `scope:chat.read` | 历史（`beforeSeq` 分页、字节预算） | `router.ts` messagesRoute 块 |
| POST | `/api/v1/chat/sessions/{sessionId}/messages` | `scope:chat.write` | 发消息 / prompt（`queue` 或 `steer`） | 同上 |
| GET | `/api/v1/chat/sessions/{sessionId}/approvals` | `scope:chat.read` | 待处理审批 | `router.ts` approvalsRoute 块 |
| POST | `/api/v1/chat/sessions/{sessionId}/approvals/{approvalId}/decision` | `scope:chat.write` | 审批决定（`allowed-once` / `rejected`） | `router.ts` approvalDecisionRoute 块 |
| GET | `/api/v1/chat/sessions/{sessionId}/questions` | `scope:chat.read` | 待答问题 | `router.ts` questionsRoute 块 |
| POST | `/api/v1/chat/sessions/{sessionId}/questions/{callId}/answer` | `scope:chat.write` | 提交答案 | `router.ts` questionAnswerRoute 块 |
| GET | `/api/v1/chat/sessions/{sessionId}/commands` | `scope:chat.read` | 斜杠命令清单 | `router.ts` commandsRoute 块 |
| POST | `/api/v1/chat/sessions/{sessionId}/commands` | `scope:chat.write` | 执行命令 | 同上 |

**宿主命令 `/tunnel` 与工具 `open_tunnel_config`（2.6.0 起）** 都不在上表里：它不是 REST 路由，而是注册进内核命令表
（`ctx.commands.register`，全局层）的一条人类命令，供 IM 适配器（`@xmanrui/dsh-im`）在聊天窗口里直接执行。
语义：开 Cloudflare 隧道 → 等随机域名 → 回一行 `DSH1:` 配置文本；隧道已在运行时复用当前地址。
两者共用 `ApiRouter.openTunnelForCommand()`；命令给「能发 `/tunnel` 的客户端」，
工具给「IM 里只会说自然语言」的场景（dsh-im 的斜杠命令表封闭，无通用派发）。
实现 `src/host/im-command.ts`，宿主侧入口 `ApiRouter.openTunnelForCommand()`（与 `POST /manage/cloudflare/create`
共用 `createTunnel()`）；审计 `action=cloudflare.create`、来源标签 `im-command`。
**身份校验不在这里**：由 IM 插件的访问策略（allowlist + `canExecuteCommands`）在派发前完成，见 SECURITY.md。
| GET | `/api/v1/chat/sessions/{sessionId}/models` | `scope:chat.read` | 会话可选模型 | `router.ts` sessionModelsRoute 块 |
| GET | `/api/v1/chat/sessions/{sessionId}/model` | `scope:chat.read` | 同上的别名（路由正则 `model(?:s)?$` 同时收两种拼法，新客户端请用 `/models`） | 同上 |
| PUT | `/api/v1/chat/sessions/{sessionId}/model` | `scope:chat.write` | 选择模型 `{provider, model, reasoningEffort?}` | 同上 |
| PUT | `/api/v1/chat/sessions/{sessionId}/agent-preset` | `scope:chat.write` | 选择智能体预设（仅空白会话可改） | `router.ts` sessionAgentPresetRoute 块 |
| POST | `/api/v1/chat/runs/{id}/cancel` | `scope:chat.write` | 取消当前轮（路径段语义为 sessionId） | `router.ts` cancelRoute 块 |
| GET | `/api/v1/settings/providers` | `scope:settings.read` | 提供商配置 | `router.ts` dispatch providers 分支 |
| POST | `/api/v1/settings/providers` | `scope:settings.write` | 新建自定义提供商 | 同上 |
| PATCH | `/api/v1/settings/providers/{providerId}` | `scope:settings.write` | 改提供商 | `router.ts` providerRoute 块 |
| DELETE | `/api/v1/settings/providers/{providerId}` | `scope:settings.write` | 删提供商 | 同上 |
| POST | `/api/v1/settings/providers/{providerId}/discover` | `scope:settings.write` | 发现可用模型 | `router.ts` discoverProviderRoute 块 |
| GET | `/api/v1/settings/models` | `scope:settings.read` | 模型目录 | `router.ts` dispatch settings/models 分支 |
| GET | `/api/v1/settings/namespaces` | `scope:settings.read` | 全部插件设置命名空间（按 schema 生成表单） | `router.ts` dispatch settings/namespaces 分支 |
| PATCH | `/api/v1/settings/namespaces/{ns}` | `scope:settings.write` | 按路径改一个命名空间（`ui-*` / `*locale` 默认可写） | `router.ts` settingsNamespaceRoute 块 |
| GET | `/api/v1/settings/plugins` | `scope:settings.read` | 插件清单（`checkUpdates=1`） | `router.ts` dispatch settings/plugins 分支 |
| PATCH | `/api/v1/settings/plugins` | `scope:settings.write` | 插件启停 `{name, loaded}` | 同上 |

> handler 列只指分支名，不抄行号（行号随提交漂移，AGENTS.md §3.2）。
> 路径与方法的机器真值：`docs/api/openapi.yaml` 的 `paths`，与 `src/host/router.ts`
> 由 `scripts/docs-contract.ts` 在 `docs:check` 中双向 diff（少一条/多一条/豁免集不一致都红）。
> `tests/capabilities.spec.ts` 还会拿能力位宣称的路径去 openapi 逐条核对。
> **改路由先改契约三处（openapi/asyncapi/API.md），再改 `router.ts`。**

### 2.3 回环管理面 `/manage`（仅 `admin`）

先 `requireAdmin`，再进 `dispatchManagement`（`router.ts:848`）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/manage/status` | 远程访问状态与运行中的操作 |
| GET / POST | `/manage/roots` | 列/加授权根 |
| DELETE | `/manage/roots/{rootId}` | 删授权根 |
| GET | `/manage/devices` | 设备清单 |
| PATCH / DELETE | `/manage/devices/{deviceId}` | 改 scope/root、**只改名**（`{name}`）· 撤销（直接删行） |
| POST | `/manage/pairings` | 生成配对码 |
| POST | `/manage/config/text` | 生成 `DSH1:` 配置文本 |
| POST | `/manage/remote/enable` · `/disable` | 开关远程监听 |
| PUT | `/manage/remote/listener` | 改绑定 IP/端口（失败回滚） |
| GET | `/manage/audit` | 审计日志 |
| GET / PUT | `/manage/image` | 识图路径设置 |
| DELETE | `/manage/trash/{trashId}` | 彻底删除回收站条目 |
| GET / HEAD | `/manage/cloudflare/status` · `/activity` | 隧道状态与活动（豁免判据 0，供本机面板读取；判据 1/2/3 仍生效） |
| POST | `/manage/cloudflare/create` | 建隧道（仅隧道未运行时；可选 body `configText:true` 搭车返回 `DSH1:` 配置） |
| POST | `/manage/cloudflare/stop` | 停隧道（**唯一豁免判据 0 的写操作**；判据 1/2/3 仍生效，边缘调用 403） |

---

## 3. 事件流、能力位与跨仓契约

### 3.1 WebSocket 事件

- 端点：`/api/v1/events`（AsyncAPI channel `events`），升级时 Bearer 鉴权。
- 帧形状：`{ id, type, time, data }`（`WorkspaceEvent`，见 `src/shared/contracts.ts:62`）。
- 事件类型（`type`）：
  `file.changed` · `file.trashed` · `chat.message.delta` · `chat.message.committed` ·
  `chat.session.status` · `chat.session.snapshot` · `chat.deliverables.presented` ·
  `chat.approval.requested` · `chat.approval.resolved` · `chat.turn.failed` ·
  `connection.ready`（首帧）· `connection.resyncRequired`（背压丢帧后补发）·
  `chat.userQuestions/requested`。
- 授权过滤在 `server.ts` 的 `eventAllowed`：按 scope（`files.read` / `chat.read`）、
  设备 root 范围、会话归属三层判；设备被撤销时该连接以 `4001` 关闭。
- `seq` 只表示**会话持久事件序号**；流式 delta 不输出它（ADR-0008）。
- 连接级行为（真值在 `src/host/server.ts`，AsyncAPI 有同条记录）：
  30s ping 心跳、连续 2 个周期缺 pong 即 terminate；默认最多 32 条连接（可配置），
  第 33 条在**鉴权通过之后**于 Upgrade 阶段收到 HTTP 429；单帧上限 1 MiB，超限 close(1009)；
  每连接发送队列 512 帧，溢出时优先丢 `chat.message.delta` 并补发
  `connection.resyncRequired`（`data: {dropped, reason:'backpressure'}`），
  状态帧也塞不进时 close(1013,'Backpressure')。

### 3.2 订阅基线与补推

| 事件 | 作用 |
| --- | --- |
| `chat.session.snapshot` | 订阅基线：`cursor` 是增量起点。**不带正文**（双通道会造两份基线） |
| `chat.approval.requested` / `chat.userQuestions/requested` | 连接建立时**只补推给这条连接**仍待处理的交互，`data.replayed = true` |

### 3.3 只读图片路由

`GET /plugin/dsh-remote-bridge/raw?sessionId=&name=` —— 走
`createImageRouteHandler`（`image-handoff.ts:239`），信任模型是
「回环 + 插件页 Referer/同源 + 64 位 hex 文件名白名单 + 字节嗅探」，
**不接受目录参数**（目录由宿主按会话工作目录推出）。

### 3.4 能力位（`connection.ready`）

- 载荷：`{ bridgeVersion, capabilities: string[] }`（`capabilities.ts` 的 `connectionReadyData()`）。
- 能力位的**清单与数量以 `src/host/capabilities.ts`（`BRIDGE_CAPABILITIES`）源码为准**，
  不在文档里抄数字（AGENTS.md §3.2）；命名固定 `<能力>-v<主版本>`；只增不撤，语义变更升 `-v2`。
- **每项必须能指出契约依据**（一个 OpenAPI 路径+方法，或一个 AsyncAPI 事件），
  `tests/capabilities.spec.ts` 逐条核对。
- 客户端只把 `approvals-v1` / `questions-v1` 当必需项（详见
  `dsh-companion` 的 `BridgeCapabilities.kt`）；其余全是特性探测。
- 最高频的新增动作：加 REST 路由 → 加能力位 → 写依据 → 跑 `capabilities.spec`。

### 3.5 移动端网关 WebSocket (/ws/mobile)

- 端点：`/ws/mobile`（双向请求/响应，挂主 HTTP server upgrade），与 `/api/v1/events` 并存；端口默认 `3090`。
- 子协议（`Sec-WebSocket-Protocol`）：`dsh-mobile-v1, dsh-pair.<code>`（首次配对，随请求带 `X-DSH-Device-ID`；成功后推 `paired` 再推 `hello`）；`dsh-mobile-v1, dsh-auth.<token>` 或 HTTP 头 `Authorization: Bearer <token>`（后续连接）。不允许 URL query 带 token。
- 连接即推 `hello`：`{kind:'hello', protocol:3, capabilities, authenticated, device, port, clients}`；能力位与 §3.4 同源（`src/host/capabilities.ts`）。
- 客户端帧 `{type:…}`：`ping` / `subscribe` / `unsubscribe` / `message` / `workspaces` / `sessions` / `history` / `attachment` / `file-download-open/read/cancel` / `search` / `host` / `default-model` / `save-default-model` / `models` / `providers` / `commands` / `command-execute` / `command-options` / `command-select` / `select-model` / `permission-options` / `permission` / `context-usage` / `session-stats` / `tasks` / `goal` / `goal-edit` / `goal-pause` / `goal-resume` / `goal-clear` / `plugin-catalog/inspect/install/settings` / `agent-presets` / `defaults` / `set-default` / `question-answer` / `question-cancel` / `approval-response`。
- 服务端帧 `{kind:…}`：`hello` / `pong` / `subscribed` / `sent` / `workspaces` / `sessions` / `history` / `search` / `commands` / `command-options` / `command-executed` / `command-selected` / `attachment` / `file-list` / `file-download-opened/chunk/cancelled` / `session-cancelled` / `queue-item-updated` / `session-queues` / `session-queue` / `session-archived` / `session-renamed` / `session-archives` / `session-title-changed` / `error` / `event` / `tasks` / `goal` / `goal-edit` / `goal-pause` / `goal-resume` / `goal-clear` / `tasks-updated` / `goal-updated` / `question-requested/response/resolved` / `approval-requested/response/resolved`。
- `message` 帧：`sessionId` 可选（省略自动建会话）、`mode:'queue'|'steer'`、`content`（PromptContentPart[]，图片 Base64 无 `data:` 前缀）、`clientTimeZone`、`workspaceId`/`cwd`。
- `history` 帧：`beforeSeq`/`maxMessages`/`maxBytes`（默认 4 MiB）、`view:'conversation'`；响应带 `hasMore`+`nextBeforeSeq`。
- HITL：`question-answer`/`approval-response` 双向；server→client `question-requested`/`approval-requested`（`outcome: 'allowed-once'|'rejected'`，**不支持始终允许**）；重放待处理项 `replayed=true`，客户端按 `approvalId`/`callId` 去重。
- 背压与关闭：同 §3.1（单帧 1 MiB、发送队列 512 帧、30s ping、连续错过 2 周期 terminate、设备撤销 close(4001)）；`connection.resyncRequired` 通知客户端改走 REST 重取基线。
- 鉴权与授权：复用 `principal()` 与 `eventAllowed`（scope/root/session 三层）；会话级操作再用 `isSessionAuthorized` 过滤；未带凭据 401，越权 scope 403，系统错误不回显绝对路径。

### 3.6 与 `dsh-companion` 的门槛

README 双站的「要求 bridge ≥ X.Y.Z」是**安装门槛**，不是功能判据；
功能判据一律走能力位。改门槛要同步：根 README 双站两处、`docs/project/PITFALLS.md`
的 bridge 版本基线表、姊妹仓同款文案（`docs:check` 会比对 README 双站与基线表）。

---

## 4. 内部模块接口

> 只列跨模块会用到的导出。私有实现细节请看源码，别在这里抄。

### 4.1 插件入口 `src/index.ts`

```ts
export const name = 'dsh-remote-bridge'
export const inject = [/* 10 项硬依赖，必须与 cordis.patch.yml 双向对齐 */]
export interface Config { dataDir?: string; port?: number; remoteHost?: string; maxUploadBytes?: number }
export async function apply(ctx: HostContext, config: Config = {}): Promise<void>
export default apply
```

- `inject` **只能放两个支持版本上都存在的服务**；可选服务（`permissionPresets` /
  `jobController` / `fileUploads` / `attachments`）用 `ctx.reflect.get(name, false)` 运行时读。
- `apply` 的装配顺序：数据库 → 内置根 → 事件总线 → 鉴权 → 文件服务 →
  `apiProxy`（适配层）→ chat/settings adapter → 注入面探针 → 监听器 → 图片路由 → 生命周期注册。

### 4.2 `src/host/server.ts`

```ts
export class RemoteApiServer implements RemoteControl
export interface EmbeddedRoute { kind: 'exact' | 'prefix'; path: string; handler: (req, res) => void | Promise<void> }
export function attachEmbeddedRoutes(webServer, router, remote, extraRoutes?): () => void
```

`RemoteApiServer` 方法：`start()` / `stop()` / `status(operationId?)` /
`enable(rootIds, scopes)` / `disable()` / `configure(host, port)` —— 全部返回或操作
`RemoteOperationView`。`attachEmbeddedRoutes` 负责挂 `/dsh-workspace-api` 与图片路由。

### 4.3 `src/host/router.ts`

```ts
export interface RemoteOperationView   // 远程操作的对外视图（id/state/target/code/pairingCode…）
export interface RemoteControl         // 管理面依赖的控制接口（status/enable/disable/configure）
export type JobRouteMatch              // { kind: 'list' | 'output' | 'kill' | 'detail', … }
export function matchJobRoute(pathname: string): JobRouteMatch | null
export class ApiRouter {
  constructor(options: RouterOptions)
  handle(req, res, stripPrefix = ''): Promise<void>
}
```

新增路由 = 在 `dispatch`（版本化 REST）或 `dispatchManagement`（`/manage`）里加分支；
文件子路由走 `dispatchEntries` / `dispatchContent`。

### 4.4 `src/host/dsh-0.2-bridge.ts`（适配层）

```ts
export interface Dsh02HostServices        // 全部宿主服务的结构类型集合
export function createDsh02ApiProxy(ctx: Dsh02HostServices, options): DshApiProxy
export async function readHandoffImageFile(ctx, roots, fallbackDir, subdir, sessionId, name)
export function normalizePermissionCatalog(raw: unknown)
export const FALLBACK_PERMISSION_CATALOG
export function projectionsOf(...) / export async function readSessionProjections(...)
export function handoffLocaleOf(acceptLanguage: string | undefined): HandoffLocale
export type PromptContentPartLike / FileUploadsLike / AttachmentStoreLike / SessionControllerLike /
  WorkspaceControllerLike / WorkspaceRegistryLike / SettingsControllerLike /
  CredentialsControllerLike / AgentPresetsLike / PermissionPresetsLike / JobControllerLike / LlmLike /
  UserQuestionsLike / UserQuestionRequestLike
```

**这个文件的任何内核适配补丁都必须带 `@patch` 四要素**（for/why/until/test），
`tests/patch-discipline.spec.ts` 校验五要素齐全且 `test` 指向的用例真实存在。

### 4.5 `src/host/chat-adapter.ts`

类 `DshChatAdapter`（`chat-adapter.ts:364`）的公开方法，全部以 `principal: Principal` 开头做授权：

```txt
listSessions(principal, { archived? })        listWorkspaces(principal)      createWorkspace(principal, rootId, relativePath)
renameWorkspace(principal, workspaceId, title) deleteWorkspace(principal, workspaceId)
listAgentPresets()                            listPermissionPresets()        selectAgentPreset(principal, sessionId, agentPreset)
createSessionInWorkspace(principal, workspaceId, …)  createSession(principal, rootId, …)
history(principal, sessionId, { beforeSeq, maxMessages })
prompt(principal, sessionId, parts, mode)     uploadAttachment(principal, sessionId, bytes, name)
readAttachment(principal, sessionId, attachmentId)   readHandoffImage(principal, sessionId, name)
cancel(principal, sessionId)                  renameSession(principal, sessionId, title)
forkSession(principal, sessionId, atSeq?)     archiveSession(principal, sessionId)
listPendingApprovals(principal, sessionId)    replayPendingApprovals(principal)
replayPendingQuestions(principal)            decideApproval(principal, sessionId, approvalId, allowOnce)
listUserQuestions(principal, sessionId)      answerUserQuestion(principal, sessionId, callId, answers)
models(principal, sessionId)                  selectModel(principal, sessionId, selection)
listCommands(principal, sessionId)            executeCommand(principal, sessionId, line)
isSessionAuthorized(principal, sessionId)     startEvents(signal, emit)
```

模块级导出：`unwrapDsh`（拆 DSH RPC 壳并映射错误）、`normalizeDshEvent`（帧归一）、
`turnFailureOf`、`approvalReplayEvents`、`questionReplayEvents`、`redactApprovalText`。

### 4.6 `src/host/database.ts`

```ts
export class WorkspaceDatabase {  // node:sqlite；构造参数 dataDir
  close() / dumpSchema()
  getSetting(key) / setSetting(key, value)
  addRoot(inputPath, label?, options?) / listRoots() / getRoot(id) / ensureBuiltinRoot(realPath, label) / removeRoot(id)
  createPairing(rootIds, scopes, ttlMs?) / exchangePairing(code, deviceName) / authenticate(token)
  getActiveDevice(id) / listDevices() / isDeviceActive(id) / updateDevice(id, scopes, rootIds)
  revokeDevice(id) / purgeRevokedDevices()
  insertTrash(record) / getTrash(id) / listTrash(rootIds?) / updateTrashStatus(id, status) / deleteTrashRecord(id)
  audit(...) / listAudit(limit?) / readIdempotent(deviceId, key) / saveIdempotent(deviceId, key, status, body)
}
export function hashSecret(secret: string): string
export interface StoredRoot / AuthenticatedDevice / TrashRecord
```

### 4.7 `src/host/file-service.ts`

```ts
export class FileService {  // 构造 (database, emit)
  list(root, relativePath, limit?, cursor?) / inspectContent(root, relativePath) / streamContent(descriptor, range?)
  writeContent(root, relativePath, bytes, opts) / createEntry(root, relativePath, kind)
  moveEntry(root, sourcePath, destinationPath) / trashEntry(root, relativePath)
  listTrash(rootIds?) / restoreTrash(root, trashId) / purgeTrash(trashId)
}
```

### 4.8 其余宿主模块（一行一条，签名以源码为准）

| 导出 | 位置 | 用途 |
| --- | --- | --- |
| `AuthService`（`principal` / `requireAdmin` / `requireScope` / `requireRoot`） | `auth.ts` | 身份与 scope 校验、限流桶；`tunnelActive` 注入驱动判据 0 |
| `adminRefusal` / `isLocalAdminRequest` / `hasForwardingHeader` | `auth.ts` | 「本机管理请求」四层判据（§2.1.1），两个入口共用 |
| `BRIDGE_CAPABILITIES` / `HISTORY_FORMAT_VERSION` / `connectionReadyData()` | `capabilities.ts` | 能力位与历史格式版本 |
| `DshSettingsAdapter`（`listProviders` / `catalog` / `updateProvider` / `createProvider` / `removeProvider` / `discover` / `describeNamespaces` / `mutateNamespace`） | `settings-adapter.ts` | 提供商与模型目录、通用设置命名空间读写 |
| `isSettingsNamespaceWriteAllowed` / `settingsNamespaceReason` / `redactSettingsSecrets` / `parseSettingsNamespaceOps` / `settingsNamespaceOpFields` / `settingsNamespaceCredentialChanged` / `projectSettingsNamespace` | `settings-namespace.ts` | 命名空间写策略、密钥脱敏、ops 校验与响应投影（纯函数） |
| `readPluginInventory` / `withUpdateCheck` / `resolveState` / `togglePlugin` / `PluginToggleError` / `resolveDshHome` / `resolveProfileName` / `normalizeProfileName` | `plugin-inventory.ts` | 插件清单与启停 |
| `JobAdapter`（`list` / `follow` / `kill`）、`JobApiError` | `job-adapter.ts` | 后台任务 |
| `WorkspaceEventBus`（`emit` / `subscribe`） | `event-bus.ts` | 进程内事件总线 |
| `FixedWindowLimiter`（`consume`） | `rate-limit.ts` | 限流 |
| `ApiError` / `asApiError` | `errors.ts` | 错误载体 |
| `stringifyWire` / `sanitizeLoneSurrogates` | `wire-json.ts` | 出网 JSON 安全序列化 |
| `validateRelativePath` / `canonicalRoot` / `resolveAuthorizedPath` / `isPathInside` / `wireRelative` / `parentWirePath` | `path-policy.ts` | 路径策略 |
| `matchAuthorizedRoot` / `matchAuthorizedRootResolved` / `inspectResolvedPath` | `root-resolver.ts` | 绝对路径 → 授权根 |
| `HISTORY_BYTE_BUDGET` / `HISTORY_EVENT_BYTE_BUDGET` / `HISTORY_KEEP_CHARS` / `clampHistoryEvents` / `applyHistoryBudget` | `history-budget.ts` | 历史字节预算 |
| `normalizeHandoffSubdir` / `readHandoffSubdir` / `saveHandoffSubdir` / `imageHandoffView` / `declaredMediaType` / `sniffMediaType` / `loopbackHost` / `pluginPageReferer` / `sameOrigin` / `createImageRouteHandler` / `IMAGE_ROUTE` / `HANDOFF_FILE_NAME` / `HANDOFF_MEDIA_TYPES` | `image-handoff.ts` | 识图路径与只读图片路由 |
| `CloudflaredTunnelManager` / `ensureCloudflared` / `downloadUrlFor` / `archSuffix` / `extractQuickTunnelUrl` / `downloadHttps` / `isDebSource` | `cloudflared.ts` | 隧道管理 |
| `classifyHost` / `detectEndpoints` / `normalizeBaseUrl` / `encodeConfigText` / `defaultDisplayName` / `DEFAULT_PORT` / `KIND_LABEL` | `config-text.ts` | 配置文本 |
| `normalizeListenerHost` / `normalizeListenerPort` / `loopbackFor` / `DEFAULT_REMOTE_HOST` | `listener-config.ts` | 监听配置 |
| `probeHostServices` / `INJECTED_SERVICE_NAMES` / `OPTIONAL_SERVICE_NAMES` / `HostServiceReport` | `host-service-probe.ts` | 注入面探针 |

### 4.9 共享层 `src/shared/`

```ts
export const DEVICE_SCOPES         // 'files.read' | 'files.write' | 'files.delete' | 'chat.read' | 'chat.write' …
export type DeviceScope
export interface RootView / DeviceView / FileEntryView / ImageHandoffSettings / WorkspaceEvent / AdminPrincipal / DevicePrincipal
export type Principal = AdminPrincipal | DevicePrincipal
export const ADMIN_PRINCIPAL
export const PLUGIN_VERSION: string          // shared/version.ts，与 package.json 同步
```

### 4.10 浏览器半边 `src/client/`

| 导出/入口 | 位置 | 用途 |
| --- | --- | --- |
| `WorkspaceApiError` / `DirectoryPage` / `ContentResult` | `api.ts` | 浏览器侧 REST 客户端 |
| 客户端插件入口（slot 注册） | `index.tsx` | 面板与图片交接渲染的注册点 |
| 手机设置面板组件 | `workspace.tsx` | 七张折叠卡片（含插件清单与启停） |
| `PLUGINS_TAB_ID` / `PLUGINS_TAB_KIND` / `pluginsTabDefinition` / `PluginsTabTitle` / `makePluginsTabBody` | `plugins.tsx` | 插件清单的右侧栏 tab：`SidebarRightTabDefinition` + guide 卡片（rc.3 起可 pin） |
| 交接消息解析 | `handoff.tsx` | 用户消息行首标记 → 图片 |
| 语言 store 与文案 | `i18n.tsx` | `zh-CN` / `en` |
| `AppQrCode` | `app-qr.ts` | 应用下载二维码（生成物） |

---

## 5. 改接口的检查清单

按顺序做，**不要跳步**：

1. **先改契约文档**：`docs/project/API.md` + `docs/api/openapi.yaml` / `asyncapi.yaml`。
2. **能力位**：若客户端要据此分支，加 `<能力>-v1` 并在注释里写出契约依据；
   不需要分支的（收到就用、没有就晚一点）**不要加**。
3. **Kotlin SDK**：`kotlin-sdk/src/main/kotlin/ai/deepseek/dsh/workspace/DshWorkspaceClient.kt`。
4. **实现**：`router.ts` 分支 + 对应 adapter。
5. **合约测试**：`tests/` 下补正向与拒绝路径；修 bug 必须带回归用例。
6. **本文与锚点**：更新上面相应小节 + 文末 `interfaces-check` 区。
7. **`pnpm check`**：typecheck → test → docs:check → build，全绿再提交。
8. 跨仓影响：需要 `dsh-companion` 跟进的，先在本仓发版，再改 App（App 只消费公开 API）。

---

## 6. 机检锚点（docs:check 读取，勿改格式）

> 本区由 `scripts/check-project-docs.ts` 解析：第二列文件必须存在，
> 且该文件包含第一列里提取出的标识符（取最后一串 `[A-Za-z_][A-Za-z0-9_]*`）。
> 改导出名或搬文件时同步这里，否则 `pnpm docs:check` 变红。

<!-- interfaces-check:begin -->
| 符号 | 位置 | 类型 |
| --- | --- | --- |
| `export const name` | `src/index.ts` | const |
| `export const inject` | `src/index.ts` | const |
| `export interface Config` | `src/index.ts` | interface |
| `export async function apply` | `src/index.ts` | function |
| `export class RemoteApiServer` | `src/host/server.ts` | class |
| `export interface EmbeddedRoute` | `src/host/server.ts` | interface |
| `export function attachEmbeddedRoutes` | `src/host/server.ts` | function |
| `export class ApiRouter` | `src/host/router.ts` | class |
| `export interface RemoteControl` | `src/host/router.ts` | interface |
| `export function matchJobRoute` | `src/host/router.ts` | function |
| `export interface Dsh02HostServices` | `src/host/dsh-0.2-bridge.ts` | interface |
| `export function createDsh02ApiProxy` | `src/host/dsh-0.2-bridge.ts` | function |
| `export async function readHandoffImageFile` | `src/host/dsh-0.2-bridge.ts` | function |
| `export function normalizePermissionCatalog` | `src/host/dsh-0.2-bridge.ts` | function |
| `export interface DshApiProxy` | `src/host/chat-adapter.ts` | interface |
| `export class DshChatAdapter` | `src/host/chat-adapter.ts` | class |
| `export function unwrapDsh` | `src/host/chat-adapter.ts` | function |
| `export function normalizeDshEvent` | `src/host/chat-adapter.ts` | function |
| `export class WorkspaceDatabase` | `src/host/database.ts` | class |
| `export function hashSecret` | `src/host/database.ts` | function |
| `export class FileService` | `src/host/file-service.ts` | class |
| `export class AuthService` | `src/host/auth.ts` | class |
| `export function adminRefusal` | `src/host/auth.ts` | function |
| `export function isLocalAdminRequest` | `src/host/auth.ts` | function |
| `export function hasForwardingHeader` | `src/host/auth.ts` | function |
| `export const BRIDGE_CAPABILITIES` | `src/host/capabilities.ts` | const |
| `export function connectionReadyData` | `src/host/capabilities.ts` | function |
| `export class DshSettingsAdapter` | `src/host/settings-adapter.ts` | class |
| `export interface SettingsNamespaceView` | `src/host/settings-namespace.ts` | interface |
| `export interface SettingsNamespacesView` | `src/host/settings-namespace.ts` | interface |
| `export function isSettingsNamespaceWriteAllowed` | `src/host/settings-namespace.ts` | function |
| `export function parseSettingsNamespaceOps` | `src/host/settings-namespace.ts` | function |
| `export class JobAdapter` | `src/host/job-adapter.ts` | class |
| `export class WorkspaceEventBus` | `src/host/event-bus.ts` | class |
| `export class FixedWindowLimiter` | `src/host/rate-limit.ts` | class |
| `export class ApiError` | `src/host/errors.ts` | class |
| `export function stringifyWire` | `src/host/wire-json.ts` | function |
| `export class MobileGatewayWsHandler` | `src/host/ws-handler.ts` | class |
| `attachHostServices` | `src/host/ws-handler.ts` | method（注入全局模型目录与文件浏览依赖） |
| `attachRemoteServices` | `src/host/ws-handler.ts` | method（注入内核可选 typert 远程服务，定时任务/语音代理） |
| `export class TeamHandler` | `src/host/ws-team.ts` | class |
| `export class GoalsHandler` | `src/host/ws-goals.ts` | class（投影读 + goals Remote 写） |
| `export class ScheduleHandler` | `src/host/ws-schedule.ts` | class |
| `export class SpeechHandler` | `src/host/ws-speech.ts` | class |
| `export function createHostRemoteServices` | `src/host/ws-host-services.ts` | function |
| `export interface HostRemoteHandle` | `src/host/ws-host-services.ts` | interface |
| `sessionProjections` | `src/host/chat-adapter.ts` | method（读会话投影基线，agent-team/subagents 用） |
| `export class FilesHandler` | `src/host/ws-files.ts` | class |
| `FilesHandler.handleDirectoryCreate` | `src/host/ws-files.ts` | method |
| `export class FileTransferHandler` | `src/host/ws-file-transfer.ts` | class（分块下载/上传，连接隔离 + 并发上限 + SHA-256） |
| `closeConnection` | `src/host/ws-file-transfer.ts` | method（连接关闭清理该连接全部传输） |
| `expire` | `src/host/ws-file-transfer.ts` | method（空闲传输回收） |
| `dispose` | `src/host/ws-file-transfer.ts` | method（停机清理全部传输） |
| `export class SettingsHandler` | `src/host/ws-settings.ts` | class |
| `export class MobileEventBridge` | `src/host/ws-event-bridge.ts` | class |
| `export function makeEventAuthorizer` | `src/host/ws-event-bridge.ts` | function |
| `export const WS_PATH` | `src/host/ws-protocol.ts` | const |
| `export const WS_PROTOCOL` | `src/host/ws-protocol.ts` | const |
| `export const PROTOCOL_PAIR_PREFIX` | `src/host/ws-protocol.ts` | const |
| `export const PROTOCOL_AUTH_PREFIX` | `src/host/ws-protocol.ts` | const |
| `export type ClientFrameType` | `src/host/ws-protocol.ts` | type |
| `export type ServerFrameKind` | `src/host/ws-protocol.ts` | type |
| `export function encodeFrame` | `src/host/ws-protocol.ts` | function |
| `export function decodeFrame` | `src/host/ws-protocol.ts` | function |
| `export function makeServerFrame` | `src/host/ws-protocol.ts` | function |
| `export function validateRelativePath` | `src/host/path-policy.ts` | function |
| `export function matchAuthorizedRoot` | `src/host/root-resolver.ts` | function |
| `export function clampHistoryEvents` | `src/host/history-budget.ts` | function |
| `export function createImageRouteHandler` | `src/host/image-handoff.ts` | function |
| `export class CloudflaredTunnelManager` | `src/host/cloudflared.ts` | class |
| `export function encodeConfigText` | `src/host/config-text.ts` | function |
| `export function normalizeListenerPort` | `src/host/listener-config.ts` | function |
| `export function probeHostServices` | `src/host/host-service-probe.ts` | function |
| `export async function readPluginInventory` | `src/host/plugin-inventory.ts` | function |
| `export async function togglePlugin` | `src/host/plugin-inventory.ts` | function |
| `export const DEVICE_SCOPES` | `src/shared/contracts.ts` | const |
| `export interface WorkspaceEvent` | `src/shared/contracts.ts` | interface |
| `export const PLUGIN_VERSION` | `src/shared/version.ts` | const |
| `export class WorkspaceApiError` | `src/client/api.ts` | class |
| `export interface AppQrCode` | `src/client/app-qr.ts` | interface |
| `export const PLUGINS_TAB_ID` | `src/client/plugins.tsx` | const |
| `export function pluginsTabDefinition` | `src/client/plugins.tsx` | function |
| `export function makePluginsTabBody` | `src/client/plugins.tsx` | function |
<!-- interfaces-check:end -->
