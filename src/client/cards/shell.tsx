/**
 * 折叠卡片的外壳：卡片头（图标 + 标题 + 描述 + 箭头）与展开体。
 *
 * 抽出来的理由：七张卡与「高级设置」组都用这一套外壳，把它留在某一张卡的文件里会让
 * 其余七份 import 一个语义上不属于它们的模块。
 *
 * 交互模型照搬 dsh-vision-router 的 `vr-card`（见 CHANGELOG 2026-08）：圆角 12px 卡片，
 * 展开时加 `daw-card-open`；头部是 `aria-expanded` 的按钮；展开体是 `daw-card-body`。
 */
import type { ReactNode } from 'react'
import {
  Cloud,
  Download,
  File,
  HardDrive,
  Image as ImageIcon,
  Package,
  SlidersHorizontal,
  Smartphone,
  Trash2,
  Upload,
} from 'lucide-react'

import type { MessageKey } from '../i18n.tsx'
import { useWorkspaceI18n } from '../i18n.tsx'
import type { CardTab } from './context.ts'

/**
 * 每张卡的图标。
 *
 * `remote` 与 `tunnel` 刻意不同款：前者是「在本机开个口子」（Upload），后者是「把机器搬到
 * 外网」（Cloud）。两者共用同一个图标会让用户以为它们是同一件事的两个开关 ——
 * 而那正是拆分前那张 123 行卡片的毛病。
 */
export function tabIcon(tab: CardTab): JSX.Element {
  if (tab === 'roots') return <HardDrive size={15} />
  if (tab === 'devices') return <Smartphone size={15} />
  if (tab === 'image') return <ImageIcon size={15} />
  if (tab === 'trash') return <Trash2 size={15} />
  if (tab === 'plugins') return <Package size={15} />
  if (tab === 'remote') return <Upload size={15} />
  if (tab === 'tunnel') return <Cloud size={15} />
  // 一个下载箭头而不是手机图标：手机图标已经归「设备」，这一页讲的是把 App 装到手机上。
  if (tab === 'app-download') return <Download size={15} />
  return <File size={15} />
}

export function SettingsCard(props: {
  tab: CardTab
  nameKey: MessageKey
  descKey: MessageKey
  open: boolean
  onToggle(): void
  children: ReactNode
}): JSX.Element {
  const { t } = useWorkspaceI18n()
  return <section className={`daw-card${props.open ? ' daw-card-open' : ''}`}>
    <button
      type="button"
      className="daw-card-header"
      aria-expanded={props.open}
      onClick={props.onToggle}
    >
      <span className="daw-card-icon" aria-hidden="true">{tabIcon(props.tab)}</span>
      <span className="daw-card-headtext">
        <span className="daw-card-name">{t(props.nameKey)}</span>
        <span className="daw-card-desc">{t(props.descKey)}</span>
      </span>
      <span className={`daw-card-chevron${props.open ? ' daw-card-chevron-open' : ''}`} aria-hidden="true">▾</span>
    </button>
    {props.open && <div className="daw-card-body">{props.children}</div>}
  </section>
}

/**
 * 「高级设置」组：把平时用不到的分区收进一个可折叠的容器。
 *
 * 关键点：**分组只影响显隐，不影响功能**。组里的每一张仍是完整的 `SettingsCard`，
 * 该拉的请求照拉、该写的接口照写 —— `image` 的懒加载挂在 `openCards` 上、
 * `plugins` 的懒加载挂在它自己的 `open` 上，两者都不经过这一层。
 *
 * 组本身**默认收起**：设置页一进来先看到主列表那几张常用的卡。
 */
export function AdvancedGroup(props: {
  open: boolean
  onToggle(): void
  children: ReactNode
}): JSX.Element {
  const { t } = useWorkspaceI18n()
  return <section className={`daw-card${props.open ? ' daw-card-open' : ''} daw-advanced-group`}>
    <button
      type="button"
      className="daw-card-header"
      aria-expanded={props.open}
      onClick={props.onToggle}
    >
      <span className="daw-card-icon" aria-hidden="true"><SlidersHorizontal size={15} /></span>
      <span className="daw-card-headtext">
        <span className="daw-card-name">{t('advancedGroupTitle')}</span>
        <span className="daw-card-desc">{t('advancedGroupDesc')}</span>
      </span>
      <span className={`daw-card-chevron${props.open ? ' daw-card-chevron-open' : ''}`} aria-hidden="true">▾</span>
    </button>
    {props.open && <div className="daw-card-body daw-advanced-body">{props.children}</div>}
  </section>
}

/**
 * 卡片标题的 i18n 键。
 *
 * 大多数分区是 `${tab}Tab`，但 `app-download` 带连字符，裸模板会拼出 `app-downloadTab`
 * —— 没人该去记那个拼法的键名。显式映射，而不是把命名规则编码进模板。
 */
export function tabLabelKey(tab: CardTab): MessageKey {
  return tab === 'app-download' ? 'appDownloadTab' : `${tab}Tab`
}

/**
 * 卡片头部的描述行。与 `tabLabelKey` 同理：唯一含连字符的分区显式映射。
 *
 * 键名是 `${tab}TabDesc`（**带 Tab**），不是 `${tab}Desc`。这个中间段不是冗余：它让
 * 描述键与标题键 `rootsTab` / `rootsTabDesc` 成对，读的人一眼能看出这两个属于同一张卡。
 *
 * 踩过的坑：早先这里写成 `${tab}Desc`，`rootsDesc` 之类根本不在字典里 —— `translate` 直接
 * `dictionaries[locale][key].replace(...)` 抛 TypeError，整个设置面板白屏。`as MessageKey`
 * 把类型检查骗过去了，所以单测全绿也照样白屏。**键名靠模板拼出来时，类型系统是最后一道
 * 防线，这里偏偏被断言关掉了。** 现在改成显式查表，见下。
 */
const TAB_DESC_KEYS: Record<CardTab, MessageKey> = {
  roots: 'rootsTabDesc',
  remote: 'remoteTabDesc',
  tunnel: 'tunnelTabDesc',
  devices: 'devicesTabDesc',
  image: 'imageTabDesc',
  trash: 'trashTabDesc',
  plugins: 'pluginsTabDesc',
  'app-download': 'appDownloadTabDesc',
}

export function tabDescKey(tab: CardTab): MessageKey {
  return TAB_DESC_KEYS[tab]
}
