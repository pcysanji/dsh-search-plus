/**
 * dsh-session-search — 客户端半边。
 *
 * Ctrl+F 打开一个浮窗，搜所有会话的正文（宿主侧建好的语料，见 ./index.js），
 * 命中按会话分组，点一条直接切到那个会话。
 *
 * 与 dsh-chat-find 的分工：chat-find 只搜「当前会话已渲染的 DOM」，
 * 这里搜「磁盘上所有会话的完整正文」，所以能命中还没加载出来的旧消息。
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-search',
  factory(require) {
    'use strict';

    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;

    const SLOT = 'conversation.session.header.utilities';
    const SLOT_ID = 'dsh-session-search';
    const STYLE_ID = 'dsh-session-search-style';
    const API = '/api/dsh-session-search';
    const DEBOUNCE_MS = 180;

    /** 把失败原因写到宿主的 diag.log，省得来回问「控制台里是什么」。 */
    function reportDiag(payload) {
      try {
        fetch(`${API}/diag`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true,
        }).catch(() => {})
      } catch {
        /* 诊断失败不影响主流程 */
      }
    }

    const COPY = {
      button: '搜索所有会话（Ctrl+F）',
      title: '搜索所有会话',
      placeholder: '输入关键词…',
      all: '所有会话',
      this: '仅此对话',
      titleOnly: '仅标题',
      empty: '没有找到匹配内容',
      hint: '↑↓ 选择 · Enter 打开 · Esc 关闭',
      building: '正在建索引',
      failed: '搜索失败',
      recent: '最近搜过',
      recentSessions: '最近会话',
      allTime: '全部时间',
      today: '今天',
      week: '近 7 天',
      month: '近 30 天',
      allWorkspace: '全部工作区',
      custom: '自定义',
      from: '起',
      to: '止',
      clear: '清空',
      pressKey: '按下组合键…',
      shortcutTip: '点击可改快捷键',
    };

    const TIME_PRESETS = [
      { key: 'all', label: 'allTime' },
      { key: 'today', label: 'today' },
      { key: 'week', label: 'week' },
      { key: 'month', label: 'month' },
      { key: 'custom', label: 'custom' },
    ];

    /** 语料是 markdown 原文，DOM 是渲染结果：比对时把这些符号和空白一起去掉 */
    const FLAT_DROP = new Set(['*', '_', '`', '#', '>', '|', '~', '[', ']', '(', ')']);

    const RECENT_KEY = 'dsh-session-search:recent';

    const CSS_TEXT = `
.sss-overlay{
  position:fixed;inset:0;z-index:2147483100;display:flex;justify-content:center;align-items:flex-start;
  padding:11vh 16px 16px;background:var(--dsw-alias-bg-mask-1,rgba(15,23,42,.34));backdrop-filter:blur(2px);
}
.sss-panel{
  width:min(880px,92vw);max-height:78vh;display:flex;flex-direction:column;overflow:hidden;
  background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l2);border-radius:14px;
  box-shadow:0 24px 64px -20px rgba(0,0,0,.45),0 2px 10px rgba(0,0,0,.12);
  font-family:var(--dsw-font-base-14-font-family,inherit);font-size:13px;line-height:1.5;
}
.sss-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.sss-glyph{flex:none;display:inline-flex;width:20px;height:20px;color:var(--dsw-alias-label-tertiary)}
.sss-input{
  flex:1 1 auto;min-width:0;height:34px;border:0;background:transparent;color:inherit;
  font:inherit;font-size:16px;outline:none;
}
.sss-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.sss-kbd{
  flex:none;height:24px;padding:0 7px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-fill-l1);color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:11px;font-variant-numeric:tabular-nums;cursor:pointer;
}
.sss-kbd:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sss-kbd[data-capturing="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.sss-scope{display:inline-flex;padding:2px;border-radius:8px;gap:2px;background:var(--dsw-alias-fill-l1)}
.sss-scope button{
  border:0;background:transparent;border-radius:6px;padding:3px 10px;font:inherit;font-size:12px;
  color:var(--dsw-alias-label-secondary);cursor:pointer;
}
.sss-scope button:hover{color:var(--dsw-alias-label-primary)}
.sss-scope button[aria-pressed="true"]{
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  box-shadow:0 1px 2px rgba(0,0,0,.16);
}
.sss-meta{
  display:flex;align-items:center;gap:10px;padding:6px 14px 4px;
  color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums;
}
.sss-meta .sss-flex{margin-left:auto}
.sss-filters{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:4px 14px 9px;
  border-bottom:1px solid var(--dsw-alias-border-l1)}
.sss-select{
  height:27px;max-width:46%;padding:0 6px 0 8px;border-radius:7px;font:inherit;font-size:12px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-fill-l1);color:var(--dsw-alias-label-primary);
  cursor:pointer;
}
.sss-select:hover{border-color:var(--dsw-alias-border-l3,var(--dsw-alias-border-l2))}
.sss-select:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.sss-dates{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.sss-dates input{
  height:27px;padding:0 8px;border-radius:7px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-fill-l1);
}
.sss-dates input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.sss-scroll{overflow:auto;padding:6px 8px 10px}
.sss-group{padding:9px 8px 6px;margin-top:5px;display:flex;gap:8px;align-items:baseline;
  position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-overlay);
  border-bottom:1px solid var(--dsw-alias-border-l1)}
.sss-group:first-of-type{margin-top:0}
.sss-group b{font-weight:600;color:var(--dsw-alias-label-primary);font-size:12.5px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:56%}
.sss-ws{flex:0 1 auto;font-size:11px;color:var(--dsw-alias-label-tertiary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:24%}
.sss-count{margin-left:auto;flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);
  font-variant-numeric:tabular-nums}
.sss-items{margin:2px 0 4px 10px;padding-left:10px;border-left:1px solid var(--dsw-alias-border-l1)}
.sss-row{
  display:block;width:100%;text-align:left;border:0;background:transparent;border-radius:9px;
  padding:7px 9px;font:inherit;color:inherit;cursor:pointer;
}
.sss-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sss-row[data-active="true"]{background:var(--dsw-alias-interactive-bg-active)}
.sss-line{display:flex;gap:8px;align-items:center;color:var(--dsw-alias-label-tertiary);font-size:11px}
.sss-tag{flex:0 0 96px;width:96px;box-sizing:border-box;padding:0 4px;border-radius:4px;
  font-size:10.5px;line-height:16px;font-weight:600;text-align:center;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-secondary)}
.sss-tag[data-kind="user"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);
  color:var(--dsw-alias-brand-primary)}
.sss-tag[data-kind="assistant"]{--sss-mc:var(--dsw-static-violet-600);
  background:color-mix(in srgb,var(--sss-mc) 15%,transparent);color:var(--sss-mc)}
body[data-ds-dark-theme] .sss-tag[data-kind="assistant"]{--sss-mc:var(--dsw-static-violet-400);
  background:color-mix(in srgb,var(--sss-mc) 18%,transparent)}
.sss-tag[data-kind="assistant"][data-mc="minimax"]{--sss-mc:var(--dsw-alias-state-success-primary)}
.sss-tag[data-kind="assistant"][data-mc="spark"]{--sss-mc:var(--dsw-alias-state-warn-primary)}
.sss-tag[data-kind="assistant"][data-mc="openai"]{--sss-mc:var(--dsw-static-blue-600)}
body[data-ds-dark-theme] .sss-tag[data-kind="assistant"][data-mc="openai"]{--sss-mc:var(--dsw-static-blue-400)}
.sss-tag[data-kind="assistant"][data-mc="doubao"]{--sss-mc:var(--dsw-static-red-600)}
body[data-ds-dark-theme] .sss-tag[data-kind="assistant"][data-mc="doubao"]{--sss-mc:var(--dsw-static-red-400)}
.sss-tag[data-kind="assistant"][data-mc="other"]{--sss-mc:var(--dsw-alias-label-secondary)}
.sss-tag[data-kind="title"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 16%,transparent);
  color:var(--dsw-alias-state-success-primary)}
.sss-snippet{margin-top:2px;color:var(--dsw-alias-label-primary);font-size:12.5px;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.sss-snippet mark{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 34%,transparent);
  color:inherit;border-radius:3px;padding:0 1px}
.sss-empty{padding:26px 14px;text-align:center;color:var(--dsw-alias-label-tertiary)}
.sss-blank{padding:6px 14px 18px}
.sss-sec{margin-top:12px}
.sss-sec-h{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary);margin-bottom:6px}
.sss-sec-h .sss-flex{margin-left:auto}
.sss-link{border:0;background:transparent;padding:0;font:inherit;font-size:11px;cursor:pointer;
  color:var(--dsw-alias-label-tertiary);text-decoration:underline;text-underline-offset:2px}
.sss-link:hover{color:var(--dsw-alias-state-error-primary)}
.sss-chips{display:flex;flex-wrap:wrap;gap:6px}
.sss-chip{display:inline-flex;align-items:center;gap:2px;border-radius:999px;padding:0 4px 0 10px;
  background:var(--dsw-alias-fill-l1);color:var(--dsw-alias-label-primary);font-size:12px}
.sss-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sss-chip-t{border:0;background:transparent;padding:4px 0;font:inherit;font-size:12px;color:inherit;cursor:pointer}
.sss-chip-x{border:0;background:transparent;width:18px;height:18px;border-radius:50%;padding:0;line-height:1;
  font-size:13px;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.sss-chip-x:hover{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}
.sss-recent{display:flex;align-items:baseline;gap:8px;width:100%}
.sss-recent-t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;text-align:left}
.sss-recent-d{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.sss-foot{display:flex;gap:10px;align-items:center;padding:7px 14px;border-top:1px solid var(--dsw-alias-border-l1);
  color:var(--dsw-alias-label-tertiary);font-size:11.5px}
.sss-foot .sss-flex{margin-left:auto}
.sss-btn{
  display:inline-flex;align-items:center;justify-content:center;height:28px;min-width:28px;padding:0 7px;
  border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:12px;line-height:1;cursor:pointer;
}
.sss-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}

`

    /* ------------------------------------------------------------------ *
     * 状态
     * ------------------------------------------------------------------ */

    const state = {
      open: false,
      query: '',
      scope: 'all',
      hits: [],
      total: 0,
      took: 0,
      loading: false,
      building: false,
      progress: { done: 0, total: 0 },
      error: null,
      active: 0,
      /** 时间范围：all / today / week / month */
      since: 'all',
      /** 工作区过滤：归一化后的 cwd，空串=全部 */
      cwd: '',
      recentSessions: [],
      workspaces: [],
      recentQueries: [],
      /** 自定义时间范围（YYYY-MM-DD） */
      from: '',
      to: '',
      /** 当前快捷键组合，如 mod+f */
      shortcut: 'mod+f',
      /** 正在录制快捷键 */
      capturing: false,
      /** 建索引结束时 +1，用来触发一次重搜 */
      refresh: 0,
    }

    const listeners = new Set()

    function set(patch) {
      Object.assign(state, patch)
      for (const fn of listeners) fn()
    }

    function subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    }

    function useStore() {
      const [, force] = React.useReducer((n) => n + 1, 0)
      React.useEffect(() => subscribe(() => force()), [])
      return state
    }

    /* ------------------------------------------------------------------ *
     * 数据
     * ------------------------------------------------------------------ */

    function currentSessionId() {
      const node = document.querySelector('[data-conversation-session]')
      const value = node && node.getAttribute('data-conversation-session')
      return value || ''
    }

    const SHORTCUT_KEY = 'dsh-session-search:shortcut'

    /** 快捷键存成 `mod+f` 这种形式（mod = Ctrl 或 Cmd）。 */
    function readShortcut() {
      try {
        const value = localStorage.getItem(SHORTCUT_KEY) || ''
        if (/^(mod|alt|shift)(\+(mod|alt|shift))*\+[a-z0-9]$/.test(value)) return value
      } catch {
        /* 忽略 */
      }
      return 'mod+f'
    }

    function saveShortcut(combo) {
      try {
        localStorage.setItem(SHORTCUT_KEY, combo)
      } catch {
        /* 忽略 */
      }
      set({ shortcut: combo, capturing: false })
    }

    /** 把一次按键压成 `mod+shift+k` 这种描述；不认识的键返回空串。 */
    function comboOf(event) {
      const key = String(event.key || '').toLowerCase()
      if (!/^[a-z0-9]$/.test(key)) return ''
      const parts = []
      if (event.ctrlKey || event.metaKey) parts.push('mod')
      if (event.altKey) parts.push('alt')
      if (event.shiftKey) parts.push('shift')
      parts.push(key)
      return parts.join('+')
    }

    function shortcutLabel(combo) {
      return String(combo || '')
        .split('+')
        .map((part) => (part === 'mod' ? 'Ctrl' : part === 'alt' ? 'Alt' : part === 'shift' ? 'Shift' : part.toUpperCase()))
        .join('+')
    }

    /** 时间范围 → 起止时间戳（0 = 不限）。自定义范围按整天算。 */
    function rangeOf(key, from, to) {
      const now = Date.now()
      if (key === 'today') {
        const day = new Date()
        day.setHours(0, 0, 0, 0)
        return { since: day.getTime(), until: 0 }
      }
      if (key === 'week') return { since: now - 7 * 86400000, until: 0 }
      if (key === 'month') return { since: now - 30 * 86400000, until: 0 }
      if (key === 'custom') {
        const start = from ? new Date(from + 'T00:00:00').getTime() : 0
        const end = to ? new Date(to + 'T23:59:59.999').getTime() : 0
        return { since: Number.isFinite(start) ? start : 0, until: Number.isFinite(end) ? end : 0 }
      }
      return { since: 0, until: 0 }
    }

    /** 浮层挂在 body 上，原生控件要跟上宿主主题，否则下拉列表会是另一套配色。 */
    function syncColorScheme(node) {
      if (!node || !document.body) return
      node.style.colorScheme = document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'
    }

    function readRecent() {
      try {
        const value = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
        return Array.isArray(value) ? value.slice(0, 8) : []
      } catch {
        return []
      }
    }

    function writeRecent(list) {
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(list))
      } catch {
        /* 存不了就算了 */
      }
      set({ recentQueries: list })
      return list
    }

    function clearRecent() {
      writeRecent([])
    }

    function forgetQuery(query) {
      writeRecent(readRecent().filter((item) => item !== query))
    }

    /** 记住这次搜的词，返回新的列表（最新的在最前）。 */
    function rememberQuery(query) {
      const value = String(query || '').trim()
      if (value.length < 2) return readRecent()
      const list = [value, ...readRecent().filter((item) => item !== value)].slice(0, 8)
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(list))
      } catch {
        /* 存不了就算了 */
      }
      return list
    }

    async function search(query, scope, filters) {
      const params = new URLSearchParams({ q: query, limit: '60' })
      if (scope === 'title') {
        params.set('mode', 'title')
      } else if (scope === 'this') {
        const id = currentSessionId()
        if (id) params.set('sessionId', canonical(id))
      }
      const range = rangeOf(filters && filters.since, filters && filters.from, filters && filters.to)
      if (range.since) params.set('since', String(range.since))
      if (range.until) params.set('until', String(range.until))
      if (filters && filters.cwd) params.set('cwd', filters.cwd)
      const response = await fetch(`${API}/search?${params}`, { headers: { accept: 'application/json' } })
      return await response.json()
    }

    function serviceProbe(ctx) {
      return ['uiWorkspace', 'workspaces', 'sessions', 'slots']
        .map((name) => `${name}:${serviceOf(ctx, name) ? 1 : 0}`)
        .join(',')
    }

    function serviceOf(ctx, name) {
      if (!ctx || typeof ctx.get !== 'function') return null
      try {
        return ctx.get(name) || null
      } catch {
        return null
      }
    }

    /**
     * DSH 客户端认的会话 id 带 `session-` 前缀（工作区记录里就是
     * `session-2f8df822-...` 这种），索引里存的是裸 uuid。切会话必须用带前缀的。
     */
    function canonical(id) {
      const value = String(id || '')
      if (!value) return ''
      return value.startsWith('session-') ? value : 'session-' + value
    }

    /** 当前打开的会话 id：DSH 把它写在对话根节点的 data-conversation-session 上。 */
    function visibleSessionId() {
      const root = document.querySelector('[data-conversation-session]')
      return root ? root.getAttribute('data-conversation-session') : null
    }

    /** 会话属于哪个工作区。搜索结果是跨工作区的，只能按 cwd 认。 */
    function workspaceFor(ctx, cwd) {
      const workspaces = serviceOf(ctx, 'workspaces')
      const snapshot = workspaces && workspaces.list && workspaces.list.getSnapshot
        ? workspaces.list.getSnapshot()
        : null
      const items = snapshot && snapshot.items
      if (!contextPath(cwd) || !Array.isArray(items)) return null
      const want = contextPath(cwd)
      return items.find((item) => contextPath(item.path) === want) || null
    }

    function contextPath(value) {
      if (!value) return ''
      return String(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    }

    /** 当前工作区：快照里没有「选中项」，只能用正开着的会话反查。 */
    function currentWorkspaceId(ctx) {
      const workspaces = serviceOf(ctx, 'workspaces')
      const snapshot = workspaces && workspaces.list && workspaces.list.getSnapshot
        ? workspaces.list.getSnapshot()
        : null
      const items = snapshot && snapshot.items
      const shown = visibleSessionId()
      if (!Array.isArray(items) || !shown) return null
      const hit = items.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(shown))
      return hit ? hit.workspaceId : null
    }

    /**
     * 切到某条命中所在的会话。
     *
     * 跨工作区必须单独处理：uiWorkspace.openSession 走 sessions.retain，
     * 而客户端只认识已连接工作区的会话，跨区会抛 `sessions.retain: unknown session`。
     * 所以失败时先把它所在的工作区连上，再切一次。
     */
    async function navigateTo(hit) {
      const ctx = ctxRef.current
      if (!ctx) return { ok: false, reason: '插件上下文没就绪' }
      const ui = serviceOf(ctx, 'uiWorkspace')
      if (!ui || typeof ui.openSession !== 'function') {
        return { ok: false, reason: '找不到 uiWorkspace 服务' }
      }
      // 客户端认带前缀的 id，但不同版本可能只认裸 uuid，两种都试
      const targets = [...new Set([canonical(hit.sessionId), String(hit.sessionId)])].filter(Boolean)
      let first = ''
      for (const target of targets) {
        try {
          ui.openSession(target)
          reportDiag({ stage: 'open-ok', sessionId: target })
          return { ok: true }
        } catch (error) {
          if (!first) first = error && error.message ? error.message : String(error)
        }
      }
      // 可能是客户端会话列表还没追平：拉一次列表再试
      const listService = serviceOf(ctx, 'sessions')
      const listStore = listService && listService.list
      if (listStore && typeof listStore.refresh === 'function') {
        try {
          await listStore.refresh()
        } catch {
          /* 拉不动就继续走后面的兜底 */
        }
        for (const target of targets) {
          try {
            ui.openSession(target)
            reportDiag({ stage: 'open-ok-after-refresh', sessionId: target })
            return { ok: true }
          } catch (error) {
            if (!first) first = error && error.message ? error.message : String(error)
          }
        }
      }

      const workspace = workspaceFor(ctx, hit.cwd)
      if (!workspace) {
        reportDiag({ stage: 'open-failed', reason: first, probe: serviceProbe(ctx), sessionId: hit.sessionId, cwd: hit.cwd })
        return { ok: false, reason: first }
      }
      if (workspace.workspaceId === currentWorkspaceId(ctx)) {
        reportDiag({ stage: 'open-failed', reason: first, probe: serviceProbe(ctx), sessionId: hit.sessionId, cwd: hit.cwd, sameWorkspace: true })
        return { ok: false, reason: first }
      }
      try {
        reportDiag({ stage: 'connect-workspace', workspaceId: workspace.workspaceId, sessionId: hit.sessionId })
        if (typeof ui.connectWorkspace === 'function') await ui.connectWorkspace(workspace.workspaceId)
      } catch (error) {
        return { ok: false, reason: `连接工作区失败：${error && error.message ? error.message : error}` }
      }
      for (const target of targets) {
        try {
          ui.openSession(target)
          reportDiag({ stage: 'open-ok-after-connect', sessionId: target })
          return { ok: true, switchedWorkspace: true }
        } catch (error) {
          if (!first) first = error && error.message ? error.message : String(error)
        }
      }
      reportDiag({
        stage: 'open-failed-after-connect',
        reason: first,
        sessionId: targets[0],
        workspaceId: workspace.workspaceId,
      })
      return { ok: false, reason: first }
    }

    /** 等对话区真的换成目标会话（切工作区会有几秒延迟）。 */
    function waitForSession(sessionId, timeoutMs) {
      return new Promise((resolve) => {
        const started = Date.now()
        const want = canonical(sessionId)
        const tick = () => {
          if (canonical(visibleSessionId()) === want) return resolve(true)
          if (Date.now() - started > timeoutMs) return resolve(false)
          window.setTimeout(tick, 120)
        }
        tick()
      })
    }

    /* ------------------------------------------------------------------ *
     * 切过去之后，把命中那句话滚到屏幕中间并高亮
     * ------------------------------------------------------------------ */

    const HIGHLIGHT = 'sss-hit'
    const locateJobs = new Map()

    function toast(text) {
      const el = document.createElement('div')
      el.className = 'sss-toast'
      el.textContent = text
      document.body.appendChild(el)
      window.setTimeout(() => el.remove(), 2600)
    }

    function ensureHighlightStyle() {
      if (document.getElementById('sss-highlight-style')) return
      const style = document.createElement('style')
      style.id = 'sss-highlight-style'
      style.textContent =
        `::highlight(${HIGHLIGHT}){background-color:rgba(255,198,46,.65);color:inherit}` +
        '.sss-toast{position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:2147483000;' +
        'background:var(--dsw-alias-tooltip-bg);color:var(--dsw-alias-tooltip-label);' +
        'padding:8px 14px;border-radius:10px;font-size:13px;line-height:1.5;box-shadow:0 6px 24px rgba(0,0,0,.24)}'
      document.head.appendChild(style)
    }

    /** 去掉空白和 markdown 控制符，返回扁平串和每个字符在原文里的下标。 */
    function flatten(text) {
      const source = String(text || '')
      let out = ''
      const map = []
      for (let i = 0; i < source.length; i += 1) {
        const ch = source[i]
        if (/\s/.test(ch) || FLAT_DROP.has(ch)) continue
        out += ch
        map.push(i)
      }
      return { text: out, map }
    }

    /** 把渲染后的对话原文拼起来，再压成扁平串；同时记住每个文本节点的起点。 */
    function collectText(root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null)
      const nodes = []
      const offsets = []
      let raw = ''
      let node
      while ((node = walker.nextNode())) {
        const text = node.nodeValue
        if (!text) continue
        nodes.push(node)
        offsets.push(raw.length)
        raw += text
      }
      const flat = flatten(raw)
      return { raw, nodes, offsets, flat: flat.text, map: flat.map }
    }

    /** 原文下标 → 它落在哪个文本节点、节点内第几个字。 */
    function nodeAt(haystack, rawIndex) {
      const { offsets, nodes } = haystack
      if (!nodes.length || rawIndex < 0) return null
      let lo = 0
      let hi = offsets.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (offsets[mid] <= rawIndex) lo = mid
        else hi = mid - 1
      }
      const node = nodes[lo]
      return { node, offset: Math.min(rawIndex - offsets[lo], node.nodeValue.length) }
    }

    function rangeAt(haystack, start, end) {
      if (start < 0 || end <= start) return null
      const from = nodeAt(haystack, haystack.map[start])
      const to = nodeAt(haystack, haystack.map[end - 1])
      if (!from || !to) return null
      const range = document.createRange()
      try {
        range.setStart(from.node, from.offset)
        range.setEnd(to.node, Math.min(to.offset + 1, to.node.nodeValue.length))
      } catch {
        return null
      }
      return range
    }

    /**
     * 在渲染后的对话里找命中的那句话。
     *
     * 命中的候选串是 markdown 原文（anchor），DOM 里已经渲染掉 ** # | 这些符号，
     * 空白也不同，所以两边都压成扁平串再比；由长到短试窗口，最长能对上就用它，
     * 最后才退化成「整页只有一处出现」的关键词。
     */
    function findInText(haystack, job) {
      const query = flatten(job.query || '').text
      const anchor = flatten(job.anchor || '').text
      const at = query && anchor ? anchor.indexOf(query) : -1
      if (at >= 0) {
        for (const radius of [40, 26, 16, 10]) {
          const from = Math.max(0, at - radius)
          const to = Math.min(anchor.length, at + query.length + radius)
          const windowText = anchor.slice(from, to)
          if (windowText.length < query.length + 4) continue
          const found = haystack.flat.indexOf(windowText)
          if (found >= 0) {
            const start = found + (at - from)
            return { start, end: start + query.length }
          }
        }
      }
      if (!query) return null
      const only = haystack.flat.indexOf(query)
      if (only < 0) return null
      // 满屏都是这个词时无法判断是哪一处，宁可不定，也不要高亮错地方
      if (haystack.flat.indexOf(query, only + 1) >= 0) return null
      return { start: only, end: only + query.length }
    }

    function paint(range) {
      if (!window.CSS || !CSS.highlights || typeof Highlight !== 'function') return
      const highlight = new Highlight(range)
      CSS.highlights.set(HIGHLIGHT, highlight)
      window.setTimeout(() => {
        if (CSS.highlights.get(HIGHLIGHT) === highlight) CSS.highlights.delete(HIGHLIGHT)
      }, 6000)
    }

    /**
     * 标题命中时只把会话正文露出来：滚到最新一条，不做文本定位。
     * 正文可能还在渲染，所以隔几帧再补一次。
     */
    function revealBody() {
      let tries = 0
      const timer = window.setInterval(() => {
        tries += 1
        const scrollport = document.querySelector('[data-conversation-scroll]')
        if (scrollport) {
          const atBottom = scrollport.scrollTop + scrollport.clientHeight >= scrollport.scrollHeight - 8
          if (!atBottom) scrollport.scrollTop = scrollport.scrollHeight
          if (tries >= 2) {
            window.clearInterval(timer)
            toast('已打开该会话')
          }
        }
        if (tries > 8) window.clearInterval(timer)
      }, 250)
    }

    /**
     * 打开某个会话并定位到一句话。
     * 目标消息可能还没加载（历史是分页的），所以找不到就滚到顶部触发加载再找。
     */
    function startLocate(job) {
      ensureHighlightStyle()
      const prev = locateJobs.get(job.sessionId)
      if (prev) window.clearInterval(prev)
      let tries = 0
      let lastHeight = 0
      let sameHeight = 0
      let told = false
      const timer = window.setInterval(() => {
        tries += 1
        const scrollport = document.querySelector('[data-conversation-scroll]')
        const shown = canonical(currentSessionId())
        if (!scrollport || (shown && shown !== canonical(job.sessionId))) {
          if (tries > 40) {
            window.clearInterval(timer)
            locateJobs.delete(job.sessionId)
            toast('已切换到该会话（内容还在加载）')
          }
          return
        }
        const haystack = collectText(scrollport)
        const found = findInText(haystack, job)
        if (found) {
          const range = rangeAt(haystack, found.start, found.end)
          if (range) {
            window.clearInterval(timer)
            locateJobs.delete(job.sessionId)
            const rect = range.getBoundingClientRect()
            const box = scrollport.getBoundingClientRect()
            scrollport.scrollTop += rect.top - box.top - box.height / 2 + rect.height / 2
            paint(range)
            toast('已定位到命中的那句话')
            return
          }
        }
        // 没找到：这条多半还在更早的页里，滚到顶部触发分页加载，等下一轮再找
        if (tries >= 2) {
          if (scrollport.scrollHeight === lastHeight) sameHeight += 1
          else sameHeight = 0
          lastHeight = scrollport.scrollHeight
          scrollport.scrollTop = 0
          if (!told && tries >= 5) {
            told = true
            toast('正在加载更早的消息…')
          }
        }
        if (sameHeight >= 8 || tries > 40) {
          window.clearInterval(timer)
          locateJobs.delete(job.sessionId)
          toast('这条消息还没加载出来，往上翻几屏再点一次')
        }
      }, 700)
      locateJobs.set(job.sessionId, timer)
    }

    const ctxRef = React.createRef()

    /* ------------------------------------------------------------------ *
     * 图标
     * ------------------------------------------------------------------ */

    function Icon(props) {
      const size = props.size || 15
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        props.name === 'search'
          ? [h('circle', { key: 'c', cx: 7, cy: 7, r: 4.3 }), h('path', { key: 'l', d: 'M10.2 10.2 14 14' })]
          : null,
      )
    }

    /* ------------------------------------------------------------------ *
     * 高亮
     * ------------------------------------------------------------------ */

    /**
     * 模型族：同一家的模型共用一个色相。
     * 可用的语义色只有五六种，十几个模型必然撞色，按族分配比按模型名更稳定。
     */
    function modelFamily(model) {
      const value = String(model || '').toLowerCase()
      if (!value) return ''
      if (value.includes('deepseek')) return 'deepseek'
      if (value.includes('minimax')) return 'minimax'
      if (value.includes('spark')) return 'spark'
      if (value.includes('gpt') || value.includes('openai') || value.includes('o1-') || value.includes('o3-')) return 'openai'
      if (value.includes('doubao')) return 'doubao'
      return 'other'
    }

    /** 助手标签上显示的模型名：`deepseek-v4.1-flash` → `v4.1-flash`。 */
    function modelLabel(model) {
      const value = String(model || '').trim()
      if (!value) return TYPE_LABEL.assistant
      const short = value.replace(/^deepseek[-_]?/i, '')
      return short || value
    }

    function highlight(text, query) {
      if (!query) return [text]
      const lower = text.toLowerCase()
      const needle = query.toLowerCase()
      const at = lower.indexOf(needle)
      if (at < 0) return [text]
      return [
        text.slice(0, at),
        h('mark', { key: 'm' }, text.slice(at, at + query.length)),
        text.slice(at + query.length),
      ]
    }

    function timeLabel(ms) {
      if (!ms) return ''
      const d = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    const TYPE_LABEL = { user: '用户', assistant: '助手', title: '标题' }

    /** 工作区名：取 cwd 最后一段目录名。 */
    function wsLabel(cwd) {
      if (!cwd) return ''
      const parts = String(cwd).split(/[\\/]/).filter(Boolean)
      return parts.length ? parts[parts.length - 1] : String(cwd)
    }

    /* ------------------------------------------------------------------ *
     * 浮窗
     * ------------------------------------------------------------------ */

    function Panel() {
      const s = useStore()
      const inputRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const [local, setLocal] = React.useState('')

      React.useEffect(() => {
        if (inputRef.current) inputRef.current.focus()
      }, [])

      // 浮层挂在 body 上：主题切亮/切暗时，原生控件（下拉、日期）也要跟着换配色
      React.useEffect(() => {
        if (!s.open) return
        const node = panelRef.current
        syncColorScheme(node)
        if (!document.body || typeof MutationObserver !== 'function') return
        const observer = new MutationObserver(() => syncColorScheme(node))
        observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class'] })
        return () => observer.disconnect()
      }, [s.open])

      // 打开时拉一次「最近会话」和工作区列表，空白页与过滤器都用得到
      React.useEffect(() => {
        if (!s.open) return
        let cancelled = false
        ;(async () => {
          try {
            const status = await (await fetch(`${API}/status`)).json()
            const workspaces = await (await fetch(`${API}/workspaces`)).json()
            if (cancelled) return
            set({
              recentSessions: (status && status.recent) || [],
              workspaces: (workspaces && workspaces.items) || [],
            })
          } catch {
            /* 拉不到就先空着 */
          }
        })()
        return () => {
          cancelled = true
        }
      }, [s.open])

      React.useEffect(() => {
        if (s.open) set({ recentQueries: readRecent(), shortcut: readShortcut() })
      }, [s.open])

      // 防抖搜索
      React.useEffect(() => {
        if (!s.open) return
        const query = local.trim()
        if (!query) {
          set({ hits: [], total: 0, took: 0, active: 0, error: null })
          return
        }
        let cancelled = false
        const timer = setTimeout(async () => {
          set({ loading: true, error: null })
          try {
            const data = await search(query, s.scope, {
              since: s.since,
              from: s.from,
              to: s.to,
              cwd: s.cwd,
            })
            if (cancelled) return
            if (data.building) {
              set({
                loading: false,
                building: true,
                progress: { done: data.done || 0, total: data.total || 0 },
                hits: [],
                total: 0,
              })
              return
            }
            if (!data.ok) throw new Error(data.error || COPY.failed)
            set({
              loading: false,
              building: false,
              hits: data.hits || [],
              total: data.total || 0,
              took: data.took || 0,
              active: 0,
              recentQueries: data.hits && data.hits.length ? rememberQuery(query) : readRecent(),
            })
          } catch (error) {
            if (!cancelled) set({ loading: false, error: error.message || COPY.failed })
          }
        }, DEBOUNCE_MS)
        return () => {
          cancelled = true
          clearTimeout(timer)
        }
      }, [local, s.open, s.scope, s.refresh, s.since, s.from, s.to, s.cwd])

      // 建索引期间轮询进度
      React.useEffect(() => {
        if (!s.open || !s.building) return
        const timer = setInterval(async () => {
          try {
            const data = await (await fetch(`${API}/status`)).json()
            const finished = s.building && !data.building
            set({
              building: !!data.building,
              progress: { done: data.done || 0, total: data.total || 0 },
              ...(finished ? { refresh: s.refresh + 1 } : {}),
            })
          } catch {
            /* 忽略 */
          }
        }, 800)
        return () => clearInterval(timer)
      }, [s.open, s.building, local])

      const groups = React.useMemo(() => {
        const map = new Map()
        s.hits.forEach((hit, index) => {
          const key = hit.sessionId
          if (!map.has(key)) map.set(key, { id: key, title: hit.title || '未命名会话', cwd: hit.cwd, items: [] })
          map.get(key).items.push({ ...hit, index })
        })
        return [...map.values()]
      }, [s.hits])

      const openHit = async (hit) => {
        if (!hit) return
        set({ open: false })
        const result = await navigateTo(hit)
        if (!result.ok) {
          console.warn('[dsh-session-search] 切换会话失败：', result.reason)
          toast(`没能切到那条会话：${result.reason}`)
          return
        }
        const ready = await waitForSession(hit.sessionId, result.switchedWorkspace ? 5000 : 1600)
        if (!ready) {
          reportDiag({ stage: 'no-switch', sessionId: hit.sessionId, shown: visibleSessionId() })
          toast('会话没打开，先在左侧切到它所在的工作区再试')
          return
        }
        reportDiag({ stage: 'switched', sessionId: hit.sessionId })
        if (hit.type === 'title') {
          // 标题命中没有对应的消息位置：打开会话、停在正文即可，不再做文本定位。
          revealBody()
          return
        }
        startLocate({
          sessionId: hit.sessionId,
          anchor: hit.anchor || hit.snippet || '',
          query: local.trim(),
        })
      }

      /** 没输入关键词时的空白页：最近搜过的词 + 最近打开的会话。 */
      const Blank = () =>
        h(
          'div',
          { className: 'sss-blank' },
          s.recentQueries.length
            ? h(
                'div',
                { className: 'sss-sec' },
                h(
                  'div',
                  { className: 'sss-sec-h' },
                  COPY.recent,
                  h('span', { className: 'sss-flex' }),
                  h(
                    'button',
                    { type: 'button', className: 'sss-link', onClick: () => clearRecent() },
                    COPY.clear,
                  ),
                ),
                h(
                  'div',
                  { className: 'sss-chips' },
                  s.recentQueries.map((item) =>
                    h(
                      'span',
                      { key: item, className: 'sss-chip' },
                      h(
                        'button',
                        { type: 'button', className: 'sss-chip-t', onClick: () => setLocal(item) },
                        item,
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'sss-chip-x',
                          'aria-label': `删除 ${item}`,
                          onClick: () => forgetQuery(item),
                        },
                        '×',
                      ),
                    ),
                  ),
                ),
              )
            : null,
          s.recentSessions.length
            ? h(
                'div',
                { className: 'sss-sec' },
                h('div', { className: 'sss-sec-h' }, COPY.recentSessions),
                s.recentSessions.map((row) =>
                  h(
                    'button',
                    {
                      key: row.sessionId,
                      type: 'button',
                      className: 'sss-row sss-recent',
                      onClick: () =>
                        openHit({
                          sessionId: row.sessionId,
                          title: row.title || '未命名会话',
                          cwd: row.cwd,
                          type: 'title',
                          seq: 0,
                          anchor: '',
                          rel: -1,
                          time: row.time,
                        }),
                    },
                    h('span', { className: 'sss-recent-t' }, row.title || '未命名会话'),
                    row.cwd ? h('span', { className: 'sss-ws', title: row.cwd }, wsLabel(row.cwd)) : null,
                    h('span', { className: 'sss-recent-d' }, timeLabel(row.time)),
                  ),
                ),
              )
            : null,
          s.recentQueries.length || s.recentSessions.length
            ? null
            : h('div', { className: 'sss-empty' }, '试试搜一句台词、一个文件名、一个报错'),
        )

      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          set({ open: false })
          return
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          set({ active: Math.min(s.active + 1, s.hits.length - 1) })
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          set({ active: Math.max(s.active - 1, 0) })
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          openHit(s.hits[s.active])
        }
      }

      const progressText = s.progress.total
        ? `${COPY.building} ${s.progress.done}/${s.progress.total}`
        : COPY.building

      return ReactDOM.createPortal(
        h(
          'div',
          {
            className: 'sss-overlay',
            onMouseDown: (event) => {
              if (event.target === event.currentTarget) set({ open: false })
            },
          },
          h(
            'div',
            { className: 'sss-panel', role: 'dialog', 'aria-label': COPY.title, onKeyDown, ref: panelRef },
            h(
              'div',
              { className: 'sss-head' },
              h('span', { className: 'sss-glyph' }, h(Icon, { name: 'search', size: 18 })),
              h('input', {
                ref: inputRef,
                className: 'sss-input',
                value: local,
                placeholder: COPY.placeholder,
                spellCheck: false,
                onChange: (event) => setLocal(event.target.value),
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'sss-kbd',
                  title: COPY.shortcutTip,
                  'data-capturing': s.capturing ? 'true' : 'false',
                  onClick: () => set({ capturing: !s.capturing }),
                },
                s.capturing ? COPY.pressKey : shortcutLabel(s.shortcut),
              ),
            ),
            h(
              'div',
              { className: 'sss-meta' },
              h(
                'span',
                { className: 'sss-scope' },
                h(
                  'button',
                  {
                    type: 'button',
                    'aria-pressed': s.scope === 'all',
                    onClick: () => set({ scope: 'all' }),
                  },
                  COPY.all,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    'aria-pressed': s.scope === 'this',
                    onClick: () => set({ scope: 'this' }),
                  },
                  COPY.this,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    'aria-pressed': s.scope === 'title',
                    onClick: () => set({ scope: 'title' }),
                  },
                  COPY.titleOnly,
                ),
              ),
              h(
                'span',
                { className: 'sss-flex' },
                s.building
                  ? progressText
                  : s.loading
                    ? '搜索中…'
                    : s.total
                      ? `${s.total} 条 · ${s.took}ms`
                      : '',
              ),
            ),
            h(
              'div',
              { className: 'sss-filters' },
              h(
                'select',
                {
                  className: 'sss-select',
                  value: s.since,
                  'aria-label': '时间范围',
                  onChange: (event) => set({ since: event.target.value }),
                },
                TIME_PRESETS.map((preset) =>
                  h('option', { key: preset.key, value: preset.key }, COPY[preset.label]),
                ),
              ),
              s.since === 'custom'
                ? h(
                    'span',
                    { className: 'sss-dates' },
                    h('input', {
                      type: 'date',
                      value: s.from,
                      'aria-label': '起始日期',
                      onChange: (event) => set({ from: event.target.value }),
                    }),
                    COPY.to,
                    h('input', {
                      type: 'date',
                      value: s.to,
                      'aria-label': '结束日期',
                      onChange: (event) => set({ to: event.target.value }),
                    }),
                  )
                : null,
              h(
                'select',
                {
                  className: 'sss-select',
                  value: s.cwd,
                  'aria-label': '工作区',
                  onChange: (event) => set({ cwd: event.target.value }),
                },
                h('option', { key: '', value: '' }, COPY.allWorkspace),
                s.workspaces.map((item) =>
                  h(
                    'option',
                    { key: item.cwd, value: contextPath(item.cwd) },
                    `${wsLabel(item.cwd)}（${item.count}）`,
                  ),
                ),
              ),
            ),
            h(
              'div',
              { className: 'sss-scroll' },
              s.error
                ? h('div', { className: 'sss-empty' }, `${COPY.failed}：${s.error}`)
                : groups.length === 0
                  ? local.trim()
                    ? h('div', { className: 'sss-empty' }, COPY.empty)
                    : Blank()
                  : groups.map((group) =>
                      h(
                        React.Fragment,
                        { key: group.id },
                        h(
                          'div',
                          { className: 'sss-group' },
                          h('b', { title: group.title || '未命名会话' }, group.title || '未命名会话'),
                          group.cwd
                            ? h('span', { className: 'sss-ws', title: group.cwd }, wsLabel(group.cwd))
                            : null,
                          h('span', { className: 'sss-count' }, `${group.items.length} 条`),
                        ),
                        h('div', { className: 'sss-items' }, group.items.map((hit) =>
                          h(
                            'button',
                            {
                              key: `${hit.sessionId}:${hit.seq}:${hit.offset}:${hit.index}`,
                              type: 'button',
                              className: 'sss-row',
                              'data-active': hit.index === s.active,
                              onMouseEnter: () => set({ active: hit.index }),
                              onClick: () => openHit(hit),
                            },
                            h(
                              'div',
                              { className: 'sss-line' },
                              h(
                                'span',
                                {
                                  className: 'sss-tag',
                                  'data-kind': hit.type,
                                  'data-mc': hit.type === 'assistant' ? modelFamily(hit.model) : undefined,
                                  title:
                                    hit.type === 'assistant' && hit.model
                                      ? `由 ${hit.model} 回答`
                                      : TYPE_LABEL[hit.type] || hit.type,
                                },
                                hit.type === 'assistant' ? modelLabel(hit.model) : TYPE_LABEL[hit.type] || hit.type,
                              ),
                              h('span', null, timeLabel(hit.time)),
                              hit.seq ? h('span', null, `第 ${hit.seq} 条消息`) : null,
                            ),
                            h('div', { className: 'sss-snippet' }, highlight(hit.snippet || '', local.trim())),
                          ),
                        )),
                      ),
                    ),
            ),
            h(
              'div',
              { className: 'sss-foot' },
              h('span', null, COPY.hint),
              h(
                'span',
                { className: 'sss-flex' },
                s.scope === 'this' ? COPY.this : s.scope === 'title' ? COPY.titleOnly : COPY.all,
              ),
            ),
          ),
        ),
        document.body,
      )
    }

    /* ------------------------------------------------------------------ *
     * 头部按钮 + 快捷键
     * ------------------------------------------------------------------ */

    function SearchWidget() {
      const s = useStore()
      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            type: 'button',
            className: 'sss-btn',
            title: COPY.button,
            'aria-label': COPY.button,
            onClick: () => set({ open: !s.open }),
          },
          h(Icon, { name: 'search', size: 15 }),
        ),
        s.open ? h(Panel, null) : null,
      )
    }

    function inEditor(target) {
      if (!target || !target.closest) return false
      // 只让代码编辑器保留 Ctrl+F；对话输入框里按 Ctrl+F 仍然要打开浮窗
      return !!target.closest('.cm-editor,.cm-content,.monaco-editor,[data-dsh-editor]')
    }

    function onKeyDown(event) {
      // 录制模式：这一下按键就是新快捷键，不再触发打开/关闭
      if (state.capturing) {
        event.preventDefault()
        event.stopPropagation()
        if (event.key === 'Escape') {
          set({ capturing: false })
          return
        }
        const combo = comboOf(event)
        if (combo) saveShortcut(combo)
        return
      }
      if (comboOf(event) === state.shortcut && !inEditor(event.target)) {
        event.preventDefault()
        event.stopPropagation()
        set({ open: !state.open })
        return
      }
      if (event.key === 'Escape' && state.open) {
        event.preventDefault()
        event.stopPropagation()
        set({ open: false })
      }
    }

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS_TEXT
      document.head.appendChild(style)
    }

    function apply(ctx) {
      ctxRef.current = ctx
      ensureStyle()
      if (typeof document !== 'undefined') {
        document.addEventListener('keydown', onKeyDown, true)
      }
      ctx.slots.inject(SLOT, () =>
        ctx.slots.register({ name: SLOT, id: SLOT_ID, order: 32, label: () => COPY.button }, SearchWidget),
      )
    }

    return { inject: ['slots'], apply }
  },
})
