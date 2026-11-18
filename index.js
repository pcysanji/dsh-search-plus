/**
 * dsh-session-search — 宿主半边。
 *
 * 目标：跨会话的中文全文搜索要「任意子串都能中」。DSH 自带的
 * `session-query-sqlite` 用 FTS5 `unicode61` 分词，连续汉字被当成一个 token，
 * 搜「好修」这种词内片段命中为 0；而 `trigram` 分词要求查询至少 3 个字，
 * 中文两字词（配乐 / 剧本 / 分镜）同样搜不到。
 *
 * 因此这里不走分词索引，而是自建一份「正文语料 + 偏移表」：
 *   - corpus.bin  所有可检索正文按 UTF-8 连续存放，追加写；
 *   - docs.jsonl  每条文档一行 JSON：会话、seq、类型、时间、在 corpus 里的起止；
 *   - state.json  每个会话日志文件的 size/mtime/代际，用来增量追平。
 *
 * 查询 = 在 corpus 里做字节级子串扫描（Buffer.indexOf，接近内存带宽），
 * 命中后用二分查回文档，再截一段上下文。实测 300 个会话、1.1 GB 解压日志、
 * 约 7 万条正文、语料 200 MB 量级时，单次查询在百毫秒级。
 *
 * 只读：不写任何会话文件，不产生模型调用。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const ROUTE = '/api/dsh-session-search'
const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const SESSIONS_ROOT = path.join(HOME, 'sessions')
const CACHE_DIR = path.join(HOME, 'cache', 'session-search-panel')
const CORPUS_FILE = path.join(CACHE_DIR, 'corpus.bin')
const DOCS_FILE = path.join(CACHE_DIR, 'docs.jsonl')

/**
 * 索引版本。改抽取规则（比如不再收工具输出）就加一，下次启动自动整库重建。
 * 1 → 2：只收用户消息与助手正文，不再收 tool/result。
 */
const INDEX_VERSION = 3

/** DSH 客户端认的会话 id 带 `session-` 前缀，磁盘目录名与索引里存的是裸 uuid。 */
function canonicalId(id) {
  const value = String(id || '')
  return value.startsWith('session-') ? value : 'session-' + value
}

/** 反过来：把带前缀的 id 还原成索引内部用的裸 id。 */
function bareId(id) {
  return String(id || '').replace(/^session-/, '')
}

const WORKSPACE_STORE = path.join(HOME, 'storages', 'workspace.json')

/**
 * 客户端只打得开「工作区记录里登记过、且没归档」的会话。
 * 磁盘上还留着但没登记的子会话（origin: subagent）点了会 unknown session，
 * 所以索引时要按工作区记录标一个 openable，搜索默认只出能打开的。
 */
async function loadRegistry() {
  try {
    const store = JSON.parse(await fsp.readFile(WORKSPACE_STORE, 'utf8'))
    const registered = new Set()
    for (const item of Object.values((store.tables && store.tables.workspaces) || {})) {
      for (const id of item.sessionIds || []) registered.add(bareId(id))
    }
    const archived = new Set(((store.global || {}).archivedSessionIds || []).map(bareId))
    return { known: true, registered, archived }
  } catch {
    return { known: false, registered: new Set(), archived: new Set() }
  }
}
const STATE_FILE = path.join(CACHE_DIR, 'state.json')

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const CHUNK = 4 * 1024 * 1024
/** 单个会话最多贡献几条命中（留最新的），避免一个长会话淹掉整个列表。 */
const PER_SESSION_CAP = 6

/** 索引构建状态（进程内）。 */
const build = {
  running: false,
  done: 0,
  total: 0,
  error: null,
  startedAt: 0,
  finishedAt: 0,
  bytes: 0,
}

let state = null
let docsCache = null
let docsCacheKey = ''

/* ------------------------------------------------------------------ *
 * 会话文件
 * ------------------------------------------------------------------ */

