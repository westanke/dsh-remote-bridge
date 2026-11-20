# BFF REST 契约 v1 —— 语音 / 定时任务 / 分块上传

> **状态：老协议 / 迁移中（2026-11-20 起）**。桥的第一协议面是 `/ws/mobile` 的双向帧；
> 本文描述的 REST 对等面只作**回落**，3.0.0 之前迁到帧。逐端点弃用表见
> [API.md](API.md) 的「协议面状态与弃用表」，规则见 [AGENTS.md](../../AGENTS.md) §1.1。
>
> 下文「App 只消费 `/api/v1`、不得直连 `/ws/mobile`」是 2026-10 的立场，**已作废**：
> 现在客户端先帧、后 REST，只有连不上 WS 或对端回 `NOT_IMPLEMENTED` 才回落。

> **这份文件的地位**：它是 `/ws/mobile` 网关里三项「手机端独有能力」的 **REST 对等面**，
> 由 App（`dsh-companion`）与插件两侧**共同实现**。任何一侧要改路径、字段或错误码，
> 必须先改这里，再改两侧代码 —— 它是跨进程契约，不是某一侧的内部设计。
>
> 依据：`docs/project/API.md` 的「Android 功能对等矩阵」——**App 只消费 `/api/v1` 下的
> 稳定 REST/事件契约**，不得直连 `/ws/mobile` 或内核私有接口。此前这三项能力只有
> `/ws/mobile` 帧（`src/host/ws-speech.ts` / `ws-schedule.ts` / `ws-file-transfer.ts`），
> 于是 App 侧 `PARITY.md` 一直只能写「缺失 / 等待 BFF」。本契约就是那份 BFF。

## 0. 通用约定

| 项 | 值 |
|---|---|
| 前缀 | `/api/v1` |
| 认证 | 与其它端点相同：`Authorization: Bearer <device token>` |
| 错误体 | `{ "error": { "code", "message", "requestId", "details"? } }`（与本仓既有端点一致） |
| 错误码 | 复用既有：`BODY_INVALID`(400) / `NOT_FOUND`(404) / `CONFLICT`(409) / `PAYLOAD_TOO_LARGE`(413) / `SCOPE_REQUIRED`(403) / `UPSTREAM_UNAVAILABLE`(503) |
| 时间 | 一律 **epoch 毫秒整数**（`1717000000000`），不传 ISO 字符串 —— 与 `/jobs`、`/history` 的写法一致 |
| 大小上限 | 单条 JSON ≤ 32 KiB；分块 PUT ≤ 1 MiB + 4 KiB |

**为什么全部要 `chat.write`**：这三项都能让内核**动起来**（转写会调模型、定时任务会在未来
自己发消息、上传会把字节落到会话里），语义与「发一条消息」同级。读取侧（catalog / 列表）
要 `chat.read`，与 `GET /commands`、`GET /jobs` 一致。

---

## 1. 分块上传（对齐 `ws-file-transfer.ts` 的 `file-upload-*` 帧）

大文件走「开票 → 逐块 PUT → 收尾」，替代现在 `POST /attachments` 的单条 base64 ——
后者一条 JSON 装下整个文件，24 MB 上限在 base64 膨胀后实际只能传 ~18 MB，且中途失败要整条重传。

### 1.1 开票

```
POST /api/v1/chat/sessions/{sessionId}/attachments/uploads
{ "name": "recording.m4a", "size": 104857600, "contentType": "audio/mp4" }
→ 201 { "uploadId": "up_9f3a…", "chunkSize": 1048576, "expiresAt": 1717003600000, "alreadyReceived": [] }
```

- `size` 必填且 `1 ≤ size ≤ 256 MiB`；超出 → `413 PAYLOAD_TOO_LARGE`。
- `chunkSize` 由服务端定（`1048576`），客户端**必须**按它切块，不要自己算。
- `alreadyReceived` 用于断点续传：同 `name` + 同 `size` + 未过期的同会话上传会被复用
  （返回同一个 `uploadId` 与已收块号），避免重传。
- `uploadId` 不透明，客户端不得解析；有效期 1 小时（`expiresAt`）。

### 1.2 上传一块

