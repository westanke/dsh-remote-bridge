# API 使用说明

公开接口基址为 `http://HOST:PORT/api/v1`。`PORT` 默认是 `3090`，可由 DSH 设置里「手机设置 → 远程访问」修改。完整 schema 见 [OpenAPI](../api/openapi.yaml) 和 [AsyncAPI](../api/asyncapi.yaml)。

绑定设置接受本机数值 IPv4/IPv6 地址，例如 `0.0.0.0`、`192.168.1.20` 或 `::`；它不接受域名。绑定 `0.0.0.0` 后，客户端仍可使用解析到该服务器的域名连接。监听配置属于回环管理 API，不是对外 `/api/v1` 契约的一部分。

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
| `deviceName` | 设备名（写进 `devices` 表，便于日后吊销），缺省 `Android 设备` |
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

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/manage/cloudflare/status` | 当前隧道状态：`{ channel, url, running, error? }`。未启动时 `running:false`、`url:null` |
| `POST` | `/manage/cloudflare/create` | 查/建 `cloudflared` 可执行文件并启动 **Quick Tunnel**（转发到配置的监听端口，常为 `3090`），响应 `201` 返回与 `status` 同构的状态 |
| `POST` | `/manage/cloudflare/stop` | 停止当前隧道，返回 `200` 与状态 |
| `GET` | `/manage/cloudflare/activity` | 创建期间的阶段进度（用户侧用它轮询画进度条）：`{ stage, label, percent }`；`create` 结束即清空 |

`create` 会先下载缺省的 `cloudflared`（官方 GitHub Release，版本 `CLOUDFLARED_VERSION`；
可用环境变量 `CLOUDFLARED_MIRROR` 指定下载镜像），随后 `spawn cloudflared tunnel --url http://127.0.0.1:<port>`，
并从 stdout 里用正则抓取 `https://<host>.trycloudflare.com` 形式的对外地址。

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

`PUT /chat/sessions/{sessionId}/agent-preset` 可重新组合空白会话的 Agent Preset。DSH 只允许在第一条消息被接受前切换；会话开始后返回 `409 AGENT_PRESET_LOCKED`，客户端应展示当前 Agent 但禁用切换。

`GET /chat/permission-presets` 返回可选权限档位清单（`options` 与部署默认 `defaultPreset`），scope 与 agent-presets 同为 `chat.read`。

**为什么必须单开一条**：内核把预设清单放在**独立的远程服务** `permissionPresets.catalog()` 上，而会话投影里那条 `permissions` wire 视图**只产 `currentValue`**（`wire.view: state => ({ currentValue })`）。两者没有任何交叉引用，客户端能读到「当前档位」却列不出候选 —— Android 客户端 v2.2.44 的权限档位 Pill 与 ⋯ 菜单权限项因此在真机上**从不渲染**（PARITY 上当时误标为 `done`）。候选不在投影里，所以插件必须自己透出来；清单是**进程级**的，客户端连上时取一次即可。形状由 `normalizePermissionCatalog` 收敛：丢弃没有 `value` 的行、`name` 缺失时退回 `value`、空串 `description` 不透传（否则客户端会渲染出一行空白副标题）。

**降级行为（重要）**：`ctx.permissionPresets` 在部分 profile 上**不可注入**（实测 2026-10-19 抛 `cannot get property "permissionPresets" without inject`）。按本仓既定结论，该异常的含义是「**压根没有**这个可注入服务」，而非「加载时机不对」—— 旁证是内核这条能力本身在工作（`/permission` 命令可列出、投影 `permissions.currentValue` 有值），只是没挂进本插件的注入面，因此**装包并不能解决它**。

所以这条端点**容错读取**：服务不可用时返回**内核默认档位**（`workspace-write` / `danger-full-access`，取值依据是内核 `Config` 的 `.default({...})`），客户端菜单因此仍可用；且**服务缺席不会让端点报错**（一个可选能力缺席不该毁掉整个权限入口）。**代价**：真部署若自定义过 `presets`，这份降级清单就不全 —— 它只是兜底，权威来源永远是 `permissionPresets.catalog()`。`read-only` 虽然合法（在 `SANDBOX_MODES` 里），但内核**没有为它配 preset**，而 `/permission <preset>` 切的是 preset 名，故**不**放进降级清单（放进去等于给客户端一个点下去必然失败的选项）。

`GET /chat/sessions/{sessionId}/commands` 列出 DSH host 为当前会话实际注册的斜杠命令、说明和可选参数提示；`POST` 同一路径以 `{ "line": "/permission workspace-write" }` 执行命令。执行要求 `chat.write` 及对应 session/root 授权，命令必须存在于当前列表中，并直接进入 DSH command registry，不会退化为普通模型消息。审计仅记录命令名，不记录可能敏感的参数。

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

判据：`Host` 必须回环、拒绝跨站请求、文件名必须匹配内容哈希白名单、扩展名声明必须与魔术字节一致、体积上限 32 MiB。取不到一律 `404`，且不区分「会话不存在」与「文件不存在」。

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

该端点与其它 REST 端点同一套鉴权（设备 token 或 loopback admin）—— 它暴露宿主内部结构，不该对局域网裸奔。采集发生在插件 `apply` 期间，因为注入属性只在那一刻可读。

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

## 事件

WebSocket 地址为 `ws://HOST:PORT/api/v1/events` 或 `wss://...`。OkHttp 等原生客户端在 Upgrade 请求中发送 `Authorization: Bearer <token>`；浏览器客户端可使用 `bearer.<token>` 子协议。query string token 不受支持，避免令牌进入 URL 日志。

`file.*` 事件要求实时 `files.read` scope，`chat.*` 事件要求实时 `chat.read` scope，并继续检查对应 root/session 授权。授权更新或撤销无需重连即可对后续事件生效；断线后客户端通过 REST 刷新状态，不依赖无限事件回放。

DSH 的 `assistant/chunk` 不直接泄漏为私有 wire。插件将文本和思考 token 规范化为 `chat.message.delta`，载荷包含 `sessionId`、`turn`、`step`、`index`、`kind` 和 `text`；完成的用户/助手消息发送 `chat.message.committed`，客户端随后读取 REST 历史收口。运行状态、Agent 切换和审批变化分别使用 `chat.session.status`、`chat.agent-preset.selected` 与 `chat.approval.*`。

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

## Android 功能对等矩阵

当前 `v1` 已覆盖设备配对、授权根、文件管理、回收站、工作区发现/创建/重命名/移除、会话列表/创建/重命名/分叉/归档、历史、发消息、steer、取消、实时事件、Agent Preset、TODO/权限投影、当前会话 host 斜杠命令、待审批查询与允许一次/拒绝、供应商有效配置/凭据状态、自定义供应商、模型发现以及会话模型/推理等级选择。以下 DSH WebUI 能力尚未进入稳定外部契约：会话搜索、附件与队列、通用问题回答、工作区自定义排序、归档恢复、目标、子代理、技能和后台任务。

App 不得直接调用 DSH 私有 `/api` 或通用 RPC 透传。每项缺失能力必须在插件中定义稳定 REST/事件 schema、对应设备 scope/root/session 授权、脱敏规则、OpenAPI/AsyncAPI、Kotlin SDK 和合约测试后才能标记为对等。
