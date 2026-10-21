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
    var ICON_SVG = __STICKY_ICON_JSON__;

    var pageHtml = null;
    function basePage() {
      if (pageHtml) return pageHtml;
      var bytes = Uint8Array.from(atob(PAGE_B64), function (ch) { return ch.charCodeAt(0); });
      pageHtml = new TextDecoder('utf-8').decode(bytes);
      return pageHtml;
    }

    function escapeInline(value) {
      return JSON.stringify(value).replace(/</g, '\\u003c');
    }

    function embed(snapshot, hostMode) {
      var boot = '<script>window.__SCHEDULE_HOST_MODE__=' + (hostMode ? 'true' : 'false')
        + ';window.__SCHEDULE_HOST_SNAPSHOT__=' + (snapshot ? escapeInline(snapshot) : 'null')
        + ';</' + 'script>';
      return basePage().replace('<script>', boot + '<script>');
    }

    var CSS = [
      '.cys-panel{position:relative;flex:1 1 auto;min-width:0;min-height:0;height:100%;overflow:hidden;background:#f1e7d4;}',
      // One sizing path: absolute + explicit width/height. The macOS top
      // clearance must be *subtracted* from the height. Previously the frame
      // was pushed down 48px while still asking for height:100%, so it ran
      // past the panel by 48px and the overflow clip cut the page's dock.
      '.cys-frame{position:absolute;inset:0;display:block;width:100%;height:100%;border:0;background:#f2ead9;}',
      'html[data-platform="darwin"] .cys-frame{top:var(--dsh-frame-top-clearance,48px);height:calc(100% - var(--dsh-frame-top-clearance,48px));}',
      '.cys-loading{position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:#5f6157;background:#f4ecdd;font-family:"PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;}',
      '.cys-loading__mark{display:grid;width:42px;height:42px;place-items:center;border:1px solid rgba(155,83,58,.45);border-radius:50%;color:#9b533a;font-family:serif;font-size:17px;}',
      '.cys-loading__sub{color:#8b816d;font-size:12px;}',
      '.cys-error{position:absolute;inset:0;z-index:3;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;color:#5f6157;background:#f4ecdd;font-family:"PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;text-align:center;}',
      '.cys-btn{min-height:34px;padding:6px 16px;border:1px solid rgba(155,83,58,.45);border-radius:3px;color:#9b533a;background:#fbf4e6;font:inherit;cursor:pointer;}',
      '.cys-btn:hover{background:#fffaf1;}',
      '.cys-sidebar-icon{display:inline-flex;align-items:center;justify-content:center;width:100%;height:100%;}',
      '.cys-sidebar-icon svg{display:block;width:100%;height:100%;overflow:visible;}',
      '.cys-host-note{position:absolute;right:10px;bottom:10px;z-index:4;padding:3px 8px;border:1px solid rgba(155,83,58,.3);border-radius:999px;color:#8b5a44;background:rgba(251,244,230,.9);font:11px/1.4 "PingFang SC","Microsoft YaHei",sans-serif;pointer-events:none;}',
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

    /* ---------- prompt library: data + composer entry ---------- */

    /* One in-memory copy per page. The desk page is the only writer; this half
       only reads the snapshot, so there is no second source of truth. */
    var promptCache = { items: null, savedAt: 0, inflight: null };

    /* @prompt-model-begin */
    function normalizePrompts(snapshot) {
      if (!snapshot || !Array.isArray(snapshot.prompts)) return [];
      return snapshot.prompts.filter(function (item) {
        return item && typeof item.id === 'string' && typeof item.body === 'string';
      }).map(function (item) {
        return {
          id: item.id,
          title: typeof item.title === 'string' && item.title ? item.title : '未命名提示词',
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

    function loadPrompts() {
      if (promptCache.inflight) return promptCache.inflight;
      promptCache.inflight = hostFetch('GET').then(function (response) {
        if (!response.ok) throw new Error('workspace ' + response.status);
        return response.json();
      }).then(function (data) {
        if (!data || data.ok !== true) throw new Error('workspace unavailable');
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

      var refresh = React.useCallback(function () {
        setStatus(function (prev) { return promptCache.items ? prev : 'loading'; });
        loadPrompts().then(function (next) {
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
        refresh();
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
          setNotice('这条提示词还没有正文。');
          return;
        }
        var result = applyPrompt(inputActions, body);
        if (!result.ok) {
          setNotice(result.reason === 'empty'
            ? '这条提示词还没有正文。'
            : (result.reason === 'unavailable' ? '输入框还没准备好，稍后再试。' : '输入框正在发送，稍后再试。'));
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

      var label = '提示词';
      var body = null;
      if (status === 'loading') {
        body = React.createElement('div', { className: 'cys-prompt-pop__hint' }, '正在读取提示词…');
      } else if (status === 'error') {
        body = React.createElement('div', { className: 'cys-prompt-pop__hint' },
          '读取提示词失败，',
          React.createElement('button', {
            type: 'button',
            className: 'cys-prompt-pop__link',
            onClick: function () { refresh(); },
          }, '重试'));
      } else if (!items.length) {
        body = React.createElement('div', { className: 'cys-prompt-pop__hint' },
          '还没有提示词。先在便签的「提示词」里写几条。');
      } else {
        body = React.createElement('ul', {
          className: 'cys-prompt-pop__list',
          ref: listRef,
          role: 'listbox',
          tabIndex: -1,
          'aria-label': '提示词列表',
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
                item.title,
                item.pinned ? React.createElement('span', { className: 'cys-prompt-pop__pin', 'aria-label': '已置顶' }, '置顶') : null),
              React.createElement('span', { className: 'cys-prompt-pop__body' }, item.body)));
        }));
      }

      var panel = open ? React.createElement('div', {
        className: 'cys-prompt-pop',
        ref: panelRef,
        role: 'dialog',
        'aria-label': '提示词',
        style: pos || { visibility: 'hidden' },
        onMouseDown: function (event) { event.preventDefault(); },
      },
        React.createElement('div', { className: 'cys-prompt-pop__head' },
          React.createElement('span', null, items.length ? '提示词 · ' + items.length + ' 条' : '提示词'),
          React.createElement('span', null, '↑↓ 选择 · Enter 填入 · Esc 关闭')),
        notice ? React.createElement('div', { className: 'cys-prompt-pop__hint' }, notice) : null,
        body,
        React.createElement('div', { className: 'cys-prompt-pop__foot' },
          React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' } }, '只填入草稿，不会发送'),
          React.createElement('button', {
            type: 'button',
            className: 'cys-prompt-pop__link',
            onClick: function () { close(); openDesk('prompts'); },
          }, '在便签里管理 ↗'))) : null;

      return React.createElement('span', { className: 'cys-prompt-root', ref: rootRef },
        React.createElement('button', {
          type: 'button',
          className: 'cys-prompt-btn',
          'aria-haspopup': 'dialog',
          'aria-expanded': open ? 'true' : 'false',
          title: '把常用提示词填进输入框',
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
      var [hostError, setHostError] = React.useState(false);

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
          onMessage: null,
        };
        stateRef.current = bridge;
        deskApi = {
          selectPanel: panelSelector,
          frame: function () { return bridge.iframe; },
        };
        var host = hostRef.current;
        if (!host) return;

        function setPhase(next) {
          statusRef.current = next;
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
          }).catch(function () {
            showHostError(true);
            bridge.attempts += 1;
            if (bridge.disposed || bridge.attempts > 2) return;
            bridge.pending = snapshot;
            bridge.timer = setTimeout(function () { flush(false); }, 1500 * bridge.attempts);
          });
        }

        function queueSave(snapshot) {
          if (!bridge.hostMode || !snapshot) return;
          bridge.pending = snapshot;
          if (bridge.timer) return;
          bridge.timer = setTimeout(function () { flush(false); }, 180);
        }

        function createFrame(snapshot) {
          if (bridge.iframe) {
            bridge.iframe.remove();
            bridge.iframe = null;
          }
          setPhase('loading');
          var iframe = document.createElement('iframe');
          iframe.className = 'cys-frame';
          iframe.title = '便签';
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
              }).catch(function () { showHostError(true); });
            } else if (snapshot) {
              bridge.lastBody = JSON.stringify({ snapshot: snapshot });
              hostFetch('POST', { snapshot: snapshot }).then(function (response) {
                if (!response.ok) showHostError(true);
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
            if (!bridge.hostMode || !frame || !frame.contentWindow) {
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

        hostFetch('GET').then(function (response) {
          if (!response.ok) throw new Error('host workspace unavailable: ' + response.status);
          return response.json();
        }).then(function (data) {
          if (!data || data.ok !== true) throw new Error('host workspace unavailable');
          finish({ ok: true, snapshot: data.snapshot || null });
        }).catch(function () {
          finish({ ok: false, snapshot: null });
        });

        return function () {
          bridge.disposed = true;
          if (bridge.timer) clearTimeout(bridge.timer);
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
        status === 'loading' ? React.createElement('div', { className: 'cys-loading' },
          React.createElement('span', { className: 'cys-loading__mark', 'aria-hidden': 'true' }, '屿'),
          React.createElement('span', null, '正在打开纸屿…'),
          React.createElement('span', { className: 'cys-loading__sub' }, '内容会自动保存')
        ) : null,
        hostError ? React.createElement('span', { className: 'cys-host-note' }, '本地缓存 · 同步失败') : null
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
        ctx.inject(['layout'], function (scope) {
          var layout = scope.layout;
          if (layout && typeof layout.selectPanel === 'function') {
            panelSelector = function (id) { return layout.selectPanel(id); };
          }
        });
        ctx.effect(function () {
          return ctx.locale.register(NS, {
            zh: { panel: '便签' },
            en: { panel: 'Sticky' },
          });
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
