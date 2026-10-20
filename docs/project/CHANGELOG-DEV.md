# 开发日志

## 未发布 · 推送拓扑改为「国内源为主」（2026-10-20）

### 基于什么

姊妹仓 dsh-companion 2026-10-16 起就是「Gitee 主 + AtomGit 备 + GitHub 从站自动同步」，
本仓却一直是手工推三站。本轮发版实测到本机到 github.com:443 **长期被阻断且间歇性**：
`Empty reply from server`、`TLS handshake failed: The TLS connection was
non-properly terminated`，重试 4~6 次才成功一次；改走 `gh api` 通道则稳定。

### 干了什么

- 新增 `scripts/push-all.sh`：推 Gitee（主）+ AtomGit（备），GitHub 不再手工推。
  参数与姊妹仓同名脚本一致（`PUSH_TAGS` / `PUSH_ALL_TAGS` / `BRANCH` / `FORCE` /
  `INCLUDE_GITHUB`）。tag 逐个推并逐个判断「远端已有则跳过」——
  不用 `git push --tags`（任意一个旧 tag 冲突就会整条被拒）。
- 新增 `scripts/setup-remotes.sh`：整理三远端命名（幂等）。
- 新增 `.github/workflows/mirror-sync.yml` + `scripts/ci/mirror-push.sh` +
  `scripts/ci/sync-releases.py`：GitHub 作为**从站**，每 3 小时从 Gitee 自动同步
  refs（`push --mirror`）与 Release（正文 + tgz/SHA256SUMS）。自举段内嵌在
  workflow 里（空仓首次运行时还没有 `scripts/ci/`）。
- `scripts/release.sh` 第 4 步改为复用 `scripts/push-all.sh`，**不再重写一遍推送逻辑**
  —— 两处各写一份必然分叉（姊妹仓就出过「分支与 tag if/else 互斥，只推了一半」的 bug）。
- `scripts/release.sh` 建 Gitee Release 改用 **form 字段**传 `access_token`
  （此前是 query + JSON body，实测一律 40001「登录失效」）。

### 测了什么

- `scripts/push-all.sh` 实跑：Gitee 与 AtomGit 分支均推成功；`PUSH_TAGS=1` 时
  正确提示「没有要推的 tag —— 指向 HEAD 的 tag 为空」而不是静默跳过。
- 四个新脚本全部过 `bash -n`；workflow 过 YAML 解析（jobs: mirror / releases）。
- 门禁：tsc 干净；vitest 42 文件 / 345 用例全绿；docs:check 三段全过。

### 待办

- **GitHub 从站的 `MIRROR_PAT` secret 需仓库管理员配置**（带 repo + workflow scope 的
  PAT，与姊妹仓 dsh-companion 同名 secret 同规格）。缺它时 workflow 会在
  `git push --mirror` 前报「MIRROR_PAT 未配置」——主源探测与克隆都是成功的，
  只是推回 GitHub 时没凭据。
- 配好 secret 后触发一次 workflow：它会用 Gitee 覆盖 GitHub，让主线归一
  （当前 GitHub 上的 main 是用 Contents API 造出的独立 commit，与 Gitee 主线分叉，
  这是预期内的 —— 从站本来就该被主源覆盖）。

## 2.4.3 · jobs 端点 + patch inject 修复 + 宿主服务探针（2026-10-20）

### 发现过程

加 `jobController` 后重启，探针报：

```
injectedTotal: 14
available: 10
missing: ['permissionPresets', 'jobController', 'fileUploads', 'attachments']
```

`injectedTotal` 从 13 涨到 14，说明新代码确实加载了；但 `jobController` 仍 MISS。
顺着 cordis 源码追：

1. `cordis/lib/index.js` L1317 `_refresh()`：inject 里**任一服务缺 impl → epoch = INACTIVE**
   → 插件不激活。所以「inject 有它 + impl 缺失」应该报
   `cannot get required service "x" in inactive context`。
2. 但探针拿到的是 `cannot get property "x" without inject` —— 这是 **prop 根本不在
   fiber.inject 里** 时的报错（`ReflectService.handler.get` L676）。
3. 既然 `src/index.ts` 导出了 `jobController`、构建产物里也有，为什么 fiber.inject 里没有？
4. `dsh --profile web --dump-config` 给出答案 —— 插件行的 `inject` 只有 **10 项**，
   是 `cordis.patch.yml` 里写的那 10 项，**不是**插件导出的 14 项。

**根因：patch yaml 里的 `inject` 覆盖插件自己导出的 `inject`，不是取并集。**

这解释了全部现象，一一对得上：

| 服务 | patch 里有没有 | 探针结果 |
|---|---|---|
| sessionController / workspaceController / workspaceRegistry / settingsController / credentialsController / agentPresets / llm / webServer / agents / commands | 有 | 全部 OK（正好 10 个） |
| permissionPresets / jobController / fileUploads / attachments | **没有** | 全部 MISS（正好 4 个） |

### 这条坑掩盖了什么

**`permissionPresets` 从来不是「web profile 注不进」。** 此前（2.4.2 的注释、
`dsh-companion` 的 F1 缺陷分析、多份调研文档）都断言它注不进、只能走
`FALLBACK_PERMISSION_CATALOG` + BFF 绕行。真相是 patch 里没声明它。
`fileUploads` 与 `attachments` 同理 —— 它们一直 MISS，不是因为内核没提供，
是因为**没写进 patch**。

> 这条要写清楚：之前的结论**错得很有说服力**，因为报错一模一样。
> 「内核没有这个服务」与「patch 没声明这个服务」在运行时报同一个错，
> 只有 `--dump-config` 看注入清单才能分辨。

### 修了什么

- `cordis.patch.yml` 的 inject 从 10 项补到 14 项（与 `src/index.ts` 对齐）。
- **新增 `docs:check` 门禁**：patch 的 inject 必须与 `src/index.ts` 的
  `export const inject` **双向完全一致**。少一项 → 服务读不到；多一项 →
  声明了不存在的依赖，整个 entry 永久 INACTIVE（比少的更糟）。
  自测两向都验过：删 `jobController` 报「缺少」；加 `notARealService` 报「多出」。

### 待验证

重启后预期：`available` 从 10 涨到 14（`permissionPresets` / `jobController` /
`fileUploads` / `attachments` 全部转 OK）。若届时 `permissionPresets` 可用，
2.4.2 的权限目录 BFF 就从「绕过去」变成「正路」，值得回头简化。

### 子批一 · 后台任务管理 + snapshot 投影优先 + A1 实测结论

### 1. 后台任务管理（jobs）

远程场景下有个真焦虑：在手机上让 agent 跑个长任务，然后切走或放下手机 ——
此时没有任何地方能看到「它还在跑吗」，更没有地方能「让它停下」。

新增三个端点，全部挂在**会话维度**下（内核的 `list` / `kill` 都要 `sessionId`，
owner fence 是唯一的访问规则；做成顶层 `/jobs` 就得让客户端猜 session，那是把
内核的围栏语义搬到桥外面）：

- `GET  /chat/sessions/{sessionId}/jobs` —— 清单
- `GET  /chat/sessions/{sessionId}/jobs/{jobId}/output` —— 已保留输出
- `POST /chat/sessions/{sessionId}/jobs/{jobId}/kill` —— 终止

能力位 `job-list-v1` / `job-output-v1` / `job-kill-v1`。

**两个关键设计判断**：

1. **REST 只读第一帧，不做长连接。** 内核的 `list` 是 `AsyncIterable`，但内核注释
   写得很清楚：「Whole-set replacement, so a reconnect's first frame is already
   the truth」—— 首帧就是完整真相。所以读一帧就够，不把 HTTP 变成长连接。
2. **kill 的 not-found 转 404，其它失败转 502。** 内核只有 `requested` /
   `already-finished` 两种返回，「不存在」走 `job/not-found` 远程错误。不靠
   `error.message` 猜（文案会变），看内核在 `RemoteErrorDetailsMap` 里登记的 code。

错误类型继承 `ApiError` 而不是另起一套 —— 形状一致，router 现有的 `asApiError`
直接就能转，不必再写一层转换。

### 2. history 首屏改用 snapshot 自带投影

0.2.1 起 `SessionFollowFrame` 的 snapshot 分支自带 `projections`，所以
`@patch history-projections-passthrough` 的 `until` 条件（「内核把 projections 并进
follow/page 的返回」）**已达成**。新增 `projectionsOf()`：优先用 snapshot 自带的，
取不到才回落 `readSessionProjections` —— 每次 history 读取少打一次 RPC。

保留回落：最低支持版本还是 0.2.0，老内核上 `readSessionProjections` 仍是客户端
看到权限档位的唯一途径，不能删。

### 3. A1 文件变更监听：实测做不了（附根因）

原计划透出 `workspaceFiles.changes()`。探针实测结论：

```
observed: workspaceFiles → available: false
           error: cannot get property "workspaceFiles" without inject
```

**根因**：`WorkspaceFiles.static inject` 里有 `fs`，而 web profile 的运行时 dump 里
**没有 `dsh-fs` 这一行**（只有 `fs-observation-policy` 与 `fs-sandbox` 两个附属包，
`tool-fs` 被显式 `disabled: true`）→ `fs` 无提供者 → 整个 entry 静默不激活。

这与 `workingDirectory`（`inject` 同样含 `fs`）**完全同源**。两者都不是 bug，
是 web profile 的刻意裁剪。

**所以 A1 不做**，`workspaceFiles` 留在探针观测区，让后来的排查者一眼看到
「不是忘了接，是接不上」。

### 4. 无用代码审计结论：**无可删**

按「每个 export/内部符号的引用计数」逐个体查（脚本扫 `src/` + `tests/` 全量文本）：

- 未引用的 export：3 个，全部合理 —— `InjectedServiceName` / `ObservedServiceName`
  是 `as const` 数组的类型别名（导出来给消费方用），`installWorkspaceStyles`
  是 client 入口。
- 未引用的内部函数 / const：**0 个**。
- 空断言测试：0 个。

即：**没有死代码可删**。这不是"审计没做"，是审计的结论。

### 5. C 层（工具专用块）现状修正

此前报告把「工具调用专用块」列为"下一个最大观感差"。核对后发现**已经做完了**：
`ChatToolBlocks.kt`（304 行）已有 `ReadBlockView` / `TerminalBlockView` /
`DiffBlockView` 三种专用块，并经 `ChatToolDetail.kt:342` 接入消息流。
权限档位 Pill（`ChatPermissionPill.kt`）也已落地。

**教训**：那份报告的依据是 10-18 的静态逆向，没核对 v2.2.44 / v2.2.45 的实际改动。
先查再写，否则会把已完成的东西当待办再做一遍。

### 6. 测试与门禁

新增 `tests/job-api.spec.ts` 21 例（桩照内核真实形状：kill 造成同步、
list/follow 造成异步迭代器）；`tests/history-projections.spec.ts` 加
`projectionsOf` 5 例。门禁：tsc 干净；vitest 42 文件 / 337 用例全绿；
docs:check 两段均过。

`capabilities.spec.ts` 当场抓到我漏写能力位依据（新能力位没有契约字面量可指
就报红），补上三个 job 能力位各自的 openapi 路径依据。

### 7. 待办

- jobs 三个端点的真机响应（需重启 web profile 后验证 admin 路径）。
- C3 Goal 入口（App 侧，服务端 API 已就绪，纯 UI）。

### 子批二 · 宿主服务注入面探针 `GET /debug/host-services`

### 基于什么

适配 DSH 0.2.1-rc.2 时遇到一个方法论问题：本插件刻意不 import 任何
`@deepseek-ai/*` 包，全部宿主服务按结构类型 + Host 注入消费。这让它跨内核版本
零漂移，**但也让「服务到底注进来了没有」只能靠猜** —— cordis 的注入属性是惰性
访问器，读一个没人提供的服务会抛 `cannot get property "x" without inject`，
而这个错误只在真的去读的那一刻出现。

于是历史上反复出现同一类事故：某功能静默不工作，两侧日志都不说一句话，
排错者先从客户端查起。`attachments` 在 2.0.0、`fileUploads` 在 2.0.2 都是这么炸的
（`dsh-0.2-bridge.ts` 里那段长注释记着连踩两次的过程）。

更具体地，本轮有两个**悬而未决的判断题**：

1. `permissionPresets` 在 0.2.0 上注不进（插件已降级到 `FALLBACK_PERMISSION_CATALOG`），
   0.2.1 的注入面**未知**；
2. `ctx.workingDirectory`（DSH 0.2.1 新增）理论上可注入，但没人验证过。

### 干了什么

- **新增 `src/host/host-service-probe.ts`**：在 apply 期间（注入属性仍可读）逐个试读
  13 个 inject 服务 + 1 个观测服务，记录每个服务的 `available` / `resolvable` / `error`。
  `available` 与 `resolvable` 分开，是为了区分「服务压根没提供」和「提供了但是空的」。
- **新增 `GET /debug/host-services`**：返回上述快照。鉴权与其它 REST 端点同一套
  （设备 token 或 loopback admin）—— 它暴露宿主内部结构，不该对局域网裸奔。
- **启动期摘要进日志**：`apply` 时把「host services N/M 可注入，缺失：…」打成一行，
  这样即使没人请求端点，「注入了几个服务」也留在 DSH 日志里。
- 同步 `docs/project/API.md` + `docs/api/openapi.yaml`（wire schema 五处同步的另两处，
  另三处 Kotlin SDK / 测试 / 实现已就位；本端点面向排错，App 不消费，故 Kotlin SDK 不加）。

### 测了什么

新增 `tests/host-service-probe.spec.ts` 6 例：

- 全部注入成功时每个服务都可用；
- 某个服务没注入时进 `injectedMissing` 并带上内核原始错误信息，且**不影响其它服务的判定**；
- 解析出 `null`/`undefined` 时算 `available` 但不算 `resolvable`；
- 观测区只报 0.2.1 已确认存在于 web profile 的服务；
- `workingDirectory` 可用时被单独报出来（这是 0.2.1 的能力信号）；
- **探针清单与 `src/index.ts` 的 inject 声明一致** —— 防的是「加了 inject 却忘了加进探针」，
  那种情况下探针答不了那个服务到底注没注进来。

测试桩用 `Proxy` 模拟 cordis 的真实语义（读未提供的服务**抛错**），不是简单留空字段 ——
空字段读出来是 `undefined`，那测的是「字段不存在」而不是「服务没注入」，
两者成因不同，而 `available`/`resolvable` 正是为了区分它们。

门禁：`npx tsc --noEmit` 干净；`npx vitest run` 41 文件 / 311 用例全绿；
`npm run docs:check` 两段均通过。

### 实测结果（2026-10-20，重启 web profile 后）

`GET /api/v1/debug/host-services` 真实返回（loopback admin）：

```
injectedTotal: 13
injectedAvailable: 10
injectedMissing: ["permissionPresets", "fileUploads", "attachments"]
observedAvailable: []
```

**三个缺失全部有据可查，且都不是 bug —— 是 web profile 的刻意裁剪：**

| 服务 | 根因（已追到源码） |
|---|---|
| `permissionPresets` | `PermissionPresetService.static inject = ["shell", "approval", "sessions", "sessionProjections"]`。web profile **没有 `shell`**（bash 执行环境归 bash-local / sandbox 那条线），依赖落空 → 整个 entry 激活失败 |
| `workingDirectory` | `WorkingDirectoryService.static inject = ["fs", "sessionProjections", "systemPrompt"]`。web profile 的 dump 里**没有 `dsh-fs` 这一行**（只有 `fs-observation-policy` 与 `fs-sandbox` 两个附属包；`tool-fs` 被显式 `disabled: true`）→ `fs` 无提供者 → 激活失败 |
| `fileUploads` | `dsh-client-file-upload` 只发布 client 侧，**没有 host apply** |
| `attachments` | `dsh-attachment-local` 只是个库，没有 apply（`dsh-0.2-bridge.ts` 那段长注释早已记着这一点） |

**关键教训（本轮最大的收获）**：`dsh --profile web --dump-config` 里 `- id: working-directory` 这行**确实存在且未 disabled**，但服务依然注不进。原因是 **dump 只打印补丁层的行，不代表该行真的被激活** —— 依赖落空的 entry 会静默不激活。此前"`workingDirectory` 在 web profile 挂着、所以能注入"的推断**是错的**，只有探针能回答这个问题。

### 修正此前的推断

- ~~`ctx.workingDirectory` 在 web profile 可用~~ → **不可用**，根因是 `fs` 无提供者。
  要接它有两条路：① 在 profile patch 里补 `dsh-fs-local` 行（但那是用户的 profile，不是插件的）；② 改用 `sessionController.projections()` 读 `workingDirectory` 投影（**不需要 fs**，因为投影是已提交状态的读出）。
- `permissionPresets` 的注入面**已定论：0.2.0 与 0.2.1 一样注不进**。权限档位目录继续走 `FALLBACK_PERMISSION_CATALOG` + BFF（2.4.2 已实现），不再列为待验证项。

### 下一步（按修正后的认知重排）

1. **`session-working-directory-v1` 改走投影路线**：`sessionController.projections({sessionId})` 的
   `values.workingDirectory` 就是已提交的 cwd，**不依赖 `fs`，因此在 web profile 可行**。
   注意这是**只读**；写（切换 cwd）仍需 `WorkingDirectoryService.set()`，而它需要 agent 与 fs，
   在 web profile 上走不通 —— 所以手机端「会话内切换工作目录」在 web profile 上**做不到**，
   这条需求应当降级或改道（例如让用户在 App 里改授权根，而不是改会话 cwd）。
2. 收掉 `history-projections-passthrough`（`follow()` snapshot 0.2.1 起自带 projections）。

## 2.4.2 · history 带投影 + 权限档位 BFF + 斜杠命令执行修复（2026-10-19）

### 基于什么

dsh-companion v2.2.44 真机验收报 F1「权限档位 Pill 与 ⋯ 菜单权限项**从不渲染**」，
以及在真机上「会话中改不了权限」（2026-10-19 复验）。追下去发现是**桥侧三个独立问题**：

1. `GET /chat/sessions/{id}/messages` **完全不下发 `projections`**（顶层只有
   `events` / `hasMore` / `historyFormatVersion`）—— 客户端连「当前权限档位」都读不到；
2. 权限档位的**候选项**只在内核的独立远程服务 `permissionPresets.catalog()` 上，
   桥没有任何入口能把它透出去；
3. **所有斜杠命令都执行失败**，报 `Cannot read properties of undefined (reading 'aborted')`。

### 干了什么

- **history 透传投影**：新增 `readSessionProjections()`，在 `sessions.history` 的两条分支
  （首屏 follow snapshot / `beforeSeq` 分页）都把 `sessionController.projections()` 的结果
  并进响应。登记 `@patch history-projections-passthrough`，新 6 例测试
  （`tests/history-projections.spec.ts`）。
  取不到投影**不抛错**：历史是主功能，投影是附加信息，缺席时客户端走降级路径。
- **新增 `GET /chat/permission-presets`**（scope 与 agent-presets 同为 `chat.read`）：
  走新 `permissionPresets` 命名空间 → 内核 `catalog()`，出网前过 `normalizePermissionCatalog`
  收敛形状（丢无 value 的行、缺 name 退回 value、空串 description 不透传）。
  登记 `@patch permission-presets-catalog-bff`，新 6 例测试。
- **该端点是容错读取**：`ctx.permissionPresets` 在本 profile **不可注入**
  （`cannot get property … without inject`）。按本仓 `attachments`/`fileUploads` 那条既有结论，
  这个异常的含义是「**压根没有**这个可注入服务」，不是时机问题 —— 旁证是内核该能力本身在工作
  （`/permission` 命令可列出、投影 `permissions.currentValue` 有值）。所以改用现成
  `optionalService` 容错读取，缺失时返回**内核默认档位**
  （`workspace-write` / `danger-full-access`，取值依据 `Config.default`）。
  不放 `read-only`：它是合法 sandbox 模式但内核没为它配 preset，而 `/permission <preset>`
  切的是 preset 名。
- **修斜杠命令执行**：`chat-adapter.executeCommand` 调内核 `commands.execute` 时**少传了
  `submittedAttachments`**（内核签名是四个参数 `execute(agent, line, submittedAttachments, signal)`），
  于是 `signal` 实际收到 `undefined`，内核随后读 `signal.aborted` 就炸。
  **症状极有迷惑性**：所有命令全废，报出来的却是「undefined 的 aborted」，与权限、与会话冷热都无关。
  已修，并让测试桩断言第三、四参（此前桩写成 `(_agent, line)`，正好放过了这个错位）。
- 文档：OpenAPI 加 `/chat/permission-presets` 与 `PermissionOption`；API.md 补两节
  （为什么单开一条、降级行为与代价）；Kotlin SDK 加 `listPermissionPresets()` 与两个数据类。

### 测了什么

- 40 个测试文件 / 305 用例全绿（`pnpm check` 四道门）；`docs:check` 10 文档一致。
- **两条用例首跑就抓到实现的真 bug**：空串 `description` 被原样透传（客户端会渲染出
  一行空白副标题）—— 已修（判据与 name 一样按非空串算）。
- 真机复验（配合 App）：重启后 `messages` 响应带上
  `projections = {"asOfSeq":…,"values":{"permissions":{"currentValue":"danger-full-access"},…}}`，
  App 的权限 Pill 与 ⋯ 菜单权限项**正常显示**；`/permission workspace-write` 返回
  `{"kind":"success","text":"preset workspace-write"}`，App 侧档位随之切换。

## 2.4.1 · `turn/end` 的 `reason` 透传（回答被截断提示）（2026-10-19）

### 基于什么

客户端（dsh-companion）新增「回答被截断」提示，需要在 `turn/end` 帧上读到
`reason.kind === 'max-tokens'`。真机实测 2026-10-18：电脑端 WebUI 有这条黄色截断提示，
App 里整条消失 —— 因为 bridge 根本没把这个字段发出去。

### 为什么

`chat.turn.failed` 只覆盖 error 与登出两种**终局失败**；而 `reason.kind === 'max-tokens'`
（输出撞上限、回答被截断）既不是失败、也没有第二条通道能告诉客户端。不发这一帧，
客户端收到的与「正常跑完」一模一样，那条截断提示永远不出现。

### 干了什么

- `src/host/chat-adapter.ts`：`normalizeDshEvent` 在 `turn/end` 上附带 `data.reason`，
  **原样透传**（本仓不解读 `kind` 的取值与语义，归内核 `turn-error.js` /
  `turn-max-tokens.js` / `retry.js`）。`turn/start` 没有 reason，不带；无 reason 时
  帧结构与旧版逐字节一致（老客户端忽略该字段，新客户端直接拿到）。
- `docs/project/API.md` + `docs/api/asyncapi.yaml`：补 `turn/end` 的 `reason` 字段说明。
- `tests/chat-adapter.spec.ts`：4 个回归用例（带 reason 透传 / 不带时结构不变 /
  只对 turn/end 附带 / 未知 kind 也原样带出）。

### 测什么

`pnpm typecheck` 通过 · `pnpm test` 38 文件 / 291 用例全绿 · `pnpm docs:check` 通过
（10 文档 / 39 任务 / 9 ADR） · `pnpm build` 通过 · `npm pack` 触发 prepack 全闸通过。

### 发布（2026-10-19）

