import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    /**
     * **测试文件之间不并行**（2026-10-20 CI 实锤后加）。
     *
     * 为什么：多个测试文件会改**进程级**的 `process.env`（典型如
     * `tests/plugin-inventory-api.spec.ts` 写 `DSH_HOME` / `DSH_PROFILE`，
     * 指向一个临时造的假 profile）。vitest 默认把不同文件跑在同一 worker 进程的
     * 同一线程里（`isolate` 只隔离模块作用域，不隔离 `process.env`）——
     * 于是 A 文件还在用它自己的假 `DSH_HOME` 时，B 文件已经把 `process.env`
     * 改掉了，B 读到 A 的值（或者反过来）。
     *
     * 症状在 CI 上是「随机地、跨平台地红」：macOS 与 Windows 的 runner 上
     * `plugin-inventory-api` 的 `/roots/resolve` 拿到 404（它读到的 profile
     * 目录里没有自己造的 root），而本地全绿（本地有真实 `~/.dsh` 兜底）。
     *
     * 为什么用 `fileParallelism: false` 而不是 `pool: 'forks'`：
     * forks 能隔离 `process.env`（每个文件一个子进程），但会让 CI 的
     * sqlite 临时库路径与 pnpm store 行为在三个平台上各走各的路径，
     * 引入新的不确定性。**串行**慢一点（本仓 42 文件约 10 秒），但行为可预测 ——
     * 对一个门禁来说，「可预测」比「快」重要。
     *
     * 若将来测试多到串行受不了，再换 `pool: 'forks'` + `isolate: true`
     * （那时各文件已在独立进程，env 天然隔离）。
     */
    fileParallelism: false,
  },
})
