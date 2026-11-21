# API 使用说明

公开接口基址为 `http://HOST:PORT/api/v1`。`PORT` 默认是 `3090`，可由 DSH 设置里「手机设置 → 远程访问」修改。完整 schema 见 [OpenAPI](../api/openapi.yaml) 和 [AsyncAPI](../api/asyncapi.yaml)。

绑定设置接受本机数值 IPv4/IPv6 地址，例如 `0.0.0.0`、`192.168.1.20` 或 `::`；它不接受域名。绑定 `0.0.0.0` 后，客户端仍可使用解析到该服务器的域名连接。监听配置属于回环管理 API，不是对外 `/api/v1` 契约的一部分。

## 协议面状态与弃用表（2026-11-20 起）

桥对外有**两个设备协议面**，新能力只做新的那个（宪法见 [AGENTS.md](../../AGENTS.md) §1.1）：

| 面 | 端点 | 状态 |
|---|---|---|
| **移动端网关（新）** | `ws://HOST:PORT/ws/mobile`，子协议 `dsh-mobile-v1`（`dshrb-v1` 另开通用内核调用面） | **新能力的唯一落点**。v2.8 起 |
| REST（老） | `http://HOST:PORT/api/v1` | **老协议，逐步下线**：已冻结、只减不增 |
| 事件流（老） | `GET /api/v1/events`（SSE，单向） | 老协议，仅作 WS 断线/降级的兜底 |
| 管理面 | `/manage/*`（仅回环） | 永久保留，不是设备契约 |

