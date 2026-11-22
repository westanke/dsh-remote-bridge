# 坑位索引（PITFALLS）

> 名字 = 触发词 = 锚点。**动手改某块代码前，先按名字读对应条目**——里面是踩过的坑、
> 最硬铁律、实测数据与被否决方案。不看就改等于重踩。
>
> 索引在 `AGENTS.md` §6，两处必须同步：新增坑位 = 名字加进 `AGENTS.md` 清单 +
> 原文写进本文件并补 `### 同名` 锚点。
>
> 每条格式：**症状 → 根因 → 现在怎么办（铁律）**。
> 与 `dsh-companion/docs/project/PITFALLS.md` **共有**的条目措辞保持一致，改一处记得改另一处。

---

### build 不查类型

**症状**：本地 `pnpm build` 一路绿灯，产物发出去才炸——调用处还传着已被删掉的参数。

**根因**：`build` 走的是 **tsdown**（打包器），它不做完整类型检查。
真正查类型的是 `typecheck`（`tsc --noEmit`），而它只在 `check` / `prepack` 里跑。

**实发案例**（`docs/project/RETRO-question-card.md` 坑 B）：`QuestionBridge` 重构后
`wait.callId` 参数已移除，调用处还传着。`pnpm build` 绿灯，
是 `npm publish --dry-run` 触发 `prepack → pnpm check → tsc --noEmit` 才抓到。

**现在怎么办**：提交前跑 **`pnpm check`**（typecheck → test → docs:check → build），
不是 `pnpm build`。发版前**必须 dry-run 一次**——`prepack` 是发布前最后一道闸。

**铁律**：「build 绿了」不等于「类型过了」。要发版，先 `npm publish --dry-run`。

---

### README 双站漂移

**症状**：`pnpm docs:check` 全绿，但 README 双站的版本号、测试数、插件基线停在几个版本之前。

**根因**：`docs:check` 的 `requiredDocs` 里第一项 `'README.md'` 读的是
**`docs/project/README.md`（文档索引）**，不是仓库根的对外 README —— 所以根 README 长期
不在任何机检范围内，「改文档再发版」这道闸在它这里是空的。

**实发案例**（姊妹仓 `dsh-companion`，2026-10-14 commit `d61cad9`）：
v2.2.33 → v2.2.35 三版发布时 README 未同步，中文停在 `v2.2.32`，英文更老（测试数写 24 类/256，中文写 25 类/271，
**两份自己就对不上**）；bridge 版本要求还出现一处 ≥2.3.3、一处 ≥2.3.1 的自相矛盾。

**现在怎么办**：2026-10-20 起这条已**部分机检化**（`scripts/check-project-docs.ts` 新增
「根 README 双站与 CHANGELOG」一节，独立成节、不动 `requiredDocs` 语义）：根 README 双语必须都在、
DSH 内核版本范围（形如 `>=0.2.0-rc.2 <0.3.0`）双语一致且对上 `package.json` 的 `engines.dsh`、
「项目信息 / Project」小节的当前版本对上 `package.json`、变更记录里有当前版本条目。
**没被机检的**仍是测试文件数/用例数、APK 体积与 SHA-256、截图说明 —— 这些照旧人工对账：

```sh
grep -n '"version"' package.json                          # 真值来源
grep -n "2\.3\.[0-9]\|dsh-remote-bridge" README.md README.en.md   # 双站一致
find tests -type f -name "*.ts" | wc -l                   # 测试文件数
```

**铁律**：英文版最容易漏——它是「没人同步的那一份」。中英一起改。
新增口径时先问一句「这条能不能进 `docs:check`」，能进就别只靠人眼。

---

### patch 的 inject 覆盖插件 inject

**症状**：`ctx.someService` 读不到，报
`cannot get property "someService" without inject` ——
与「内核压根没提供这个服务」的报错**一模一样**，肉眼分不出来。

**根因**：`cordis.patch.yml` 里插件行的 `inject` **覆盖**插件自己
`export const inject`，不是取并集。于是「插件声明了、patch 漏了」的服务
在 fiber.inject 里根本不存在，报的是「没声明」那一档错误。

判别两种错误（cordis `ReflectService.handler.get` L676）：

| 报错 | 含义 |
|---|---|
| `cannot get property "x" without inject` | x **不在** fiber.inject 里 → patch 覆盖漏了 |
| `cannot get required service "x" in inactive context` | x 在 inject 里但 impl 缺失 → 依赖没激活 |

**为什么这条特别阴险**：它长期掩盖了 4 个服务缺失。`permissionPresets` 曾被
连续多份文档断言为「web profile 注不进、只能走内置兜底目录」，实际是 patch
没声明它；`fileUploads` / `attachments` 同理。**结论错得很有说服力**，
因为报错形态完全一致 —— 只有 `dsh --profile web --dump-config` 看注入清单
才能分辨。

**现在怎么办**：
1. 加新服务时**两处一起改**：`src/index.ts` 的 `export const inject` 与
   `cordis.patch.yml` 的 `inject`。
2. 这条已机检：`pnpm docs:check` 会双向比对两者，少了报「缺少」、
   多了报「多出」（多了更糟 —— 声明不存在的依赖让整个 entry 永远 INACTIVE）。
3. 排查服务缺失时，**先 dump 再看源码**：`dsh --profile web --dump-config`
   里插件行的 inject 才是运行时真值。

### apiProxy 消失

**症状**：插件在 DSH 0.2.x 上「装上了但不工作」——没有报错日志，
WebUI 里还能打开插件设置页，但 `apply()` 从不执行，HTTP 路由从未挂载。
最误导的表现：添加根目录返回 **405**。

**根因**：DSH 做了一个**破坏性替换**：

```
0.1.x : @deepseek-ai/dsh-host-apiproxy      → Cordis 服务名 apiProxy
0.2.x : @deepseek-ai/dsh-api-gateway        → Cordis 服务名 typertGateway
```

插件原本在 `cordis.patch.yml` 里 `inject: [apiProxy, ...]`。
被注入的服务不存在时，**Cordis 不报错退出**，而是让该行永远停在 `pending`
（只有一行 `pending (waiting for service: apiProxy)` 的 warning）。

**现在怎么办**：`src/host/dsh-0.2-bridge.ts`（1 730 行）用 0.2.x 的宿主服务
（`ctx.llm`、`ctx.workspaceRegistry` 等）**重建** `apiProxy` 面容。
完整说明见 `docs/project/DSH-0.2-COMPAT.md`。

**铁律**：
- 任何 `inject` 的服务不存在时，先查上游是否**改名/替换**了，别先怀疑自己的代码。
- 这个适配层要按 `AGENTS.md` §3.3 打 `@patch` 标，`until` 写「上游恢复 apiProxy 或本项目只支持 0.2.x」。
- **pending 不等于装好了**——判断插件是否生效，看路由是否真的挂载，不看有没有 warning。

---

### 前缀契约

**症状**：删掉某个页面后，线上 App 突然全部连不上。

**根因**：REST 前缀 `/dsh-workspace-api` 与独立页面 `/dsh-workspace` 曾被误当成一回事。
**前缀还在**（App 硬编码），**页面没了**（2.2.0 已删）。

**现在怎么办**（`src/host/server.ts:325`）：`webServer.register` 必须保留
`kind: 'prefix', path: '/dsh-workspace-api'`。注释在 `server.ts:316` 明示：
released apps hard-code it。

> 同理，状态目录 `dsh-workspace` 也不能改——换目录等于让用户的授权根配置与回收站全部消失。
> **看到旧名不是改名没改干净**，是刻意保留的契约。

**铁律**：改名前先问「哪些是契约」。改名只改「安装时叫什么、bundle 叫什么」。
判断方法：**已发布的下游有没有把它写死**。写死了就是契约。

---

### 端口 3090 归属

**症状**：与 DSHA 系产品同机部署时端口占用，或用户按示例填的地址连不上。

**根因**：3090 在生态里是**双重身份**：
- 本插件默认监听（`src/host/config-text.ts:67` `DEFAULT_PORT = 3090`）
- DSHA App 侧设备桥 `Constants.SHELL_BRIDGE_PORT = 3090`（给容器内插件调 `/app/*`）

且 DSHA 的内置插件把 3090 **硬编码**（`dsh-deliverable-mobile/lib/index.js:19` 的 `BRIDGE_BASE`）。

**现在怎么办**：绑定 IP 与端口都可在回环管理面配置（ADR-0004），失败自动回滚。
示例地址（`config-text.ts:24`）用 3090 作默认值。

**铁律**：文档/示例里的端口号改了，记得同步 `config-text.ts` 与 README 双站；
**若要与 DSHA 同机并存，把本插件改到 3091** 并写进说明。
（`dsh-companion` 侧同一坑位措辞一致。）

---

### 归档点了不消失

**症状**：会话点归档后，列表刷新它还在；再点一次才消失。

**根因**（v2.3.6 修复）：桥接读内核归档集合时**读成了空数组**——
取值字段与内核实际返回结构不一致，于是「已归档」判定永远为假。

**现在怎么办**：回归用例已加。读内核集合类字段时，**先打一次真实响应确认字段路径**，
别按类型定义推断（类型定义可能滞后于运行时）。

**铁律**：跨内核版本读集合/对象时，用一次真实响应校字段；「类型说它有」不等于「运行时真有」。

---

### 审批与提问卡片全灭

**症状**：手机上审批卡片、提问卡片一张都不显示（v2.3.6 修复）。

**根因**：`sessionIdOfAgent` **查错了字段**——内核的 `Agent.id` 才是 `SessionId`
（`dsh-agent/lib/types/types.d.ts:11-14`），原实现取了另一个标识，
导致按 sessionId 匹配时全部落空。

**现在怎么办**：`src/host/dsh-0.2-bridge.ts:898-911` 的 `sessionIdOfAgent`
已改为以 `Agent.id` 为准，并注明依据文件行号。

**铁律**：身份字段映射（Agent / Session / Run）**必须贴内核类型定义的行号**，
不要凭命名直觉。这类错误不会报错，只会静默返回空。

---

### 抢答与 next() 委托

**症状**：给插件加了提问界面后，官方 WebUI 上的同一个提问不再弹出，或两边同时弹。

**根因**：内核 host 面定义了 `user-questions/request` 事件，
签名 `(request, next) => Promise<AskUserQuestionAnswer>`——**`next` 是委托给官方界面的钩子**。
插件如果直接返回答案（抢答），就绕过了官方 WebUI。

**现在怎么办**：像 approvals 那样用 `next()` 委托兜底——
手机上没人答时委托给电脑上的官方界面，别让 agent 干等。

**铁律**：内核给的 `next` 不是可选项，是**协作协议**。要插界面，先委托；要拦截，先想清楚谁兜底。

---

### wait.callId 判据过严

**症状**：plan 模式的问答卡片整条不显示，其他模式正常。

**根因**（`docs/project/RETRO-question-card.md` 坑 A）：`QuestionBridge` 最初的判据是
「拿不到 `request.wait.callId` 就整条委托」。而 plan 模式的请求**不带** `callId`，
于是整条被当作「非本插件该处理的」直接委托走，卡片自然不显示。

**现在怎么办**：放宽判据——`callId` 只是可选增强信息，不是准入条件。
复盘的方法论教训更值钱：**先确认现象真的发生过，再解释现象**
（那次排查中卡片代码从头到尾都是对的，错的是排查方法）。

**铁律**：用可选字段做**准入判据**前，先确认它在所有模式下都存在。

---

### npm pack 与 pnpm pack

**症状**：本地产物的哈希与 npm 上那份对不上。

**根因**：两个打包器产物的 shasum/integrity 不一致。

**现在怎么办**（`docs/project/RELEASE.md` 新规矩）：正式产物必须用
`npm pack --pack-destination artifacts`，不用 `pnpm pack`。
v2.2.1 是第一次按此规矩执行，哈希成功对上。

**铁律**：要校验产物一致性，用与发布方相同的打包器。

---

### Gitee Release 死链

**症状**：README 里写的 Gitee 安装命令 404。

**根因**：Gitee 插件库此前**只有 tag、没有任何 Release**（API 查询返回 Release 数 0），
而安装命令指向 Release 资产。

**现在怎么办**：用 Gitee API v5 补建 Release（v2.0.4，id 1192683），上传同一份 tarball。
写双列地址前**先验证两端都真的可达**。

**2026-10-19 又栽一次，换了个面孔**：这次 Release 有货、附件也在，但 README 的链接仍然 404 ——
因为**文件名对不上**。`npm pack` 产出 `dsh-remote-bridge-<ver>.tgz`（**无 v 前缀**），
README 两条安装命令写的是 `dsh-remote-bridge-v<ver>.tgz`（**带 v**）。对照 v2.4.1 的附件列表，
上一版就是裸名 —— 也就是说这个链接**从 v2.2.x 起就没工作过**，只是没人点过。
现在 `scripts/pack-release.sh` 产出**两个名字各一份**，上传时两份都传，文档怎么写都能下。

