/**
 * Client half of dsh-plugin-control-your-schedule.
 * The paper desk is mounted in an isolated same-origin iframe so its own CSS,
 * window manager and autosave keep working without React rewrites.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-control-your-schedule',
  factory(require) {
    'use strict';

    var React = require('react');
    var NS = 'dsh-plugin-control-your-schedule';
    var PANEL_ID = 'paper-os';
    var ROUTE = '/api/control-your-schedule/workspace';
    var PREFIX = 'dsh-plugin-control-your-schedule:';
    var VERSION = '__VERSION__';
    var PAGE_B64 = '__PAGE_B64__';
    /* The English desk is a build-time variant of the same source page (see
       output/_probe/i18n/CONTRACT.md). build_page.py injects its base64; nothing
       here translates the page at runtime. */
    var PAGE_B64_EN = '__PAGE_B64_EN__';
    var ICON_SVG = __STICKY_ICON_JSON__;

    var pageHtml = { zh: null, en: null };
    function basePage(lang) {
      var key = lang === 'en' ? 'en' : 'zh';
      if (pageHtml[key]) return pageHtml[key];
      var code = key === 'en' ? PAGE_B64_EN : PAGE_B64;
      var bytes;
      try {
        bytes = Uint8Array.from(atob(code), function (ch) { return ch.charCodeAt(0); });
      } catch (err) {
        /* A missing variant has to break loudly: quietly serving the Chinese
           page to an English host would look like a half-finished translation. */
        throw new Error('paper page variant "' + key + '" is missing; rebuild with tools/build_page.py');
      }
      pageHtml[key] = new TextDecoder('utf-8').decode(bytes);
      return pageHtml[key];
    }

    /* @shell-theme-begin */
    /* Host language, shared with the panel and the composer entry. The desk page
       is built per language; this only decides which variant gets loaded. */
    var localeHost = 'zh';

    function normalizeLang(value) {
      var text = String(value == null ? '' : value).trim().toLowerCase();
      if (!text) return null;
      if (text === 'zh' || text.indexOf('zh-') === 0 || text.indexOf('zh_') === 0) return 'zh';
      if (text === 'en' || text.indexOf('en-') === 0 || text.indexOf('en_') === 0) return 'en';
      return null;
    }

    /* prefs.lang wins (the user picked a language inside the desk); otherwise the
       host decides. An unrecognised host language stays on Chinese. */
    function resolveLang(snapshot) {
      var prefs = snapshot && snapshot.prefs;
      return normalizeLang(prefs && prefs.lang) || localeHost;
    }

    /* First-frame theme. The page hides its own content until body.os-ready
       (.os stays at opacity 0), so the only thing that can flash is the page's
       own background before boot. If <html data-theme> is already right when the
       srcdoc lands, there is nothing to flash.
       Order: snapshot prefs light/dark -> host body[data-ds-dark-theme] -> light. */
    function hostPrefersDark() {
      try {
        return !!(document.body && document.body.hasAttribute('data-ds-dark-theme'));
      } catch (err) {
        return false;
      }
    }

    function firstFrameTheme(snapshot) {
      var prefs = snapshot && snapshot.prefs;
      var wanted = prefs && prefs.theme;
      if (wanted === 'light' || wanted === 'dark') return wanted;
      return hostPrefersDark() ? 'dark' : 'light';
    }

    /* macOS puts the window traffic lights above the panel: DSH publishes the
       reserved height as --dsh-frame-top-clearance on html[data-platform=darwin].
       The frame is inset:0 now, so the value travels into the page as
       --cys-top-clearance and the page's own top bar paints that strip. */
    function hostIsDarwin() {
      try {
        return document.documentElement.getAttribute('data-platform') === 'darwin';
      } catch (err) {
        return false;
      }
    }

    function hostTopClearance() {
      if (!hostIsDarwin()) return '';
      try {
        var raw = getComputedStyle(document.documentElement).getPropertyValue('--dsh-frame-top-clearance');
        var value = String(raw || '').trim();
        return /^\d+(?:\.\d+)?px$/.test(value) ? value : '';
      } catch (err) {
        return '';
      }
    }

    function escapeInline(value) {
      return JSON.stringify(value).replace(/</g, '\\u003c');
    }

    function firstFramePage(page, theme, clearance) {
      return page.replace(/<html\b([^>]*)>/i, function (match, attrs) {
        var next = String(attrs).replace(/\sdata-theme="[^"]*"/i, '').replace(/\sstyle="[^"]*"/i, '');
        var style = clearance ? ' style="--cys-top-clearance:' + clearance + '"' : '';
        return '<html' + next + ' data-theme="' + theme + '"' + style + '>';
      });
    }

    function embed(snapshot, hostMode) {
      var lang = resolveLang(snapshot);
      /* The language goes last so the host mode/snapshot payload keeps its place
         at the front of the document (the page reads it on first script run). */
      var boot = '<script>window.__SCHEDULE_HOST_MODE__=' + (hostMode ? 'true' : 'false')
        + ';window.__SCHEDULE_HOST_SNAPSHOT__=' + (snapshot ? escapeInline(snapshot) : 'null')
        + ';window.__SCHEDULE_LANG__=' + escapeInline(lang)
        + ';</' + 'script>';
      var page = firstFramePage(basePage(lang), firstFrameTheme(snapshot), hostTopClearance());
      return page.replace('<script>', boot + '<script>');
    }
    /* @shell-theme-end */

    /* ---------- language: one dictionary, one resolved language ---------- */

    /* Every user-visible string of the shell lives here exactly once. The
       composer entry and the panel render through textFor(uiLang, ...), and the
       host locale service is handed this same object for its own lookups. */
    /* @dictionary-begin */
    var DICTIONARY = {
      zh: {
        panel: '便签',
        'panel.frameTitle': '便签',
        'panel.opening': '正在打开纸屿…',
        'panel.autosave': '内容会自动保存',
        'panel.hostNote': '本地缓存 · 同步失败',
        'prompt.title': '提示词',
        'prompt.buttonTitle': '把常用提示词填进输入框',
        'prompt.listLabel': '提示词列表',
        'prompt.count': '提示词 · {n} 条',
        'prompt.keys': '↑↓ 选择 · Enter 填入 · Esc 关闭',
        'prompt.loading': '正在读取提示词…',
        'prompt.error': '读取提示词失败，',
        'prompt.retry': '重试',
        'prompt.empty': '还没有提示词。先在便签的「提示词」里写几条。',
        'prompt.untitled': '未命名提示词',
        'prompt.pinnedLabel': '已置顶',
        'prompt.pin': '置顶',
        'prompt.draftOnly': '只填入草稿，不会发送',
        'prompt.manage': '在便签里管理 ↗',
        'prompt.emptyBody': '这条提示词还没有正文。',
        'prompt.notReady': '输入框还没准备好，稍后再试。',
        'prompt.busy': '输入框正在发送，稍后再试。',
      },
      en: {
        panel: 'Sticky',
        'panel.frameTitle': 'Sticky notes',
        'panel.opening': 'Opening Paper Isle…',
        'panel.autosave': 'Your work saves automatically',
        'panel.hostNote': 'Local copy · sync failed',
        'prompt.title': 'Prompts',
        'prompt.buttonTitle': 'Insert a saved prompt into the composer',
        'prompt.listLabel': 'Prompt list',
        'prompt.count': 'Prompts · {n}',
        'prompt.keys': '↑↓ to choose · Enter to insert · Esc to close',
        'prompt.loading': 'Reading prompts…',
        'prompt.error': 'Could not read prompts. ',
        'prompt.retry': 'Retry',
        'prompt.empty': 'No prompts yet. Add a few in the desk under Prompts.',
        'prompt.untitled': 'Untitled prompt',
        'prompt.pinnedLabel': 'Pinned',
        'prompt.pin': 'Pinned',
        'prompt.draftOnly': 'Fills the draft only. It is not sent.',
        'prompt.manage': 'Manage in the desk ↗',
        'prompt.emptyBody': 'This prompt has no text yet.',
        'prompt.notReady': 'The composer is not ready yet. Try again in a moment.',
        'prompt.busy': 'The composer is sending. Try again in a moment.',
      },
    };

    /* Same {name} interpolation the host t() uses, but keyed by an explicit
       language: the shell follows the plugin's resolved language, which can
       differ from the host locale (host English, desk pinned to Chinese). */
    function textFor(lang, key, params) {
      var table = DICTIONARY[lang === 'en' ? 'en' : 'zh'];
      var template = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key;
      if (!params) return template;
      return String(template).replace(/\{(\w+)\}/g, function (match, name) {
        return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
      });
    }
    /* @dictionary-end */

    /* uiLang is what the shell's own chrome renders in: prefs.lang once the user
       pinned one inside the desk, otherwise the host locale. latestSnapshot is
       the newest workspace state any surface has seen; before it arrives the
       host locale decides, which is the boundary the composer entry lives with. */
    var uiLang = 'zh';
    var latestSnapshot = null;
    var uiLangListeners = [];

    function onUiLang(listener) {
      uiLangListeners.push(listener);
      return function () {
        var index = uiLangListeners.indexOf(listener);
        if (index !== -1) uiLangListeners.splice(index, 1);
      };
    }

    function refreshUiLang() {
      var next = resolveLang(latestSnapshot);
      if (next === uiLang) return;
      uiLang = next;
      uiLangListeners.slice().forEach(function (listener) {
        try { listener(next); } catch (err) { /* one listener must not starve the rest */ }
      });
    }

    /* One entry point for "a newer workspace snapshot arrived". */
    function publishSnapshot(snapshot) {
      latestSnapshot = snapshot || null;
      refreshUiLang();
    }

    function publishHostLang(next) {
      if (!next || next === localeHost) return;
      localeHost = next;
      refreshUiLang();
    }

    function readHostLang(ctx) {
      try {
        var api = ctx && ctx.locale;
        if (!api || typeof api.getLocale !== 'function') return null;
        return normalizeLang(api.getLocale().active);
      } catch (err) {
        return null;
      }
    }

    var CSS = [
      '.cys-panel{position:relative;flex:1 1 auto;min-width:0;min-height:0;height:100%;overflow:hidden;background:transparent;}',
      // One sizing path: the frame always fills the panel. The macOS 48px window
      // clearance is no longer subtracted from the frame (pushing it down while it
      // still asked for height:100% overflowed the panel and the clip ate the dock).
      // It travels into the page as --cys-top-clearance instead, so the page's own
      // top bar paints that strip and the shell never shows a bare warm band.
      '.cys-frame{position:absolute;inset:0;display:block;width:100%;height:100%;border:0;background:transparent;}',
      '.cys-loading{position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--dsw-alias-label-secondary,#61666b);background:var(--dsw-alias-bg-base,transparent);font-family:"PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;}',
      '.cys-loading__mark{display:grid;width:42px;height:42px;place-items:center;border:1px solid var(--dsw-alias-border-l3,rgba(120,120,120,.36));border-radius:50%;color:var(--dsw-alias-label-tertiary,#8a8f98);font-family:serif;font-size:17px;}',
      '.cys-loading__sub{color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:12px;}',
      '.cys-error{position:absolute;inset:0;z-index:3;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;color:var(--dsw-alias-label-secondary,#61666b);background:var(--dsw-alias-bg-base,transparent);font-family:"PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;text-align:center;}',
      '.cys-btn{min-height:34px;padding:6px 16px;border:1px solid var(--dsw-alias-border-l3,rgba(120,120,120,.36));border-radius:3px;color:var(--dsw-alias-label-primary,#222);background:var(--dsw-alias-bg-layer-2,transparent);font:inherit;cursor:pointer;}',
      '.cys-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(120,120,120,.12));}',
      '.cys-sidebar-icon{display:inline-flex;align-items:center;justify-content:center;width:100%;height:100%;}',
      '.cys-sidebar-icon svg{display:block;width:100%;height:100%;overflow:visible;}',
      '.cys-host-note{position:absolute;right:10px;bottom:10px;z-index:4;padding:3px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(120,120,120,.24));border-radius:999px;color:var(--dsw-alias-label-tertiary,#8a8f98);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2,rgba(120,120,120,.08)));font:11px/1.4 "PingFang SC","Microsoft YaHei",sans-serif;pointer-events:none;}',
      // Composer entry: a compact chip that matches the host tool row, plus a
      // fixed-position panel (same pattern the host uses for its own popovers,
      // so the composer card's ancestors cannot clip it).
      '.cys-prompt-root{position:relative;display:inline-flex;flex:none;align-items:center;}',
      '.cys-prompt-btn{display:inline-flex;height:24px;align-items:center;gap:4px;padding:0 7px;border:0;border-radius:var(--dsw-radius-sm,4px);color:var(--dsw-alias-label-tertiary);background:transparent;font-family:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;cursor:pointer;white-space:nowrap;}',
      '.cys-prompt-btn:hover,.cys-prompt-btn[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);}',
      '.cys-prompt-btn svg{display:block;width:14px;height:14px;flex:none;}',
      '.cys-prompt-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;}',
      '.cys-prompt-pop{position:fixed;z-index:1200;display:flex;width:320px;max-height:340px;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border-l1,rgba(120,120,120,.2));border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-specific-menu,#fff);box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.18));backdrop-filter:var(--dsw-menu-backdrop-filter,none);font-family:inherit;color:var(--dsw-alias-label-primary,#222);}',
      '.cys-prompt-pop__head{display:flex;flex:none;align-items:center;justify-content:space-between;gap:8px;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(120,120,120,.16));color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;}',
      '.cys-prompt-pop__list{margin:0;padding:4px;list-style:none;overflow-y:auto;min-height:0;}',
      '.cys-prompt-pop__item{display:block;width:100%;box-sizing:border-box;padding:7px 9px;border:0;border-radius:var(--dsw-radius-sm,4px);background:transparent;text-align:left;cursor:pointer;color:inherit;font:inherit;}',
      '.cys-prompt-pop__item:hover,.cys-prompt-pop__item[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));}',
      '.cys-prompt-pop__title{display:flex;align-items:center;gap:5px;font-size:13px;font-weight:500;line-height:19px;}',
      '.cys-prompt-pop__pin{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;}',
      '.cys-prompt-pop__body{display:-webkit-box;overflow:hidden;margin-top:1px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px;-webkit-box-orient:vertical;-webkit-line-clamp:2;}',
      '.cys-prompt-pop__foot{display:flex;flex:none;align-items:center;justify-content:space-between;gap:8px;padding:7px 10px;border-top:1px solid var(--dsw-alias-border-l1,rgba(120,120,120,.16));}',
      '.cys-prompt-pop__link{border:0;background:transparent;color:var(--dsw-alias-state-business-primary,#2b6cb0);font:inherit;font-size:12px;line-height:18px;cursor:pointer;padding:2px 4px;border-radius:var(--dsw-radius-sm,4px);}',
      '.cys-prompt-pop__link:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));}',
      '.cys-prompt-pop__hint{padding:14px 12px;color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:19px;text-align:center;}',
    ].join('');

    function ensureStyle() {
      if (document.querySelector('style[data-plugin="' + NS + '"]')) return;
      var style = document.createElement('style');
      style.dataset.plugin = NS;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    function SidebarIcon(props) {
      var size = props && props.size ? props.size : 16;
      return React.createElement('span', {
        className: 'cys-sidebar-icon',
        style: { width: size + 'px', height: size + 'px' },
        'aria-hidden': 'true',
        dangerouslySetInnerHTML: { __html: ICON_SVG },
      });
    }

    function hostFetch(method, body, keepalive) {
      return fetch(ROUTE, {
        method: method,
        credentials: 'same-origin',
        headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        keepalive: !!keepalive,
      });
    }

    /* ---------- host workspace: one read, shared ---------- */

    /* The desk page is the only writer. This half only reads, and it reads
       through one cache: the plugin prefetches on start-up (see apply), so the
       composer entry and the panel both get that same response and opening the
       panel does not pay a second round trip before it can paint. Every write
       that lands invalidates the cache, so a later read is never served stale. */
    var workspaceCache = { data: null, promise: null };

    function loadWorkspace(options) {
      var force = !!(options && options.force);
      if (!force && workspaceCache.data) return Promise.resolve(workspaceCache.data);
      if (workspaceCache.promise) return workspaceCache.promise;
      workspaceCache.promise = hostFetch('GET').then(function (response) {
        if (!response.ok) throw new Error('workspace ' + response.status);
        return response.json();
      }).then(function (data) {
        if (!data || data.ok !== true) throw new Error('workspace unavailable');
        workspaceCache.data = data;
        /* First read fills the shared snapshot (the composer entry resolves its
           language from it); a later read never overwrites a newer live state. */
        if (!latestSnapshot) publishSnapshot(data.snapshot || null);
        return data;
      }).finally(function () {
        workspaceCache.promise = null;
      });
      return workspaceCache.promise;
    }

    function invalidateWorkspace() {
      workspaceCache.data = null;
    }

    /* ---------- prompt library: data + composer entry ---------- */

    /* Composer-side view of the prompt list, derived from the cached workspace. */
    var promptCache = { items: null, savedAt: 0, inflight: null };

    /* @prompt-model-begin */
    function normalizePrompts(snapshot) {
      if (!snapshot || !Array.isArray(snapshot.prompts)) return [];
      return snapshot.prompts.filter(function (item) {
        return item && typeof item.id === 'string' && typeof item.body === 'string';
      }).map(function (item) {
        var title = typeof item.title === 'string' ? item.title : '';
        /* Old versions stored a language-specific title sentinel in the data. The page
           normalizes it on load, but the composer can read a legacy snapshot before
           that save lands, so fold the two known legacy values here as well. */
        if (title === '未命名提示词' || title === 'Untitled prompt') title = '';
        return {
          id: item.id,
          /* An empty title stays empty: the data must never carry a language-specific
             sentinel. untitled is the flag the UI uses to draw a localized placeholder. */
          title: title,
          untitled: !title,
          body: item.body,
          pinned: !!item.pinned,
          updatedAt: Number(item.updatedAt) || 0,
        };
      }).sort(function (a, b) {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.updatedAt - a.updatedAt;
      });
    }

    /* Insert semantics, kept pure so it can be tested without a browser:
       1) caret insertion through the public action face (one undoable edit)
       2) empty/stale draft falls back to whole-draft fill (keeps paragraphs)
       3) a second attempt before giving up, then an honest refusal. */
    function applyPrompt(inputActions, body) {
      if (!inputActions) return { ok: false, reason: 'unavailable' };
      if (typeof body !== 'string' || !body.trim()) return { ok: false, reason: 'empty' };
      var canInsert = typeof inputActions.captureInsertion === 'function' && typeof inputActions.insertText === 'function';
      if (canInsert) {
        try {
          var span = inputActions.captureInsertion();
          if (span && inputActions.insertText(body, span) === true) return { ok: true, via: 'insert' };
        } catch (err) { /* fall through to the draft fallback */ }
      }
      if (typeof inputActions.setDraft === 'function') {
        try {
          inputActions.setDraft(body);
          return { ok: true, via: 'draft' };
        } catch (err2) { /* fall through */ }
      }
      if (canInsert) {
        try {
          var retry = inputActions.captureInsertion();
          if (retry && inputActions.insertText(body, retry) === true) return { ok: true, via: 'retry' };
        } catch (err3) { /* give up below */ }
      }
      return { ok: false, reason: 'busy' };
    }
    /* @prompt-model-end */

    function loadPrompts(options) {
      if (promptCache.inflight) return promptCache.inflight;
      promptCache.inflight = loadWorkspace(options).then(function (data) {
        promptCache.items = normalizePrompts(data.snapshot);
        promptCache.savedAt = Number(data.savedAt) || 0;
        return promptCache.items;
      }).finally(function () {
        promptCache.inflight = null;
      });
      return promptCache.inflight;
    }

    var PROMPT_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2.6h10v7.2L9.4 13.4H3z"/><path d="M12.6 9.8H9.4v3.6"/><path d="M5.2 5.2h5.6M5.2 7.6h3.8"/></svg>';

    function PromptEntry(props) {
      var inputActions = props && props.inputActions;
      var [open, setOpen] = React.useState(false);
      var [items, setItems] = React.useState(promptCache.items || []);
      var [status, setStatus] = React.useState(promptCache.items ? 'ready' : 'loading');
      var [active, setActive] = React.useState(0);
      var [notice, setNotice] = React.useState('');
      var [pos, setPos] = React.useState(null);
      var rootRef = React.useRef(null);
      var panelRef = React.useRef(null);
      var listRef = React.useRef(null);
      var returnFocusRef = React.useRef(null);
      var [, setLangTick] = React.useState(0);

      /* A host language switch does not remount this component, and the template
         function is live, so one render pass is all the translated text needs. */
      React.useEffect(function () {
        return onUiLang(function () { setLangTick(function (value) { return value + 1; }); });
      }, []);

      /* The composer popup always asks for a fresh copy (the desk page may have
         edited a prompt since the cache was filled); the mount-time call rides
         the cache so a plugin start-up prefetch is not wasted. */
      var refresh = React.useCallback(function (force) {
        setStatus(function (prev) { return promptCache.items ? prev : 'loading'; });
        loadPrompts({ force: !!force }).then(function (next) {
          setItems(next);
          setStatus('ready');
          setActive(0);
        }).catch(function () {
          setStatus('error');
        });
      }, []);

      React.useEffect(function () {
        refresh();
      }, [refresh]);

      var close = React.useCallback(function (restoreFocus) {
        setOpen(false);
        setNotice('');
        if (restoreFocus !== false) {
          var previous = returnFocusRef.current;
          returnFocusRef.current = null;
          if (previous && typeof previous.focus === 'function' && document.contains(previous)) {
            try { previous.focus({ preventScroll: true }); } catch (err) { /* focus is best-effort */ }
          }
        }
      }, []);

      var place = React.useCallback(function () {
        var root = rootRef.current;
        if (!root) return;
        var rect = root.getBoundingClientRect();
        var panel = panelRef.current;
        var width = 320;
        var height = panel ? Math.min(panel.offsetHeight || 320, 340) : 320;
        var margin = 8;
        var left = rect.left;
        if (left + width > window.innerWidth - margin) left = window.innerWidth - margin - width;
        if (left < margin) left = margin;
        var above = rect.top - height - margin;
        var top = above >= margin ? above : Math.min(rect.bottom + margin, window.innerHeight - height - margin);
        if (top < margin) top = margin;
        setPos({ left: left + 'px', top: top + 'px' });
      }, []);

      var openPanel = React.useCallback(function () {
        if (open) { close(); return; }
        returnFocusRef.current = document.activeElement;
        setOpen(true);
        setNotice('');
        refresh(true);
        window.requestAnimationFrame(function () {
          place();
          if (listRef.current) listRef.current.focus();
        });
      }, [open, close, refresh, place]);

      React.useEffect(function () {
        if (!open) return undefined;
        function onPointerDown(event) {
          var root = rootRef.current;
          var panel = panelRef.current;
          if (!root || !panel) return;
          if (root.contains(event.target) || panel.contains(event.target)) return;
          close();
        }
        function onKeyDown(event) {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }
        function onResize() { close(false); }
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('resize', onResize);
        return function () {
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown, true);
          window.removeEventListener('resize', onResize);
        };
      }, [open, close]);

      var insert = React.useCallback(function (item) {
        if (!inputActions || !item) return;
        var body = item.body;
        if (!body.trim()) {
          setNotice(textFor(uiLang, 'prompt.emptyBody'));
          return;
        }
        var result = applyPrompt(inputActions, body);
        if (!result.ok) {
          setNotice(result.reason === 'empty'
            ? textFor(uiLang, 'prompt.emptyBody')
            : (result.reason === 'unavailable' ? textFor(uiLang, 'prompt.notReady') : textFor(uiLang, 'prompt.busy')));
          return;
        }
        close();
      }, [inputActions, close]);

      var onListKeyDown = React.useCallback(function (event) {
        if (!items.length) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          var delta = event.key === 'ArrowDown' ? 1 : -1;
          var next = (active + delta + items.length) % items.length;
          setActive(next);
          var node = listRef.current && listRef.current.querySelector('[data-index="' + next + '"]');
          if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
          return;
        }
        if (event.key === 'Home') { event.preventDefault(); setActive(0); return; }
        if (event.key === 'End') { event.preventDefault(); setActive(items.length - 1); return; }
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          insert(items[active]);
        }
      }, [items, active, insert]);

      var label = textFor(uiLang, 'prompt.title');
      var body = null;
      if (status === 'loading') {
        body = React.createElement('div', { className: 'cys-prompt-pop__hint' }, textFor(uiLang, 'prompt.loading'));
      } else if (status === 'error') {
        body = React.createElement('div', { className: 'cys-prompt-pop__hint' },
          textFor(uiLang, 'prompt.error'),
          React.createElement('button', {
            type: 'button',
            className: 'cys-prompt-pop__link',
            onClick: function () { refresh(); },
          }, textFor(uiLang, 'prompt.retry')));
      } else if (!items.length) {
        body = React.createElement('div', { className: 'cys-prompt-pop__hint' },
          textFor(uiLang, 'prompt.empty'));
      } else {
        body = React.createElement('ul', {
          className: 'cys-prompt-pop__list',
          ref: listRef,
          role: 'listbox',
          tabIndex: -1,
          'aria-label': textFor(uiLang, 'prompt.listLabel'),
          onKeyDown: onListKeyDown,
        }, items.slice(0, 8).map(function (item, index) {
          return React.createElement('li', { key: item.id, role: 'none' },
            React.createElement('button', {
              type: 'button',
              role: 'option',
              'aria-selected': index === active ? 'true' : 'false',
              'data-active': index === active ? 'true' : 'false',
              'data-index': String(index),
              className: 'cys-prompt-pop__item',
              onMouseEnter: function () { setActive(index); },
              onClick: function () { insert(item); },
            },
              React.createElement('span', { className: 'cys-prompt-pop__title' },
                item.untitled ? textFor(uiLang, 'prompt.untitled') : item.title,
                item.pinned ? React.createElement('span', { className: 'cys-prompt-pop__pin', 'aria-label': textFor(uiLang, 'prompt.pinnedLabel') }, textFor(uiLang, 'prompt.pin')) : null),
              React.createElement('span', { className: 'cys-prompt-pop__body' }, item.body)));
        }));
      }

      var panel = open ? React.createElement('div', {
        className: 'cys-prompt-pop',
        ref: panelRef,
        role: 'dialog',
        'aria-label': textFor(uiLang, 'prompt.title'),
        style: pos || { visibility: 'hidden' },
        onMouseDown: function (event) { event.preventDefault(); },
      },
        React.createElement('div', { className: 'cys-prompt-pop__head' },
          React.createElement('span', null, items.length ? textFor(uiLang, 'prompt.count', { n: items.length }) : textFor(uiLang, 'prompt.title')),
          React.createElement('span', null, textFor(uiLang, 'prompt.keys'))),
        notice ? React.createElement('div', { className: 'cys-prompt-pop__hint' }, notice) : null,
        body,
        React.createElement('div', { className: 'cys-prompt-pop__foot' },
          React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' } }, textFor(uiLang, 'prompt.draftOnly')),
          React.createElement('button', {
            type: 'button',
            className: 'cys-prompt-pop__link',
            onClick: function () { close(); openDesk('prompts'); },
          }, textFor(uiLang, 'prompt.manage')))) : null;

      return React.createElement('span', { className: 'cys-prompt-root', ref: rootRef },
        React.createElement('button', {
          type: 'button',
          className: 'cys-prompt-btn',
          'aria-haspopup': 'dialog',
          'aria-expanded': open ? 'true' : 'false',
          title: textFor(uiLang, 'prompt.buttonTitle'),
          onClick: openPanel,
          onMouseDown: function (event) { event.preventDefault(); },
          dangerouslySetInnerHTML: { __html: PROMPT_ICON + '<span>' + label + '</span>' },
        }),
        panel);
    }

    /* Deep link into the desk panel: select the panel, then hand the page an
       open-app instruction once its iframe is mounted (see PaperPanel). */
    var pendingApp = null;
    var panelSelector = null;

    function openDesk(appId) {
      pendingApp = appId || null;
      var select = (deskApi && deskApi.selectPanel) || panelSelector;
      if (typeof select === 'function') {
        try { select(PANEL_ID); } catch (err) { /* panel may be unavailable */ }
      }
    }

    var deskApi = null;

    function deliverPendingApp() {
      if (!pendingApp || !deskApi) return;
      var frame = deskApi.frame();
      if (!frame || !frame.contentWindow) return;
      var appId = pendingApp;
      pendingApp = null;
      try {
        frame.contentWindow.postMessage({ type: PREFIX + 'open-app', appId: appId }, '*');
      } catch (err) { /* best effort */ }
    }

    function PaperPanel() {
      var hostRef = React.useRef(null);
      var statusRef = React.useRef('loading');
      var stateRef = React.useRef(null);
      var [status, setStatus] = React.useState('loading');
      var [maskVisible, setMaskVisible] = React.useState(false);
      var [hostError, setHostError] = React.useState(false);
      var [, setLangTick] = React.useState(0);

      React.useEffect(function () {
        var bridge = {
          disposed: false,
          hostMode: false,
          hadSnapshot: false,
          iframe: null,
          timer: 0,
          pending: null,
          lastBody: '',
          attempts: 0,
          maskTimer: 0,
          lang: '',
          onMessage: null,
        };
        stateRef.current = bridge;
        deskApi = {
          selectPanel: panelSelector,
          frame: function () { return bridge.iframe; },
        };
        var host = hostRef.current;
        if (!host) return;

        /* The mask is an apology for a slow paint, not a splash screen. The frame
           is created only after the snapshot arrives and it paints the real page,
           so covering that window from the first frame is what painted a band of
           shell colour on every entry. Show it only when loading really drags. */
        bridge.maskTimer = setTimeout(function () {
          bridge.maskTimer = 0;
          if (bridge.disposed || statusRef.current !== 'loading') return;
          setMaskVisible(true);
        }, 300);

        /* The resolved language changed: swap the desk page variant (or just the
           chrome text when prefs.lang pinned the desk to its current language).
           Ask the page for a final snapshot first: the frame and its document are
           thrown away, so whatever sits inside the page's save debounce goes with
           it. */
        var stopLang = onUiLang(function () {
          setLangTick(function (value) { return value + 1; });
          if (!bridge.iframe) return;
          if (uiLang === bridge.lang) return;
          requestFinalSnapshot(200).then(function () {
            if (bridge.disposed) return;
            createFrame(latestSnapshot);
          });
        });

        function setPhase(next) {
          statusRef.current = next;
          if (next !== 'loading' && bridge.maskTimer) {
            clearTimeout(bridge.maskTimer);
            bridge.maskTimer = 0;
            setMaskVisible(false);
          }
          setStatus(next);
        }

        function showHostError(next) {
          setHostError(!!next);
        }

        function flush(keepalive) {
          if (!bridge.hostMode) return;
          if (bridge.timer) {
            clearTimeout(bridge.timer);
            bridge.timer = 0;
          }
          var snapshot = bridge.pending;
          if (!snapshot) return;
          bridge.pending = null;
          var body = JSON.stringify({ snapshot: snapshot });
          if (body === bridge.lastBody) return;
          bridge.lastBody = body;
          hostFetch('POST', { snapshot: snapshot }, keepalive).then(function (response) {
            if (!response.ok) throw new Error('workspace write failed: ' + response.status);
            bridge.attempts = 0;
            showHostError(false);
            invalidateWorkspace();
          }).catch(function () {
            showHostError(true);
            bridge.attempts += 1;
            if (bridge.disposed || bridge.attempts > 2) return;
            bridge.pending = snapshot;
            bridge.timer = setTimeout(function () { flush(false); }, 1500 * bridge.attempts);
          });
        }

        function queueSave(snapshot) {
          if (!snapshot) return;
          /* Whatever the page last told us is the newest state any surface can
             render from, the composer entry included. */
          publishSnapshot(snapshot);
          if (!bridge.hostMode) return;
          bridge.pending = snapshot;
          if (bridge.timer) return;
          bridge.timer = setTimeout(function () { flush(false); }, 180);
        }

        function createFrame(snapshot) {
          bridge.lang = resolveLang(snapshot);
          publishSnapshot(snapshot);
          if (bridge.iframe) {
            bridge.iframe.remove();
            bridge.iframe = null;
          }
          setPhase('loading');
          var iframe = document.createElement('iframe');
          iframe.className = 'cys-frame';
          iframe.title = textFor(uiLang, 'panel.frameTitle');
          iframe.setAttribute('allow', 'clipboard-read; clipboard-write');
          iframe.addEventListener('load', function () {
            setTimeout(function () {
              if (!bridge.disposed && statusRef.current === 'loading') setPhase('ready');
            }, 5000);
          });
          iframe.srcdoc = embed(snapshot, bridge.hostMode);
          host.appendChild(iframe);
          bridge.iframe = iframe;
        }

        function applyRestart(payload) {
          var cleared = !!(payload && payload.cleared);
          var snapshot = cleared ? null : (payload && payload.snapshot ? payload.snapshot : null);
          if (bridge.hostMode) {
            if (cleared) {
              bridge.pending = null;
              bridge.lastBody = '';
              hostFetch('DELETE').then(function (response) {
                if (!response.ok) showHostError(true);
                else invalidateWorkspace();
              }).catch(function () { showHostError(true); });
            } else if (snapshot) {
              bridge.lastBody = JSON.stringify({ snapshot: snapshot });
              hostFetch('POST', { snapshot: snapshot }).then(function (response) {
                if (!response.ok) showHostError(true);
                else invalidateWorkspace();
              }).catch(function () { showHostError(true); });
            }
          }
          bridge.hadSnapshot = !!snapshot;
          createFrame(snapshot);
        }

        function onMessage(event) {
          if (!bridge.iframe || event.source !== bridge.iframe.contentWindow) return;
          var data = event.data;
          if (!data || typeof data.type !== 'string' || data.type.indexOf(PREFIX) !== 0) return;
          var kind = data.type.slice(PREFIX.length);
          if (kind === 'ready') {
            setPhase('ready');
            if (data.snapshot) publishSnapshot(data.snapshot);
            if (bridge.hostMode && !bridge.hadSnapshot && data.snapshot) queueSave(data.snapshot);
            /* A deep link may have been requested before this frame existed. */
            if (pendingApp) deliverPendingApp();
            return;
          }
          if (kind === 'save') {
            queueSave(data.snapshot);
            return;
          }
          if (kind === 'snapshot') {
            /* 页面在卸载前主动推来的一份最新快照（同步路径）。 */
            if (bridge.finalSnapshotResolver) {
              bridge.finalSnapshotResolver(true);
              bridge.finalSnapshotResolver = null;
            }
            queueSave(data.snapshot);
            return;
          }
          if (kind === 'restart') {
            applyRestart(data);
          }
        }

        /* 卸载时向页面要一份"现在就保存"的快照，并等它回。
           以前这里只 flush 已经排队的快照：页面的 420ms 防抖还没到，
           iframe 就被销毁，那一段操作等于从没发生过。 */
        function requestFinalSnapshot(timeoutMs) {
          return new Promise(function (resolve) {
            var frame = bridge.iframe;
            /* Even without a host (degraded mode) the page in the frame owns the newest
               edits; a language switch rebuilds that frame, so ask it for a snapshot first. */
            if (!frame || !frame.contentWindow) {
              resolve(false);
              return;
            }
            var settled = false;
            var timer = setTimeout(function () {
              if (settled) return;
              settled = true;
              resolve(false);
            }, timeoutMs);
            function settle(value) {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve(value);
            }
            bridge.finalSnapshotResolver = settle;
            try {
              frame.contentWindow.postMessage({ type: PREFIX + 'flush-now' }, '*');
            } catch (error) {
              settle(false);
            }
          });
        }

        bridge.onMessage = onMessage;
        window.addEventListener('message', onMessage);

        function finish(host) {
          if (bridge.disposed) return;
          bridge.hostMode = host.ok;
          bridge.hadSnapshot = !!host.snapshot;
          if (!host.ok) showHostError(true);
          createFrame(host.snapshot || null);
        }

        /* Served from the start-up prefetch when it is already here: that is what
           lets the frame appear as soon as the panel paints. */
        loadWorkspace().then(function (data) {
          finish({ ok: true, snapshot: data.snapshot || null });
        }).catch(function () {
          finish({ ok: false, snapshot: null });
        });

        return function () {
          bridge.disposed = true;
          if (stopLang) stopLang();
          if (bridge.timer) clearTimeout(bridge.timer);
          if (bridge.maskTimer) clearTimeout(bridge.maskTimer);
          window.removeEventListener('message', onMessage);
          /* 先请页面立刻存一次（最多等 200ms），再 flush，最后才拆 iframe。
             顺序不能反：iframe 一拆，页面里的防抖保存就再也没机会送出。 */
          requestFinalSnapshot(200).then(function () {
            if (bridge.hostMode && bridge.pending) flush(true);
            if (bridge.iframe) {
              bridge.iframe.remove();
              bridge.iframe = null;
            }
          }).catch(function () {
            if (bridge.hostMode && bridge.pending) flush(true);
            if (bridge.iframe) {
              bridge.iframe.remove();
              bridge.iframe = null;
            }
          });
        };
      }, []);

      return React.createElement('div', { className: 'cys-panel', ref: hostRef },
        status === 'loading' && maskVisible ? React.createElement('div', { className: 'cys-loading' },
          React.createElement('span', { className: 'cys-loading__mark', 'aria-hidden': 'true' }, '屿'),
          React.createElement('span', null, textFor(uiLang, 'panel.opening')),
          React.createElement('span', { className: 'cys-loading__sub' }, textFor(uiLang, 'panel.autosave'))
        ) : null,
        hostError ? React.createElement('span', { className: 'cys-host-note' }, textFor(uiLang, 'panel.hostNote')) : null
      );
    }

    ensureStyle();

    return {
      name: NS,
      version: VERSION,
      /* layout stays optional on purpose: it is only needed for the "manage in the
         desk" deep link. A hard dependency would take the whole panel (and the
         composer entry) down if that service were ever renamed. */
      inject: ['slots', 'locale'],
      apply(ctx) {
        var t = ctx.locale.bind(NS);
        /* The host locale is the fallback for every desk whose prefs.lang is
           "system"; keep it current so a switch can rebuild the desk page with
           the other variant instead of waiting for the next open. */
        var initialLang = readHostLang(ctx);
        if (initialLang) localeHost = initialLang;
        refreshUiLang();
        ctx.effect(function () {
          if (!ctx.locale || typeof ctx.locale.subscribe !== 'function') return;
          return ctx.locale.subscribe(function () { publishHostLang(readHostLang(ctx)); });
        }, NS + ': host locale');
        /* Prefetch the workspace once at start-up. The panel then paints from
           the cache instead of waiting for its own round trip. A failure is
           not fatal: the panel retries through loadWorkspace() when opened. */
        ctx.effect(function () {
          loadWorkspace().catch(function () { /* the panel asks again on open */ });
        }, NS + ': workspace prefetch');
        ctx.inject(['layout'], function (scope) {
          var layout = scope.layout;
          if (layout && typeof layout.selectPanel === 'function') {
            panelSelector = function (id) { return layout.selectPanel(id); };
          }
        });
        ctx.effect(function () {
          return ctx.locale.register(NS, DICTIONARY);
        }, NS + ': dictionaries');
        ctx.effect(function () {
          return ctx.slots.inject('sidebar.panellist', function () {
            return ctx.slots.register({
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 50,
              label: function () { return t('panel'); },
              locale: NS,
            }, SidebarIcon);
          });
        }, NS + ': sidebar entry');
        ctx.effect(function () {
          return ctx.slots.inject('main', function () {
            return ctx.slots.register({
              name: 'main',
              key: PANEL_ID,
              locale: NS,
            }, PaperPanel);
          });
        }, NS + ': main panel');
        /* The composer entry is registered on its own so a missing desk slot can
           never take it down (and vice versa). */
        ctx.effect(function () {
          return ctx.slots.inject('conversation.input.left', function () {
            return ctx.slots.register({
              name: 'conversation.input.left',
              id: 'prompts',
              order: 20,
              locale: NS,
            }, PromptEntry);
          });
        }, NS + ': composer prompt entry');
      },
    };
  },
});