- 提交 `8eec95b`，双推 origin + gitee（`3ebdeb0..8eec95b`），tag `v2.4.1`（`783346c`）两端一致；
- npm 发布 `dsh-remote-bridge@2.4.1`（`latest`；shasum `451a7138…`、integrity `sha512-2wsGPPucDvj9Y…cAXseb2HrHInA==`，与本地 `npm pack` 完全一致）；
- 双站 Release：GitHub `releases/tag/v2.4.1`（2 资产，tgz 555,503 字节，digest `sha256:ad44dbaf…8198d`）；Gitee `releases/tag/v2.4.1`（id 1217063，自传 2 资产 + 平台自动 zip/tar.gz）；
- **回读校验**：Gitee 下载 tgz **逐字节一致**（555,503 字节，SHA-256 `ad44dbaf…8198d`），GitHub API digest 与本地一致。

## 2.4.0 · Cloudflare WAN 隧道接入 + 远程卡 UI 调整（2026-10-17）

### 基于什么

「人已出门、只有手机在手」也要能连回本机 —— 远端在哪、局域网之外怎么连，是远程访问的
最后一块短板。用户已在真机（重启 dsh 后）确认手机端可访问，随后提出插件界面端四项 UI 调整。

### 为什么

1. 之前只有独立 listener（局域网/直连），没有公网兜底通道；人不在同一网络就断了；
2. Cloudflare 隧道（边缘上已由 provider 做了)→ 不需要逐个路由器配端口映射；
3. 原 UI 里隧道开关、地址、创建/停止分散，「用隧道地址生成配置文本」藏在一处；
4. 创建云隧道是**公网暴露**的高风险动作，缺一个安全确认在逻辑上站不住。

### 干了什么

- **云端接入**：新增 `src/host/cloudflared.ts`（`ensureCloudflared` 复用局内已下载的二进制/否则
  择源解包，`CloudflaredTunnelManager` 起 Quick Tunnel，从 stdout 正则抓
  `https://<host>.trycloudflare.com`）；router 加回环管理端点
  `/manage/cloudflare/{status,create,stop}` 与进度查询 `/manage/cloudflare/activity`；
  `api.ts` 加 `tunnelStatus/Create/Stop/Activity`。端点对外统一为 `https://`；
- **UI 调整（四项）**：
  1. 隧道主体区（标题/状态 pill/安全警告/开关/进度/地址）**上移到「选择权限」之上、「远程访问
     已启用」之下**；
  2. 创建/停止**合并为单按钮**，按隧道运行状态切换文案「开启云隧道 / 停止云隧道」；
  3. 「用隧道地址生成配置文本」按钮**移到主「生成配置文本」按钮之后**，按状态显示
     「生成隧道配置文件」（可点）/「隧道未开启」（点击等同开启云隧道）；
  4. 开启云隧道（含「隧道未开启」态触发的开启）先弹 `window.confirm` 安全确认
     （`tunnelStartConfirm`），取消则不执行；UI 常驻 `tunnelSecurityWarning`。

### 测什么

`tsc --noEmit` exit 0；`vitest run` **38 文件 / 290 用例**；`docs:check`（10 文档 / 39 任务 / 9 ADR）；
`tsdown` 构建通过；`playwright test` 4 个样式契约全部通过。
真机（2026-10-17）：官方 cloudflared deb 在本机择源下载解包起隧道成功，手机端确认可访问。

### 发布（2026-10-17）

提交 `b9f08a2`，双推 origin(GitHub) + gitee、tag `v2.4.0`、双站 Release 与 npm 均已发布。
- 产物 `dsh-remote-bridge-2.4.0.tgz`，555,053 字节，SHA-256 `42d5bd58…9d40e3`；
  npm dist.integrity `sha512-DhZrZSVTVKUkY…ZknhpBAM1/zXg==` 与本地 `npm pack` 一致；
- 两站资产均**下载回读哈希**并 Gitee 侧反向 `sha256sum -c` 校验通过；npmmirror 已同步 2.4.0；
- GitHub 侧因历史上 v2.3.6 后与本地分叉，经用户拍板用 `--force-with-lease` 对齐到本地历史。

## 2.3.8 · C 批结构性修复 + 能力位与事件面（2026-10-17）

### 基于什么

`dsh-study/分析-2026-10-16/` 的对比报告（对 `dsh-plugin-mobile-gateway` 的分析），
以及姊妹仓 `dsh-companion` 同期做 A 批时暴露的协议层需求。

### 为什么

1. 客户端无法可靠判断「事件有没有漏」：流式 delta 与持久事件共用 `seq`，语义混淆；
   也没有订阅基线，REST 拉取与 WS 订阅之间可能漏事件；
2. 重连后待处理的审批/提问会丢，用户以为「没人找他」；
3. 出网 JSON 可能含孤立代理项（部分客户端会**整帧拒绝**）、历史响应无字节预算；
4. 能力只写在版本号里，客户端只能硬比版本。

### 干了什么

- **`seq` 语义单一化**（ADR-0008）：只表示持久事件序号，流式 delta 不再输出它；
- **订阅基线** `chat.session.snapshot`：只给 `cursor` / `hasMore` / `recordCount`，不发正文
  （双通道会造出两份基线，先后无法保证）；新增能力位 `session-snapshot-v1`；
- **连接即重放**：新连接只补推仍待处理的审批/提问，`data.replayed = true`；
- **出网 Unicode 消毒**（孤立代理项替换为 U+FFFD）与**历史响应字节预算**（截断标记与内容同源）；
- **交付物实时事件** `chat.deliverables.presented`；
- **能力发现**：`capabilities.ts` 共 26 项，每项都必须能指出契约依据（测试逐条核对），
  并讲清两类用途（客户端分支判据 3 项 / 对外声明 23 项）；
- **门禁**：`docs:check` 新增坑位索引 ↔ PITFALLS 正文双向一致；新增
  `tests/patch-discipline.spec.ts` 机检 `@patch` 五要素与 `test` 指向的用例真实存在。

### 测什么

`tsc --noEmit` exit 0；`vitest run` **37 文件 / 275 用例**；`docs:check` 10 文档 / 39 任务 / 9 ADR；
`tsdown` 构建通过；`playwright test` 4 个样式契约用例通过。
⚠️ 涉及内核交互、审批与问答卡片的部分**未做真机确认**。


## 用机检兑现「`@patch` 的 `test` 必须存在」这条承诺（2026-10-17，未发版）

### 基于什么

`AGENTS.md` §3.3 白纸黑字写着「`test` 指向的测试**必须存在** —— 这条可机检」，
而本仓**一直没有实现它**（姊妹仓 `dsh-companion` 早由 `ArchitectureGuardTest` 兑现）。

**一份承诺了「可机检」的纪律，如果没有检查，实际约束力等于零** —— 这正是要补的不对称。

### 干了什么

新增 `tests/patch-discipline.spec.ts`：

1. 五要素齐全且非空（`id` / `for` / `why` / `until` / `test`），支持 `//` 续行；
2. `test` 里至少有一个 `tests/*.spec.ts` 路径，且**文件真实存在**；
3. `test` 里写出的**用例名**必须真的在那个文件里 —— 否则「有测试盯着」是句空话；
4. **下限断言**（至少扫到 1 个块）：解析规则失效时，「零问题」与「零解析」长得一模一样。

当前 2 个块（`approval-hook-prepend`、`question-hook-prepend`）都合格。

### 我验证了这条检查真的会红

**一个从不失败的检查等于没有检查**，所以做了一次 mutation check：故意把一个 `test`
改成不存在的用例名 → 检查失败，报错精确到
`dsh-0.2-bridge.ts:642 的 test 写了用例名「…」，但 tests/dsh-0.2-bridge.spec.ts 里找不到它`
→ 恢复后重新通过。

### 测什么

- `tsc --noEmit` exit 0；`vitest run` **37 个测试文件 / 275 个用例**（+1）。

## 把「坑位索引一致性」并入 `docs:check`（2026-10-17，未发版）

**基于什么**：姊妹仓把同一条检查并进了它的 `ArchitectureGuardTest`；
本仓的对应位置是 `scripts/check-project-docs.ts`（已经进 `pnpm check`）。

**干了什么**：`docs:check` 现在会校验 `AGENTS.md` 的坑位索引与 `PITFALLS.md` 的 `###` 标题**双向一致**，
并带一条**下限断言**（两边各 ≥ 10 条）。三处讲究与姊妹仓相同：**双向**（单向时空集合永远满足）、
**下限**（防解析失败被当成「一致」）、**不按编号找小节**（本仓在 §6、姊妹仓在 §7）。

**新检查第一次跑就抓到了自己的实现 bug**：我原本从 `contents` 缓存里取 `PITFALLS.md` ——
而它**不在那 10 份必需文档里**，于是拿到空串、解析出 0 个标题、17 条索引全报「正文里没有」。
是那条**下限断言**让错误信息指向「解析失败」而不是「正文缺条目」（否则我会去正文里白找一遍）。
已在注释里写明：**不要从必需文档缓存里取 PITFALLS，直接读文件**。

**测什么**：`tsc --noEmit` exit 0；`docs:check`（10 文档 / 39 任务 / 9 ADR）通过；
`vitest run` 仍 36 文件 / 274 用例（这条检查不新增用例）。

## 能力位消费者审计：26 项里只有 3 项是「我方客户端的分支判据」（2026-10-17，未发版）

**基于什么**：交付前自检时想到的问题 —— 这一轮加了 26 项能力位，而我方客户端只读了少数几个。
这正是我在别处反复批评过的「声明了没人用」，值得查清。

**审计方法**：把 `BRIDGE_CAPABILITIES` 的 26 项逐个在 `dsh-companion` 全仓（`.kt` + `.xml`）grep。

**结论**：

| 类别 | 数量 | 是哪些 |
|---|---|---|
| 我方客户端的分支判据 | **3** | `approvals-v1` / `questions-v1`（缺失时客户端明说「插件过旧、卡片不会出现」）、`session-archive-list-v1`（决定是否显示「已归档」入口） |
| **对外声明** | 23 | 其余全部 —— 回答「这台服务端能做什么」，**服务任何客户端（包括第三方）** |

（另有 `session-archive-v1` / `history-v1` 两个名字出现在客户端**测试**里，那是用例字面量，不算消费。）

**这不是同一个问题**：能力位与服务端能力的对应关系是**对外契约**，
「某个客户端没用到」不等于「没人用」；删掉第 2 类等于撤回了对外承诺。

**干了什么**

- `capabilities.ts` 的 KDoc 新增「**两类用途**」一节：讲清两类的区别，
  写明「别把第二类当死代码删」，并给出加位的克制标准（客户端可能需要分支，或这是一个稳定的对外能力面）；
- `API.md` 的能力位一节同步这段说明；
- **加了一条跨仓钉子**：`tests/capabilities.spec.ts` 断言 `approvals-v1` 与 `questions-v1`
  **必须在清单里** —— 客户端把这两个名字写死在 `REQUIRED_CAPABILITIES` 里，
  删掉不是内部重构，而是让客户端对**所有用户**误报「插件过旧」。
- 客户端侧 `BridgeCapabilities.kt` 的注释里加了指向那条钉子的说明（跨仓契约要两边都留线索）。

**测了什么**：`tsc --noEmit` exit 0；`vitest run` **36 文件 / 274 用例全绿**（能力位契约测试 6 → 7 例）。

**未做**：没有为 26 项维护「消费方」分类表 —— 「外部消费者」本来就无法机检，
为它加一张需要人工维护的表只会变成新的漂移源。真正能机检的那一条（客户端必需项）已经钉住了。

## 文件卡片有了实时事件：交付物不再等下一次刷新（2026-10-17，未发版）

**基于什么**：C 批清单的最后一项「文件卡片事件」。对标报告点名这是一处**能力缺口**：
它的网关只要在 `buildWireEvent` 加一个 `case 'deliverables/presented'` 就修好了一个 UI 特性；
而我方 bridge 的 `grep -rn 'deliverables\|presented' src/` 是 **0**。

**动手前的核实**（决定了这是「补一条实时通道」而不是「从零做功能」）：

- **历史那一路一直是通的**：内核的持久事件 `deliverables/presented` 原样透传，
  客户端的 `ChatHistory.deliverables()` 与文件卡片（`ChatSessionFiles.kt`）**早已在读它**、
  也已经能显示 ✓
- **缺的是实时性**：`session/event` 里这个 eventType 此前落进末尾的默认分支，
  被规范化成 `chat.deliverables/presented` —— 客户端不认那个名字，于是新交付物要等到
  **下一次消息完成**触发刷新才出现（延迟几十秒到几分钟）

**干了什么**

- `normalizeDshEvent` 加 `deliverables/presented` 分支 → **`chat.deliverables.presented`**；
  `files` **原样透传**（客户端按 `path` / `description` 读，内核以后往文件项里加字段不用改插件）；
  没有 `files` 时也照样发这条事件（客户端据此知道「这次没有可展示的文件」，而不是干等）。
- 客户端加同名分支 → `scheduleChatRefresh()`：卡片数据在**历史**里，刷新即出现。
- 契约：AsyncAPI 新增 `ChatDeliverablesPresented`、事件名进 `type.examples`；
  `API.md` 新增「文件卡片」一节。

**不加能力位**：客户端的行为是「收到就刷新」，没有它只是**晚一点**看到 —— 这不是分支关系。
按既有判断标准（有分支需求才加位），不加。

**测了什么**

- 新增 `tests/deliverables.spec.ts`（**4 例**）：事件名与字段映射、**未知文件字段原样透传**、
  无 `files` 时给空列表、多次 present 的 `id` 可区分（否则客户端按 id 去重会吞掉后一次）。
- `tsc --noEmit` exit 0；`vitest run` **36 文件 / 273 用例全绿**；
  `docs:check`（10 文档 / 39 任务 / 9 ADR）；`tsdown` build 通过。

**未做（如实记）**

- 客户端那条分支**没有单测**：ViewModel 层在本项目没有测试基建，其余事件分支同样如此 ——
  不假装覆盖了。
- 未做真机：要真机上让智能体 `present` 一个文件，看卡片是否**立刻**出现。

## 单胜方交互的核账：两件已有、两件待拍板（2026-10-17，未发版）

**基于什么**：C 批清单的最后一项「单胜方下游 abort」。对标报告 §4.3 把竞品的机制拆成**四件事**。

**动手前的核账**（本轮的全部工作 —— 结论决定了「不该改代码」）：

| # | 竞品的做法 | 我方现状 |
|---|---|---|
| ① | 注册时立刻 `next()`：WebUI 与手机**同时**拿到卡片 | **刻意不调** —— `prepend` 到 waterfall 链首，接管到手机作答为止 |
| ② | 身份比对判胜方 | **已有** ✓ |
| ③ | 手机赢时 abort 下游信号，收起所有 WebUI 弹窗 | **没有**，且**本仓不可证**：`req.signal` 是否可写、内核/WebUI 是否认这个 abort，都查不到 |
| ④ | 迟到响应统一视为 `not-pending` | **已有** ✓，且**有测试钉住**（`dsh-0.2-bridge.spec.ts:232`、`chat-adapter.spec.ts:403`） |

**结论：这项不该直接改代码。** 串行 vs 并行决定的是「**用户在电脑前能不能看到卡片**」，
属于产品行为；而并行化的前提（③）在本仓不可证。硬做的代价可能是**永远挂着的弹窗**——
用户点它只会得到「已由别处处理」（④ 会返回 `not-pending`），但弹窗本身不会消失，比现状更糟。

**交付**：`decisions/ADR-0009-single-winner-interactions.md`（状态 **proposed**）——
把四件事逐条核账、列出两个选项的代价、并给出**选项 C：一个低成本实验**：

> 在下一次联调时，于内核侧让一次审批的 `req.signal` 触发 abort，
> 观察官方 WebUI 的审批弹窗**是否自行收起**。

- 会收 ⇒ 并行化具备前提，可以排期做；
- 不会收 ⇒ 串行就是终局，届时把「电脑端看不到卡」作为**已知限制**写进 README
  （让用户知道这是设计选择，而不是我们漏做了）。

**为什么这是正确的交付**：查不到就写「不可证」，并给出**让它变得可查**的办法 ——
而不是凭猜在两条路之间选一个。这正是本项目 §空结果的来源要验证 那条坑位的用法。

**未改代码**：本文没有任何代码改动。门槛与用例数因此不变
（`tsc` exit 0、**34 文件 / 264 用例**、`docs:check` 现在报 **9 ADR**）。

## 订阅基线不再被丢弃：断档从此可检测（2026-10-17，未发版）

**基于什么**：对标报告点名的「原子基线 `snapshot`」。报告的证据是
`dsh-0.2-bridge.ts:554` 那句 `continue` 把上游第一条 `snapshot` 直接丢掉。

**动手前先核实**（不照报告抄）。两处独立证据：

1. 本文件 `SessionEventRelay` 顶部注释写着：Live follow stream. Its first frame is
   **always** a `snapshot`；
2. history 路径（`:1434-1451`）**一直在消费** `snapshot.records` / `hasMore` / `cursor`
   —— `throughSeq` 就取自 `snapshot.cursor`。

所以 mux 那条路上每一路订阅的第一帧确实是 snapshot，只是被丢了。

**为什么是问题**：手机端因此**永远拿不到原子基线** —— 「REST 拉历史」与「WS 订阅」
之间的窗口期事件真漏，而且客户端**无从判断漏没漏**（它没有任何参照点）。

**干了什么**

- `SessionEventRelay.pump` 接出 `frame.type === 'snapshot'` 分支，推 `session/snapshot`；
- `normalizeDshEvent` 把 `session/snapshot` 转成 **`chat.session.snapshot`**，
  data 带 `sessionId` / `cursor` / `hasMore` / `recordCount`；
- 能力位新增 **`session-snapshot-v1`**（依据是 AsyncAPI 里的 `chat.session.snapshot`）；
- AsyncAPI 新增 `ChatSessionSnapshot` schema、把事件名加进 `type.examples`；`API.md` 新增「订阅基线」一节。

**两个刻意的收窄**（写在代码、契约与文档三处）：

1. **正文不发**：`records` 只计数成 `recordCount`。本桥是 REST + WS **双通道**，
   把历史正文也灌进 WS 会造出**两份基线**，而它们的先后顺序无法保证 ——
   竞品的教训清单里正有「不得用迟到的 history 响应覆盖订阅基线」这一条。
   正文继续由 REST 作为**单一来源**。
2. **不可证字段不给**：某些版本的 snapshot 里可能有 `assistantStream.activeAttempt`，
   但在我方 0.2.x 上**不可证**（本仓 `node_modules` 下没有内核包）。按
   `PITFALLS.md` §空结果的来源要验证，宁可不给，也不按想象给。

**测了什么**

- `tests/dsh-0.2-bridge.spec.ts` 加 1 例：snapshot 帧被转发为 `session/snapshot`，
  且**断言不含 `records`**（防日后有人顺手把它加回来）。
- 新增 `tests/session-snapshot.spec.ts`（**4 例**）：字段映射、**缺字段不凭空补**
  （补个 `cursor: 0` 会让客户端把「历史完整」判成事实）、即使 `records` 传到规范化层
  **也不透出**（第二道防线）、重订阅的 id 可区分。
- `tsc --noEmit` exit 0；`vitest run` **35 文件 / 269 用例全绿**；
  `docs:check`（10 文档 / 39 任务 / 8 ADR）；`tsdown` build 通过。

**顺带**：能力位契约测试当场拦下「声明了 `session-snapshot-v1` 但契约里没有这个字面量」——
我只加了 schema、忘了把事件名写进文档。补进 `type.examples` 与 schema 描述后通过。
这是它第二次真正生效（上一次是 ADR 索引）。

**未做**：客户端消费（收到基线后比 `max(本地 seq) < cursor` ⇒ 重取历史）归到下一项
「断档检测与 resync」—— 那一项本来就要客户端一套完整的判断与恢复路径，
分两次做反而会把状态机切碎。

## `seq` 语义单一化：流式片段不再冒充会话序号（2026-10-17，未发版）

**基于什么**：对标报告点名的阻断项「`seq` 隔离」——
`dsh-0.2-bridge.ts` 的 `assistant-stream` 路径用 `inner.index` 冒充 `seq`。

**先设计再动手**：新增 `docs/project/decisions/ADR-0008-seq-single-meaning.md`。
改 wire 语义按本项目制度**先落决策记录**，再改实现。

**病根**：两条来源塞进了同一个字段名 ——

| 来源 | 原来的 `seq` | 真实含义 |
|---|---|---|
| `frame.type === 'event'` | `event.seq` | 会话**持久事件**序号（历史坐标） |
| `frame.type === 'assistant-stream'` | `inner.index` | **本次流内**的 chunk 序号（每轮从 0 重来） |

按 `seq` 排序 / 去重 / 分页的消费者，会把「流式片段的 0,1,2…」与「持久事件的 0,1,2…」
当成同一序列；把 chunk 序号当作 `beforeSeq` 游标或 `atSeq` 分叉点，更会指向完全不相干的历史位置。
不是崩溃，是**静默的语义污染**。

**动手前逐个核过消费者**（这是「可以安全地不再输出」的前提，不是推断）：

- 本仓 `kotlin-sdk` 未建模 delta；
- WebUI 兜底页 `chat.html` 不读 `seq`；
- 姊妹仓 App 的 `ChatDelta` 里**没有 seq 字段**，`chatDelta()` 只读 `index`；
- AsyncAPI 的 `ChatMessageDelta.seq` 本来就不是必填。

也就是：这个字段**当前没有任何消费者**，它唯一的作用是给后来者埋雷。

**干了什么**

- `assistant-stream` 路径推给 mux 的 `assistant/chunk` 事件**不再带 `seq`**；
  `index` / `turn` / `step` / `time` / `data.chunk` 照旧。
- AsyncAPI 把 `ChatMessageDelta.seq` 标注为 **deprecated**（保留而非删除 ——
  免得把已有第三方实现判成不合法），并写明它只对持久事件有意义。
- `API.md` 新增「`seq` 的语义（只有一种）」一节；ADR-0008 登记进 `docs/project/README.md` 索引。

**测了什么**

- `tests/dsh-0.2-bridge.spec.ts` 的 chunk 断言改为**断言字段不存在**（而不是改成别的值 ——
  那样有人在把 `seq` 加回来时会静默通过），并与同一文件里持久事件
  `assistant/message` 的 `seq: 7` **形成对照**：两条路径的语义差异从此被测试钉住。
- `tsc --noEmit` exit 0；`vitest run` **34 文件 / 264 用例全绿**；
  `docs:check`（10 文档 / 39 任务 / **8 ADR**）；`tsdown` build 通过。

**未做 / 边界**

- **不加能力位**：能力位表示「客户端可据此分支的能力」，而这里没有任何客户端需要分支 ——
  它只是不再产生一个没人读的字段；加了反而暗示客户端应该做点什么（理由写在 ADR 的影响节）。
- 未发版；`pnpm` 仍不可用（见 `PITFALLS.md` §pnpm store 打不开数据库）。

**顺带**：`docs:check` 当场拦下「新 ADR 未登记进索引」（`ADR-0008-… is missing from the ADR index`）——
**那条校验第一次真正生效**。

## 已归档会话可列：手机端的「归档」不再是单向门（2026-10-17，未发版）

**基于什么**：对标报告 A 批清单里的「归档恢复」。动手前先查证了两件事，结论决定了这次的边界：

1. 归档数据**本仓可得**吗？—— 可得：`archivedSessionIds` 与 sessions 都在宿主响应里，
   本仓代码已在读（`chat-adapter.ts` 的 `listSessions` 用它做过滤）。
2. 内核支持**取消归档**吗？—— **本仓不可证**：适配层只声明了 `archiveSession`，
   `node_modules` 下没有 `@deepseek-ai/*`（那些包随 DSH 主包安装）。

**为什么**：内核把「归档」实现为**从所有分组界面隐藏**，本桥默认照做 —— 于是用户在手机上
一归档，那条会话就**再也看不到**（连找都找不到）。「恢复」这次做不到（见下），
但「连看都看不到」是更糟的那一半。