**铁律**：双站镜像 ≠ 双站都有货。写进文档的下载地址，两端都要点一次 ——
而且要点的是**文档里那个字面地址**，不是「我以为的产物名」。

### inject 是硬依赖：只放「所有支持版本都存在」的服务

**症状**：某个内核版本上插件**整个不激活**，报

```
dsh-remote-bridge: pending (waiting for services: sessionController, ..., jobController, fileUploads)
Error: dsh: plugin tree failed to load: dsh: 1 entry did not activate
```

**根因**：cordis 的 `inject` 是**硬依赖**（`cordis/lib/types/registry.d.ts` 的 `Inject`
类型注释原文 "required services"）—— 任何一个服务缺失，`_refresh()` 就把 epoch 置为
INACTIVE，**整个插件不激活**。所以「某版本才有的服务」写进 inject 的意思是
**那个版本上插件整个死掉**。

**踩坑实例（2026-10-20）**：把 0.2.1 才有的 `jobController` / `fileUploads` /
`attachments` / `permissionPresets` 加进 inject 后，插件在 **0.2.0-rc.2** 上整体不激活
（CI 的 `profile-install` job 检出固定上游提交 47f9438 = 0.2.0-rc.2 基线）。
**这直接证伪了本仓自己写下的 `engines.dsh: >=0.2.0-rc.2 <0.3.0` 声明。**

**正确做法**：

1. `inject` 只放**所有支持版本都存在**的服务；
2. 某版本才有的服务声明成**可选**（`foo?: FooLike`），运行时经
   `ctx.reflect.get(name, false)` 读 —— cordis 给这件事准备的正路
   （`ReflectService.get` 注释原文："Read a service from the store **without the inject
   requirement**"），服务不存在时返回 `undefined` 而不是抛错；
3. 「不声明」与「声明了但服务没提供」在运行时报**同一个错**
   （`cannot get property "x" without inject`）—— 只有探针能分辨，
   见 §patch 的 inject 覆盖插件 inject。

**铁律**：加一个 inject 服务之前，先问「**最老的支持版本上有它吗**」。
`docs:check` 的 inject 对齐门禁只保证 patch 与 `src/index.ts` 两份清单**互相一致**，
不保证它们**在所有支持版本上都存在** —— 后者只能靠真机/CI 验证。

### Gitee API 的 token 必须放 form 字段

**症状**：建 Gitee Release 一律返回
`{"message":"登录失效，无权限访问该资源","code":40001}` —— 看着像 token 失效或没权限。

**真相**：token 本身是好的，只是**以 query 参数传时 Gitee 的写接口不认**。

| 传法 | 结果 |
|---|---|
| `?access_token=$GT`（query） | ❌ 40001 登录失效 |
| `-F "access_token=$GT"`（form 字段） | ✅ 一次成功 |

**排查时容易走错的路**（2026-10-20 实际走了一遍）：

| 猜测 | 实测 | 结论 |
|---|---|---|
| token 过期 | `GET /api/v5/user` → **200**，返回 `{"login":"westanke"}` | token 有效 |
| 仓库无权限 | `GET /api/v5/repos/...` → **200** | 仓库可读 |
| payload / 正文格式错 | 手工用同样 payload POST → 同样 40001 | 与内容无关 |
| git 身份问题 | `git ls-remote gitee` → 正常 | git 推送完全正常 |

**所以「读接口通 + 写接口 401」这个组合，唯一可能就是传参方式**。

附件 `attach_files` 一直是 form（`-F "file=@..."`），所以**只有建 Release 这一步**会踩。

**另一条**：回读下载要用**网页直链**
`https://gitee.com/<owner>/<repo>/releases/download/<tag>/<file>`（不带 token），
API 路径 `/api/v5/repos/.../releases/download/...` 返回 404 HTML。
且 `foruda.gitee.com` 的 CDN 偶发只给 52 字节，**回读要重试**再判失败。

---

### waterfall 不 prepend 就等于没注册

**症状**：审批与提问卡片在手机端**一张都不显示**，而电脑端官方 WebUI 一切正常；
两侧日志都不会说一句话（本插件的 `log()` 里一条 approval/question 记录都没有）。

**根因**：内核的 `approval/request` 与 `user-questions/request` 是 **waterfall** 链。
Cordis 4.0.2（`vendor/cordis/src/events.ts`）：

- `:143` / `:255` —— 注册就是数组插入：`const method = options.prepend ? 'unshift' : 'push'`；
  **不传 `prepend` 就是 `push` 到链尾**。
- `:225-228`（waterfall 语义原文）——「Listeners run outermost-first;
  **a listener that does not call `next()` vetoes the rest of the chain**」。

于是：不 prepend 时本插件排在官方 WebUI 的监听器**之后**；官方 WebUI 自己处理掉
这次审批/提问就不调 `next()`，**本钩子永远不被调用**——表现与「压根没注册」完全一样。

**现在怎么办**：两个钩子注册时都传 `{ prepend: true }`
（`src/host/dsh-0.2-bridge.ts` 的 `ApprovalBridge.attach` 与 `QuestionBridge.attach`）。
**真机已验证**（v2.3.7，2026-10-16）：改前 plan 模式评审卡片只有电脑端弹、
手机端零卡片；改后**手机端与电脑端同时正常弹出**，电脑端行为一字未变（没抢答）。

**为什么难以发现**：提问钩子的源码注释里**早就写对了这段机理**
（「我们必须在链的最外层……排在后面的话，前面那家一旦不调 next（veto 整条链），
我们根本不会被调用」）——**知道该怎么做，只是注册时漏了这个选项**。
且失败路径**完全静默**，没有任何日志或报错。

**铁律**：① 在 waterfall 事件上注册接管钩子，**必须 prepend**；
② 测试替身若忽略第三个参数，`{ prepend: true }` 写错或被删都不会红 ——
本仓 `tests/dsh-0.2-bridge.spec.ts` 的 `makeHost().on` 已按 `unshift`/`push` 忠实建模，
并有回归用例「registers both interaction hooks at the head of the waterfall chain」盯着。

---

### 审批否决下游：电脑端审批卡要等 10 分钟才出现

**症状**（#13，v2.10.0 真机，Windows 11 桌面 WebUI + 手机配对但离线）：
手机端审批卡片**立刻**出现，电脑端官方 WebUI 的那张卡却要等几分钟到一小时才可点。
实测 11 次审批的 `approval/asked` → `approval/decided` 间隔：
8.1s / 21.7s / 310.3s / 372.4s / 605.0s / 676.9s / 724.3s / 759.4s / 1354.5s / 6864.1s
——其中 5 次**恰好**是 600s + 反应时间（600s = `APPROVAL_PENDING_TIMEOUT_MS`）。

**根因**：`ApprovalBridge.attach` 以 `{ prepend: true }` 注册后，
在 `await` 挂起期间**从不调 `next()`**。而 Cordis 的 waterfall 契约是
「**a listener that does not call `next()` vetoes the rest of the chain**」
（cordis `lib/index.js:307-325`）—— 不调 `next()` 等于**否决整条链**，
官方 WebUI 那条远端 answerer **根本没收到这次请求**。
旧实现只在超时后才 `if (outcome === 'delegate') return next()`，
于是电脑端那张卡恰好在超时那一刻才冒出来。

**与上面那条坑的关系**：「waterfall 不 prepend 就等于没注册」讲的是**链首位置**；
这条讲的是**调不调 `next()`**。两条是不同的失败方式，症状却相反 ——
不 prepend 是手机端一张卡都没有，否决下游是手机端有卡、电脑端没有。

**现在怎么办**（#13）：审批侧改成与 `QuestionBridge` 同一个范式 ——
**进入即委托**（`next()` 只在这条路径上被调一次），然后与手机端 `Promise.race`：
- 下游给 `'unavailable'` **不算答复**（那是内核「链上没人接」的兜底值，
  `dsh-user-approval/lib/index.js:176`），必须继续等手机端；
- 手机端先赢 → 推**带** `outcome` 的 `approval/resolved`；
- 电脑端先赢 → 推**不带** `outcome` 的 `approval/resolved`（语义 = 收起陈旧卡片）；
- 超时 → 回落成内核兜底 `'unavailable'`，**绝不** `'allowed-once'`。

**代价（必须认下来）**：两端各一张卡，后答的那端拿到 `not-pending`
（409 APPROVAL_NOT_PENDING）；官方客户端**没有外部撤销通道**，
手机端先赢时电脑端那张卡要用户点一下才消失。
这正是 `docs/project/decisions/ADR-0009-single-winner-interactions.md` 讨论的选项 B。

**铁律**：① 在 waterfall 链上插界面，**先委托再竞速**，不要「攥住等自己答」；
② 内核兜底值（`'unavailable'`）是「没有通道」，**不是答复** ——
把它当答复等于手机端还没答就被拒；③ 超时**绝不**自动批准 ——
「没人回答 = 默认批准」是把安全判据交给一个定时器。

---

### npm 发布：本地 npm 不支持 staged，报错方向还相反

**症状**（2026-10-19 发 v2.4.2 时）：
1. 本地 npm 10.9.9 跑 `npm publish` → 输出 `+ dsh-remote-bridge@2.4.2` 像是成功，
   但 `npm view` 查不到；
2. 再发一次 → `E409 Cannot publish over previously **staged** version "2.4.2"`；
3. 换 `npm@12` 再发 → `You cannot publish over the **previously published** versions: 2.4.2`。

三次报错，两个相反方向（「还没发」vs「已经发过」），全都指向「这版本状态不明」。

**根因**：账号的 token 是 **bypass-2FA 型**，npm 官方已把它限制为**只能暂存发布**，
而本地 npm 10.9.9 对 staged 流程支持不完整。第 3 步的「已经发过」才是事实 ——
**第一次发布真的成功了，只是 registry 的 CDN 要几分钟才可见**。

**现在怎么办**：`scripts/publish-npm.sh`。它做三件事：
① 发布前先查 registry 是否已有该版本（有则直接早退，避免撞上面那串鬼报错）；
② 用 `npx npm@12 publish`；
③ **不看 publish 的退出码，只看 registry 的实际状态**，每 15 秒轮询一次、最多 8 分钟。

**铁律**：`npm publish` 的退出码不足以判断成败，**以 registry 回读为准**。
「命令说成功」与「包真的在了」是两件事。

### 孤立代理项打死整条连接

**症状**：客户端「突然不再更新」——WebSocket 看着还连着，但一帧都不再处理。
服务端日志干净（`JSON.stringify` 本身没报错），客户端侧只有一句 JSON 解码失败。
重启客户端后一切正常，直到下一次同样的输出再次出现。

**根因**：DSH 内核按**字符数**截断摘要（工具输出、标题）时，截断点可能落在代理对中间，
字符串里只剩**半个** UTF-16 代理项（emoji、部分 CJK 扩展字）。`JSON.stringify` 会照常把它
转义成 `\udXXX` —— JSON **语法合法、语义非法**，而 Swift/Foundation 的 JSONDecoder
拒绝的是**整帧**，不是那个字段。一个坏字符 = 一条连接静默死亡。

**现在怎么办**：出网统一走 `src/host/wire-json.ts` 的 `stringifyWire()`（孤立代理项 → U+FFFD）。
两个出网口都已接入：WS（`server.ts` 的 `connection.ready` 与 `broadcast`）与
HTTP JSON（`router.ts` 的 `sendJson`）。**新增任何出网口都要走它**，不要直接 `JSON.stringify`。

**铁律**：跨端协议上的字符串必须保证是**合法 Unicode** —— 同一个坏字符在 JS 端无害，
在 Swift 端是整帧被拒。判断责任时先看**接收端能不能解**，而不是看发送端有没有抛错。

**回归**：`tests/wire-json.spec.ts`（8 用例，含嵌套结构往返、干净输入与原生逐字节一致、
20 万字符病态输入）。

---

### pnpm store 打不开数据库

**症状**：任何 `pnpm` 命令（含 `pnpm --version`）直接失败并打印
`[ERROR] unable to open database file`，连帮助都出不来。
而 `node --version`、`npm` 与项目 `node_modules/.bin/` 下的 tsc / vitest / tsx / tsdown 全部正常。

**根因**：本机 pnpm 自身的 store/state 层问题（pnpm 11 用 SQLite 维护索引）。
换 `XDG_STATE_HOME`、换 `store-dir` 都无效，`~/.local/state/pnpm` 里只有一份正常权限的
`pnpm-state.json` —— 所以不是项目配置，而是**全局 pnpm 安装或它的 store 索引损坏**。
2026-10-17 首次遇到，尚未修复（npm 10.9.9 / node v24.19.0 / 磁盘余量 747G 均正常）。