/**
 * 列出所有会话日志：每个工作区目录下是一堆 `session-*` 目录，
 * 目录里可能有 v0…v4 多个代际，只取编号最高的那个。
 * @returns {Promise<Array<{rel: string, abs: string, size: number, mtimeMs: number}>>}
 */
async function listSessionLogs() {
  const out = []
  let workspaces = []
  try {
    workspaces = await fsp.readdir(SESSIONS_ROOT, { withFileTypes: true })
  } catch {
    return out
  }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue
    const wsPath = path.join(SESSIONS_ROOT, ws.name)
    let dirs = []
    try {
      dirs = await fsp.readdir(wsPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue
      const dirPath = path.join(wsPath, dir.name)
      let names = []
      try {
        names = await fsp.readdir(dirPath)
      } catch {
        continue
      }
      let best = null
      for (const name of names) {
        const m = /^session\.v(\d+)\.jsonl\.zstd$/.exec(name)
        if (!m) continue
        const gen = Number(m[1])
        if (!best || gen > best.gen) best = { gen, name }
      }
      if (!best) continue
      const abs = path.join(dirPath, best.name)
      try {
        const st = await fsp.stat(abs)
        out.push({
          rel: path.relative(SESSIONS_ROOT, abs).replace(/\\/g, '/'),
          abs,
          size: st.size,
          mtimeMs: st.mtimeMs,
        })
      } catch {
        /* 文件刚被删掉 */
      }
    }
  }
  return out
}

/**
 * 解压一个会话日志里的全部 zstd 帧。
 * @param {Buffer} buf - 原始文件内容。
 * @returns {string} 拼接后的 JSONL 文本。
 */
function decompressFrames(buf) {
  let out = ''
  let i = 0
  for (;;) {
    const start = buf.indexOf(ZSTD_MAGIC, i)
    if (start < 0) break
    const next = buf.indexOf(ZSTD_MAGIC, start + 4)
    const end = next < 0 ? buf.length : next
    try {
      out += zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
    } catch {
      /* 尾部残帧：崩溃残留，跳过 */
    }
    if (next < 0) break
    i = next
  }
  return out
}

/**
 * 从一段 JSONL 里抽出可检索正文。
 * @param {string} text - 解压后的 JSONL。
 * @param {string} sessionId - 兜底会话 id（目录名）。
 * @returns {{docs: Array<{seq: number, type: string, time: number, text: string, model?: string}>, title?: string, cwd?: string, createdAt?: number}}
 */
function extractDocs(text, sessionId) {
  const docs = []
  let title
  let cwd
  let createdAt
  // 每条请求头里都带 provider/model，记下来贴在它之后产生的助手消息上
  let model = ''
  for (const line of text.split('\n')) {
    if (!line) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const type = event.type
    const seq = Number(event.seq) || 0
    const time = Number(event.time) || 0
    if (type === 'session') {
      const data = event.data || {}
      cwd = event.cwd || data.cwd || cwd
      createdAt = Number(event.createdAt || data.createdAt) || createdAt || 0
      continue
    }
    if (type === 'request/header') {
      const config = ((event.data || {}).header || {}).config || {}
      if (typeof config.model === 'string' && config.model) model = config.model
      continue
    }
    if (type === 'session/title') {
      const value = event.data && event.data.title
      if (typeof value === 'string' && value.trim()) title = value.trim()
      continue
    }
    if (type === 'user/message') {
      const data = event.data || {}
      const source = data.source || {}
      // skill 目录 / 技能正文属于噪声，不进语料
      if (source.kind === 'skill-catalog' || source.kind === 'skill') continue
      for (const part of data.content || []) {
        if (part && part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
          docs.push({ seq, type: 'user', time, text: part.text })
        }
      }
      continue
    }
    if (type === 'assistant/message') {
      const message = (event.data || {}).message || {}
      for (const part of message.content || []) {
        if (part && part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
          docs.push({ seq, type: 'assistant', time, text: part.text, model })
        }
      }
      continue
    }
  }
  return { docs, title, cwd, createdAt, sessionId }
}

/* ------------------------------------------------------------------ *
 * 状态
 * ------------------------------------------------------------------ */