**干了什么**

- `chat-adapter.listSessions(principal, { archived })`：`archived: true` 时**只列归档**的那批，
  默认行为完全不变（仍只列未归档）。
- `GET /chat/sessions?archived=true` 接上；OpenAPI 补参数与说明；`API.md` 新增「已归档会话」一节。
- 能力位新增 **`session-archive-list-v1`** —— 按能力位纪律（加位必须能指出契约依据），
  依据就是那个 query 参数：`tests/capabilities.spec.ts` 会拿 `name: archived` 去 OpenAPI 里核对。

**测了什么**

- 既有 `chat-adapter.spec.ts` 补两条断言：默认列表 2 条（**不含**归档会话）、
  `archived: true` 只返回 `session-archived`。
- `tsc --noEmit` exit 0；`vitest run` 全绿；能力位契约测试同步通过。

**未做 / 边界（刻意）**

- **恢复（取消归档）不做**：内核是否提供 unarchive **从本仓不可证**。按
  `PITFALLS.md` §空结果的来源要验证，只在代码注释与 `API.md` 里写「不可证」，
  并明确「客户端不要提供恢复按钮，除非能在宿主侧确认该能力」。
  宁可少一个功能，也不实现一个可能不存在的内核调用。
- **客户端 UI 未做**（已归档列表入口 + 归档动作的确认文案），留下一轮。
- 未发版；`pnpm` 仍不可用（见 `PITFALLS.md` §pnpm store 打不开数据库）。

## 能力发现与历史格式版本：不再让客户端硬比版本号（2026-10-17，未发版）

**基于什么**：对标第三方移动网关的 `hello.capabilities`（19 项、带 `-v1` 后缀，
且是**配置与鉴权状态的函数**）与它的 `historyFormatVersion` 游标护栏。

**为什么**：客户端需要一个**运行时**判据来回答「这台服务端现在能做什么」。
—— 先纠正一个易混点：README 里那句「要求 bridge ≥ 2.3.7」是给**用户**看的安装门槛，
而 `dsh-companion` 的代码里**既没有**版本比较、**也没有**处理 `connection.ready`（已核实）。
所以真实症状不是「判据太粗」，而是**没有判据**：服务端能力不足时，手机端只会静默少一个功能
（审批卡片不弹，看起来与「本来就没有待审批」一模一样 —— 这个坑踩过两次，根因都在插件侧）。
能力位把「不支持」变成可探测的事实，客户端据此可以**明说**而不是让用户干等。
另：版本号本身也不适合当判据 —— 粒度太粗（一个版本加五件事只能整包接受），
且方向反了（能不能用取决于服务端**现在**提供什么，版本号只是它的历史编号）。
另一头，`history` 响应没有任何**形状**版本标记：将来事件形状一变，老客户端会拿新形状
按老规则解析，拼出一段「看起来正常、内容却是错的」历史 —— 那比直接报错难查得多。

**干了什么**

- 新增 `src/host/capabilities.ts`：
  - `BRIDGE_CAPABILITIES`：24 项能力位，**每一项都能指出依据**（一条 OpenAPI 路径+方法，
    或一个 AsyncAPI 事件）；命名固定 `<能力>-v<主版本>`，纪律写在文件头：
    只增不撤、语义变更要升 `-v2`、加位必须能指依据、只声明已稳定的东西。
  - `connectionReadyData()`：每次返回**副本**（一次手滑改到常量会污染进程内后续所有连接）。
  - `HISTORY_FORMAT_VERSION = 1` 及其升级规则。
- `server.ts`：`connection.ready` 的 `data` 从 `{}` 变成 `{ bridgeVersion, capabilities }`。
- `chat-adapter.history()`：响应**总是**带 `historyFormatVersion`（**只声明不校验** ——
  强制会打断已发布客户端的 `beforeSeq` 分页）。
- 契约面：AsyncAPI 新增 `ConnectionReadyData` 并接入 `WorkspaceEvent.data.oneOf`；
  OpenAPI 的 `listMessages` 200 补 `historyFormatVersion` 与说明。

**测了什么**

- 新增 `tests/capabilities.spec.ts`（**6 用例**）：命名规则与去重、
  **逐条把能力位依据拿进 openapi/asyncapi 核对**、反向断言「依据表不许有孤儿」
  （少写依据或加依据忘加能力位都红）、`connectionReadyData()` 返回副本、格式版本为正整数。
- `tsc --noEmit` **exit 0**；`vitest run` **34 个测试文件 / 264 用例全绿**；
  `docs:check`（10 文档 / 39 任务 / 7 ADR）；`tsdown` build 通过。

**未做**

- **客户端未接入**：`dsh-companion` 仍在硬比版本号。下一轮改成按能力位分支、
  版本号只留作诊断。
- 未打开 `historyFormatVersion` 的强制校验（等客户端会读之后）。
- 未发版；`pnpm` 仍不可用（见 `PITFALLS.md` §pnpm store 打不开数据库）。

## 连接即重放：把「新连接能拿到待处理审批」变成服务端保证（2026-10-17，未发版）

**基于什么**：对标第三方移动网关的 `replayPendingInteractions` —— 它在**连接建立**与
**subscribe** 两个触发点重发仍待处理的提问/审批并打 `replay: true`，客户端按 id 去重
（证据见 `dsh-study/分析-2026-10-16/mobile-gateway-插件借鉴点.md` 的「立刻可抄」第 5 条）。

**为什么**：「连接后要不要主动查一次 REST」是**每个客户端自己的选择**。
姊妹仓 `dsh-companion` 会 —— 它的 `HarnessViewModel` 在 `connection` 回调里（连接成功时）
刷新历史、审批、提问与命令（`HarnessViewModel.kt:537-546`）。
**但协议不该把「审批不丢」寄托在这一点上**：客户端若只在收到事件时才刷新，
重连窗口里产生的审批就会静默消失（内核阻塞着等决定、手机上却一片安静）。
重放把这件事变成**服务端保证**；对已经在连接后刷新的客户端，它只是一次幂等冗余。

> **纠错记录（同一轮内自查）**：本条初稿的论证是「客户端自动重连不触发任何刷新，
> 这就是缺口」——**那是错的**。写它的时候我只 grep 了 data 层的 `DshClient.onOpen`，
> 没追到 ViewModel 的 `connection` 回调。功能保留（它让协议不再依赖客户端自觉），
> 理由按事实改正；这类「论证比代码错得更早」的教训已记入 `PITFALLS.md`。

**干了什么**

- `chat-adapter.ts`：新增 `replayPendingApprovals(principal)` —— 复用已有的
  `pendingApprovals` 本地缓存（`captureApproval` 从 mux 帧捕获的完整信息），
  **零 IO**；逐条按 `isSessionAuthorized` 过滤（重放走的是这条连接的身份，
  不能把别的设备授权过的会话推给这台手机）。
- 抽出纯函数 `approvalReplayEvents(records, time)`：按 `requestedAt` 升序、
  `id` 与实时事件同形（`<approvalId>:requested`）、`data.replayed = true`。
- `server.ts`：WS 升级成功后调用，**只发这一条连接**（不走 broadcast，避免有人重连就骚扰所有在线设备）；
  **不 await**（握手不该为一次授权过滤排队）；**失败静默**（重放是补救措施，
  真正的兜底仍在客户端侧）。
- 契约面：AsyncAPI 的 `ChatApprovalRequested` 补 `replayed` 与说明；
  `API.md` 新增「连接即重放（待处理审批）」一节。

**测了什么**

- 新增 `tests/interaction-replay.spec.ts`（**10 用例**：审批 6 + 提问 4）：空集、事件 id/字段形状、
  full-access 风险判定、按 `requestedAt` 升序、时间戳统一，以及一条**契约钉子** ——
  「实时路径（`normalizeDshEvent`）与重放路径必须给出同一组 data 字段（重放多一个 `replayed`）」。
  两条路径各写各的，最容易的漂移就是一条加了字段另一条没加，症状只在「重连后」出现。
- `tsc --noEmit` **exit 0**；`vitest run` **33 个测试文件 / 258 用例全绿**。

**未做**

- ~~提问侧未重放~~ **已于同日补齐**：`QuestionBridge.pendingAll()` → `chat-adapter.replayPendingQuestions()`
  → server 合并推送，走既有事件类型 `chat.userQuestions/requested`，data 字段与实时路径一致（只多 `replayed`）。
  提问不阻塞内核、漏掉的代价小一些，但对称做掉它才配得上「新连接一定能拿到仍待处理的东西」这句话。
- **提问事件仍未进 AsyncAPI**：它由 `normalizeDshEvent` 末段的 `chat.${payloadType}` 兜底产生，
  不在 `components.messages` 里；给所有兜底事件补 schema 是独立的一件事，本次未扩（已记在 `API.md`）。
- 客户端侧未改动：重放对我方 App **无需改代码**（它收到 `chat.approval.requested` 就会去查
  REST，刷新幂等），但也**未经真机验证**。
- 未发版；`pnpm` 仍不可用（见 `PITFALLS.md` §pnpm store 打不开数据库）。

## 历史响应字节预算：一次「翻历史」不再能把手机打死（2026-10-17，未发版）

**基于什么**：对标第三方移动网关的字节预算做法（单帧 4 MiB、订阅基线 256 KiB，
`tool/result` 首尾各保留 8000 字符并置 `outputTruncated`）—— 证据见
`dsh-study/分析-2026-10-16/mobile-gateway-插件借鉴点.md` 的「立刻可抄」第 6 条。

**为什么**：`GET /chat/sessions/{id}/messages` 是**原样透传**内核事件的，工具输出单条就可能几 MB
（`cargo build`、大文件读取、日志回放）。手机端拿到响应必须**先把整份 JSON 读进内存**才谈得上解析，
于是「翻一次历史」就能变成卡顿甚至 OOM —— 而服务端毫无察觉（序列化成功、HTTP 200 正常返回）。

**干了什么**

- 新增 `src/host/history-budget.ts`：
  - `clampStrings()`：递归把超长字符串换成「首尾保留 + `…[truncated]…`」，**形状无关**（不认识字段名也能生效）。
  - `clampHistoryEvents()`：单条超限先剥字符串；整份超限则从**最旧**端丢整条，直到落进预算。
  - `applyHistoryBudget()`：套回响应体 —— 丢过条 ⇒ `hasMore` 置真（与 `beforeSeq` 分页语义一致）；
    真的动手 ⇒ 追加 `truncated` + `bytes`；**没动手就一字不加**。
- `chat-adapter.history()` 出网前调用（router 原样透传，无需改动）。
- **为什么不照抄字段级裁剪**：本仓**无法证明**工具结果挂在哪个字段上 —— `tool/result` 这个类型名
  在本仓 `src/`、`tests/`、`docs/` 零命中，而**内核契约不在本仓可查范围内**（`node_modules` 下没有
  `@deepseek-ai/*`）。按猜出来的字段名写裁剪，最坏结果是**静默无效**
  （裁剪器一条都没命中，界面上看不出区别，直到线上真的 OOM）。

  > **纠错记录（2026-10-17 当日自查）**：本条初稿写的是「`tool/result` 在本仓与**内核的
  > `node_modules`** 里都零命中」—— 那半句是**假证据**：`node_modules/@deepseek-ai` 这个目录
  > **根本不存在**，`grep -r PATTERN missing-dir/` 的 0 命中被我当成了「查过、没有」。
  > 而且本文件里 2.1.x 那条记录早就写明「官方内核包随 DSH 主包安装，不会出现在 profile 的
  > `node_modules` 下」—— 我既没验证目录存在，也和仓库已有知识矛盾。
  > 结论不变（仍是"形状无关"实现），但理由已按事实重写；教训记入 `PITFALLS.md` §空结果的来源要验证。
- `kotlin-sdk` 未改：该 SDK 没有建模 history 响应（已核），契约面只有 `API.md` + OpenAPI。

**测了什么**

- 新增 `tests/history-budget.spec.ts`（**13 用例**）：小响应逐字节不变、单条限幅、嵌套字符串、
  丢最旧保最新、单条超总预算时至少留一条、不改入参、无字符串事件、字节数报告、
  以及 `applyHistoryBudget` 的四个分支（不动手不加字段 / 丢条置 `hasMore` / 只剥串不动 `hasMore` /
  上游已说 `hasMore` 时保持）。
- **一条回归钉子专治实现初版的真 bug**：标记挂在了**原始** entry 上，于是「标记说截断了、
  内容一个字符没少」——客户端会据此提示用户「内容已截断」，而几十万字符照旧进了响应。
  现在断言「有标记 ⇒ 内容确实变短」。
- `tsc --noEmit` **exit 0**；`vitest run` **32 个测试文件 / 248 用例全绿**。
- 文档同步：`API.md` 新增「历史与分页」一节；`docs/api/openapi.yaml` 的 `listMessages` 200
  补上 schema（`events`/`hasMore`/`projections`/`bytes`/`truncated`）。

**未做**

- 未发版、无版本号变更。
- `pnpm` 仍不可用（见下一条与 `PITFALLS.md` §pnpm store 打不开数据库），四道门仍是逐条等价执行。

## 出网 JSON 消毒：孤立代理项不再打死整条连接（2026-10-17，未发版）

**基于什么**：对标第三方移动网关时发现它有一个 7 行的 `lib/wire-json.mjs`，
把**孤立 UTF-16 代理项**替换为 U+FFFD，理由写在注释里：DSH 内核的摘要截断会留下
半个代理项，`JSON.stringify` 会照样把它转义成 `\udXXX`，而 **Swift/Foundation 的
JSONDecoder 会拒绝整帧**。证据见 `dsh-study/分析-2026-10-16/mobile-gateway-插件借鉴点.md`
的「立刻可抄」第 7 条（我方当时零对应处理）。

**为什么**：这不是新功能，是补传输层的安全网。一条工具输出被截断在 emoji 中间，
就能让整条 WebSocket 帧变成 Foundation 不接受的 JSON —— 症状是客户端「突然不再更新」，
而服务端日志一句报错都没有（序列化本身是成功的）。放在**出网口**做，未来新增事件类型自动受益。

**干了什么**

- 新增 `src/host/wire-json.ts`：
  - `sanitizeLoneSurrogates(text)`：单遍字符扫描。合法代理对（emoji）原样放行，
    无缺陷输入**返回原引用**（广播热路径上零分配）。
  - `stringifyWire(value)`：用 `JSON.stringify` 的 `replacer` 只清洗**字符串值**，
    不做深拷贝（工具结果动辄几百 KB，深拷贝就是白烧 GC）。
  - 刻意**不用正则**：孤立代理项的判定要看相邻字符，带后向断言/重复分组的正则在长串上
    有性能与跨端一致性问题（同一天在姊妹仓踩过一次，见那边 `PITFALLS.md` §长文本正则与重复分组）。
  - 已知边界写在注释里：`replacer` 不经过**对象的键**，本项目键名都是协议固定 ASCII 字段，
    不存在「按字符数截断的键」；真出现应从产生侧修，而不是在每次广播上做全量 JSON 词法扫描。
- 接入**两个出网口**：WebSocket（`src/host/server.ts` 的 `connection.ready` 与 `broadcast`）
  与 HTTP JSON（`src/host/router.ts` 的 `sendJson`）。路由鉴权、事件过滤一律未动。

**测了什么**

- 新增 `tests/wire-json.spec.ts`（8 用例）：合法代理对保留、孤立高/低代理替换、
  好坏混合只修坏的、无缺陷快路径同引用、嵌套结构往返后线上无 `\ud800`、
  干净输入与原生 `JSON.stringify` 逐字节一致、20 万字符病态输入不退化。
- `tsc --noEmit` **exit 0**；`vitest run` **31 个测试文件 / 235 用例全绿**
  （新增 1 文件 8 用例，其余未动）。
- `tsx scripts/check-project-docs.ts` 与 `tsdown` build：见本轮门验结论。

**未做 / 环境问题（需明确提示）**

- **未发版**，无版本号变更。
- ⚠️ **本机 `pnpm` 已坏**：`pnpm --version` 直接报 `[ERROR] unable to open database file`，
  换 `XDG_STATE_HOME` 无效；`node_modules/.bin/` 下的同名二进制（tsc / vitest / tsx / tsdown）
  全部正常，npm 10.9.9 与 node v24.19.0 正常。因此本轮 `pnpm check` 的四道门是**逐条等价执行**的，
  不是一条命令跑的 —— 环境修复后应补跑一次完整 `pnpm check`。已记入 `PITFALLS.md`。

## 投稿 awesome-dsh-plugin 收录（2026-10-15，未发版，仅文档与资产）

**基于什么**：读 [awesome-dsh-plugin/contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md) 全文，逐条比对两个仓库的现状。该列表的收录形态是「一个插件一个 YAML 文件」，两个 README 由脚本生成、禁止手改。

**为什么**：让插件进入公共列表，用户从列表页即可安装；同时按文档要求补齐推荐的截图声明（市场详情页会展示 AppStore 式截图）。

**dsh-companion 为什么不一起投**：它是纯 Kotlin/Gradle 的 Android 工程，仓库内**没有 `package.json`**，因此无法声明文档第 2 项 CI 强制检查的 `dsh.bundle` manifest（只声明 `dsh.client` 会被明确拒绝）。硬造一个 Node 插件外壳只会命中「placeholder / name-squat 仓库不予收录」条款。客户端改由本插件 README「连接 Android App 或其他客户端」一节以双站链接 + 双二维码引用。

**干了什么**

- 新增 `screenshots.json`（4 张）与 `assets/screenshots/` 下四张真实截图：根目录（默认展开）/ 远程访问 / 设备 / App 下载。生成脚本 `scripts/generate-screenshots.ts` 复用 `src/client/workspace.tsx` 的 `ADMIN_TABS`、`src/client/styles.ts` 的 `WORKSPACE_CSS` 与 `src/client/app-qr.ts` 的 `APP_QR_CODES` —— 与 `e2e/styles.spec.ts` 同一产出来源，不是另画的示意图；面板呈现「未连接真实内核」的自然状态（刚装好、远程访问未启用）。
- `package.json` 的 `files` 数组补入 `screenshots.json`（此前只有 `assets/**`，截图进包而声明文件不进）。
- 新增 `scripts/validate-entry.ts`：条目 YAML 的自检工具，校验必填字段、`category` 合法性、`tarball` 必须是 GitHub 托管的 https `.tgz`、描述无营销词。
- 投稿侧条目 `data/plugins/westanke__dsh-remote-bridge.yml`：`category: remote`；`tarball` 钉在 `releases/download/v2.3.6/dsh-remote-bridge-v2.3.6.tgz`（**不用 `latest/download/`** —— 文档警告资产名带版本号时该写法会在下次发版后静默 404）；描述中英双语、只陈述功能。

**测了什么**

- `node scripts/check-submission.mjs --only-list …`（CI 同款脚本，带 `GITHUB_TOKEN`）→ `all checked entries pass`，JSON `ok: true`、`checked: 1`、`failures: []`、`incomplete: []`。
- `node scripts/generate-readme.mjs --check` 一致；与上游 `main` 的 README 中英 diff 各 **+1 行 / -0 行**，未触碰任何既有条目（对应评审标准第 6 条）。
- fork 原先落后上游 6 天（10-08 的 base），已 `gh repo sync` 到上游最新 `575ea0b8` 后重跑，避免 PR 大面积删除他人条目。
- `pnpm check`：typecheck + **30 个测试文件 / 226 个用例** + docs:check + build 全绿。
- 截图经逐张目视核对：七张卡片平铺、默认只展开一张、按钮非白字白底、二维码正常解码（与 e2e 四条断言一致）。

**未做**

- 未新开 PR：fork 分支 `add-dsh-remote-bridge` 对应上游 **PR #6968**（2026-10-09 创建，CI 两项 success，`mergeable_state: clean`）本就在队列中等评审；本轮只往同一分支追加改动，不制造重复投稿。
- 未改动 dsh-companion 仓库（不满足收录硬门槛，且在 remote-bridge README 中已被引用）。
- 未发布新版本：本轮无运行时行为变更，仅新增静态资产与文档。

## v2.3.6 · 归档不消失 + 手机端交互卡片全灭（两处「想当然」）

用户报「App 会话列表 归档点击后 实际未归档」。归档请求一路返回 200，列表纹丝不动，
看起来像手机端点了个寂寞。

### 根因：链路是通的，过滤集却永远是空的

写入这一侧完全正常：App `POST /chat/sessions/{id}/archive` → router → chat-adapter
→ 桥接 `workspaceController.archiveSession`，内核把会话写进**注册表级**的归档集合
（`WorkspaceRegistry.archivedSessionIds`，持久化在 workspace state，`dsh-workspace`
的 `get archivedSessionIds()` 读的就是它）。

问题在**读**这一侧。`chat-adapter.listSessions` 靠 `api.workspace.list()` 返回的
`archivedSessionIds` 做过滤：

```ts
const archivedSessionIds = new Set(workspaceValue.archivedSessionIds)
...
if (archivedSessionIds.has(session.sessionId)) continue
```

而桥接的 `workspace.list` 把这个字段**硬编码成了 `[]`**：

```ts
// The registry has no notion of plugin-side archived sessions; the
// chat adapter unions this with its own store.
return { items, archivedSessionIds: [] as string[] }
```

那句注释——「注册表没有**插件侧**归档的概念」——对「插件自己建的归档存储」成立，
结论却错得离谱：**归档压根不是插件侧状态**，`archiveSession` 写的正是注册表本身。
于是 `listSessions` 拿到一个永远为空的过滤集，那句 `continue` 一次都不执行。

一句话：**归档确实写进去了，读的时候被自己的空数组抹掉了。**

### 改了

- `dsh-0.2-bridge.ts`：`workspace.list` 改从 `host.workspaceRegistry.archivedSessionIds`
  透传真实集合；`WorkspaceRegistryLike` 补上该 getter 的声明（注释写明它的出处是内核
  `dsh-workspace` 的 `WorkspaceRegistry`，不是插件自定义的约定）。
- 新增 `readArchivedSessionIds()`：getter 缺失（老内核 / 测试替身）时退化成空集合 ——
  过滤失效，但列表本身照常可读，不让一条读路径把整页炸掉。

### 不做什么

- **不动 App 侧**：dsh-companion 的归档调用与「归档后重拉列表」都是对的，
  问题全在服务端这一侧。
- **不引入插件自己的归档存储**：内核已有唯一真源，再分出一份只会制造两份互相打架的状态。
- **不自动传 `stopActivity`**：内核默认拒绝归档**正在运行**的会话
  （`WorkspaceActiveSessionError`），App 会把这条例外显示成错误。要不要顺手停掉会话
  该由用户拍板，不该由插件替他决定 —— 本轮只修「明明成功了却看不见」这一段。

### 测了

- 新增桥接用例 2 条：① 注册表报出的归档集合被原样透传（**把这行修复回退成 `[]` 即失败**，
  已实测复现）；② getter 缺失时退化成空集合、列表仍可读。
- 新增 HTTP 端到端断言 1 条：`POST /archive` 之后，同一个 `GET /chat/sessions`
  不再返回被归档的会话（归档前两条，归档后只剩 fork 出来那条）。
- `pnpm typecheck` 通过 · `pnpm test` **30 个测试文件 / 226 个用例全绿** ·
  `pnpm docs:check` 通过 · `pnpm build` 两个 entry 构建完成。

### 同一个版本里的第二处：手机端**所有**交互卡片全灭

归档修完，用户又报「手机上看不到问题卡片」。追问一句才发现更严重：
**审批卡片也没看到，那次是在电脑端操作的** —— 手机端两类交互（审批 + 提问）一张卡都没有。

#### 逻辑闭环：电脑端都正常，手机端都空白

