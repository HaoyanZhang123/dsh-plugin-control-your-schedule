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
      '.cys-host-note{position:absolute;right:10px;bottom:10px;z-index:4;padding:3px 8px;border:1px solid rgba(155,83,58,.3);border-radius:999px;color:#8b5a44;background:rgba(251,244,230,.9);font:11px/1.4 "PingFang SC","Microsoft YaHei",sans-serif;pointer-events:none;}'
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
            return;
          }
          if (kind === 'save') {
            queueSave(data.snapshot);
            return;
          }
          if (kind === 'restart') {
            applyRestart(data);
          }
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
          if (bridge.hostMode && bridge.pending) flush(true);
          if (bridge.iframe) {
            bridge.iframe.remove();
            bridge.iframe = null;
          }
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
      inject: ['slots', 'locale'],
      apply(ctx) {
        var t = ctx.locale.bind(NS);
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
      },
    };
  },
});
