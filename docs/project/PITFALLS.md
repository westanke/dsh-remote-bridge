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
