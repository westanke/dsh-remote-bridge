# dsh-remote-bridge 2.4.2 → DSH 0.2.1-rc.2 适配差距清单

> 本文是一次**差距调研**，不是适配记录。目的是回答三个问题：
> 1. 2.4.2 在 DSH 0.2.1-rc.2 上能否直接运行？哪些功能会坏？
> 2. 能否声明兼容 0.2.0（最低支持版本）？
> 3. 要改哪些文件、按什么优先级改？
>
> **验证状态标注**：每条结论都带 `[已验证]` 或 `[未验证]`。
> - `[已验证]` = 本机可查证据（内核源码/类型/已装包、本仓源码、semver 实跑、单测实跑）。
> - `[未验证]` = 需要在真机/实装 profile 上跑一遍才能定论，本文只给出判断与验证方法。
>
> 调研基线：
> - 本仓：`dsh-remote-bridge@2.4.2`（AGPL-3.0-only，分支 `main`，HEAD `5636819`）
> - 目标内核：`@deepseek-ai/dsh@0.2.1-rc.2`（本机已装，`/usr/local/nodejs/lib/node_modules/@deepseek-ai/dsh`）
> - 上一轮适配基线：`docs/project/DSH-0.2-COMPAT.md`，对应内核 `0.2.0-rc.2`
> - 内核源码树（供比对）：`/usr/local/nodejs/lib/node_modules/@deepseek-ai/dsh-root`（workspace 版本号 0.1.2-alpha.2，**不代表线上版本**；实装包以 `dsh/node_modules/@deepseek-ai/*` 为准，那里每个包都是 `0.2.1-rc.2`）

---

## 〇、结论先行

### 0.1 能否直接运行？

**大概率能，且不需要改任何源码。** `[已验证：服务名层面]`

2.4.2 的兼容层（`src/host/dsh-0.2-bridge.ts`，1 993 行）对 12 个宿主服务做了**结构化消费**，
不 import 任何 `@deepseek-ai/*` 运行时模块。逐一到 0.2.1-rc.2 的实装包里核对，
**12/12 服务名全部存在，且本插件调用的方法签名全部仍然存在**：

| 注入服务（`src/index.ts:48-68` + `cordis.patch.yml:9`） | 0.2.1-rc.2 提供方 | 插件用到的方法 | 0.2.1 是否仍在 |
|---|---|---|---|
| `sessionController` | `@deepseek-ai/dsh-api-session-controller` | `list` / `create` / `follow` / `page` / `prompt` / `cancel` / `rename` / `fork` / `attachment` / `selectModel` / `modelCatalog` / `projections` / `resolveAgent` | 全部在 `[已验证]` |
| `workspaceController` | `@deepseek-ai/dsh-api-workspace-controller` | `create` / `rename` / `delete` / `archiveSession` | 全部在 `[已验证]` |
| `workspaceRegistry` | `@deepseek-ai/dsh-workspace` | `list()` / getter `archivedSessionIds` | 全部在 `[已验证]` |
| `settingsController` | `@deepseek-ai/dsh-api-settings-controller` | `describe` / `mutate` | 全部在 `[已验证]` |
| `credentialsController` | 同上（`lib/types/credentials.d.ts`） | `describe` / `set` / `unset` | 全部在 `[已验证]` |
| `agentPresets` | `@deepseek-ai/dsh-agent-preset-registry` | `list` / `remoteExportList` / `select` | 全部在 `[已验证]` |
| `permissionPresets` | `@deepseek-ai/dsh-permission-presets` | `catalog()` | 在，但**由同步方法变成远程服务方法**，见 P1-3 `[已验证：签名变了]` |
| `llm` | `@deepseek-ai/dsh-llm` | `listProviders` / `listConfigurableProviders` / `discoverModels` / `resolveModelInfo` | 全部在 `[已验证]` |
| `webServer` | `@deepseek-ai/dsh-host-webserver` | `register({kind,path,handler})` | 在，`WebRoute` 结构逐字段一致 `[已验证]` |
| `agents` | `@deepseek-ai/dsh-agent` | `get(id)` | 在 `[已验证]` |
| `commands` | `@deepseek-ai/dsh-commands` | `list(agent)` / `execute(agent, line, attachments, signal)` | 在，**四参数签名一致** `[已验证]` |
| `fileUploads` | `@deepseek-ai/dsh-client-file-upload` | `upload(agent, req, signal)` / `bindPrompt(agent, ids, requestId)` | 在，签名一致 `[已验证]` |
| `attachments` | `@deepseek-ai/dsh-attachment` | `readImage(ref, signal)` | 在 `[已验证]` |
| `userQuestions`（非注入，按 agent 取） | `@deepseek-ai/dsh-user-questions` | `continued(agent)` / `answer(agent, callId, answer)` | `answer` 公开；`continued` 在 0.2.1 仍是 **private**（运行时可用），与 0.2.0 同样处境 `[已验证]` |

> `src/index.ts` 的 `inject` 比 `cordis.patch.yml` 多 3 个（`permissionPresets` / `fileUploads` / `attachments`），
> 这是**既有的两处不一致**，与 0.2.1 无关，但见 P2-5。