function emptyState() {
  return { v: INDEX_VERSION, files: {}, sessions: {}, corpusBytes: 0, staleBytes: 0, builtAt: 0 }
}

async function loadState() {
  if (state) return state
  try {
    state = JSON.parse(await fsp.readFile(STATE_FILE, 'utf8'))
    if (!state || state.v !== INDEX_VERSION) state = emptyState()
  } catch {
    state = emptyState()
  }
  return state
}

async function saveState() {
  await fsp.mkdir(CACHE_DIR, { recursive: true })
  const tmp = STATE_FILE + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(state), 'utf8')
  await fsp.rename(tmp, STATE_FILE)
}

/* ------------------------------------------------------------------ *
 * 建索引 / 追平
 * ------------------------------------------------------------------ */

/**
 * 把变化的会话日志追加进语料。已有文档不重写；文件变小（被压缩重写）时
 * 该会话的旧文档整体作废（代际 +1），并在陈旧字节超过 30% 时整体重建。
 * @param {boolean} force - 忽略 size/mtime 缓存，整库重建。
 * @returns {Promise<{rebuilt: boolean, added: number}>}
 */
async function refreshIndex(force) {
  await fsp.mkdir(CACHE_DIR, { recursive: true })
  const st = await loadState()
  const logs = await listSessionLogs()
  build.total = logs.length
  build.done = 0

  const rebuild =
    force ||
    !fs.existsSync(CORPUS_FILE) ||
    st.corpusBytes === 0 ||
    st.staleBytes > st.corpusBytes * 0.3

  if (rebuild) {
    state = emptyState()
    await fsp.writeFile(CORPUS_FILE, Buffer.alloc(0))
    await fsp.writeFile(DOCS_FILE, '')
  }

  const corpus = await fsp.open(CORPUS_FILE, 'a')
  const docsOut = await fsp.open(DOCS_FILE, 'a')
  let added = 0
  let bytes = state.corpusBytes
  try {
    for (const log of logs) {
      build.done += 1
      const prev = state.files[log.rel]
      if (!rebuild && prev && prev.size === log.size && prev.mtimeMs === log.mtimeMs) continue
      let text = ''
      try {
        text = decompressFrames(await fsp.readFile(log.abs))
      } catch {
        continue
      }
      const dirName = path.basename(path.dirname(log.abs))
      const sessionId = dirName.replace(/^session-/, '')
      const { docs, title, cwd, createdAt } = extractDocs(text, sessionId)
      const gen = prev ? prev.gen + 1 : 1
      if (prev) state.staleBytes += prev.bytes || 0
      let fileBytes = 0
      const lines = []
      for (const doc of docs) {
        const buf = Buffer.from(doc.text, 'utf8')
        await corpus.write(buf)
        lines.push(
          JSON.stringify({
            s: sessionId,
            q: doc.seq,
            t: doc.type,
            m: doc.time,
            b: bytes + fileBytes,
            l: buf.length,
            g: gen,
            ...(doc.model ? { d: doc.model } : {}),
          }),
        )
        fileBytes += buf.length
        added += 1
      }
      if (lines.length) await docsOut.write(lines.join('\n') + '\n')
      bytes += fileBytes
      state.files[log.rel] = {
        size: log.size,
        mtimeMs: log.mtimeMs,
        gen,
        bytes: fileBytes,
        docs: docs.length,
      }
      const session = state.sessions[sessionId] || {}
      state.sessions[sessionId] = {
        ...session,
        title: title || session.title || sessionId,
        cwd: cwd || session.cwd || '',
        createdAt: createdAt || session.createdAt || 0,
        path: log.rel,
        gen,
        size: log.size,
      }
    }
  } finally {
    await corpus.close()
    await docsOut.close()
  }
  const registry = await loadRegistry()
  if (registry.known) {
    for (const [sid, meta] of Object.entries(state.sessions)) {
      meta.openable = registry.registered.has(sid) && !registry.archived.has(sid)
    }
  }
  state.corpusBytes = bytes
  state.builtAt = Date.now()
  await saveState()
  docsCache = null
  return { rebuilt: rebuild, added }
}