```
PUT /api/v1/chat/sessions/{sessionId}/attachments/uploads/{uploadId}/chunks/{index}
Content-Type: application/octet-stream
<二进制，长度 ≤ chunkSize（末块可短）>
→ 200 { "uploadId": "up_9f3a…", "received": 7, "count": 100 }
```

- `index` 从 **0** 开始；重复 PUT 同一块**幂等覆盖**（重试安全）。
- 长度超 `chunkSize` → `413`；`index` 越界 → `400 BODY_INVALID`；`uploadId` 不存在/过期 → `404 NOT_FOUND`。

### 1.3 收尾

```
POST /api/v1/chat/sessions/{sessionId}/attachments/uploads/{uploadId}/complete
→ 201 { "id": "att_…", "name": "recording.m4a", "size": 104857600, "contentType": "audio/mp4" }
```

返回体与既有 `POST /chat/sessions/{id}/attachments` 的附件视图**同形**（App 用同一套解析）。
缺块 → `409 CONFLICT`，`details.missing = [3, 4]`，客户端补齐后重试即可。
完成后 `uploadId` 失效，再次 complete → `404`。

### 1.4 查询 / 取消

```
GET    /api/v1/chat/sessions/{sessionId}/attachments/uploads/{uploadId}
→ 200 { "uploadId", "name", "size", "chunkSize", "receivedCount", "count", "expiresAt", "missing": [] }

DELETE /api/v1/chat/sessions/{sessionId}/attachments/uploads/{uploadId}
→ 204
```

---

## 2. 定时任务（对齐 `ws-schedule.ts`）

### 2.1 列表

```
GET /api/v1/chat/schedules?sessionId={id}
→ 200 { "items": [ {
    "id": "sch_…",
    "sessionId": "sess_…",
    "text": "每天早上汇总一次 CI 结果",
    "cron": "0 8 * * *",
    "timezone": "Asia/Shanghai",
    "enabled": true,
    "createdAt": 1717000000000,
    "lastRunAt": 1717084800000,
    "nextRunAt": 1717171200000,
    "kind": "cron"
  } ] }
```

`sessionId` 可选；缺省返回全部（App 的「定时任务」页需要跨会话看）。

> **视图表达力**（对齐 `bff-schedule.ts` 文件头）：内核有 after / at / every / daily /
> weekly / cron / rrule 七种计时。**P2-E（DSH 0.2.2）起全部回**：item 恒带
> `kind`（七种之一）；daily/weekly 折算成等价五段 cron，其余 kind 回 `cron:null`
> + 规则字段（`rrule` / `everySeconds` / `afterSeconds`）—— 折算成会重复的 cron
> 是更坏的错，宁可让旧客户端按真值过滤 `cron` 后看到的集合不变。
> `createdAt` 自 DSH 0.2.2 起回真实 epoch 毫秒（更早的内核记录面没有该字段 → `null`）。

### 2.2 新建

```
POST /api/v1/chat/schedules
{ "sessionId": "sess_…", "text": "…", "cron": "0 8 * * *", "timezone": "Asia/Shanghai" }
→ 201 <同 2.1 的 item>
```

- `text` 长度 1..8000；`cron` 为标准五段 Vixie 表达式（与 App 内 UI 一致）；
  `timezone` 必须是 IANA 名，非法 → `400 BODY_INVALID`。
- 会话不存在 → `404 NOT_FOUND`。
- **P2-E 新形态**（additive）：`{ "text": "…", "timing": {…内核七种原样…},
  "target"?: { "kind": "new_once" | "new", "create"?: { "cwd"?, "agentPreset"? } } }`。
  `timing` 与 `cron`/`timezone` 互斥、`target` 与 `sessionId` 互斥（都 400，桥先拒）；
  `target` 存在时不做会话可见性检查 —— 会话由内核在首次投递时创建，item 的
  `sessionId` 为空串。`timing` 内部字段由内核校验，不合法 → `400 BODY_INVALID`
  （`details.reason` 带内核 `ScheduleInputErrorCode`）。

### 2.3 改 / 删

```
PATCH  /api/v1/chat/schedules/{id}   { "enabled"?: bool, "text"?: string, "cron"?: string, "timezone"?: string, "timing"?: {…} }
→ 200 <item>

DELETE /api/v1/chat/schedules/{id}
→ 204
```