这本身就把矛头指向「插件到底有没有接住」。**审批那条尤其关键**：`ApprovalBridge` 是
「接管＝否决下游」（不调 `next()`，官方界面就没机会渲染）。插件真接住了的话，
**电脑端反而不会出现卡片**。可电脑端明明弹了 —— 于是只剩一个解释：
**插件的监听器压根没进链**，`sessionId` 没解析出来，直接 `return next()` 让给了官方界面。

#### 根因：一处字段名想当然，两类交互一起废

两个桥的入场判断是同一句：

```ts
const sessionId = sessionIdOfAgent(req.agent)
if (sessionId === undefined) return next()   // 放弃接管
```

而 `sessionIdOfAgent` 当时只查两条：

```ts
if (typeof candidate.sessionId === 'string') return candidate.sessionId
if (candidate.session && typeof candidate.session.id === 'string') return candidate.session.id
```

**这两条在内核里都不存在**：

- 内核 `Agent` 的身份字段就是 `id` —— `dsh-agent/lib/types/types.d.ts:11-14` 的
  `readonly id: SessionId`，运行时由 `dsh-agent-loop/lib/index.js:773` 的 `this.id = id` 赋值；
- `agent.session` 是 `dsh-session` 的 **class** `Session`，**没有** `id` 属性 ——
  session id 挂在 `header.id`（`SessionHeader.id`）。

函数签名里明明声明了 `id?: unknown`，代码却一次都没用。于是**每一个**审批、
**每一个**提问都在第一行被判成「定位不到会话」，然后静默让给电脑端。

#### 改了

- `sessionIdOfAgent` 补齐两条真实来源，顺序为
  `sessionId → id → session.id → session.header.id`；
- 审批测试桩从 `{ sessionId: 'session-1' }` 改成内核真实形状 `{ id: 'session-1' }` ——
  **桩比现实宽容，正是这个缺陷被放行的原因**；另补两条：只有 `session.header.id` 时能认、
  完全定位不到时必须交还下游；
- 新增提问桥用例 3 条 —— 此前**提问桥一条测试都没有**。回退这两条解析，两个 describe
  共 3 条用例如期失败（已实测）。

#### 不做什么

- **没有改 App**：故障全在服务端这一侧，App 的订阅、拉取、卡片渲染都是对的；
- **没有加「从会话历史里猜提问」的兜底**：根因修好后实时链路即恢复，
  再加一层猜测只会多一条会过期、还会重复弹卡的路径。

## v2.3.5 · 给会话补上绝对工作目录，救活手机端的 `@` 补全

用户报「APP 会话中使用 `@` 出现问题，可让选插件授权的根目录」。查下去发现，
**这个 `@` 补全从写出来那天起就没成功列出过一个文件** —— 而且根因是一处
「注释与实现正好相反」的路径语义误解。

### 三层，一层比一层深

| 层 | 问题 | 后果 |
| --- | --- | --- |
| 1 | 会话工作目录 = 授权根本身时，`wireRelative` 返回**空字符串**（`path.relative(root, root) === ''`） | App 把它当成「没有工作目录」，界面显示「读不到这个会话的工作目录」 |
| 2 | App 把**相对根**的 `cwd` 当**绝对路径**送去 `/roots/resolve` | 服务端对相对路径硬拒绝（`PATH_NOT_ABSOLUTE`），补全必然拿不到数据 |
| 3 | App 没有根的 realPath（`RootView` 刻意不含它） | 拼不出官方那种绝对路径 |

第 2 层最要命也最讽刺：服务端 `ChatSessionView.cwd` 的语义一直是「相对授权根的
wire 路径」，而 App 的注释却写着「会话的 cwd 是**绝对路径**，中间必须过一次
`resolvePath` 做翻译」。**那一步翻译纯属多余** —— 会话里本来就有 `rootId`，
列举接口要的正是「根 id + 相对根的路径」，两个值都是现成的。

顺带一个发现：`MentionQuery.absolute` 也按错误语义写的（「cwd + 相对路径」拼接），
而列举接口返回的 `entry.path` 是**相对授权根**的完整路径，会话目录只是它的一段前缀 ——
正确操作是**换前缀**。这条也一并改了，旧单测随之重写。

### 改了（本服务端只承担第 3 层）

- `ChatSessionView` 新增**可选**字段 `cwdAbsolute`：会话工作目录的绝对路径。
  这个值服务端本来就有（`matchRoot` 的入参就是它），而且该会话一定落在**这台设备
  已授权**的根内（不匹配的会话压根不会出现在列表里），所以给出它不扩大可见范围。
- `listSessions` 里把绝对 cwd 收进局部变量，供 `matchRoot` 与 `cwdAbsolute` 共用；
  顺手在契约注释里写明「`cwd` 为空串是合法值，表示会话目录就是授权根本身」——
  这一条正是 App 侧那个判断写错的根源。
- OpenAPI 的 `ChatSession` schema 同步登记该字段（可选、老客户端忽略）。

### 这一版不做什么

**没有改 `cwd` 的语义**。它已经是「相对授权根」，改回绝对既破坏已发布客户端，
又把机器路径铺给所有人。需要绝对路径的地方，由 `cwdAbsolute` 单独承担。
**也没有新增 `reason` 枚举或错误码** —— 任何新增值都会让老 App 掉进更模糊的
兜底文案，比现状更糟。

### 测了

- 新增 1 条用例：**会话工作目录正好等于授权根本身**（也就是线上截图那个场景），
  钉住 `cwd === ''` 与 `cwdAbsolute === <根真实路径>` 两件事。
- 安全断言**没有拆掉**：`chat-adapter.spec.ts` 原本断言「响应 JSON 不含根的绝对
  路径」，加字段后如期失败。处理方式是把例外**精确摘出去**（按 key 过滤掉
  `cwdAbsolute` 再验），防线收窄到一处而不是整条删除。
- `pnpm typecheck` 通过 · `pnpm test` **30 个测试文件 / 221 个用例全绿** ·
  `pnpm docs:check` 通过 · `pnpm build` 两个 entry 构建完成。

## v2.3.4 · 桌面版：profile 参数是目录，不是名字

用户反馈「我的 APP 项目，目前使用桌面版本」，手机插件页红条提示：

> 服务器读不出插件清单：package.json 可能损坏、缺失或没有读取权限。

并特别交代「**你要考虑兼容性**」。这条提示把排查方向带偏了 —— 它听起来像文件出了问题。

### 文件明明是好的

先按提示排除了三个嫌疑：`/home/wangke/.dsh/profiles/desktop/package.json`
**存在**、`0644` 可读、`JSON.parse` 通过。提示里说的三件事一件都不成立。

于是不再猜文件、改为**去问运行中的插件本人**。它监听 `3090`（并内嵌在 WebUI 端口
`36079` 上），对 `/settings/plugins` 的写操作要 `settings.write`，但只读请求走
loopback 管理通道即可 —— 拿到的真实响应是：

```json
{
  "profile": "/home/wangke/.dsh/profiles/desktop",
  "profilePath": "/home/wangke/.dsh/profiles/home/wangke/.dsh/profiles/desktop",
  "available": false,
  "reason": "MANIFEST_UNREADABLE"
}
```

**`profile` 字段本该是 `desktop`，返回的却是一整条绝对路径。** 真相在这里。

### 为什么

内核接受**两种** `--profile` 写法，两者都合法：

- `--profile web` —— profile **名**；
- `--profile /home/u/.dsh/profiles/web` —— profile **目录**。内核启动器文档里写的正是
  `--profile ${basename(profileDir)}`，**内核自己会取 basename**。

而 **`resolveProfileName()` 只认第一种**，把整条路径当成了 profile 名。接下来
`path.join` 又补了一刀：它**不会**因为后面一段是绝对路径就重置（那是 `path.resolve`
的行为），于是拼出：

```
path.join('/home/wangke/.dsh', 'profiles', '/home/wangke/.dsh/profiles/desktop')
= /home/wangke/.dsh/profiles/home/wangke/.dsh/profiles/desktop
                                    ↑ 多出来的一层
```

必然 `ENOENT`。`readJson()` 的 `catch` 把异常吞成 `MANIFEST_UNREADABLE`，界面再把
`MANIFEST_UNREADABLE` 翻译成「package.json 可能损坏、缺失或没有权限」——
**一条把「路径算错了」说成「文件坏了」的误导性提示**。

### 为什么能潜伏这么久

web 版走的是名字形式（`dsh web` / `--profile web`），永远碰不到这条分支。
**只有官方 Electron 桌面版用目录形式启动内核** —— 所以这个 bug 一直躺在那儿，
直到有人在桌面版里打开插件页。

### 改了

- 新增 `normalizeProfileName()`：**含路径分隔符就取最后一段**，不含则原样返回。
  一条规则同时覆盖名字、绝对目录、相对目录、Windows 反斜杠路径、末尾带斜杠五种输入。
- `resolveProfileName()` 的 **4 个取值入口**（`DSH_PROFILE`、`--profile=`、
  `--profile <name>`、子命令简写）**全部**过这道归一化。四者都可能装着一个目录。
- 连带修好 `togglePlugin()`：它共用同一个 profile 判定，所以手机上点「启用 / 停用」
  本会试图往那个不存在的多层目录里写 `package.json` —— 用户只会看到又一次失败。

### 兼容性（用户明确要求的那条）

- **字段一个没加、没删、没改语义**。`tests/plugin-inventory.spec.ts` 里那条字段
  白名单测试（精确断言 `inventory` 只有 7 个键、每个 item 只有 11 个键）**原样通过** ——
  这是刻意的：老版 App 收到的 JSON 结构与 2.3.3 完全一致，只是 `profile` 从路径变成
  名字。纯字符串，界面显示只会更正确。
- **web 版行为不变**：名字形式的四条来源归一化后仍是原值。
- **不新增 reason 枚举值**：新增值会让老 App 掉进 `else` 分支显示
  「服务器暂时无法提供插件清单（…）」，比现在更模糊。宁可不加。

### 测了

新增 8 条用例（`resolveProfileName` 5 条 + `readPluginInventory` 2 条 +
`togglePlugin` 1 条），其中一条直接拿桌面版启动形式做端到端复现：

```ts
await readPluginInventory({
  env: { DSH_HOME: dshHome },
  argv: ['node', '/usr/local/nodejs/bin/dsh', '--profile', profileDir],
})
// 修复前必然 available:false + MANIFEST_UNREADABLE（而磁盘上文件好好的）
```

`pnpm typecheck` 通过 · `pnpm test` **30 个测试文件 / 220 个用例全绿**。

## v2.3.3 · 「插件」页：详情增强 + 手机上直接启停

用户要求「结合官方的插件特点和功能增加对应功能」，选定 A（管理写操作）+ B（详情增强）。

### 先摸清官方那套是怎么运作的

`dsh plugin <任何东西>` 会**原样转发给 pnpm**。实测踩过一次：本想查
`dsh plugin enable --help`，pnpm 直接进了安装流程（打出 `Packages: +4 -85`）——
它在**动依赖树**。所幸 `package.json` 与 `node_modules`（310 个包）都没被改动，
但这条教训决定了后面所有设计。

翻内核源码确认了真正的机制（`profile-boot` 模块注释）：

> stack its patch layers (**bundle layers in `dsh.profile.bundles` order** …)

也就是说 **`dsh.profile.bundles` 数组就是加载清单，而且顺序即加载顺序**。
启用 = 加一个名字，停用 = 删一个名字 —— **完全不必碰依赖**（包还在 `node_modules` 里，
随时能再启用，不用重新下载）。这条路比走 pnpm 精准得多，风险也小得多。

顺带一个实测发现：本机 profile 有 15 个第三方插件，其中 **3 个装了但没在 bundles 里**
（`@liustack/modlens`、`dsh-hyperframes`、`dsh-remotion`）—— 旧版页面虽然能算出
这个状态，但那正是它读不出清单时最该展示的东西。

### B：详情增强

每个插件多带四样信息（都限制在固定几项，**不转发 manifest 原文**）：

| 字段 | 用途 |
| --- | --- |
| `description` | 手机上只有一串 `@scope/name@1.2.3` 时，用户没法判断「这个能不能停用」，描述是主要依据 |
| `homepage` | 从 `homepage` / `repository`（字符串或对象两种写法）里取，剥掉 `git+` 前缀与 `.git` 后缀 —— 否则点开是 git 协议地址，浏览器打不开 |
| `updateAvailable` / `latestVersion` | 有没有新版本 |
| `toggleable` | 能不能在手机上启停（官方包恒为 false） |

**`updateAvailable` 是三态不是布尔**：`null` 表示「没查/查不到」。压成 `false` 会让界面
在离线时理直气壮地说「已是最新」—— 那是谎话，比什么都不说更糟。

版本检查**默认关闭**，要 `?checkUpdates=1` 显式开：每个包一次 registry 请求，
十几个包会让清单从毫秒级变成好几秒，而用户点进这页十次里九次只想看「装了啥、哪个没启用」。
开启时也只查**确实装在 profile 里**的第三方包（官方包用户装不了、缺失包连本地版本都没有），
并发限 6、超时 5 秒、失败即 null 不重试。

### A：启停写操作（`PATCH /settings/plugins`）

请求 `{ name, loaded }`，需要 `settings.write` 权限。**只改 bundles 数组**。三道安全阀：

1. **拒绝改官方包**（`@deepseek-ai/`）：它们随 DSH 运行时安装、不由 profile 管理，
   改 bundles 也加载不出来，只会把清单搞成与实际不符。
2. **写前必备份**：`package.json.bak-<时间戳>` 落在同目录。profile 的 package.json
   一旦写坏，**dsh 下次起不来**，而用户此刻在手机上、够不着电脑 —— 备份是唯一退路。
3. **先写临时文件再 rename**：同分区 rename 是原子的。直接写原文件的话，写到一半
   断电/被杀会留下残缺 JSON，后果同上。

另外两条边界：

- **幂等不产生垃圾**：本来就是目标状态时不动文件、不写备份 —— 重复点不该在磁盘上
  堆一串备份。
- **启用一个没装的包会被拒**（`PLUGIN_NOT_INSTALLED`）：那会得到一个「声明加载却找不到」
  的条目，而用户看到的现象是「插件没了」，说不清哪一步错了。这种情况该走**安装**流程，
  不该在启停入口放过去。

**必须重启才生效**：bundles 只在启动时读一次。响应里固定带 `restartRequired: true`，
由界面明确告诉用户 —— 别让人以为点了没反应。

### 测了什么

- `togglePlugin` 新增 8 条用例：启用追加、停用只摘名字（**不碰依赖声明、不打乱其余顺序**）、
  写前有备份且内容正确、幂等不堆备份、拒官方包、拒未安装、拒畸形包名
  （`../evil` / `a b` / 空 / `x/y/z` —— 包名会参与拼路径，脏输入不该走到 `path.join`）、
  profile 判不出时报 `PROFILE_UNKNOWN` 而不是猜。
- 既有的**字段白名单测试**如期失败了一次（它专门防「顺手把整个 manifest 塞进去」），
  按新字段同步登记，边界意图不变。
- `pnpm check` 全绿：**30 文件 / 212 用例**（上轮 204，+8）。
- OpenAPI 补登了 `/settings/plugins` 的 GET 与 PATCH 及三个 schema ——
  顺带发现这个端点**此前根本没进 OpenAPI**（旧遗漏）。
  中途 YAML 报过一次 `mapping values are not allowed here`：行内 description 里
  写 `restartRequired: true` 的冒号被当成键值分隔，加引号解决。
- **待真机确认**：重启 dsh 后启停一个插件、看是否要重启才生效、备份文件是否落地。

## v2.3.2 · 修「插件」页判定不出 profile（`dsh web` 这种启动形式被漏掉）

用户反馈（手机端「插件」页）：

> 服务器判定不出当前使用的插件档案，暂时读不到插件清单。请确认 DSH 启动时带有 `--profile` 参数。

**但 profile 就在那儿** —— 插件装在 `~/.dsh/profiles/web/`，加载正常，只有这个页面读不出来。

### 根因：漏了一种启动形式

`resolveProfileName()` 此前只认三种来源：`DSH_PROFILE` 环境变量、
`--profile=<name>`、`--profile <name>`。而用户实际的启动命令是：

```
argv = ["node", "/usr/local/nodejs/bin/dsh", "web"]     ← 没有 --profile
环境变量 = 无 DSH_PROFILE
```

于是返回 null，页面老实报「判定不出」。

**但内核的启动器文档写得很清楚**（`@deepseek-ai/dsh/args` 模块注释）：

> `dsh <name>` **abbreviates** `dsh --profile <name>`；`dsh web` boots the web
> profile (**same as: `dsh --profile web`**)

所以 `dsh web` 与 `dsh --profile web` 完全等价，只是 profile 名被写成了子命令。
**这不是「用户没带参数」，是插件漏了一条启动形式** —— 而 `dsh web` 恰恰是大多数
人用的写法（文档示例里第一个就是它）。

### 修法

在原有三条来源之后补第四条：**子命令简写**。判据照抄内核启动器的解析规则 ——
跳过所有选项，第一个非选项 token 就是子命令：

- 跳过 `--flag value` 时**要连取值一起跳**（`dsh --port 3080 web` 里的 `3080`
  不是子命令，只是 `--port` 的值；不跳它就会去读一个叫 "3080" 的目录）；
- `--flag=value` 自带取值，只跳一个 token；
- `plugin` 子命令**单独排除**：`dsh plugin add xxx` 管理依赖、不启动任何 profile，
  把它当 profile 名会去读不存在的目录 —— 比返回 null 更糟（null 至少老实报错）。

另外补了一条**明确不猜**的边界：写了 `--profile` 但取值非法（`--profile --port 3080`）
时**直接返回 null**，不再退回子命令简写。用户明确写了 `--profile` 只是写错了，
这时候猜「大概是想用 web 吧」是在替用户做决定，而猜错的后果是读到另一个 profile 的
清单 —— 比老实报错难排查得多。

### 测了什么

`resolveProfileName` 新增 6 条用例（该 describe 现共 12 条），其中直接复刻出问题机器
的真实 argv：

```
['node', '/usr/local/nodejs/bin/dsh', 'web']      → 'web'
['node', 'dsh', '--port', '3080', 'web']          → 'web'    （跳过选项与取值）
['node', 'dsh', '--patch=a.yml', 'web']           → 'web'
['node', 'dsh', 'plugin', 'add', 'foo']           → null
['node', 'dsh', '--profile', 'tui', 'web']        → 'tui'    （显式旗标优先）
```

`pnpm check` 全绿。**待重启 dsh 后在真机确认那个页面能列出插件。**

## v2.3.1 · 修「加载更早消息」点了没反应（2026-10-13 发布）

手机端会话里点「加载更早消息」，界面纹丝不动。一行修复，但根因值得记下来。

### 根因：`history()` 从来没有分页过

`GET /chat/sessions/:id/messages` 的实现（`src/host/dsh-0.2-bridge.ts`）是**只用 `follow()`
的开场帧**取历史的：拿到第一帧 `snapshot` 就把流 abort 掉，返回 `snapshot.records`。

问题在于它**把 `beforeSeq` 参数整个忽略了** —— 客户端传不传、传什么值，返回的都是同一窗
（最近 N 条）。于是客户端把「更早的记录」和「已有的记录」一合并，`distinctBy { seq }` 一
过滤，结果就是**什么都没多出来**：按钮点了像没反应。

### 修法：走内核 `page()`

`SessionPageRequest` 需要 `throughSeq`，而它的文档写得很明白 —— 必须**取自对应的
`follow()` 开场帧**，硬编码一个（比如 `-1`）会返回 HTTP 200 + 空页，是一种「不报错的
静默失败」。所以现在的分支是：

- **不带 `beforeSeq`**：照旧走 `follow()` 开场帧（行为不变）；
- **带 `beforeSeq`**：先取开场帧的 `cursor` 当 `throughSeq`，再调
  `host.sessionController.page({ address, throughSeq: snapshot.cursor, beforeSeq, maxMessages })`，
  返回 `page.records`。

`SessionControllerLike` 接口相应补上 `page()` 声明。

### 真机效果（实测）

同一个会话：

```
第一页            → 261 事件，seq 104~364，hasMore: true
带 beforeSeq=104  → 104 事件，seq 0~103，  hasMore: false
```

修复前两次返回的都是 104~364 那一窗；修复后第二次真正取回了 0~103 的更早记录。

### 升级须知

插件是进程内加载的，替换文件后**必须重启 dsh 进程**新代码才生效。

---

## v2.3.0 · 设置面板重做为折叠卡片；识图路径并入；默认根与设备清理（2026-10-12 发布）

本轮把几件事一次做完，用户视角的变化按下面顺序排：

### 1. 设置面板换成了 Vision Router 的折叠卡片样式

删掉了顶部的分区导航栏，七张卡片**平铺**、各自折叠、可多张同时展开（此前一次只显示一张，
用户得先点导航再点卡片头，两步才走一步）。配色从自成一派的灰底青边改挂 DSH 原生
`--dsw-alias-*` 令牌，深色模式因此自动跟随，不必另写一套。

顺带清掉 44% 的死样式：文件工作区那套 UI（文件树、编辑器、对话框）在 2.2.0 就搬走了，
JSX 里一个引用都没有，样式表从 12.6 KB 降到 6.2 KB。

### 2. 识图路径（原 dsh-image-paths 0.3.1 并入）

纯文本模型收到图片时，图片落盘到**会话工作目录**下的 `.dsh-images/`，消息里只留路径给
识图工具读；WebUI 里则用官方附件渲染把图画出来给人看。目录名可在设置里改（单段目录名，
1-64 字符），「当前默认」与「兜底目录」只读展示。

### 3. 根目录默认项：DSH 工作区

DSH 当前的工作区会作为**默认根**自动登记 —— 不可删除，但可正常访问（手机照常浏览）。
路径每台机器不同，所以由插件每次启动自动取，不让用户手填。你自己加过的目录不受影响，
仍可自行增删。

### 4. 设备：撤销即删除 + 权限中文化

撤销一台设备现在是**真的从数据库删除**，不再是打个标记留着一串灰字（本机实测曾堆到
32 条历史探针）。授权行随之清除，审计记录保留。

权限码不再露 `chat.read` 这种英文协议码，中文界面显示「读聊天」、英文界面显示
`Read chat`。

### 5. 远程访问：权限可以在配对前勾选

**新增的权限是在「远程访问」里勾选的**：勾什么，生成的配对码就带什么；APP 输入配对码后
这些权限随设备一起生效。此前这里写死全量，勾了也不生效。

配置文本（`DSH1:` 那串）刻意**不跟随勾选**，仍固定最小权限（不含删文件、改设置）——
它是发给别人扫的。

### 数据库变更（升级须知）

- `roots` 表新增 `builtin` 列；`roots.real_path` 的 UNIQUE 约束**已移除**（默认根与你自己
  加的同目录根是两条独立记录，前者不可删、后者可删）。
- 启动时会清理历史遗留的「标记式」撤销设备。已装机器的授权根与配对**不受影响**，
  令牌继续有效，不需要重新扫码。

升级前建议备份 `DSH_HOME/dsh-workspace/`。

---

## 2026-10-12 · 远程访问的权限勾选恢复可用（配对前选权）

> **待真机验证**：已构建、已同步实装目录，**需重启 dsh + 刷新页面**。
> **未发版、未推送**：版本号仍是 2.2.4（bump 等用户发话）。

### 诉求（用户原话）

「远程访问中的权限都选不上了，点了不自动打勾」，
补充：「正是没设备，才在这里生成访问码，选权限，APP 输入码后，权限就自动带上了。」