/**
 * 保证索引可用；没有索引时先同步跑完一次（首次会花十几秒）。
 * @returns {Promise<{ready: boolean, building: boolean}>}
 */
async function ensureIndex() {
  if (build.running) return { ready: false, building: true }
  const st = await loadState()
  build.running = true
  build.startedAt = Date.now()
  build.error = null
  try {
    await refreshIndex(!fs.existsSync(CORPUS_FILE) || st.builtAt === 0)
    build.finishedAt = Date.now()
    build.bytes = state.corpusBytes
    return { ready: true, building: false }
  } catch (error) {
    build.error = error && error.message ? error.message : String(error)
    return { ready: false, building: false }
  } finally {
    build.running = false
  }
}

/* ------------------------------------------------------------------ *
 * 查询
 * ------------------------------------------------------------------ */

async function loadDocs() {
  const stat = await fsp.stat(DOCS_FILE)
  const key = `${stat.size}:${stat.mtimeMs}`
  if (docsCache && docsCacheKey === key) return docsCache
  const text = await fsp.readFile(DOCS_FILE, 'utf8')
  const docs = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      docs.push(JSON.parse(line))
    } catch {
      /* 半行 */
    }
  }
  docsCache = docs
  docsCacheKey = key
  return docs
}

/** 二分找 offset 落在哪条文档里。 */
function docAt(docs, offset) {
  let lo = 0
  let hi = docs.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const doc = docs[mid]
    if (offset < doc.b) hi = mid - 1
    else if (offset >= doc.b + doc.l) lo = mid + 1
    else {
      found = mid
      break
    }
  }
  return found >= 0 ? docs[found] : null
}

/** 路径比对统一成斜杠、小写、去尾斜杠。 */
function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** 侧栏式的「最近会话」：按会话日志最后修改时间倒序。 */
function recentSessions(st, count) {
  const rows = []
  for (const [sid, meta] of Object.entries(st.sessions)) {
    if (meta.openable === false) continue
    const file = meta.path ? st.files[meta.path] : null
    const at = (file && file.mtimeMs) || meta.createdAt || 0
    if (!at) continue
    rows.push({
      sessionId: canonicalId(sid),
      title: looksUntitled(meta.title, sid) ? '' : meta.title,
      cwd: meta.cwd || '',
      time: at,
    })
  }
  rows.sort((a, b) => b.time - a.time)
  return rows.slice(0, count)
}

/** 工作区下拉：每个 cwd 一个条目，带会话数和最近活跃时间。 */
function workspaceList(st) {
  const map = new Map()
  for (const meta of Object.values(st.sessions)) {
    if (!meta.cwd || meta.openable === false) continue
    const key = normalizePath(meta.cwd)
    const file = meta.path ? st.files[meta.path] : null
    const at = (file && file.mtimeMs) || meta.createdAt || 0
    const row = map.get(key) || { cwd: meta.cwd, count: 0, lastAt: 0 }
    row.count += 1
    row.lastAt = Math.max(row.lastAt, at)
    map.set(key, row)
  }
  return [...map.values()].sort((a, b) => b.lastAt - a.lastAt)
}

/** 截一段以命中为中心的上下文。 */
function snippetOf(text, localOffset, queryLength) {
  const before = 45
  const after = 90
  let start = Math.max(0, localOffset - before)
  let end = Math.min(text.length, localOffset + queryLength + after)
  // 不要切开代理对
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) start -= 1
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end += 1
  const head = start > 0 ? '…' : ''
  const tail = end < text.length ? '…' : ''
  return head + text.slice(start, end).replace(/\s+/g, ' ') + tail
}

