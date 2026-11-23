# 帧样例（golden fixtures）—— 三端对拍基线

这个目录是桥真实输出的帧样例，供 dsh-companion / dsh-Chat 拷走做对拍基线。
跨仓共享靠**文件本身**（不引子模块）：客户端仓库把 `server/` 下的 JSON
拿去当解析/渲染的期望输入；桥这边用 `tests/frame-fixtures.spec.ts` 保证
样例不漂移。

- `server/` — 服务端帧（`{kind, data}`）。`client/` 预留给客户端→桥方向，暂空。
- 机检在 `tests/frame-fixtures.spec.ts`，两层锁：
  1. **词表一致**：`ServerFrameKind` / `ClientFrameType`（`src/host/ws-protocol.ts`）
     与 AsyncAPI 的 kind/type enum 双向比对——加了帧忘改契约直接红。
  2. **活体比对**：`LIVE_SERVER_KINDS` 里的每个 kind 都真实触发一帧、normalize 后
     与本目录 JSON 深度相等——帧形状漂移在 CI 就撞出来。
- 其余样例只做静态校验（kind 在词表里、`kind` 字段与文件名一致），逐步扩进活体集。

## 占位符语义

静态样例里的尖括号值与 normalize 语义一一对应（活体比对两侧都过同一函数）：

| 占位符 | 含义 |
| --- | --- |
| `<NOW>` | 服务端时间戳（epoch ms），`at` / `time` 字段 |
| `<ROOT>` | 授权根 UUID，每次建库重新生成 |
| `<PROJECT>` | 项目路径（tmpdir，每台机器不同） |
| `<DEVICE_ID>` / `<PAIRING_TOKEN>` / `<RECEIPT_ID>` / `<DSH_VERSION>` / `<HOME>` | 一次性凭据 / 环境相关值，样例里占位、不参与比对 |

## 怎么扩

- **加活体帧**：在 `tests/frame-fixtures.spec.ts` 的 `LIVE_SERVER_KINDS` 加
  `{kind, send}`（send 是触发它的客户端帧），然后跑
  `UPDATE_FRAME_FIXTURES=1 node node_modules/vitest/vitest.mjs run tests/frame-fixtures.spec.ts`
  重新生成；生成模式会重写活体集文件、跳过静态覆盖线。
- **加静态样例**：新文件名 = 帧的 kind（如 `hello.json`），`kind` 字段必须与文件名
  一致；形状照 `src/host/ws-*.ts` 里对应帧的构造点抄，动态值用占位符。
  静态样例总数有防清空线（`frame-fixtures.spec.ts` 里 ≥14），别删。
