# API 使用说明

公开接口基址为 `http://HOST:PORT/api/v1`。`PORT` 默认是 `3090`，可由本机 WebUI 的“工作区设置 → 远程访问”修改。完整 schema 见 [OpenAPI](../api/openapi.yaml) 和 [AsyncAPI](../api/asyncapi.yaml)。

绑定设置接受本机数值 IPv4/IPv6 地址，例如 `0.0.0.0`、`192.168.1.20` 或 `::`；它不接受域名。绑定 `0.0.0.0` 后，客户端仍可使用解析到该服务器的域名连接。监听配置属于回环管理 API，不是对外 `/api/v1` 契约的一部分。

## 配对设备

本机管理员启用远程访问后获得一次性配对码。设备在十分钟内交换令牌：

```sh
curl -X POST http://192.168.1.20:3090/api/v1/pairings/exchange \
  -H "Content-Type: application/json" \
  -d '{"code":"ABCDE-FGHIJ","deviceName":"Pixel"}'
```

响应中的 `token` 只出现一次。后续请求使用 `Authorization: Bearer <token>`。

## 管理文件

路径必须由 `rootId` 和使用 `/` 的相对路径组成：

```sh
curl "http://192.168.1.20:3090/api/v1/roots/ROOT_ID/entries?path=src" \
 \
  -H "Authorization: Bearer TOKEN"
```

读取文件返回原始字节和 `ETag`。保存时必须回传 `If-Match`；新建空路径使用 `If-None-Match: *`。陈旧版本返回 `412 ETAG_MISMATCH`。

### 把绝对路径解析为授权根

会话事件里出现的文件路径是**服务器绝对路径**，而 `/roots` 刻意不返回根的绝对路径。客户端因此无法自己完成映射，需要本端点做一次转换：

```sh
curl "http://192.168.1.20:3090/api/v1/roots/resolve?path=%2Fmedia%2Fdata%2Fproject%2FREADME.md" \
  -H "Authorization: Bearer TOKEN"
```

```json
{ "rootId": "b3cc74d4-...", "path": "project/README.md", "kind": "file",
  "size": 1234, "modifiedAt": 1791498310753, "contentType": "text/markdown" }
```

要求 `files.read`。行为约定：

| 情况 | 结果 |
| --- | --- |
| 命中授权根 | `200`，返回 `rootId` 与根内相对路径，**不含根的绝对路径** |
| 落在多个嵌套根内 | 取**最长**匹配的那个根 |
| 不在任何授权根内 | `404 PATH_OUTSIDE_ROOTS` |
| 传入相对路径 | `400 PATH_NOT_ABSOLUTE`（相对路径会按服务端 cwd 解析，语义不确定，拒绝比猜安全） |
| 路径是目录 | `200` 且 `kind: "directory"`、`size: null`（会话里提到的可能是目录，不该报错） |
| 路径不存在 | `404 PATH_NOT_FOUND` |

安全校验复用文件接口的同一套逻辑（逐段 `lstat`、拒绝路径中的符号链接），因此字符串前缀匹配的局限不会导致越权读取。拿到 `rootId` 与相对路径后，读取内容仍走上面的 `/roots/{rootId}/content`。

## 创建 DSH 会话

`GET /chat/workspaces` 返回当前设备授权根内、由 DSH WebUI 登记的工作区；它与插件文件管理的 `/roots` 是两个不同概念。响应只包含不透明 `workspaceId`、标题、所属 `rootId` 和根内相对路径，不返回服务器绝对路径。没有获准的 DSH 工作区时返回空列表，客户端不得拿文件根标签代替。

`GET /chat/agent-presets` 返回 DSH 当前可用的 Agent 模式及默认项。客户端使用所选 `workspaceId` 和可选 `agentPreset` 调用 `POST /chat/sessions`。为兼容早期客户端，`rootId + path` 创建方式仍保留，但新客户端应优先使用 `workspaceId`。

`PUT /chat/sessions/{sessionId}/agent-preset` 可重新组合空白会话的 Agent Preset。DSH 只允许在第一条消息被接受前切换；会话开始后返回 `409 AGENT_PRESET_LOCKED`，客户端应展示当前 Agent 但禁用切换。

