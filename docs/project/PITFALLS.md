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
  官方 deb 兜底 `pkg.cloudflare.com`。三者都失败时**聚合带 URL 的具体原因**给前端（502
  `TUNNEL_DOWNLOAD_FAILED`），而不是泛型 500。
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
