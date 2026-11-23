# `/ws/mobile` 协议行为规范 —— 语义契约（帧顺序 / 背压 / 超时 / 断开分类）

> **地位**：帧的**形状**在 [API.md](API.md) 与 [../api/asyncapi.yaml](../api/asyncapi.yaml)（机器可读）；
> 本文记的是形状之外、客户端与服务端**都必须遵守的行为语义** —— 顺序、时限、
> 背压义务、断开分类与重连策略。任何一侧改动这里的条目，都必须先改本文、
> 再改两侧代码（它是跨进程契约，不是某一侧的内部设计）。
>
> 背景（issue #IKXGYT/#IKXGYX，2026-11-23）：桥此前只成文了帧形状，语义散在代码注释里。
> 本文件的条目主要从 `src/host/ws-handler.ts` / `ws-protocol.ts` / `bridge/rpc.ts` /
> `bridge/frame-hub.ts` 的既有行为**提炼成文**（记录现状为主），新条目会标注 issue 号。

## 1. 帧顺序承诺（服务端 → 客户端）

1. **同连接 FIFO**：一条连接上的所有帧（请求应答、订阅推送、主动告知）经过同一个
   发送队列（`sendFrame` → `enqueue` → `drain`），**按入队顺序发出**。不存在「推送插队」。
2. **应答回显**：所有应答帧（含 `error` 帧）在 `data.requestId` 原样回显请求的
   `requestId`（例外：`kernel-call` / `kernel-call-result` / `kernel-call-cancel` 用
   `callId` 配对，**不**回显 `requestId` —— 两套关联并存，别混用）。
3. **错误不终结连接**：单个请求处理失败回 `error` 帧，连接继续可用
   （例外：入站帧不是合法 JSON / 重复键 → `INVALID_FRAME` 错误帧，连接同样不断开）。
4. **协议版本纪律**：已发布的帧 kind 与字段**只增不撤**；老客户端必须忽略未知 kind
   与未知字段。服务端对不认识的 `type` 回 `UNKNOWN_TYPE`，对认识但本构建不支持的回
   `NOT_IMPLEMENTED` —— 两者语义不同，客户端分别处理。

## 2. 背压与 resync（客户端义务）

- 服务端发送队列上限默认 512（`DEFAULT_SOCKET_QUEUE_LIMIT`，可配）。队列满时
  **先丢「可重建」的帧**（`assistant`/`chunk` 这类流式过程帧，重拉 `history` 就能补齐），
  没有可重建帧才丢最旧的一条 —— 永不优先丢请求应答（丢了客户端会干等超时）。
- 被丢帧数累加，队列排空后服务端**必发**一条 `connection-resync-required`
  （`data = { dropped: number, reason: 'backpressure' }`）。
- **客户端收到 `connection-resync-required` 后的义务**：把受影响会话的实时状态视为
  不可信，**重拉 `history` 与 `sessions` 刷新**；随后正常收帧即可，不需要断线重连。
  流式渲染的中间帧丢了不算事故 —— 只有「静默丢帧不告知」才是事故，服务端承诺不这么做。
- `/api/v1/events`（老 REST 事件面）的对应行为是 `connection.resyncRequired` 事件 +
  `close(1013, 'Backpressure')`（队列溢出直接断，客户端重连后全量刷新）。

## 3. 数据基线：history 拉取 + 订阅预热（合起来才是断线恢复）

- **`history` 是唯一权威基线**：客户端（重）连后先拉 `history` 再订阅。历史响应有
  服务端字节预算（`bridge/history-budget.ts`），返回的是服务端当前状态的一致切片，
  分页游标语义见 API.md。
- **`subscribe` 不做全量回放**：订阅只做三件事 —— ① 确认帧 `subscribed`；
  ② 补推该会话**仍待处理**的提问/审批（带 `replayed: true` 标记，防止与新事件混淆）；
  ③ 队列/目标的首屏快照（新连接没有「上次签名」，推一次即得当前状态）。
  除此之外的既往消息一律走 `history`，不靠订阅重放。
- 重复 `subscribe` 是合并不是重置（上游可订阅多个会话）；`unsubscribe` 恢复
  「接收所有已授权会话」的缺省语义。

