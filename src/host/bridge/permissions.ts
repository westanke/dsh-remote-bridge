/**
 * 权限档位目录：内核 `permissionPresets.catalog()` 的容错读取与降级清单。
 * （原 `dsh-0.2-bridge.ts` 内的权限区，#2 拆分时原样搬出。）
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import type { PromptContentPart, RpcResponse, UserQuestionAnswer, UserQuestionView } from '../chat-adapter.ts'
import { DEFAULT_HANDOFF_SUBDIR, HANDOFF_FILE_NAME, HANDOFF_MEDIA_TYPES } from '../image-handoff.ts'
import { recordFrameHubDropped, recordRpc } from '../metrics.ts'
import { wireRelative } from '../path-policy.ts'
import type { SettingsApiProxy } from '../settings-adapter.ts'
import type { Dsh02HostServices } from './kernel-services.ts'


/**
 * 内核 `permissionPresets.catalog()` 的形状收敛器。
 *
 * @patch
 * id: permission-presets-catalog-bff
 * for: 内核把预设清单放在独立的远程服务上，且 wire 视图与投影都不带候选项。
 * why: 没有正规写法可用 —— 客户端需要候选项，而内核只把这个方法单独暴露。
 * until: 内核把候选项并进投影，或提供一条已含 options 的查询。
 * test: tests/permission-presets.spec.ts
 */
export function normalizePermissionCatalog(raw: unknown): {
  options: { value: string; name: string; description?: string }[]
  defaultPreset: string
} {
  const view = (raw && typeof raw === 'object' ? raw : {}) as {
    options?: unknown
    defaultPreset?: unknown
  }
  const options = Array.isArray(view.options)
    ? view.options
        .map((entry) => {
          const row = (entry && typeof entry === 'object' ? entry : {}) as {
            value?: unknown
            name?: unknown
            description?: unknown
          }
          if (typeof row.value !== 'string' || row.value === '') return null
          return {
            value: row.value,
            // 名字可以缺（内核的 custom 档位只保证 value），缺了就退回 value 本身 ——
            // 客户端拿它显示档位标签，空串会让菜单出现一个没有文字的行。
            name: typeof row.name === 'string' && row.name !== '' ? row.name : row.value,
            // 空串的 description **不能**原样透传：客户端把它当「有副标题」渲染，
            // 结果是一行空白。判定与 name 一样按「非空串」算。
            ...(typeof row.description === 'string' && row.description !== ''
              ? { description: row.description }
              : {}),
          }
        })
        .filter((entry): entry is { value: string; name: string; description?: string } => entry !== null)
    : []
  const defaultPreset = typeof view.defaultPreset === 'string' && view.defaultPreset !== ''
    ? view.defaultPreset
    // 清单能读出候选、却读不出默认值时，退回第一个候选：它必然是内核声明顺序里的首个，
    // 与「默认档位」的语义最接近，也比抛错好。
    : (options[0]?.value ?? 'workspace-write')
  return { options, defaultPreset }
}


/**
 * 内核 `dsh-permission-presets` 不可注入时用的**降级档位清单**。
 *
 * ## 取值依据（不是编的）
 *
 * 来自内核 `@deepseek-ai/dsh-permission-presets/lib/index.js` 的 `static Config`：
 *
 * ```js
 * presets: z.dict(z.object({ sandbox, approval, name, description })).default({
 *   "workspace-write":   { sandbox: "workspace-write",   approval: "ask",   … },
 *   "danger-full-access":{ sandbox: "danger-full-access",approval: "never", … },
 * })
 * ```
 *
 * 也就是说**未配置时内核就这两个档位**。`read-only` 是合法的 sandbox 模式
 * （`dsh-sandbox-policy` 的 `SANDBOX_MODES = ['read-only','workspace-write','danger-full-access']`），
 * 但内核**没有为它配 preset**，而 `/permission <preset>` 切的是 **preset 名**，
 * 所以这里**不放** read-only —— 放进去等于给客户端一个点下去必然失败的选项。
 *
 * ## 代价（必须说清楚）
 *
 * 这只覆盖**内核默认**：真部署若自定义了 `presets`，这份清单就不全。
 * 所以它只是「内核服务读不到」时的兜底，**不是**候选清单的权威来源 ——
 * 权威来源永远是 `permissionPresets.catalog()`。
 */
export const FALLBACK_PERMISSION_CATALOG = {
  options: [
    {
      value: 'workspace-write',
      name: 'workspace-write',
      description: 'Write inside the workspace and permitted temporary directories; wider retries require approval.',
    },
    {
      value: 'danger-full-access',
      name: 'danger-full-access',
      description: 'Full file access without approval prompts.',
    },
  ],
  defaultPreset: 'workspace-write',
}