**2026-10-19 根治了一半**：`package.json` 里 `check` / `build` / `prepack` 曾经**内部再调 pnpm**
（`pnpm typecheck && pnpm test && …`），于是 `npm publish` 的 prepack 钩子会在 pnpm 一坏时整条断掉，
报错还只说「pnpm 打不开库」。现已全部改成 `npm run` 自调用：
`pnpm check` 入口照旧可用（pnpm 跑 check 脚本），而 `npm run check` 也能独立跑通。
**新脚本一律用 `npm run` 串，不要用 `pnpm` 串** —— 让发布链不依赖那个会坏的东西。

**临时口径（pnpm 整体不可用时）**：`pnpm check` 的四道门**逐条等价执行**：

```sh
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run
./node_modules/.bin/tsx scripts/check-project-docs.ts
./node_modules/.bin/tsdown
```

**铁律**：pnpm 不可用时**不要**去改项目脚本迁就环境；用本地二进制跑等价门禁，
并在提交信息与日志里写明「本次不是一条命令跑的」。**环境修复后必须补跑一次完整 `pnpm check`**
—— `prepack`（发版前最后一道闸）只有它能触发，`build` 不查类型（见本文件 §build 不查类型）。

---

### 截断标记与内容必须同源

**症状**：响应里带了 `truncated: true`（或 `bridgeTruncated` 之类）的标记，客户端据此提示用户
「内容已截断」，**而内容一个字符都没少**。反过来更危险：内容真被裁了却**没有**标记，
用户以为看到的是全文。

**根因**（2026-10-17 实发）：`history-budget.ts` 初版给事件贴标记时写的是
`{ ...entry, bridgeTruncated }` —— 用的是**原始** entry，而裁剪结果在 `result.value` 里。
于是「标记加上了、内容没换」。更值得记住的是：**单元测试里只断言「有标记」时它会静默通过** ——
断言写弱了，等于给 bug 发了通行证。

**现在怎么办（铁律）**：
- 任何「我改过了」的标记必须与**改动后的数据**来自同一处（同一个变量/对象），
  不能一边留着旧引用、一边贴新标记。
- 测试必须**双向**：有标记 ⇒ 内容确实变了（长度或字节数变小）；
  无标记 ⇒ 内容与输入**逐字节一致**。只测一侧等于没测。
- 回归钉子：`tests/history-budget.spec.ts` 的
  「never marks an event as truncated unless its content really shrank」与
  「leaves a within-budget response exactly as it was, with no extra fields」。

---

### 论证要先追到消费侧

**症状**：文档 / 提交信息 / 代码注释里写下「X 不会做 Y，所以这里是缺口」，
而实际上 X **会**做 Y。依据只是「我 grep 了 X 的入口文件，没看到」。
更麻烦的是这种结论会被当成设计依据继续传播 —— 后来的人只抄前一句，不会重查。

**根因**（2026-10-17 实发）：给「连接即重放」写动因时，只 grep 了客户端 data 层的
`DshClient.onOpen`（那里确实只改连接状态），就断言「自动重连不触发任何业务刷新」。
而真正的刷新发生在**上一层**：`HarnessViewModel.connectEvents` 的 `connection` 回调
（`dsh-companion` 的 `HarnessViewModel.kt:537-546`）在连接成功时刷新历史、审批、提问与命令。
搜索停在了「信号的发出处」，没走到「信号的消费处」。

**现在怎么办（铁律）**：
- 说「某某不做某件事」之前，必须追到**消费该信号的那一层**：回调的注册方、
  事件的订阅方、接口的调用方。只搜发出方得出的结论**不算证据**。
- 中间隔着回调 / 事件 / 抽象类时尤其危险：「发出方只做了 A」≠「系统只做了 A」。
- **纠错要留痕**：改正措辞之外，还要在 `CHANGELOG-DEV.md` 里写一句
  「初稿论证是错的、错在哪」——否则下一个人会顺着旧结论再推一遍。
  本条的实例见 2026-10-17「连接即重放」条目末尾的纠错记录。

**为什么值得单列**：这类错误**没有测试能抓**（代码全绿、行为也对），
它污染的是「为什么这么做」的记录，而那份记录正是后来者唯一能依据的东西。

---

### 空结果的来源要验证

**症状**：注释 / 文档 / 提交信息里写着「X 里**没有** Y（已 grep）」，看起来有证据，
而那条 grep 的 0 命中来自一个**不存在的目录**（或压根没读到的文件）。结论有证据的外形，
实际是**空证据**，还会被后来者当依据继续传播。

**根因**（2026-10-17 实发）：为「历史响应为什么不照抄字段级裁剪」写理由时，
`grep -rho "tool/result" node_modules/@deepseek-ai/` 返回 0，我据此写下
「本仓与**内核的 `node_modules`** 里都零命中」。而 `node_modules/@deepseek-ai`
**根本不存在** —— 官方内核包随 DSH 主包安装，本仓只把它们列为 peer 依赖；
**这一点本仓 `CHANGELOG-DEV.md` 里早就写着**（2.1.x 那条「官方内核包随 DSH 主包安装，
不会出现在 profile 的 `node_modules` 下」）。我既没验证路径存在，也和仓库已有知识矛盾。

`grep` 对不存在的路径返回空输出 + 退出码 2，与「目录存在但没匹配」在终端上几乎一样 ——
**除了退出码，两者不可区分，而人不会去看退出码**。

**现在怎么办（铁律）**：
- **先确认目标存在，再引用它的查询结果**：`ls -d <path>` / `test -d <path>` 跑一遍再 grep；
  或者把范围限定在**仓库内**（`grep -r --include='*.ts' PATTERN src/ tests/ docs/`），
  这样"路径不存在"这个失败模式从根上消失。
- 区分三种「没有」，只有第一种能当证据：
  ① 我查了，目标存在，确实没有 → 可写「已核」；
  ② 我查了，但目标不存在 / 没读到 → 只能写「**本仓不可证**」；
  ③ 我没查 → 什么都不该写。
- 审稿看到「已核 / 零命中 / 不存在」这类断言，先问：**查的是哪条路径？那条路径存在吗？**

**为什么值得单列**：这类错误**没有测试能抓**（代码全绿、行为也对），
它伪造的是「为什么这么做」的依据 —— 而那份依据正是后来者唯一能据以判断的东西。
与 §论证要先追到消费侧 是一对：那条讲「别把发出方当消费方」，这条讲「别把查不到当不存在」。

---

### wss 端点必须归一成 https

**症状**：配置文本里直接塞 `wss://…`（隧道给的原始地址），App 解析时报错 / 直接打不开。

**根因**：`config-text.ts` 的 `normalizeBaseUrl` 与 App 端 `DshClient.normalizeEndpoint`
（`dsh-companion`）都有一条硬性的 `require(input.startsWith("http://") || input.startsWith("https://"))`
—— **前缀必须是 `http(s)://`**，写 `wss://` 会被 `require` 直接 throw，
或判定为「非端点地址」。`wss://` 的「s」其实由 OkHttp `HttpUrl` 根据 scheme 在拼 `/events` 时
自动补上（`https` → `wss`），bridge 自己不终止 TLS。

**现在怎么办（铁律）**：生成配置文本时收到隧道地址
`wss://xxx.trycloudflare.com` / `https://your.domain`，**一律归一成 `https://` 再进配置文本**，
绝不让 `wss://` 字面量进入 `DSH1:` 文本。客户端拼 `/events` 时自动升级为 wss。

---

### 国内下载 cloudflared 必须择源

**症状**：UOS 20 上「创建云隧道」一直转圈 / 卡死 / 点了没反应，日志里是 `github.com/…/cloudflared…` 超时。

**根因**：cloudflared 官方二进制主要发布在 GitHub Releases，国内裸连时好时坏；直接走 GitHub
是「能否上网看脸」。更隐蔽的是——**复用 fetch 的超时**：被墙网络的 TCP 连接是「半开挂起」，
Node 的 `fetch`（undici）对这类连接**不响应 `AbortController.abort()`**（真机实测 15s 超时
根本不触发、请求永久挂起），于是「超时 → 回退 deb」永远走不到，前端只看到泛型 500「内部错误」、
没有具体原因（asApiError 吞掉 non-ApiError 的 message）。

**现在怎么办（铁律）**：
- 下载用**原生 `node:https`**（`downloadHttps`），`req.destroy()` 从 socket 层硬掐断被墙连接，
  必然在超时内返回（回归用例 `downloadHttps aborts within the timeout` 盯着）。
  超时语义只到「响应头到达」，否则 20MB 的 deb 会被「下载慢」误判成超时。
- 取源顺序（`ensureCloudflared`）：显式 `CLOUDFLARED_MIRROR`（若设）→ 官方 GitHub →
  官方 deb 兜底 `pkg.cloudflare.com`。三者都失败时聚合原因给前端（502
  `TUNNEL_DOWNLOAD_FAILED`），而不是泛型 500。**2.5.2 / SEC-H7 起原因必须脱敏**：
  聚合点与 router 出口都过 `sanitizeDownloadError`（完整 URL → 仅保留 host、绝对路径 → 仅保留 basename），
  502 响应的 `message` 是固定英文兜底句，具体原因放 `details.reason`（已脱敏），
  客户端按 `details.errorKey: 'tunnelErrorDownload'` 本地化。早先版本把
  `cause.message` 原样透传，会连带泄露镜像完整 URL（可能带 token）与 `dpkg-deb -x` 的绝对路径。
  教训：「给得出原因」与「不回显绝对路径」（SECURITY.md 脱敏承诺）要同时成立——
  保留 host/basename 级线索，而不是在「透明」和「泛型 500」之间二选一。
- `CLOUDFLARED_MIRROR` 支持两种形态（见 `src/host/cloudflared.ts`）：
  1. **`deb+` 完整 .deb 地址（推荐，已验证）**：
     `CLOUDFLARED_MIRROR=deb+https://pkg.cloudflare.com/cloudflared/pool/main/c/cloudflared/cloudflared_2026.10.1_amd64.deb`
     → 下载后用 `dpkg-deb -x` 解包提取 `usr/bin/cloudflared`（不污染包数据库）。
     `pkg.cloudflare.com` 是 Cloudflare 官方 deb 仓库，在 GitHub 直连被墙的真机上**实测可达可用**
     （2026-10-17 验证：下载解包并成功拉起 Quick Tunnel、抓到 `.trycloudflare.com` 地址）。
  2. **裸二进制镜像基址**：拼上架构后缀，如 `CLOUDFLARED_MIRROR=https://host/cloudflared-`。
- 并按 `getconf LONG_BIT` / `uname -m` 选 amd64 归档，别拿错 arm64。解压到用户目录
  （`~/.local/share/dsh-cloudflared/`），不碰 `/usr` 权限。

---

### Quick 隧道地址漂移后不会自动更新

**症状**：建设成功、手机也连上了，但重启电脑 / 隧道进程后地址变成新的，
手机还死连旧 `wss://xxx.trycloudflare.com`，事件一直收不到。

**根因**：App 端 `ReconnectingEvents`（`dsh-companion/data/DshClient.kt`）对**同一个 base URL**
做指数退避重连（1s → 30s），`closed` 才停——它**不知道** `trycloudflare.com` 换地址了，
只会对着旧地址无限重试。

**现在怎么办（铁律）**：Quick Channel 的产出是对外**易失地址**，要让 App 「吃新地址」：
面板显示当前 wss + 「重建即换新」提示；用户在 App 端重新导入最新配置文本（或换端点重连）。
设计上不要把 Quick 地址当作长期固定，把它当「临时演示/兜底」。

### 创建隧道无提示

**症状**：点「创建云隧道」后界面无任何反应，几十秒才出结果（首次要跨 GitHub 超时 + deb 下载）。

**根因**：下载整块埋在单个 POST `/manage/cloudflare/create` 里，前端只知道 busy，看不到 到哪一步。

**现在怎么办（铁律）**：创建期间前端**轮询** `GET /manage/cloudflare/activity`（约 350ms）拿阶段
进度渲染进度条 + 文案；后端 `ensureCloudflared` 通过可选 `report` 回调逐阶段上报
（`locating`/`downloading`/`unpacking`/`starting`，下载阶段带真实字节百分比）。
阶段随管理实例 `CloudflaredTunnelManager` 收敛，路由 `/cloudflare/activity` 暴露，POST 结束即清空。
- 新增阶段文案走前端硬编码中文即可，不必进 i18n 字典（与 `tunnelCreate` 按钮共存的临时提示）。
- 进度条：确定百分比用真实宽度，无确定值（连接/启动）用 `30%` 占位即可，别硬凑假百分比。