最后这句点醒了我 —— 这排勾选框是**配对前的选权界面**，不是展示。我把它读成了
「展示会授予什么权限」，还加了 `readOnly` 把它彻底锁死。

同一条链路上，三个版本各错一次，全都栽在同一个盲点：

| 版本 | 写法 | 错在哪 |
| --- | --- | --- |
| 初版 | `checked readOnly` | 七个框全勾，点不动 |
| 上一版 | `checked={deviceScopes.includes(scope)}`，`deviceScopes = devices[0]?.scopes ?? []` | **只有没设备时才会走到这一步**，没设备 → 空数组 → 七框全灰。用户唯一需要它的时刻，正好被弄坏 |
| 现在 | 可交互 state `grantedScopes`，默认全选 | 值随配对请求一起发出去 |

用户点不出来不是巧合，是这两版错误的必然结果。

### 改了什么

- 加 `grantedScopes` state（`useState<DeviceScope[]>`，默认全选，与既有行为一致）和
  `toggleScope`；勾选框去掉 `readOnly`，接上 `onChange`。
- `enableRemote(...)` 与 `createPairing(...)` 不再写死 `[...DEVICE_SCOPES]`，改传
  `grantedScopes` —— 服务端本来就支持（`validateScopes` 校验后透传），只是客户端没送。
- 一个都没勾时**禁用**两个按钮，并给一句说明：`validateScopes([])` 服务端不报错，
  但一台零权限的设备连聊天都读不了，不如在源头拦住。
- 文案改成按场景给三种：有设备 / 没设备 / 一项都没勾。前两版那套「只读展示、改请去设备」
  的说明是错的前提上写的，一并换掉。

### 刻意保留的一处最小权限

配置文本（`DSH1:` 那串）**不跟随勾选**，仍走服务端的 `DEFAULT_CONFIG_SCOPES`
（不含 `files.delete`、`settings.write`）。理由是它是**发给别人扫**的，最小权限更稳；
要完整权限就用配对码。这点在按钮旁加了说明 —— 否则用户会以为「我勾了删除怎么没生效」。

### 验证

`tests/scope-picker.spec.ts` 七条，服务端 + UI 源码契约两头都钉：

- 服务端：子集如实落库、单元素与空集合不炸、未知码（如 `file.read`）报错而非静默忽略；
- UI 源码契约（vitest 没配 jsdom，改为查源码）：勾选框**不得**带 `readOnly`、
  `checked` **不得**来自 `devices[0].scopes`、`enableRemote`/`createPairing` **必须**传
  `grantedScopes` 而非 `DEVICE_SCOPES`。

这三条分别对应上面三个版本各自的错法，已反向验证：把 `grantedScopes` 改回
`[...DEVICE_SCOPES]`，只有最后那条变红。

顺带修了 `tests/purge-drill.spec.ts` 的一次假绿：它断言「真实库里必须还有脏数据」，
可上一轮重启时清理**真的跑成功了**，于是它开始红 —— 那是**前提被自己的成果推翻**，
不是回归。改成在副本里自造三条历史标记设备，`device.purge` 的断言也从「恰一条」
放宽到「至少一条」（真实副本里已经有一条了）。

pnpm check 全绿（30 文件 198 用例）。

---

## 2026-10-12 · 设备：撤销即删除；权限码中文化

> **待真机验证**：已构建、已同步实装目录，**需重启 dsh + 刷新页面**。
> **未发版、未推送**：版本号仍是 2.2.4（bump 等用户发话）。
> **生产库已备份**：`workspace.sqlite.bak-before-device-purge-20261012`。

### 诉求（用户原话）

「设备中 是『已撤销』的可以不显示，也自动从数据库中删除，授权的权限，中文状态下显示中文，
英文显示英文。」

三件事：① 撤销的设备不显示；② 顺手从库里真删；③ 权限码别再露英文。

### 先量了现状：32 条全是已撤销的

```
devices 总数: 32    已撤销: 32    活跃: 0
 - V2080A | revoked: 是 | scopes: [chat.read, chat.write, …]
 - img-probe | revoked: 是 | scopes: [chat.read]
 - e2e-probe | revoked: 是 | scopes: [chat.read, chat.write, …]
 - ICL-AL10 | revoked: 是 | …
```

界面上那一长串灰字就是这么来的 —— 全是历史测试探针和早已弃用的旧手机，没有一个是还在用的。
用户早就看腻了才提的，不是无理取闹。

### 撤销 = 删除，不是打标记

原先 `revokeDevice` 是 `UPDATE … SET revoked_at`，行留着。改成 `DELETE`：

- `device_roots` 是 `ON DELETE CASCADE`，授权行自动清；
- `audit.actor_id` 是**普通字符串不是外键** —— 所以「谁在什么时候撤了谁」这段留痕
  一条不少。删掉的是设备，不是历史；
- `authenticate` 仍保留 `revoked_at IS NULL` 作兜底，万一别处留下标记行，它们依然登不进来。
  两层保险不冲突。

顺序上「先写审计再删」，更符合「记录发生了什么」的直觉。

### 历史 32 条：`purgeRevokedDevices()`

启动时调一次，幂等（没有就返回 0）。**不走 `revokeDevice`**，否则会把「系统清理」记成
管理员逐个撤销，审计失真；它只写一条汇总 `device.purge`。失败只 warn 不拦启动 ——
清理历史数据不该拦住插件起来。

`listDevices()` 也加了 `WHERE revoked_at IS NULL`：撤销已经删行了，再过滤一次是兜住
别处可能留下的标记行，它们不该出现在界面上。

### 权限码中文化

七个码换成人话：`chat.read` → 「读聊天」/「Read chat」，`files.delete` → 「删文件」/
「Delete files」。界面里原来有三处直接渲染裸码（远程访问的只读展示、设备行的权限摘要、
权限编辑的勾选），全部接上 `scopeLabel(locale, scope)`。

`scopeLabel` 用**显式查表**而不是模板拼 —— 白屏那次就是模板拼错键名导致的，
`translate` 查不到会静默降级露出键名（界面上冒出一行 `scopeChatread`）。未知码（老库里
可能有已废弃权限）直接显示原值：宁可难看也不要空白。空权限显示「没有任何权限」。

### 验证

7 条单测（删除而非标记 / 级联但审计留存 / 重复撤销仍 404 / 清理历史 / 权限双语 /
未知码兜底 / 不露键名）+ `tests/purge-drill.spec.ts` 拿**生产库真实副本**演练：
32 条全删、授权行级联、审计一条不少、只写一条 `device.purge`。

顺带修了 `tests/migration-drill.spec.ts`：它拿生产库副本做迁移演练，但生产库**在功能落地
时就已经迁移过一次**，「迁移前带 UNIQUE」这个前提早不成立了 —— 第一版演练就是这么假绿的。
改成用 `rewindRootsSchema()` 把副本**倒回**未迁移状态，演练才真的在测迁移。
**演练的前提会被现实悄悄改掉，发现断言一开始就注定时，要怀疑的是前提而不是代码。**

pnpm check 全绿（29 文件 191 用例）。

---

## 2026-10-12 · 根目录自动带一个「DSH 工作区」默认项（不可删、可访问）

> **待真机验证**：已构建、已同步实装目录，**需重启 dsh + 刷新页面**。
> **未发版、未推送**：版本号仍是 2.2.4（bump 等用户发话）。
> **生产库已备份**：`~/.dsh/dsh-workspace/workspace.sqlite.bak-before-builtin-20261012`。

### 诉求（用户原话）

「根目录可否让默认为当前 DSH 的工作目录吗（不可更改但要显示，但是每个人的可能不一样），
除默认以为，用户可以自行增加。」

两处口径开工前确认过：默认项取 `workspaceRegistry.list()` 的**第一个**工作区（用户明确
「只显示第一个」）；它**当作真正的授权根**——手机端照常浏览，但界面上不能删。

### 为什么必须自动登记，而不是让用户手填

工作区路径**每台机器都不一样**。本机实测（`~/.dsh/storages/workspace.json`）：

```json
"7252d879-…": { "path": "/media/wangke/OFFICE/workspace", "title": "workspace" }
```

DSH 用的是系统文档目录派生的 `<Documents>/deepseek-harness/default-workspace`（见
`@deepseek-ai/dsh-api-workspace-controller/lib/types/default-directory.js`）。手填等于让
用户去猜一个他本来就不该知道的路径。**所以插件每次启动自动登记一次**，靠 `real_path`
的 UNIQUE 约束保证幂等。

### 三条设计取舍

**1. 它就是一条普通的根，不是另起一套特例。** 除了「不能删」，配对、`files.*` 授权、
回收站、写盘全走现成逻辑。少一套需要同步维护的规则，也就不会出现「手机能看见但插件说不认」
这种分裂。

**2. 删除的闸门在数据库层，不在界面。** `removeRoot()` 里判 `builtin` 抛 `ROOT_BUILTIN`。
界面不给按钮只是 UX；API 可能被别处直接调到，闸门必须落在**所有路径都绕不过去**的地方。

**3. 不劫持用户已有的配置。** 本机生产库里已经有一条 `workspace` 根（`builtin=0`，是用户
自己加的）。迁移演练确认：加列后它**原样保留、仍可删除**。`ensureBuiltinRoot` 遇到已存在
的同路径就什么都不做——升级成内置会让「我自己加的根」突然不能删，那是对用户配置的破坏。

### 加列而不是改表

```sql
-- SQLite 的 ADD COLUMN 不认 IF NOT EXISTS，重复执行直接报错
PRAGMA table_info(roots) → 没有 builtin 才 ALTER TABLE roots ADD COLUMN builtin INTEGER NOT NULL DEFAULT 0
```

不能写进 `CREATE TABLE`：已经装过的机器上那张表早就存在，`IF NOT EXISTS` 会整块跳过，
新列永远加不上。这是加列而不是改表的典型理由。

`listRoots()` 的排序加了 `builtin DESC`，让默认项排在第一条——否则用户得自己找哪条是默认。

### 验证

除了 6 条单测（幂等 / 不可删 / 可配对可访问 / 不劫持用户配置 / 排第一 / 迁移可重跑），
另加一条**读本机真实 `workspace.json`** 的集成测试：整套逻辑依赖「注册表第一个工作区就是
当前工作目录」这个前提，前提错了单测照样全绿，真机上就是设��里冒出一条指向别处的根 ——
而根目录配错的后果是手机能看见不该看见的东西。测试写进临时副本库，绝不碰生产库。

迁移已在生产库副本上演练：现有那条 `workspace` 根原样保留、`builtin=0`。

### 第二轮返工：界面上根本不会出现「不可删除」

用户再问：「设置中能让看到刚弄的这个默认目录，且是不可删除状态吗？」

**查生产库才发现首版是个死功能。** 库里早就有一条指向同一目录的根：

```
roots: [{ label: "workspace", real: "/media/wangke/OFFICE/workspace", builtin: 0 }]
审计:  2026/10/8 21:04:06 | root.add | {"label":"workspace"}     ← 用户自己手动加的
```

路径和 DSH 工作区**完全一样**。于是首版那个「尊重用户已有配置」的分支每次启动都命中它、
什么都不做 → **永远没有 `builtin = 1` 的行** → 界面靠 `root.builtin === true` 判断，
用户看到的还是一条普通根、有删除按钮。功能写了，测试也绿，就是不生效。

根子在于我把「尊重用户选择」理解错了层级。用户要的是「**这条要不可删**」，不是
「**这条不能变**」——把这两件事混为一谈，功能就自动失效了。

用户拍板：**另起一条内置的，原来那条保持可删**。

### 去掉 UNIQUE：只能重建表

两条根指向同一目录，而 `roots.real_path` 上有 UNIQUE，第二条根本插不进去。
SQLite 没有 `ALTER TABLE … DROP CONSTRAINT`，只能**重建表**（`dropRootsUniqueConstraint()`）：

- `PRAGMA foreign_keys=OFF` —— `device_roots.root_id` 引用 `roots(id)`，而重建要 DROP
  被引用的那张表，开着外键会直接失败；
- 全程事务，`roots_migrated` 建成、数据搬完、**最后**才 DROP 老表改名，中途失败整体回滚；
- 搬数据用**显式列名**而不是 `SELECT *` —— 老库可能还没有 `builtin` 列（两种迁移顺序
  都可能出现），按列名搬才不会在某一台机器上错位；
- 幂等靠查 `sqlite_master` 里还有没有 UNIQUE，而不是「跑过一次」。

`addRoot` 加了 `allowDuplicate`：默认仍按 `real_path` 去重（用户手加目录时不该冒出两条），
只有 `ensureBuiltinRoot` 绕开它。幂等改由「已存在 `builtin = 1` 的同路径就返回」保证。

### 验证：拿生产库的真实副本演练

重建表有真实数据风险，单测用的是自己造的临时库，跑不出问题。为此加
`tests/migration-drill.spec.ts`：直接复制 `~/.dsh/dsh-workspace/workspace.sqlite`（连
`-wal`/`-shm`）到工作区副本上跑，断言根、设备、授权一条不少，UNIQUE 真的没了，再开一次不得报错。

演练时踩了一个自己挖的坑：第一版用 `new WorkspaceDatabase(...)` 取「迁移前」的 schema ——
可它的构造函数里就调了 `migrate()`，取到的已经是迁移后的结构，那条断言等于什么都没验。
必须绕过这个类，用裸 `DatabaseSync` 直接读文件。**断言「迁移前」时，不能用会触发迁移的东西去取样。**

演练结果：✅ 两条全过（`drill1` 验完整性、`drill2` 验并存后同路径两条且恰有一条 `builtin`）。

生产库备份：`workspace.sqlite.bak-before-unique-drop-20261012`。

pnpm check 全绿（27 文件 183 用例）。

---

### 「不会要求重新扫码吧」——问得对，答案分两半

用户紧接着问：「插件每次启动自动登记一次，不会要求我重新生产远程访问的码吧？」

**不会。** 启动时那次登记只碰 `roots` 表（外加写一条审计），`devices` / `pairings` /
`device_roots` 一行没动。令牌照样有效，`authenticate(token)` 照样认。已用测试钉死：

```
✓ keeps an already paired device authenticated across plugin restarts
✓ does not silently grant the new root to already paired devices
```

第一条连续登记三次（模拟多次重启）后断言 `authenticate(token)` 仍有效、设备 id 与授权
一条没少、老根仍可删 —— 这是「会不会被要求重新扫码」的直接答案。

**但第二件事必须说清楚：新根不会自动授权给已配对的手机。** `device_roots` 是
**配对那一刻的快照**：`exchangePairing` 把 `rootIds` 逐条写进 `device_roots`，之后
新增的根不会自己长出授权行。`authorizedRoots()` 里 `principal.rootIds === 'all'` 只对
**回环管理面**成立，设备面走的是过滤。

这是安全侧的合理默认（不给等于不给），但用户一定会撞上：「设置里明明有这个目录，
手机里就是看不到」。所以根目录卡片底部常驻一句提示，指路到「设备」去勾授权 ——
不能等用户自己撞墙才发现。

pnpm check 全绿（24 文件 176 用例 + docs:check + build）。

---

## 2026-10-12 · 设置面板换成 Vision Router 的折叠卡片样式

> **待真机验证**：已构建、已同步实装目录，**需重启 dsh + 刷新页面**。
> **未发版、未推送**：版本号仍是 2.2.4（bump 等用户发话）。

### 诉求（用户原话）

「把插件 `dsh-remote-bridge` 的设置样式改为 Vision Router 插件的设置样式。」

开工前确认过范围：用户选的是**只改卡片外壳，内部控件保持现状** + 深色模式跟随 + 独立页同步。
独立页那句其实是空条款 —— `src/standalone/` 早已不存在，`/dsh-workspace` 只剩文件 API，
UI 只有设置页内联这一处。共用 `PhoneSettingsBody` / `AdminPanel` / `styles.ts` 改一次即两处一致。

### 改了什么

**1. 外壳换成 `vr-card` 模型。** 照搬 `dsh-vision-router` 的 `daw-card` 三件套：

| 元素 | 作用 |
| --- | --- |
| `daw-card` / `daw-card-open` | 圆角 12px 外壳，展开时换底色 |
| `daw-card-header` | `aria-expanded` 按钮：标题（15px/600）+ 描述（13px/tertiary）+ 旋转箭头 |
| `daw-card-body` | 展开体，顶部一条 `--dsw-alias-border-l2` 分隔线 |

七个分区（根目录 / 远程访问 / 设备 / 识图 / 回收站 / 审计 / App 下载）各自一张卡。
原来每节顶上的内联 `<h3>` 删掉了 —— 标题已经进了卡片头，留着就是同一句话说两遍。

**2. 配色令牌换成 DSH 原生。** `--daw-*` 全部改挂 `--dsw-alias-*`，深浅色因此自动跟随，
不需要写两套。

### 踩到的坑：Vision Router 自己有两个假令牌

扒 VR 的编译产物当蓝本时发现它引了 `--dsw-alias-label-error` 和 `--dsw-alias-label-warning`，
**这两个在 DSH 里根本不存在** —— 全仓搜索 0 处定义。它靠 `var(--a,var(--b,#fallback))`
的兜底链活着，所以从不报错，只是错误色悄悄退回了灰色。

DSH 里真实存在的是 `--dsw-alias-state-error-primary`（→ `static-red-400/600`）和
`state-success-primary`。所以没有照抄，而是用了真名，并加了两条测试守住它：

- `styles.spec.ts`：**卡片规则里不许出现任何硬编码十六进制色值**。写死 `#fff`/`#dfe4e8`
  会让深色模式下变成一块白斑 —— 这正是换令牌要消灭的东西。
- `i18n.spec.ts`：七条卡片描述键**双语全量断言**。抽查挡不住「漏了第 6 条」，
  且缺英文时 `translate` 会退回中文原文，英文界面直接露中文。

### 折叠与切分区的交互

折叠是「当前这张卡」的状态。切分区时 `useEffect` 把 `collapsed` 复位为展开 ——
否则「收起远程访问 → 切到设备 → 切回来发现是空的」很费解。

### 二次返工：对照真机截图发现「只换了壳」

用户拿真机截图和 Vision Router 并排一比，说「区别有点大」。截图说明问题不在细节，在**结构**：

| | 首版（错） | 现在（对） |
| --- | --- | --- |
| 顶部导航栏 | 有，七个分区标签横排 | **删掉**，卡片头自己就是入口 |
| 卡片数量 | 一次只渲染一张 | **七张全部平铺**，想开哪张开哪张 |
| 展开关系 | 单选互斥 | **可多张同时展开** |
| 卡片图标 | 无 | 有（复用原导航栏的 `tabIcon`） |

Vision Router 自己的提示词就写着「多张卡可以同时保持展开」——我首版连这个前提都读漏了，
把「折叠卡片」当成了「带导航的分页」。用户点一下导航、再点一下卡片头才走一步，
两次点击干一件事，这就是差别大的真正来源。

**展开态从 `boolean` 改成 `Set<AdminTab>`**，多张同时展开是自然结果，不需要额外互斥逻辑。
`initialOpen` 决定进页面先展开哪一张（默认第一张），之后完全由用户控制。

**数据加载跟着改口径**：原来只在「切到某个分区」时拉它的数据，现在按「这张卡**展开**了没有」拉。
无条件全拉等于打开设置页就打七个请求，其中五个用户根本不会点开。

### 顺带修的两件事

**1. 控件皮肤没跟上。** 用户上轮选的是「只改外壳」，但截图里青底白字按钮配中性灰卡片，
两套皮肤并排，一看就不是同一个产品。这次把设置页里**实际渲染到**的控件也换成令牌：
输入框（8px 圆角 + 令牌描边）、主按钮（改中性底而非品牌色实心）、配对码块、警告条、
状态药丸、表单标签、勾选项。

**2. 清掉 44% 的死样式。** 文件工作区那套 UI（`.daw-tree` / `.daw-editor` / `.daw-dialog` /
`.daw-token` / `.daw-modal-small` …）在 2.0.4 就搬走了，3.0 起 `/dsh-workspace` 只剩文件 API，
**JSX 里一个引用都没有**。留着不只是占地方：深色模式改造时每个选择器都得重新判断
「它还在用吗」，误改就直接弄坏看不见的页面。样式表从 12.6 KB 降到 6.2 KB。

清理脚本栽过一次，值得一提：第一版用 `css.replace(/\{[^{}]*\}/g, ...)` 想清空规则，
结果它把 `installWorkspaceStyles` 的**函数体也当成 CSS 规则删掉了**，TS2391 当场报错。
第二版先把模板字符串的边界切出来，只在切好的片段里操作。**CSS 清洗脚本必须先隔离
模板字符串**，否则正则分不清 CSS 和 TypeScript。

另外第一版还有个隐蔽误伤：`.daw-icon,.daw-command{...}` 是**逗号合并规则**，
按「选择器含死类名」判定会整条删掉，连在用的 `.daw-command` 一起陪葬。
教训：删规则要按**选择器列表**逐个判断，不能整条按字符串匹配。

---

### 首版白屏事故（已修）

首次装上去重启，**整个设置面板一片空白**。三层原因叠一块，一层比一层难看。

**1. 键名拼错。** `tabDescKey()` 里写的是模板 `` `${tab}Desc` `` → 产出 `rootsDesc`，
而字典里定义的是 `rootsTabDesc`。**七个分区错六个**（只有 `app-download` 侥幸对了，它走显式
分支）。错的那个键不在字典里，`translate` 立刻炸。

**2. `translate` 遇缺键就抛异常。** 它是 `dictionaries[locale][key].replace(...)`，而它跑在
React 渲染路径上 —— 一个不存在的键 = 整个设置面板白屏。缺一行描述，把七张卡里的全部设置
一起搭进去，代价和收益完全不成比例。

**3. 最难看的一层：我用 `as MessageKey` 把警报器按掉了。** 那个断言让 TypeScript 闭嘴，
所以「键名拼错」这条错误类型检查抓不到；我加的测试又只验证「我手写的七条键有文案」，
压根没验证**代码里真正用的**是不是那七条。于是 `pnpm check` 全绿、166 个用例全绿，
然后白屏。绿得理直气壮，红得毫无预警。

修法分两层：

- **改对**：`tabDescKey` 从模板拼接改成显式查表 `TAB_DESC_KEYS`，七个键一眼可查，
  以后加分区漏了也会被 TypeScript 点名（`Record<AdminTab, MessageKey>` 强制穷举）。
- **改脆**：`translate` 缺键不再抛异常，降级成「回退另一种语言 → 再回退成键名」并在控制台
  留痕。最坏情况是某一行露出 `rootsTabDesc` 字面量，一眼看出该补哪条，而不是白屏。

**能抓住它的测试**（已反向验证：把键改回 `rootsDesc`，只有新测试变红，旧的全绿）：

```
FAIL every card description key the UI actually asks for exists in both dictionaries
AssertionError: roots → rootsDesc 缺中文: expected 'rootsDesc' not to be 'rootsDesc'
```

这条测试从 workspace.tsx **源码里抠出映射表**再逐条对双语字典验证 —— 抠源码而不是 import
组件，是因为 vitest 没配 jsdom，而这张表是纯数据。

教训：**键名靠模板拼出来时，别用类型断言糊过去**，那正是最后一道防线。

---

## 2026-10-12 · 并入 image-paths：交接图片在 WebUI 里显示出来，设置里加「识图路径」

> **待真机验证**：已构建、已同步实装目录，**需重启 dsh + 刷新页面**。
> **未发版、未推送**：版本号仍是 2.2.4（bump 等用户发话）；本文案按 v2.2.5 的内容准备。

### 诉求（用户原话）

「把 `dsh-image-paths-0.3.1` 的功能加到我们写的插件 `dsh-remote-bridge` 上，在设置里加上
识图的路径设置及当前默认（不能改）。」