**事件名也全部对得上** `[已验证]`（内核 `packages/api/remotes/src/remote-events.ts`）：

| 桥接层订阅 | 0.2.1 声明 |
|---|---|
| `approval/request`（waterfall） | `{ event: 'approval/request', mode: 'waterfall' }` |
| `user-questions/request`（waterfall） | `{ event: 'user-questions/request', mode: 'waterfall' }` |
| `agent-preset/selected`（emit） | `{ event: 'agent-preset/selected', mode: 'emit' }` |
| `api-session/status`（emit） | `{ event: 'api-session/status', mode: 'emit' }`，签名 `(sessionId, running)` 未变 |

### 0.2 哪些功能会坏？

**没有任何功能"必然坏"，但有 4 处"可能静默退化"，都必须真机回归才能定论。** `[未验证]`

| # | 功能 | 0.2.1 下的风险 | 为什么是"静默" |
|---|---|---|---|
| A | 权限档位目录（`permissionPresets.catalog`） | 该服务在 0.2.0 就是"注不进"状态，插件已降级到 `FALLBACK_PERMISSION_CATALOG`；0.2.1 包仍存在，但注入面是否变未知 | 降级路径返回 200 + 内置两档，客户端看不出区别 |
| B | 会话历史附带投影（`history-projections-passthrough`） | **0.2.1 的 `follow()` snapshot 已经自带 `projections` 字段**（`types.d.ts:545`），而插件仍在为它**单独再发一次 `projections()` 调用**。功能不会坏，但白打一次 RPC | 多一次调用不报错，只是延迟 |
| C | 流式增量（`assistantStream: true`） | 0.2.1 的 `SessionFollowRequest.assistantStream` 仍是 `?: true`，opt-in 语义未变；`assistant-stream` 帧类型仍在 | 若某天内核改默认值，症状是"回复不流式"——正是 0.2.0 踩过的第 9 项缺口 |
| D | 附件读取 | 插件走 `sessionController.attachment()` 而非 `ctx.attachments`（因为实测本机 `ctx.attachments` MISSING）。0.2.1 上 `attachments` 服务确实存在 | 若 0.2.1 上 `attachments` 可注入了，当前代码仍能工作（走内核 attachment），只是没用上更近的那条路 |

**真正会让插件"整个起不来"的，只有一种情况**：`cordis.patch.yml` 的 `inject` 里某个服务在 0.2.1 上不存在，
Cordis 会让该行永久 `pending`、`apply()` 从不执行、HTTP 路由从未挂载——表现是"装上没报错，
点添加根目录返回 405"。按 0.1 的核对，**这个触发条件在 0.2.1 上不成立**。

### 0.2.1 唯一已知的编译期破坏点：`InvokeRemoteRequest.peer` —— **与本仓无关** `[已验证]`

0.2.1 把 `InvokeRemoteRequest.peer` 从可选改成了必填
（`@deepseek-ai/dsh-api-gateway/lib/types/types.d.ts:9-27`，注释原文：
"Peer the call speaks for; every carrier and in-process caller names it explicitly."）。
这是 `typertGateway.invoke()/stream()` 的入参契约，只影响**自己构造 InvokeRemoteRequest、
自己接 carrier、或直接调 typertGateway** 的代码。

本仓三项核查，全部为否：

| 核查项 | 结果 |
|---|---|
| `src/` `tests/` `e2e/` `scripts/` 里是否出现 `InvokeRemoteRequest` | **零命中** |
| 是否 import 任何 `@deepseek-ai/*`（编译期绑定的前提） | **零命中**（`grep -rn "from '@deepseek-ai"` 为空） |
| 是否碰 `typertGateway` / `TypertGateway` / 自建 carrier / `.peer` | **零命中**（`dsh-0.2-bridge.ts:7-8` 与 `src/index.ts:42` 只是注释里提到 `typert-gateway` 这个名字；`src/host/history-budget.ts:20` 的"peer 依赖"是 npm peerDependencies 一词，与 `InvokeRemoteRequest.peer` 无关） |

结论：**这个破坏点碰不到本仓。** 根因是本仓的结构化类型纪律——插件从来不是 Typert carrier，
它只通过 Cordis 注入拿服务对象、调服务方法（`sessionController.list()` 这类），
`InvokeRemoteRequest` 是 carrier 解封信封之后的内部形状，在插件的调用面之下两层。
连 `tests/dsh-0.2-bridge.spec.ts` 的 host 桩也是手写普通对象，不涉及任何信封/carrier 概念。

### 0.3 能否声明兼容 0.2.0（最低支持版本）？

**能，而且推荐。** `[已验证：semver 实跑]`

内核的兼容性判定在 `@deepseek-ai/dsh-app-boot/lib/index.js:252-330`（`evaluatePluginCompatibility`）：

