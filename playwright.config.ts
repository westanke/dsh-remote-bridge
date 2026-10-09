import { defineConfig, devices } from '@playwright/test'

/**
 * 浏览器层的样式契约测试。
 *
 * 没有 `webServer`：这一层不需要服务器。插件唯一能打开的网页（独立页 `/dsh-workspace`）
 * 已在 2.2.0 删除，剩下的界面都活在 DSH 自己的设置页插槽里，起不来一个可供 e2e 访问的页面。
 *
 * 那这一层还测什么？测**样式**——用真实的样式表渲染真实的 DOM 结构，再读计算样式。
 *
 * 因为本项目真实栽过两次这个坑：
 * 组件从 920px 弹窗搬进设置页内联渲染后，①少了 `.daw-root` 祖先 → `var(--daw-accent)`
 * 解析失败 → 按钮白字白底**看不见**；②少了原来的两列网格 → 导航塌成竖排。
 * 这两个 bug 类型检查、单测、构建全都发现不了，只有肉眼看渲染或量计算样式才抓得到，
 * 而且两次都是**用户先发现的**。所以把量计算样式这件事固化下来。
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  workers: 1,
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
  ],
})