两处口径开工前确认过：识图路径指**图片交接目录**（`会话工作目录/.dsh-images`，默认值
`.dsh-images`）；「不能改」指**「当前默认」那一栏只读**，路径本身可自定义。

### 并进来的两半（原 dsh-image-paths 0.3.1）

| 半边 | 原来长在哪 | 现在长在哪 |
| --- | --- | --- |
| 宿主只读路由 | `/plugin/image-paths/raw?path=…&cwd=…` | `/plugin/dsh-remote-bridge/raw?sessionId=…&name=…` |
| 浏览器图集 | `client.js` 的 `turnTail` 座位 + Conversation Definition | `src/client/handoff.tsx`，同一个座位 |

**功能等价，参数更紧**：原来的路由由客户端给 `path` + `cwd`，服务端再校验「真实路径落在
cwd 内」。现在请求里只有**会话 + 裸文件名**，目录由宿主按会话工作目录推出 —— 和写盘用的是
同一个 `sessionWorkspaceDir()`，客户端连「读哪个目录」都递不进来。一句话：
**写在哪、从哪读，永远是同一套解析**。

判据仍然是「只认交接句式」：行首标记（`🖼️ 图片 N` / `🖼️ Image N`）**在用户消息里**，
行内 `已存到 / 已保存到 / saved to` 后面那个图片地址才被取出。助手正文、上下文注入、
工具输出、文档示例里到处引用 `.dsh-images/…`，一律不碰；`[Image: source: …]` 机器行
与上面那行指的是同一个文件，不再出第二张图。

### 设置里新增「识图」一节（第 4 个分区）

导航栏：根目录 / 远程访问 / 设备 / **识图** / 回收站 / 审计 / App 下载。

- **识图路径（目录名）** —— 可改，存 `settings` 表（键 `image_handoff_subdir`）。校验只收
  **单段**目录名（1-64 字符，字母/数字/点/下划线/连字符；`.`、`..`、含分隔符一律拒，
  返回 `IMAGE_SUBDIR_INVALID`）。允许点开头 —— 默认值自己就是点目录。
- **当前默认（不能改）** —— 只读栏，展示出厂字面量 `.dsh-images`。它是契约：历史交接消息、
  识图工具、手机端都按它写过路径，所以**当前值怎么改，这一栏都不动**。
- **兜底目录（只读）** —— 解析不出会话工作目录（冷会话 / 目录不在任何授权根下）时的落点，
  展示的是交接实际会用的那个目录（生产路径由 `index.ts` 传入，界面与落盘同源）。

改完**立即生效**，不必重启：交接写盘与只读图片路由都通过 getter 现读设置。为此
`createDsh02ApiProxy` 的 `handoffRoots` 也一并改成「数组或 getter」—— 顺带修掉一个既有偏差：
授权根原来是 `apply` 期间的一张快照，新加的根要等重启才参与交接。

### 无 token 路由凭什么安全

浏览器不会给 `<img>` 加 Authorization 头，所以这条路由进不了版本化 REST 的鉴权通道。
四道闸与原插件一致，另加一条更严的：

1. `Host` 必须是回环（DNS 重绑定防护）；跨站请求（`Sec-Fetch-Site`）一律 403；
2. 文件名必须是 `^[0-9a-f]{64}\.(png|jpe?g|webp|gif|heic|heif|bmp|avif)$` —— 目录穿越、
   绝对路径、随便一个 `shot.png` 连查询都不会发生（读图实现**根本不被调用**）；
3. 目录由宿主按会话推出（客户端递不进来）；
4. 字节自证：扩展名声明必须与魔术字节一致，体积上限 32 MiB，空文件当「没有」；
5. 取不到一律 404 且**不区分**「会话不存在」与「文件不存在」—— 区分它等于泄漏哪些会话存在。

### 与独立 image-paths 插件不能同时开

两个插件都会把自己的图集挂在同一个 Turn 尾座位上，同一张图会**画两遍**；路由不同名
（`/plugin/image-paths/raw` 与 `/plugin/dsh-remote-bridge/raw`），互不覆盖、只是重复。
正确做法是**停用独立插件那一行**（`cordis.patch.yml` 里删掉，或从 profile bundles 里移除）。
本次同步实装目录**没有**动 profile 配置 —— 这一步是用户的开关，见文末「待办」。

### 验证

- `pnpm typecheck` 通过。
- `pnpm test` **22 文件 / 163 用例全绿**（+35）：新增 `tests/image-handoff.spec.ts`
  （设置校验与坏值修复、格式自证、同源判据、路由的 200/400/403/404/405/413/415、格式错配、
  超大与空文件、`/manage/image` 读写与非法值）与 `tests/client-handoff.spec.ts`
  （中英与旧文案的句式解析、只认用户消息、噪声不解析、去重与 8 张上限、URL 只带裸文件名）；
  `dsh-0.2-bridge.spec.ts` 新增「识图路径改完，写与读一起跟着走」；`i18n.spec.ts` 补新标签
  与「只读」措辞。
- `pnpm build` 通过（host 200.5 kB / client 680 kB）；`lib/` 已同步到
  `~/.dsh/profiles/web/node_modules/dsh-remote-bridge/`，**含 client.cjs** —— 上一轮只同步了
  host 产物，而这次客户端也变了，漏了它就等于「服务端会取图、界面不会画图」。
- **真机核验待做**：重启 dsh → 刷新 WebUI → 往纯文本模型会话发一张图，应看到「图 + 路径」
  两样都有；设置页「识图」一节应显示当前值 `.dsh-images` 与只读的「当前默认」。

## 2026-10-11 · 交接文案改成人话，并按客户端界面语言分流

> 已发布 **v2.2.4**（npm，`latest`），并双推 GitHub / Gitee。需重启 dsh 生效。

### 为什么改

用户对交接那条消息的反馈是「把提示改为能看懂的」。旧文案第一行写的是
「当前模型不支持图片输入，已保存到工作目录 …；请先用读图工具打开下面那行的绝对路径，
看清内容再回答」—— 这是**写给机器看的祈使句**，却挂在用户眼前：术语（「图片输入」「绝对路径」）
加指代（「下面那行」），双重劝退。

### 现在长什么样

第一行改成两句人话，仍然留在同一行内（客户端按行首标记**整行**摘除，多一行会露在手机上）：

- 中文：`🖼️ 图片 1「shot.png」（当前模型看不到图，已存到 .dsh-images/xxx.png；要看图，请用识图工具打开下面那行的路径）`
- 英文：`🖼️ Image 1 "shot.png" (this model can't see images, saved to .dsh-images/xxx.png; to view it, open the path below with an image-reading tool)`

第二行 `[Image: source: <绝对路径>]` 是机器契约，跨语言不变。

### 语言从哪来

HTTP `Accept-Language` 一路带下来：`router`（读头）→ `chat.prompt` → `apiProxy.prompt` → 图片交接。
`locale` 是**我们自己加的字段**，调内核前会被摘掉 —— 内核的 prompt 入参是严格形状，
多一个字段就可能被拒（这条有测试钉着）。

判不出来就退回中文（既有口径，不猜）。识别规则：按客户端排的优先级取第一个认识的 `zh*` / `en*`。

**要真正跟随英文界面，客户端得把语言带出来**：`dsh-companion` 已在 `DshClient.authenticated()`
统一加了 `Accept-Language`（取自 App 的语言设置）。**这一项要等下次出包 + 安装才生效**；
在那之前手机端发图仍是中文文案（插件、WebUI 侧不受影响）。

### 验证

`pnpm typecheck` 通过 · `pnpm test` 20 文件 / **128 用例全绿**（+2）：
新增「speaks the client interface language, and never leaks our field to the kernel」
（英文文案 + `locale` 不出现在内核入参里），以及 `handoffLocaleOf` 的取值规则。
`dsh-companion` 侧 `./gradlew :app:compileDebugKotlin` 通过（仅编译，未出包）。

> 编译要显式指定 JDK：这台机器的 `java` 不在 PATH 上，得给
> `JAVA_HOME=/media/wangke/OFFICE/workspace/android-toolchain/jdk17`。
> 另外**不要用 `./gradlew … | tail` 判断成败** —— 管道会把退出码替换成 `tail` 的 0，
> 第一次就因为这样把「JAVA_HOME 未设置、根本没编译」误读成了「编译通过」。

## 2026-10-11 · 交接文本追加动作指令：只递路径，模型不一定去读（发布 v2.2.3）

> 真机实测后的补丁。已 publish 到 npmjs，`latest` tag = 2.2.3。DSH 下次自动更新或手动 reinstall 即可拿到。

### 为什么加

重启后交接链路已经通了（20:47:43 图正常落到工作区 `.dsh-images/`，路径也进了消息），
但真机上出现新现象：用户发「看图，不操作」+ 图，那一轮的模型**并没有去读那张图** ——
它先去加载界面技能，图放着没看，用户看到的是「你啥都不显示」。

结论：**只递路径是「可以读」，不等于「被要求读」**，所以要在交接文本里明确要求。

### 怎么加（以及为什么不新增一行）

指令塞进原有的第一行，**不另起一行**：

```
🖼️ 图片 1「274938.jpg」（当前模型不支持图片输入，已保存到工作目录 .dsh-images/xxx.jpg；请先用读图工具打开下面那行的绝对路径，看清内容再回答）
[Image: source: /绝对路径/.dsh-images/xxx.jpg]
```

理由：客户端（dsh-companion）摘除交接行是按**行首标记**（`🖼️ 图片 ` 与 `[Image: source:`）
整行摘掉的，不看括号里的字。所以把指令塞进原行，**手机端不必跟着出包**；
若新增一行，那一行会被当成正文显示在手机上。

### 验证

`pnpm typecheck` 通过 · `pnpm test` 20 文件 / 126 用例全绿 ·
新增断言两条：指令存在、且交接文本恰好两行（防回归）。
`pnpm build` 后已同步到实装目录（sha256 与仓库产物一致）。
**v2.2.3 已 publish 到 npmjs（latest tag），DSH 下次自动更新即可拿到。**

## 2026-10-11 · 修「刚切到纯文本模型就发图，图片仍被内核拒收」

> **真机报障 → 定位 → 修复**：已构建并同步实装目录，**需重启 dsh 生效**。未发版、未推送。

### 现象（用户真机截图原话）

```
DSH_SESSION/ATTACHMENT_INVALID: Model "agnes-2.5-flash" does not support image input.
```

用户把会话切到 `agnes-2.5-flash`（纯文本）后发图，仍被内核拒收 —— 图片交接没有触发。

### 核数据的过程（不靠猜）

1. 先排除「插件版本旧」：dsh 进程 19:47:32 启动，**晚于**插件实装 19:44:31 ✓
2. 再看有没有落盘：`.dsh-images/` 里只有 19:48 / 19:50 两张老图，**这次没有新文件**
   → 交接确实没跑。
3. 回放会话事件（`session-8c2fc46f`）：20:37:20 切到 agnes-2.5-flash，20:38:31 切回
   deepseek-flash，20:39:03 才发出那条带 image 部件的消息 —— 失败发生在两次切换**之间**。
4. 对照内核源码看两侧口径：
   - 内核拒收用 `agents.selectionFor(agent).current`（`pending` 优先）；
   - 本插件用 `projections().values.modelSelection`。

### 根因：读错了投影的字段名

内核投影对外给的是 **wire 视图**：

```js
// dsh-api-session-controller/lib/index.js
view: (state) => ({ lastUsed: state.lastUsed, next: state.pending ?? state.lastUsed })
```

`pending` 只存在于**内部 state**；`dsh-session-projection` 组装对外值时是
`values[key] = wire.viewSchema.parse(wire.view(state))`（第 259 行），
所以对外**只有 `lastUsed` 与 `next`**，没有 `pending`。

插件两处都写了 `selection?.pending ?? selection?.lastUsed`：
`pending` 恒为 `undefined` → 一路退回 **`lastUsed` = 上一次真正跑过的模型**。
用户刚切模型、还没用它跑过一轮时，拿到的是旧模型 → 判定「旧模型支持图片、不用插手」
→ 图片原样交给内核 → 内核按**真实当前模型**拒收。

这也解释了为什么 19:48 那次能成功：当时会话一直在用同一个模型，`lastUsed` 恰好等于当前值。

### 改了什么

- `dsh-0.2-bridge.ts` 两处（`currentModelSelection` 与 `sessions.models` 的 `current`）
  由 `pending ?? lastUsed ?? catalog.default` 改为 **`next ?? lastUsed ?? catalog.default`**
  （保留 `lastUsed` 兜底：老内核的 wire 视图没有 `next`）。
- 顺带修好一个同源偏差：客户端「当前模型」此前也读到 `lastUsed`，
  切完模型要等它真跑过一轮才更新。

### 测试为什么没拦住，以及怎么补的

原测试桩照**内部 state** 写 `{ lastUsed, pending }` —— 正是实现读错的那个名字，
于是「桩与实现同错」、一路全绿。改法：

- 所有投影桩改成真实 wire 形状 `{ lastUsed, next }`；
- 新增「切换后立刻发图」回归用例：`lastUsed` 是**支持图片的旧模型**、`next` 是
  **纯文本新模型**，且 `resolveModelInfo` 桩**不再无视参数** —— 读错字段就会拿到
  「支持图片」的结论而不交接，用例立刻失败；
- 新增「老内核没有 `next` 时退回 `lastUsed`」用例。

### 验证

`pnpm typecheck` 通过 · `pnpm test` **20 文件 / 126 用例全绿** ·
`pnpm build` 后产物里两处都是 `selection?.next ?? selection?.lastUsed`（`pending` 残留 0 处），
已同步到 `~/.dsh/profiles/web/node_modules/dsh-remote-bridge/lib/`（sha256 与仓库产物一致）。
**真机复现待做：需要重启 dsh 进程。**

## 2026-10-11 · 纯文本模型也能发图：图片交接（零插件依赖）

> **待真机验证**：已同步实装目录，需重启 dsh 生效。**未发版、未推送。**

### 诉求

用户原话：「模型不支持图片，图片就发不出去……我装的有图片识别插件，如何能让我发出去，
让插件去识别，**不要从入口阻拦**。」以及关键约束：
「你判定了插件，是不是我以后必须装这个插件，装其他插件又不行了」——
明确拒绝把手机端绑死在任何一个具体识图插件上。

### 谁在拦

是**内核**，不是 App 也不是本插件：`dsh-api-session-controller` 的 prompt 准入里，
内容只要含 `type:'image'` 部件，就调 `ctx.llm.resolveModelInfo()` 查模型元数据，
`inputModalities` 已声明且不含 `image` 时抛 `MODEL_DOES_NOT_SUPPORT_IMAGES`。
内核给「视觉插件」**没有**预留接缝（grep 过，没有 batch-attachments 之类的服务钩子）。

桌面 WebUI 里 modlens 自带一个「浏览器半边」：确认当前模型只支持文本时，把粘贴的图
POST 到它的 `/modlens/paste` 落成临时文件，输入框收到的是**路径文本**，于是消息里
没有 image 部件，准入自然不触发。手机端是另一个客户端，拿不到这个浏览器半边。

### 做法：把缺的那半步做在本插件里，但不引用任何插件

- **判定**用内核自己的 `ctx.llm.resolveModelInfo()`（`LlmLike` 补了这个方法）——
  与内核拒收时查的是**同一份元数据**，结论逐字一致；模型选择按
  `projections().values.modelSelection`（pending > lastUsed > 目录默认）取。
- **动作**只做一件通用的事：图片解码落文件、消息里给路径，
  **任何按路径读图的工具都能接手**，不出现任何插件名。
- 三条保守原则，宁可退回原样：元数据缺失（`undefined`）不动、模型声明了 image 不动、
  落盘失败不动（try/catch 包住整个交接）。拿不准就走原路，与内核「未声明模态不拒」一致。
- 总开关 `createDsh02ApiProxy(host, { imageHandoff: false })`，默认开。

### 落地位置与消息形态（按真机反馈改过一轮）

第一版把文件写进 DSH 私有目录、消息里只有一条 `<image …path>` 裸标签，
真机验证后用户提了两点：① 应落到**工作目录**而不是 DSH_HOME；② 裸路径只适合机器读，
不符合人类阅读习惯。改成：

- **落点优先会话工作目录**：用 `sessionController.list()` 找会话 `cwd`（冷会话也有，
  不依赖 live agent），与注入的授权根（`handoffRoots`，由 index.ts 从数据库给）匹配出
  真实路径，写到 `<工作目录>/.dsh-images/<sha256>.<ext>`（目录 0700、文件 0600、
  内容寻址去重）。匹配不到根/解析不出工作目录时，才退回 `<dataDir>/image-handoff`
  这个 DSH 目录兜底——无论如何不能让发消息失败。
- **一条 image 部件换成两行文本**，同一处信息伺候两类读者：
  - 给人看：`🖼️ 图片 N「原名」（当前模型不支持图片输入，已保存到工作目录 .dsh-images/xxx.jpg）`；
  - 给机器看：`[Image: source: <绝对路径>]`——这是识图技能明确列出的触发形状之一
    （带图片扩展名的绝对路径同样触发），换任何读图工具都认，不绑插件。

### 取舍说明

- 纯文本模型下，这条消息在历史里是**文件说明文本而不是图片缩略图**——桌面 WebUI 的
  「paste-to-path」本来也是这个样子；模型本身支持图片时仍走原生 image 部件，缩略图不受影响。
- 没走「file 附件」那条路：内核把 file 部件也只存成一个**没有路径的引用**，
  agent 未必拿得到可读路径，不牢靠。

### 验证

`pnpm typecheck` 通过 · `pnpm test` **20 文件 / 124 用例全绿**（7 个交接用例：
工作目录落地+人话消息、匹配不到根退回兜底、视觉模型→原样、元数据缺失→原样、
纯文本消息不查元数据、同图去重、可关闭）。已构建并同步实装目录。
**第一版（裸标签 + DSH 目录）真机跑通过识图；改后的工作目录版待重启验证。**

## 2026-10-11 · v2.2.4（建议）修「历史图片永远显示不出来」：走内核 sessionController.attachment

> **✅ 真机验证通过**（2026-10-11 18:51）：用户确认历史图片与刚发图片都显示了。
> 诊断日志铁证：`sessionController.attachment ✓ 139215 bytes · image/jpeg`、
> `✓ 211964 bytes · image/webp`，0 失败。诊断代码与 `.attachment-diag.log` 已清理。
> **未发版、未推送**：等用户发话再走 `pnpm check` + publish。
> 版本号建议 v2.2.4（当前 package.json 仍是 2.2.2，bump 留到发版时做）。

### 这一节纠正了我自己的两次误判

排查这个 bug 我走过两段弯路，都是因为**没先看真进程的诊断日志**，光从源码推：

1. 第一次：以为附件存储没数据（`profile bundles` 缺附件服务）→ 实测 35/35 个 id 全部命中磁盘，错的。
2. 第二次：以为是**缺四项元数据**（客户端没把 `mediaType`/`bytes`/`width`/`height` 传给 `ctx.attachments.readImage`，会被内核完整性校验 `ATTACHMENT_CORRUPT`）→ 从源码看这个判断成立，于是改客户端把四项带上来。
3. **真因**（重启后读 `.attachment-diag.log` 才看到）：真进程里 **`ctx.attachments` 是 `MISSING`** ——
   这条 profile 根本没有把附件存储挂成可注入服务（`dsh-attachment-local` 只是个库）。
   我在 vitest 里看到的 `OK` 全是测试桩噪音（mock host 当然有 attachments），不是真进程。

教训记牢：**测试桩不是运行时，能拿到日志就别从源码猜。**

### 正路：让内核自己取，插件不碰 ctx.attachments

内核主机端本来就有方法 `SessionController.attachment({sessionId, attachmentId})`
（`dsh-api-session-controller/lib/index.js`，客户端契约里叫 `readAttachment`）。
它内部一次做完三件事：

1. `readSessionState(sessionId)` —— 确认该会话确实引用了这张图（`referencedImage`）；
2. 调 `ctx.attachments.readImage(ref)` —— **ref 是它自己从会话事件里取的真实引用**；
3. 用真实 ref 做完整性校验，返回 `{ attachment, data }`（`data` 是 **base64 字符串**）。

我们绕开它自己调 `ctx.attachments`，既拿不到注入属性、又得自己复刻这三件事 ——
完整性校验正是先前 `ATTACHMENT_CORRUPT` 的来源。

### 改了什么

- `dsh-0.2-bridge.ts`：`readAttachment` 改为调 `host.sessionController.attachment({sessionId, attachmentId})`，
  并把返回的 base64 **解码成 Uint8Array**；`SessionControllerLike` 补 `attachment()` 声明。
  不再读 `ctx.attachments`（`optionalService(host,'attachments')` 只剩诊断观测用）。
- `chat-adapter.ts`：`readAttachment(principal, sessionId, attachmentId)` —— **sessionId 必需**
  （内核要靠它读会话事件、定位真实 ref），并保留会话归属校验；撤掉上一轮的 `ref` 参数。
- `router.ts`：附件端点改为从 query 取 `sessionId`（缺失即 400 `BODY_INVALID`），
  撤掉 `attachmentRefFromQuery()` 和 mediaType/bytes/width/height 四项 —— 真实 ref 内核手里本来就有。
- 测试重写：`dsh-0.2-bridge.spec.ts` 断言「调 sessionController.attachment、**不调** ctx.attachments、
  base64 正确解码、内核报错原样透传」；`attachment-api.spec.ts` 改为钉 sessionId 转发与缺 sessionId 返回 400。
- 一次性诊断写 `.attachment-diag.log`（**不依赖 logger**：dsh 是前台进程，logger 走 stdout
  到用户终端、不落盘，`/proc/<pid>/fd/1 -> /dev/pts/0`，实测读不到）。定位完成后这段应删。

### 验证

`pnpm typecheck` 通过 · `pnpm test` **20 个文件 / 117 用例全绿** ·
`pnpm docs:check` 通过 · `pnpm build` 通过，且已同步到实装目录。
**图片能否显示待真机验证**（需重启 dsh + 装新版 App v2.2.24）。

### 客户端配套（详见 dsh-companion 的 CHANGELOG-DEV）

`DshClient.readAttachment(sessionId, attachmentId)` 把 sessionId 拼进 query；
`HarnessViewModel.loadAttachmentImage` 用当前 `selectedSessionId` 调用，不在任何会话时直接返回。
撤掉了上一轮的 `referenceOf()` 与四项元数据透传（内核不需要）。

## 2026-10-11 · v2.2.3 把 `turn/end` 的失败原因送出去：新增 `chat.turn.failed` 帧

> **未发版、未推送**：等用户真机测试通过后再走 `pnpm check` + publish。
> 版本号建议 v2.2.3（当前 package.json 仍是 2.2.2， bump 留到发版时做）。

### 为什么

用户真机报的 bug：**模型限流（429）之后，手机端一直在傻傻地等。**

抓到的原样报文：

```
本轮运行失败429: {"code":"","message":"您已达到免费用户的 API 速率限制。升级 Token Plan
即可解锁更高限额，继续不间断使用 API。 (request id: 20261011054136674823028JzjiUYGm)","type":"AgnesAI_error"}
```

### 根因（三处断点，缺一处就还是"傻等"）

1. **内核**把失败写在 `turn/end` 的 `data.reason` 里：`reason.kind === 'error'` 时
   错误详情在 `reason.error = {message, code}`。权威判据见
   `dsh-client-ui-chat/lib/client.js` 的 `turn-error.js`（`failureFrom` / `match`）。