- 只认两个来源：**自己的 `engines.dsh`**，或 **`peerDependencies` 里所有 `@deepseek-ai/dsh*` 包**。
- 判定用 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`（`app-boot/lib/index.js:276-278`）。
- **当前 2.4.2 两个都没声明** → 永远不触发版本拦截，也永远不给用户任何提示。

关键实测（用内核自带的 semver 跑，非记忆）：

| 候选 `engines.dsh` | 0.2.0-rc.2 | 0.2.0 | 0.2.1-rc.2 | 0.2.1 | 0.1.1-rc.2 |
|---|---|---|---|---|---|
| `^0.2.0` | **false** | true | true | true | false |
| `>=0.2.0-rc.2 <0.3.0` | true | true | true | true | false |
| `^0.2.0-rc.2` | true | true | true | true | false |
| `0.2.x` | true | true | true | true | false |

结论：
- **`^0.2.0` 会漏掉 `0.2.0-rc.2`**——那正是上一轮适配所依据的内核。若 README 说"支持 0.2.x"而
  `engines.dsh` 写 `^0.2.0`，老 rc 用户会被误拦。
- **`>=0.2.0-rc.2 <0.3.0` 是唯一同时覆盖「0.2.0 全部 rc + 0.2.x 正式版」且排除 0.1.x 的范围**。
- 0.1.x 应被排除：0.1.x 上 `apiProxy` 仍在，但本仓自 2.0.0 起 `inject` 已全部换成 0.2.x 服务名，
  **0.1.x 上插件同样起不来**（反向的 405）。README 现在写的"`0.1.x` 或 `0.2.x`"与事实不符，见 P1-4。

### 0.4 一句话给用户

> 2.4.2 大概率能在 0.2.1-rc.2 上直接跑，服务面没有断；但**没有任何自动化的兼容性验证能证明它**——
> 唯一可信的验证是把 tarball 装进 0.2.1-rc.2 的隔离 profile 真跑一遍（本仓既定纪律：
> 单测 → 打包装入 → 真实端到端，`DSH-0.2-COMPAT.md:159-161`）。

---

## 一、P1 —— 必须改，不改在 0.2.1 上会坏或会误导用户

> 本节 4 条。前 2 条是"真机回归 + 文档口径"，第 3 条是 0.2.1 新暴露的**确定**差异，
> 第 4 条是 README 现存的事实错误。

### P1-1 真机回归：`cordis.patch.yml` 的 10 个 inject 在 0.2.1 上是否仍全部注入成功

**现状**

- `cordis.patch.yml:9` 声明 `inject: [sessionController, workspaceController, workspaceRegistry, settingsController, credentialsController, agentPresets, llm, webServer, agents, commands]`（10 个）。
- `src/index.ts:48-68` 声明 13 个（多 `permissionPresets` / `fileUploads` / `attachments`）。
- `docs/project/DSH-0.2-COMPAT.md:33-45` 记录了失败形态：服务不存在时 **Cordis 不报错**，只让该行永久
  `pending`，`apply()` 从不执行，HTTP 路由从未挂载，用户看到的是"添加根目录返回 405"。

**0.2.1 下的风险**

- `[已验证]` 这 10 个服务名在 0.2.1-rc.2 的实装包里都有对应 `declare module '@deepseek-ai/cordis'` 声明
  （见 0.1 表格的"0.2.1 提供方"列），**所以这一条的风险已经很低**。
- `[未验证]` 但"包存在"≠"这条 profile 里挂成了可注入服务"。本仓有前例：
  `permissionPresets` 在 0.2.0 的包也在，却报 `cannot get property "permissionPresets" without inject`
  （`src/host/dsh-0.2-bridge.ts:1840-1846` 的实测记录）。
- **这是唯一能让插件"整个不启动"的翻车点**，也是唯一必须真机验的一项。

**建议改法**

不改代码，做一次**回归实测**，步骤沿用本仓既有隔离环境法（`DSH-0.2-COMPAT.md:186-201`）：

```sh
# 1) 本机四道门（pnpm 坏时用 node_modules/.bin 逐条跑，见 PITFALLS §pnpm store 打不开数据库）
npm run typecheck && npx vitest run && npm run docs:check && npm run build

# 2) 打包（按 RELEASE.md 新规矩用 npm，不用 pnpm pack）
npm pack --pack-destination artifacts

# 3) 隔离 DSH_HOME + 0.2.1-rc.2 内核，装真实 tarball
DSH_HOME=<scratch> dsh plugin --profile web add ./dsh-remote-bridge-2.4.2.tgz

