const STYLE_ID = 'dsh-workspace-style'

/**
 * 插件的全部样式。
 *
 * 导出出来是为了让测试能守住一条容易失守的不变量：**CSS 变量块必须同时覆盖
 * `.daw-root` 与 `.daw-settings-section`**。
 *
 * 这条防线来自一个真实发生过的隐形 bug：设置页内联渲染时，那一节没有 `.daw-root` 祖先，
 * 于是 `var(--daw-accent)` 解析失败 → `.daw-command.primary` 的 `background` 失效变透明、
 * 而 `color` 仍是 `#fff` → **白字落在白底上，按钮彻底看不见**。
 * 类型检查、单测、构建全都发现不了，只有肉眼看渲染或量计算样式才抓得到。
 */
export const WORKSPACE_CSS = `
.daw-version{font:600 11px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--daw-muted);white-space:nowrap}
.daw-root,.daw-settings-section{--daw-bg:var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-2,#f7f8fa));--daw-panel:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,#fff));--daw-ink:var(--dsw-alias-label-primary,#18202a);--daw-muted:var(--dsw-alias-label-tertiary,#687381);--daw-line:var(--dsw-alias-border-l2,#dfe4e8);--daw-accent:var(--dsw-alias-brand-primary,#087f8c);--daw-accent-soft:var(--dsw-alias-bg-module-platform,#e5f5f6);--daw-good:var(--dsw-alias-state-success-primary,#2f7d4a);--daw-danger:var(--dsw-alias-state-error-primary,#b33a3a);color:var(--daw-ink);background:transparent;font:13px/1.45 Inter,ui-sans-serif,system-ui,sans-serif;letter-spacing:0;min-width:0}
.daw-root *{box-sizing:border-box;letter-spacing:0}
.daw-input:focus-visible{border-color:var(--dsw-alias-brand-primary,var(--daw-accent));outline:none}.daw-icon{width:30px;padding:0}
.daw-icon:hover{background:var(--dsw-alias-bg-module-platform,var(--daw-accent-soft))}
.daw-icon.danger{color:var(--daw-danger);border-color:transparent;background:transparent}
.daw-icon:disabled{opacity:.45;cursor:not-allowed}
.daw-command{padding:0 10px;border-color:#cbd2d8;background:#fff}.daw-command.primary{color:var(--dsw-alias-label-primary,var(--daw-ink));background:var(--dsw-alias-bg-module-platform,var(--daw-panel));border-color:var(--dsw-alias-border-l2,var(--daw-line));font-weight:500}
.daw-command.primary:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,var(--daw-panel));border-color:var(--dsw-alias-label-dimmed,var(--daw-line))}.daw-command.danger{color:var(--daw-danger)}.daw-filebar{display:flex;align-items:center;gap:6px;border-bottom:1px solid var(--daw-line);padding:4px 8px;min-width:0}.daw-admin{overflow:auto;padding:18px;display:flex;flex-direction:column;gap:10px}.daw-admin h3{font-size:14px;margin:0 0 12px}
.daw-cards{display:grid;gap:10px}
.daw-card{border:1px solid var(--dsw-alias-border-l2,var(--daw-line));background:var(--dsw-alias-bg-layer-3,var(--daw-panel));border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.daw-card:hover{border-color:var(--dsw-alias-label-dimmed,var(--daw-line))}
.daw-card-open{background:var(--dsw-alias-bg-layer-2,var(--daw-panel));border-color:var(--dsw-alias-label-dimmed,var(--daw-line))}
.daw-card-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.daw-card-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,var(--daw-accent));outline-offset:-2px}
.daw-card-icon{color:var(--dsw-alias-label-tertiary,var(--daw-muted));flex:none;display:flex;align-items:center}
.daw-card-headtext{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.daw-card-name{color:var(--dsw-alias-label-primary,var(--daw-ink));font-size:15px;font-weight:600;line-height:1.4}
.daw-card-desc{color:var(--dsw-alias-label-tertiary,var(--daw-muted));font-size:13px;line-height:1.5}
.daw-card-chevron{color:var(--dsw-alias-label-tertiary,var(--daw-muted));flex:none;transition:transform .16s;font-size:12px;line-height:1}
.daw-card-chevron-open{transform:rotate(180deg)}
.daw-card-body{border-top:1px solid var(--dsw-alias-border-l2,var(--daw-line));margin:0 16px;padding-bottom:8px}.daw-settings-section{display:grid;grid-template-rows:auto minmax(0,1fr);gap:10px;min-width:0;min-height:0}.daw-settings-section>.daw-list-meta{margin:0}.daw-settings-section .daw-admin{padding:14px 2px}.daw-qr-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-top:12px}.daw-qr-card{margin:0;display:grid;justify-items:center;gap:8px;padding:16px;border:1px solid var(--daw-line);border-radius:6px;background:var(--daw-panel)}.daw-qr-image{width:180px;height:180px;background:var(--dsw-alias-bg-layer-3,#fff);border-radius:4px}.daw-qr-site{font-weight:600}.daw-qr-url{font:12px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--daw-accent);text-decoration:none;overflow-wrap:anywhere;text-align:center}.daw-qr-url:hover{text-decoration:underline}.daw-form-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(120px,.45fr) auto;gap:8px;margin-bottom:14px}.daw-listener-form{display:grid;grid-template-columns:minmax(180px,1fr) 130px auto;gap:8px;align-items:end}.daw-field{display:grid;gap:5px;color:var(--dsw-alias-label-secondary,var(--daw-muted));font-size:12px}.daw-listener-status{display:flex;flex-wrap:wrap;gap:5px 18px;padding:9px 0;color:var(--daw-muted);font:12px ui-monospace,SFMono-Regular,Consolas,monospace}.daw-listener-hint{margin:0 0 8px}.daw-list{border-top:1px solid var(--daw-line)}.daw-list-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;min-height:48px;border-bottom:1px solid var(--daw-line);padding:7px 2px}.daw-list-title{font-weight:600;overflow-wrap:anywhere}
.daw-list-title .daw-pill{margin-left:8px;vertical-align:middle}
.daw-builtin-hint{text-align:right;align-self:center}
.daw-builtin-notice{margin-top:10px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-module-platform,var(--daw-accent-soft))}.daw-list-meta{font-size:12px;color:var(--daw-muted);overflow-wrap:anywhere}.daw-scope-grid{display:flex;flex-wrap:wrap;gap:6px 12px;padding:8px 0}.daw-check{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary,var(--daw-muted))}.daw-code{font:600 22px ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:2px!important;padding:14px;border:1px solid var(--dsw-alias-border-l2,var(--daw-line));background:var(--dsw-alias-bg-module-platform,var(--daw-accent-soft));border-radius:8px;text-align:center;margin:12px 0}.daw-warning{flex:none;border:1px solid var(--dsw-alias-border-l2,var(--daw-line));border-radius:8px;background:var(--dsw-alias-bg-module-platform,var(--daw-accent-soft));padding:9px 11px;color:var(--daw-muted);margin-bottom:0}.daw-pill{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:1px 8px;background:var(--dsw-alias-bg-module-platform,var(--daw-accent-soft));color:var(--dsw-alias-label-secondary,var(--daw-muted));font-size:11px;font-weight:500;line-height:17px}.daw-pill.on{background:var(--dsw-alias-bg-module-platform,var(--daw-accent-soft));color:var(--dsw-alias-state-success-primary,var(--daw-good))}.daw-inline-command{margin-left:8px}@mediaa(max-width:720px){.daw-form-row,.daw-listener-form{grid-template-columns:1fr}.daw-admin{padding:12px}.daw-qr-grid{grid-template-columns:1fr}.daw-qr-image{width:150px;height:150px}.daw-inline-command{margin:8px 0 0}}
`

export function installWorkspaceStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.dataset.plugin = 'dsh-workspace'
  style.textContent = WORKSPACE_CSS
  document.head.appendChild(style)
}