2. **插件** `normalizeDshEvent` 的 `turn/end` 分支只转 `type`，把 `reason` **整段丢掉** ——
   于是限流、配额用尽、密钥失效这些终局失败，在客户端眼里与「正常跑完」一模一样。
3. **客户端**只认 `chat.turn.end`，且历史里 `turn/end` 落进 `else -> emptyList()`。

也就是说，那句话从来没到过手机。用户看到的是「转圈」，而真相是「早就失败了」。

### 改了什么

- `chat-adapter.ts`：`turn/end` 命中失败判据时，**额外**发一帧 `chat.turn.failed`
  （id 为 `<rpcId>:failed`），`data.failure = {message, code, stopped?}`。
  正常收尾仍然只发 `chat.turn.end` —— 一个失败只有一帧，客户端不会收到两个信号。
- 新增并导出纯函数 `turnFailureOf(event)`，判据与内核 `turn-error.js` **逐条对齐**：
  只认 `reason.kind === 'error'` 与「登出导致的 aborted」，**不能多也不能少**。
- `docs/api/asyncapi.yaml`：新增 `ChatTurnFailed` schema，并把该帧加进事件类型示例。
- `tests/chat-adapter.spec.ts`：新增一个用例，用**用户报文原样**钉住 429 那一条，
  外加登出停止、AUTH 空 message、以及四种不该报失败的收尾（含 `max-tokens` 与老帧）。

### 三个刻意的不做

1. **不翻译 message。** 服务端那句话本身就是中文，且本地化是客户端的职责
   （与官方 `failureMessage()` 的划分一致）。插件只做搬运。
2. **`max-tokens` 不当失败。** 那是「回答被截断，已有输出保留」，官方渲染成黄色警示。
   报成失败会让用户以为白跑了一轮。
3. **AUTH 的 message 不补。** 内核 `displayFailure` 把它抹成空串，客户端用本地化文案
   「API 密钥无效」顶上。插件补一个字，就两头不一致了。

### 验证

`pnpm typecheck` 通过 · `pnpm test` **19 个文件 / 114 用例全绿**（新增 1 个用例）·
`pnpm docs:check` 通过。

**✅ 真机验证通过**（2026-10-11）：用户重启 dsh + 装 App v2.2.24 后，
429 限流被如实显示在客户端上。

### ⚠️ 踩到的坑：改了 lib/ 并不等于改了跑着的插件

这是本轮**真被绊了一跤**的地方，值得单列：

1. `lib/index.js` 是 tsdown 的产物，只在 `pnpm build` / `prepack` 时重建 ——
   改 `src/` 之后**必须** `pnpm check` 才落到 lib/；
2. 就算仓库里的 lib/ 重建好了，**DSH 加载的是另一个副本**：
   `~/.dsh/profiles/web/node_modules/dsh-remote-bridge/lib/`。
   实测那个目录里的版本号是 2.2.1、`chat.turn.failed` 计数为 0 ——
   仓库却是 2.2.2 且已含新帧。**两边 package.json 只差版本号**，说明是打包/拷贝过去的实体副本，
   没有任何链接关系；
3. 插件是**进程内加载**的：实测 dsh 进程启动于 13:12，而插件目录 13:21 才被写入 ——
   不重启，跑的就是旧代码。

所以完整动作是三步，缺一步就是"App 变了但没反应"：

```bash
pnpm check                                                  # ① 重建 lib/
cp lib/*.js lib/*.d.ts ~/.dsh/profiles/web/node_modules/dsh-remote-bridge/lib/   # ② 同步到实装目录
# ③ 重启 dsh —— 用户操作，重启会掐掉正在跑的这个会话
```

> 备份留在 `.local-backup/web-profile-2.2.1/lib/`（插件仓库内，不入版本库）。
>
> 更稳的做法是给实装目录建符号链接指向仓库的 lib/，从此不再有"两份"这个问题 ——
> **本轮没做，等发版时一并考虑**。

（`docs/project/CHANGELOG-DEV.md` 里 `pnpm build` 不查类型那条旧教训依然成立。）

## 2026-10-11 · v2.2.2 接住 `user-questions/request`：手机端可显示并回答提问

### 为什么

内核的 `ask_user_question` 有两条路：带 `timeout` 的走 `askTimed`（超时后进投影变成
`continued`，可迟到补交），这条路早就通了；**不带 `timeout` 的走 `ask()`，唯一入口是
host 钩子 `user-questions/request`**，此前完全没接。

实测 15 个真实调用样本，参数键**清一色只有 `questions`**（没有一个带 timeout）——
也就是说绝大多数提问走的是那条没接的路。

### 改了什么

- 新增 `QuestionBridge` 接住钩子；**先委托再竞速**：进入即 `next()` 把卡片交给官方
  WebUI（电脑端照旧能答），同时留一份给手机端，先答者胜。这样不必抢注册顺序。
  形状不认识 / 已中止 / 表满一律整条委托，绝不让 agent 拿不到答案。
- 新增两个端点（已写入 OpenAPI）：`GET /chat/sessions/{id}/questions`、
  `POST /chat/sessions/{id}/questions/{callId}/answer`。
- 新增三个 WS 帧：`userQuestions/requested | answered | dismissed`。

### 踩到的坑（详见 RETRO-question-card.md）

1. **`callId` 只在 `wait` 里，而 `wait` 只有 `askTimed` 才加。** 最初的判据「拿不到
   `wait.callId` 就整条委托」等于**把 plan 模式整条挡在门外** —— 那种 request 直接
   交给官方界面，于是**电脑端有卡片、手机端一帧收不到**。两个现象同一个原因。
   现改为缺失时自造 `bridge-<uuid>`。
2. **`pnpm build` 不查类型。** 清临时诊断时删了构造器参数却漏改调用处，build 一路绿灯，
   是 `npm publish --dry-run` 的 `prepack → tsc --noEmit` 才抓到。**直接 publish 会失败。**

### 验证

`pnpm check` 全绿：tsc --noEmit · 19 个测试文件 / 113 用例 · docs:check · build。
**问答卡片经真机端到端验证通过**（内核提问 → 钩子 → 插件推帧 → App 渲染 → 作答 → 答案回到内核）。

## 2026-10-09 · v2.2.1 README 增加 npm 安装方式

### 为什么

插件在 2.2.0 之后已经发布到 npm（`dsh-remote-bridge`，官方源 + npmmirror 都有），
但 README 只列了 GitHub / Gitee 两个 Release tarball 的装法 —— 最省事的那条路没写出来。

### 改了什么

README 中英两份的安装段从两种变成三种，并把 **npm 包名放在首位**：

```
dsh plugin --profile web add dsh-remote-bridge                                  # 推荐
dsh plugin --profile web add dsh-remote-bridge --registry https://registry.npmmirror.com
```

推荐它是因为装的是**预构建产物**，pnpm 不会要求构建授权 —— 这也是 DSH 插件清单
（awesome-dsh-plugin）指南的推荐做法。项目信息一节补了 npm 链接。

### 一件先验证再写的事

记不清 `dsh plugin add` 是否接受 `--registry`（印象里有两种相反的说法），所以实测两次：

- 该子命令的 `--help` 输出的其实是 **`pnpm add` 的帮助**，其中明确列有
  `--registry <url>  The registry to use for the installation` —— 它就是转发给 pnpm 的；
- 用 `--registry https://registry.invalid.example` 做证伪：pnpm 明确去访问该域名并以
  `ENOTFOUND` 失败；去掉该参数则照常成功。说明这个 flag 真的生效，不是被静默忽略。

### 顺带

发版流程第 1 步改为**用 `npm pack` 产出 Release 产物**（见
[RELEASE.md](./RELEASE.md)）：2.2.0 那次用的是 `pnpm pack`，产物与 npm 上那份哈希对不上
（文件清单一致、内容一致，只差 npm 改写的 package.json 元数据），对账时容易误判。

## 2026-10-09 · v2.2.0 删除独立页，包体 1.72 MB → 0.25 MB

### 为什么删

`/dsh-workspace` 独立页（文件树 + CodeMirror 编辑器）自 2.0.4 起就已经不在桌面设置里，
只剩它自己那一套入口。删它的依据不是「代码不好看」，而是**能力已经有人做过了**：
手机 App 的文件页原生覆盖同一套操作（列目录、上传下载、重命名、移入回收站），走的是同一组
REST 端点；桌面上这个页面没有人用。留着它，等于同时维护两份文件管理界面，
并为其中没人用的一份付 7 倍体积。

### 删了什么

- `src/standalone/`（独立页入口）与 `assets/workspace.html`
- `src/client/editor.tsx`（CodeMirror 6 封装）
- `workspace.tsx` 里的 `WorkspaceApp`、`DirectoryNode`、`CommandDialog`、`AdminOverlay`
- `scripts/test-server.ts`
- 8 个 `@codemirror/*` 与 `@lezer/highlight` 依赖

发布包因此从 **1.72 MB 降到 0.25 MB**（`artifacts/dsh-remote-bridge-2.2.0.tgz`，
264,167 字节，SHA-256 `6c3301f8a2110a63daf5c51865e2f2bec9e6cb893740694b79aa8afd7db899b5`）。

### 保留了什么（这条比删除本身重要）

**删的是页面，不是接口**：

- `/dsh-workspace-api` 代理前缀原样保留 —— 已发布的 App 把它写死了，删掉等于让所有在用的手机失联；
- `/roots`、`/roots/{rootId}/entries`、`/roots/{rootId}/content`、`/roots/resolve`、`/trash`
  等 REST 文件端点一个没动，**手机 App 的文件功能完全不受影响**；
- 设置面板六个分区（根目录 / 远程访问 / 设备 / 回收站 / 审计 / App 下载）一个未减。

所以这次是**减界面，不是减能力**。代价也要说清楚：桌面端从此没有文件管理界面，
在电脑上动文件只剩两条路 —— 在会话里让 agent 用工具读写，或者自己开终端。
`Playwright` 配置里那句「插件唯一能打开的网页」也随之失效，这一层现在只测面板计算样式。

### 为什么顺手关掉 source map

`tsdown` 改 `sourcemap: false`。映射本身约 5 MB，而插件发的是**预构建 bundle**、
包内并不含原始 TypeScript 源码 —— 拿不到源码的映射对排障没有价值，只白占体积。
这一次体积和可调试性不冲突：删掉它两头都更好。

### 验证

`pnpm check` 全绿：`tsc --noEmit`、**19 个测试文件 / 113 个用例**、
`docs:check`（9 份项目文档、38 项任务、6 份 ADR 与 API/SDK 版本一致性）、两个 entry 构建完成；
另有 **3 个浏览器层用例**（Playwright 用真实浏览器量「手机设置」面板的计算样式）。

## 2026-10-09 · v2.1.3 回收站页补来路说明

### 为什么

用户反馈**「回收站 我一直没找到用途」**。这句话指向的不是缺功能，是**功能在但没用**：
桌面面板自 2.0.4 起已不含文件树，从这里根本删不掉任何文件，于是列表永远是空的 ——
一个空页面当然没人知道它是干什么的。

所以这一版没有加任何能力，只在页首补了说明：只列出来自手机 App 或独立页
`/dsh-workspace` 的删除记录；文件先来这里而非直接消失，可恢复，永久清理也在此发起。

把「为什么这里是空的」写出来，比再加一个按钮有用。

## 2026-10-09 · v2.1.2 修隐形按钮 + 导航改横排

### 真因：白字白底

用户反馈**「授权根目录后面的添加按钮看不见」**、**「竖排不好看，改横排」**。

看不见的按钮不是样式没写，是**变量没解析**：所有 `--daw-*` 自定义属性定义在
`.daw-root` 上，而 2.1.1 把设置改成内联渲染之后，那一节**没有 `.daw-root` 祖先**。
于是 `var(--daw-accent)` 解析失败 → `.daw-command.primary` 的 `background` 落成透明，
而 `color` 仍是 `#fff` —— **白字画在白底上**。

同一个 bug 其实也解释了 2.1.1 之前那个「看不见的按钮」：不是两个 bug，是同一个。

修法两条：变量块选择器从 `.daw-root` 扩成 `.daw-root,.daw-settings-section`；
导航在 `.daw-settings-section` 作用域下改横排（flex 横排、底部边框、选中态由左侧
竖条改底部横条）。

### 因果验证

不靠「看起来好了」收工：用 Playwright 取**计算样式**确认 `background` 真的不再是
`rgba(0, 0, 0, 0)`，并新增 `tests/styles.spec.ts` 守住这条结构不变量 ——
否则下一次有人改选择器，同样的白字白底会再来一遍，而且症状是「按钮不见了」，
没人会联想到祖先缺一个 class。

## 2026-10-09 · v2.1.1 设置页内联渲染（修一个自己犯的设计错误）

### 2.1.0 的入口是错的

2.1.0 把设置页那一节做成了**启动器**：一句说明 + 一个按钮，真正的设置在按钮后面的
模态框里。用户点进去只看到一句话，反馈**「其他的可以设置的东西那去了」** ——
他把这一节当成设置本身，而它只是个门把手。

抽出 `PhoneSettingsBody`（导航栏 + 内容区，无对话框外壳），设置页**内联**渲染。

### 随之删掉的死代码

内联之后这些都没有存在理由了，留着就是第二套入口：
`GlobalOverlay`、`dsh-remote-bridge:open-panel` 事件、`openSection()`、
`shell.overlay` 注册、`WorkspacePanel`、`openPanel` 文案键。
`AdminOverlay` 保留 —— 独立页 `/dsh-workspace` 仍在用。

## 2026-10-09 · v2.1.0 入口搬进 DSH 设置 + App 下载页

### 用户的三条要求

把「工作区设置」移到 DSH 设置里「手机访问」下面、改名为「手机设置」、二维码单独一页。

### 入口：删掉侧栏按钮，改注册 settings.section

原先的侧栏齿轮按钮（`sidebar.footer.action`）已**删除**，改为注册 `settings.section`，
`id: dsh-remote-bridge`、`order: 2` —— 紧跟 dsh-pocket-relay 的「📱 手机访问」
（它 `order: 1`）。同一件事有侧栏图标和设置页两个起点，是「哪个是真的」的成本，
现在远程访问、配对与客户端下载都收在设置页一处。

### 改名，以及一个刻意不改的地方

面板标题「工作区设置」→「手机设置」。但**独立页 `/dsh-workspace` 自己的齿轮保留
「工作区设置」**：那里确实就是文件工作区，两个概念不该共用一个词。

### 二维码指向列表页，不是具体文件

两个二维码指向 GitHub / Gitee 的 **dsh-companion Releases 列表页**，刻意不指向
`/releases/download/<tag>/<file>` —— 否则每发一个新版都要重做二维码，而这份资产是
**提交进仓库**的，漏更新就等于给用户一个过期入口。

### 资产双份，各有各的理由

- `assets/app-qr-{github,gitee}.svg` —— 插件界面用，以 data URL 内联，
  浏览器端零依赖、零网络请求；
- `.png` —— README 用（Gitee 的 Markdown 可能不渲染 SVG）。

生成脚本 `scripts/generate-app-qr.mjs`（`pnpm qr:app`），并用**独立解码器**交叉验证
（编码 qrcode、解码 jsqr）：自己编自己解不算验证，换一条链路才算。
新增 `tests/app-qr.spec.ts` 解**提交进仓库的资产本身**，防止手改或漂移。

## 2026-10-09 · v2.0.4 改名 dsh-remote-bridge + 宿主注入容错（补记）

> 这条是**补记**：2.0.4 当时直接发了 Release，没进开发日志。
> 结果 CHANGELOG 从 2.0.0 直接跳到 2.1.0，读的人会以为中间没有版本 —— 而 2.0.4 是
> 改名那一版，对下游影响最大的恰恰是它。

### 改了什么

- **改名**：`dsh-workspace` → `dsh-remote-bridge`。旧名字比内容窄 —— 插件实际承担的是
  「把 DSH 内核的私有 remote 协议翻译成版本化 REST，供手机端远程访问这台机器」
  外加一个设置中心，而「workspace」只是其中一页。
  改名只动「安装时叫什么、bundle 叫什么」，**四处对外契约刻意不变**：
  REST 前缀 `/dsh-workspace-api`（已发布 App 写死了）、独立页 `/dsh-workspace`、
  浏览器存储键 `dsh-workspace-device-token`、状态目录 `dshHomePath('dsh-workspace')`。
  改名不该顺带把已装机器上的授权根和回收站清空。
- **宿主注入容错**：某些 DSH 构建不提供 `ctx.attachments` / `ctx.fileUploads`。
  原先插件在回调里直接读这两个注入属性，缺失时抛
  `cannot get property "..." without inject`，**整个插件激活失败**（2.0.1 就是这么坏的）。
  改为用 `optionalService()` 容错解析并闭包捕获：插件照常激活，
  只有真正用到该能力的接口返回 `ATTACHMENT_STORE_UNAVAILABLE` / `FILE_UPLOADS_UNAVAILABLE`。
- **桌面端收敛为纯设置面板**：入口图标由文件夹换成齿轮，只渲染五行设置；
  目录树、编辑器与文件操作移出桌面面板，保留在独立页 `/dsh-workspace`；
  会话视图中的「文件」标签页不再注册。

### 为什么值得补记

2.0.1 的教训是「一个缺失的服务能让整个插件起不来」，2.0.4 把这条修掉并写成容错边界；
而改名是一次不可逆的对外变更。两件事都该在日志里留下痕迹。

## 2026-10-09 · v2.0.0 下游适配版发布（`REL-005`）

### 为什么发 major

不是代码风格洁癖，是**宿主契约变了**：`apiProxy` 在 DSH 0.2.x 已不存在，host bridge 整体迁到
host services。插件的入口签名与生命周期钩子跟着换，这一类改动对下游集成方就是破坏性的，
哪怕四个新端点本身都是向后兼容的新增。压成 v1.0.1 会让半年后有人对着旧文档调试新内核，
那才是真正的破坏。

### 这一版带了什么

| 端点 | 任务 | 解决的用户原话 |
| --- | --- | --- |
| `GET /api/v1/settings/plugins` | `PLUGIN-001` | 「无法查看已装插件情况」 |
| `POST /manage/config/text` + WebUI 按钮 | `CFG-001` | 「电脑在哪里生成？」（配对码本来就在远程访问页） |
| `GET /api/v1/roots/resolve` | `FS-003` | 「会话中的文件无法查看」 |
| `GET /api/v1/attachments/:id` | 附件读取 | 会话里发的图片/文件在客户端不可见 |

### 版本号的四处战场

改版本号时踩了一个坑，值得记下来：`package.json` 只是**四个**版本源之一。
`docs/api/openapi.yaml`（含 `pluginVersion` 的 `const` 约束）、`docs/api/asyncapi.yaml`、
`kotlin-sdk/build.gradle.kts` 各有一份，而运行时真正对外报版本的是
`src/shared/version.ts` 里的 `PLUGIN_VERSION`——它才是 `healthz` 与客户端设置页显示的那个值。

只改 `package.json` 而漏掉 `src/shared/version.ts` 的结果是：
`pnpm docs:check` 全绿（它只校对文档与 package.json 的版本），
只有 `tests/http-api.spec.ts` 的 `healthz` 断言会红。一条测试抓住一个真实的漏项。

`docs/api/openapi.yaml` 里那个 `const: 2.0.0` 也要一起改，否则规范会把响应钉死在旧版本上。

### 验证

`pnpm check` 全绿：`tsc --noEmit`、**17 个测试文件 / 101 用例**、`docs:check`（9 份项目文档、
37 项任务、6 份 ADR 与 API/SDK 版本一致性）、三份 bundle 构建。
产物 `artifacts/dsh-workspace-2.0.0.tgz`，2,676,271 字节，
SHA-256 `6657DD9C24BB644FBD7245499E51533D51D5D6E83EB676D9708EDC9ED12A6C74`。

### 发布形态

`feat/plugin-inventory` 合并进 `main`，在 `main` 上打 `v2.0.0`，tag 推 GitHub + Gitee，
GitHub Release 附 tarball 与 `SHA256SUMS.txt`。上游 `Hakunm/dsh-workspace` 与 AtomGit 远端不动。

---

## 2026-10-08 · 配置文本的 WebUI 入口（`CFG-001`，下游分支）

### 为什么：一句被用户戳穿的话

README 把「配置导入」写成主路径：

> 电脑上生成一行文本 → 发给自己（微信 / 邮件 / 私密笔记）→ 到了外面粘贴进 App

用户追问：**「电脑 在哪里生成？」**

**这一问是对的。** 当时的生成端只有一个命令行脚本（在另一个仓库里）：
用户得装 Node、开终端、`cd` 到仓库、记命令。对一个「人已出门、电脑在家」的场景，
这等于「请先编译源码」，不是入口。而配对码本来就在 WebUI 的「远程访问」页一键生成 ——
配置文本理应出现在同一处。

### 干了什么

- 新增 `src/host/config-text.ts`：线格式编码 + 本机地址探测。
  - `detectEndpoints()` 枚举非回环 IPv4，**排除 `169.254.*`**（只在没有 DHCP 时出现，
    给用户只会换来「为什么这个地址连不上」的困惑）。
  - `classifyHost()` 与 Kotlin `EndpointKind.infer` 的规则一致（含 `100.64.0.0/10` 归虚拟网，
    因为 Tailscale 与 BeyondTunnel 都在用这个 CGNAT 网段）。
  - `encodeConfigText()` 用**对象字面量固定键顺序**，不依赖 `JSON.stringify` 的字典序。
- `src/host/router.ts` 新增 `POST /manage/config/text`（回环管理面）：
  内部走既有的 `createPairing` → `exchangePairing`，默认授予 5 项**非破坏性**权限
  （刻意不含 `files.delete` 与 `settings.write` —— 那是用户显式要求才给的东西）。
- WebUI「远程访问」页在「生成配对码」旁加「生成配置文本」（见 `CFG-001` 的客户端部分）。

### 一个刻意的字段省略

响应**不返回 `pairing.expiresAt`**。它是**配对码**的十分钟有效期，而设备令牌本身
**不过期**（`devices` 表没有过期列）。回传它会被读成「这段文本十分钟后就失效」，
诱发没必要的重复生成。同理，响应也**不单独回传 token** —— 它已在 `text` 内，
多一份只会让它出现在日志、浏览器历史与开发者工具里；有测试断言响应字段集合防止后人加回。

### 三处实现必须逐字节一致

同一套线格式现在有三处实现：Kotlin 编解码（`ConnectionShare.kt`）、命令行脚本
（`dsh-companion/tools/emit-config.mjs`）、本模块。任何一处在键顺序或「空值不写键」上跑偏，
都会产出**字节不同但都能被解码**的文本 —— 三处单测各自都绿，跨端却不再兼容。

因此 `tests/config-text.spec.ts` 里钉了一条 **golden 逐字节断言**，输入取自脚本的真实
stdout（而该脚本的输出已被 Kotlin 端 `ConnectionShareInteropTest` 断言与 `ConnectionShare.encode()`
相同）。一条断言同时钉住三处实现。

### 测了什么

| 测试文件 | 用例 | 覆盖 |
| --- | --- | --- |
| `tests/config-text.spec.ts` | 9 | **golden 逐字节**、空值不写键、键顺序稳定、`/api/v1` 剥离、无地址拒绝生成、各网段分类（含 `100.128`/`100.63` 两个边界外必须归 WAN）、探测结果不含回环与 link-local |
| `tests/plugin-inventory-api.spec.ts` | 11 | 真起 HTTP server：配置文本可解码且**响应不含 token**、生成的设备确实入库、未给地址时自动探测、**非回环 origin 不可触发** |

全量：`17` 个测试文件 / `94` 用例通过；`tsc --noEmit` 通过。

---

## 2026-10-08 · 绝对路径解析端点（`FS-003`，下游分支）

