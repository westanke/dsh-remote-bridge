# DSH 0.2.x 兼容性适配说明

> 本文记录一次**下游适配**：在上游 `Hakunm/dsh-workspace` v1.0.0 的基础上，让插件能在
> DSH 0.2.0-rc.2 内核上正常跑起来，并修掉由此暴露出的若干契约缺口。
> 文中所有结论都在真机上实测过，不是推断。

---

## 一、基于什么

| 项 | 值 |
|---|---|
| 上游项目 | `Hakunm/dsh-workspace` |
| 上游版本 | `v1.0.0`（提交 `4c6b1fa`） |
| 适配后的 DSH 内核 | `0.2.0-rc.2` |
| 适配前可用的内核 | `0.1.x`（`@deepseek-ai/dsh-host-apiproxy` 提供 `apiProxy` 服务的最后一版为 `0.1.1-rc.2`） |
| 许可证 | `AGPL-3.0-only`（沿用上游，未更改） |
| 适配分支 | `feat/dsh-0.2-compat` |

---

## 二、为什么必须改

DSH 在 0.2.x 做了一个**破坏性替换**：

```
0.1.x :  @deepseek-ai/dsh-host-apiproxy      →  Cordis 服务名 apiProxy
0.1.2-alpha.3 起 :  @deepseek-ai/dsh-api-gateway  →  Cordis 服务名 typertGateway
```

也就是说，**0.2.x 上没有任何东西再提供 `apiProxy`**。

插件原本在 `cordis.patch.yml` 里声明 `inject: [apiProxy, ...]`。当被注入的服务不存在时，
Cordis 不会报错退出，而是**让该行永远停在 `pending`**——`apply()` 因此从不执行，
插件注册的 HTTP 路由也就从未挂载。

对使用者的表现极具误导性：

- 插件看起来"装上了"（没有报错日志，只有一行 `pending (waiting for service: apiProxy)` 的 warning）
- WebUI 里能打开插件的设置页
- 但只要点"添加根目录"，就返回 **`405 Method Not Allowed`**

因为那条 POST 请求根本没打到插件上，而是落到了宿主内核的默认路由。

> **结论**：这不是"某个功能坏了"，是"整个插件没启动"。必须提供一层 `apiProxy` 兼容实现。

---

## 三、干了什么

### 3.1 总体思路

新增一层桥接（`src/host/dsh-0.2-bridge.ts`），**用 0.2.x 的宿主服务重建出旧版 `apiProxy`
门面**。插件的上层代码（`chat-adapter.ts` / `settings-adapter.ts` 等，共约 1300 行）
因此**一行都不用改**。

桥接层只声明它真正调用的成员，且**不 import 任何 `@deepseek-ai/*` 运行时模块**——
全部使用结构化类型（structural typing），这样插件不会绑定到某个具体内核版本。

### 3.2 改动清单（相对上游 v1.0.0）

| 文件 | 性质 | 说明 |
|---|---|---|
| `src/host/dsh-0.2-bridge.ts` | 新增 | 兼容层：重建 `apiProxy` 门面（25 个方法）+ 事件中继 + 审批桥 |
| `src/index.ts` | 修改 | `inject` 改为 10 个 0.2.x 服务名；用桥接实例喂给两个 adapter |
| `cordis.patch.yml` | 修改 | `inject` 同步为 0.2.x 服务名 |
| `tests/dsh-0.2-bridge.spec.ts` | 新增 | 桥接层契约测试 |
| `src/host/chat-adapter.ts` | 微调 | 命令发现改为可降级（见 3.4 第 10 条） |
| `docs/project/DSH-0.2-COMPAT.md` | 新增 | 本文 |
| `docs/project/CHANGELOG-DEV.md` | 修改 | 追加本次适配条目 |

`inject` 的 10 个服务：`sessionController`、`workspaceController`、`workspaceRegistry`、
`settingsController`、`credentialsController`、`agentPresets`、`llm`、`webServer`、`agents`、`commands`。

### 3.3 桥接层承担的职责

桥接层的职责**不是"转发"，而是"翻译"**。旧版门面的每一条隐式保证，都必须在
0.2.x 上显式复刻一遍，否则会出现"HTTP 200 但功能静默失效"这类最难查的问题。

