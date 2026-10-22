/**
 * 浏览器半边：把**图片交接消息**里的那个地址渲染成图片本身。
 *
 * 这半边是从 `dsh-image-paths` 0.3.1 并过来的，接的是同一个契约：纯文本模型收到图片时，
 * remote-bridge 会在用户消息里追加两行 ——
 *
 *   🖼️ 图片 1「shot.png」（当前模型看不到图，已存到 .dsh-images/<sha>.png；要看图，请用识图工具打开下面那行的路径）
 *   [Image: source: /absolute/path/.dsh-images/<sha>.png]
 *
 * 本模块只读第一行里那个地址，把它变成一张真的图。第二行是给模型读的机器契约，同一张图
 * 不再重复出第二张；而且只扫**用户消息**，上下文注入、助手正文、工具输出里引用的路径
 * 一律不碰 —— 否则对话里到处都是 `.dsh-images/…` 的例子，每个都会被渲染成图。
 *
 * 取图走宿主那条只读路由 `/plugin/dsh-remote-bridge/raw?sessionId=…&name=…`：
 * 请求里**只有会话与裸文件名**，目录由宿主按会话工作目录推出，客户端连「读哪个目录」
 * 都递不进去。这条路是给 `<img>` 用的 —— 浏览器不会给图片请求加 Authorization 头，
 * 所以它独立于版本化 REST，按回环 + 同源 + 文件名白名单 + 字节自证守门。
 *
 * 座位选的是 Turn 尾部（`conversation.chat.turnTail`）：Chat 节点座位会把这个 kind 收进
 * 「过程分组」，standard 模式下折叠起来 —— DOM 里有、肉眼看不着。Turn 尾在独立成行的
 * 白名单内，任何工作详情模式下都看得见。
 */

import { useEffect, useState, type CSSProperties } from 'react'
import { useWorkspaceI18n } from './i18n.tsx'

/** 本插件在 Chat store 里占的节点 kind。 */
const KIND = 'dsh-remote-bridge-handoff-gallery'
/** 宿主的只读图片路由。 */
const ROUTE = '/plugin/dsh-remote-bridge/raw'
/** 每轮最多显示几张。 */
const MAX_IMAGES = 8
/** 长过这个的路径不值得去解析。 */
const MAX_PATH_CHARS = 4096

/** 图片扩展名：与宿主交接写盘的白名单一致。 */
const IMAGE_EXTENSION = /\.(?:png|jpe?g|webp|gif|heic|heif|bmp|avif)$/i

/**
 * 交接行的行首标记：中英两种文案都以它开头。
 *
 * 判据选「行首标记」而不是「句子里有 已存到」——后者会把用户自己写的句子也算进来，
 * 而 dsh-companion 摘除这一行用的也是同一个标记，两边口径一致。
 */
const HANDOFF_LINE = /^🖼️\s*(?:图片|Image)\s+\d+/i

/**
 * 从交接行里抠出图片地址。
 *
 * 允许「已存到 / 已保存到 / saved to」后面隔一段散文（历史文案里有「工作目录」这种词），
 * 所以是「点心号 + 非贪婪」而不是紧邻匹配。取出的是消息里**原样**的那条路径，
 * 相对（`.dsh-images/x.png`）与绝对（兜底目录那版）都认。
 */