# 4) 看启动日志有没有 pending 警告；然后打 8/8 接口：
#    healthz / manage/status / manage/roots / chat/workspaces / chat/sessions /
#    chat/agent-presets / settings/models / settings/providers
#    「添加根目录」必须是 201，不是 405。
```

若某一项注入失败，处理方式照 0.2.0 的先例：把该服务从 `inject` 摘掉、改走 `optionalService()` 容错读，
并给它打 `@patch` 四要素标（`AGENTS.md` §3.3）。

**涉及文件**：无源码改动；结果写进 `docs/project/TESTING.md`（新增一行）与
`docs/project/DSH-0.2.1-ADAPTATION.md`（回填"已验证"）。

---

### P1-2 把"兼容 0.2.x"从口头变成机制：`engines.dsh` + README 双站

**现状**

- `package.json:63-65` 只有 `engines.node`，**没有 `engines.dsh`**，也没有任何 `peerDependencies`。
- 后果（`[已验证]`，`dsh-app-boot/lib/index.js:311-330`）：`evaluatePluginCompatibility()` 对 2.4.2
  永远返回 `undefined`——**既不拦截也不提示**。用户在 0.3.x 上装 2.4.2，内核不会给任何警告。
- README 双站各有一句口头声明：`README.md:24-27`、`README.en.md:25-29`（"对 DSH 0.2.0-rc.2 的兼容层"），
  以及 `README.md:65` / `README.en.md:66`（"DSH 内核 `0.1.x` 或 `0.2.x`"）。

**0.2.1 下的机会**

- 加上 `engines.dsh` 后，内核会在**安装时与启动时**替你把关：版本不符 → `incompatible-version` 拒绝 +
  明确文案（`pluginCompatibilityWarning`，`app-boot/lib/index.js:332-336`），并给出
  `dsh plugin allow-version` 精确豁免通道。这是免费的用户体验，也是免费的风险边界。
- 同时修掉 README 那句错的"`0.1.x`"（见 P1-4）。

**建议改法**

`package.json` 的 `engines` 增加一项：

```json
"engines": {
  "node": "^22.19.0 || >=24.0.0",
  "dsh": ">=0.2.0-rc.2 <0.3.0"
}
```

选 `>=0.2.0-rc.2 <0.3.0` 而不是 `^0.2.0` 的理由（`[已验证：semver 实跑]`）：`^0.2.0` 不含
`0.2.0-rc.2`，会把上一轮适配所依据的那颗内核判为不兼容；而 `0.2.x` 虽然覆盖全，
但语义上不如显式范围清晰，且 `0.2.x` 在部分 semver 实现对 prerelease 的处理更绕。

**涉及文件**：`package.json`（`engines`）、`README.md:65`、`README.en.md:66`（同步改写版本要求句）。

---

### P1-3 `permissionPresets.catalog`：0.2.1 上从"同步进程级"变成"远程服务方法"

**现状**

- `src/host/dsh-0.2-bridge.ts:223-225` 把 `PermissionPresetsLike.catalog` 声明为 `(): Promise<unknown>`。
- 调用处 `src/host/dsh-0.2-bridge.ts:1837-1852`：先用 `optionalService()` 容错读（因为 0.2.0 上实测
  抛 `cannot get property "permissionPresets" without inject`），读不到就退到 `FALLBACK_PERMISSION_CATALOG`。
- 该补丁带 `@patch id: permission-presets-catalog-bff`（`dsh-0.2-bridge.ts:213-221`、`:1184-1190`），
  `until` 写的是"内核把候选项并进投影，或提供一条已含 options 的查询"。

**0.2.1 下的差异** `[已验证]`

- 0.2.1 的 `@deepseek-ai/dsh-permission-presets/lib/types/index.d.ts`：`PermissionPresetService extends TypertRemoteService`，
  `catalog(): PermissionCatalog` —— **同步返回，不是 Promise**；类上有 `@Remote('catalog')` 语义（Typert 远程服务）。
- 也就是说 0.2.0→0.2.1 之间这个方法**没有改名、没有消失**，插件结构类型仍然匹配。
- **但**：插件声明的是 `Promise<unknown>`，而 0.2.1 实际同步返回。`await` 一个非 Promise 值在 JS 里合法，
  所以**不会炸**；`normalizePermissionCatalog()` 收的是 `unknown`，也不受影响。
- 真正的不确定项是**注入面**：0.2.0 上这条服务注不进（插件因此常驻降级路径），0.2.1 是否变了，本机不可证。

**0.2.1 下的风险**

- 若 0.2.1 上仍注不进：功能不退（已降级），但用户看到的档位永远只有内置两档，
  **新档位加不进来**——这是"静默少功能"，正是 `capabilities.ts` 开头批评的那类问题。
- 若 0.2.1 上能注入：一切正常，且这条 `@patch` 的 `until` 条件可重新评估。

**建议改法**

1. 真机确认注入面（P1-1 的回归里顺手打一条日志或直接看端点返回的档位数）。
2. 若已能注入：把 `PermissionPresetsLike.catalog` 的返回类型改成 `PermissionCatalog | Promise<PermissionCatalog>`，
   调用处 `await` 不变（两种都吃）；同时在 `@patch` 的 `until` 里记下"0.2.1 注入面已恢复，待确认是否可删降级分支"。
3. 若仍不能注入：**保持现状**，但把降级的事实写进 README 的能力说明，别让用户以为档位菜单是全集。

**涉及文件**：`src/host/dsh-0.2-bridge.ts`（`PermissionPresetsLike`、`permissionPresets.catalog` 两处 `@patch` 注释）、
回归结果回填 `docs/project/DSH-0.2.1-ADAPTATION.md`。

---

### P1-4 README 双站："DSH 内核 `0.1.x` 或 `0.2.x`" 是事实错误

**现状**

- `README.md:65`：「DSH 内核 `0.1.x` 或 `0.2.x`（0.2.x 由本分支的兼容层支持…）」
- `README.en.md:66`：同义英文。
- 同一份 README 的 `:24-27` / `:25-29` 又说兼容层是基于 `0.2.0-rc.2` 的——两处口径本身就不一致。

**0.2.1 下的风险**

- `[已验证]` 2.4.2 的 `inject` 全是 0.2.x 服务名（`src/index.ts:48-68`），
  **0.1.x 上插件同样无法启动**（`apiProxy` 在 0.1.x 存在，但插件已经不 inject 它了）。
  也就是说 README 在**劝 0.1.x 用户装一个必然起不来的插件**。
- 这条与 0.2.1 无关，是 2.0.0 改名适配时留下的漂移；但既然要发兼容声明，就一次改对。

**建议改法**

双站同步改成与 `engines.dsh` 一致的口径：

```
- DSH 内核 `0.2.x`（`>=0.2.0-rc.2 <0.3.0`；0.2.0-rc.2 起由本插件的兼容层支持，
  见 DSH 0.2.x 兼容性适配说明）。0.1.x 不受支持——插件自 2.0.0 起只注入 0.2.x 宿主服务。