**另一个「无提示」：安全层面**（2026-10-17，v2.4.0 修）：创建云隧道 = 把本机远程端口经
Cloudflare 边缘暴露到公网，是高风险的对外动作，光有进度条不够，还得在**动手前**让用户
意识到风险。修法：创建入口（面板开关与「隧道未开启」态）先 `window.confirm`（i18n
`tunnelStartConfirm`），取消则不执行；隧道区常驻 `tunnelSecurityWarning` 警示文字。

### CI 判活把 401 当没起来

**症状**：`profile-install (ubuntu-latest)` 每次稳定红 5 分钟，日志里只有 `dsh web:` 启动横幅，
下面探针循环**一句话都没有**，最后 `Process completed with exit code 1`。
其余 10 个 job 全绿，看上去像「只有 Ubuntu 的 web 冒烟挂了、插件本身没事」——这个判断只对了一半。

**根因**：探针用 `curl --fail --silent http://127.0.0.1:43992/` 判活。
DSH 0.2.x 起 WebUI **对 loopback 也要求 token**，裸请求 `GET /` 返回 **401**；
`--fail` 把 401 当成失败，120 秒重试自然全部落空。**401 是鉴权正常工作，不是进程没监听。**

**实发案例（2026-10-20，run `39413498323` / commit `c5e0b3f`）**：本机隔离 `DSH_HOME`
起 DSH `0.2.1-rc.2` 实测：`GET /` = **401**，带 token 的 `GET /?token=…` = **303**，
而插件 `GET :3090/api/v1/healthz` = **200**（`{"ok":true,"version":"v1","pluginVersion":"2.4.3"}`）。
插件、tarball 安装、bundle 激活全部正常，唯一错的是探针口径。

**现在怎么办**：按状态码判活，别用 `--fail` 判「服务在不在」——
`000`（连不上）和 `5xx`（起了但报错）算失败，`2xx/3xx/4xx` 都说明 HTTP 端口已在服务；
插件端点（`/api/v1/healthz`）继续 `curl --fail`（它返回 401 才是真问题）。
同时给 `dsh web` 加 `--no-open`（headless runner 上不需要开浏览器），
启动输出重定向到 `$RUNNER_TEMP/dsh-web.log`，失败时 `cat` 出来。

**铁律**：CI 判活要贴着**当前内核的鉴权契约**写。把「401 需要 token」写成「服务没起来」，
这条红就会伪装成产品 bug，白烧一整轮排查。判活失败时必须把服务端日志打出来
（这次原脚本把 `dsh web` 的 stdout 丢进了 CI 控制台，循环里又一句不打印，等于零诊断信息）。

**修复验证**：run `39417950880`（commit `88b444c`）11/11 全绿，`profile-install (ubuntu-latest)`
的冒烟行实证 `web smoke ok: web=401 plugin=200`。

---

### CI 矩阵上的跨平台路径规范化假失败

**症状**：CI 上 `core (macos-latest, …)` / `core (windows-latest, …)` 与
`profile-install (macos/windows)` 稳定红，失败数**一模一样**（实测 `24 failed | 38 passed`），
而 ubuntu 的全部 job 全绿、本机（Linux，`/tmp` 不是符号链接）也全绿。
首个失败断言是 `expected [] to include 'sess-1'` —— 列表**整个是空的**。
凡是要内核真正干活的用例全挂（sessions list / fork / question-cancel / approval replay /
subscribe / model & permission options / host snapshot / agent-team / subagents / todos /
goal / session-stats / file download / chunked upload / file-resolve），
纯校验与结构化报错的用例全过。

**根因**：夹具 `startHarness` 用 `mkdtemp(path.join(os.tmpdir(), 'daw-mgw-'))` 建临时目录，
把**未规范化**的路径直接当会话 `cwd` 塞进 `fakeApi`（`tests/mobile-gateway-ws.spec.ts:41`、
`:1152`/`:1162`/`:1163`）；而 `database.addRoot` 内部 `canonicalRoot()` 会
`realpath(path.resolve(input))` 规范化（`src/host/path-policy.ts:35`）。两条路径字符串不等 →
`matchRoot`（`src/host/chat-adapter.ts:1585`）→ `wireRelative(root.realPath, cwd)`
（`src/host/path-policy.ts:92`）→ `isPathInside` 判失败 → 会话被过滤 → 列表为空。

**平台差异正是迷惑的来源**：Linux 的 `/tmp` 不是符号链接，`realpath` 等于原路径 → 全绿；
macOS 的 `/var/folders → /private/var/folders`、Windows 的 8.3 短名都是符号链接 → 必红。
所以「**本机全绿、CI 红**」是本条坑的签名，而不是「CI 环境有问题」。

**复现手法（决定性）**：把 TMPDIR 指到符号链接上跑同一个文件，
失败数与 CI 完全一致 —— 等于把 CI 环境搬到本机：

```sh
LINK_PARENT=$(mktemp -d)
mkdir -p "$LINK_PARENT/real" && ln -s "$LINK_PARENT/real" "$LINK_PARENT/link"
TMPDIR="$LINK_PARENT/link" npm run test -- tests/mobile-gateway-ws.spec.ts
# 修复前：24 failed | 38 passed（与 CI 同数）；修复后：62 passed
```

**现在怎么办**：夹具里凡是要「落进授权根内」的路径，一律先 `realpath` 再喂给 `fakeApi`：

```ts
activeProject = await realpath(project)   // 而不是 activeProject = project
```

对齐既有约定：`tests/chat-adapter.spec.ts` 与 `tests/http-api.spec.ts` 早已在夹具里 realpath，
`mobile-gateway-ws.spec.ts` 是漏做的那一个。

**铁律**：
- 夹具的路径口径必须与产品代码的规范化口径**一致** —— 产品那边 `canonicalRoot` 已经 realpath 了，
  夹具就不能拿原始路径去比。
- 排查顺序：**先怀疑路径规范化口径不一致，再怀疑 CI 环境**。
- 「本机绿 + CI 红」先做符号链接 TMPDIR 复现；能复现就等于定位完成。
- 修复后**必须同时跑两种 TMPDIR**：符号链接（复现原失败）与常规（回归），只跑一种会漏。

**回归**：`tests/mobile-gateway-ws.spec.ts`（62 用例，覆盖会话列表 / fork / question-cancel /
approval replay / subscribe / 各类 options / host snapshot / agent-team / subagents /
todos / goal / session-stats / 分块上传 / file-resolve）。

**CI 矩阵**（`.github/workflows/ci.yml`）：`os: [ubuntu-latest, windows-latest, macos-latest]`
× `node: [22.19.0, 24]` —— 所以 macos 与 windows 的 core 与 profile-install 都会跑到，
ubuntu 不会暴露这条。

---

### bash 3.2 把中文吃进变量名

**症状**：GitHub Actions 上 `core (macos-latest, *)` 与 `profile-install (macos-latest, *)`
从某次提交起每轮都红，ubuntu / windows 全绿；失败断言只有两行：

```text
scripts/push-all.sh: line 68: BRANCH（: unbound variable
  expected 1 to be +0   ← tests/release-tag-push.spec.ts
```

`profile-install` 的红色**不是**第二个缺陷：它第 7 步 `pnpm pack` 触发 `prepack` →
整条门禁，`release-tag-push.spec.ts` 红了，打包也红。

**根因**：脚本里 `say "推送分支 $BRANCH（${#PAIRS[@]} 个远端…）"` —— `$BRANCH` 紧贴全角括号。
bash 5（ubuntu / 本机）把非 ASCII 字节当变量名的边界，能正常展开；macOS runner 自带的
**bash 3.2** 把多字节字符算进变量名，于是它找的是 `BRANCH（…` 这个不存在的变量，
`set -u` 下直接 `unbound variable` 退出。

**拿不到日志时怎么定位**（本机到 `productionresultssa1.blob.core.windows.net` 不通，
`/actions/jobs/<id>/logs` 只返回 302 到那个域名）：改用 **check-run 注解**，它带断言原文：

```sh
curl -s -H "Authorization: Bearer $TOK" \
  "https://api.github.com/repos/<owner>/<repo>/commits/<sha>/check-runs?per_page=40" \
  | jq -r '.check_runs[] | select(.conclusion=="failure") | .id'
curl -s -H "Authorization: Bearer $TOK" \
  "https://api.github.com/repos/<owner>/<repo>/check-runs/<id>/annotations"
```

**铁律**：脚本里凡是要拼接中文标点（`（`、`：`、`，`、`…`）的变量，一律写 `${VAR}`。
`$VAR，` 在本机是有效代码，在 macOS 上是 unbound variable —— 这类错误只有 CI 矩阵的
macOS 作业能抓。

**同一台 bash 3.2 上的第二个陷阱：空数组的 `"${a[@]}"`**。2026-11-21 修完上面那条，
macOS 作业换了个位置继续红：`scripts/push-all.sh: line 74: force_args[@]: unbound variable`。
`force_args=()` 在 `FORCE!=1` 时是空数组，bash 5 展开成零个词、什么也不发生；
bash 3.2 在 `set -u` 下把它当**未定义变量**直接退出。修法是别留「可能为空的数组」——
`if [ "$FORCE" = 1 ]; then git push --force-with-lease …; else git push …; fi` 分两行写，
或者在 `if/else` 里各展开一次；非要用数组就写 `${a[@]+"${a[@]}"}`。

**回归**：`tests/shell-portability.spec.ts` 静态扫 `scripts/**/*.sh` 与
`.github/workflows/*.yml`：`$VAR` 紧跟非 ASCII 就红，`[ … ] && arr=(…)` 造出的数组
被裸 `"${arr[@]}"` 展开也红（静态断言足够，真跑 bash 3.2 需要 macOS 或容器）。
同文件还顺手钉了 Windows：测试里拼路径必须用 `fileURLToPath`，`new URL(…).pathname`
在 Windows 上是 `/D:/a/…`，拼出来 `D:\D:\a\…` 整片 ENOENT。

---

### 目录结构与接口说明漂移

**症状**：两种表现，都很像「没问题」：

1. 新加了 `src/host/foo.ts`，`docs/project/STRUCTURE.md` 里压根没它。后来的人（或 AI）
   照目录图找实现，翻不到，于是**重新写一份**——同一件事出现两套实现。
2. 某个导出改名或搬了文件（`createDsh02ApiProxy` 挪走、`unwrapDsh` 退休），
   `INTERFACES.md` 还写着旧签名。照着旧签名调，编译报错还算好；更糟的是
   签名「看着还在、语义变了」，代码能编过、行为是错的。

两种都不会让别的检查变红：`docs:check` 原来的四段只管必需文档存在性、ROADMAP/STATUS
引用、ADR 索引、坑位双向、根 README 与 patch inject —— **它压根不读 `src/` 的文件清单**。

**根因**：用户的原始要求是「加文档，**后期改代码要同步改**」，而「请记得同步」是**靠自觉**。
本仓对这件事有实锤先例：README 双站漂移连续三版（v2.2.33→v2.2.35）无人发现，
根因正是「那份文档不在任何机检范围内」。同样的敞口不能在新文档上再开一次。

另外两个容易走偏的修法，都被否了：

- **只查「文档 → 源码」**（锚点里的路径必须存在）：删文件忘删条目会被抓，
  但**新增文件永远发现不了** —— 而新增恰恰是高频的那一半。
- **只查「条目数 > 0」**：表格格式一变（把锚点套进代码块、标记写错、列数改了），
  正则一条都不匹配，两个集合双双为空而「一致」，门禁全绿。
  这是坑位索引那一节最初撞上的假绿，教训已经写在 `check-project-docs.ts` 的注释里。

**现在怎么办**（2026-10-21 落地，`commit` 见 git log）：

- `docs/project/STRUCTURE.md`：目录树、分层与依赖方向、逐目录职责、关键文件速查、
  **「新增东西放哪里」决策表**，文末 `<!-- structure-check -->` 锚点。
- `docs/project/INTERFACES.md`：对外 REST/流/能力位、内部模块导出与签名、
  **改接口检查清单**，文末 `<!-- interfaces-check -->` 锚点。
- `scripts/check-project-docs.ts` 新增第四段，**双向 + 下限断言**：
  1. 文档 → 源码：锚点路径必须存在且类型对（`file`/`dir`）；锚点声明的标识符必须能在
     指出的文件里 grep 到；
  2. 源码 → 文档：`src/` 下每个 `.ts`/`.tsx` 都必须登记在锚点里；
  3. 下限：`structure` < 30 条或 `interfaces` < 25 条直接红，报「表格格式可能变了」。

  负向实测（四条全红，恢复后逐字节复核）：
  删掉 `src/host/rate-limit.ts` 锚点行 → 「未登记进 STRUCTURE.md 机检锚点」；
  把 `createDsh02ApiProxy` 改成 `…TYPO` → 「源码里找不到」；
  删 `structure-check:end` → 「缺少机检锚点…解析不出任何条目」；
  把路径改成 `rate-limit-GONE.ts` → 「不存在」+「原来那个未登记」。