`GET /chat/sessions/{sessionId}/commands` 列出 DSH host 为当前会话实际注册的斜杠命令、说明和可选参数提示；`POST` 同一路径以 `{ "line": "/permission workspace-write" }` 执行命令。执行要求 `chat.write` 及对应 session/root 授权，命令必须存在于当前列表中，并直接进入 DSH command registry，不会退化为普通模型消息。审计仅记录命令名，不记录可能敏感的参数。

会话历史响应的 `projections.values.todos` 与 `projections.values.permissions` 分别提供 DSH 当前 TODO 列表和权限选择器状态。移动端据此展示任务进度，并使用公开命令接口切换 `read-only`、`workspace-write` 或 `danger-full-access`；完整访问仍应由客户端二次确认。

需要新的会话工作区时，客户端先用授权的 `rootId + relativePath` 调用 `POST /chat/workspaces`。服务端确认目标是现有目录且仍位于设备授权根内，再通过 DSH `workspace.create` 登记；响应只返回不透明工作区信息。该接口不会创建本地目录，目录应先通过文件 API 创建。

`PATCH /chat/workspaces/{workspaceId}` 重命名可见工作区，`DELETE` 只移除 DSH 工作区登记，不删除目录、文件或会话日志。两者都要求 `chat.write`，并在调用宿主前重新验证工作区仍位于设备授权根内。

`PATCH /chat/sessions/{sessionId}` 重命名会话；`POST .../fork` 在 DSH 完成的事件边界分叉并继承历史、工作目录和配置；`POST .../archive` 把会话加入 DSH 归档集合。归档会话从默认 `GET /chat/sessions` 结果中隐藏，但日志保留。所有操作同时执行 `chat.write` 与 session/root 授权检查。

## 模型与供应商

`GET /chat/sessions/{sessionId}/models` 返回当前会话选中的供应商、模型、思考强度以及 DSH 判定为可路由的模型组；`PUT /chat/sessions/{sessionId}/model` 使用 `provider + model + reasoningEffort?` 更新当前会话。两者仍执行 session/root 授权检查。

`GET /settings/providers` 只返回供应商有效配置和凭据是否已配置，不返回 API 密钥正文。有效配置会合并 DSH 模板默认值与用户覆盖值；未显式固化模型时从实时 `llm.models` 目录投影并标记 `modelsInherited: true`。响应中的 `customProvider` 同时说明当前 DSH 是否允许自定义供应商和可用协议。

`POST /settings/providers` 使用自定义 route、显示名、Base URL、协议与至少一个模型创建 DSH 自定义供应商；route 必须匹配 DSH WebUI 的小写短横线规则。`PATCH /settings/providers/{providerId}` 可更新 Base URL、协议、模型和写入/清除凭据；`POST .../discover` 使用草稿配置发现模型。读取与修改分别要求 `settings.read`、`settings.write`，并由 DSH 设置服务决定配置是否可写。

## 插件清单

`GET /settings/plugins` 返回当前 profile 的插件状况，要求 `settings.read`：

```json
{
  "profile": "web",
  "profilePath": "/home/user/.dsh/profiles/web",
  "available": true,
  "reason": null,
  "loadedCount": 17,
  "problemCount": 2,
  "items": [
    { "name": "dsh-ffmpeg", "declared": "^0.4.5", "installed": "0.4.7", "loaded": true, "official": false, "state": "loaded" }
  ]
}
```

`items` 是 `dependencies` 与 `dsh.profile.bundles` 的并集，因此能区分三种情况：

| `state` | 含义 |
| --- | --- |
| `loaded` | 声明加载且在 profile 的 `node_modules` 里找到 |
| `runtime-provided` | 官方包（`@deepseek-ai/`），随 DSH 运行时安装，不出现在 profile 的 `node_modules` —— **正常状态** |
| `installed-not-loaded` | 装了但不在加载列表里（常见于备用插件先装不启用） |
| `declared-missing` | 非官方包声明加载却找不到，通常意味着启动会出问题 |