```

**涉及文件**：`README.md:65`、`README.en.md:66`（并复核 `:24-27` / `:25-29` 的措辞是否要升到 0.2.1）。

---

## 二、P2 —— 建议改，能提升

### P2-1 借 0.2.1 新表面删掉一次多余 RPC：history 不再单独取 projections

**现状**

- `src/host/dsh-0.2-bridge.ts:1274-1307`（`@patch id: history-projections-passthrough`）：
  因为 0.2.0 的 `follow()` snapshot 与 `page()` 都不返回 projections，插件在每次 history 请求里
  **额外发一次 `sessionController.projections()``**（`:1619`）。
- `@patch` 的 `until` 明写：「内核把 projections 并进 follow/page 的返回」。

**0.2.1 下的机会** `[已验证]`

- 0.2.1 的 `SessionFollowFrame` snapshot 分支**已经带 `projections: SessionProjectionBaseline`**
  （`dsh-api-session-controller/lib/types/types.d.ts:539-546`），且 `SessionProjectionBaseline`
  正是 `{ asOfSeq, values }`（同文件 `:67-71`）——与插件 `readSessionProjections()` 的返回形状一致。
- 换言之：**`until` 条件已经达成**，这条补丁可以收。

**建议改法**

```ts
// history 路径：优先用 snapshot 自带的 projections，取不到再单独问一次（老内核兼容）
const fromSnapshot = (snapshot as { projections?: { asOfSeq?: number; values?: unknown } }).projections
const projections = fromSnapshot?.values && typeof fromSnapshot.values === 'object'
  ? { ...(typeof fromSnapshot.asOfSeq === 'number' ? { asOfSeq: fromSnapshot.asOfSeq } : {}),
      values: fromSnapshot.values as Record<string, unknown> }
  : await readSessionProjections(host, sessionId, controller.signal)
```

收益：history 每次少一次 RPC（手机端对每个会话各拉一次，是热路径）；同时让
`@patch` 的 `until` 真正闭环，债务台账少一条。

**注意**：`page()` 分支仍拿不到 projections（0.2.1 的 `SessionPage` 仍是 `{ records, hasMore }`），
所以 `readSessionProjections()` 不能删，只能改成"snapshot 优先"。

**涉及文件**：`src/host/dsh-0.2-bridge.ts`（`history` 实现、`readSessionProjections` 的 `@patch` 注释）、
`tests/history-projections.spec.ts`（补一例"snapshot 带 projections 时不再调 projections()"）。

---

### P2-2 新增能力位 `session-working-directory-v1`

**现状**

- 0.2.0 时代会话的 `cwd` 只能从 `sessionController.list()` 的行上读（`dsh-0.2-bridge.ts:1160-1175`，
  用于图片交接目录解析 `handoffRoots`）。
- `docs/api/openapi.yaml:1058-1068` 的 session 视图已暴露 `cwd` / `cwdAbsolute`，但是**只读快照**。
- 0.2.1 内核侧与 working-directory 相关的能力在 `session-reference`（`listCandidates` 按 working-directory
  亲和度排序，`packages/context/session-reference/src/index.ts:156-176`）与 subagent 的
  working-directory 解析里，**没有暴露成 `sessionController` 的 get/set 远程方法** `[已验证：内核全树搜索无 `session/working-directory` 远程端点]`。

**0.2.1 下的机会与边界**

- 若目标是"手机上改会话工作目录"：**0.2.1 没有现成端点**，本条只能作为"未来内核提供时再加"的预留。
- 若目标是"把已有 `cwd` 提升为一等能力"：现在就能做——把 `cwdAbsolute` 的解析从"图片交接内部用"
  提成对外契约，加能力位 `session-working-directory-v1`。

**建议改法（取后者，低风险）**

1. `src/host/capabilities.ts` 加 `'session-working-directory-v1'`，依据指向 OpenAPI 的
   `GET /chat/sessions/{sessionId}` 的 `cwdAbsolute` 字段（`capabilities.ts` 的纪律：加位必须能在契约里指出依据）。
2. 同步 `docs/api/openapi.yaml`、`docs/api/asyncapi.yaml`（若有事件）、`kotlin-sdk`、`tests/capabilities.spec.ts`
   ——按 `AGENTS.md` §3.1「改 wire schema 五处一起」。
3. 不改内核交互，纯把既有事实对外声明。

**为什么不放 P1**：客户端（dsh-companion）现在不依赖它，不做也不会坏。

