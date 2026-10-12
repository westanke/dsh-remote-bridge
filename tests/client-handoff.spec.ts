import { describe, expect, it } from 'vitest'
import { basenameOf, collectTurnItems, handoffDefinition, handoffMention, imageUrl, itemsOfMessage } from '../src/client/handoff.tsx'

/**
 * 交接句式的解析：这是「图能不能显示出来」的唯一入口，也是最容易误伤的地方。
 *
 * 判据只有一条路：**行首标记**（`🖼️ 图片 N` / `🖼️ Image N`）在**用户消息**里。
 * 对话里到处都在引用 `.dsh-images/…`（上下文注入、助手正文、上一轮工具输出、文档示例），
 * 放宽一点就会把别人的话切成碎图 —— 用户对这种噪声的容忍度是零。
 */

const SHA = 'b'.repeat(64)

describe('交接句式解析', () => {
  it('reads the address out of the Chinese handoff line', () => {
    const text = [
      `🖼️ 图片 1「截图.png」（当前模型看不到图，已存到 .dsh-images/${SHA}.png；要看图，请用识图工具打开下面那行的路径）`,
      `[Image: source: /home/me/project/.dsh-images/${SHA}.png]`,
    ].join('\n')
    expect(handoffMention(text)).toEqual({ path: `.dsh-images/${SHA}.png`, label: `${SHA}.png` })
    // 机器那一行不再产出第二张图。
    expect(itemsOfMessage({ content: [{ type: 'text', text }] })).toHaveLength(1)
  })

  it('reads the English handoff line too', () => {
    const text = `🖼️ Image 2 "shot.webp" (this model can't see images, saved to .dsh-images/${SHA}.webp; to view it, open the path below with an image-reading tool)`
    expect(handoffMention(text)?.path).toBe(`.dsh-images/${SHA}.webp`)
  })

  it('still reads the older wording that spelled out 工作目录', () => {
    const text = `🖼️ 图片 1「老图.jpg」（当前模型不支持图片输入，已保存到工作目录 .dsh-images/${SHA}.jpg；请先用读图工具打开下面那行的绝对路径，看清内容再回答）`
    expect(handoffMention(text)?.path).toBe(`.dsh-images/${SHA}.jpg`)
  })

  it('accepts an absolute path, which is what the fallback directory writes', () => {
    const text = `🖼️ 图片 1「shot.png」（当前模型看不到图，已存到 ${SHA}.png；要看图，请用识图工具打开下面那行的路径）`
    expect(handoffMention(text)?.path).toBe(`${SHA}.png`)
    const absolute = `🖼️ 图片 1「shot.png」（当前模型看不到图，已存到 /state/image-handoff/${SHA}.png；要看图，请用识图工具打开下面那行的路径）`
    expect(handoffMention(absolute)?.path).toBe(`/state/image-handoff/${SHA}.png`)
  })

  it('ignores the machine line when the human line is absent', () => {
    expect(handoffMention(`[Image: source: /home/me/.dsh-images/${SHA}.png]`)).toBeNull()
  })

  it('ignores paths quoted by prose, injections, examples and tool output', () => {
    const noise = [
      `图片交接会存到 .dsh-images/${SHA}.png，详见 README。`,
      `运行时上下文：工作目录是 /media/work，产物放 .dsh-images/ 下。`,
      '```sh\ncp x.png .dsh-images/\n```',
      '',
    ]
    for (const text of noise) expect(handoffMention(text), text).toBeNull()
    expect(itemsOfMessage({ content: [{ type: 'text', text: noise[0] }] })).toEqual([])
  })

  it('ignores a non-image extension even behind the handoff marker', () => {
    expect(handoffMention(`🖼️ 图片 1「notes.txt」（当前模型看不到图，已存到 .dsh-images/${SHA}.txt；要看图，请用识图工具打开下面那行的路径）`)).toBeNull()
  })

  it('only ever matches user messages that were appended', () => {
    const match = (event: unknown): unknown => handoffDefinition.match(event)
    expect(match({ type: 'user/message', surfaceOp: 'append', seq: 7 })).toEqual({ id: 'm:7', role: 'start' })
    // 助手正文与上下文注入都会引用路径，它们不是「交接给人的图」。
    expect(match({ type: 'assistant/message', surfaceOp: 'append', seq: 8 })).toBeNull()
    expect(match({ type: 'user/message', surfaceOp: 'replace', seq: 9 })).toBeNull()
    expect(match(null)).toBeNull()
  })

  it('builds a node only when the message really carried a picture', () => {
    const context = {
      key: 'k', id: 'i', start: { location: { kind: 'turn', turn: 1 } }, state: { items: [{ path: 'a.png', label: 'a.png' }], anchorSeq: 3 },
    }
    expect(handoffDefinition.buildViewNode(context)).toMatchObject({ kind: 'dsh-remote-bridge-handoff-gallery', data: { items: [{ path: 'a.png' }] } })
    expect(handoffDefinition.buildViewNode({ ...context, state: { items: [], anchorSeq: 3 } })).toBeNull()
  })
})

describe('Turn 尾图集', () => {
  function store(items: { path: string; label: string }[][], turn = 4) {
    const nodes = new Map<string, unknown>()
    items.forEach((list, index) => {
      nodes.set(`n${index}`, { kind: 'dsh-remote-bridge-handoff-gallery', data: { items: list } })
    })
    const locations = { getTurn: () => items.map((_list, index) => `n${index}`) }
    return { nodes, locations, turn: { turn } }
  }

  it('collects this turn’s pictures in mention order and de-duplicates them', () => {
    const { nodes, locations, turn } = store([
      [{ path: '.dsh-images/a.png', label: 'a.png' }],
      [{ path: '.dsh-images/a.png', label: 'a.png' }, { path: '.dsh-images/b.jpg', label: 'b.jpg' }],
    ])
    expect(collectTurnItems(nodes, locations, turn).map(item => item.path)).toEqual(['.dsh-images/a.png', '.dsh-images/b.jpg'])
  })

  it('caps a turn at eight pictures and survives a broken location index', () => {
    const list = Array.from({ length: 12 }, (_value, index) => ({ path: `.dsh-images/${index}.png`, label: `${index}.png` }))
    const { nodes, locations, turn } = store([list])
    expect(collectTurnItems(nodes, locations, turn)).toHaveLength(8)
    expect(collectTurnItems(nodes, undefined, turn)).toEqual([])
    expect(collectTurnItems(nodes, { getTurn() { throw new Error('gone') } }, turn)).toEqual([])
  })

  it('builds the route URL from the session and the bare file name', () => {
    const url = imageUrl('.dsh-images/dir name/中文 图.png', 'session 1')
    expect(url.startsWith('/plugin/dsh-remote-bridge/raw?')).toBe(true)
    expect(url).toContain(`sessionId=${encodeURIComponent('session 1')}`)
    // 目录不进请求：路由只收裸文件名，目录由宿主按会话推出。
    expect(url).toContain(encodeURIComponent('中文 图.png'))
    expect(url).not.toContain('dir%20name')
    expect(basenameOf('C:\\Users\\me\\shot.png')).toBe('shot.png')
    expect(basenameOf('shot.png')).toBe('shot.png')
  })
})