## 4. 超时口径

| 期限 | 值 | 位置 | 说明 |
| --- | --- | --- | --- |
| 桥 → 内核 RPC | 10 s（`RPC_TIMEOUT_MS`） | `bridge/rpc.ts` | 会话目录查询更紧：3 s（`SESSION_DIR_LOOKUP_TIMEOUT_MS`，在发送的同步前置里） |
| 慢调用日志 | >5 s（`SLOW_RPC_LOG_MS`） | `bridge/rpc.ts` | 观测用，不是超时 |
| 客户端 → 服务端请求 | 30 s 默认 | Kotlin SDK `request(timeoutMs)` | 客户端自己的等待预算；服务端**没有**请求级超时，慢就是慢到 RPC 期限 |
| 心跳 | 30 s 间隔（`DEFAULT_HEARTBEAT_INTERVAL_MS`） | `ws-connection-policy.ts` | 两轮 ping 都没换来 pong → `terminate()` |

## 5. 断开分类与重连策略（客户端义务；issue #IKXGYT）

**铁律（吸取 ds-harness-remote 的教训）：永远不要从裸 close code 推导重试决策 ——
必须 `(code, reason)` 成对判。** 中间层（TLS 终止、反代、隧道）可能改写 close code，
reason 是语义的另一半；两者冲突时按 reason（`error.code` 词表）解释。

桥的 close code 词表（服务端只会发这些）：

| code | reason | 语义 | 客户端重连策略 |
| --- | --- | --- | --- |
| `4001` | `AUTH_REQUIRED` / `AUTH_FAILED` / `PAIRING_FAILED` / `DEVICE_ID_REQUIRED` / `Device revoked` / 鉴权阶段错误码 | **凭据或授权不通过**（含设备被撤销、配对失败） | **终态：停止自动重连**。原样重试只会循环失败；走重新配对/重新授权流程 |
| `1000` | `Client closed` 等 | 正常关闭 | 按需重连（用户主动操作触发的重连） |
| `1001` | `Server stopping` | 服务端计划内停机 | 重连，短退避（服务恢复通常很快） |
| `1012` | `Listener rebinding` | 监听端口重绑 | 重连，短退避 |
| `1013` | `Backpressure` | 事件队列溢出（仅 `/api/v1/events`） | 重连后**全量刷新**（history + sessions） |
| `1006` / `1011` / 无 code | — | 异常断开（握手未完成 / 服务端内部错误 / `terminate()`） | **指数退避 + 全抖动重连**：`delay = random(0, min(cap, base·2^n))`，`base` 建议 1 s、`cap` 建议 30 s，成功后复位 n |
| 其它 | 任意 | **未知 code** | **终态：不重试**（保守方向）。将来服务端新增 code 时，老客户端的默认行为必须安全 |

注意三件事：

1. `mobile` 面的背压**不 close**（丢帧 + `connection-resync-required`，见 §2）；
   `1013` 只出现在老 REST 事件面。
2. `4001` 不是「会话过期」一类的暂态 —— 桥把一切鉴权失败收敛到 4001 并把
   具体原因放进 reason（错误语义用 reason 里的 `error.code` 表达），这是桥与
   其他实现**语义相反**的例子（有的实现用 4008 表达策略违规）——再强调一次：
   判决策要看 `(code, reason)` 对，不要只看 code。
3. 服务端停机流程：`stop()` 先 `close(1001)` + 宽限期等在飞帧排空，宽限期到
   `terminate()`。客户端收到 `1006` 无 reason 的断开多半就是这一过程的尾部。

## 6. 测试认领

- 帧顺序 / requestId 回显：`tests/mobile-gateway-ws.spec.ts`（requestId echo describe）
- 背压丢可重建帧 + resync-required 补发：`tests/mobile-gateway-ws.spec.ts`
  （`/ws/mobile 的连接上限、心跳与背压告知` describe）与 `tests/frame-hub.spec.ts`
- 重复键帧拒且不断链：`tests/mobile-gateway-ws.spec.ts`（issue #IKXGYR describe）
- close code 词表：`tests/websocket-security.spec.ts`（4001 断言）