`PATCH` 只改传入的字段；显式 `"enabled": false` 是暂停，不是删除。
`timing`（P2-E）整体替换计时原样透传，与 `cron`/`timezone` 互斥（400）。

> **暂停与恢复**（DSH 0.2.2 起）：内核 `edit` 支持 `patch.active`，桥把 `enabled`
> 双向映射过去 —— 暂停 `enabled:false`、恢复 `enabled:true` 都回 200 与最新 item
> （恢复从下一个未来发生开始）。已经 `ended` 的任务恢复 → `409 CONFLICT`，
> `details.reason = "SCHEDULE_ENDED"`。内核拒绝输入（`schedule/input-invalid`）→
> `400 BODY_INVALID`，`details.reason` 带内核的结构化错误码；目标会话已归档
> （`schedule/target-archived`）→ `409 CONFLICT`，`details.reason = "SCHEDULE_TARGET_ARCHIVED"`。
> 更早的内核没有暂停操作，`enabled:false` 回 `400`（`details.reason = "ENABLED_UNSUPPORTED"`）。

---

## 3. 官方语音输入（对齐 `ws-speech.ts`）

App 侧不做流式识别：录一段（16 kHz 单声道 PCM16，封装成 WAV）再整段提交。
理由：REST 无双向流，而「按住说话 → 松手出字」是手机语音输入的真实交互；
流式只对「边说边出字」有意义，那属于 `/ws/mobile` 的体验，不在本契约范围。

### 3.1 目录

```
GET /api/v1/chat/speech/catalog
→ 200 {
  "available": true,
  "providers": [ { "id": "builtin", "name": "内置语音", "languages": ["zh-CN", "en-US"] } ],
  "selected": { "providerId": "builtin", "language": "zh-CN" },
  "reason": null            // available=false 时给一句人话，直接展示给用户
}
```

内核没有 speech 服务时返回 `200 { "available": false, "providers": [], "reason": "当前内核未注入语音服务" }`
—— **不要 404**：客户端要把「服务不可用」和「路由不存在」区分开（后者才该退版本）。

### 3.2 转写

```
POST /api/v1/chat/speech/transcriptions
{ "audio": "<base64 WAV>", "language": "zh-CN", "providerId": "builtin" }
→ 200 { "text": "帮我看一下今天的 CI", "providerId": "builtin", "language": "zh-CN", "durationMs": 2400 }
```

- 音频解码后 ≤ **4 MiB**（与 `ws-speech.ts` 的 `MAX_AUDIO_BYTES` 一致），超出 → `413`。
- 服务端超时 **180 s**（同 WS 侧 `TRANSCRIPTION_TIMEOUT_MS`）；上游失败 → `503 UPSTREAM_UNAVAILABLE`，
  `details.reason` 给一句人话。
- 空识别结果返回 `200 { "text": "" }`，**不是错误** —— 用户可能就是没说话。

### 3.3 配置

```
PUT /api/v1/chat/speech/config
{ "providerId"?: "builtin", "language"?: "zh-CN" }
→ 200 <同 3.1 的 catalog 视图>
```

---

## 4. 两侧各自的验收

**插件侧（本仓）**
- `docs/api/openapi.yaml` 补全以上全部路径与 schema；`docs/project/API.md` 加一节。
- 合约测试：`tests/bff-rest.spec.ts` —— 覆盖鉴权（缺 scope → 403）、缺块 complete → 409、
  超限 → 413、幂等 PUT、断点续传复用 `uploadId`、`available:false` 形状。
- `npm run check`（typecheck + test + docs:check + build）必须绿。

**App 侧（`dsh-companion`）**
- `data/DshClient.kt` 加对应方法（唯一网络边界）；`data/Models.kt` 加可反序列化模型。
- 每个新端点都要有 fixture 单测，且**缺字段时不崩**（老 bridge 没有这些路由 → 404，
  客户端要退化成「该入口隐藏」，不能整页报错）。
- `PARITY.md` 对应行从「缺失 / 等待 BFF」改为实际状态。

> **兼容性**：本契约是**新增**，不改动既有端点。老版本 App 连新插件、新 App 连老插件
> 都必须正常工作 —— 新 App 遇到 `404 NOT_FOUND` 就隐藏对应入口，这条要有测试钉住。