/** 会话没有正经标题时（还是裸 id / uuid），拿第一条用户消息当标题。 */
function looksUntitled(title, sessionId) {
  const value = String(title || '').trim()
  if (!value) return true
  if (value === sessionId) return true
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

/** 一段不含省略号的连续上下文，用来在渲染后的对话里做文本定位。 */
function anchorOf(text, localOffset, queryLength, query) {
  const before = 40
  const after = 60
  let start = Math.max(0, localOffset - before)
  let end = Math.min(text.length, localOffset + queryLength + after)
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) start -= 1
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end += 1
  const anchor = text.slice(start, end).replace(/\s+/g, ' ').trim()
  const rel = anchor.toLowerCase().indexOf(String(query || '').toLowerCase())
  return { anchor, rel }
}

/**
 * 搜一次。
 *
 * 全语料顺序扫描（不走分词索引，中文两字词也能命中），然后按会话聚合：
 * 最近活跃的会话排前面，同一会话内按 seq 升序。返回的每条命中都带一段
 * 原文上下文（anchor），客户端拿它在渲染后的对话里做文本定位。
 *
 * @param {{query: string, sessionId?: string, limit?: number}} options
 */
async function runSearch(options) {
  const query = String(options.query || '').trim()
  if (!query) return { ok: true, total: 0, sessions: 0, hits: [], took: 0 }
  if (!state) await loadState()
  const startedAt = Date.now()
  const limit = Math.min(Math.max(Number(options.limit) || 40, 1), 120)
  const wantSession = options.sessionId ? bareId(options.sessionId) : undefined
  const since = Number(options.since) || 0
  const until = Number(options.until) || 0
  const cwdFilter = normalizePath(options.cwd || '')
  const inRange = (at) => (!since || at >= since) && (!until || at <= until)
  const inWorkspace = (cwd) => !cwdFilter || normalizePath(cwd) === cwdFilter

  // 只搜会话标题：不碰语料，直接把会话表里的标题扫一遍
  if (options.mode === 'title') {
    const st = await loadState()
    const needle = query.toLowerCase()
    const rows = []
    for (const [sid, meta] of Object.entries(st.sessions)) {
      if (wantSession && sid !== wantSession) continue
      if (meta.openable === false) continue
      if (!inWorkspace(meta.cwd)) continue
      if (!inRange(meta.createdAt || 0)) continue
      const title = meta.title || ''
      if (!title || looksUntitled(title, sid)) continue
      const at = title.toLowerCase().indexOf(needle)
      if (at < 0) continue
      rows.push({
        sessionId: canonicalId(sid),
        title,
        cwd: meta.cwd || '',
        seq: 0,
        type: 'title',
        time: meta.createdAt || 0,
        offset: at,
        length: query.length,
        snippet: title,
        anchor: title,
      })
    }
    rows.sort((a, b) => b.time - a.time || (a.title < b.title ? -1 : 1))
    return {
      ok: true,
      total: rows.length,
      sessions: rows.length,
      hits: rows.slice(0, limit),
      took: Date.now() - startedAt,
      mode: 'title',
    }
  }

  const docs = await loadDocs()
  const queryBuf = Buffer.from(query, 'utf8')
  const lowerNeedle = Buffer.from(query.toLowerCase(), 'utf8')
  const ascii = /^[\x20-\x7e]+$/.test(query)

  const handle = await fsp.open(CORPUS_FILE, 'r')
  const total = (await handle.stat()).size
  const perSession = new Map()
  let scannedFrom = 0
  try {
    let carry = Buffer.alloc(0)
    while (scannedFrom < total) {
      const want = Math.min(CHUNK, total - scannedFrom)
      const buf = Buffer.allocUnsafe(want)
      await handle.read(buf, 0, want, scannedFrom)
      let hay = carry.length ? Buffer.concat([carry, buf]) : buf
      const base = scannedFrom - carry.length
      if (ascii) hay = Buffer.from(hay.toString('latin1').toLowerCase(), 'latin1')
      let idx = hay.indexOf(ascii ? lowerNeedle : queryBuf)
      let lastDocEnd = -1
      while (idx >= 0) {
        const offset = base + idx
        // 同一个文档只出一次命中，出完直接跳到文档末尾
        if (offset >= lastDocEnd) {
          const doc = docAt(docs, offset)
          if (doc) {
            lastDocEnd = doc.b + doc.l
            const meta = state.sessions[doc.s] || {}
            const valid =
              meta.openable !== false &&
              inWorkspace(meta.cwd) &&
              inRange(doc.m) &&
              (!state.files[meta.path] || state.files[meta.path].gen === doc.g)
            if (valid && (!wantSession || doc.s === wantSession)) {
              const bucket = perSession.get(doc.s) || []
              if (bucket.length >= PER_SESSION_CAP) bucket.shift()
              bucket.push({
                sessionId: doc.s,
                title: meta.title || '',
                cwd: meta.cwd || '',
                seq: doc.q,
                type: doc.t,
                model: doc.d || '',
                time: doc.m,
                offset,
                length: queryBuf.length,
              })
              perSession.set(doc.s, bucket)
            }
          }
        }
        if (lastDocEnd > offset) {
          const next = lastDocEnd - base
          idx = next > idx ? hay.indexOf(ascii ? lowerNeedle : queryBuf, next) : hay.indexOf(ascii ? lowerNeedle : queryBuf, idx + 1)
        } else {
          idx = hay.indexOf(ascii ? lowerNeedle : queryBuf, idx + 1)
        }
      }
      const overlap = Math.max(queryBuf.length - 1, 0)
      carry = buf.subarray(Math.max(0, buf.length - overlap))
      scannedFrom += want
    }
  } finally {
    await handle.close()
  }

  // 排序：时间新的在前，会话之间和会话内部同一套规则
  const hits = []
  for (const bucket of perSession.values()) hits.push(...bucket)
  // 内部子会话（mnemon-run-*）排后面：它们是自动跑的，不该盖住人自己的对话
  const inner = (id) => (id.startsWith('mnemon-run-') ? 1 : 0)
  hits.sort((a, b) => {
    if (inner(a.sessionId) !== inner(b.sessionId)) return inner(a.sessionId) - inner(b.sessionId)
    if (a.time !== b.time) return b.time - a.time
    if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1
    return b.seq - a.seq
  })

  const picked = hits.slice(0, limit)

  // 个别会话没有标题事件：用它的第一条用户消息顶上，别在列表里显示裸 uuid
  const untitled = new Set()
  for (const hit of picked) {
    const meta = state.sessions[hit.sessionId] || {}
    if (looksUntitled(hit.title, hit.sessionId)) untitled.add(hit.sessionId)
  }
  if (untitled.size) {
    const firstUser = new Map()
    for (const doc of docs) {
      if (doc.t !== 'user' || !untitled.has(doc.s) || firstUser.has(doc.s)) continue
      firstUser.set(doc.s, doc)
    }
    if (firstUser.size) {
      const probe = await fsp.open(CORPUS_FILE, 'r')
      try {
        for (const [sessionId, doc] of firstUser) {
          const buf = Buffer.allocUnsafe(Math.min(doc.l, 400))
          await probe.read(buf, 0, buf.length, doc.b)
          const text = new TextDecoder('utf-8', { fatal: false })
            .decode(buf.subarray(0, Math.min(buf.length, 300)))
            .replace(/\s+/g, ' ')
            .trim()
          const title = text.length > 28 ? text.slice(0, 28) + '…' : text
          const meta = state.sessions[sessionId] || {}
          state.sessions[sessionId] = { ...meta, title }
          for (const hit of picked) if (hit.sessionId === sessionId) hit.title = title
        }
      } finally {
        await probe.close()
      }
    }
  }

  // 补上下文：只读命中附近的一小段，不整个读回 120 MB 语料
  const reader = await fsp.open(CORPUS_FILE, 'r')
  const decoder = new TextDecoder('utf-8', { fatal: false })
  try {
    for (const hit of picked) {
      const doc = docAt(docs, hit.offset)
      if (!doc) continue
      const pad = 320
      const from = Math.max(doc.b, hit.offset - pad)
      const to = Math.min(doc.b + doc.l, hit.offset + hit.length + pad)
      const buf = Buffer.allocUnsafe(Math.max(0, to - from))
      await reader.read(buf, 0, buf.length, from)
      const text = decoder.decode(buf)
      const at = text.indexOf(query)
      const local = at >= 0 ? at : 0
      hit.snippet = snippetOf(text, local, query.length)
      const anchor = anchorOf(text, local, query.length, query)
      hit.anchor = anchor.anchor
      hit.rel = anchor.rel
    }
  } finally {
    await reader.close()
  }

  return {
    ok: true,
    total: picked.length,
    sessions: new Set(hits.map((hit) => hit.sessionId)).size,
    hits: picked.map((hit) => ({ ...hit, sessionId: canonicalId(hit.sessionId) })),
    took: Date.now() - startedAt,
    corpusBytes: total,
  }
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handle(req, res) {
  const url = new URL(req.url || '/', 'http://localhost')
  const route = url.pathname.slice(ROUTE.length) || '/'
  if (route === '/status') {
    const st = await loadState()
    return sendJson(res, 200, {
      ok: true,
      building: build.running,
      done: build.done,
      total: build.total,
      error: build.error,
      builtAt: st.builtAt,
      sessions: Object.keys(st.sessions).length,
      corpusBytes: st.corpusBytes,
      recent: recentSessions(st, 12),
    })
  }
  if (route === '/workspaces') {
    const st = await loadState()
    return sendJson(res, 200, { ok: true, items: workspaceList(st) })
  }
  if (route === '/reindex') {
    if (build.running) return sendJson(res, 409, { ok: false, error: '已在重建中' })
    build.running = true
    build.done = 0
    refreshIndex(true)
      .then(() => {
        build.finishedAt = Date.now()
      })
      .catch((error) => {
        build.error = String(error && error.message ? error.message : error)
      })
      .finally(() => {
        build.running = false
      })
    return sendJson(res, 202, { ok: true, started: true })
  }
  if (route === '/diag') {
    // 客户端点击结果时的诊断：先落盘，再由人（或 agent）读文件，不占浏览器控制台
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > 64_000) break
    }
    const line = `${new Date().toISOString()}\t${body.replace(/[\r\n]+/g, ' ')}\n`
    await fsp.mkdir(CACHE_DIR, { recursive: true })
    await fsp.appendFile(path.join(CACHE_DIR, 'diag.log'), line, 'utf8')
    return sendJson(res, 200, { ok: true })
  }
  if (route === '/search') {
    const status = await ensureIndex()
    if (status.building) {
      return sendJson(res, 200, { ok: true, building: true, done: build.done, total: build.total, hits: [] })
    }
    if (!status.ready) {
      return sendJson(res, 500, { ok: false, error: build.error || '索引不可用' })
    }
    const result = await runSearch({
      query: url.searchParams.get('q') || '',
      sessionId: url.searchParams.get('sessionId') || undefined,
      mode: url.searchParams.get('mode') || undefined,
      cwd: url.searchParams.get('cwd') || undefined,
      since: Number(url.searchParams.get('since') || 0),
      until: Number(url.searchParams.get('until') || 0),
      limit: Number(url.searchParams.get('limit') || 40),
    })
    return sendJson(res, 200, result)
  }
  return sendJson(res, 404, { ok: false, error: '未知接口 ' + route })
}

export const inject = ['webServer']

/** 给命令行自测用：不经过 Electron，也能建库 + 查询。 */
export const internals = { ensureIndex, runSearch, refreshIndex, listSessionLogs, build, handle }

/**
 * @param {import('cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: async (req, res) => {
          try {
            await handle(req, res)
          } catch (error) {
            try {
              sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
            } catch {
              /* 响应已经发完 */
            }
          }
        },
      }),
    'dsh-session-search: api',
  )
  // 启动后在后台先把索引追平，第一次 Ctrl+F 不用等
  setTimeout(() => {
    ensureIndex().catch(() => {})
  }, 3000).unref?.()
}
