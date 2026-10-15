import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

const file = process.argv[2]
if (!file) {
  console.error('用法: tsx scripts/validate-entry.ts <条目 yml 路径>')
  process.exit(1)
}
const raw = readFileSync(file, 'utf8')
const entry = parse(raw)

const required = ['url', 'name', 'category', 'description']
const problems: string[] = []

for (const key of required) {
  if (entry[key] === undefined) problems.push(`缺少必填字段: ${key}`)
}
if (!entry.description?.en) problems.push('description.en 是必填的')
if (entry.description?.zh === undefined) console.log('提示: 未提供 description.zh（可选，维护者会补）')

// category 必须在允许列表内
const VALID = ['agi','ui','usage','theme','model','identity','session','memory','tools','wsl','browser','vision','voice','docs','skill','workflow','git','notify','dev','security','remote','market','fun']
if (entry.category && !VALID.includes(entry.category)) problems.push(`category 非法: ${entry.category}`)

// url 与 name 必须对应仓库
if (entry.url && !/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(entry.url)) problems.push(`url 不是规范的 GitHub 仓库地址: ${entry.url}`)

// tarball 必须是 GitHub Release 的 https .tgz
if (entry.tarball) {
  if (!/^https:\/\//.test(entry.tarball)) problems.push('tarball 必须是 https')
  if (!/\.tgz$/.test(entry.tarball)) problems.push('tarball 必须是 .tgz')
  if (!/github\.com|raw\.githubusercontent\.com/.test(entry.tarball)) problems.push('tarball 必须在 GitHub Release 托管')
}

// 描述里不该有营销词
const MARKETING = /\b(best|ultimate|powerful|amazing|revolutionary|blazing|superb|excellent|perfect|magic)\b/i
for (const [lang, text] of Object.entries(entry.description ?? {})) {
  if (typeof text === 'string' && MARKETING.test(text)) problems.push(`description.${lang} 含营销词`)
}

console.log('--- 解析结果 ---')
console.log(JSON.stringify(entry, null, 2))
console.log('--- 字段类型检查 ---')
console.log('url:', typeof entry.url, '| name:', typeof entry.name, '| category:', typeof entry.category)
console.log('description.en 是字符串:', typeof entry.description?.en === 'string')
console.log('description.zh 是字符串:', typeof entry.description?.zh === 'string')
if (problems.length) { console.log('\n❌ 问题:'); problems.forEach(p => console.log(' -', p)); process.exit(1) }
console.log('\n✅ 条目校验通过')