**铁律**：

- **新增/移动/删除 `src/` 下文件、改导出符号或 REST 路由 → 同一提交改锚点**，
  不允许「下个提交补」。门禁红着提交只是把红转给下一个人。
- 目录图与签名**只在两份文档里写一次**；`AGENTS.md` 只留指针、不抄清单
  （抄了必漂，见 §行数口径那段的教训）。
- 锚点的 `<!-- …-check:begin/end -->` 与表头是**机器契约**，改格式必须同批改
  `scripts/check-project-docs.ts`，否则整段解析成空 → 被下限断言抓红。
- 判据要**双向**且**带下限**。只查一向或只查「非空」的写法，
  在「新增文件」与「格式变更」这两个真实场景下都会静默放行。

### 隧道让回环判据失效

**症状**：开隧道（或任何反代）后，`/manage/**` 的全部管理端点对公网**无凭据**开放。
`curl https://xxx.trycloudflare.com/manage/roots` 一个头都不加就返回 200，
`POST /manage/config/text` 直接吐出一枚设备令牌（含任意 scope）。关掉隧道、只用局域网
直连则一切正常 —— 于是这个洞很难在「本地开发」中被发现。

**根因**：管理面（`/manage`）与回环管理员身份（`X-Dsh-Workspace-Admin: 1`）修复前的
唯一判据是 `req.socket.remoteAddress` 是否回环 + `Origin` 是否回环。而插件自带的
cloudflared Quick Tunnel 用 `--url http://127.0.0.1:PORT` 转发，**公网请求进到 bridge 时
`remoteAddress` 恒为 `127.0.0.1`** —— 回环校验对隧道流量完全失效。
同一类拓扑：ngrok、frp、Caddy/Nginx `proxy_pass 127.0.0.1`、SSH 端口转发、Tailscale Serve。

放大器有两个：`isLoopbackOrigin(undefined) === true`（curl 天然不带 Origin，于是天然
「同源」）；以及 Host 头**完全没人校验**（DNS 重绑定同样不设防）。

**为什么测试没抓到**：`tests/http-api.spec.ts` 有一条看起来同类的用例，它塞了
`X-Forwarded-For: 127.0.0.1` 与一个坏 Origin，断言 401。但它**从本机直连**服务器
（`remoteAddress` 本来就是 127.0.0.1），于是测的是「坏 Origin 被拒」「转发头不被信任」，
而真实攻击不需要坏 Origin、也不依赖转发头。**测试存在，但性质没被钉住** —— 这是本仓
最典型的假绿形态。

**修法（v2.5.1）**：判据从「只看 socket」扩成四层，写进 `src/host/auth.ts` 的
`adminRefusal`，`requireAdmin` 与 `principal({allowAdmin})` 共用（一严一松是同族 bug）：

0. 隧道运行中（`CloudflaredTunnelManager.tunnelActive`）→ 整体拒绝；
1. 出现任何转发头 → 按代理处理；
2. `Host` 必须回环（缺失也拒）；
3. socket 回环 + `Origin` 存在时回环。

**坑位不是「改完了」而是这几条**：

- **判据 0 才是那条硬的**。判据 2（Host）在**真实** cloudflared 下未必挡得住：
  `httpHostHeader` 默认为空，会把 `Host` 改写成源站地址。集成测试里那个「转发器不改写
  任何头」的模型是**简化**的，别拿它当真实拓扑的证据。
- 改判据必须**同时**改 `/manage` 与 `/api/v1` 两条路径，并写一条「两者对同一请求结论一致」
  的断言。只改一处等于把洞挪到另一处。
- 隧道模式一关，面板就读不到「隧道开着」这个信号（它自己在 `/manage` 前缀下）——
  所以状态端点必须显式豁免判据 0，并对非本机调用方隐去 `url`。见
  `router.ts` 的 `TUNNEL_MODE_EXEMPT_PATHS` 与 `tunnelStateFor`。
- 桌面端不是「豁免」，而是**恰好通过**：它跑在只绑回环的 WebUI 里，Origin 与 Host 天然回环。
  改判据前先确认这一点，别用「给桌面端开个白名单」的方式绕过。

**这条坑没被修完（2026-10-21 实测，必须知道）**：判据 0 只管**本插件自己拉的**隧道。
外部反代 / SSH `-L` / 他人的 frp 转进来的请求，`tunnelActive` 是 `false`，于是判据 0 不触发；
而判据 1（裸 TCP 转发不加头）、判据 2（`Host` 由客户端自填）、判据 3（缺 `Origin` 放行）
**全都能被绕过**。实测 `POST /manage/pairings` → **201**，兑换后设备数 0 → 1。

**为什么值得单独写一段**：它很容易被误读成「洞已经堵死了」。准确表述是
**本插件自带隧道已堵死，外部反代/SSH 在特定配置下仍可提权**。
「本机进程能做的事，SSH 转发进来的攻击者也能做」—— socket 层面无法区分，
所以**任何再加一层请求头 / Host / Origin 判据的「加固」都是自欺**（头本身能伪造）。
根治只有「认凭据」（独立管理令牌）或「端口分离」两条。详见
`SECURITY.md` §信任边界的两个前提 / §残余风险 与实施记录 §7。

**第二条已落地（issue #26 阶段 0.2，2026-11-19）**：隧道改指**隧道专用数据端口**
（`src/host/tunnel-listener.ts`，只绑 `127.0.0.1`、端口系统分配），主端口不再被隧道触及。
管理面在那个端口上**根本没有路由**（`404`），不靠判据 —— 于是「自控 `Host` + 无 `Origin` +
无转发头 + 插件不知道反代在跑」这一整类绕过对**管理面**失效。⚠️ 但它只解决管理面：
手机端还必须走 `/api/v1/**`，数据面仍是公网暴露面。另外**前提 1 照旧要守** ——
别给主端口挂第三方反代 / SSH 转发。断言见 `SECURITY.md` §隧道数据面的端口分离。

`docs/project/SECURITY.md` 里旧版「在 listener 前使用…**可信隧道**」那句是本坑位的
反向建议（照做就中招），2.5.1 已改写。

**回归断言**：`tests/admin-loopback-escalation.spec.ts`（20 例，含隧道拓扑、判据矩阵、
桌面端放行、两者一致，以及阶段 0.2 的两条：隧道端口上管理面一律 404 / 隧道端口上数据面照旧可用）。
该文件原有的 5 条 `it.fails` 在 2.5.1 全部转正为 `it`。

### 改 node_modules 里的插件产物不生效（pnpm 硬链接）

2026-10-22 实测：把 `lib/*.js` 直接 `cp` 进
`~/.dsh/profiles/web/node_modules/dsh-remote-bridge/`，`sha256sum` 当场对得上，
重启后却跑的还是旧代码 —— 因为该目录里的文件是 **pnpm 内容寻址仓库的硬链接**
（`link count 2`），重启时 profile 依赖被重新链接，手写的那份被 store 里的原件覆盖。

**正确做法**：走官方安装通道，让 store 里那份本身就是新的。

```bash
pnpm pack --pack-destination <workspace>/pack          # 产出 dsh-remote-bridge-<version>.tgz
node /usr/local/nodejs/bin/dsh plugin --profile web add <workspace>/pack/<tgz>
```

`dsh plugin add` 会把依赖记录改成 `file:…/xxx.tgz` 并重装；装完用
`grep -c '<新路由片段>' node_modules/dsh-remote-bridge/lib/index.js` 确认，再让用户重启。
**判据**：重启后新路由仍 404，就说明产物没换成功，别急着改代码。

### apply 尾部抛错会留下「半死桥」

同一个事故的根因侧：`apply()` 里 HTTP 服务器已经 `listen` 成功后，末尾再有一段注册代码
抛错，cordis 会把整个 fiber 拆掉 —— 但监听端口没人还，于是出现最迷惑的形态：

- `GET /api/v1/healthz`、`/manage/cloudflare/status` 正常 200（不碰内核服务）；
- **所有**需要内核服务的端点（`/settings/*`、`/chat/*`、`/devices/self`…）
  一律 `400 cannot get required service "x" in inactive context`；
- 客户端表现为「连上了，但快照拉不完，一直转圈」。

**纪律**：凡在 `apply` 里注册可选入口（命令/工具/服务），一律 `try/catch` 降级成
「少一个入口 + 一条 warn」，绝不让 `apply` 抛错。代价不对等：一个入口不可用 vs 整桥假死。
回归口径见 `src/index.ts` 的 `/tunnel` 命令与 `open_tunnel_config` 工具注册块。

### 产物校验值必须在打 tag 之前提交（否则 tag 里的哈希是上一版的）

`scripts/pack-release.sh` 是**打完包才知道哈希**的，它把结果写进 `artifacts/SHA256SUMS.txt`；
而这个文件是被 git 跟踪的（`.gitignore` 里 `artifacts/*` 唯独放行它）。于是有一个顺序陷阱：

- 若「人工发版提交」排在打包之前（v2.6.0 的实际顺序），那么打包后重算出来的
  `SHA256SUMS.txt` 只是一份**工作区改动**，tag 指向的提交里仍是**上一版**的哈希；
- 症状极隐蔽：Release 附件、npm 包、远端 tag 全部正确，只有
  `git checkout vX.Y.Z && cat artifacts/SHA256SUMS.txt` 会读到旧值；
- 而 tag 一旦推出去就**不能改指**（要 `--force`，本仓明令禁止），只能另起提交补，
  于是「tag 指向的树」与「main 最新树」永久多出一条无意义差异。

**纪律**：`release.sh` 的顺序固定为 打包 → **提交 `artifacts/SHA256SUMS.txt`** → 打 tag → 双推。
脚本在打 tag 后立刻用 `git show "$TAG:artifacts/SHA256SUMS.txt" | cmp -s - artifacts/SHA256SUMS.txt`
自检：不一致就 `exit 1`（tag 未推送，`git tag -d` 后重跑即可）。
姊妹仓 `dsh-companion` 的 `release.sh` 在阶段 B 打 tag 后做同一道闸。

### 发版脚本不推 tag（默认行为与注释相反）

**症状**：一键发版 `bash scripts/release.sh` 跑完，**两站 Release 建好了、npm 也发上去了**，
但远端**没有** `v<ver>` 这个 tag。第 7 步「全渠道回读」才报 `gitee: tag vX.Y.Z 缺失` ——
可那已经是 npm 发布**之后**了，而 npm 的版本号不能重发。

**根因**：两个默认值撞在一起，而且**两处注释互相矛盾**，所以谁也没发现：

- `scripts/push-all.sh:29` 是 `PUSH_TAGS="${PUSH_TAGS:-0}"` —— **默认不推 tag**
  （手工推送时这个默认是对的：防止误推历史 tag）；
- `scripts/release.sh` 第 4 步调用它是**裸调** `bash scripts/push-all.sh` —— 没带 `PUSH_TAGS=1`；
- 而 `release.sh` 那段注释曾写着「tag 的推法与 push-all.sh 的默认一致：**只推指向 HEAD 的 tag**」——
  与实际行为**正好相反**；`push-all.sh` 自己的用法注释倒是对的（`PUSH_TAGS=1 bash scripts/push-all.sh`）。

**为什么没被中途拦住**：第 5 步建 Release 用的是 `tag_name=$TAG`，而 **Gitee / AtomGit 的
Release 接口不校验远端有没有这个 tag** —— 于是 Release 照建、附件照传、npm 照发，一路绿灯。
唯一会暴露它的是最后一步的回读，而那时已经不可回滚。

**现在怎么办**：

1. **tag 推送是 `release.sh` 的义务，不是调用者的义务** —— 调用必须显式带 `PUSH_TAGS=1`，
   不能指望人记得配环境变量（v2.12.1 发版时就是这么临时绕过去的：`PUSH_TAGS=1 bash scripts/release.sh`，
   绕法不该成为发版的前提条件）；
2. `push-all.sh` 的默认**保持 `PUSH_TAGS=0` 不变** —— 缺陷在调用方，不在被调方；
3. **`release.sh` 在进入第 5 步之前加一道硬闸**：对 `gitee`/`atomgit` 各查一次
   `git ls-remote --tags "$r" "refs/tags/$TAG"`，**tag 不在就直接 `exit 1`**，
   宁可不发 Release，也不发一个「有 Release、没 tag」的版本；
4. 查的时候要**区分两种失败**：ls-remote 本身失败 = 「连不上远端」（网络/凭据问题），
   与「连上了但没这个 tag」是两回事，混成一句会把排查方向带偏。

