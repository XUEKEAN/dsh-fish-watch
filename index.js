/**
 * 看门鱼 —— 帮后室里的这条鱼盯着 B 站。
 *
 * 干一件事：把「谁回复了我」「谁 @ 了我」「主人有没有私信」拉下来，
 * 跟本地记住的"已经看过"对比，只把新的交出来。
 *
 * 只读：不评论、不点赞、不发私信。发不发由鱼自己决定。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

export const name = 'fish-watch'
export const inject = ['tools']

// 本地目录安装时 pnpm 用的是 link，peer 依赖不会从宿主 node_modules 解析，
// 所以这里按需自己去 profile 里捞 schemastery：捞到就导出设置面板，捞不到就退化成
// 「只认 cordis.patch.yml 里的 config」，插件照常能用。
function loadSchema() {
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    const profile = process.env.DSH_PROFILE || 'desktop'
    const req = createRequire(join(home, 'profiles', profile, 'package.json'))
    const mod = req('@deepseek-ai/schemastery')
    return mod.default ?? mod
  } catch {
    return null
  }
}

const Schema = loadSchema()

export const Config = Schema
  ? Schema.object({
      biliPath: Schema.string()
        .default('bili')
        .description('bili 命令的路径。装好 bili-cli 后一般直接填 bili（走 PATH）；找不到就填绝对路径。'),
      limit: Schema.natural()
        .min(1)
        .max(30)
        .default(10)
        .description('每个来源默认拉几条。'),
      dataDir: Schema.string().description('存"已经看过"的记录放在哪。留空用 ~/.dsh/fish-watch。'),
    })
  : undefined

const pexec = promisify(execFile)
const SEEN_KEEP = 800

const MISSING_HINT =
  '找不到 bili 命令。这个插件靠 bili-cli 干活，先装它：\n' +
  '  1) pip install bili-agent\n' +
  '  2) bili login      （扫码登录你的号）\n' +
  '  3) bili owner set <主人的UID>   （不设的话查不了主人私信）\n' +
  '如果 bili 装好了只是不在 PATH 里，把这插件的 biliPath 填成完整路径。'

export function apply(ctx, config) {
  const read = (value, fallback) => {
    const v = value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
    return v === undefined || v === null || v === '' ? fallback : v
  }
  const cfg = () => ({
    bin: String(read(config && config.biliPath, 'bili')),
    limit: Number(read(config && config.limit, 10)) || 10,
    dir: String(read(config && config.dataDir, join(homedir(), '.dsh', 'fish-watch'))),
  })

  /** 跑一条 bili 命令，返回 data 段。 */
  async function bili(args) {
    let stdout
    try {
      ;({ stdout } = await pexec(cfg().bin, args, {
        timeout: 45000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      }))
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        throw new Error(MISSING_HINT)
      }
      const stderr = e && e.stderr ? String(e.stderr).trim().slice(0, 300) : ''
      throw new Error(`bili ${args[0]} 跑失败：${e && e.message ? e.message : e}${stderr ? ` — ${stderr}` : ''}`)
    }
    let parsed
    try {
      parsed = JSON.parse(stdout)
    } catch {
      throw new Error(`bili 输出不是 JSON：${String(stdout).slice(0, 200)}`)
    }
    if (parsed && parsed.ok === false) {
      const err = parsed.error || {}
      throw new Error(err.message || err.code || 'bili 返回失败')
    }
    return (parsed && parsed.data) || {}
  }

  async function loadSeen() {
    try {
      const arr = JSON.parse(await readFile(join(cfg().dir, 'seen.json'), 'utf8'))
      return Array.isArray(arr) ? arr : []
    } catch {
      return []
    }
  }

  async function saveSeen(keys) {
    await mkdir(cfg().dir, { recursive: true })
    await writeFile(join(cfg().dir, 'seen.json'), JSON.stringify(keys.slice(-SEEN_KEEP)), 'utf8')
  }

  function toItem(kind, raw) {
    const on = raw.on || {}
    const user = raw.user || {}
    return {
      key: `${kind}:${raw.rpid ?? raw.id ?? raw.seqno}`,
      kind,
      time: raw.time || '',
      who: user.name || (kind === 'dm' ? '主人' : ''),
      mid: user.mid ?? null,
      text: String(raw.content ?? raw.text ?? '').trim(),
      video: on.title || '',
      bvid: on.bvid || '',
      url: on.url || '',
      rpid: raw.rpid ?? null,
      root: raw.root ?? null,
    }
  }

  async function pullFeed(kind, limit) {
    const data = await bili(['feed', kind, '--limit', String(limit)])
    const items = Array.isArray(data.items) ? data.items : []
    return items.map((raw) => toItem(kind, raw))
  }

  async function pullOwnerDM(limit) {
    const data = await bili(['dm', 'read', 'owner', '--limit', String(limit)])
    const msgs = Array.isArray(data.messages) ? data.messages : []
    // 只要主人发来的；我自己的回声不算新东西。
    return msgs.filter((m) => m.from !== 'me').map((raw) => toItem('dm', raw))
  }

  function renderText(value) {
    const v = value || {}
    const lines = [v.count ? `看门鱼查了一趟：${v.count} 条新的` : '看门鱼查了一趟：没有新的。']
    for (const it of (v.items || []).slice(0, 20)) {
      const who = it.who ? `${it.who}：` : ''
      lines.push(`· [${it.kind}] ${who}${it.text}`)
      if (it.video) lines.push(`    ↳《${it.video}》${it.bvid || ''}`)
    }
    if ((v.items || []).length > 20) lines.push(`……还有 ${v.items.length - 20} 条`)
    if (v.errors && v.errors.length) lines.push(`（部分来源没查成：${v.errors.join('；')}）`)
    return lines.join('\n')
  }

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'queue_check',
        description:
          '查一趟看门鱼队列：B 站上谁回复了我、谁 @ 了我、主人有没有私信，只返回上次之后新增的。纯只读，不会发任何东西。',
        parameters: {
          type: 'object',
          properties: {
            scope: {
              type: 'string',
              enum: ['all', 'inbox', 'owner'],
              description: '查哪儿。all＝回复+@+主人私信；inbox＝只查回复和@；owner＝只查主人私信。',
            },
            mark: {
              type: 'boolean',
              description: '查完是否标记为已看过（默认 true）。传 false 可以重复看同一批。',
            },
            limit: {
              type: 'number',
              description: '每个来源最多拉几条，默认用插件设置里的值（10）。',
            },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              at: { type: 'string' },
              count: { type: 'number' },
              items: { type: 'array', items: { type: 'object' } },
              errors: { type: 'array', items: { type: 'string' } },
            },
          },
          render(_args, value) {
            return [{ type: 'text', text: renderText(value) }]
          },
        },
        async execute(args) {
          const a = args && typeof args === 'object' ? args : {}
          const scope = a.scope === 'inbox' || a.scope === 'owner' ? a.scope : 'all'
          const mark = a.mark !== false
          const base = cfg().limit
          const limit = Number.isFinite(a.limit) && a.limit > 0 ? Math.min(Math.floor(a.limit), 30) : base

          const seen = await loadSeen()
          const seenSet = new Set(seen)
          const fresh = []
          const errors = []

          const wantFeed = scope === 'all' || scope === 'inbox'
          const wantDM = scope === 'all' || scope === 'owner'

          if (wantFeed) {
            for (const kind of ['replies', 'mentions']) {
              try {
                for (const it of await pullFeed(kind, limit)) {
                  if (!seenSet.has(it.key)) fresh.push(it)
                }
              } catch (e) {
                errors.push(`${kind}: ${e && e.message ? e.message : e}`)
              }
            }
          }
          if (wantDM) {
            try {
              for (const it of await pullOwnerDM(limit)) {
                if (!seenSet.has(it.key)) fresh.push(it)
              }
            } catch (e) {
              errors.push(`dm: ${e && e.message ? e.message : e}`)
            }
          }

          fresh.sort((x, y) => String(x.time).localeCompare(String(y.time)))
          if (mark && fresh.length) {
            await saveSeen(seen.concat(fresh.map((f) => f.key)))
          }

          return {
            ok: errors.length === 0,
            at: new Date().toISOString(),
            count: fresh.length,
            items: fresh,
            errors,
          }
        },
      }),
    'fish-watch.queue_check',
  )
}