const HANDOFF_PATH = /(?:已(?:保存|存)到|saved to)[^；;\n]*?([A-Za-z0-9_./@~+-][^\s`"'()[\]{}<>|,;:?，。；：、！？]*?\.(?:png|jpe?g|webp|gif|heic|heif|bmp|avif))/i

/** 路径里的文件名（路由只收裸文件名）。 */
export function basenameOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut === -1 ? path : path.slice(cut + 1)
}

/**
 * 读出一段文本里的交接图片。
 * @param text - 消息的文本内容（已按块拼接）。
 * @returns 单个 `{ path, label }`，不是交接消息就是 null。
 */
export function handoffMention(text: string): { path: string; label: string } | null {
  if (typeof text !== 'string' || text === '') return null
  for (const line of text.split('\n')) {
    if (!HANDOFF_LINE.test(line.trim())) continue
    const match = HANDOFF_PATH.exec(line)
    if (match === null) continue
    const path = match[1] ?? ''
    if (path.length === 0 || path.length > MAX_PATH_CHARS) continue
    if (!IMAGE_EXTENSION.test(path)) continue
    return { path, label: basenameOf(path) }
  }
  return null
}

/** 把一条消息的内容块拼成文本。 */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') parts.push(candidate.text)
  }
  return parts.join('\n')
}

/** 一条消息交接出去的那张图，没有就是空数组。 */
export function itemsOfMessage(payload: unknown): { path: string; label: string }[] {
  if (payload === null || typeof payload !== 'object') return []
  const item = handoffMention(contentText((payload as { content?: unknown }).content))
  return item === null ? [] : [item]
}

const WRAP_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'flex-start',
  gap: 8,
  margin: '8px 0 4px',
}

const ITEM_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  maxWidth: '100%',
}

const THUMB_STYLE: CSSProperties = {
  display: 'block',
  maxHeight: 180,
  maxWidth: '100%',
  borderRadius: 8,
  border: '1px solid rgba(127,127,127,0.28)',
  background: 'rgba(127,127,127,0.06)',
  cursor: 'zoom-in',
}

const CAPTION_STYLE: CSSProperties = {
  display: 'block',
  maxWidth: 180,
  fontFamily: 'inherit',
  fontSize: 11,
  lineHeight: 1.4,
  color: 'rgba(127,127,127,0.95)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const OVERLAY_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1000,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(0,0,0,0.72)',
  cursor: 'zoom-out',
}

const FULL_STYLE: CSSProperties = {
  maxWidth: '92vw',
  maxHeight: '92vh',
  borderRadius: 6,
  boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
}

/** 加载失败的缩略图占位（不再像旧版那样整张消失，只留一个问号让人瞎猜）。 */
const THUMB_BROKEN_STYLE: CSSProperties = {
  ...THUMB_STYLE,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 160,
  height: 120,
  cursor: 'default',
  fontSize: 12,
}

const LIGHTBOX_NAV_STYLE: CSSProperties = {
  position: 'absolute',
  top: '50%',
  transform: 'translateY(-50%)',
  zIndex: 1001,
  width: 44,
  height: 44,
  borderRadius: '50%',
  border: 'none',
  background: 'rgba(255,255,255,0.14)',
  color: '#fff',
  fontSize: 22,
  lineHeight: '44px',
  textAlign: 'center',
  cursor: 'pointer',
  padding: 0,
}

const LIGHTBOX_CLOSE_STYLE: CSSProperties = {
  position: 'absolute',
  top: 16,
  right: 16,
  zIndex: 1001,
  width: 40,
  height: 40,
  borderRadius: '50%',
  border: 'none',
  background: 'rgba(255,255,255,0.14)',
  color: '#fff',
  fontSize: 20,
  lineHeight: '40px',
  textAlign: 'center',
  cursor: 'pointer',
  padding: 0,
}

const LIGHTBOX_FULL_BROKEN_STYLE: CSSProperties = {
  ...FULL_STYLE,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 'min(72vw, 560px)',
  height: 'min(60vh, 360px)',
  background: 'rgba(127,127,127,0.18)',
  color: 'rgba(255,255,255,0.92)',
  fontSize: 14,
}

/** 某条地址在这条路由上的 URL。 */
export function imageUrl(path: string, sessionId: string): string {
  return `${ROUTE}?sessionId=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(basenameOf(path))}`
}

/**
 * 缩略图。取不到的（文件已删、会话读不出、格式不符）显示一块「加载失败」占位，
 * 而不是像旧版那样整张消失——消失了用户只会以为模型没存图，根本不知道该重试。
 */
function HandoffThumb(props: {
  item: { path: string; label: string }
  sessionId: string
  failedText: string
  onOpen(): void
}): JSX.Element {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return <div className="daw-handoff-item" style={ITEM_STYLE}>
      <div style={THUMB_BROKEN_STYLE} title={props.item.path}>{props.failedText}</div>
      <span className="daw-handoff-caption" title={props.item.path} style={CAPTION_STYLE}>{props.item.path}</span>
    </div>
  }
  return <div className="daw-handoff-item" style={ITEM_STYLE}>
    <img
      src={imageUrl(props.item.path, props.sessionId)}
      alt={props.item.label}
      title={props.item.path}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      style={THUMB_STYLE}
      onError={() => setFailed(true)}
      onClick={props.onOpen}
    />
    <span className="daw-handoff-caption" title={props.item.path} style={CAPTION_STYLE}>{props.item.path}</span>
  </div>
}

/** 灯箱里的大图；换图时靠 key 重挂载来重置 failed。 */
function LightboxImage(props: { item: { path: string; label: string }; sessionId: string; failedText: string }): JSX.Element {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return <div style={LIGHTBOX_FULL_BROKEN_STYLE}>{props.failedText}</div>
  }
  return <img
    src={imageUrl(props.item.path, props.sessionId)}
    alt={props.item.label}
    decoding="async"
    referrerPolicy="no-referrer"
    style={FULL_STYLE}
    onError={() => setFailed(true)}
  />
}

/**
 * 图集灯箱：点遮罩空白处关闭，但**点图片本身不再误关**（旧版 img 的点击冒泡到 overlay）。
 * 多图时左右切换，Esc 关闭。
 */
function HandoffLightbox(props: {
  items: { path: string; label: string }[]
  index: number
  sessionId: string
  failedText: string
  prevLabel: string
  nextLabel: string
  onClose(): void
  onPrev(): void
  onNext(): void
}): JSX.Element {
  const { items, index, onClose, onPrev, onNext } = props
  const multiple = items.length > 1
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
      else if (multiple && event.key === 'ArrowLeft') onPrev()
      else if (multiple && event.key === 'ArrowRight') onNext()
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [multiple, onClose, onPrev, onNext])

  // 调用方（HandoffTurnTail）已保证 openIndex < items.length，这里下标必中。
  const item = items[index] as { path: string; label: string }
  return <div
    style={{ ...OVERLAY_STYLE, cursor: 'zoom-out' }}
    role="dialog"
    aria-modal="true"
    aria-label={item.path}
    onClick={onClose}
  >
    <button type="button" style={LIGHTBOX_CLOSE_STYLE} aria-label="×" onClick={onClose}>×</button>
    {multiple && index > 0
      ? <button type="button" style={{ ...LIGHTBOX_NAV_STYLE, left: 24 }} aria-label={props.prevLabel} title={props.prevLabel}
          onClick={(e) => { e.stopPropagation(); onPrev() }}>‹</button>
      : null}
    {multiple && index < items.length - 1
      ? <button type="button" style={{ ...LIGHTBOX_NAV_STYLE, right: 24 }} aria-label={props.nextLabel} title={props.nextLabel}
          onClick={(e) => { e.stopPropagation(); onNext() }}>›</button>
      : null}
    {/* 内容区拦截冒泡：点图/点计数器都不关，只有点周围黑色遮罩才关。 */}
    <div style={{ position: 'relative', cursor: 'default' }} onClick={(e) => e.stopPropagation()}>
      <LightboxImage key={index} item={item} sessionId={props.sessionId} failedText={props.failedText} />
      {multiple
        ? <div style={{ position: 'absolute', bottom: -28, left: 0, right: 0, textAlign: 'center', color: 'rgba(255,255,255,0.85)', fontSize: 12 }}>
            {index + 1} / {items.length}
          </div>
        : null}
    </div>
  </div>
}

/** 把本轮各节点里交接出去的图收成一串（按出现顺序去重）。 */
export function collectTurnItems(nodes: any, locations: any, turn: unknown): { path: string; label: string }[] {
  if (nodes === undefined || locations === undefined || turn === undefined || turn === null) return []
  let keys: unknown
  try {
    keys = locations.getTurn((turn as { turn?: unknown }).turn)
  } catch {
    return []
  }
  if (!Array.isArray(keys)) return []
  const seen = new Set<string>()
  const items: { path: string; label: string }[] = []
  for (const key of keys) {
    const node = nodes.get(key)
    if (node === undefined || node === null || node.kind !== KIND) continue
    const list = node.data?.items
    if (!Array.isArray(list)) continue
    for (const item of list) {
      if (item === null || typeof item !== 'object' || typeof item.path !== 'string') continue
      if (seen.has(item.path)) continue
      seen.add(item.path)
      items.push({ path: item.path, label: typeof item.label === 'string' ? item.label : basenameOf(item.path) })
      if (items.length >= MAX_IMAGES) return items
    }
  }
  return items
}

/**
 * Turn 尾部的图集：本轮每条交接消息各自那张图。
 *
 * 没有会话 id 就什么都不显示 —— 路由需要它来定位目录，猜一个只会 404。
 */
export function HandoffTurnTail(props: any): JSX.Element | null {
  const nodes = props.useChat((snapshot: any) => snapshot.nodes)
  const locations = props.useChat((snapshot: any) => snapshot.locations)
  const items = collectTurnItems(nodes, locations, props.turn)
  const sessionId = props.sessionId
  const { t } = useWorkspaceI18n()
  // 灯箱打开的是第几张；null = 关闭。索引状态归图集，单张图之间才能左右切换。
  // 注意：hooks 必须排在所有早退之前，否则 items 从 0 变多张时 hook 顺序会漂移。
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  if (items.length === 0) return null
  if (typeof sessionId !== 'string' || sessionId === '') return null
  // 本轮图片变少（极端情况：节点被替换）时把越界的灯箱收回。
  const openIndex = activeIndex !== null && activeIndex < items.length ? activeIndex : null
  return <>
    <div className="daw-handoff-gallery" style={WRAP_STYLE}>
      {items.map((item, index) => <HandoffThumb
        key={item.path}
        item={item}
        sessionId={sessionId}
        failedText={t('imageLoadFailed')}
        onOpen={() => setActiveIndex(index)}
      />)}
    </div>
    {openIndex !== null
      ? <HandoffLightbox
          items={items}
          index={openIndex}
          sessionId={sessionId}
          failedText={t('imageLoadFailed')}
          prevLabel={t('prevImage')}
          nextLabel={t('nextImage')}
          onClose={() => setActiveIndex(null)}
          onPrev={() => setActiveIndex(i => (i === null ? i : Math.max(0, i - 1)))}
          onNext={() => setActiveIndex(i => (i === null ? i : Math.min(items.length - 1, i + 1)))}
        />
      : null}
  </>
}

/**
 * 一条「交接消息 → 一个图集节点」的 Definition。
 *
 * 只匹配 `user/message`：交接说明属于读者自己发的那条消息。助手正文、上下文注入、
 * 工具输出里到处都是引用 `.dsh-images/…` 的文本，读它们会把别人的话切成碎图。
 *
 * 节点自身**不注册渲染器**（Turn 尾负责显示），所以过程分组里不会多出一行、
 * verbose 模式下也不会重复一次。
 */
export const handoffDefinition = {
  kind: KIND,
  target: 'chat',
  match(event: any): { id: string; role: 'start' } | null {
    if (event === null || typeof event !== 'object' || event.surfaceOp !== 'append') return null
    if (event.type !== 'user/message') return null
    return { id: `m:${String(event.seq)}`, role: 'start' }
  },
  start(_context: any, match: any): { items: { path: string; label: string }[]; anchorSeq: unknown } {
    return { items: itemsOfMessage(match.event.data), anchorSeq: match.event.seq }
  },
  update(context: any): unknown {
    return context.state
  },
  buildViewNode(context: any): Record<string, unknown> | null {
    const state = context.state
    if (state === undefined || !Array.isArray(state.items) || state.items.length === 0) return null
    const start = context.start
    return {
      key: context.key,
      kind: KIND,
      id: context.id,
      target: 'chat',
      anchorSeq: state.anchorSeq,
      location: start !== undefined && start !== null ? start.location : { kind: 'unresolved' },
      visibility: 'visible',
      data: { items: state.items },
    }
  },
}
