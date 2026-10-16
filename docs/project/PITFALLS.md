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

**根因**：`docs:check` 只覆盖 `docs/project/` 下 10 份必需文档与 ADR 索引，
**完全不覆盖 README**。所以「改文档再发版」这道闸在 README 是空的。

**实发案例**（姊妹仓 `dsh-companion`，2026-10-14 commit `d61cad9`）：
v2.2.33 → v2.2.35 三版发布时 README 未同步，中文停在 `v2.2.32`，英文更老（测试数写 24 类/256，中文写 25 类/271，
**两份自己就对不上**）；bridge 版本要求还出现一处 ≥2.3.3、一处 ≥2.3.1 的自相矛盾。

**现在怎么办**：本仓发版前除 `docs:check` 外，另跑一次对账——

```sh
grep -n '"version"' package.json                          # 真值来源
grep -n "2\.3\.[0-9]\|dsh-remote-bridge" README.md README.en.md   # 双站一致
find tests -type f -name "*.ts" | wc -l                   # 测试文件数
```

**铁律**：英文版最容易漏——它是「没人同步的那一份」。中英一起改。

---

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

**铁律**：双站镜像 ≠ 双站都有货。写进文档的下载地址，两端都要点一次。

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

**现在怎么办（临时口径）**：`pnpm check` 的四道门**逐条等价执行**：

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
