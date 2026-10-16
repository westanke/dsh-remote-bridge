# 回滚说明：给审批/提问钩子加 `{ prepend: true }`

> 改动日期：2026-10-16
> 仓库：`dsh-remote-bridge`
> **回滚锚点分支：`backup-before-whaleness-prepend`（= `4bdb85d`，改动前的 main）**

---

## 一、这版改了什么

给两个交互钩子加了 Cordis 原生的 `{ prepend: true }` 选项，来源是第三方实现 Whaleness 的网关插件
`dsh-plugin-mobile-gateway`（`lib/index.mjs:3182` 与 `:3214` 都有这个选项，我方没有）。

| 文件 | 改动 |
|---|---|
| `src/host/dsh-0.2-bridge.ts:269` | `Dsh02HostServices.on` 签名加第三个参数 `options?: { prepend?: boolean }` |
| `src/host/dsh-0.2-bridge.ts:599/660` | 审批钩子加 `{ prepend: true }` + `@patch` 四要素 |
| `src/host/dsh-0.2-bridge.ts:758/864` | 提问钩子加 `{ prepend: true }` + `@patch` 四要素 |
| `tests/dsh-0.2-bridge.spec.ts:97` | 测试替身 `on` 改为忠实模拟 Cordis 的 `unshift`/`push` |
| `tests/dsh-0.2-bridge.spec.ts:134` | 新增回归用例「两个钩子必须在瀑布链链首」 |

---

## 二、为什么这么改（**证据链，不是推测**）

上一轮我把它标成「最可疑的推测」。**这一轮坐实了**，证据来自 Cordis 4.0.2 源码
`/media/wangke/OFFICE/harness/deepseek-harness/vendor/cordis/src/events.ts`：

1. **`events.ts:143` 与 `:255`** —— 注册方式就是数组插入：
   ```ts
   const method = options.prepend ? 'unshift' : 'push'
   ```
   不传 `prepend` = `push` 到**链尾**。

2. **`events.ts:225-228`（waterfall 语义原文）** —— 这是决定性的一条：
   > Listeners run outermost-first; **a listener that does not call `next()` vetoes
   > the rest of the chain**, including the built-in behavior.

3. **推论**：不 prepend 时我方监听器排在官方 WebUI 的监听器**之后**；官方 WebUI 若自己处理掉
   这次审批/提问就不调 `next()`，我方**永远不被调用**。症状正是「电脑端一切正常、手机端一张
   卡都没有」，且两侧日志都不会说一句话。

这与本仓 `docs/project/PITFALLS.md` 两条既有坑位完全吻合：
- `§抢答与 next() 委托`：「`next` 是委托给官方界面的钩子」
- 提问钩子源码里**早就有**那段注释：「我们必须在链的最外层……排在后面的话，前面那家一旦不调
  next（veto 整条链），我们根本不会被调用」——**机理当年就写对了，只是注册时漏了这个选项**。

⚠️ 仍然**不是**「已在真机证实卡片因此弹出」。坐实的是**机制成立**，不是**它就是本次不弹的唯一原因**。

---

## 三、怎么回滚

### 方式 A：整版回退（推荐，最快）

```sh
cd /media/wangke/OFFICE/workspace/dsh-remote-bridge
git checkout backup-before-whaleness-prepend -- src/host/dsh-0.2-bridge.ts tests/dsh-0.2-bridge.spec.ts
pnpm check
```

### 方式 B：只回滚实现，保留测试替身

只删两处 `{ prepend: true }`（`:660` 与 `:864`），其余保留。
**注意**：此时那条新回归用例会变红（它就是盯着这个的），需一并删掉该用例或改回旧断言。

### 方式 C：整仓回退到锚点

```sh
cd /media/wangke/OFFICE/workspace/dsh-remote-bridge
git reset --hard backup-before-whaleness-prepend
```

⚠️ 方式 C 会丢弃该分支上其它所有未提交改动，执行前先 `git status` 确认。

---

## 四、怎么判断「要不要回滚」

改动**只影响钩子的注册顺序**，不改任何业务判据。真机验证按下面走：

| 真机现象 | 判定 | 动作 |
|---|---|---|
| 手机端卡片**能弹了** | ✅ 改动有效 | 保留，走发版流程 |
| 卡片仍不弹，但**电脑端 WebUI 的卡片也不弹了** | ⛔ **抢答了**，违反 `§抢答与 next() 委托` | **立即回滚**（方式 A） |
| 卡片仍不弹，电脑端一切照旧 | ➖ 改动无害但非本次病因 | 可保留（它修的是一个真实机制缺陷），另找病因 |
| 电脑端卡片出现两次 / 两边同时弹 | ⛔ 顺序错乱 | **立即回滚** |

第二条是**硬红线**：违反它就是让 agent 抢答，手机没人答时电脑端也拿不到卡片。

---

## 五、门禁记录

- `pnpm check`（typecheck → test → docs:check → build）**全绿**：30 测试文件 / **227 用例通过**，
  `docs:check: 10 project docs, 39 tasks, 7 ADRs, and API/SDK versions are consistent`，
  tsdown 构建成功。
- **反向验证**：临时删掉两处 `{ prepend: true }` 后重跑，新用例如期变红
  （`expected [AsyncFunction Mock] not to be [AsyncFunction Mock]`），恢复后 45 用例全绿
  —— 证明这条测试真能抓回归，不是装饰。

---

## 六、这版**没做**的（留待真机结论）

1. **在线客户端判据**（Whaleness 的 `hasInteractionClient`）—— 我方仍无「有 id 但没手机连就
   `next()` 放行」的守卫。**这版先不动**，避免一次改两件事说不清是哪件起的作用。
2. **下游 abort**（`AbortSignal.any` 答完主动中止 WebUI）—— 未做，风险高于收益。
3. **`sessionIdOfAgent` 链序**（`agent.sessionId` 根本不存在，应把 `id` 提到第一位）——
   未做，属纯优化，不影响行为。
4. **任何发版动作** —— 按规矩未 commit、未推送、未发版，等真机结论。