具体实现了三件事：

1. **门面重建**：把 0.2.x 的调用形状（`SessionAddress` 判别联合、`AsyncIterable` 流、
   异步审批瀑布）翻译成旧版的 `{ rpcId, payload } → { result: { ok, value } }`。
2. **事件中继**：0.2.x 没有进程级会话事件流，durable 事件与 assistant 流增量都只能
   **按会话** `follow()` 拿到。桥接层为每个 *运行中* 的会话维持一个订阅，再扇出成
   插件期望的单一 `session/event` 流。
3. **审批桥**：0.2.x 通过 Cordis 瀑布 `approval/request` 询问审批。桥接层认领该瀑布，
   改发 `approval/requested` 给客户端，等客户端答复后再调用 `next()` 决定是否放行；
   无人应答时委托给下一个 answerer，不会把审批卡死。

### 3.4 逐项修复的契约缺口

适配过程中暴露出 **10 处**缺口。它们的共同特征是**不抛错**——要么返回 200 但内容为空，
要么字段缺失导致客户端严格解码失败。逐一列出，便于后人对照排查：

| # | 缺口 | 表现 | 处理 |
|---|---|---|---|
| 1 | `chat/agent-presets` 缺 `trust` | 客户端报 `Field 'trust' is required ... missing at path: $.items[0]` | 桥接层补 `trust: 'system'`（0.2.x 已移除 system/user 二分） |
| 2 | `chat/sessions/:id/models` 缺 `current` / `routable` | 报 `Fields [current, routable] are required ... missing at path: $` | 从会话投影 `modelSelection` 取 `pending ?? lastUsed ?? catalog.default`；`routable` 由 `routableProviders` 推导；`failures` 字段名映射 |
| 3 | `chat/sessions/:id/messages`（history）恒为空 | **HTTP 200 但 `events: []`** | 改用 `follow()` 的首个 `snapshot` 帧取 `records`。`page()` 要求 `throughSeq` 取自该帧，硬编码 `-1` 会返回结构合法但内容为空的页 |
| 4 | 冷会话命令发现失败 | `409 COMMANDS_UNAVAILABLE: could not be activated` | 0.2.x 中激活 Agent 的正路是 `resolveAgent()`（`agents.get()` 只读不激活），在读取模型时顺带激活 |
| 5 | 实时流式输出缺失 | 回复不流式，要等整条消息提交后才整段出现 | 新增 `SessionEventRelay`：按会话 follow 并转发增量帧 |
| 6 | `api-session/status` 参数误读 | 会话运行状态事件全部丢失 | 该事件签名是 `(sessionId, running)`，第一个参数**是裸 id 不是对象**，不可当作 summary 解析 |
| 7 | 事件名不符 | 状态事件落进兜底分支 | 插件 normalizer 认的是 `host/session-status`（连字符），不是 `session/status` |
| 8 | `agent-preset/selected` 未转发 | 切换 Agent 预设不同步 | 监听该 Cordis 事件，转成 `host/remote-event` 帧 |
| 9 | 流式帧根本没产生 | 第 5 项修好后仍无增量 | `follow()` 的 `assistantStream` 是 **opt-in**，不传 `assistantStream: true` 宿主不产生任何增量帧 |
| 10 | 内部会话混入列表并报 409 | 「个别会话」打开命令菜单报 409 | 0.2.x 的 `list()` 会返回 subagent 拥有的会话，而 `resolveAgent()` **按设计拒绝激活**它们。两头处理：列表过滤 `origin === 'subagent'`；命令发现无法激活时**返回空列表**而非报错（执行命令仍报错，因为真的需要 Agent） |

> 第 6、7、9 项是**适配过程中自己引入/遗漏**的问题，一并记录在此，作为"桥接层不能想当然"的例证。

---

## 四、测了什么

### 4.1 单元测试

```
pnpm test        →  42 passed (13 files)
npx tsc --noEmit →  0 error
```