**涉及文件**：`src/host/capabilities.ts`、`docs/api/openapi.yaml`、`kotlin-sdk/src/main/kotlin/.../DshWorkspaceClient.kt`、
`tests/capabilities.spec.ts`、`docs/project/API.md`。

---

### P2-3 把"兼容层基于 0.2.0-rc.2"升级为"基于 0.2.1-rc.2 验证"

**现状**

- `docs/project/DSH-0.2-COMPAT.md:15`：「适配后的 DSH 内核 | `0.2.0-rc.2`」。
- 该文第 4 节记的全部实测（42 项单测、8/8 接口、11 帧 delta、70 会话探测）都是 0.2.0-rc.2 上的。

**0.2.1 下的机会**

- 0.2.1-rc.2 与 0.2.0-rc.2 之间，本插件依赖的面**没有破坏性变化**（见 0.1、0.2）。
  把这句话写下来，用户与后来者都能少一次重复摸索——这正是 `DSH-0.2-COMPAT.md:213` 自称的价值。

**建议改法**

在 `DSH-0.2-COMPAT.md` 顶部加一节「0.2.1-rc.2 复核」（或在本文件回填），列出：
- 复核日期、内核版本、12 服务名核对结果表（本文 0.1 那张）；
- 4 项 `[未验证]` 的真机回归结果；
- 与 0.2.0 的差异清单（目前只有"snapshot 带 projections"这一条确定差异）。

**涉及文件**：`docs/project/DSH-0.2-COMPAT.md` 或本文回填、`docs/project/STATUS.md`、`docs/project/TESTING.md`。

---

### P2-4 单元测试补 0.2.1 形状的 snapshot 桩

**现状**

- `tests/dsh-0.2-bridge.spec.ts` 的 host 桩（`:30-110` 一带）按 0.2.0 形状搭：
  `follow` 桩返回的 snapshot 没有 `projections` 字段。
- `[已验证]` 现有测试全绿：`npx vitest run` → **40 文件 / 305 用例通过**（2026-10-20 实跑）。

**0.2.1 下的机会**

- 桩不随内核升格，就会出现"0.2.1 已经在 snapshot 里给 projections 了、测试却还按老形状验"的盲区——
  正是 `DSH-0.2-COMPAT.md:159-161` 那条教训（单测能证明"拿到帧之后处理得对"，证明不了"帧会不会来"）。

**建议改法**

在 `tests/dsh-0.2-bridge.spec.ts` 的 host 桩里给 `follow` 的 snapshot 加 `projections: { asOfSeq, values }`，
并加一例断言：history 路径在 snapshot 带 projections 时**不再**调用 `sessionController.projections()`。
这与 P2-1 是同一处改动的两面，一起做。

**涉及文件**：`tests/dsh-0.2-bridge.spec.ts`、`tests/history-projections.spec.ts`。

---

### P2-5 统一 `cordis.patch.yml` 与 `src/index.ts` 的 inject 清单

**现状**

- `cordis.patch.yml:9`：10 个服务。
- `src/index.ts:48-68`：13 个服务（多 `permissionPresets` / `fileUploads` / `attachments`）。
- 两者不一致。注释说 patch 那份是"同步为 0.2.x 服务名"（`DSH-0.2-COMPAT.md:66`），但实际没同步全。

**0.2.1 下的风险**

- `[已验证]` 这 3 个服务在 0.2.1 都存在，所以现在不会坏。
- 但 Cordis 的 `inject` 是**插件能否激活的门**：patch 里少写一个，`apply()` 期间读它就可能撞
  `cannot get property ... without inject`。本仓对这个坑有专门处理（`optionalService()`，
  `dsh-0.2-bridge.ts:317-327`），所以现状是"靠容错读兜住"而非"靠注入声明保证"。
- 属于**潜在债务**，不是 0.2.1 特有。

**建议改法**

把 `cordis.patch.yml:9` 补成与 `src/index.ts:48-68` 相同的 13 个，并在注释里说明两处必须一致
（或反过来：把 `src/index.ts` 的 `inject` 删掉，只保留 patch 一份——需先确认 Cordis 加载器是否读 `src/index.ts` 的 `inject`）。
**先确认再改**，`[未验证]` Cordis 对"patch 的 inject"与"插件导出 inject"的优先级。

**涉及文件**：`cordis.patch.yml`（或 `src/index.ts`）、`tests/` 下若有 inject 清单断言需同步。

---

## 三、P3 —— 暂不做，说明为什么

### P3-1 不引入 on-demand bundle 机制

0.2.1 的 `@deepseek-ai/dsh` 包里确有 `OFFICIAL_ON_DEMAND_CATALOG` / `ON_DEMAND_BUNDLES`
（`dsh-app-boot/lib/index.js:4566` 导出表）。但本插件是**自包含 tarball**（`package.json:20-36` 的 `files`），
按需拆分会改变安装形态与 `exports`，收益（体积）不抵风险（装不上/装不全）。发布包现在 0.25 MB 量级，无此必要。

### P3-2 不把桥接层改成 import SDK 类型