**铁律**：**发版脚本里凡是「远端可能不存在、但后续步骤照样能跑」的引用（tag、commit、附件名），
都要在「不可逆的那一步」之前验一次。** Release 建得出来不等于 tag 推得上去 ——
接口不校验的东西，脚本必须自己校验。

回归锚：`tests/release-tag-push.spec.ts`（6 个用例：默认不推 tag / 带开关才推 / 幂等重跑 /
`release.sh` 的调用显式带 `PUSH_TAGS=1` / 注释不再与行为相反 / tag 闸早于 Release 与 npm）。

### 把事件信封的外层 rpcId 当成结算句柄（approval 决策恒 409）

`FrameHub.push(payload)`（`src/host/dsh-0.2-bridge.ts`）给每条帧**新造**一个随机外层
`rpcId: randomUUID()` 作为信封/事件 id；而 `ApprovalBridge` 发起审批时把自己 pending 表的
**结算句柄**塞进 `payload.rpcId`，`respond()` 按 payload 里这个值查表结算。两者不是同一个值。

适配层 `DshChatAdapter.captureApproval` 一度记的是**外层** `frame.rpcId`，于是决策时
`respond({ rpcId: 外层id })` 在 ApprovalBridge 表里查不到 → `accepted:false` →
`409 APPROVAL_NOT_PENDING`，并把记录删掉。症状极具迷惑性（真机 Desktop 宿主 / v2.8.1，2026-10-30）：

- 同一秒 `GET /chat/sessions/{id}/approvals` **能列出**这条审批（记录在适配层 pendingApprovals 表里）；
- `POST .../approvals/{id}/decision` 却恒回 **409**，点完手机上转 15s 超时；
- 审批没真正结算，内核一直等到 10 分钟超时才 delegate，期间命令没执行。

**为什么单测漏网**：`tests/chat-adapter.spec.ts` 直接手造 `{ rpcId, payload:{type:'approval/requested',…} }`
喂给 `startEvents`，手造帧的外层 rpcId 恰好就是断言里的 `'private-rpc-id'`，与「payload 里另有句柄」
的真实管线不符——夹具绕过了 FrameHub 的再包装。

**怎么发现的**：用裸 WS/REST 探针在真桥上做对照——先 `GET` 确认审批在、拿真 approvalId，再立刻
`POST decision`，同样 409，于是排除「App 双发 / WS 路径」，回到桥侧顺着 `approvalKey → pendingApprovals
→ FrameHub.push → ApprovalBridge.respond` 把两个 rpcId 对上。

**铁律**：

1. 区分「信封/事件 id」与「结算句柄」——前者每条帧唯一、用于去重与事件 id；后者是发起方放进
   **payload** 的、要原样回传才能结算的关联键。看到 `record.rpcId = frame.rpcId` 先问「这条帧
   有没有被再包一层」。
2. 事件总线（FrameHub）若会重造信封 id，**不得**覆盖/顶替 payload 自带的关联字段。
3. 适配层测试要覆盖「真实管线的再包装」，至少有一条用例让外层 id 与 payload 句柄**不同**，
   断言决策用的是 payload 句柄（`tests/chat-adapter.spec.ts` 的
   "uses payload.rpcId (not the FrameHub outer id)"）。
4. question 侧不受影响：它按 `(sessionId, callId)` 匹配并直连内核 `ctx.userQuestions`，不读信封 rpcId。

---

### 可信发布者只认「2FA 设备」，邮箱验证码不算（403 Please enable 2fa for your account）

**症状**（2026-11-11 配 npm 可信发布者时，实测三轮都撞同一句）：

1. 直接打 `POST https://registry.npmjs.org/-/package/dsh-remote-bridge/trust` → 回
   `403 {"message":"Please enable 2fa for your account"}`；
2. `npm trust github dsh-remote-bridge --file publish.yml --repo westanke/dsh-remote-bridge
   --allow-publish --allow-stage-publish` → 终端先打印
   `Two-factor authentication is required for this operation`，再问 `Do you want to proceed? (y/N)`；
3. npm 网页「可信的发布者」表单也存不下来。

换令牌类型、加 `npm-otp`、加 `npm-auth-type: web` / `npm-command: trust` 头 —— 全试过，
**同一句 403**，响应头连 `www-authenticate` 都没有（所以 CLI 走不到「提示输 OTP」那一步）。

**根因**：npm 的 2FA **设备**只有两种形态 —— **security key（WebAuthn：Touch ID / Face ID /
Windows Hello，或 Yubikey / Thetis / Feitian 硬件钥匙）** 与 **TOTP 认证器 App**。
**邮箱验证码不是 2FA 设备**，它只是登录时的补充验证（npm 文档原话：没有 2FA 设备时才用
邮箱码）。账号的 `GET /-/npm/v1/user` 确实报 `tfa.mode = auth-and-writes`，但**手上只有邮箱码
这一种手段** → 服务端判定「没有可交互的 2FA 设备」，一律 403。

两个附带事实（都实测过，别再重复试）：

- **bypass-2FA 的 GAT 无权调这个接口**，报的是另一句
  `Granular access tokens that bypass two-factor authentication may not perform this action`
  （见 https://gh.io/npm-gat-bypass2fa-deprecation）。想配可信发布者，只能用**会话令牌或
  非 bypass 令牌 + 有效 `npm-otp`**。
- body 形状也会被拒，但**报错在 403 之后**、极易误导：body 必须是**数组**（单对象 →
  400 `"value" must be an array`；空数组 → 400 `"value" must contain at least 1 items`）。
- `npm profile enable-2fa auth-and-writes` 在账号已开 2FA 时是**空操作**，只打印
  `Two factor authentication is already enabled and set to auth-and-writes` 就返回；
  想用它补 TOTP 设备得先 `disable`（而 disable 本身要设备认证）→ **只能走网页配**。

**现在怎么办**：在 npm 网页 → 头像 → Account → Two-Factor Authentication → Enable 2FA →
输密码 → **Add security key**（浏览器生物识别或硬件钥匙）；或终端
`npm profile enable-2fa auth-and-writes` 配 TOTP 认证器 App（会打印二维码 + secret，
需要手机装认证器 App）。⚠️ **必须抄下恢复码**：用恢复码登录会触发 **72 小时安全冻结**，
期间不能发包、不能建令牌、不能改设置。

配好设备后再在 npm 网页「可信的发布者」登记（出版者 GitHub Actions / `westanke` /
`dsh-remote-bridge` / 工作流文件名 `publish.yml` / 环境留空 / 勾「允许 npm publish」）。
命令行等价物：`npm trust github dsh-remote-bridge --file publish.yml
--repo westanke/dsh-remote-bridge --allow-publish --allow-stage-publish`。

**铁律**：

1. **邮箱验证码 ≠ 2FA 设备**。判断账号能不能配可信发布者，看「有没有一把可交互的设备」，
   不是看 `tfa.mode` 字段。
2. **npm 不会在保存可信发布者配置时校验它** —— 填错文件名、填错仓库，都要到**发布那一刻**
   才暴露成一次失败的 run。所以配置完先手工打一个 tag 验一次。
3. 工作流里必须写 `permissions: id-token: write`，否则 npm 跳过 OIDC 直接报 `ENEEDAUTH`；
   只能用 GitHub 托管 runner，自托管不支持。
4. 配置与排查细节见 `docs/project/RELEASE.md` §2.1。

### 挂起提问寿命：桌面卡片无超时，手机端不得单方面摘卡

**踩坑**（2026-11-16，用户报障「电脑端列表有待回答、点进去能看到提问卡；手机端两个都看不见」）：
`QuestionBridge.attach` 给挂起提问挂的是**无条件 10 分钟定时器**（`QUESTION_PENDING_TIMEOUT_MS`）。
到点只把挂起项摘表 + 推 `userQuestions/dismissed` —— 但 `delegate`（桌面远端 answerer）**还挂着**，
桌面那张卡是客户端自持、无超时。结果：桌面照旧显示可答，手机端的卡被单方面推掉；
提问若发生在手机连接之前且已过 10 分钟，重放也补不回来（`replayPendingQuestions` 只用 `pendingAll`）。

**根因**：真实 `ask_user_question` 参数只有 `questions`（无 `timeout`）→ 不进内核投影、
`GET /questions` 查不到，只走 Cordis waterfall —— 手机端的可见性**完全**由本插件的挂起表决定，
摘表 = 手机端永久失明，而内核/桌面的这次提问还活着。

**现在怎么办**：挂起寿命随 `delegate` 状态走 —— 未决（桌面还能答）→ 不设超时，两端同寿命；
rejected（NO_PROVIDER，手机是唯一界面）→ 自拒起 10 分钟自愈线，超时按 `dismissed` 收尾。
`PendingQuestion.deadline === null` 的条目 `sweepExpired` 永不清扫。审批侧（`APPROVAL_PENDING_TIMEOUT_MS`）
**不受影响** —— 审批是等待承诺，无人答内核永久阻塞，必须有超时。

**铁律**：

1. 给手机端摘卡之前，先问「这次提问在桌面/内核侧还活着吗」—— 活着就不许摘（两端一致性 > 自愈洁癖）。
2. 自愈线只该保护「唯一界面也答不了」的场景（delegate rejected），不是统一寿命。
3. 回归锚：`tests/approval-timeout.spec.ts` 的 `question pending timeout` 三个用例。

### Gitee issue 写 API 路径不含 repo 段（PATCH 404 Not Found Project）

**踩坑**（2026-11-16，v2.11.1 发版当天关 issue IKVP1Q）：按官方 swagger 的
`PATCH /repos/{owner}/{repo}/issues/{number}` 关 issue —— GET 能查到，PATCH 恒 404
`{"message":"Not Found Project"}`；换 urlencoded 表单、form 字段、`PUT` 全试一遍
（PUT 直接 405），无一幸免。

**根因**：Gitee OpenAPI v5 的 issue **写**端点实际路径是 `/repos/{owner}/issues/{number}`
（**没有 repo 段**），`repo` 是 body 字段；**读**端点才是 `/repos/{owner}/{repo}/issues/{number}`。
两套路径形近致错（imjoey/ge PR !45 修的就是这个）。

**现在怎么办**：

1. 关闭/编辑：`PATCH /repos/{owner}/issues/{number}?access_token=…`，body
   `{"repo":"<repo>","number":"<编号>","state":"closed"}`（JSON body 可用）。
2. 评论走 `POST /repos/{owner}/{repo}/issues/{number}/comments`（读同款路径）；
   token 统一放 query 或 header，`-F` 与 `-d @file` 混用会静默失败（multipart 混 urlencoded）。
3. **新建 issue 同理**（2026-11-21 又踩一次，开 dsh-Chat 对接单）：`POST /repos/{owner}/issues`
   （同样没有 repo 段），body 带 `{"repo":"<repo>","title":…,"body":…}` 才 201；
   按官方 swagger 写 `/repos/{owner}/{repo}/issues` 回 404 `{"message":"project or enterprise"}`。
4. 项目管理型（project 型）issue 的写 API 未公开，仍只能网页操作。

---

### 晚挂拒绝处理器 = 未处理拒绝（用例随机红）

**踩坑**（2026-11-22，v2.15.0 发布后的 CI）：`profile-install (macos-latest, 0.2.2-rc.1)` 红了，
失败步骤是 `pnpm pack`（`prepack → pnpm check` 跑测试），注解里只有一句

```
Error: ENOENT: no such file or directory, lstat '/private/var/folders/…/zzz-gone.txt'
 ❯ src/host/file-service.ts:91:22
This error originated in "tests/file-service.spec.ts" test f…
```

看起来像「`list()` 抛错」，但那条用例**就是**要验抛错（`surfaces a stat failure for a vanished
entry instead of silently skipping it`）。同一个提交（只改了文档）在上一轮 14/14 全绿，这一轮红。

**根因**：用例的写法是

```ts
const listing = files.list(root, '', 500)   // 先拿 promise
await rm(path.join(project, target))        // 再制造删除
threw = await listing.then(() => false, () => true)  // 最后才挂拒绝处理器
```

中间那个 `await` 让出了事件循环。`files.list()` 的拒绝完全可能在 `rm` 返回**之前**落地；那一刻
promise 上没有任何处理器，Node 在微任务队列排空后发 `unhandledRejection`，Vitest 把它算作**这条
用例失败**，尽管后面 `await listing.then(…, …)` 确实拿到了同一个拒绝。窗口大小取决于磁盘与调度，
所以只在 macOS 上随机命中。

**现在怎么办**：**先挂处理器，再做会触发拒绝的动作**。

```ts
const listing = files.list(root, '', 500).then(() => false, () => true)
await rm(path.join(project, target), { force: true })
threw = await listing
```