新增的桥接契约测试覆盖：审批瀑布的认领与委托、`trust` 默认值、
模型目录与会话投影的折叠、`pending` 优先于 `lastUsed`、
history 走 follow 开场帧（且忽略其后的实时帧）、
`api-session/status` 的 `(sessionId, running)` 签名、子 agent 会话过滤、
命令发现的可降级行为、订阅在运行结束后释放。

### 4.2 隔离环境验证

在独立的 `DSH_HOME`（独立 profile、独立端口）中安装真实 tarball 后验证：

- 添加根目录返回 **201**（适配前为 **405**）
- 8/8 接口返回 200：`healthz`、`manage/status`、`manage/roots`、`chat/workspaces`、
  `chat/sessions`、`chat/agent-presets`、`settings/models`、`settings/providers`
- 文件浏览 / 读取 / 写入正常
- 会话创建返回 201（拿到真实 session id）
- 历史记录正常返回

### 4.3 真实设备验证

使用真实配对令牌（含 `chat.read/write`、`files.*`、`settings.*` 全部 scope）：

- 8/8 接口 200
- 验证完成后**立即吊销该探针设备**，不长期留存凭据

### 4.4 端到端实测（关键）

写了一个 WebSocket 探针复现真实客户端行为，**订阅事件流的同时发一条真实消息**，
统计收到的帧类型：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| `chat.message.delta` | **0 帧** | **11 帧** |
| 累积流式文本 | （空） | `"收到"` |
| `chat.session.status` | 事件被丢弃 | 1 帧 |
| `chat.session.event` | 11 帧 | 17 帧 |
| `chat.message.committed` | 5 帧 | 5 帧 |

> **教训**：第 9 项缺口（`assistantStream` opt-in）在 42 项单测全绿、`tsc` 干净、
> 产物校验通过的情况下依然存在。单测能证明"拿到帧之后处理得对"，
> 证明不了"帧会不会来"。**验证链条必须是三段：单测 → 打包装入 → 真实端到端。**

### 4.5 全量会话探测

适配完成后的收口验证（在 70 个真实会话上逐个调用命令发现）：

| 指标 | 值 |
|---|---|
| 会话总数 | 75 → **70**（滤除 5 个 subagent 内部会话） |
| 仍含 subagent | **0** |
| 命令发现：正常 / 空列表（已降级）/ 报错 | 67 / 3 / **0** |

---

## 五、已知边界

- **不修改插件的公开接口**：`docs/api/openapi.yaml` 与 `asyncapi.yaml` 描述的契约保持不变，
  本次改动是把实现对齐到该契约。
- **不修改许可证**：仍为上游的 `AGPL-3.0-only`。
- **不 import 内核运行时模块**：桥接层只用结构化类型，降低未来内核变动时的耦合。
- **第 10 项的两层处理是互补而非冗余**：`origin` 标记在部分历史会话上可能缺失，
  所以过滤之外还有降级兜底。若未来内核为所有 subagent 会话都补全标记，过滤层即可单独生效。

---

## 六、如何复现验证

```bash
# 1) 类型检查与单元测试
pnpm install
npx tsc --noEmit
pnpm test

# 2) 打包并在隔离环境安装
pnpm build && pnpm pack
# tarball 名随包名与版本变化（2.0.4 起包名为 dsh-remote-bridge），用通配而非写死具体名字
DSH_HOME=/path/to/scratch dsh plugin --profile <name> add ./dsh-remote-bridge-*.tgz

# 3) 端到端流式验证（需先配对取得 token 与一个 sessionId）
#    探针脚本见适配分支的 .e2e.mjs
```

---

## 七、上游合并建议

本适配**只增不删**：新增 1 个源文件与 1 个测试文件，改动 3 处配置/接线，
且不触碰插件的公开接口与许可证。对上游的价值在于：

1. 让插件在 **0.2.x 内核**上可用（当前 0.2.x 上插件完全无法启动）；
2. 桥接层用结构化类型实现，**对 0.1.x 无副作用**——若上游希望同时支持两个内核，
   这层可直接沿用；
3. 第 3.4 节的 10 项清单可作为 0.2.x 迁移的对照表，节省后来者重复摸索的时间。

若上游选择不合并，本分支也可作为独立的下游兼容分支长期维护。
