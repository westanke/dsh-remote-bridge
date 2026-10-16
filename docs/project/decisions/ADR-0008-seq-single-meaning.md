# ADR-0008：`seq` 只表示会话持久事件序号

- 状态：accepted
- 日期：2026-10-17

## 决策

出网的 `seq` 字段从此只有一个含义：**会话内持久事件的序号**（内核 `session/event` 的 `event.seq`）。

流式片段 —— `chat.message.delta`，源自内核 `assistant-stream` 的 chunk —— **不再输出 `seq`**；
它的位置信息由既有的 `index`（本次流内的 chunk 序号）承载。

## 原因

0.2 适配层把两条来源完全不同的东西塞进了同一个字段名：

| 来源 | 原来的 `seq` 取值 | 实际含义 |
|---|---|---|
| `frame.type === 'event'` | `event.seq` | 会话**持久事件**序号（全局递增，代表历史位置） |
| `frame.type === 'assistant-stream'` | `inner.index` | **本次流内的 chunk 序号**（每轮从 0 重新开始） |

后果不是崩溃，而是**静默的语义污染**：任何按 `seq` 排序 / 去重 / 分页的消费者，都会把
「流式片段的 0、1、2…」与「持久事件的 0、1、2…」当成同一个序列；
若把 chunk 序号当作 `beforeSeq` 分页游标或 `atSeq` 分叉点，更会指向完全不相干的历史位置。

**为什么可以安全地不再输出**（动手前逐个核过，不是推断）：

- 本仓 `kotlin-sdk` 未建模 delta（`grep seq kotlin-sdk/src` 无命中）；
- WebUI 兜底页 `chat.html` 不读 `seq`；
- 姊妹仓 App 的 `ChatDelta` 里**没有 seq 字段**，`chatDelta()` 只读 `index`；
- AsyncAPI 的 `ChatMessageDelta.seq` 本来就**不是必填**，第三方按 schema 实现不会因此失败。

也就是说：这个字段**当前没有任何消费者**，它唯一的作用是给后来者埋雷。

## 影响

- `assistant-stream` 路径推给 mux 的 `assistant/chunk` 事件不再带 `seq`；
  `index` / `turn` / `step` / `time` 与 `data.chunk` 照旧。
- `chat.message.delta` 载荷里 `seq` 从「总是存在（但可能是 chunk 序号）」变成「不存在」。
  AsyncAPI **保留**该属性并标注 **deprecated**（不删，免得把已有第三方实现判成不合法），
  并写明它只对持久事件有意义。
- **不加能力位**：能力位表示「客户端可据此分支的新能力」，而这里没有任何客户端需要分支 ——
  它只是不再产生一个没人读的字段；加了反而暗示客户端应该做点什么。
- 回归钉子：`tests/dsh-0.2-bridge.spec.ts` 断言 chunk 事件**不含 `seq`**、**含 `index`**。

## 备选方案（未采用）

- **改名为 `chunkSeq` 并继续输出**：信息量更大，但要新增一个字段进契约、进 AsyncAPI、
  进第三方实现的心智模型 —— 而现有消费者连 `seq` 都不读，更不会去读 `chunkSeq`。
  在「没人要」这件事上，少一个字段比多一个字段好。
- **两条路径都用内核的持久 seq**：做不到 —— 内核的 `assistant-stream` 帧里根本没有会话
  持久序号（它只给 `index` / `time` / `turn` / `step`），要拿持久 seq 只能等事件落盘，
  那就等于把流式退化成轮询。