本仓既定纪律（`DSH-0.2-COMPAT.md:57-58`、`AGENTS.md` §3.1）：**刻意不 import 任何 `@deepseek-ai/*`**，
全部结构化类型。这条纪律在 0.2.1 上**依然成立且更有价值**——本次调研的全部结论都建立在
"服务名 + 方法签名"的比对上，正因为没有编译期绑定，2.4.2 才不需要为 0.2.1 改一行源码。
改成 import 类型会把"内核小改"升级成"编译失败"，是净损失。

### P3-3 不做 Office 环境变量类适配

本插件不读任何 `DSH_*` 环境变量做行为分支（`grep` 全仓无此类逻辑）；0.2.1 亦无相关契约变化。
无对象可改。

### P3-4 不为 0.1.x 保留兼容

README 现在声称支持 0.1.x（P1-4），但 `inject` 早已全是 0.2.x 服务名。**不为 0.1.x 做双轨**：
那需要第二套桥接层（`DEBT-001`，`docs/project/TECH-DEBT.md:44`），成本高、用户群趋零。
正确做法是 P1-4 把文档改对，而不是把代码改回去。

---

## 四、测试与 e2e：能否验证 0.2.1 兼容性？

**现状** `[已验证：本机实跑]`

| 层 | 命令 | 2026-10-20 实跑结果 |
|---|---|---|
| 类型 | `npx tsc --noEmit` | （并入 vitest 前的 `npm run typecheck`） |
| 单元 | `npx vitest run` | **40 文件 / 305 用例全绿**，13.36s |
| 文档 | `npm run docs:check` | 未单独跑（本轮为调研，不跑全门禁） |
| e2e | `npx playwright test` | **无法验证 0.2.1 兼容性**——`e2e/styles.spec.ts` 是 4 个**样式契约**用例，渲染真实 DOM 量计算样式，**不需要服务器**（`AGENTS.md` §4） |
| 真机 | 人工 | **未做**——这才是唯一能验证 0.2.1 的一层 |

**结论：现有测试链没有一项能验证 0.2.1 兼容性。**

- 单元测试全部使用**本地桩**（`tests/dsh-0.2-bridge.spec.ts` 的 `host` 桩是手写对象，不是真内核），
  所以"全绿"只证明"拿到帧之后处理得对"，**证明不了帧会不会来、服务注不注得进**。
  这与 `DSH-0.2-COMPAT.md:159-161` 自己记录的教训完全一致。
- e2e 不连服务器，与内核无关。
- **因此 P1-1 的真机回归不是可选项，是唯一手段。**

**建议补的验证（不改测试框架，只加流程）**

1. 隔离 `DSH_HOME` + 0.2.1-rc.2 内核 + 真实 tarball（P1-1 的 4 步）。
2. 8/8 接口 + 「添加根目录 201」。
3. WebSocket 探针复现真实客户端行为（订阅事件流同时发一条消息），统计
   `chat.message.delta` / `chat.session.status` / `chat.message.committed` 帧数——
   这一项专门盯"流式增量会不会来"（0.2.0 的第 5/9 项缺口形态）。
4. 权限档位端点返回的档位数（≥2 且含内核新档位 → 注入面恢复）。
5. 结果写进 `docs/project/TESTING.md` 并在本文件回填 `[已验证]`。

---

## 五、README / package.json 需要改哪些行（结尾清单）

### 5.1 `package.json`

| 行 | 现在 | 改成 | 理由 |
|---|---|---|---|
| `63-65` | `"engines": { "node": "^22.19.0 \|\| >=24.0.0" }` | 增加 `"dsh": ">=0.2.0-rc.2 <0.3.0"` | P1-2。让内核在安装/启动时把关；`^0.2.0` 会漏掉 `0.2.0-rc.2` |
| `37-50` | `dsh.bundle.patch` + `dsh.client.inject`（4 包） | **不动**（见下） | 见 5.3 |

### 5.2 `README.md` / `README.en.md`（双站必须同步，`PITFALLS.md` §README 双站漂移）

| 文件:行 | 现在 | 改成 |
|---|---|---|
| `README.md:24-27` | 「增加了对 DSH `0.2.0-rc.2` 的兼容层」 | 「对 DSH `0.2.x`（`>=0.2.0-rc.2 <0.3.0`，含 0.2.1-rc.2 已验证服务面）的兼容层」；保留指向 `DSH-0.2-COMPAT.md` 的链接 |
| `README.md:65` | 「DSH 内核 `0.1.x` 或 `0.2.x`」 | 「DSH 内核 `0.2.x`（`>=0.2.0-rc.2 <0.3.0`）；0.1.x 不受支持」 |
| `README.en.md:25-29` | 同 :24-27 | 同 5.2 第 1 行（英文） |
| `README.en.md:66` | 同 :65 | 同 5.2 第 2 行（英文） |

### 5.3 明确**不改**的几处（避免误改）