同一类写法要一起看：任何「故意制造拒绝」的用例（竞态、超时、被 kill 的请求）都要在**创建
promise 的同一行**把 `.then(ok, err)` 挂上，或包在 `expect(...).rejects` 里（它也是立刻挂的）。
`await expect(fn()).rejects.toThrow()` 是安全的；`const p = fn(); await something(); await p` 不是。

**为什么容易漏**：本地连跑 8 次都不会红（macOS 本地 APFS 的 `rm` 往往比 `lstat` 慢），只有 CI 的
两档矩阵 × 三个平台才暴露。所以「本机全绿」不能证明这类用例稳。

---

### kernel-call 白名单是唯一执法点

**症状**：新加一条手机可达的内核能力时，最省事的写法是「在处理函数里判一下 scope
就放行」。这类判定一旦散在处理器、校验器、路由三处，总有一条路能绕开其中一处；而
`kernel-call` 是全桥唯一「客户端按名字指定要执行什么代码」的入口，绕开一次就等于把内核的
owner 权限交出去。更隐蔽的是**顺序**：先查目录再判白名单，「白名单外但内核有」与
「白名单外且内核没有」会给出两种不同报错，客户端免费拿到端点存在性探针。

**根因**：内核侧没有第二道设备校验。`PrincipalMap` 只有一条
`owner: { readonly kind: 'owner' }`（`@deepseek-ai/dsh-typert-protocol` 的
`lib/types/types.d.ts:363-368`；ADR-0010
`docs/project/decisions/ADR-0010-kernel-endpoint-unification.md:45` 记了「`PrincipalMap`
只有一条 `owner`」），peer 的 principal 由宿主进程内代码在创建时固定（同文件 `:380`），
**没有 wire 字段能改**。桥正是靠这一点复用一个 owner peer 代发全部代理调用
（`src/host/ws-host-services.ts:70-71`）。于是「能在契约里点名某个内核端点」在内核看来
就是本机 owner 在调 —— 白名单是唯一能拦住手机的那道门。

**现在怎么办（铁律）**：

1. 能不能调**只问** `src/host/bridge/kernel-allowlist.ts` 的 `authorizeKernelEndpoint`
   （`:130-139`）：`isKernelEndpointAllowed`（`:113-115`，白名单查表 + 钉死命名空间）
   不通过就抛 `KernelCallDeniedError`（`:36-43`，文案与「端点不存在」**一字不差**），
   通过后才 `authorizer.requireScope`（`:137`）。处理器拿到返回值或异常照办，不再自己判。
2. 默认拒绝必须排在**目录查找之前**、也排在 **scope 判定之前**。执行器的硬顺序：
   授权（`src/host/bridge/kernel-call.ts:148-151`）→ 幂等回放（`:153-154`）→ 在飞行拒绝
   （`:157-162`）→ `requireKernelEndpoint`（`:166`）→ `assertKernelArguments`（`:168`）
   → `invoke` / `collectStream`（`:169-171`）。文件头 `:7-16` 把这顺序与理由写死了。
3. 高危命名空间 `KERNEL_DENIED_NAMESPACES`（`kernel-allowlist.ts:56-73`，能起进程、读本机
   文件或碰凭据的那批）的判定在白名单查找**之前**；以后往白名单加条目也放不开它。
4. 单一路径：白名单不得包含桥已封装的 35 个入口（31 条换源 + 4 条永久留桥）。
   `BRIDGE_OWNED_ENDPOINTS`（`kernel-allowlist.ts:163-199`）是机器可读副本，
   `singlePathViolations()`（`:203-205`）做交集，空数组才算合规。
5. scope 一律走 `AuthService.requireScope`（`src/host/auth.ts:400-402`），与 REST 面同源；
   **不要**另写一份「内核调用专用」的权限模型。
6. 新增错误文案/错误码前先问：它能不能区分「没这个端点」与「没被允许」。能，就是白送探针。

**铁律**：白名单是**唯一执法点**；默认拒绝必须排在目录查找与 scope 判定**之前**。

回归锚：`tests/kernel-allowlist.spec.ts`（`:72` 钉死 14 条与各自 scope、`:105` 钉死命名
空间、`:138`「denies anything outside the allowlist with the same shape as an unknown
endpoint」、`:224` 与 35 条桥自有入口不相交）；`tests/kernel-call.spec.ts`（`:181`「denies
an endpoint outside the allowlist before touching the catalog」、`:217` 参数多/漏一个字节
都不发内核、`:271` scope→403、`:291` 不得触发交互）。

---

### owner peer 没有设备概念

**症状**：给手机新增一条可达路径时，把「这台设备有没有被撤销、有没有这个授权根、这条调用
该记谁的审计」指望在内核侧落实 —— 内核根本不知道有「设备」这回事，它看到的每个调用都是
本机 owner。结果要么判定被悄悄跳过（撤销了的手机照样能调），要么审计只记成「owner 调了
某端点」，出事后查不到是哪台手机。

**根因**：内核的鉴权模型只有身份，没有设备维度。`PrincipalMap` 只有 `owner` 一条
（ADR-0010 `:45` 明确写「设备授权根…**不能**：`PrincipalMap` 只有一条 `owner`」；源在
`@deepseek-ai/dsh-typert-protocol` 的 `lib/types/types.d.ts:363-368`），peer 的 principal
由宿主进程内代码在创建时固定（同文件 `:380`），没有 wire 字段能改。桥因此只建**一个**
owner peer 贯穿全部代理调用（`src/host/ws-host-services.ts:70-71`，注释：「一个 owner peer
贯穿全部代理调用，与 mobile-gateway 的单 peer 模型一致」）。

设备维度全部落在桥这一层：

- principal 由 token 解析（`src/host/ws-handler.ts:456-474`），设备视图从 principal 另建
  （`principalToDeviceView`，`:635-641`）；
- scope / 授权根：`src/host/auth.ts:400-416` 的 `requireScope` / `requireRoot`；
- 撤销：`src/host/database.ts:329-331`（删设备行、审计先留痕同事务），审计实现在
  `src/host/db/audit.ts`；
- **按连接隔离**：`KernelCallHandler` 每条连接一套（`src/host/ws-handler.ts:492-513` 的
  构造注释与实参），取消与在飞行表随连接 `dispose()`（`src/host/ws-kernel-call.ts:37-38`、
  `:78-80`；`tests/ws-kernel-call.spec.ts:108`），幂等键是 `(principal.id, callId)`
  （`src/host/bridge/kernel-call.ts:153-154`）。

**现在怎么办（铁律）**：

1. 新增/修改任何「手机 → 内核」路径，设备判定只能加在**桥**：授权时的 scope 参数、
   principal 传参、审计写入，三处都不能因为「内核会管」而省。
2. 不要试图把 deviceId 塞进内核 principal —— 类型上就做不到。要按设备收紧，就收紧
   `KERNEL_ALLOWLIST` 条目声明的 `scope`，或在桥侧调用前后加判。
3. 在飞行 / 取消 / 幂等必须保持「按连接或按 principal」隔离。把 `KernelCallService` 提成
   全局单例，等于让 A 手机用猜到的 callId 取消 B 手机的调用
   （`src/host/bridge/kernel-call.ts:25-29` 的注释就是这么写的）。
4. 动撤销 / 审计 / principal 传参的改动，同时跑
   `tests/kernel-call.spec.ts:416`「scopes the replay key to the principal」与
   `tests/device-revocation.spec.ts`。

**铁律**：owner peer 只有一个身份；「哪台设备」只存在于桥，内核永远答不了这个问题。

回归锚：`tests/ws-kernel-call.spec.ts`（`:35-97` 帧族与形状校验、`:108` 连接断开中止在飞行）；
`tests/kernel-call.spec.ts:416`。

---

### 服务方法 ≠ 内核端点

**症状**：换源时把「桥里直接调的宿主服务方法」当成「还没搬的端点」，往白名单或目录里加
名字 —— 运行期恒 `kernel/endpoint-unknown`，怎么调都不通；反过来，以为换源后这些调用可以
删，手机端会**静默**少功能：模型选择器不显示上下文窗口（`llm.resolveModelInfo` 的容量
字段没了），大附件上传回落 base64（100 MiB 上传的内存峰值从 2.5 MiB 放大 5.67×）。

**根因**：只有带 `@Remote` 的内核方法才会进 `ctx.typert.local.list()` 的描述符目录，才能被
`namespace/method` 寻址。这四条恰恰**没有端点**（ADR-0010 `:52-53` 逐条核过）：
`userQuestions.continued`（private，无端点）、`llm.resolveModelInfo`（无 `@Remote`）、
`fileUploads.uploadStream`、`sessionController.resolveAgent`。它们是 Cordis 服务方法：
只能进程内 `ctx.get(name)` / `ctx.reflect.get(name, false)` 拿到后直接调，通用调用面的
`namespace/method` 根本到不了。

**现在怎么办（铁律）**：

1. 判断「能不能走通用调用面」的唯一依据是**描述符里有没有它**
   （`src/host/bridge/kernel-endpoints.ts:182-184` 读 `ctx.typert.local.list()`；该模块
   只管登记表现状，不猜服务方法）。目录里没有 ⇒ 必须留桥。
2. 4 条永久留桥已登记在 `BRIDGE_OWNED_ENDPOINTS`
   （`src/host/bridge/kernel-allowlist.ts:194-199`）：`approvals.respond` /
   `userQuestions.cancel` / `sessions.readHandoffImage` /
   `sessions.uploadAttachmentStream`。每条「内核为什么顶不上」、可证伪断言与认领测试见
   ADR-0010 `:156-161` 的表（决议前文 `:130-134`）。
3. 服务方法的容错读取集中在 `src/host/bridge/kernel-services.ts`：`optionalService`
   （`:52-69`，必须走 `ctx.reflect.get(name, false)` —— 直接读属性会抛
   `cannot get property "x" without inject`，与「服务不存在」同形）、`userQuestionsOf`
   （`:88-100`，从 agent scope 取服务）、`toUserQuestionView`（`:109-122`）。
4. 四条消费点别乱搬：
   `resolveAgent` → `src/host/bridge/host-reads.ts:95-114`（无 live Agent 抛
   `session/agent-unavailable`）；
   `llm.resolveModelInfo` → `src/host/bridge/models.ts:95` 的 `enrichModelGroups`（调用点
   `src/host/bridge/kernel-views.ts:245`；字段摘取在
   `src/host/bridge/kernel-deltas.ts:116-125`）；
   `userQuestions.continued` → `kernel-views.ts:354-375`；
   `fileUploads.uploadStream` → `src/host/bridge/file-upload-stream.ts:102-111`（服务缺席
   才回落 base64）。
5. 新增「内核没有」的能力，先写成一句可证伪断言 + 一个认领测试（照 ADR-0010 的 4 条表），
   否则它会被下一个做换源的人误当成漏搬端点删掉。

**铁律**：**有 `@Remote` 才有端点**；服务方法是进程内调用，描述符里没有的名字永远不该出现
在白名单或端点表里。

---

### agent scope 会隐式 resume 冷会话

**症状**：把 agent scope 端点（`agentPresets/select`、`userQuestions/answer`、
`fileUploads/upload` 这类 `agentId` 装会话 id 的）换源或加白名单后直接调用，冷会话会被
**隐式唤醒**：手机只是打开设置、拉一次列表、答一条提问，内核侧却把会话跑起来了。它不报错、
不弹窗，所以没人发现，直到用户看到「没点过的会话自己在跑/在烧额度」。

**根因**：内核端点的 `agentId` 参数走 agent lookup，查不到 live Agent 时会 resume 一个 ——
这是端点语义，不是 bug。而桥的既有语义是「先要求有 live Agent」：门面 `agentPresets.select`
显式 `await agentFor(...)`（`src/host/dsh-0.2-bridge.ts:211-222`，`:212-214` 的注释标了
「保留的 delta 5」）；`agentFor` 拿不到 Agent 就抛 `session/agent-unavailable`
（`src/host/bridge/host-reads.ts:95-114`），`agentForQuestions` 把「冷会话」当正常情况返回
null（`:117-130`）。换源时若不保留这层前置判定，行为就从「拒绝/空」变成「唤醒」。

**现在怎么办（铁律）**：

1. 新增 agent scope 端点前先问：**这一步该不该唤醒会话？** 不该 → 保留前置 live 判定；
   该（如会话模型读，插件命令发现依赖它，见 `src/host/bridge/kernel-views.ts:215-233`）→
   写成一条具名 delta 并登记到 `docs/project/STATUS.md`。
2. 前置判定的显式化工具是 `agentScopeSkip`（`src/host/bridge/kernel-deltas.ts:127-137`，
   delta 5 的表行在 `:17`）：拿不到 Agent 就跳过内核调用、只回桥侧数据。已用在
   `listQuestions`（`src/host/bridge/kernel-views.ts:365-369`）与 `answerQuestion`
   （`:391-419`）。