`declared` 是 `dependencies` 里的版本声明，`installed` 是 `node_modules` 里**实际装上的版本**（前者回答不了「现在跑的是哪个版本」）。`problemCount` 统计 `installed-not-loaded` 与 `declared-missing`，**不计** `runtime-provided`。

profile 名依次取自 `DSH_PROFILE`、`--profile=<name>`、`--profile <name>`；`DSH_HOME` 缺省为 `~/.dsh`。无法判定时**不猜**，返回 `available: false` 与 `reason`（`PROFILE_UNKNOWN` 或 `MANIFEST_UNREADABLE`）而不是 500。返回值只包含包名、版本与状态，不返回任何文件内容。

## 工具审批

`GET /chat/sessions/{sessionId}/approvals` 返回当前授权会话的待审批操作；要求 `chat.read` 及对应 root grant。响应只包含公开 `approvalId`、工具名、风险等级，以及可选的脱敏原因和限长命令预览，不返回 DSH 私有 `rpcId`、原始工具参数或未脱敏正文。

`POST /chat/sessions/{sessionId}/approvals/{approvalId}/decision` 接受 `{ "outcome": "allowed-once" }` 或 `{ "outcome": "rejected" }`，要求 `chat.write` 及当前 session/root 授权。v1 不提供永久允许；已解决、过期或重复决定返回 `409 APPROVAL_NOT_PENDING`。审计只记录会话、审批 ID、结果、工具名和风险等级。

WebSocket 使用 `chat.approval.requested` 与 `chat.approval.resolved` 提醒客户端刷新 REST 状态。DSH mux 重连会重放仍待处理的请求，因此插件可恢复内存缓存；客户端断线重连后也必须重新查询 REST，而不是依赖事件回放。

## 错误

所有 REST 业务错误采用：

```json
{
  "error": {
    "code": "PATH_INVALID",
    "message": "Relative path contains a forbidden segment.",
    "requestId": "5f3f4c1b-..."
  }
}
```

结构性元数据不会返回服务器绝对路径。聊天正文和工具输出属于会话内容，可能包含用户或模型主动写出的路径文本。

## 事件

WebSocket 地址为 `ws://HOST:PORT/api/v1/events` 或 `wss://...`。OkHttp 等原生客户端在 Upgrade 请求中发送 `Authorization: Bearer <token>`；浏览器客户端可使用 `bearer.<token>` 子协议。query string token 不受支持，避免令牌进入 URL 日志。

`file.*` 事件要求实时 `files.read` scope，`chat.*` 事件要求实时 `chat.read` scope，并继续检查对应 root/session 授权。授权更新或撤销无需重连即可对后续事件生效；断线后客户端通过 REST 刷新状态，不依赖无限事件回放。

DSH 的 `assistant/chunk` 不直接泄漏为私有 wire。插件将文本和思考 token 规范化为 `chat.message.delta`，载荷包含 `sessionId`、`turn`、`step`、`index`、`kind` 和 `text`；完成的用户/助手消息发送 `chat.message.committed`，客户端随后读取 REST 历史收口。运行状态、Agent 切换和审批变化分别使用 `chat.session.status`、`chat.agent-preset.selected` 与 `chat.approval.*`。

## Android 功能对等矩阵

当前 `v1` 已覆盖设备配对、授权根、文件管理、回收站、工作区发现/创建/重命名/移除、会话列表/创建/重命名/分叉/归档、历史、发消息、steer、取消、实时事件、Agent Preset、TODO/权限投影、当前会话 host 斜杠命令、待审批查询与允许一次/拒绝、供应商有效配置/凭据状态、自定义供应商、模型发现以及会话模型/推理等级选择。以下 DSH WebUI 能力尚未进入稳定外部契约：会话搜索、附件与队列、通用问题回答、工作区自定义排序、归档恢复、目标、子代理、技能和后台任务。

App 不得直接调用 DSH 私有 `/api` 或通用 RPC 透传。每项缺失能力必须在插件中定义稳定 REST/事件 schema、对应设备 scope/root/session 授权、脱敏规则、OpenAPI/AsyncAPI、Kotlin SDK 和合约测试后才能标记为对等。