| 位置 | 为什么不动 |
|---|---|
| `package.json:37-50` 的 `dsh.client.inject` 四个包（`@deepseek-ai/dsh-client-runtime` / `-ui-layout` / `-ui-sidebar` / `-ui-conversation`） | `[已验证]` 后三个在 0.2.1-rc.2 全部实装（`dsh-web-app` 的依赖清单里都在）；`dsh-client-runtime` 在 0.2.1 的实装树里**找不到**（只在 0.1.x 插件如 dshmarket / dsh-xdpool 的依赖里出现）。但**这不构成 0.2.1 上的问题**：该字段只影响 WebUI 客户端插件的加载，且缺失时的表现是"面板不渲染"而非"插件不启动"——需真机确认，属 P1-1 回归的一部分，**不预先改**。若确认要改，替换为 0.2.1 实装的 `@deepseek-ai/dsh-client-connection` / `@deepseek-ai/dsh-client-modules` / `@deepseek-ai/dsh-client-ui-slots`（参照 `dsh-im` 的 `client.inject` 写法） |
| `package.json:3` `version: 2.4.2` | 本文只调研不发版；改版本需走 `scripts/release.sh` 且 git 与 npm 同批（`AGENTS.md` §2 铁律） |
| `package.json:74` `license: AGPL-3.0-only` | 上游许可证，不动 |
| `cordis.patch.yml:13` `dataDir: !!js dshHomePath('dsh-workspace')` | 对外契约（`AGENTS.md` §1 三条不可动契约之一），不动 |
| `src/host/server.ts:325` REST 前缀 `/dsh-workspace-api` | 同上，已发布 App 写死，不动 |
| `docs/api/openapi.yaml` / `asyncapi.yaml` 的 `info.version` | 必须与 `package.json` 一致（`scripts/check-project-docs.ts` 机检）；除非 bump 版本，否则不动 |

---

## 六、一页速查

| 问题 | 答案 |
|---|---|
| 2.4.2 在 0.2.1-rc.2 上能直接运行吗？ | **大概率能**。12/12 注入服务名 + 全部方法签名 + 4 个事件名在 0.2.1 均在 `[已验证]`；但"注入成功"需真机确认 `[未验证]` |
| 哪些功能会坏？ | **没有必然坏的**。4 处可能静默退化：A 权限档位目录（可能仍只有内置两档）、B history 多打一次 RPC（不坏，只是浪费）、C 流式增量（内核语义未变，但是历史高危点）、D 附件读取（走内核 attachment，仍可用） |
| 能让插件整个起不来的是什么？ | 只有 `inject` 服务不存在导致 Cordis 永久 `pending`。按核对，0.2.1 上不触发 |
| 能声明兼容 0.2.0（最低版本）吗？ | **能，推荐**。`engines.dsh: ">=0.2.0-rc.2 <0.3.0"`——`^0.2.0` 会漏掉 `0.2.0-rc.2`，`0.2.x` 亦可但不够显式 |
| 现有测试能验证 0.2.1 吗？ | **不能**。单测全是本地桩；e2e 不需要服务器。唯一手段是隔离 profile + 真实 tarball 真机回归 |
| 最该先做哪一件？ | P1-1 真机回归（一次跑完，同时回答 A/B/C/D 与 `dsh-client-runtime` 五个疑问） |

---

## 附：调研方法与证据位置

| 结论 | 证据 |
|---|---|
| 12 个服务名在 0.2.1 存在 | 各包 `lib/types/index.d.ts` 的 `declare module '@deepseek-ai/cordis' { interface Context { … } }`：`dsh-api-session-controller` / `dsh-api-workspace-controller` / `dsh-workspace` / `dsh-api-settings-controller`（含 `credentials.d.ts`）/ `dsh-agent-preset-registry` / `dsh-permission-presets` / `dsh-llm` / `dsh-host-webserver` / `dsh-agent` / `dsh-commands` / `dsh-client-file-upload` / `dsh-attachment` / `dsh-user-questions` |
| 4 个事件名与 mode | `@deepseek-ai/dsh-api-remotes/lib/types/remote-events.d.ts:13-116` |
| `follow` snapshot 已带 projections | `@deepseek-ai/dsh-api-session-controller/lib/types/types.d.ts:539-546`；`SessionProjectionBaseline` 在同文件 `:67-71` |
| `assistantStream` 仍 opt-in | 同文件 `:482-486` |
| `commands.execute` 四参数 | `@deepseek-ai/dsh-commands/lib/types/index.d.ts:142` |
| `WebRoute` 结构一致 | `@deepseek-ai/dsh-host-webserver/lib/types/index.d.ts:32-40` |
| `permissionPresets.catalog` 同步返回 | `@deepseek-ai/dsh-permission-presets/lib/types/index.d.ts:95,135-138` |
| `userQuestions.continued` 仍 private | `@deepseek-ai/dsh-user-questions/lib/types/index.d.ts:42` |
| `engines.dsh` 判定逻辑 | `@deepseek-ai/dsh-app-boot/lib/index.js:252-336`（`unmetRequirements` / `evaluatePluginCompatibility` / `pluginCompatibilityWarning`） |
| semver 覆盖实跑 | 本机 `node -e` + 内核自带 `semver`，结果见 0.3 表 |
| 本仓测试现状 | `npx vitest run` → 40 文件 / 305 用例（2026-10-20） |
| 无 `session/working-directory` 远程端点 | 对 `dsh-root/packages` 全树 `grep -rn "working-directory"`：只命中 `session-reference`（候选排序）、`subagent`（子进程 cwd 解析）、`tool-cordis`（描述文本），无 controller 方法 |