3. `agentPresets/select` 上这条判定是**刻意保留**的；已知行为差异登记在
   `docs/project/STATUS.md:64-65`。同批的 `uploadAttachment` 已发生过一次同类变化（错误码
   从 `session/agent-unavailable` 变内核解析错误，`STATUS.md:51-53`）—— 下次改 agent scope
   端点，先翻这两段。
4. 加白名单条目时注意：14 条刻意**不含**任何 agent scope 端点
   （`src/host/bridge/kernel-allowlist.ts:82-101`）。放行一条前，先确认它能接受隐式 resume，
   或在桥侧先判 live。
5. 真机验收要分别看**冷/热**两种路径（`STATUS.md:64-65` 点名了这条）。

**铁律**：agent scope 端点自带 resume 副作用；桥侧的「先 agentFor」是有意的语义，不是没搬完
的残余。要放开必须单独立项。

回归锚：`tests/kernel-deltas.spec.ts:86`「delta 5 — treats a missing agent as a short
circuit, not an error」（`agentScopeSkip` 的单测）。⚠️ 门面 `agentPresets.select` 那条
「先 agentFor」目前**没有专门用例认领**（`grep agentPresets.select tests/` 只有描述符
固定，没有冷会话不唤醒的断言）—— 动它之前先补一条用 fake host 断言「冷会话不触发
`invokeKernelEndpoint`」的用例。

---

### workspace/follow 会被 remoteAccess 过滤

**症状**：`workspace.list` 换源到 `workspace/follow` 首帧后，owner peer 下一切照旧；可一旦
有人（为了「更细的权限」）把桥换成非 owner peer，工作区列表会**静默变短**：返回 200、没有
错误帧，只是少了会话/工作区。手机端表现为「会话不见了」，用户以为被删了。

**根因**：内核的 list 类方法会逐条过 `remoteAccess.allows(resource)`。`allows()` 的文档写明
「owner 与 Remote 调用之外一律 true，否则按非 owner principal 的 policy 判」
（`@deepseek-ai/dsh-api-remote-access` 的 `lib/types/index.d.ts:83-90`；同文件 `:74-82` 说
list 方法逐条过它）。桥今天唯一 peer 是 owner（`src/host/ws-host-services.ts:70-71`），所以
这层过滤是**空操作**，可见范围实际上全由桥自己的授权根决定。ADR-0010 的 ⑩ 行已把这条列成
用户可见后果（`docs/project/decisions/ADR-0010-kernel-endpoint-unification.md:85`）。

**现在怎么办（铁律）**：

1. 保持 owner peer 是**默认**，并把「工作区可见范围 = 桥的 rootIds 判据」当契约；不要在桥侧
   再叠一层 `remoteAccess`（那会变成第二套权限模型，两套必然分叉）。
2. 将来若真要把 peer 换成非 owner：先写对账用例，证明同一台设备看到的 workspace/session
   集合在换 peer 前后**逐项相等**；不等就说明出现了本条坑位。当前 `listWorkspace`
   （`src/host/bridge/kernel-views.ts:261-295`）把首帧 `baseline.items` 直接透传
   （`:282-284`），桥侧没有任何补充过滤 —— 过滤只能来自内核。
3. 别把「列表变短」当成分页或空结果：`baseline` 是快照，只有归档集合为空时才回退注册表
   （`:285-291`）。
4. 顺带一条硬约束：`workspace/follow` 是**无参流式**端点，必须走 `streamBareEndpoint`
   （`kernel-views.ts:270`）；错用 `wrapRequestArgument` 会得到 `unexpected ""`
   （`docs/project/TESTING.md:16` 记着实锤）。
5. 列完必须**立刻** abort，否则每次列工作区都会在内核侧挂一个 follower
   （`kernel-views.ts:256-260` 的注释与 `:292-294` 的 finally）。

**铁律**：owner peer 今天让这层过滤等于空操作；换非 owner peer = 悄悄改变工作区可见范围，
必须当成一次用户可见的契约变更来做。

回归锚：`tests/kernel-endpoints.spec.ts:249` 固定 `workspace/follow` 的
`{ wires: [], stream: true, cancellation: true }`；`tests/kernel-invoke.spec.ts:156-161`
流式与多余参数拒收。

---

### 端点缺席 ≠ 服务缺席

降级判据只认一个错误码，就会把「能力不存在」升级成整块 500。

**症状**：某个可选能力（权限档位、提问回答）在裁剪过的 profile / 老内核上整块报系统错误，
而不是回落到换源前的降级行为。单测全绿 —— 因为进程内传输把「服务缺席」刻意映射成
`gateway/service-unavailable`，而真实网关给的是另一个码。

**根因**：换源把「服务缺席」的判据从 `optionalService() === null` 换成了
`error.code === 'gateway/service-unavailable'`，但**端点不在目录里**时抛的是
`KernelEndpointUnknownError`（`code = 'kernel/endpoint-unknown'`，
`src/host/bridge/kernel-invoke.ts:48-55`）。两种情形对降级逻辑是同义的，只认前者就会
rethrow → 500（issue #26 检修审计 R1/R2）。

**现在怎么办（铁律）**：

1. 判断「这个可选能力现在有没有」一律用 `isKernelServiceUnavailable(error)`
   （`kernel-invoke.ts:257-268`，两个码都认），不要自己比错误码字符串。
2. 同样地，`questionAnswerOutcome`（`kernel-deltas.ts:242-263`）把
   `kernel/endpoint-unknown` 归到 `'unavailable'` —— 落到桥的挂起表，等价于换源前的
   `service === null`。
3. 新增任何「服务缺席 ⇒ 降级」的分支时，必须补一条用例：**目录里没有这个端点** +
   `caller.invoke` 零调用 + 断言降级结果。只测「服务在」等于没测这条路径。
4. 反向也要守住：`SCOPE_REQUIRED`/`BAD_ANSWER` 这类真错误**不许**被吞成降级，
   否则越权会伪装成「能力不存在」。

**铁律**：`kernel/endpoint-unknown` 与 `gateway/service-unavailable` 在降级语义上必须
等价；只认一个码就是把「能力不存在」升级成「整块功能 500」。

回归锚：`tests/dsh-0.2-bridge.spec.ts` › falls back to the kernel-default presets when the
gateway lacks the endpoint；`tests/kernel-deltas.spec.ts` › treats a missing endpoint as an
unavailable service for question answers。

### 幂等表：键不带端点、失败也落表、窗口只靠清理器

**症状**：同一个 `callId` 换个端点重试，客户端收到 `ok:true` 但写操作**没执行**（回放的是
上一条应答）；或者一次瞬时失败之后，带同一 `callId` 重试永远拿到失败，直到人工清库。

**根因**（`src/host/bridge/kernel-call.ts` 旧实现）：键是
`kernel-call:${principalId}:${callId}`（不含 endpoint）；`:181` 除 `call/cancelled` 外
**所有失败**都写进表（status 500）；`IdempotencyTable.read` 的 SQL 不带 `created_at`
条件，而唯一 pruner `createIdempotencyPruner`（`retention.ts:146-163`）在生产上**没有定时
调用方** —— 于是「24 h 窗口」只是一句注释。

**现在怎么办（铁律）**：

1. 键必须含端点：`kernel-call:${principalId}:${endpoint}:${callId}`。缺了它，「同一 callId
   幂等」这条承诺就会跨端点串台。
2. **只缓存成功**。失败多半是瞬时的（服务未起、取消、超时），缓存失败等于把一次抖动
   放大成 24 小时不可恢复。
3. 窗口由**读取侧**判（`KernelIdempotencyStore.read` 返回 `createdAt`，
   `kernel-call.ts` 比 `IDEMPOTENCY_TTL_MS`），不要假设清理器跑过。
4. 取消/超时不进幂等：重试应当真的重试。
5. 幂等表只解决「同一连接/同一 callId」，不解决并发互斥（服务按连接创建）；跨连接的
   同一 callId 仍可能各执行一次 —— 要强互斥得把在飞表提到进程级。

**铁律**：幂等三件套（键含语义、只存成功、读侧判窗口）缺一条，都会变成「静默丢写」
或「永久失败」。

回归锚：`tests/kernel-call.spec.ts` › does not replay one endpoint's result for a different
endpoint with the same callId / does not cache failures — a transient error must be retryable /
ignores a cache entry older than the 24h window。

### apply 期读出来的目录，是把「空」钉成事实

**症状**：单测全绿、能力位也「实现了」，但真机装上去 `hello.capabilities` 里就是没有
`kernel-endpoint-catalog-v1` / `kernel-call-v1`，`kernel-endpoints` 帧一次都不推，手机上
整个「内核调用」入口按设计隐藏 —— 看起来像打包漏了代码，其实是读得太早。

**根因**：桥的 apply 早于各 `dsh-api-*` 注册 `@Remote` 端点。apply 期
`readTypertRegistry(ctx.reflect.get('typert', false)).local.list()` 返回**空数组**，
而这份空数组被 `createKernelEndpointCatalog(...)` 包好后塞进构造期 `capabilities` 与
`attachMobileRemoteServices(remote, catalog)`。构造期快照只算一次 ⇒ 之后登记表装好了，
桥手里仍是空目录。单测看不出来：测试是先装好假目录再喂给 server 的，时序恰好相反。

**现在怎么办（铁律）**：目录与依赖它的能力位一律**在用到时再读**（第一条 WS 连接 /
第一次 `connection.ready`），并且**读到空就不缓存** —— 空只代表「现在还不知道」，
不是「内核什么都没有」。具体：`src/index.ts` 的 `resolveKernelCatalog()` 只在非空时落缓存；
`kernelGateway` 的 `catalog` 是 getter；`server.ts` / `ws-handler.ts` 各收一个
`capabilityResolver`，`connection.ready` 与 `hello` 都现算。

**铁律**：凡「运行时才知道」的装配事实（可选服务、登记表、内核目录），构造期只允许
存**取它的方法**，不允许存**取到的值**。

**回归锚**：`tests/mobile-gateway-ws.spec.ts` › 「answers hello from the runtime resolver
instead of the construction snapshot」；真机验证见 `STATUS.md` 2026-11-19 条目。


### idle 即 abort 丢尾帧

**症状**：客户端能收到全部回答正文，但**这一轮永远不结束** —— 顶栏常驻「生成中」，
依赖「轮结束」的通知一条都不弹，`max-tokens` 截断提示也不出现。重连后拉历史一切正常，
所以第一反应总是「客户端少解析了一帧」。

**根因**：内核收尾的顺序是「**先 append `turn/end`，再 `setPhase({kind:'idle'})`**」
（`dsh-agent-loop` 的 turn `finally` → `kick()` 的 `finally`），两步之间**没有 await**；
而 `api-session/status(false)` 正是由后者引出的。桥在状态回调里直接
`controller.abort()`，于是 `for await` 的下一拍恢复时 `signal.aborted` 已经为真、
循环 `break` —— **这一轮最后一帧（正是 `turn/end`）永久丢失**。丢的时机是每轮结尾，
且没有任何日志（`detach()` 静默）。

**实发案例**（2026-11-22，dsh-Chat 1.0.27 + 桥 v2.16.0）：报告
`dsh-Chat 调查报告-dshChat-turn帧丢失疑点-20261122.md`。临时 vitest 复现：
假 `follow` 先 yield snapshot、再在**同一同步栈**触发 status(false)，`frames seen`
只有 `["session/snapshot"]`。既有用例只断言 `aborted === true`，从不断言尾帧送达，
所以这个缺口从 `#2` 拆文件起一直绿。

**现在怎么办（铁律）**：会话「转 idle」**不等于**「流可以立刻掐」。`SessionEventRelay`
现在把 `running === false` 交给 `noteRunFinished()`：先挂一个
`SESSION_RELAY_IDLE_GRACE_MS` 宽限计时器（1.5s，`unref` 过），pump 一旦送出
`turn/end` 就**当场收敛**（`detach` + return），计时器只兜「尾帧始终不来」的会话；
宽限期内重新 `running === true` 走 `attach()` 的命中分支复用同一条订阅（不重建、不丢帧）。

**铁律**：中止一条「还在排水」的流之前，先问一句「最后那一帧是不是还在管道里」。
凡「内核先写事件、再发状态」的地方，状态回调里只允许**标记**，不允许**掐断**。

**回归锚**：`tests/dsh-0.2-bridge.spec.ts` › delivers the turn/end that is still in flight
when the run-finish status arrives / keeps the subscription through the idle grace window,
then releases it。（注意 `nextFrame()` 取一帧就 `return`，会把流关掉 —— 要连取两帧必须
自己拿 `stream[Symbol.asyncIterator]()`。）