**新代码一律用帧。** 下面给出「哪条 REST 已被哪一帧替代」「最早什么时候移除」；
帧本身的说明见 [移动端网关 WebSocket](#移动端网关-websocket-wsmobile)。

### 1. 已弃用：REST → 帧（最早 3.0.0 移除）

这些 operation 在 [`openapi.yaml`](../api/openapi.yaml) 里已标 `deprecated: true`，并带
`x-dsh-replaced-by`（替代帧）与 `x-dsh-removal-not-before: '3.0.0'`。它们**仍然可用**，
但行为不再承诺，新代码不要调用；客户端迁移到帧之前的老版本继续工作。

| REST（老） | 替代帧（新） | 说明 |
| --- | --- | --- |
| `GET /chat/workspaces` | `workspaces` | 工作区发现 |
| `GET /chat/agent-presets` | `agent-presets` | Agent Preset 清单 |
| `GET /chat/permission-presets` | `permission-options` | 权限/审批档位候选 |
| `GET /chat/sessions` | `sessions` | 含 `archived` 归档列表 |
| `POST /chat/sessions` | `session-create` | `reuseBlank` 语义一致 |
| `PATCH /chat/sessions/{sessionId}` | `session-rename` | 改名 |
| `POST /chat/sessions/{sessionId}/fork` | `fork` | 分叉 |
| `POST /chat/sessions/{sessionId}/archive` | `session-archive` | 归档 |
| `POST /chat/sessions/{sessionId}/wait` | `session-wait` | 长轮询改成一问一答 |
| `GET /chat/sessions/{sessionId}/messages` | `history` | 首屏带 `projections` |
| `POST /chat/sessions/{sessionId}/messages` | `message` | 自动建会话；`mode: queue \| steer` |
| `GET /chat/sessions/{sessionId}/approvals` | `event` 重放 + `approval-resolved` | 连接即重放待处理审批 |
| `POST …/approvals/{approvalId}/decision` | `approval-response` | 仅 `allowed-once` / `rejected` |
| `GET /chat/sessions/{sessionId}/questions` | `event` 重放 + `question-response` | 待处理提问 |
| `POST …/questions/{callId}/answer` | `question-answer` | |
| `GET /chat/sessions/{sessionId}/commands` | `commands` | host 斜杠命令清单 |
| `POST /chat/sessions/{sessionId}/commands` | `command-execute` | |
| `GET /chat/sessions/{sessionId}/models` | `models` | 模型发现 |
| `PUT /chat/sessions/{sessionId}/model` | `select-model` | 会话模型/推理等级 |
| `PUT /chat/sessions/{sessionId}/agent-preset` | `select-agent-preset` | 首条消息前才可切 |
| `POST /chat/runs/{id}/cancel` | `session-cancel` | 帧按会话取消当前 run |

### 2. 迁移中：帧已就绪，客户端仍在用 REST

这三域是 2026-10 为 App 补的 REST 对等面（见 [BFF-REST-CONTRACT.md](BFF-REST-CONTRACT.md)）。
帧是主路径，REST 只作回落；3.0.0 前迁完后按上表规则降级为「已弃用」。

| REST（老） | 替代帧（新） | 说明 |
| --- | --- | --- |
| `…/attachments/uploads` 六条（分块上传） | `file-upload-open` / `chunk` / `finish` / `cancel` | 大附件 |
| `/chat/schedules` 四条 | `schedule-*` 十个帧 | 定时任务（REST 只支持 cron 形态） |
| `/chat/speech/*` 三条 | `speech-*` 八个帧 | 官方语音输入 |
| `POST …/attachments`（单条 base64） | 分块上传 / `attachment` 读取 | 大文件不可靠，建议直接分块 |

### 3. 永久例外：没有帧等价物，不弃用

| REST | 为什么留 |
| --- | --- |
| `/manage/*`、`GET /image-handoff`、`GET /plugin/dsh-remote-bridge/raw` | 浏览器直连/免令牌只读，HTTP 语义本身就是需求 |
| `GET /healthz`、`GET /debug/host-services` | 运维与排障探针 |
| `POST /pairings/exchange`、`GET /devices/self` | 配对发生在 WS 握手之前 |
| `/roots*`、`/trash*` | 授权根与回收站管理；`file-*` 帧只覆盖工作区文件 |
| `GET /attachments/{attachmentId}` | 附件字节；消息里以 `file` 部件引用 |
| `/chat/sessions/{id}/jobs` 三条 | 后台任务没有帧（`tasks` 帧是 TODO 投影，不是 jobs） |
| `/chat/sessions/{lead}/subagents/{subagentId}/messages` | 子会话历史没有帧 |
| `POST /chat/workspaces`、`PATCH/DELETE /chat/workspaces/{id}` | 帧只有 `workspace-create` |
| `/settings/*` | 设置面：帧只覆盖 `providers` 只读、`plugin-*` 插件管理与 `default-model` |

### 4. 给我的迁移指引

1. 先连 `/ws/mobile`，用 `hello.capabilities` 判断帧是否可用；
2. 只有「连不上 WS」或「对端老桥回 `NOT_IMPLEMENTED`」才回落 REST —— 回落原因要能说清；
3. 3.0.0 之前把表 1、表 2 的调用全部换成帧。表 3 不需要迁移。

## 配对设备

本机管理员启用远程访问后获得一次性配对码。设备在十分钟内交换令牌：

```sh
curl -X POST http://192.168.1.20:3090/api/v1/pairings/exchange \
  -H "Content-Type: application/json" \
  -d '{"code":"ABCDE-FGHIJ","deviceName":"Pixel"}'
```

响应中的 `token` 只出现一次。后续请求使用 `Authorization: Bearer <token>`。

## 生成配置文本

回环管理接口 `POST /manage/config/text` 直接产出一行可粘贴的 `DSH1:` 文本，
用于「人已出门、电脑在家」时把连接信息带到手机上。WebUI 的「远程访问」页有对应按钮。

```sh
curl -X POST http://127.0.0.1:3090/manage/config/text \
  -H "Content-Type: application/json" \
  -d '{}'
```

请求体字段全部可选：

| 字段 | 说明 |
| --- | --- |
| `displayName` | 电脑显示名，缺省取本机主机名 |
| `deviceName` | 设备名（写进 `devices` 表，便于日后吊销），缺省 `Mobile device`（**平台无关**；设备第一次带身份连上来时会被自动换成「平台 · 型号」） |
| `scopes` | 设备权限，缺省为 5 项**非破坏性**权限（不含 `files.delete` / `settings.write`） |
| `rootIds` | 授权的根，缺省为全部已注册根 |
| `port` | 自动探测地址时拼接的端口，缺省 `3090` |
| `endpoints` | 显式指定地址 `[{label, baseUrl}]`；缺省时自动探测本机非回环 IPv4 |

响应 `201`：

```json
{ "text": "DSH1:...", "displayName": "家里的电脑", "deviceName": "Pixel 9",
  "endpoints": [{ "label": "局域网（eno1）", "baseUrl": "http://192.168.1.126:3090", "kind": "LAN" }],
  "deviceId": "..." }
```

两点刻意设计：

- **响应不单独回传 `token`** —— 它已包含在 `text` 内，多一份只会让它出现在日志、
  浏览器历史与开发者工具里。
- **不返回配对码的 `expiresAt`** —— 那是配对码的十分钟有效期，而设备令牌**不过期**
  （`devices` 表没有过期列）。回传它会被误读为「这段文本十分钟后失效」。

探测不到任何非回环地址时返回 `400 NO_ENDPOINT`，此时应显式传 `endpoints`。
`text` 内含设备令牌，等价于一把钥匙，只应发给自己。

## Cloudflare 隧道管理

这三种管理端点用于「公网连回本机」的兜底通道（手机不在局域网时也能连）。它们只在注入了
`tunnels`（`CloudflaredTunnelManager`）的构建上可用；未注入时返回 `404 ROUTE_NOT_FOUND`。
`GET /manage/cloudflare/status` 带 `HEAD`/`GET` 任一。`create`/`stop` 为 `POST`，均走回环管理面。

**v2.5.1 起隧道运行时会禁用整个管理面**（`403 TUNNEL_MODE_ADMIN_DISABLED`）——
因为隧道把公网流量转成 127.0.0.1 出站，回环判据会被它洗白。
豁免项有三个：`status`、`activity`（只读）与 `stop`。`stop` 是 v2.5.2 加入的**唯一豁免判据 0
的写操作**：否则隧道一开，本机面板连「体面停机」的出口都没有（只能杀进程），而 status 又 403、
根列表刷空，主按钮随之永久禁用。放行它不构成提权——它的唯一效果是把管理面重新锁回判据 0，
且判据 1 仍挡住任何经边缘的调用（真实 cloudflared 必带 `cf-*` 头）。`create` 与
`config/text` **绝不豁免**（`create` 只在隧道起来之前可调用，`config/text` 能签发令牌）。
豁免只针对判据 0：隧道来源打豁免端点照样 403。见 `SECURITY.md` §管理面的信任边界与「残余风险」。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/manage/cloudflare/status` | 当前隧道状态：`{ channel, url, running, error?, errorKey? }`。未启动时 `running:false`、`url:null`。豁免判据 0 的端点之一，供本机面板读「隧道开着」；隧道来源的请求仍被判据 1/2/3 挡住（403），读不到隧道地址 |
| `POST` | `/manage/cloudflare/create` | 查/建 `cloudflared` 可执行文件并启动 **Quick Tunnel**（转发到**隧道专用数据端口**，见下节；不是主监听端口 `3090`），响应 `201` 返回与 `status` 同构的状态。**请求体可选** `{ "configText": true }`（v2.5.2）：在隧道**起来之前**的这一次调用里等随机域名并顺带生成 `DSH1:` 令牌配置，响应在状态之外多带 `configText`（结构同 `POST /manage/config/text` 的 201），`url` 也回填为等到的地址；12s 内没等到地址则不带 `configText`、`url:null`，客户端可轮询 `status` 后补一步 |
| `POST` | `/manage/cloudflare/stop` | 停止当前隧道，返回 `200` 与状态。**唯一豁免判据 0 的写操作**（v2.5.2）：本机面板在隧道运行时仍可停机；经边缘（带转发/`cf-*` 头）仍 403 |
| `GET` | `/manage/cloudflare/activity` | 创建期间的阶段进度（用户侧用它轮询画进度条）：`{ stage, labelKey, labelParams?, percent }`（v2.5.2 起文案为可本地化的 `labelKey`，不再下发拼好的中文）；`create` 结束即清空 |

`create` 会先下载缺省的 `cloudflared`（官方 GitHub Release，版本 `CLOUDFLARED_VERSION`；
可用环境变量 `CLOUDFLARED_MIRROR` 指定下载镜像），随后
`spawn cloudflared tunnel --url http://127.0.0.1:<隧道专用端口>`，
并从 stdout 里用正则抓取 `https://<host>.trycloudflare.com` 形式的对外地址。

### 隧道专用数据端口（issue #26 阶段 0.2 起）

隧道**不再**指向主监听端口（默认 `3090`）。桥另起一个只绑 `127.0.0.1`、端口由系统分配的
**隧道专用监听**（`src/host/tunnel-listener.ts`），cloudflared 只转到它：

| 在这个端口上 | 行为 |
| --- | --- |
| `/api/v1` 与 `/api/v1/**` | **放行**，与原主端口同一套鉴权（设备令牌；`/api/v1/healthz` 免鉴权） |
| `/ws/mobile`（upgrade） | **放行**，复用主端口同一个 `MobileGatewayWsHandler` 实例（子协议/令牌/连接上限完全一致） |
| `/manage` 与 `/manage/**` | **不存在** ⇒ `404 ROUTE_NOT_FOUND` |
| `/dsh-workspace-api/**` | **不存在**（该前缀只挂在宿主 `webServer`，即主端口） |
| `/api/v1/events` | **不存在**（桥自己的广播 WS 通道，只走主端口） |
| 其它任何 upgrade | 直接销毁连接 |

它的端口号通过 `GET /manage/status` 的**可选**字段 `tunnelPort` 暴露（未启动时为 `0`）；
`cloudflared` 指向哪个端口由代码定死，`create` 不接受调用方指定端口。端口号 <= 0 时
`create` 返回 `503 TUNNEL_PORT_UNAVAILABLE`。

放行 `/api/v1/**` 而不是只放 `/ws/mobile` 是刻意的：手机端用**同一个基地址**同时承载
REST（`base + /api/v1/...`）与 WebSocket（`base + /ws/mobile`），只放 WS 会让经隧道的
REST 调用全部失败。管理面则靠**端口分离**做拓扑级隔离 —— 隧道那个端口上根本没有那条路由，
不依赖请求头判据。详见 `SECURITY.md` §隧道数据面的端口分离。

隧道端口**永不产生「回环管理员」身份**：进入路由分派前它会剥掉
`X-Dsh-Workspace-Admin` 头，所以经隧道的请求即便伪造该头也只能拿到设备令牌身份。

`CLOUDFLARED_MIRROR` 支持两种形态：

- **裸二进制镜像基址**（默认解释）：在被下载地址后拼上架构后缀，如
  `CLOUDFLARED_MIRROR=https://host/cloudflared-` → `https://host/cloudflared-linux-amd64`。
- **`deb+` 前缀的 .deb 完整地址**：`deb+https://…/cloudflared_<ver>_amd64.deb`，
  会下载该 .deb 并用 `dpkg-deb -x` 解包提取 `usr/bin/cloudflared`（**不**污染系统包数据库）。

  已在真机（GitHub 直连被墙）验证：`CLOUDFLARED_MIRROR=deb+https://pkg.cloudflare.com/cloudflared/pool/main/c/cloudflared/cloudflared_2026.10.1_amd64.deb`
  可下载解包并成功拉起 Quick Tunnel（见 PITFALLS §国内下载 cloudflared 必须择源）。

对外地址是 **`https://`**（不产生 `wss://`）：`.trycloudflare.com` 域名来自边缘的 WebSocket 反向代理，
客户端在拼 `wss://` connection 时由客户端侧完成升级。Quick Tunnel 地址**临时且会漂移**，
重建即换新 —— 客户端应用最新的 `url`，不要缓存。

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

`POST /chat/sessions` 在不带 `sessionId` 时，默认先找该位置已有的**空白**会话并复用（`reuseBlank` 省略即 `true`），与 DSH 0.2.1 桌面端「新会话」回到空白会话的行为一致；传 `reuseBlank: false` 可强制新建。挑选时按内核列表顺序取第一个 `blank` 且未被归档的会话，若它记录的 `agentPreset` 与本次请求的预设冲突则跳过、继续找下一个（「没记录预设」不算冲突，否则历史会话永远挑不中）。复用语义完全由桥实现：内核 `sessionController.create` 只在调用方显式传了 `sessionId` 时才会复用，不会自己挑。老的 `rootId + path` 入口没有工作区摘要可用，判据退化为「`cwd` 相同且空白」。

`PUT /chat/sessions/{sessionId}/agent-preset` 可重新组合空白会话的 Agent Preset。DSH 只允许在第一条消息被接受前切换；会话开始后返回 `409 AGENT_PRESET_LOCKED`，客户端应展示当前 Agent 但禁用切换。

`GET /chat/permission-presets` 返回可选权限档位清单（`options` 与部署默认 `defaultPreset`），scope 与 agent-presets 同为 `chat.read`。

**为什么必须单开一条**：内核把预设清单放在**独立的远程服务** `permissionPresets.catalog()` 上，而会话投影里那条 `permissions` wire 视图**只产 `currentValue`**（`wire.view: state => ({ currentValue })`）。两者没有任何交叉引用，客户端能读到「当前档位」却列不出候选 —— Android 客户端 v2.2.44 的权限档位 Pill 与 ⋯ 菜单权限项因此在真机上**从不渲染**（PARITY 上当时误标为 `done`）。候选不在投影里，所以插件必须自己透出来；清单是**进程级**的，客户端连上时取一次即可。形状由 `normalizePermissionCatalog` 收敛：丢弃没有 `value` 的行、`name` 缺失时退回 `value`、空串 `description` 不透传（否则客户端会渲染出一行空白副标题）。

**降级行为（重要）**：`ctx.permissionPresets` 在部分 profile 上**不可注入**（实测 2026-10-19 抛 `cannot get property "permissionPresets" without inject`）。按本仓既定结论，该异常的含义是「**压根没有**这个可注入服务」，而非「加载时机不对」—— 旁证是内核这条能力本身在工作（`/permission` 命令可列出、投影 `permissions.currentValue` 有值），只是没挂进本插件的注入面，因此**装包并不能解决它**。

所以这条端点**容错读取**：服务不可用时返回**内核默认档位**（`workspace-write` / `danger-full-access`，取值依据是内核 `Config` 的 `.default({...})`），客户端菜单因此仍可用；且**服务缺席不会让端点报错**（一个可选能力缺席不该毁掉整个权限入口）。**代价**：真部署若自定义过 `presets`，这份降级清单就不全 —— 它只是兜底，权威来源永远是 `permissionPresets.catalog()`。`read-only` 虽然合法（在 `SANDBOX_MODES` 里），但内核**没有为它配 preset**，而 `/permission <preset>` 切的是 preset 名，故**不**放进降级清单（放进去等于给客户端一个点下去必然失败的选项）。

`GET /chat/sessions/{sessionId}/commands` 列出 DSH host 为当前会话实际注册的斜杠命令、说明和可选参数提示；`POST` 同一路径以 `{ "line": "/permission workspace-write" }` 执行命令。执行要求 `chat.write` 及对应 session/root 授权，命令必须存在于当前列表中，并直接进入 DSH command registry，不会退化为普通模型消息。审计仅记录命令名，不记录可能敏感的参数。响应自 P2-B（0.2.2）起另带 `builtinTokens`（一方命令 en/zh 词条，goal/plan/feedback/compact/permission/export），WS `commands` 帧同字段，条目另带 `definitionId`/`builtin` 供面板分组。

会话历史响应的 `projections.values.todos` 与 `projections.values.permissions` 分别提供 DSH 当前 TODO 列表和权限档位**当前值**。移动端据此展示任务进度，并使用公开命令接口切换 `read-only`、`workspace-write` 或 `danger-full-access`；完整访问仍应由客户端二次确认。

> **`permissions` 只给当前值，候选档位不在里面。** 内核那条 wire 视图是
> `wire.view: state => ({ currentValue })` —— 它不产 `options`，候选项在**另一个远程服务**
> `permissionPresets.catalog()` 上（见上文 `GET /chat/permission-presets`）。
> 客户端的权限菜单必须**两路合成**：当前值读这里，候选读那条目录接口。
>
> `projections` 是**可选**字段，内核没给基线时整个字段缺席（不是空对象）。
> 客户端必须容忍它不存在 —— 把「读不到投影」当成「没有权限这个功能」，
> 就会做出一个永远不渲染的权限入口（v2.2.44 真机验收踩过，见 `PITFALLS.md` §桥的 history 不带 projections）。

需要新的会话工作区时，客户端先用授权的 `rootId + relativePath` 调用 `POST /chat/workspaces`。服务端确认目标是现有目录且仍位于设备授权根内，再通过 DSH `workspace.create` 登记；响应只返回不透明工作区信息。该接口不会创建本地目录，目录应先通过文件 API 创建。

`PATCH /chat/workspaces/{workspaceId}` 重命名可见工作区，`DELETE` 只移除 DSH 工作区登记，不删除目录、文件或会话日志。两者都要求 `chat.write`，并在调用宿主前重新验证工作区仍位于设备授权根内。

`PATCH /chat/sessions/{sessionId}` 重命名会话；`POST .../fork` 在 DSH 完成的事件边界分叉并继承历史、工作目录和配置；`POST .../archive` 把会话加入 DSH 归档集合。归档会话从默认 `GET /chat/sessions` 结果中隐藏，但日志保留。所有操作同时执行 `chat.write` 与 session/root 授权检查。

`POST /chat/sessions/{sessionId}/wait` 长轮询会话状态（0.2.2 `session/wait`，P2-C，需 `chat.read`）：`{timeoutMs?, afterSeq?, maxMessages?}`，阻塞直到会话静止（`reason:'idle'`）、有待输入（`'input-required'`）或超时（`'timeout'`），响应 `{wait:{reason,state,output}}` 原样透传内核结果（`state.queue`/`state.pendingInput` 可驱动输入框提示）。桥钳制 `timeoutMs` 1–120000（缺省 30000）、`maxMessages` 1–200，并把 RPC 超时放宽为等待时长 + 余量——调多久就等多久，不要当心跳用。内核无该远程方法（更早内核）回 **503** `UPSTREAM_UNAVAILABLE`。

## 模型与供应商

`GET /chat/sessions/{sessionId}/models` 返回当前会话选中的供应商、模型、思考强度以及 DSH 判定为可路由的模型组；`PUT /chat/sessions/{sessionId}/model` 使用 `provider + model + reasoningEffort?` 更新当前会话。两者仍执行 session/root 授权检查。

模型条目上的 `contextWindow`（上下文窗口，token）与 `maxTokens`（单次输出上限）由桥补齐：DSH 的 `ModelCatalogModel` 只有 `id` / `name` / `description` / `reasoning`，容量字段在另一处 —— 桥对每个 `provider + model` 调 `llm.resolveModelInfo` 取值（并发查询，按 `provider + model` 缓存 10 分钟，与内核模型列表的 `DEFAULT_MODELS_MAX_AGE_MS` 对齐），失败不缓存以免一次 RPC 抖动让某个模型十分钟没有容量。内核若自己在目录条目里给了这两个字段，桥不覆盖（内核更权威）。同样的补齐也作用于 `GET /settings/models` 的 `ProviderModel`。两个字段都是可选的：查不到就不出现，客户端不得把它当作 0 或「无限制」。

`GET /settings/providers` 只返回供应商有效配置和凭据是否已配置，不返回 API 密钥正文。有效配置会合并 DSH 模板默认值与用户覆盖值；未显式固化模型时从实时 `llm.models` 目录投影并标记 `modelsInherited: true`。响应中的 `customProvider` 同时说明当前 DSH 是否允许自定义供应商和可用协议。

目录型供应商（含未配置的休眠条目）还会携带适配器目录元数据：`defaultBaseURL`（适配器默认 API 地址）、`baseURLEnv`（可覆盖默认地址的环境变量，按优先级排序）、`nativeAuth`（`{env?, oauth}`，适配器原生认证回退）。另有 `settingsNs`（条目设置命名空间；客户端捕获打开卡片那一刻的 `revisionByNamespace[settingsNs]` 作为 `expectedRevision`）。以上字段都是可选的，缺席即「该供应商没有这项目录信息」。

`POST /settings/providers` 使用自定义 route、显示名、Base URL、协议与至少一个模型创建 DSH 自定义供应商；route 必须匹配 DSH WebUI 的小写短横线规则。`PATCH /settings/providers/{providerId}` 可更新 Base URL、协议、模型和写入/清除凭据；`POST .../discover` 使用草稿配置发现模型。`PATCH` 的 `models` 字段：数组=整体替换（空数组=自定义空目录），`null`=恢复适配器默认目录（unset，2.5.0 起）。读取与修改分别要求 `settings.read`、`settings.write`，并由 DSH 设置服务决定配置是否可写；`expectedRevision` 不匹配时返回 409 `SETTINGS_CONFLICT`。

**`baseURL` 的地址策略（2.6.1 起）**：三个写入口（`POST /settings/providers`、`PATCH /settings/providers/{providerId}`、`POST .../discover`）都要过同一套校验，与「命名空间是否可写」是**两条独立的闸门**（providers 路由不经过 `settingsWriteNamespaces`）：

| 情形 | 状态码 | 错误码 |
| --- | --- | --- |
| `baseURL` 为空串 | 400 | `PROVIDER_BASE_URL_REQUIRED` |
| 不是绝对 URL，或协议不是 `http`/`https` | 400 | `PROVIDER_BASE_URL_INVALID` |
| 指向私网 / 回环 / 链路本地 / CGNAT，且未在 `allowPrivateProviderHosts` 里 | 403 | `PROVIDER_BASE_URL_FORBIDDEN`（`details.host`） |
| 该供应商已存有凭据，换 host 却没同时提供新 `apiKey` | 403 | `PROVIDER_BASE_URL_REPOINT_FORBIDDEN`（`details.previousHost` / `details.host`） |

`details.host` 只给 `host[:port]`，**不回显完整 URL**（path/query 可能带凭据）。`allowPrivateProviderHosts` 接受精确 `host` 或 `host:port`，**不支持 CIDR**；推荐带端口（`127.0.0.1:11434`），裸 host 会放行该主机的全部端口。理由与实测证据见 `SECURITY.md` 的「供应商 `baseURL` 的地址策略」。

三个写入口的审计（`settings.provider.create` / `.update` / `.discover`）都带 `baseURLHost`，同样只记 host。`discover` 的 `baseURL` 是临时覆盖、不写配置，所以这条审计是唯一的取证线索。

## 通用设置命名空间（2.6.0 起）

DSH 的设置是**一份按插件命名空间划分的文档**（`ui-chat` 的 `transcriptView`、`ui-theme` 的 `fontSize` 等）。本桥不再为每个插件写专用接口，而是暴露一对通用端点，客户端按返回的 `schema` 自行生成表单：

- `GET /settings/namespaces`（`settings.read`）→ `{ writable, namespaces: SettingsNamespaceSummary[] }`。
- `PATCH /settings/namespaces/{ns}`（`settings.write`）→ 与上面数组里的**单个条目同形**。

条目的形状：

```json
{
  "ns": "ui-chat",
  "revision": 3,
  "schema": { "...": "内核 schema 树，供客户端生成表单" },
  "value": { "transcriptView": "compact" },
  "base": { "transcriptView": "compact" },
  "user": { "transcriptView": "detailed" },
  "secrets": [{ "path": ["apiKey"], "set": true }],
  "writable": true
}
```

`schema` / `base` / `user` / `secrets` 都可能缺席；缺席即「内核没报这一项」，不是空对象。条目的 `revision` 就是 `settings.mutate` 的 `expectedRevision` 来源。

**写策略**（两层与关系）：顶层 `writable` = 内核 `settings.describe().writable`（宿主设置文档整体可不可写）；条目 `writable` = 顶层可写 **且** 该 ns 命中桥的写允许策略。策略默认放行 `ui-*` 与以 `locale` 结尾的命名空间，其余（`llm-*`、`permission`、`agent-default-model`、`subagent-*` 等）只读；部署方可用插件配置 `settingsWriteNamespaces`（精确 ns 或 `前缀*`）显式放宽。不可写时条目带 `reason`：`HOST_READONLY`（整份文档只读）或 `HIGH_RISK_NAMESPACE`（策略拒绝）。理由与安全含义见 `SECURITY.md`。

**PATCH 请求体**：

```json
{
  "ops": [
    { "op": "set", "path": ["transcriptView"], "value": "detailed" },
    { "op": "unset", "path": ["collapseTiming"] }
  ],
  "expectedRevision": 3
}
```

`ops` 必须是 1~32 项、每项 `op` 为 `set`/`unset`、`path` 为字符串数组（空数组代表该命名空间的根，等于整份替换）；`set` 必须带 `value`。`expectedRevision` 可选（不匹配即 409，防止两个客户端互相覆盖）。

**错误码**：

| 状态 | code | 含义 |
|---|---|---|
| 403 | `SETTINGS_NAMESPACE_READONLY` | 该 ns 不在写允许策略内；`details` 带 `ns` 与 `reason` |
| 400 | `SETTINGS_OPS_INVALID` | `ops` 非数组/空/超过 32 项/单项非法，或 `expectedRevision` 不是非负整数 |
| 409 | `SETTINGS_CONFLICT` | `expectedRevision` 与内核当前 revision 不一致 |
| 409 | `SETTINGS_READ_ONLY` | 宿主设置文档整体不可写（与 provider 写入沿用同一错误码） |
| 503 | `SETTINGS_UNAVAILABLE` | 运行的内核没有设置服务 |

**脱敏是两道**：内核本身以 `redactSecrets` 报告 `value`/`user`；桥在序列化前再递归遮蔽键名匹配 `apiKey|secret|token|password|credential|apiKeyEnv` 的字符串值为 `***`（`apiKeyEnv` 本身是环境变量名、不是密钥，但它会暴露供应商配置，一并遮蔽）。两次都不碰非字符串值——数字/布尔不是密钥。

**审计**：每次成功写入记一条 `settings.namespace.mutate`，`details = { ns, fields: string[], credentialChanged: boolean }`。`fields` 只是被触碰的路径（`path.join('.')`），**绝不记录值**；`credentialChanged` 在内核报告的 `secrets[].path` 被命中时为 `true`。

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

`?checkUpdates=1` 时逐条比对 npm registry 上的 latest，填充 `updateAvailable` 与 `latestVersion`。**默认不查**：这是要打网络的活，而绝大多数调用只想看「装了啥」。`updateAvailable` 是三态 —— `null` 表示没查或查不到；压成 `false` 会让界面在离线时谎称「已是最新」，比什么都不说更糟。

`PATCH /settings/plugins` 启用 / 停用单个插件，要求 `settings.write`：

```json
{ "name": "dsh-ffmpeg", "loaded": false }
```

成功返回 `{ name, loaded, backupName, bundleCount, restartRequired }`，其中 `restartRequired` **恒为 `true`**：`dsh.profile.bundles` 只在 DSH 启动时读一次，改了 `package.json` 不等于改了运行中的进程。界面必须把这句说出来，否则用户会以为点了没反应、反复点击。

写入有三条硬约束：写前备份成 `package.json.bak-<时间戳>`（写坏 profile 会让 DSH 下次起不来，而此刻用户可能正在手机上、够不着电脑）、先写临时文件再 `rename`（同分区原子，避免写一半留下残缺 JSON）、官方包一律拒绝。

| 错误码 | 状态 | 含义 |
| --- | --- | --- |
| `REQUEST_INVALID` | 400 | 请求体不是 JSON，或不是 `{ name: string, loaded: boolean }` |
| `PLUGIN_NAME_INVALID` | 400 | 包名不合法（npm 包名允许的字符集，含 scope 的 `/`） |
| `PLUGIN_OFFICIAL_IMMUTABLE` | 400 | 官方包随 DSH 运行时安装，改 bundles 也加载不出来 |
| `PLUGIN_NOT_INSTALLED` | 400 | 包不在 profile 的 `dependencies` 里，先安装再启用 |
| `PROFILE_UNKNOWN` | 503 | 解析不出 profile 目录，不敢猜着写 |
| `MANIFEST_UNREADABLE` | 503 | `package.json` 读不懂，原文件未被改动 |

## 识图路径与交接图片

纯文本模型收到图片时，内核会以 `MODEL_DOES_NOT_SUPPORT_IMAGES` 拒收整条消息。本插件在发消息前把图片落成工作区文件，消息里只留路径 —— 于是「人看到图、模型看到路径、识图工具按路径读图」三者各取所需。落点规则：

```text
<会话工作目录>/<识图路径>/<sha256>.<ext>      # 首选；目录 0700、文件 0600、内容寻址去重
<插件状态目录>/image-handoff/<sha256>.<ext>   # 解析不出会话工作目录时的兜底
```

「识图路径」默认 `.dsh-images`，可在回环管理面查看与修改：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/manage/image` | 返回 `{ subdir, defaultSubdir, fallbackDir }`。`defaultSubdir` 是出厂默认（`.dsh-images`），设置页只读展示 |
| `PUT` | `/manage/image` | 请求体 `{ "subdir": "imgs" }`；只接受**单段**目录名（1-64 字符，字母/数字/点/下划线/连字符）。非法值返回 `400 IMAGE_SUBDIR_INVALID` |

改动立即生效：交接写盘与读图都按当前值现读，不需要重启。响应里的 `fallbackDir` 就是兜底目录的绝对路径。

设备侧取图（需要 `files.read` 与会话归属）：

```http
GET /api/v1/image-handoff?sessionId=<sessionId>&name=<sha256>.<ext>
```

只接受**裸文件名**：目录永远由宿主按会话工作目录推出，客户端给绝对路径也不认（否则这条读文件的口子会变成任意文件读取）。

WebUI 另有**只读**路由供 `<img>` 使用（浏览器不会给图片请求加 `Authorization`，所以它独立于本 REST）：

```http
GET /plugin/dsh-remote-bridge/raw?sessionId=<sessionId>&name=<sha256>.<ext>
```

判据：`Host` 必须回环；浏览器带 `Sec-Fetch-Site` 时跨站一律拒绝（仅 `same-origin` / `none` 放行），同源 `/plugin/` 前缀页面的 `Referer` 放行；**刻意例外**：无 `Sec-Fetch-Site` 且无 `Origin` 的非浏览器调用方（curl、脚本）放行——浏览器一定带这两个头之一，此时安全前提是回环可达性本身（见 `SECURITY.md`，真值在 `image-handoff.ts` 的 `sameOrigin()`）。文件名必须匹配内容哈希白名单、扩展名声明必须与魔术字节一致、体积上限 32 MiB。取不到一律 `404`，且不区分「会话不存在」与「文件不存在」。

## 会话附件

附件走「先上传拿回执，再在消息里引用」两段式：

```http
POST /api/v1/chat/sessions/{sessionId}/attachments
Authorization: Bearer <device-token>
Content-Type: application/json

{ "data": "<base64>", "name": "photo.jpg" }
```

- 要求 `chat.write` 与会话归属；请求体上限 24 MiB；`data` 必填（非空字符串，标准 base64），`name` 可选。
- `201` 返回 `{ "receiptId": "…", "name": "photo.jpg" | null, "attachment"?: {attachmentId, name, bytes} }`；`attachment` 自 0.2.2 起在内核回出 `file` 元数据时透出（P2-D，additive），可据此直接拼 `GET /attachments/{attachmentId}` 而不必再等消息落库。随后把回执放进消息内容的 `file` 部件。**只有图片可以直接内联**（`image` 部件传 base64），其它文件类型必须先拿回执。
- 取附件字节（注意：这条要求的是 **`files.read`**，不是 `chat.read` —— 与「取图」同一档位）：

```http
GET /api/v1/attachments/{attachmentId}?sessionId=<sessionId>
```

`attachmentId` 通常形如 `sha256:<hex>`，**冒号必须 percent-encode**（`sha256%3A<hex>`），路径段百分号编码非法时返回 `400 PATH_INVALID`。响应是原始字节（`Content-Type` 取嗅探结果），`Cache-Control: private, max-age=31536000, immutable`（内容寻址，不可变）。会话或附件不属于当前设备时按 404 处理。

`GET /image-handoff` 与 `GET /attachments/{id}` 的机器 schema 以 `docs/api/openapi.yaml` 为准。

## 已归档会话

`GET /chat/sessions` 默认只列**未归档**的会话（与 WebUI 的分组界面一致）。带上
`?archived=true` 则只列**已归档**的那批。

为什么要有这个参数：内核把「归档」实现为**从所有分组界面隐藏**，而本桥此前照做 ——
于是用户在手机上一归档，那条会话就**再也看不到**（连找都找不到），「归档」成了单向门。

**恢复（取消归档）不在本桥能力内。** 适配层只声明了内核的 `archiveSession`，
内核是否提供 unarchive 调用，**从本仓不可证**（`node_modules` 下没有 `@deepseek-ai/*`，
那些包随 DSH 主包安装）。所以客户端不要提供「恢复」按钮，除非有一天能在宿主侧确认该能力。
—— 这条措辞是刻意的：按 `PITFALLS.md` §空结果的来源要验证，查不到只能写「不可证」，
不能写「没有」。

## 历史与分页

`GET /chat/sessions/{sessionId}/messages` 返回会话历史（`events` + `hasMore`，可选 `projections`），
要求 `chat.read` 与对应 session 授权；`beforeSeq` 往回翻、`maxMessages` 限制条数。

### 子会话（团队成员）历史：受成员关系校验的只读窄口

`GET /chat/sessions/{leadSessionId}/subagents/{subagentId}/messages` 读**子会话**历史，
参数与响应形状与上一条**完全一致**（同样受字节预算约束、同样带 `historyFormatVersion`）。

为什么需要单独一条路径：内核 0.2.x 把子会话也列在 `sessions.list` 里并标 `origin: 'subagent'`，
而桥把这类行整批滤掉（内核拒绝把子会话当普通会话激活，暴露出来只会得到「点开就崩」的行）。
`requireSession()` 的可见性判定建立在 `listSessions()` 上，于是任何子会话 id 打进
`/messages` 都必然 404 —— 手机端「团队面板里点成员看内容」因此走不通。

授权分两步，缺一不可：

1. **Lead 必须可见**：`{leadSessionId}` 走完全没变的既有规则（设备 scope + 授权根 + 归档状态）。
2. **成员关系必须由内核背书**：读 Lead 的会话投影，要求 `{subagentId}` 出现在
   `subagentCatalog[].id`（或 `agentTeam.members[].id`）里。这份目录是内核为这个 Lead
   亲手发布的，不是桥维护的白名单 —— 猜一个 sessionId 来读别人的会话在这里不成立。

两步都过之后才直读历史；**刻意不再调 `requireSession(subagentId)`**，那正是会必然 404 的一步。

- 只读：非 `GET` 一律 `405 METHOD_NOT_ALLOWED`。写成员会话会让「谁在指挥谁」含混，
  官方 Web 端同样只允许经 Lead 的模型工具去写。
- 不满足成员关系、或 Lead 投影取不到时统一 `404 SUBAGENT_NOT_FOUND`（不区分「不存在」
  与「不是成员」，避免把子会话 id 的存否变成探测面）。

响应受**字节预算**约束（单次 2 MiB、单条事件 512 KiB）：

- 整份超出预算时，从**最旧**端丢弃事件、保留最新的连续后缀，并把 `hasMore` 置 `true` ——
  与分页语义一致：客户端拿最早那条的 `seq` 带 `beforeSeq` 继续往回翻即可，不会「以为到底了」。
- 单条事件超出预算时，对它内部的超长字符串做首尾保留（各 8000 字符，中间插入
  `…[truncated]…`），并在该元素上标 `bridgeTruncated: { truncated: true }`。
- **真的发生裁剪时**，响应体追加 `truncated: true` 与 `bytes`（裁剪后的事件字节数）；
  **未发生裁剪时这两个字段不出现**，响应与加这道闸之前逐字节一致。

为什么需要：`events` 是原样透传的内核事件，工具输出单条就可能几 MB，而手机端必须先把整份
JSON 读进内存才谈得上解析 —— 不设闸，「翻一次历史」就能变成卡顿甚至 OOM。
为什么不做字段级裁剪（只掐工具输出那个字段）：本仓**无法证明**工具结果挂在哪个字段上 ——
`tool/result` 这个类型名在本仓 `src/`、`tests/`、`docs/` 零命中，而**内核契约不在本仓可查范围内**
（`node_modules` 下没有 `@deepseek-ai/*`：那些包随 DSH 主包安装，本仓只把它们列为 peer 依赖）。
按猜出来的字段名写裁剪最坏结果是**静默无效**。实现见 `src/host/history-budget.ts`。

## 后台任务

远程场景下有个真焦虑：在手机上让 agent 跑个长任务（bash 构建、批量处理），然后切走或放下手机 —— 此时没有任何地方能看到「它还在跑吗」，更没有地方能「让它停下」。

三个端点，全部挂在**会话维度**下（内核的 `list` / `kill` 都要 `sessionId`，owner fence 是唯一的访问规则）：

```sh
# 这个会话可见的任务清单（它自己的 + 所有无主任务）
curl http://127.0.0.1:3090/api/v1/chat/sessions/{sessionId}/jobs \
  -H "Authorization: Bearer <device-token>"

# 读一个任务已保留的输出；from 省略时从最旧的保留字节开始
curl "http://127.0.0.1:3090/api/v1/chat/sessions/{sessionId}/jobs/{jobId}/output?from=0" \
  -H "Authorization: Bearer <device-token>"

# 终止
curl -X POST http://127.0.0.1:3090/api/v1/chat/sessions/{sessionId}/jobs/{jobId}/kill \
  -H "Authorization: Bearer <device-token>"
```

清单响应：

```json
{
  "jobs": [
    {
      "id": "bash-3f9a1c",
      "kind": "bash",
      "label": "npm run build",
      "owner": "session-1",
      "status": "running",
      "progress": "3/10",
      "startedAt": 1760000000000
    },
    {
      "id": "bash-7d2e04",
      "kind": "bash",
      "label": "cargo test",
      "status": "completed",
      "detail": "exit code: 0",
      "startedAt": 1759999990000,
      "finishedAt": 1760000042000
    }
  ]
}
```

`status` 的取值：`running` / `stopping`（存活中）与 `completed` / `killed` / `failed`（终态）。
`progress` 是生产者的实时进度行，终态时被清空；`detail` 是终态原因（`exit code: 3`），
记录过的人工取消原因会并进来。

输出响应：

```json
{ "jobId": "bash-3f9a1c", "text": "building...\ndone\n", "next": 15, "lossy": false, "status": "completed" }
```

`next` 是**绝对字节偏移**，客户端想增量续读就把它当 `from` 再调一次，不必从头拉。
`lossy: true` 表示「请求偏移与返回内容之间有字节被留存策略吃掉了」——此时这段输出
**不是完整的**，客户端应当提示用户，而不是把它当成全部。

终止响应只有两种：

```json
{ "jobId": "bash-3f9a1c", "outcome": "requested" }
{ "jobId": "bash-3f9a1c", "outcome": "already-finished" }
```

`already-finished` 表示它已经是终态、无需再杀 —— 客户端应显示「它已经结束了」，
而不是「已终止」。任务不存在或该会话看不到它时返回 `404 JOB_NOT_FOUND`。

### 为什么 REST 只读一帧，不做长连接

内核的 `list` 是流（`AsyncIterable`），但内核注释写得很清楚：
「Whole-set replacement, so a reconnect's first frame is already the truth」——
**首帧就是完整真相**。所以 REST 读第一帧就够，不把 HTTP 变成长连接（手机端耗电、
断线重连复杂，而且清单本来就该「拉一次就是真的」）。

同理，`output` 读到终态帧就收：内核让终态与输出走同一条流，就是为了避免
「输出没读全就被告知结束」。

## 工具审批

`GET /chat/sessions/{sessionId}/approvals` 返回当前授权会话的待审批操作；要求 `chat.read` 及对应 root grant。响应只包含公开 `approvalId`、工具名、风险等级，以及可选的脱敏原因和限长命令预览，不返回 DSH 私有 `rpcId`、原始工具参数或未脱敏正文。

`POST /chat/sessions/{sessionId}/approvals/{approvalId}/decision` 接受 `{ "outcome": "allowed-once" }` 或 `{ "outcome": "rejected" }`，要求 `chat.write` 及当前 session/root 授权。v1 不提供永久允许；已解决、过期或重复决定返回 `409 APPROVAL_NOT_PENDING`。审计只记录会话、审批 ID、结果、工具名和风险等级。

WebSocket 使用 `chat.approval.requested` 与 `chat.approval.resolved` 提醒客户端刷新 REST 状态。DSH mux 重连会重放仍待处理的请求，因此插件可恢复内存缓存；客户端断线重连后也必须重新查询 REST，而不是依赖事件回放。

## 宿主服务注入面探针

`GET /debug/host-services` 回答一个此前只能靠猜的问题：**当前这个 DSH 内核上，插件 `inject` 声明的服务到底有几个真的注进来了。**

本插件刻意不 import 任何 `@deepseek-ai/*` 包，全部宿主服务按结构类型 + Host 注入消费。好处是跨内核版本零漂移，代价是 cordis 的注入属性是惰性访问器 —— 读一个没人提供的服务会抛 `cannot get property "x" without inject`，而这个错误只在真的去读的那一刻出现。历史上反复出现同一类事故：某功能静默不工作，两侧日志都不说一句话（`attachments` 在 2.0.0、`fileUploads` 在 2.0.2 都是这么炸的）。

该端点与其它 REST 端点同一套鉴权（设备 token 或 loopback admin），并且**额外要求 `settings.read` scope**（loopback admin 自动继承）—— 它暴露宿主内部结构，不该对局域网裸奔。2.5.2 修复（SEC-H1）：此前它在令牌校验之前返回，属于无凭据可读。本构建未注入报告时返回 `404 NOT_FOUND`；报告可能附带运行期 `metrics` 字段（同一鉴权，不另开路由）。采集发生在插件 `apply` 期间，因为注入属性只在那一刻可读。

```sh
curl http://127.0.0.1:3090/api/v1/debug/host-services \
  -H "Authorization: Bearer <device-token>"
```

```json
{
  "pluginVersion": "2.4.2",
  "injected": [
    { "name": "sessionController", "available": true, "resolvable": true },
    { "name": "permissionPresets", "available": false, "resolvable": false,
      "error": "cannot get property \"permissionPresets\" without inject" }
  ],
  "observed": [
    { "name": "workingDirectory", "available": true, "resolvable": true }
  ],
  "summary": {
    "injectedTotal": 13,
    "injectedAvailable": 12,
    "injectedMissing": ["permissionPresets"],
    "observedAvailable": ["workingDirectory"]
  }
}
```

字段语义：

- `available` —— cordis 是否认为有插件提供这个服务。
- `resolvable` —— 读到的值是否是可用的服务对象（`available` 为真但 `resolvable` 为假，说明服务注册了却是空的）。
- `observed` —— 已确认存在于 web profile、但插件**尚未** `inject` 的服务。当前只有 `workingDirectory`（DSH 0.2.1 新增），列在这里是为了让探针顺手回答「要接的时候它在不在」。

插件启动时也会把摘要打成一行 DSH 日志（`host services N/M 可注入`），所以即使没人请求这个端点，「注入了几个服务」也会留在日志里。

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

### 管理面拒绝码（v2.5.1 起，`403`）

管理面（`/manage/**`）与回环 admin 头（`X-Dsh-Workspace-Admin: 1`）不再只看「TCP 来源是否回环」。
四层判据各给**一个独立的码**，客户端应按码给不同提示，不要把它们糊成一个：

| `error.code` | 含义 | 用户该怎么办 |
| --- | --- | --- |
| `TUNNEL_MODE_ADMIN_DISABLED` | 隧道正在运行，管理面整体停用 | 到本机 WebUI 操作，或在面板里停掉隧道 |
| `ADMIN_PROXY_FORWARDED` | 请求带了转发头（经代理/反代） | 管理面只能从本机直连访问 |
| `ADMIN_HOST_NOT_LOOPBACK` | `Host` 不是回环（公网域名 / DNS 重绑定 / 缺失） | 用 `127.0.0.1` 或 `localhost` 打开 |
| `ADMIN_LOOPBACK_REQUIRED` | socket 来源或 `Origin` 不是回环 | 只能在本机操作（2.5.0 就有的码，保留作兜底） |

判定顺序即上表顺序（短路）。`Origin` **缺失时不因此被拒** —— 详见
`INTERFACES.md` §2.1.1 与 `SECURITY.md` §管理面的信任边界。

## 事件

WebSocket 地址为 `ws://HOST:PORT/api/v1/events` 或 `wss://...`。OkHttp 等原生客户端在 Upgrade 请求中发送 `Authorization: Bearer <token>`；浏览器客户端可使用 `bearer.<token>` 子协议。query string token 不受支持，避免令牌进入 URL 日志。

`file.*` 事件要求实时 `files.read` scope，`chat.*` 事件要求实时 `chat.read` scope，并继续检查对应 root/session 授权。授权更新或撤销无需重连即可对后续事件生效；断线后客户端通过 REST 刷新状态，不依赖无限事件回放。

DSH 的 `assistant/chunk` 不直接泄漏为私有 wire。插件将文本和思考 token 规范化为 `chat.message.delta`，载荷包含 `sessionId`、`turn`、`step`、`index`、`kind` 和 `text`；完成的用户/助手消息发送 `chat.message.committed`，客户端随后读取 REST 历史收口。运行状态、Agent 切换、模型目录变化和审批变化分别使用 `chat.session.status`、`chat.agent-preset.selected`、`chat.models.updated`（0.2.2 `llm/models-updated`，载荷 `{provider}`，P2-A）与 `chat.approval.*`。

### 工具调用的实时事件（`chat.tool.call` / `chat.tool.result`）

内核的 `tool/call` 与 `tool/result` 会话事件原样透传为 `chat.tool.call` / `chat.tool.result`（`data` = 内核 `event.data` 原文 + `sessionId`/`eventType`/`seq`；内核以后加字段不需要改桥）。此前这两类落进兜底分支、`event.data` 整段被丢，实时路径上客户端拿不到工具名/参数/结果，只能防抖重拉历史。

- `chat.tool.call`：`{callId, name, arguments, turn, step}` —— 工具开始执行（参数已定稿）。按 `callId` 去重，同 id 的后到帧覆盖 preparing/running 态。
- `chat.tool.result`：`{turn, step, message, error?}` —— `message` 是持久化工具消息（`role:'tool'`、`toolCallId`、`isError`、`content[{type,text}]`）；`error.code` 是内核侧失败分类（`TOOL_OUTCOME_UNKNOWN` / `TOOL_NOT_STARTED` / `ASK_CANCELLED` 等，**不是桥的枚举**，客户端按已知值出「失败/已取消」态、未知值降级为失败）。exit code 不是协议字段：官方客户端从结果文本尾部的 `[exit code: N]` / `[killed by signal: X]` 标记解析。
- `chat.message.delta` 的 `kind` 扩展：`tool-call`（参数流式生成中，官方 preparing 态，`callId`/`name`/`argumentsDelta` 宽容透传）与 `tool-call-end`（block-end 参数定稿边界）。**老客户端必须忽略未知 kind**，不得当文本渲染。

### 哪条 `chat.message.committed` 才是「回答写完了」（`hasReplyContent`）

`chat.message.committed` 的 `data` 里，`assistant` 角色**多一个** `hasReplyContent` 布尔字段。

**为什么需要它**：内核在**工具执行之前**就把只含 `tool-call` 块的 assistant 消息 settle 落库
（`dsh-agent-loop` 的 `live.settle("assistant/message", …)` 之后才
`message.content.filter(type === "tool-call")` 进执行）—— 一次带工具的回合会提交**多条**
assistant 消息，只有最后那条含正文。桥此前只送了 `role`，客户端收到第一条就只能当「回答结束」：
清流、收起过程组、停掉工具行的实时刷新，而此刻工具还没开始跑。

**判据**（与官方 WebUI 的 `hasAssistantReplyContent` 逐字同义）：`reasoning` 与 `tool-call`
块不算正文，`text` 块按 `trim()` 判空，其余块类型算正文。

- `hasReplyContent: true` —— 最终回答：客户端可以清流式状态、按收起时机收起过程组。
- `hasReplyContent: false` —— 中途提交（工具即将执行）：**不要**清流、**不要**收起、
  保持工具行实时刷新。
- `user/message` 不带该字段（用户消息本来就是一次落库）。

向后兼容：新增字段，老客户端忽略它 → 行为退回修复前（每条 assistant 消息都当结束），不会坏。
`turn.end` 的 `reason` 仍是「这一轮怎么结束的」的唯一权威来源（尤其 `max-tokens`）。

### 一轮怎么结束的（`chat.turn.end` 的 `reason`）

`chat.turn.end` 的 `data` 里带 `reason`，**原样透传**自内核，本插件不解读、不写白名单。

已知四种 `kind`（内核 `turn-error.js` / `turn-max-tokens.js` / `retry.js`）：

| `kind` | 含义 | 客户端该怎么显示 |
|---|---|---|
| `ok` | 正常收尾 | 什么都不用做 |
| `error` | 终局失败（限流/配额/密钥） | 红框；**另有**一帧 `chat.turn.failed` 带 message/code |
| `max-tokens` | **输出撞上限，回答被截断**（已有输出有效） | **黄色警示**，不是失败 |
| `aborted` | 被用户或钩子取消（如登出） | 按取消处理 |

**为什么必须带**：`max-tokens` 既不是失败（所以不会发 `chat.turn.failed`），
也没有第二条通道能告诉客户端 —— 不带上它，客户端收到的帧与「正常跑完」一模一样，
那条「回答被截断」的提示就永远不出现。2026-10-18 真机实测正是这个症状：
电脑端 WebUI 有黄色提示，App 里整条消失。

**向后兼容**：这是**新增字段**，老客户端忽略它、行为不变；未知 `kind` 必须按「不认识就忽略」处理，
**不得**当成失败（内核将来加新 kind 时不能把老客户端吓成红框）。

### 文件卡片（`chat.deliverables.presented`）

智能体用内核 `present` 工具明确交付文件时，前端会收到这条事件，载荷里的 `files` 是
**原样透传**的（客户端读 `path` / `description`，内核以后加字段不用改插件）。

对应的持久事件是 `deliverables/presented` —— 它一直在历史里原样透传（客户端的文件卡片
就是读它渲染的），但**实时**这一路此前被规范化成了一个客户端不认识的名字，
于是新交付物要等到下次消息完成才出现。这条事件补的就是那个**实时性**。

### `seq` 的语义（只有一种）

出网事件里的 `seq` **只表示会话持久事件序号**（内核 `session/event` 的 `event.seq`）——
它是 `beforeSeq` 分页与 `atSeq` 分叉的**坐标**。

**流式片段（`chat.message.delta`）不再带 `seq`**：它没有持久位置，位置信息在 `index`
（本次流内的 chunk 序号，每轮从 0 重新开始）。此前适配层把内核 `assistant-stream` 的
`inner.index` 填进了 `seq`，于是同一个字段名在两条路径上是两种含义 ——
按 `seq` 排序 / 去重 / 分页的消费者会静默错乱，把它当分叉点更会指向不相干的历史位置。

决策、以及「为什么可以安全地不再输出」（逐个核过消费者）见
`docs/project/decisions/ADR-0008-seq-single-meaning.md`。

### 连接即宣告能力（`connection.ready`）

每条被接受的 WebSocket 连接，第一帧都是 `connection.ready`，其 `data` 形如：

```json
{ "bridgeVersion": "2.3.7", "capabilities": ["history-v1", "approvals-v1", "…"] }
```

**请用 `capabilities` 做特性探测，不要硬比 `bridgeVersion`**：能力位回答的是「这台服务端**现在**
能做什么」，而版本号只是它的历史编号（同一版本可能因配置差异关掉某条能力）。
命名规则 `<能力>-v<主版本>`；能力位是**对外承诺**，只增不撤（撤要发新位并把旧的标 deprecated）。

**两类用途，别混淆**：① 某客户端的分支判据（例如姊妹仓 Android App 需要
`approvals-v1` / `questions-v1` 才显示审批与问答卡片，需要 `session-archive-list-v1`
才显示「已归档」入口）；② **对外声明**（回答「这台服务端能做什么」，服务任何客户端，包括第三方）。
**「某个客户端没用到」不等于「这项位没人用」** —— 这一类不是死代码，删掉等于撤回了对外承诺。
完整清单与每项的契约依据见 `src/host/capabilities.ts` 与 `tests/capabilities.spec.ts` ——
后者会拿依据去 OpenAPI/AsyncAPI 里逐条核对，防止「文档说支持、契约里没有」。

**2026-10-28 新增的三个位**（都在 `docs/project/BFF-REST-CONTRACT.md` 里有对应端点）：

| 能力位 | 契约依据 | 运行时降级 |
| --- | --- | --- |
| `attachment-chunked-upload-v1` | `POST /chat/sessions/{sessionId}/attachments/uploads` | 不降级（只依赖本进程的会话与 spool） |
| `chat-schedules-v1` | `GET /chat/schedules`、`POST /chat/schedules` | 内核 typertGateway（schedule Remote）缺席时**不发位**（端点只会 503，发位等于挂一个必然失败的入口） |
| `speech-transcription-v1` | `POST /chat/speech/transcriptions` | **只在 typert Gateway 整体缺席时不发位**；内核没装语音包时仍发位，`GET /chat/speech/catalog` 回 `200 {available:false,reason}` |
| `kernel-endpoint-catalog-v1` | 无 REST 依据（**运行时探测面**） | 内核 Typert 登记表读不到（老内核没有 `typert` 服务）或目录为空时**不发位**；发位即保证目录非空 |
| `kernel-call-v1` | 无 REST 依据（**运行时探测面**） | 通用调用面可用（issue #26 阶段 5）：内核网关与连接服务都在**且**白名单里至少有一条端点在内核目录中；只是目录非空**不发** —— 「能调但每次被拒」比不声明更糟 |

最后一行是有意为之：客户端必须能区分「桥支持语音、但本机没配」（位在、目录
`available:false` → 引导去插件管理装语音包）与「桥不支持语音」（位不在 → 隐藏入口）。
把「没装语音包」也当成不发位，这两种状态就糊成一个了。

**2026-11-21 新增的两个位**（issue IKX1ZM；依据是帧本身，不是 REST 路径）：

| 能力位 | 契约依据（AsyncAPI 帧） | 运行时降级 |
| --- | --- | --- |
| `mobile-queue-v1` | `session-queues` / `queue-update` / `queue-item-updated` | 读（队列快照）只依赖会话投影，始终可用；写（`queue-update`）需要内核 `session/updateQueue` Remote，缺席时回 `unsupported`，读面不受影响。**位照发** —— 「能排队、能不能改队」由 `queue-update` 的错误回答区分 |
| `mobile-goal-activation-v1` | `goals-get` / `goal-updated` | 两者都要内核 `goals` Remote；缺席时回 `unsupported` 并保持 `mobile-goal-read-v1` 的投影读面可用。**位照发**，理由同上：投影读给的是「有没有目标」，activation 只能在真有 Remote 时问到 |

为什么这两位不按「没 Remote 就不发位」处理：它们各自包住**读/写两面**，写在缺 Remote 时本来就有
结构化的 `unsupported` 应答（老内核），把读面也一起藏起来反而让客户端连「队列里有几条」都看不见。

### 历史格式版本（`historyFormatVersion`）

`GET /chat/sessions/{id}/messages` 的响应**总是**带 `historyFormatVersion`（当前 `1`）：
它描述 `events` 里元素的**形状**约定（既不是包版本，也不是内核的 session format）。
只是新增可选字段不升版；改变既有字段含义、把可选变必填、事件改名则**必须**升版。

**本轮只声明、不校验**：客户端带回不匹配的版本，服务端暂不拒绝 —— 强行校验会打断已发布
客户端的 `beforeSeq` 分页（它们不认识这个字段，也就带不对版本）。等客户端开始读它之后再打开
校验（届时返回 `resetRequired`，让客户端重取基线，而不是拿新形状按老规则解析、
拼出一段「看起来正常但内容是错的」历史）。

### 连接即重放（待处理审批）

WebSocket 建立后，插件会把**当前仍待处理**的审批补推给**这一条连接**（只发给它，不广播），
事件形如 `chat.approval.requested`，但多一个 `data.replayed = true`。

为什么需要：「连接后要不要主动查一次 REST」是**每个客户端自己的选择** —— 我方 App 会
（连接成功时刷新历史/审批/提问/命令），但协议不该把「审批不丢」寄托在这一点上。
客户端若只在收到事件时才刷新，重连窗口里产生的审批就会静默消失：
**内核阻塞着等决定，手机上却一片安静**。重放把这件事变成**服务端保证**；
对已经在连接后刷新的客户端，它只是一次幂等冗余。
重放按这条连接的身份**逐会话授权过滤**（别的设备授权过的会话不会推给这台手机）；
客户端按 `approvalId` 去重即可（刷新本身幂等），也可以完全忽略 `replayed` 字段。

**提问侧同样重放**（2026-10-17 同日补齐）：提问不阻塞内核（Agent 已经继续跑），漏掉的代价小一些，
但「卡片不出现、用户以为没问题」同样是坏体验。它走既有事件类型 `chat.userQuestions/requested`，
data 字段与实时路径**一致**（只多 `replayed`）；数据来自适配层的「全部会话挂起表」，
按本条连接的授权逐条过滤。

> 注：提问事件目前由 `normalizeDshEvent` 末段的 `chat.${payloadType}` 兜底产生，
> 因此**尚未进 AsyncAPI 的 schema**（本次未扩：给所有兜底事件补 schema 是独立一件事）。

### 连接级行为与背压（`connection.resyncRequired`）

连接管理参数（真值在 `src/host/server.ts`，AsyncAPI info 描述有同条记录）：

| 行为 | 规则 | 客户端感知 |
|---|---|---|
| 心跳 | 服务端每 30s ping；连续 2 个周期缺 pong 即 terminate（`ws-handler.ts` 的 `startHeartbeat`，与 `/api/v1/events` 的 `startHeartbeat` 各管自己那张连接表） | 正常实现自动回 pong 即可 |
| 连接数 | 默认上限 32（可配置）；**鉴权先于计数**，第 33 条鉴权通过后在 Upgrade 阶段收到 HTTP `429`（`Retry-After: 5`）。`/ws/mobile` 与 `/api/v1/events` **各自计数**（各自 32，互不占用），判定都在 Upgrade 之前做（`server.ts` 的 `handleUpgrade` 两个分支） | 未鉴权请求不消耗名额；429 后退避重连 |
| 帧大小 | 单帧上限 1 MiB，超限 WebSocket close `1009` | 大附件走 REST 上传，不要塞进 WS |
| 发送队列 | 每连接 512 帧；溢出时优先丢可重建的 `chat.message.delta`，状态帧（`chat.turn.*` / `chat.approval.*` / `chat.turn.failed` / `connection.ready`）优先保留。`/ws/mobile` 侧按 kind 判据（`isRebuildableServerFrame`：只有 `event` 可丢 —— 它的载荷都能从 REST 历史与状态重拉，**应答帧一律不丢**） | — |

队列溢出丢帧后，服务端会尽力补发一帧连接级通知（状态帧也塞不进、要 close `1013 Backpressure` 之前也会再发一次）。两个通道拼写不同、载荷相同：`/api/v1/events` 是 `type: 'connection.resyncRequired'`，`/ws/mobile` 是 `kind: 'connection-resync-required'`（后者在队列排空后补发，多次溢出合并成一条，`dropped` 累加）：

```json
{ "id": "<uuid>", "type": "connection.resyncRequired", "time": 1761100000000,
  "data": { "dropped": 12, "reason": "backpressure" } }
```

收到后客户端应改走 REST 重新拉历史与待处理状态（被丢的帧不会重放）；`dropped` 仅用于诊断，
不要按数值做逻辑。老客户端不认识该事件类型，忽略即可，无破坏性。

## 移动端网关 WebSocket (/ws/mobile)

v2.8 新增，**现在是桥的第一协议面**：新能力只在这里落帧（见上文「协议面状态与弃用表」）。独立于 `/api/v1/events`（单向广播，老协议，仅作断线兜底）的双向请求/响应通道，专供移动端客户端，协议形参考上游 `dsh-plugin-mobile-gateway`：连接即推 `hello`，客户端发 `{type: …}` 帧，服务端回 `{kind: …}` 响应帧，并可主动推送 `event` 帧（审批与提问卡片就是 `chat.approval.*` / `chat.userQuestions/*` 载荷，不是专用 kind）。

**帧优先，REST 兜底**：移动端业务（发消息、查历史、选模型、回复审批/提问、执行命令、文件下载）优先走帧；REST `/api/v1` 是老协议，已冻结并逐步下线，只服务未升级的客户端与没有帧等价物的能力（例外表见「协议面状态与弃用表」§3）。两条通道共享同一套设备 token / loopback admin 鉴权与 scope/root/session 授权。

### 端点与鉴权

- 路径：`ws://HOST:PORT/ws/mobile`（挂主 HTTP server 的 upgrade，`PORT` 默认 `3090`）；
  issue #26 阶段 0.2 起**同一个路径也开在隧道专用数据端口上**（同一个 handler 实例，
  鉴权与连接上限完全一致），cloudflared 只指向那个端口 —— 见 §隧道专用数据端口
- 子协议（`Sec-WebSocket-Protocol`）：
  - 首次配对：`dsh-mobile-v1, dsh-pair.<code>`，随请求带 `X-DSH-Device-ID`（必填，安装级稳定标识，仅校验不落库）；可选 `X-DSH-Device-Name`（Base64(UTF-8) 展示名，缺省回退 Device-ID，非法编码同样回退）。成功后服务端推 `paired`（`{kind:'paired', token, device}`），再推 `hello`。
  - 后续连接：`dsh-mobile-v1, dsh-auth.<token>`，或 HTTP 头 `Authorization: Bearer <token>`。
  - **位置无关**（issue #26 阶段 2 起）：服务端从客户端清单里挑**第一个自己认识的**，
    协商结果永远是 `dsh-mobile-v1`。此前要求「首项必须是 `dsh-mobile-v1`」，等于把
    客户端数组的排序当成协议要求 —— 排过序的客户端（把 `dsh-auth.*` 排前面）握手直接被
    4001 掉，手机上只看到「连接被关闭」。清单里一个都没有时行为不变：握手完成后照样
    `close(4001, AUTH_REQUIRED)`。
  - **`dshrb-v1`（issue #26 阶段 5，通用内核调用面）**：客户端清单里提供 `dshrb-v1` 时
    连接启用四个新帧（`kernel-call` / `kernel-call-cancel` / `kernel-call-result` /
    `kernel-endpoints`，见下面两张帧表）。能力面按**客户端声明**的清单判定（`ws-handler.ts`
    的 `offersKernelSubprotocol` 读请求头），握手回给客户端的子协议仍是 `dsh-mobile-v1`。
    已发布 App 的清单里没有它 ⇒ 帧词表与行为**与今天逐字相同**，新帧名不会出现在老连接上。
  - **白名单是唯一执法点**（`src/host/bridge/kernel-allowlist.ts`）：通用调用面只接
    `KERNEL_ALLOWLIST` 里的 23 条 unary 端点，其余一律 `METHOD_NOT_ALLOWED`，且文案与
    「内核根本没这个端点」完全同形（先拒后查目录 —— 让错误码无法当存在性探针）。
    `terminal` / `sandbox` / `dynamicCordisRunner` / `workspaceFiles` / `fileUploads` /
    `settings` / `credentials` / `account` / `liveshareShares` / `cuaAccess` / `forgePanel` /
    `agentTeams` 十二个命名空间**钉死在桥内**，无论内核是否新增端点都不外放。
    每条端点的 scope 与 REST 侧同一份判据（`auth.ts` 的 `requireScope`），**另有第二维**：
    会话类端点（`session/state`、`messageFeedback/*`、`workspace/pin*`）必须通过
    `chat.isSessionAuthorized` —— 内核网关那侧看到的是 owner 主体，它自己的会话过滤恒放行，
    这一维只能由桥来判（见 SECURITY.md 断言 2）。`session/search` 的结果在返回前按同一判据
    过滤（`hasMore` 原样保留，客户端翻页语义不变）。
    执行器跑在 `interactions:'none'` 的 owner peer 上 —— 被脚本化的客户端不能替人点「允许」。
    `kernel-call` 的单次调用有 30 s 硬上限（`call/timeout`），没声明 `cancellation` 的端点
    在 `kernel-call-cancel` 时回 `call/not-found` 而不是假装取消；
    `plugin-install` 可用 `installId` 指定内核的 `options.requestId`，
    `plugin-install-status` 必须带同一个 `installId`（缺了本地回 `BAD_REQUEST`）。
  - 不允许 URL query 带 token，避免令牌进入 URL 日志。
- 配对码：一次性，10 分钟有效期（复用 `/api/v1/pairings/exchange` 产出的 code），256-bit，Base64URL 载荷；设备令牌不过期，撤销即时生效。
- 鉴权：`dsh-pair`/`dsh-auth`/`bearer.<token>` 均复用 `principal()`，与 `/api/v1` 同一套判据；`allowAdmin: true` 允许 loopback admin；连接上限 32（鉴权后计数，Upgrade 前判定，超出回 HTTP `429` + `Retry-After: 5`）。

### 连接即推 hello

每条被接受的连接，第一帧是 `hello`：

```json
{ "kind": "hello", "protocol": 3, "capabilities": [...], "authenticated": true|false, "device": {...}, "port": 3090, "clients": N }
```

`capabilities` 与 `connection.ready` 的能力位同源（见 `src/host/capabilities.ts`），命名 `<能力>-v<主版本>`，只增不撤。

### requestId 关联（请求/应答配对）

请求帧可选带 `requestId`（非空字符串，opaque）。**所有应答帧统一在 `data.requestId` 原样回显它**，包括 `error` 帧——失败也能钉到具体那一个在途请求上。

- 实现只有一处：`MobileGatewayWsHandler.sendFrame` 在 `encodeFrame` 前调 `withRequestIdEcho(frame, this.frameRequestId.getStore())`。各域处理器不必各自复制（少数仍复制，集中注入**不覆盖** `data` 里已有的值）。
- id 走 `AsyncLocalStorage`，不是实例字段：帧分发是并发的（`webSocket.on('message')` 里 `void this.handleMessage(...)` 不 await），共享槽位会串号。
- 不回显的是一次「推送/流式」帧，集合声明在代码里：`REQUEST_ID_ECHO_EXCLUDED_KINDS`（`src/host/ws-protocol.ts`）——`hello` / `paired` / `pong` / `subscribed` / `event` / `approval-resolved` / `speech-state` / `speech-transcript` / `speech-preparing` / `connection-resync-required` / `file-download-chunk` / `file-upload-chunk-accepted` / `kernel-call-result` / `kernel-endpoints`。该表的字面量数组声明为 `readonly ServerFrameKind[]`，写进一个非帧 kind 会编译失败。**新增推送 kind 必须同步该集合**，否则它会带上当时在途请求的 id。其中 `kernel-call-result` 明明是应答却也在表里：它自带客户端铸的 `callId` 做关联，再注入 `requestId` 会出现两条互相矛盾的配对通道；`kernel-endpoints` 则是鉴权通过后主动推送的一次目录快照。
- 请求没带 `requestId`（或带 `""`）⇒ 应答帧里**完全没有** `requestId` 键（不是 `null`、不是 `""`）。
- `data` 不是普通对象（缺省 / `null` / 数组）时不注入。
- `file-resolve`、`file-download-open`、`file-upload-open` 的 `requestId` 是**必填**，缺它回 `error code:'bad-request'`。
- 关联是**按连接**的：两条连接可以复用同一个 id。
- 服务端不发「请求过期」帧，未配对的请求由客户端自己超时。

### 客户端→服务端帧（{type: …}）

| type | 说明 | 关键字段 |
|---|---|---|
| `ping` | 心跳 | — |
| `subscribe` / `unsubscribe` | 事件流会话白名单过滤 | `subscribe`：非空 `sessionId`（可重复订阅多个会话）；缺省未订阅 = 接收所有已授权会话。订阅后只放行这些会话的事件，无 `sessionId` 的全局/文件帧仍放行；紧接着补推该会话待处理审批/提问（`replayed:true`）。`unsubscribe` 恢复全量 |
| `message` | 发消息（sessionId 可选，省略自动创建新会话） | `sessionId?`, `mode:'queue'|'steer'`, `content` (PromptContentPart[]), `clientTimeZone?`, `workspaceId?`, `cwd?` |
| `workspaces` | 列工作区 | — |
| `sessions` | 列会话（按授权过滤） | `archived?` |
| `history` | 分页拉历史 | `sessionId`, `beforeSeq?`, `maxMessages?`, `maxBytes?`（默认 4 MiB）, `view:'conversation'`；**首屏（不带 `beforeSeq`）的响应额外带 `projections`**（与 REST `GET /chat/sessions/{id}/messages` 同源），翻页不带 —— 投影只要一份，而这一帧有 1 MiB 上限 |
| `attachment` | 取附件/图片 base64 | `attachmentId` 或 `sessionId+name` |
| `file-download-open/read/cancel` | 分片下载文件 | open **必带** `requestId`,另带 `sessionId`,`path`（相对会话根，禁 `..`）；read 带 `transferId`,`offset`（严格顺序）；最大 512 MiB，chunk 512 KiB，最大 4 并发，idle 2 min，末块附 `sha256` |
| `file-upload-open/chunk/finish/cancel` | 分片上传文件 | open **必带** `requestId`,另带 `sessionId`,`name`（叶子名）,`size`,`sha256`；chunk 带 `uploadId`,`offset`,`data`（顺序 base64，块 256 KiB）；finish 校验 SHA-256 后经内核附件通道换 `receiptId`；需 `files.write` scope |
| `file-resolve` | 文件预览元数据（不取字节） | **必带** `requestId`,另带 `sessionId`,`path`（相对会话根，禁 `..`）；回 `file-resolved` 带 `{path,name,mediaType,size,modifiedAt}`；非普通文件 `file-not-regular`，超下载上限 `file-too-large`；需 `files.read` |
| `host` | 查主机信息 | — | 回 `{version,dshVersion,cwd,attachedSessions,canOpenPath,defaultProvider?,defaultModel?}`；`cwd` 仅 `os.homedir()`，不回显授权根绝对路径；无 `canOpenWorkspacePath` 通道时 `canOpenPath:false` |
| `default-model` / `save-default-model` | 读/保存默认模型 | `provider`, `model`, `reasoningEffort?` |
| `models` / `providers` | 模型目录与供应商 | — |
| `commands` / `command-options` / `command-select` | 命令目录与通用二级菜单 | `command-options`：`sessionId`、`command`（仅 `model`/`permission`）；`command-select`：再加 `optionId`（model 的 id 为 base64url 的 `[provider,model]`，opaque 原样回传；permission 为档位 value，提交走 `/permission <id>`） |
| `command-execute` | 执行斜杠命令 | `line`, `ui.kind` ('immediate'|'input'|'select'), `source` ('host'|'skill') |
| `select-model` | 切换当前会话模型 | `sessionId`, `provider`, `model`, `reasoningEffort?` |
| `permission-options` / `permission` | 权限档位 | `permission`：`sessionId`、`name`（走官方 `/permission <name>` 命令，不触发模型，回 `{set,commandId,result}`） |
| `context-usage` | token 用量 + 上下文占用投影 | `sessionId`；读会话投影 `tokenUsage`/`contextPressure` |
| `session-stats` | 会话执行统计（输入框统计条） | `sessionId`；读投影 `sessionStats`/`tokenUsage`/`contextPressure` |
| `tasks` / `goal` | 任务列表/当前目标基线（只读会话投影） | `sessionId`；回 `asOfSeq` + `todos`/`goal`，未写入过为 `null` |
| `goal-edit` / `goal-pause` / `goal-resume` / `goal-clear` | 当前目标写操作（compare-and-set） | `sessionId`, `ref:{id,revision}`，edit 另带 `objective?`/`maxGoalRounds?`；代理内核 goals Remote，老内核回 `unsupported` 走 REST |
| `session-queues` | 读当前会话的排队队列（issue IKX1ZM） | `sessionId`；读会话投影 `inbox`（`next-turn`/`next-step` 两个槽位）并归一成 `queue: QueueEntry[]`，**不**走内核 `session/state`（冷会话那里 `queue` 是 `null`）。无会话返回 `SESSION_NOT_FOUND` |
| `queue-update` | 改一条排队项（撤回/改插话/改文本） | `sessionId` + `inboxId`（或别名 `requestId`）+ `action:'remove'\|'steer'\|'edit'`，edit 必带非空 `text`；代理内核 `session/updateQueue`（`{request:{sessionId,itemId,action}}`），成功回 `queue-updated` 带重读的整份 `queue`；内核错误码原样透传（如 `QUEUE_TOO_LATE`/`TURN_ENDED`），老内核回 `unsupported` |
| `goals-get` | 读当前目标**含 activation**（issue IKX1ZM） | `sessionId`（内核侧 `agentId`）；代理内核 `goals/get`，回 `{goal: GoalView\|null, activation:'armed'\|'disarmed'}`。`goal` 投影**故意不含** activation，所以这个能力只能走 Remote；老内核回 `unsupported` |
| `plugin-catalog` / `plugin-inspect` / `plugin-install` / `plugin-settings` | 插件管理（paired 控制连接） | — |
| `agent-presets` / `session-agent-preset` / `select-agent-preset` | Agent 预设 | `agent-presets` 列清单；`session-agent-preset`（`sessionId`+`agentPresetId`，锁定后不可改）与 `select-agent-preset`（`sessionId`+`agentPresetId`，为会话选一个预设）**均已实现**，二者应答都是 `kind:'sent'` + `data.type` 为同名帧（配对应看 `data.type`，别只看 kind） |
| `question-answer` / `question-cancel` | HITL 提问回应 | answer：`callId`/`rpcId`,`answers[]`；cancel：`sessionId`+`rpcId`（上游）或 `callId`（本桥），回 `{kind:'question-response',action:'answer'\|'cancel',accepted}`。cancel 只能作废本桥接管、正阻塞 agent 的前台提问；内核无 continued 提问取消通道 |
| `approval-response` | HITL 审批回应 | `approvalId`, `outcome: 'allowed-once'|'rejected'` |
| `session-create` | 提前建空会话（不发消息） | 两种寻址，与 REST `POST /chat/sessions` 同语义：① `workspaceId`（只认工作区，推荐 —— 客户端不必知道「哪个根 + 相对路径」）；② `rootId?`（缺省取首个授权根）+ `cwd?`（相对根）。另带 `agentPreset?` 与 `reuseBlank?`：`reuseBlank !== false` 时优先复用同路径的空白会话，`false` 则强制新建。响应 `session-created` 带 `{sessionId, rootId \| workspaceId, agentPreset?}`，`agentPreset` 是内核落定后的值（可能被改写），客户端应据此刷新而不是假定自己选的那个生效 |
| `session-cancel` / `session-archive` / `session-rename` / `fork` | 会话生命周期 | `sessionId` |
| `session-wait` | 长轮询会话状态（DSH 0.2.2 `session/wait`，P2-C） | `sessionId`, `timeoutMs?`（1–120000，缺省 30000）, `afterSeq?`, `maxMessages?`（1–200）；应答 `session-waited` 带 `{sessionId, wait:{reason:'idle'\|'input-required'\|'timeout', state, output}}` 原样透传内核结果 |
| `directory-create` / `workspace-create` | 目录/工作区操作 | `directory-create`/`workspace-create`：`rootId?`,`path`（`directory-create` 还可带 `name`），均限授权根内；授权根内浏览用 `file-list` |
| `agent-team` / `subagents` | 智能体团队/子会话目录（只读会话投影） | `sessionId`, `requestId?`（应答回显，见上）；回 `projectionState:'ready'|'unavailable'|'migration-required'` |
| `speech-catalog` / `speech-subscribe` / `speech-unsubscribe` / `speech-configure` / `speech-prepare` / `speech-cancel-preparation` / `speech-transcribe` / `speech-cancel` | 官方语音输入（纯代理内核 speech Remote） | `requestId?`（应答回显；`speech-state` 等推送帧自带的是订阅上下文里那个 id，不跟随本次请求），transcribe 带 `audioBase64`（16k PCM16 WAV，≤4 MiB）、`providerId?`、`language?` |
| `schedule-catalog` / `schedule-list` / `schedule-history` / `schedule-update` / `schedule-delete` | 定时任务（代理内核 schedule Remote，DSH 0.2.2 记录面） | catalog 无会话；其余带 `sessionId`；update 带完整 `expected`+`change`（桥只取 `expected.updatedAt` 做 `expectedUpdatedAt` 乐观并发，`change` 即 `patch.timing`）；回程记录按旧形状呈现（`sessionId` 从内核 `target` 派生，`paused`/`ended` → `inactive`，新字段原样透传） |
| `kernel-call` | 通用内核调用（**仅 `dshrb-v1`**，issue #26 阶段 5；不按业务类目造新帧，端点名走内核描述符） | `callId`（客户端自铸，重试带同一个即按 `(principal,callId)` 幂等回放，24 h）、`endpoint`（内核原名 `namespace/method`，桥不维护第二份端点表）、`args?`（严格按描述符键集，多/漏键本地拒）。回一帧 `kernel-call-result`；授权失败在结果帧 `ok:false`（`METHOD_NOT_ALLOWED`，先于目录查询 ⇒ 不可拿错误码探端点存在性）、`kernel/endpoint-unknown`、`call/in-flight`、`call/cancelled`、端点自身错误。帧形状错回 `error BAD_REQUEST`；清单里没提供 `dshrb-v1` 的连接上不启用（老连接的能力面里没有这帧）；流式端点结果为 `{frames,truncated?}`（默认收 64 帧） |
| `kernel-call-cancel` | 取消一次在飞行中的内核调用（**仅 `dshrb-v1`**） | `callId`；尽力而为 —— 已结算的调用结果帧照样会来，客户端按 `callId` 去重。匹配不到在飞行的调用回 `error code:'call/not-found'`；被取消的那次以结果帧 `ok:false` + `call/cancelled` 结算，且**不进幂等**（重试应真的重试） |
| `plugin-detail` | 读某个插件包的详情（issue #26 阶段 7） | `{name, language?, options?}`；响应为同 kind 帧，`data` 为 `{ok:true, value}` 或 `{ok:false, error:{code,message}}`（+ `requestId` 回显）；需 `settings.*` scope |
| `plugin-install-status` | 查一次安装的进度（`installId` 是 `plugin-install` 返回值里的 id，issue #26 阶段 7） | `{installId}`；响应为同 kind 帧，`data` 为 `{ok:true, value}` 或 `{ok:false, error:{code,message}}`（+ `requestId` 回显）；需 `settings.*` scope |
| `plugin-remove` | 卸载已安装的插件包（issue #26 阶段 7） | `{name}`；响应为同 kind 帧，`data` 为 `{ok:true, value}` 或 `{ok:false, error:{code,message}}`（+ `requestId` 回显）；需 `settings.*` scope |
| `plugin-update` | 更新已安装的插件包（可指定版本，issue #26 阶段 7） | `{name, version?, options?}`；响应为同 kind 帧，`data` 为 `{ok:true, value}` 或 `{ok:false, error:{code,message}}`（+ `requestId` 回显）；需 `settings.*` scope |
| `plugin-versions` | 列某个插件包已发布的版本（issue #26 阶段 7） | `{name, options?}`；响应为同 kind 帧，`data` 为 `{ok:true, value}` 或 `{ok:false, error:{code,message}}`（+ `requestId` 回显）；需 `settings.*` scope |
| `plugin-registries` | 列已配置的插件源（issue #26 阶段 7） | `{}`（无参）；响应为同 kind 帧，`data` 为 `{ok:true, value}` 或 `{ok:false, error:{code,message}}`（+ `requestId` 回显）；需 `settings.*` scope |
| `schedule-create` | 创建定时任务（`request` 原样透传内核 `schedule/create`，issue #26 阶段 7） | `{request}`；响应为同 kind 帧，`data` 为 `{ok:true, value}` 或 `{ok:false, error:{code,message}}`（+ `requestId` 回显）；需 `chat.*` scope |
| `schedule-edit` | 编辑定时任务（`request` 原样透传内核 `schedule/edit`，issue #26 阶段 7） | `{request}`；响应为同 kind 帧，`data` 为 `{ok:true, value}` 或 `{ok:false, error:{code,message}}`（+ `requestId` 回显）；需 `chat.*` scope |
| `schedule-view` | 读单条定时任务（`request` 原样透传内核 `schedule/view`，issue #26 阶段 7） | `{request}`；响应为同 kind 帧，`data` 为 `{ok:true, value}` 或 `{ok:false, error:{code,message}}`（+ `requestId` 回显）；需 `chat.*` scope |
| `schedule-run` | 立刻执行一次定时任务（`request` 原样透传内核 `schedule/run`，issue #26 阶段 7） | `{request}`；响应为同 kind 帧，`data` 为 `{ok:true, value}` 或 `{ok:false, error:{code,message}}`（+ `requestId` 回显）；需 `chat.*` scope |
| `schedule-delete-inactive` | 清理已停用/已结束的定时任务（无参，issue #26 阶段 7） | `{}`（无参）；响应为同 kind 帧，`data` 为 `{ok:true, value}` 或 `{ok:false, error:{code,message}}`（+ `requestId` 回显）；需 `chat.*` scope |

> **阶段 8（issue #26 / MOB-012）删掉的声明**：`search` / `defaults` / `set-default` /
> `directories` 曾经声明在词表里，但只会回结构化 `NOT_IMPLEMENTED`
> （内核没有对应通道，或 `directories` 与「仅授权根可见」的安全模型冲突）。声明一个永远不工作的帧
> 等于把「能力暂缺」当承诺，所以这 4 个名字已从 `ClientFrameType` 与 AsyncAPI enum 删除；
> 再发送它们与拼错帧同路，回 `UNKNOWN_TYPE`。仍声明、但当前连接/内核缺能力的帧（插件族在
> 没协商 `dshrb-v1` 或宿主无 `pluginManager` 时）继续回 `NOT_IMPLEMENTED`。
>
> `queue-update` 当时也在这一批里（内核那时没有队列写通道）；issue IKX1ZM 起内核已有
> `session/updateQueue`，这条帧带着真实现回到词表 —— 该 case 不再是「死声明」，而是能力位
> `mobile-queue-v1` 下的正常帧。

### 服务端→客户端帧（{kind: …}）

| kind | 说明 |
|---|---|
| `hello` | 连接即推（见上）；`port` 为本连接实际接入的本地端口，`clients` 为当前已鉴权连接数 |
| `pong` | 心跳应答（`{at,time}`，同一毫秒时间戳） |
| `subscribed` | 订阅确认 |
| `sent` | 消息已发（应答帧，回显 `requestId`） |
| `workspaces` / `sessions` / `history` | 查询响应（会话搜索没有 WS 通道；`search` 帧已在阶段 8 从词表删除，发送即 `UNKNOWN_TYPE`） |
| `commands` / `command-options` / `command-executed` / `command-selected` | 命令响应；`commands` 另带 `builtinTokens`（0.2.2 一方命令 en/zh 六条）与每条目的 `definitionId`/`builtin`（P2-B） |
| `attachment` / `file-list` / `directory-create` / `file-download-opened/chunk/cancelled` | 附件、目录浏览/建目录（需 `files.write`）与文件下载（chunk 末块带 `sha256`） |
| `file-upload-opened/chunk-accepted/completed/cancelled` | 分片上传（completed 带 `receiptId` 与 `sha256`） |
| `session-cancelled` | 会话取消回执 |
| `session-created` / `session-archived` / `session-renamed` / `session-waited` / `fork` / `workspace-create` | 会话与工作区生命周期（`session-created` 带 `{sessionId, rootId \| workspaceId, agentPreset?}`） |
| `error` | 错误（不回显绝对路径）；**带** `data.requestId` 与 `data.requestType`——前者钉到具体在途请求，后者说明是哪类请求。分发**前**的拒绝（`UNKNOWN_TYPE`/`INVALID_FRAME`/`MISSING_TYPE`）没有 `requestType`（没有处理器可署名）；`UNKNOWN_TYPE` 仍带 `requestId`（若请求给了） |
| `event` | 内部事件透传（与 `/api/v1/events` 同源，受 scope/授权过滤）；推送帧，不带 `requestId` |
| `tasks` / `goal` / `goal-edit` / `goal-pause` / `goal-resume` / `goal-clear` | 任务/目标投影（tasks/goal 读基线，goal-* 为写应答带新 `ref` 或 `cleared:true`）。`goal-clear` 另带 `clearedAt` 与内核返回的墓碑 `ref`（revision = 清除前 + 1）。目标变化现在有推送帧 `goal-updated`（见下），不再要求客户端轮询 |
| `session-queues` / `queue-updated` | 队列读/写的同名应答：`{sessionId, queue: QueueEntry[]}`，`queue-updated` 另带 `accepted:true`。`QueueEntry = {inboxId, requestId, slot:'next-turn'\|'next-step', mode:'queue'\|'steer', text, resendable, sourceKind}`；`text` 是所有 text 块的 `\n` 拼接，`resendable` 表示「内容全是文本、可原样重发」 |
| `goals-get` | 目标 activation 应答：`{sessionId, goal: GoalView\|null, activation:'armed'\|'disarmed'}`（`goal` 为内核视图，自带 activation；无目标时 `null` + `disarmed`） |
| `queue-item-updated` | **主动推送**（整份快照，不带 `requestId`）：`{sessionId, queue}`。时机：一轮 turn 的开始/结束/失败、消息提交、`agent/inbox/spliced`、本地 `queue-update` 成功、以及新订阅时补一次首屏。未订阅的会话不推；内容与上次相同不重复推 |
| `goal-updated` | **主动推送**（整份快照，不带 `requestId`）：`{sessionId, goal, activation, clearedAt?}`。时机：`goal/*` 事件（含 `goal/change`、`goal/activation-changed`）、`goal-*` 写成功、新订阅补首屏。`goal-clear` 之后内核日志追上前读到旧快照时，桥用墓碑（同 id 且 revision ≤ 墓碑）把它压成 `goal:null` 并带 `clearedAt`，客户端不会闪回 |
| `session-stats` / `context-usage` | 会话统计与上下文占用投影响应 |
| `question-response` | HITL 提问回执（`{action, accepted}`）；**主动推送走 `event` 帧**（`chat.userQuestions/*` 载荷），不是专用 kind |
| `approval-response` / `approval-resolved` | HITL 审批回执（outcome `allowed-once`\|`rejected`，不支持始终允许）；**主动推送走 `event` 帧**（`chat.approval.*` 载荷） |
| `paired` / `host` / `models` / `default-model` / `providers` / `permission` / `permission-options` / `agent-presets` | 配对流程与设置面查询/写入应答（`paired` 先于 `hello`，见握手一节） |
| `connection-resync-required` | 反压溢出丢帧后的全量重同步提示（`{dropped, reason}`，多次溢出合并成一条） |
| `agent-team` / `subagents` | 团队/子会话投影响应（随 `projectionState` 与 `asOfSeq`） |
| `speech-catalog` / `speech-subscribed` / `speech-unsubscribed` / `speech-state` / `speech-configured` / `speech-preparing` / `speech-preparation-cancelled` / `speech-transcript` / `speech-cancelled` | 语音输入响应与就绪状态推送；内核无该服务时 catalog 回 `available:false, code:'speech/unavailable'`，其余回 `error` |
| `schedule-catalog` / `schedule-list` / `schedule-history` / `schedule-update` / `schedule-delete` | 定时任务响应；内核无 schedule Remote 时回 `error code:'schedule/unavailable'`，引导 REST 兜底 |
| `schedule-create` / `schedule-edit` / `schedule-view` / `schedule-run` / `schedule-delete-inactive` | 阶段 7 直通帧的**同名应答**：`{request}` 原样交给内核 `schedule/create|edit|view|run|deleteInactive`，`data` 为 `{ok:true, value}` 或 `{ok:false, error:{code,message}}`（+ `requestId` 回显）。错误走结果帧而不是 `error` 帧：这五条是请求-应答，客户端按 kind 找回调 |
| `plugin-catalog` / `plugin-detail` / `plugin-inspect` / `plugin-install` / `plugin-install-status` / `plugin-remove` / `plugin-update` / `plugin-versions` / `plugin-registries` / `plugin-settings` | 插件族**同名应答**（`plugin-settings` 的载荷是 `{name, enabled}`，落点是 `pluginManager/setBundleEnabled` —— **会触发该 bundle 的 reload**；`plugin-install` 可在 `options` 里带 `requestId`/`installId`，`plugin-install-status` 必须带 `installId`，缺参回 `BAD_REQUEST` error 帧）（`plugin-catalog`/`inspect`/`install`/`settings` 四条此前只回 `NOT_IMPLEMENTED`，阶段 7 起为真实现）：请求经 `kernel-allowlist.ts` 的 `KERNEL_FRAME_CALLS` 落到 `pluginManager/*`，与 `kernel-call` 帧共用同一个 `KernelCallService`（默认拒绝 + 同一套设备 scope 判据），`data` 同样是 `{ok, value\|error}` 信封 |
| `kernel-call-result` | 通用内核调用结果（**仅 `dshrb-v1`**）：`{callId, ok, value?, error?{code,message}}`。**不带 `data.requestId`**，按 `callId` 关联（见上面 exclusion 清单）；幂等命中的重试拿到的是上次结果的原样回放 |
| `kernel-endpoints` | 能力目录快照（**仅 `dshrb-v1`**）：鉴权通过后即推一次，内容是「桥白名单 ∩ 内核目录」的 `{endpoint, scope, stream, wires, summary}[]` —— 不是内核全量端点（全量等于把攻击面列给客户端），客户端据此知道能调什么、需要什么 scope、`args` 该带哪些键（`wires` 取自内核描述符，客户端不必硬编码键名）。元素形状由后续阶段冻结，客户端需容忍未知字段与未知端点 |

### HITL（提问与审批）双向

- `question-answer` / `question-cancel`：客户端回应的是 `event` 帧里推送的待处理提问（`chat.userQuestions/*` 载荷）；迟到或非待处理返回 `{accepted:false, reason:'not-pending'|'reply-queued'|'answer-invalid'|'not-answerable'|'unavailable'}`。
- `approval-response`：`outcome` 为 `allowed-once` 或 `rejected`，**v1 不提供永久允许**；已解决、过期或重复决定返回 `APPROVAL_NOT_PENDING` 等价帧。
- 重放：建立后，待处理的审批与提问按本条连接的授权逐条补推（`replayed=true`），客户端按 `approvalId`/`callId` 去重。
- 审批/提问卡片对应 DSH 内部 `chat.approval.*` / `chat.userQuestions/*` 事件，通过 `/api/v1` REST 兜底同步。

### 背压与关闭

与 `/api/v1/events` 同一套参数（单帧上限 1 MiB，发送队列 512 帧，溢出优先丢可重建帧，连续错过 2 个心跳周期 terminate）；设备撤销或授权变更时 `close(4001,'Device revoked')`；`connection.resyncRequired` 通知客户端改走 REST 重取基线。

> 注：`message` 帧图片/文件按 Base64 无 `data:` 前缀传输（同 mobile-gateway），单帧 1 MiB 上限，大附件先走 REST 上传拿回执，再在 WS 消息里用 `file` 部件引用。

### 内核可选服务与 REST 兜底

`agent-team`/`subagents` 只读内核会话投影（`sessionController.projections` 的 `agentTeam`/`subagentCatalog` 键）；`speech-*` 与 `schedule-*` 不自带能力，全部代理内核通过 Typert Remote 发布的 `speech`/`schedule` 服务（插件以宿主 owner peer 代发）。这些服务只在较新内核（DSH 0.2.1-rc.2+ 提供 Gateway；schedule 的 create/edit 自 0.2.2 起才在远程面上）提供；老内核缺服务时：

- `speech-catalog` 回 `{kind:'speech-catalog', available:false, providers:[], code:'speech/unavailable'}`，其余 `speech-*` 回 `error code:'speech/unavailable'`；
- `schedule-*` 回 `error code:'schedule/unavailable'`。

客户端据此走等价 REST `/api/v1/*` 兜底，不把「服务端较旧」误判成「本来没有数据」。

## REST 对等面（语音 / 定时任务 / 分块上传）

`/ws/mobile` 里的 `speech-*`、`schedule-*` 与 `file-upload-*` 三域在 REST 侧有一套**同语义**的
对等端点（契约：[BFF-REST-CONTRACT.md](BFF-REST-CONTRACT.md)）。App 可以先连 WS：连不上、
或该内核没注入对应服务时，退回这里而不是报「功能不存在」。

通用约定：读取侧要 `chat.read`，动作侧要 `chat.write`；错误体与其它 `/api/v1` 端点一致
（`{error:{code,message,requestId,details?}}`）；时间一律 **epoch 毫秒整数**；单条 JSON 体
≤ 32 KiB。错误码复用既有词汇：`BODY_INVALID`(400)、`NOT_FOUND`(404)、`CONFLICT`(409)、
`PAYLOAD_TOO_LARGE`(413)、`SCOPE_REQUIRED`(403)、`UPSTREAM_UNAVAILABLE`(503)。

### 分块上传（大附件）

单条 `POST /chat/sessions/{sessionId}/attachments` 用 base64 一次传完，适合小图；大文件走分块：

| 方法 | 路径 | scope | 说明 |
| --- | --- | --- | --- |
| POST | `/chat/sessions/{sessionId}/attachments/uploads` | `chat.write` | 开票 `{name,size,contentType?}` → `{uploadId,chunkSize,expiresAt,alreadyReceived}` |
| GET | `/chat/sessions/{sessionId}/attachments/uploads` | `chat.read` | 本会话未完成票据 `{items:[…]}`，冷启动续传用 |
| GET | `/chat/sessions/{sessionId}/attachments/uploads/{uploadId}` | `chat.read` | 进度 `{receivedCount,count,missing[]}` |
| PUT | `/chat/sessions/{sessionId}/attachments/uploads/{uploadId}/chunks/{index}` | `chat.write` | 写一块（`application/octet-stream`） |
| POST | `/chat/sessions/{sessionId}/attachments/uploads/{uploadId}/complete` | `chat.write` | 合并落库 → 201 附件视图 |
| DELETE | `/chat/sessions/{sessionId}/attachments/uploads/{uploadId}` | `chat.write` | 丢弃 → 204 |

要点：

- `chunkSize` **由服务端定**（当前 1048576），客户端必须按它切；`index` 从 0 开始。
- 断点续传：同 `name` + 同 `size` 且票据未过期（1 小时）时 `POST` 复用同一 `uploadId`，
  响应里的 `alreadyReceived` 是服务端已收块号——只补发其余块。
- 重复 `PUT` 同一 `index` 幂等（覆盖），所以网络重试安全；块长度必须**精确**（末块可短），
  长度不符 400、超过 `chunkSize` 413、`index` 越界 400、票据不存在/过期/跨会话一律 404。
- `complete` 缺块 → **409** + `details.missing`（块号数组）。补齐后重试即可。成功后票据作废
  （再 `complete` 是 404）。
- `size` 上限 256 MiB，超出 413。

```sh
# 1) 开票
curl -X POST http://192.168.1.20:3090/api/v1/chat/sessions/S1/attachments/uploads \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"clip.mp4","size":3145728,"contentType":"video/mp4"}'
# → {"uploadId":"up_9f3a","chunkSize":1048576,"expiresAt":1761000000000,"alreadyReceived":[]}

# 2) 逐块 PUT（这里是第 0 块）
curl -X PUT http://192.168.1.20:3090/api/v1/chat/sessions/S1/attachments/uploads/up_9f3a/chunks/0 \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/octet-stream" \
  --data-binary @chunk-0.bin

# 3) 合并
curl -X POST http://192.168.1.20:3090/api/v1/chat/sessions/S1/attachments/uploads/up_9f3a/complete \
  -H "Authorization: Bearer $TOKEN"
```

### 定时任务

| 方法 | 路径 | scope | 说明 |
| --- | --- | --- | --- |
| GET | `/chat/schedules?sessionId=` | `chat.read` | 列表 `{items:[Schedule]}`；不带 `sessionId` 列全部 |
| POST | `/chat/schedules` | `chat.write` | 新建 → 201。经典形态 `{sessionId,text,cron,timezone}`；P2-E 新形态 `{text,timing,target?}`（timing 七种内核原样，`target:{kind:'new_once'\|'new',create?}` 由内核建会话；两组互斥） |
| PATCH | `/chat/schedules/{id}` | `chat.write` | 只改传入字段（`enabled`/`text`/`cron`/`timezone`/`timing`）；`enabled` 走内核暂停/恢复（0.2.2），`timing` 与 `cron`/`timezone` 互斥 |
| DELETE | `/chat/schedules/{id}` | `chat.write` | 删除 → 204 |

`Schedule` = `{id,sessionId,text,cron,timezone,enabled,createdAt,lastRunAt,nextRunAt,kind,rrule?,everySeconds?,afterSeconds?}`。
`cron` 是**五段 Vixie**（`minute hour day-of-month month day-of-week`，不支持秒与 `@daily`
之类别名），`timezone` 是 `UTC` 或真实 IANA `Area/Location`；两者不合法都是 **400**
`BODY_INVALID`。会话不存在 404。

与内核的差异（**必须知道**，否则 UI 会撒谎）：

- `createdAt` 自 DSH 0.2.2 起是真实 epoch 毫秒（更早的内核记录面没有该字段 → `null`），
  客户端不要假设它恒为 `null`。
- `kind` 自 P2-E 起必回，取值 `after|at|every|daily|weekly|cron|rrule`：内核的
  `daily`/`weekly` 提醒仍折算成等价 cron 返回；**其余 kind 不再隐藏**——`cron:null`
  + 规则字段（`rrule`/`everySeconds`/`afterSeconds`）原样透出，按真值过滤 `cron` 的
  旧客户端看到的行为不变。`POST`/`PATCH` 也可直接传 `timing`（七种内核原样，P2-E），
  `POST` 可带 `target:{kind:'new_once'|'new',create?}` 让内核在首次投递时建会话
  （此时不查会话可见性，item 的 `sessionId` 为空串）。
- 暂停与恢复（DSH 0.2.2 起）：`PATCH {enabled:false}` 暂停、`{enabled:true}` 恢复
  （从下一个未来发生开始），都回 200 与最新 item。更早的内核没有暂停操作，回 **400** +
  `details.reason:'ENABLED_UNSUPPORTED'`。对已结束的提醒发 `enabled:true` 回 **409** +
  `SCHEDULE_ENDED`（两代内核一致）；目标会话已归档回 **409** + `SCHEDULE_TARGET_ARCHIVED`。
- 新建/修改/删除自 0.2.2 起全部走内核 Remote（`schedule/create`/`schedule/edit`，
  乐观并发用 `expectedUpdatedAt`）；网关缺席仍回 **503** `UPSTREAM_UNAVAILABLE`
  （`details.reason:'gateway/invocation-unavailable'`）。

### 官方语音

| 方法 | 路径 | scope | 说明 |
| --- | --- | --- | --- |
| GET | `/chat/speech/catalog` | `chat.read` | 目录视图，含 `available` 与 `reason` |
| POST | `/chat/speech/transcriptions` | `chat.write` | 转写 `{audio:base64,providerId?,language?}` |
| PUT | `/chat/speech/config` | `chat.write` | 改选中 `{providerId?,language?}`（至少一项）→ 目录视图 |

目录视图：`{available,providers:[{id,name,languages,location}],selected:{providerId,language}|null,
reason,maxAudioBytes,maxDurationSeconds}`。

- **内核没有语音服务时是 200** `{available:false,providers:[],reason:'当前内核未注入语音服务'}`，
  **不是 404**。App 据此隐藏入口即可，别当故障。
- 转写：`audio` 是 base64 WAV（推荐 16 kHz PCM16），**解码后 ≤ 4 MiB**——与 `/ws/mobile`
  同一条硬线，走 REST 不会放宽；超出 **413**。超过 180 s 放弃，上游失败回 **503**
  `UPSTREAM_UNAVAILABLE` + `details.reason`（不回显内核原始消息，它可能含主机路径）。
- 识别到空白是**成功**：`200 {text:""}`，不是错误。`durationMs` 是音频时长，不是推理耗时。

### 与 WS 的关系

两条通道共享同一批纯逻辑（`ws-speech.ts` 的上限与归一、`ws-file-transfer.ts` 的 MIME 推断），
所以上限、`available:false` 的判据、空识别语义三处完全一致。老 App 连新插件不受影响
（全是新增端点）；新 App 连老插件会在这些路径上拿到 **404** `ROUTE_NOT_FOUND`，
此时应隐藏入口而不是重试。

## Android 功能对等矩阵

当前 `v1` 已覆盖设备配对、授权根、文件管理、回收站、工作区发现/创建/重命名/移除、会话列表/创建/重命名/分叉/归档、历史、发消息（含图片与文件附件）、steer、取消、实时事件、Agent Preset、TODO/权限投影、当前会话 host 斜杠命令、待审批查询与允许一次/拒绝、供应商有效配置/凭据状态、自定义供应商、模型发现以及会话模型/推理等级选择。

2026-10 起，原本只走 `/ws/mobile` 的三项也有了 REST 对等面（见上一节）：

| 能力 | REST 状态 | 说明 |
| --- | --- | --- |
| 分块上传（大附件） | **已对等** | `…/attachments/uploads` 六条端点；1 MiB 切片、断点续传 `alreadyReceived`、缺块 409 |
| 定时任务（cron） | **已对等（限 cron 形态）** | 创建/列表/局部改/删除/暂停恢复（0.2.2 起）；一次性、固定间隔与 rrule 提醒不可表达，不在列表出现 |
| 官方语音输入 | **已对等** | 目录/转写/配置；内核无服务时为 200 `available:false` 而非 404 |

以下 DSH WebUI 能力仍有缺口：后台任务（`jobs`）与子会话历史**没有帧**，继续走 REST（例外表 §3）；工作区自定义排序、回收站管理同样只有 REST。会话搜索走 `kernel-call` 的 `session/search`；目标与子代理已有 `goal-*` / `subagents` 帧；消息队列由 `message` 帧的 `mode` 表达，不是独立能力。

App 不得直接调用 DSH 私有 `/api`；确需通用内核调用时只能走 `dshrb-v1` 的 `kernel-call`（23 条白名单 + 12 个拒绝命名空间 + scope 同源，见上文）。每项新能力必须在插件中定义**帧 + 能力位**、对应设备 scope/root/session 授权、脱敏规则、AsyncAPI 帧枚举、Kotlin SDK 和合约测试，才能标记为对等；确实做不成帧的，按例外表登记并写清理由。