### 基于什么

- 上游 `Hakunm/dsh-workspace` v1.0.0，接在 `PLUGIN-001` 之后。
- 触发自真实使用反馈：**「会话中的文件无法查看」**。

### 为什么：一次被实测推翻的判断

我最初判断这一条**不需要改服务端**，理由是「客户端可以把绝对路径与授权根做最长前缀匹配」。
**这个判断是错的**，实测三条事实推翻了它：

| 事实 | 实测结果 |
| --- | --- |
| `/api/v1/roots` 是否返回根的绝对路径 | **不返回**，只有 `{ id, label, createdAt }`（既有安全设计） |
| 会话的 `cwd` 字段是否可用 | **71/71 全为空字符串** |
| 绝对路径能否直传 `roots/:id/content` | **400**（`PATH_INVALID`，接口只接受相对路径；`../` 逃逸同样 400） |

于是客户端的处境是：手里有「一个绝对路径」和「一个 rootId」，**中间那一环它永远拿不到**。
必须由服务端做这一次转换。

### 干了什么

新增 `GET /api/v1/roots/resolve?path=<绝对路径>`（要求 `files.read`）：

```json
{ "rootId": "...", "path": "dsh-companion/README.md", "kind": "file",
  "size": 1234, "modifiedAt": 1791498310753, "contentType": "text/markdown" }
```

- **仍然不返回根的绝对路径** —— 原有安全边界没有被削弱，这正是把转换放在服务端做的原因。
- 多个根相互嵌套时取**最长**匹配，否则外层根会把内层根下的文件解析成更长的相对路径，
  绕过内层更严格的授权语义。
- 相对路径一律 `400 PATH_NOT_ABSOLUTE`：`path.resolve` 会按服务端 cwd 解析，语义不确定，
  拒绝比猜更安全。
- 不在任何授权根内 → `404 PATH_OUTSIDE_ROOTS`。
- **目录不算错误**：会话里提到的路径可能是目录，返回 `kind: "directory"` 比抛 400 更合理。

新增 `src/host/root-resolver.ts`，分为两层：

1. `matchAuthorizedRoot()` —— **纯字符串**粗筛（找出候选根），因此可脱离文件系统单测；
2. `inspectResolvedPath()` —— 真正的安全校验，委托给既有的 `resolveAuthorizedPath`
   （它逐段 `lstat` 并拒绝路径中的符号链接）。

**为什么必须分两层**：字符串前缀相等不代表真实落在根内 —— 根内可能存在指向外部的符号链接。
复用 `resolveAuthorizedPath` 而不是自己写一遍，是为了不重复实现（也就不会重复实现错）。
另外 `ContentDescriptor` 里带 `absolutePath`，本端点刻意**不返回**该字段。

### 测了什么

| 测试文件 | 用例 | 覆盖 |
| --- | --- | --- |
| `tests/root-resolver.spec.ts` | 13 | 单根内文件、根本身、嵌套根取最长、**同前缀兄弟目录必须拒绝**（`/srv/database` vs 根 `/srv/data`）、越界、空根集合、文件/目录/根本身的描述、不存在、**符号链接逃逸被拒**、`../` 逃逸被拒、响应不含绝对路径 |
| `tests/plugin-inventory-api.spec.ts` | 8 | 真起 HTTP server：resolve 成功且**响应不含根路径**、越界 404、相对路径 400、无 `files.read` 403，外加 `PLUGIN-001` 的四条 |

全量：`16` 个测试文件 / `82` 用例通过；`tsc --noEmit` 通过。

### 教训

「客户端能不能自己做到」这类判断，必须**对着真实响应验证**，不能靠推理。
我这次先给出结论、后来被自己的实测推翻，代价是多写了一个端点；
但如果照原判断交付，用户拿到的是一个**永远点不开文件**的功能。

---

## 2026-10-08 · 插件清单端点（`PLUGIN-001`，下游分支）

### 基于什么

- 上游 `Hakunm/dsh-workspace` v1.0.0，同分支内接在 DSH 0.2.x 兼容适配之后。
- 触发自真实使用反馈：**「功能单调点，无法查看装的插件情况」**。

### 为什么

用户人在外面用手机时，想知道这台机器装了哪些插件、有没有出问题的，**必须回到电脑前的 WebUI**。
核实过插件的对外 API 面：`/api/v1` 当时共 10 个端点
（`healthz` / `pairings/exchange` / `devices/self` / `roots` / `trash` / `chat/sessions` /
`chat/workspaces` / `chat/agent-presets` / `settings/models` / `settings/providers`），
外加 WS `events` —— **没有任何一个与插件相关**；loopback 管理面 `/manage/status` 也只回
`remote` / `roots` / `devices`。所以这个信息在远程侧完全不可见。

### 数据源与依据

DSH 把每个 profile 的插件状态放在同一个 `package.json` 的两个字段里，缺一不可：

| 字段 | 含义 |
|---|---|
| `dependencies` | **装了哪些包**（含版本声明，如 `^0.4.5`） |
| `dsh.profile.bundles` | **实际加载了哪些包** |

两者之差是有意义的信息：
- 在 `dependencies` 但不在 `bundles` → **装了但没启用**；
- 在 `bundles` 但找不到 → **声明加载却缺失**，通常意味着启动有问题。

另外 `node_modules/<name>/package.json` 的 `version` 才是**实际装上的版本** ——
只看 `dependencies` 的 `^0.4.5` 回答不了「我现在跑的是哪个版本」。

profile 名取自 `DSH_PROFILE` 环境变量 → `--profile=<name>` → `--profile <name>`（实测 DSH 以
`dsh --profile web --port …` 启动）；`DSH_HOME` 缺省为 `~/.dsh`。都拿不到时**不猜**，
返回 `PROFILE_UNKNOWN` 让界面如实说明。

### 干了什么

- 新增 `src/host/plugin-inventory.ts`：纯逻辑，不做 IO 之外的副作用，`resolveProfileName` /
  `resolveDshHome` / `readPluginInventory` / `resolveState` 均可单测，支持注入 env 与 argv。
- `src/host/router.ts` 新增 `GET /api/v1/settings/plugins`，要求 scope `settings.read`
  （与 `settings/models` 一致）。读取失败不抛 500，而是返回 `available:false` + `reason` ——
  一个只读的信息端点不该因为文件缺失就让整个请求失败。
- 返回字段被**限制**为「包名 + 版本 + 状态」，不回传任何文件内容；另有测试断言字段集合，
  防止将来有人顺手把整个 manifest 塞进去。

### 一处真实数据才能暴露的设计缺陷（重要）

首版把「在 `bundles` 里但 `node_modules` 找不到」一律判为 `declared-missing`。
**单元测试全绿**（mock 数据里没有官方包），但在真实机器上一次性产生了 **5 条假警报**：

```
[declared-missing] @deepseek-ai/dsh-base
[declared-missing] @deepseek-ai/dsh-web-app
[declared-missing] @deepseek-ai/dsh-experimental-*
```

原因是**官方内核包随 DSH 主包安装，不会出现在 profile 的 `node_modules` 下**，这是正常状态。
修正为新增状态 `runtime-provided`（`official && loaded && !installed`），并在 `problemCount`
中排除它。修正后真实机器上「需注意」从 7 条降到 **2 条**，且这两条是真实洞察：

```
[installed-not-loaded] dsh-hyperframes  声明=^0.4.2  实装=0.4.2
[installed-not-loaded] dsh-remotion     声明=^0.3.4  实装=0.3.4
```

**教训**：mock 数据只能证明逻辑自洽，证明不了判定规则符合真实世界。这类「把正常状态误判为异常」
的缺陷，只有拿真实环境跑一遍才会暴露 —— 而假警报比没有信息更糟，它会让用户学会忽略警告。

### 测了什么

| 测试文件 | 用例 | 覆盖 |
|---|---|---|
| `tests/plugin-inventory.spec.ts` | 19 | profile 解析（含 `--profile --port` 不误判）、`DSH_HOME` 缺省、三种状态分类、scoped 包名展开、`runtime-provided` 判定、官方/非官方、排序稳定、profile 未知、manifest 缺失与格式损坏、字段集合不泄漏 |
| `tests/plugin-inventory-api.spec.ts` | 4 | 真起 HTTP server：有 `settings.read` → 200 且结构正确；无该 scope → 403；未认证 → 401；profile 不可解析 → 200 且带 `reason` |

全量：`15` 个测试文件 / `65` 用例通过；`tsc --noEmit` 通过；`tsdown` 构建通过。

### 安装

```sh
pnpm pack        # prepack 自动跑 typecheck + test + docs:check + build
```

产物需安装进 profile 并**重启 DSH** 才生效。

---

## 2026-10-08 · DSH 0.2.x 兼容适配（下游分支）

- **背景**：DSH 0.2.x 起用 `@deepseek-ai/dsh-api-gateway`（服务名 `typertGateway`）替换了
  `@deepseek-ai/dsh-host-apiproxy`（服务名 `apiProxy`，最后一版 `0.1.1-rc.2`）。0.2.x 上不再有任何
  服务提供 `apiProxy`，插件的 `inject` 无法满足，Cordis 让该行永久停在 `pending`，`apply()` 从不执行，
  HTTP 路由从未挂载——用户侧表现为「添加根目录返回 405」，而非任何显式报错。
- **做法**：新增 `src/host/dsh-0.2-bridge.ts`，在 0.2.x 宿主服务之上重建旧版 `apiProxy` 门面
  （25 个方法），插件的 `chat-adapter.ts` / `settings-adapter.ts`（约 1300 行）零改动。
  桥接层只用结构化类型，不 import 任何 `@deepseek-ai/*` 运行时模块。
- 桥接层同时承担三项非转发职责：事件中继（0.2.x 无进程级会话事件流，改为按运行中会话 `follow()` 后扇出）、
  审批桥（认领 Cordis 瀑布 `approval/request`，转成 `approval/requested`，答复后经 `next()` 放行，
  无人应答则委托下一个 answerer）、门面翻译（`SessionAddress` 判别联合、`AsyncIterable` 流、
  `{ rpcId, payload } → { result: { ok, value } }` 信封）。
- 适配过程中修复 **10 处契约缺口**，全部为「不抛错的静默失败」：`agent-presets` 缺 `trust`；
  会话模型缺 `current`/`routable`；history 恒为空（`page()` 的 `throughSeq` 必须取自 `follow()`
  开场帧，硬编码 `-1` 返回结构合法的空页）；冷会话命令发现失败（0.2.x 激活 Agent 的正路是
  `resolveAgent()`，`agents.get()` 只读）；实时流式输出缺失（新增 `SessionEventRelay`）；
  `api-session/status` 签名误读（参数是 `(sessionId, running)`，首参为裸 id 非对象）；
  事件名不符（应为 `host/session-status`）；`agent-preset/selected` 未转发；
  流式帧未产生（`follow()` 的 `assistantStream` 是 opt-in，不传宿主不产生任何增量帧）；
  内部会话混入列表并报 409（0.2.x `list()` 返回 subagent 拥有的会话，而 `resolveAgent()`
  按设计拒绝激活它们——过滤 `origin === 'subagent'` 并把命令发现改为可降级返回空列表）。
- 第 6、7、9 项属适配过程中自己引入或遗漏的问题，一并记入 `docs/project/DSH-0.2-COMPAT.md` 作为例证。
- **验证**：`pnpm test` 42 项通过（13 个文件）、`npx tsc --noEmit` 零错误；隔离 `DSH_HOME` 中安装真实
  tarball 后「添加根目录」由 405 变为 **201**，8/8 接口 200，文件读写与会话创建正常；真实设备令牌
  验证 8/8 接口 200 后**立即吊销探针设备**；端到端 WebSocket 实测（订阅事件流并真实发消息）
  从修复前的 `chat.message.delta` **0 帧**变为 **11 帧**、累积流式文本正确输出；70 个真实会话逐个
  探测命令发现，结果 正常 67 / 空列表 3 / **报错 0**，会话列表由 75 收敛到 70。
- 新增 `docs/project/DSH-0.2-COMPAT.md` 完整记录「基于什么、为什么、改了什么、测了什么、已知边界」。
- 未改动公开接口（`docs/api/openapi.yaml`、`asyncapi.yaml` 契约保持不变），未改动许可证（仍为 `AGPL-3.0-only`）。

## 2026-08-15 · v1.0.0

- 完成 `DOC-003` 与 `REL-004`：按发布要求删除中英文 README 的截图环境说明，并继续以单一根提交同步公开分支和标签。
- 完成 `BRAND-002`：插件界面、API 文档、SDK 文档和用户 README 的产品简称统一为 `DSH`；中文安装标题改为“快速安装”，两张 DSH WebUI 实际截图同步重拍。
- 完成 `LICENSE-001`：项目自身许可证和 npm 元数据改为 `AGPL-3.0-only`；上游图标及其他第三方材料继续保留原始许可证，不混入项目主许可证。
- 完成 `REL-003`：v1.0.0 按最终名称、许可证、截图和文档重新打包，公开分支与标签以单一根提交发布，避免暴露开发阶段的提交轨迹。
- GitHub hosted 矩阵发现 Windows / Node 22 在 listener 重绑定后可能复用已关闭的 keep-alive 连接；所有会触发重绑定的 `202` 管理响应现显式返回 `Connection: close`，客户端会在新 listener 上建立新连接，并补充响应头合约测试。
- 修复后的 GitHub Actions `31839360841` 全部通过，覆盖 Windows、Ubuntu、macOS 的 Node 22.19.0/24、浏览器、Kotlin SDK 和三平台 Profile 安装。
- 后续 Windows hosted runner 复现出负载相关的 5 秒测试超时，并发现失败重绑定会短暂关闭仍可用的旧 listener；不同端口现先绑定候选 listener、成功后再切换，端口冲突不会中断现有服务，跨平台集成测试预算同步调整为 15 秒。
- 完成 `CHAT-005`：公开 BFF 新增 DSH 工作区重命名/移除及会话重命名/分叉/归档，所有操作重新执行 scope、session 和 root 授权；归档会话从默认列表隐藏但保留日志。
- 正式项目名统一为 `dsh-workspace`，包、bundle、Cordis row、状态目录、CI、OpenAPI、AsyncAPI 和 Kotlin SDK 版本统一为 `1.0.0`，WebUI 设置页和健康检查显示运行版本。
- 重写中英双语用户 README，补齐安装、远程访问、HTTP 风险、权限、安全语义、完整公开接口和排错说明；新增 ADR-0006 固定插件/App 拆分与版本策略。
- Windows Node 24 下 `pnpm check`、24 项 Vitest、Kotlin SDK JDK 17 编译和真实 tarball profile 安装冒烟通过。正式包 SHA-256 为 `739B0C9FDA032B0E15C323A4A1B36FDE15398BE2ECB2234A00B9CE171F6CC40F`。
- 完成 `DOC-002`：安装 Humanizer-zh，参考 GitHub `dsh-plugin` 主题中高关注项目的首屏、截图、安装和双语组织方式，在保留用户手动删改的前提下重写中文 README，并拆出完整 `README.en.md`。
- 通过隔离 DSH WebUI profile 生成文件编辑器与远程访问两张真实截图；只使用 `C:\DshWorkspaceDemo` 示例根，未展示设备令牌、配对码、外部服务器地址或个人文件。
- 创建 `Hakunm/dsh-workspace` 公开仓库并推送 `main`，设置 `dsh-plugin`、`deepseek-harness`、`dsh`、`file-manager`、`remote-api`、`vibe-coding` topics。重新打包后的 tarball 为 2,622,852 字节，SHA-256 `1F7B8C38D5625880A893B08391607185D329ED2E5EC05CA9B0C9600963AA56E7`。
- 发布 GitHub `v1.0.0` Release，上传正式 tarball 与 `SHA256SUMS.txt`；README 的主安装命令固定到该 Release 资产，不依赖尚未发布的 npm 包。

## 2026-08-15

- 完成 `CHAT-004`：插件注入 DSH `agents/commands` host service，新增受 session/root 与 `chat.read/chat.write` 约束的命令列举/执行 BFF、OpenAPI、Kotlin SDK 和合约测试；命令直接进入 host registry且审计不保存参数。会话 `todos/permissions` projection 保持在历史响应中供 App 使用。
- 完成 `UI-004`：远程访问页在没有授权根时明确提示必须先添加根目录，启用按钮继续保持禁用；插件标题区和包元数据展示作者 `Github@Hakunm`，中英文同步。
- 当前 tarball 已更新到 Oracle root `web` profile并重启 DSH；`3080/3090` 和健康检查恢复，真实命令列表与四项 Host 注入验证通过，既有授权根、设备和监听设置保持不变。
- 用户明确要求重启后，将已校验的审批 tarball 安装到 Oracle root `web` profile，终止旧 DSH 进程并以相同 root/npx 环境后台启动；`3080/3090`、健康检查、审批 OpenAPI 和 Host bundle 哈希全部验证通过。旧待审批运行随重启终止，后续真实验收使用新会话。

## 2026-08-14

- 完成 `APPROVAL-001`：Host 缓存 DSH mux 待审批请求，公开按 session/root 授权的脱敏查询与“允许一次/拒绝”接口，私有 RPC ID 不出服务端；新增 `chat.approval.requested/resolved`、OpenAPI、AsyncAPI、Kotlin SDK、REST/脱敏/重复决定测试和最小审计。
- 审批发布包已上传至 Oracle `/tmp` 但没有安装或重启；当前真实 Skill 会话仍停在原审批点，避免为部署新功能而破坏用户尚未决定的运行。
- 完成 `CHAT-003`：将 DSH token 级 `assistant/chunk` 规范化为公开 `chat.message.delta`，完成消息/运行状态/Agent 选择使用稳定事件；新增仅空白会话可用的 Agent Preset 切换端点，已开始会话返回明确锁定错误，并同步 OpenAPI、AsyncAPI、Kotlin SDK 与合约测试。
- WebSocket 广播改为单一有序队列，修复并发异步授权查询可能重排 token 的问题；会话到根的固定映射只作定位缓存，每个事件仍重新检查设备撤销、scope 和 root grant。ARM64 Oracle 真实探针验证 24 个增量严格有序、拼接正文与持久消息一致。
- 扩展 `CHAT-002`：新增受 `chat.write` 与 root grant 约束的 `POST /chat/workspaces`，允许 Android 从授权目录登记新的 DSH WebUI 工作区后直接创建会话；同步 OpenAPI、Kotlin SDK 和合约测试。
- 扩展 `MODEL-001`：供应商读取合并 DSH 模板基值与用户覆盖，并从实时模型目录补足继承模型；新增与 DSH WebUI 同规则的完全自定义供应商创建、协议 schema 发现、脱敏凭据写入及 Android 合约。
- 最终 tarball 已更新到 ARM64 Oracle 的 root `web` profile 并重载；真实 listener 验证工作区发现、37 个供应商、自定义协议能力和模型回填后撤销临时探针设备，未改动授权根与既有设备。

- 完成 `MODEL-001`：新增 `settings.read/settings.write`、供应商配置与凭据状态/写入、模型发现、会话模型和思考强度接口；同步 OpenAPI 3.1、Kotlin SDK、脱敏与选择合约测试。当前 tarball 已更新并重载至 ARM64 Oracle DSH，现有手机设备保留根授权并追加设置 scope。

- 将通过完整 prepack 校验的当前插件 tarball 更新到私有 ARM64 Oracle 测试服务器 root `web` profile；把易失的 `/tmp` 文件依赖迁移为 `/root/.dsh/packages/` 持久引用，并通过 bundle 哈希与 `--dump-config` 验证。未修改插件数据、授权根、设备或监听设置。
- 克隆 DSH `master@47f943859bef60e4160492346772ded9b24f765a`，确认 Profile bundle、`dsh.client` 和官方 slot 契约。
- 初始化独立插件仓库、发布清单、构建入口和持久化项目追踪文档。
- 接受外置插件、授权根、独立 HTTP listener 三项架构决策。
- 记录 npm 旧版 DSH peer 链不完整的问题；开发安装关闭 peer 自动补全，运行时代码保持宿主 service 注入。
- 完成授权根文件服务：懒加载列表、Range 读取、ETag 保存、新建/移动、跨卷校验、插件回收站和冲突恢复。
- 完成 SQLite 配对、256 位令牌摘要、设备 scope/root grant、撤销、审计、幂等与限流。
- 完成默认回环、显式远程启停与回滚的独立 listener，并发布版本化 REST/WebSocket BFF。
- 完成 DSH `apiProxy` 聊天 adapter、三个官方 WebUI slot、独立工作区 route、CodeMirror 6 和响应式管理面。
- 发布 OpenAPI 3.1、AsyncAPI 3.0 与带 Gradle Wrapper 的 Kotlin/OkHttp SDK；JDK 17 实际编译通过。
- 增加 null Origin、转发头、scope/root、错误脱敏、实时 WebSocket 授权和撤销安全回归。
- 增加三系统 CI profile 安装脚本与 Ubuntu DSH 运行探针；Windows 本地 tarball 安装、上游构建和完整启动通过。
- 将 DSH 自注册 Client bundle 发布为 `client.cjs`，消除 ESM 包中的格式歧义；生产依赖审计和 publint 均通过。
- 在真实 DSH WebUI 完成 Chromium 交互验证：通过侧栏 `Files` 打开管理 overlay、登记插件源码根，并从 DSH 同源 route 展示完整文件工作区。
- 完成 `UI-002`：新增默认中文的中英双语词典、全局语言按钮、浏览器偏好持久化、状态/错误本地化及动态 DSH slot 标签；桌面、移动和真实 DSH WebUI 均完成双向切换验证。
- 完成 `UI-003`：侧栏“文件”改为在 DSH 根页面直接打开完整工作区 overlay；设置往返保留当前文件和编辑状态，独立 `/dsh-workspace` route 降级为备用入口，并通过真实 DSH 桌面/移动视口验证。
- 完成 `NET-002`：远程访问设置可持久化自定义数值 IPv4/IPv6 与端口，禁用状态下安全重绑定，失败自动恢复旧 listener；DSH 宿主内完成 `3090` 到 `3190` 再恢复的实际验证，并为占用、不可用及权限拒绝提供中英文错误提示。
- 启动 DeepSeek Harness Android App：锁定独立工程、`io.github.hakunm.deepseekharness`、Compose/Material 3、中英双语、上游黑色鲸鱼图标、Android Keystore 令牌保护和仓库外正式签名；建立 `PARITY-001`，明确当前 BFF 与 DSH WebUI 全功能之间的差距。
- Android 基础客户端实现配对/恢复、scope 感知、WebSocket 重连、聊天与完整文件操作，并通过 HTTP 合约单测、lint、R8 Release 和独立签名校验，随后进入真实 DSH/Android 验收。
- 对运行中的真实插件 listener 完成临时设备与根的配对、scope、ETag 文件、回收站恢复和会话过滤回归，测试授权已撤销。
- Android 文件传输改为 Okio 流式 I/O，并补充目录分页与 Compose 默认中文连接首屏测试 APK。
- Android 15 发布版通过真实插件 listener 完成健康检查、一次性配对、设备/scope/根加载、重启恢复及会话/文件/设置导航；Compose 仪器测试在清理登录前置状态后通过。
- 真机发现并修复 OkHttp WebSocket 握手 URL 被提前改为 `ws://` 的回归，增加合约测试；测试临时设备和授权根已撤销。
- 完成 `CHAT-002`：新增受 `chat.read` 与 root grant 约束的 DSH 工作区发现和 Agent Preset 列表，创建会话优先接收 `workspaceId`；OpenAPI、Kotlin SDK、合约测试与真实 listener 同步通过，外部响应不暴露绝对工作区路径或 preset 损坏详情。
