#!/usr/bin/env node
/**
 * K3 machine acceptance (task-11): sticky ordering data-compat, keyboard reorder,
 * and the 04 §8 boundary states — as assertions, not screenshots.
 *
 * Runs the built client.js page in headless Edge/Chrome through the same CDP
 * skeleton as page_e2e. Default skin = classic; use --skin=modern for the modern
 * pass. Every geometry/colour read waits for the animation gate
 * (document.getAnimations().playState !== 'running') and a stable sample.
 *
 * Reverse audit (07 §4): --mutate=<id> rewrites the decoded page in %TEMP% only.
 *   no-trash-guard       reorderStickies accepts a trashed id      -> invalid-input assertion red
 *   keyboard-no-op       the keyboard reorder call is disabled     -> keyboard assertions red
 *   dock-guard-removed   the dock Ctrl/Cmd guard is deleted        -> dock Ctrl+Alt assertion red
 *   new-sticky-default   new sticky falls back to the 26,26 corner  -> classic new-position assertion red
 *   drag-no-pointer-none the dragged card keeps its own hit target  -> pointer-reorder assertions red
 *   drag-no-user-select   the ordering gesture keeps user-select  -> no-selection assertion red
 *   drag-no-ordering-class the ordering class is never added      -> no-selection assertion red
 *   drag-stuck-ordering  finish() never removes the class         -> cleanup assertion red
 *
 * Exit 0 only when every assertion passes; exit 3 when no browser is available.
 * No third-party dependencies.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
/* 两种布局都要能跑：开发树是 <项目>/plugin/client.js，发布仓把包根当仓库根。
   与 smoke/page_e2e.mjs 同一套写法，避免"发布仓里这套门禁直接报文件不存在"。 */
const CLIENT = [join(ROOT, 'plugin', 'client.js'), join(ROOT, 'client.js')]
  .find((candidate) => existsSync(candidate)) || join(ROOT, 'plugin', 'client.js');
const argOf = (name, fallback) => {
  const found = process.argv.find((one) => one.indexOf('--' + name + '=') === 0);
  return found ? found.slice(name.length + 3) : fallback;
};
const SKIN = argOf('skin', 'classic');
const MUTATE = argOf('mutate', '');
if (SKIN !== 'classic' && SKIN !== 'modern') {
  console.log('FAIL | --skin must be classic or modern, got ' + JSON.stringify(SKIN));
  process.exit(1);
}
const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const BROWSER = CANDIDATES.find((one) => existsSync(one));
if (!BROWSER) { console.log('SKIP | no headless browser found'); process.exit(3); }
if (!existsSync(CLIENT)) { console.log('FAIL | plugin/client.js missing'); process.exit(1); }

const clientText = readFileSync(CLIENT, 'utf8');
const BUILD = {
  sha16: createHash('sha256').update(clientText).digest('hex').slice(0, 16),
  bytes: Buffer.byteLength(clientText),
};
const found = /var PAGE_B64 = '([A-Za-z0-9+/=]+)'/.exec(clientText);
if (!found) { console.log('FAIL | PAGE_B64 not found'); process.exit(1); }
let pageText = Buffer.from(found[1], 'base64').toString('utf8');
const enFound = /var PAGE_B64_EN = '([A-Za-z0-9+/=]+)'/.exec(clientText);
const enText = enFound ? Buffer.from(enFound[1], 'base64').toString('utf8') : '';

const PAGE_MUTATIONS = {
  'no-trash-guard': (text) => text.replace('if (Number(byId[id].trashedAt) > 0) return null;', ''),
  /* 键盘重排整体失效：moveStickyByKeyboard 一进来就返回 false（唯一锚点）。 */
  'keyboard-no-op': (text) => text.replace(
    'function moveStickyByKeyboard(id, delta) {',
    'function moveStickyByKeyboard(id, delta) { return false;'
  ),
  'new-sticky-default': (text) => text.replace('        var pos = findFreePosition();', '        var pos = { x: 26, y: 26 };'),
  /* 本轮缺陷的原始形态：拖动开始时不摘掉被拖卡片的命中 → elementFromPoint 永远命中自己，
     插入线不出现、松手也不排序。删掉这一行后，拖动排序断言必须点名红。 */
  'drag-no-pointer-none': (text) => text.replace(
    "            card.el.style.pointerEvents = 'none';\n",
    ''
  ),
  /* 缺陷 B 原始形态①：删掉排序手势期间的 user-select:none CSS 规则。 */
  'drag-no-user-select': (text) => text.replace(
    'html[data-skin="modern"].is-sticky-ordering,\n'
    + 'html[data-skin="modern"].is-sticky-ordering .sticky,\n'
    + 'html[data-skin="modern"].is-sticky-ordering .sticky * {\n'
    + '  user-select: none;\n'
    + '  -webkit-user-select: none;\n'
    + '}',
    ''
  ),
  /* 缺陷 B 原始形态②：不挂 is-sticky-ordering 类（等价没有手势态）。 */
  'drag-no-ordering-class': (text) => text.replace(
    "        document.documentElement.classList.add('is-sticky-ordering');\n",
    ''
  ),
  /* 缺陷 B 的"清不干净"形态：finish() 里不摘类 → 松手后手势态残留。 */
  'drag-stuck-ordering': (text) => text.replace(
    "          document.documentElement.classList.remove('is-sticky-ordering');\n",
    ''
  ),
  /* 反向审计：删掉坞按钮新增的 Ctrl/Cmd 守卫（唯一上下文锚点）。 */
  'dock-guard-removed': (text) => text.replace(
    '        /* 同类缺陷：Ctrl/Cmd + Alt + ←/→ 属于窗口循环，不能让应用坞再排一次序。 */\n        if (event.ctrlKey || event.metaKey) return;\n',
    ''
  ),
};
if (MUTATE && PAGE_MUTATIONS[MUTATE]) {
  const mutated = PAGE_MUTATIONS[MUTATE](pageText);
  if (mutated === pageText) { console.log('FAIL | mutation did not apply: ' + MUTATE); process.exit(1); }
  pageText = mutated;
}

const WORK = join(tmpdir(), 'k3-assertions-' + process.pid + '-' + Date.now());
const PROFILE = join(WORK, 'profile');
mkdirSync(WORK, { recursive: true });
mkdirSync(PROFILE, { recursive: true });
writeFileSync(join(WORK, 'page.html'), pageText, 'utf8');
if (enText) writeFileSync(join(WORK, 'page.en.html'), enText, 'utf8');
const PAGE_URL = pathToFileURL(join(WORK, 'page.html')).href;
const PAGE_EN_URL = enText ? pathToFileURL(join(WORK, 'page.en.html')).href : '';
const dropWork = () => { try { rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (error) { /* temp */ } };

const PORT = 9985;
const proc = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--allow-file-access-from-files',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE, 'about:blank',
], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 100; i += 1) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
    const page = list.find((one) => one.type === 'page');
    if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch (error) { /* not up yet */ }
  await sleep(200);
}
if (!wsUrl) { console.log('FAIL | could not attach to the browser'); proc.kill(); dropWork(); process.exit(1); }
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0;
const pendingCalls = new Map();
const pageErrors = [];
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') {
    const d = message.params.exceptionDetails;
    pageErrors.push((d && d.exception && d.exception.description) || (d && d.text) || 'exception');
  }
  if (message.id && pendingCalls.has(message.id)) { pendingCalls.get(message.id)(message); pendingCalls.delete(message.id); }
};
const send = (method, params) => new Promise((r) => {
  const id = ++msgId;
  pendingCalls.set(id, r);
  ws.send(JSON.stringify({ id, method, params: params || {} }));
});
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) {
    const d = r.result.exceptionDetails;
    return { __err: (d.exception && d.exception.description) || d.text };
  }
  return r.result && r.result.result ? r.result.result.value : undefined;
};
const run = (fn) => ev('(' + fn.toString() + ')()');
const runWith = (fn, args) => ev('(' + fn.toString() + ')(' + (args || []).map((one) => JSON.stringify(one)).join(',') + ')');
const ANIMATIONS_IDLE = '(function () { if (!document.getAnimations) return true; var list = document.getAnimations(); for (var i = 0; i < list.length; i += 1) { if (list[i].playState === "running") return false; } return true; })()';
const waitAnimationsIdle = async (limit) => {
  for (let i = 0; i < (limit || 30); i += 1) {
    if (await ev(ANIMATIONS_IDLE)) return true;
    await sleep(80);
  }
  return false;
};
/* 隐藏页不投递 resize / 不跑 rAF（ui-k4 定性）：导航后带到前台，ready 必须可见。
   另外必须确认"已经是新文档"：Page.navigate 是异步的，导航未提交时 evaluate 会落回旧文档，
   旧文档的 READY 还是 true → 会把上一页的状态当成新页面的结果（k3 只读夹具曾因此偶发
   blocked=false）。导航前 markLeaving() 在旧文档写一个标记，新文档里该标记不存在。 */
const markLeaving = () => ev('try { window.__NAV_TOKEN__ = "leaving"; } catch (err) {}');
const waitReady = async () => {
  /* 就在循环里反复请前台，而不是只在开头请一次：headless 窗口丢前台时
     visibilityState 会一直是 hidden，而下面的断言需要"可见"这个前置条件。
     循环里重请 = 把丢掉的**前置条件**拿回来，不是把断言放宽：
     真拿不回来时它照样返回 false、断言照样红。 */
  for (let i = 0; i < 80; i += 1) {
    await sleep(250);
    if (await ev('document.visibilityState !== "visible"')) {
      try { await send('Page.bringToFront'); } catch (err) { /* older targets */ }
      continue;
    }
    if (await ev('typeof window.__NAV_TOKEN__ === "undefined" && !!window.__PAPER_OS_READY__')) return true;
  }
  return false;
};
const settle = async (fn, args, streakNeeded) => {
  const need = streakNeeded || 6;
  let previous = '';
  let latest = null;
  let streak = 0;
  for (let i = 0; i < 40; i += 1) {
    const idle = await ev(ANIMATIONS_IDLE);
    const visible = await ev('document.visibilityState === "visible"');
    const now = await runWith(fn, args || []);
    latest = now;
    const key = JSON.stringify(now);
    if (!idle || !visible || !previous || key !== previous) streak = 1;
    else streak += 1;
    previous = key;
    if (idle && visible && streak >= need) break;
    await sleep(100);
  }
  return latest;
};
/* 可见性守卫（K2 §8.4b / K7）：隐藏页不推进动画、不投递 resize/rAF。
   隐藏时 getAnimations() 里会留下一堆永远 running 的动画（实测 171 个）——那不是常驻动画，
   是时间被冻住了。动画类断言前先确认可见，避免把测量环境当成产品缺陷。 */
const ensureVisible = async (limit) => {
  let state = '';
  for (let i = 0; i < (limit || 25); i += 1) {
    state = await ev('document.visibilityState');
    if (state === 'visible') return { visible: true, samples: i + 1 };
    try { await send('Page.bringToFront'); } catch (err) { /* older targets */ }
    await sleep(120);
  }
  return { visible: false, samples: limit || 25, state: state };
};
/* 轮询到 getAnimations() 没有 running（带超时，默认 5s）；把采样数/耗时/动画名记进 detail。 */
const waitNoRunningAnimations = async (timeoutMs) => {
  const budget = timeoutMs || 5000;
  const deadline = Date.now() + budget;
  let samples = 0;
  let last = null;
  while (Date.now() < deadline) {
    samples += 1;
    last = await run(function () {
      var list = document.getAnimations ? document.getAnimations() : [];
      var running = [];
      for (var i = 0; i < list.length; i += 1) {
        if (list[i].playState === 'running') {
          var target = list[i].effect && list[i].effect.target ? list[i].effect.target : null;
          running.push({
            name: String(list[i].animationName || list[i].transitionProperty || (list[i].constructor && list[i].constructor.name) || 'animation'),
            target: target ? String((target.className && target.className.baseVal !== undefined ? target.className.baseVal : target.className) || target.tagName || '') : '',
          });
        }
      }
      return { running: running.length, names: running.slice(0, 6), visibility: document.visibilityState };
    });
    if (last && last.running === 0) return { ok: true, samples: samples, waitedMs: budget - Math.max(0, deadline - Date.now()), last: last };
    await sleep(100);
  }
  return { ok: false, samples: samples, waitedMs: budget, last: last };
};
const checks = [];
const ok = (n, d) => { checks.push([true, n]); console.log('PASS | ' + n + (d ? ' | ' + d : '')); };
const bad = (n, d) => { checks.push([false, n]); console.log('FAIL | ' + n + ' | ' + d); };

await send('Page.enable');
await send('Runtime.enable');

const bootPage = async (url, skin) => {
  await send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 });
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await markLeaving();
  await send('Page.navigate', { url });
  if (!(await waitReady())) return false;
  await sleep(400);
  await waitAnimationsIdle();
  await run(function (wanted) {
    var P = window.PaperOS;
    if (P.tour && P.tour.close) P.tour.close();
    var dialog = document.querySelector('.paper-dialog[open]');
    if (dialog && dialog.close) dialog.close();
    P.wm.getWindows().forEach(function (one) { P.wm.close(one.id); });
    if (wanted === 'modern' && P.data.getPrefs().skin !== 'modern') {
      P.data.setPrefs({ skin: 'modern' });
      P.shell.applyPrefs();
    }
    if (wanted === 'classic' && P.data.getPrefs().skin !== 'classic') {
      P.data.setPrefs({ skin: 'classic' });
      P.shell.applyPrefs();
    }
    return true;
  }, [skin]);
  await waitAnimationsIdle(40);
  return true;
};

/* ---------------- Group A: reorder data compatibility ---------------- */
const readOrder = () => run(function () {
  var P = window.PaperOS;
  return {
    active: P.data.listActiveStickies().map(function (one) { return one.id; }),
    zOrder: P.data.listStickies().map(function (one) { return one.id; }),
    positions: P.data.listStickies().map(function (one) { return one.id + ':' + one.x + ',' + one.y + ',' + one.z; }).join('|'),
    snapshot: JSON.stringify(P.data.snapshotData().stickies),
    prefs: P.data.getPrefs()
  };
});

if (!(await bootPage(PAGE_URL, SKIN))) { console.log('FAIL | page never became ready'); proc.kill(); dropWork(); process.exit(1); }
const seeded = await run(function () {
  var P = window.PaperOS;
  var existing = P.data.listActiveStickies();
  if (existing.length < 3) {
    var a = P.data.createSticky({ text: '排序样本 A' });
    var b = P.data.createSticky({ text: '排序样本 B' });
    var c = P.data.createSticky({ text: '排序样本 C' });
    return [a.id, b.id, c.id];
  }
  return existing.map(function (one) { return one.id; });
});
const trashTarget = await run(function () {
  var P = window.PaperOS;
  var created = P.data.createSticky({ text: '将进废纸篓' });
  P.data.deleteSticky(created.id);
  return created.id;
});
const baseline = await readOrder();
const bornSnapshot = baseline.snapshot;

const invalidResults = await runWith(function (ids) {
  var P = window.PaperOS;
  var active = P.data.listActiveStickies().map(function (one) { return one.id; });
  var present = P.data.listStickies().map(function (one) { return one.id; });
  var extra = 'sticky_deliberately_missing';
  var cases = {
    missingOne: active.slice(1),
    extraOne: active.concat([extra]),
    duplicate: active.concat([active[0]]),
    trashedSwap: active.map(function (one, index) { return index === 0 ? ids.trashed : one; }),
    nonexistent: active.map(function (one, index) { return index === 0 ? extra : one; })
  };
  var out = {};
  Object.keys(cases).forEach(function (key) {
    out[key] = P.data.reorderStickies(cases[key]);
  });
  out.after = JSON.stringify(P.data.snapshotData().stickies);
  out.active = P.data.listActiveStickies().map(function (one) { return one.id; });
  return out;
}, [{ trashed: trashTarget }]);
const rejectedKeys = ['missingOne', 'extraOne', 'duplicate', 'trashedSwap', 'nonexistent'];
const refused = rejectedKeys.every((key) => invalidResults && invalidResults[key] === null);
const unchanged = invalidResults && invalidResults.after === bornSnapshot;
if (refused && unchanged) ok('reorderStickies refuses five malformed inputs and keeps the data byte-identical', rejectedKeys.join(','));
else bad('reorderStickies refuses five malformed inputs and keeps the data byte-identical', JSON.stringify({ result: invalidResults && Object.keys(invalidResults).map((key) => [key, invalidResults[key]]), unchanged: unchanged }));

const reorderOutcome = await runWith(function (ids) {
  var P = window.PaperOS;
  var reversed = ids.slice().reverse();
  var before = { z: P.data.listStickies().map(function (one) { return one.id; }), pos: P.data.listStickies().map(function (one) { return one.id + ':' + one.x + ',' + one.y + ',' + one.z; }).join('|') };
  var written = P.data.reorderStickies(reversed);
  var after = { active: P.data.listActiveStickies().map(function (one) { return one.id; }), z: P.data.listStickies().map(function (one) { return one.id; }), pos: P.data.listStickies().map(function (one) { return one.id + ':' + one.x + ',' + one.y + ',' + one.z; }).join('|') };
  var snapshot = P.data.snapshotData();
  P.ingestWorkspace(JSON.parse(JSON.stringify(snapshot)));
  return {
    reversed: reversed,
    wrote: !!written,
    after: after,
    before: before,
    hydratedOrder: P.data.listActiveStickies().map(function (one) { return one.id; })
  };
}, [baseline.active]);
const orderOk = reorderOutcome && reorderOutcome.after && reorderOutcome.wrote && JSON.stringify(reorderOutcome.after.active) === JSON.stringify(reorderOutcome.reversed);
const zStable = !!(reorderOutcome && reorderOutcome.after && reorderOutcome.before
  && reorderOutcome.after.z.join(',') === reorderOutcome.before.z.join(',')
  && reorderOutcome.after.pos === reorderOutcome.before.pos);
if (orderOk) ok('a legal reorder follows the given order and leaves z/x/y untouched', JSON.stringify(reorderOutcome.after.active));
else bad('a legal reorder follows the given order and leaves z/x/y untouched', JSON.stringify(reorderOutcome && { wrote: reorderOutcome.wrote, after: reorderOutcome.after, reversed: reorderOutcome.reversed }));
if (zStable) ok('z order and every x/y/z stay byte-identical after a reorder', reorderOutcome.before.pos.length + ' chars');
else bad('z order and every x/y/z stay byte-identical after a reorder', JSON.stringify(reorderOutcome && { before: reorderOutcome.before, after: reorderOutcome.after }));
const hydrateOk = reorderOutcome && JSON.stringify(reorderOutcome.hydratedOrder) === JSON.stringify(reorderOutcome.reversed);
if (hydrateOk) ok('the reordered sequence survives snapshot -> ingestWorkspace', JSON.stringify(reorderOutcome.hydratedOrder));
else bad('the reordered sequence survives snapshot -> ingestWorkspace', JSON.stringify(reorderOutcome && reorderOutcome.hydratedOrder));

/* classic switch: classic z order unchanged, and a new sticky in classic does not land on 26,26 */
const classicSide = await run(function () {
  var P = window.PaperOS;
  var before = P.data.listStickies().map(function (one) { return one.id + ':' + one.z; }).join('|');
  P.data.setPrefs({ skin: 'classic' });
  P.shell.applyPrefs();
  var after = P.data.listStickies().map(function (one) { return one.id + ':' + one.z; }).join('|');
  P.wm.open('stickies');
  return { before: before, after: after, ready: !!document.querySelector('.window[data-app="stickies"]') };
});
await waitAnimationsIdle(40);
const newCard = await run(function () {
  var P = window.PaperOS;
  var win = document.querySelector('.window[data-app="stickies"]');
  var button = win ? win.querySelector('[data-testid="new-sticky"]') : null;
  if (button) button.click();
  var active = P.data.listActiveStickies();
  var last = active[active.length - 1];
  return { clicked: !!button, found: !!last, x: last ? last.x : null, y: last ? last.y : null, text: last ? last.text : null };
});
if (classicSide && classicSide.after && classicSide.after === classicSide.before) ok('switching back to classic keeps the classic z order', classicSide.after.length + ' chars');
else bad('switching back to classic keeps the classic z order', JSON.stringify({ before: classicSide.before, after: classicSide.after }));
const staggered = newCard && newCard.found && !(newCard.x === 26 && newCard.y === 26);
if (staggered) ok('a sticky created from the sticky board is not parked on the 26,26 corner', JSON.stringify({ x: newCard.x, y: newCard.y, clicked: newCard.clicked }));
else bad('a sticky created from the sticky board is not parked on the 26,26 corner', JSON.stringify(newCard));

/* ---------------- Group B: keyboard reorder ---------------- */
const keyboard = await run(function () {
  var P = window.PaperOS;
  P.data.setPrefs({ skin: 'modern' });
  P.shell.applyPrefs();
  P.wm.open('stickies');
  var win = document.querySelector('.window[data-app="stickies"]');
  var board = win ? win.querySelector('[data-testid="sticky-board"]') : null;
  var cards = board ? board.querySelectorAll('.sticky') : [];
  if (!cards.length) return { error: 'no cards' };
  var before = P.data.listActiveStickies().map(function (one) { return one.id; });
  var first = cards[0];
  first.focus();
  var target = first.getAttribute('data-id') || first.getAttribute('data-sticky-id') || '';
  var event = new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', altKey: true, bubbles: true, cancelable: true });
  (document.activeElement || first).dispatchEvent(event);
  var after = P.data.listActiveStickies().map(function (one) { return one.id; });
  var live = document.getElementById('dock-live');
  var announce = live ? String(live.textContent || '').trim() : '';
  var snapshot = JSON.stringify(P.data.snapshotData().stickies);
  P.ingestWorkspace(JSON.parse(JSON.stringify(P.data.snapshotData())));
  var hydrated = P.data.listActiveStickies().map(function (one) { return one.id; });
  return { before: before, after: after, announce: announce, hydrated: hydrated, snapshot: snapshot.slice(0, 40), target: target, cardCount: cards.length };
});
const keyMoved = keyboard && keyboard.before && keyboard.after && keyboard.before.join(',') !== keyboard.after.join(',');
if (keyMoved) ok('Alt+ArrowRight on a focused sticky moves it one slot', JSON.stringify({ before: keyboard.before, after: keyboard.after }));
else bad('Alt+ArrowRight on a focused sticky moves it one slot', JSON.stringify(keyboard));
if (keyboard && keyboard.announce) ok('the keyboard move is announced through the existing live region', JSON.stringify(keyboard.announce));
else bad('the keyboard move is announced through the existing live region', JSON.stringify(keyboard && keyboard.announce));
if (keyboard && JSON.stringify(keyboard.hydrated) === JSON.stringify(keyboard.after)) ok('the keyboard move survives snapshot -> ingestWorkspace', JSON.stringify(keyboard.hydrated));
else bad('the keyboard move survives snapshot -> ingestWorkspace', JSON.stringify(keyboard && keyboard.hydrated));

const ctrlAlt = await run(function () {
  var P = window.PaperOS;
  var before = P.data.listActiveStickies().map(function (one) { return one.id; });
  var win = document.querySelector('.window[data-app="stickies"]');
  var card = win ? win.querySelector('.sticky') : null;
  if (card) {
    card.focus();
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', altKey: true, ctrlKey: true, bubbles: true, cancelable: true }));
  }
  var after = P.data.listActiveStickies().map(function (one) { return one.id; });
  return { before: before, after: after };
});
if (ctrlAlt && JSON.stringify(ctrlAlt.before) === JSON.stringify(ctrlAlt.after)) ok('Ctrl/Cmd+Alt+ArrowRight is not stolen by the sticky reorder', 'order unchanged');
else bad('Ctrl/Cmd+Alt+ArrowRight is not stolen by the sticky reorder', JSON.stringify(ctrlAlt));

/* 同一类缺陷的第二处：应用坞按钮的 keydown 也不许抢 Ctrl/Cmd+Alt+←/→（窗口循环）。 */
const dockShortcuts = await run(function () {
  var P = window.PaperOS;
  function dockOrder() {
    var out = [];
    var buttons = document.querySelectorAll('[data-dock-app]');
    for (var i = 0; i < buttons.length; i += 1) out.push(buttons[i].getAttribute('data-dock-app'));
    return out;
  }
  function focusedId() {
    var focused = P.wm.getFocused ? P.wm.getFocused() : null;
    return focused ? focused.id : '';
  }
  if (P.wm.getWindows().length < 2) {
    try { P.wm.open('notes'); } catch (err) { /* ignore */ }
    try { P.wm.open('calendar'); } catch (err) { /* ignore */ }
  }
  var button = document.querySelector('[data-dock-app]');
  if (!button) return { error: 'no dock button' };
  button.focus();
  var orderBefore = dockOrder();
  var focusBefore = focusedId();
  button.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true, altKey: true, bubbles: true, cancelable: true
  }));
  var orderAfterCtrlAlt = dockOrder();
  var focusAfterCtrlAlt = focusedId();
  var liveAfterCtrlAlt = String((document.getElementById('dock-live') || {}).textContent || '').trim();
  var orderBeforeAlt = dockOrder();
  button.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'ArrowRight', code: 'ArrowRight', altKey: true, bubbles: true, cancelable: true
  }));
  var orderAfterAlt = dockOrder();
  var liveAfterAlt = String((document.getElementById('dock-live') || {}).textContent || '').trim();
  return {
    orderBefore: orderBefore,
    orderAfterCtrlAlt: orderAfterCtrlAlt,
    orderBeforeAlt: orderBeforeAlt,
    orderAfterAlt: orderAfterAlt,
    focusBefore: focusBefore,
    focusAfterCtrlAlt: focusAfterCtrlAlt,
    liveAfterCtrlAlt: liveAfterCtrlAlt.slice(0, 60),
    liveAfterAlt: liveAfterAlt.slice(0, 60)
  };
});
const dockCtrlAltKept = !!(dockShortcuts && !dockShortcuts.error
  && JSON.stringify(dockShortcuts.orderBefore) === JSON.stringify(dockShortcuts.orderAfterCtrlAlt)
  && dockShortcuts.focusAfterCtrlAlt && dockShortcuts.focusBefore
  && dockShortcuts.focusAfterCtrlAlt !== dockShortcuts.focusBefore);
if (dockCtrlAltKept) ok('dock Ctrl/Cmd+Alt+ArrowRight cycles windows without reordering the dock', JSON.stringify({ order: dockShortcuts.orderAfterCtrlAlt, focus: [dockShortcuts.focusBefore, dockShortcuts.focusAfterCtrlAlt] }));
else bad('dock Ctrl/Cmd+Alt+ArrowRight cycles windows without reordering the dock', JSON.stringify(dockShortcuts));
const dockAltKept = !!(dockShortcuts && !dockShortcuts.error
  && JSON.stringify(dockShortcuts.orderBeforeAlt) !== JSON.stringify(dockShortcuts.orderAfterAlt)
  && dockShortcuts.liveAfterAlt);
if (dockAltKept) ok('dock Alt+ArrowRight reorders the dock and announces it', JSON.stringify({ order: dockShortcuts.orderAfterAlt, live: dockShortcuts.liveAfterAlt }));
else bad('dock Alt+ArrowRight reorders the dock and announces it', JSON.stringify(dockShortcuts));

/* ---------------- Group B2: 现代便签真实指针拖动排序（task-7 收口） ----------------
   本轮两个"套件没抓到、靠人拍图发现"的缺陷都在这条手势上：
   A) beginReorder 的 onMove 用 elementFromPoint 找目标卡，被拖卡片跟手后正好压在指针下面；
      不摘掉它的命中，elementFromPoint 永远命中自己 → 插入线不出现、松手也不排序
      （数据层 reorderStickies 与键盘 Alt+←/→ 都正常，所以既有断言全绿）。
   B) 拖动经过别的卡片会顺带选中正文；修法是起手给 documentElement 挂 is-sticky-ordering、
      CSS 只在现代便签排序手势期间关掉 user-select，finish（含 pointercancel）摘掉。
   因此这里必须用 CDP 真实输入（Input.dispatchMouseEvent = 真实命中测试），并同时断言：
   插入线 + is-dragging 恰 1 张、顺序按落点改变、reload 后仍在、拖动期间选区为 0 且类在、
   松手后类清掉且 pointer-events 还原、cancel 不写数据。整组强制执行 modern（与 Group B
   键盘测试同一做法），--skin=classic / --skin=modern 两次跑都会执行；最后恢复调用方皮肤。 */
const DRAG_MARKER = 'modern sticky drag shows a drop marker on the hovered card';
const DRAG_ORDER = 'modern sticky drag reorders the active list to the drop position';
const DRAG_RELOAD = 'the dropped sticky order survives a reload';
const DRAG_SELECTION = 'modern sticky drag creates no text selection while ordering';
const DRAG_CLEANUP = 'releasing a sticky drag clears the ordering state';
const DRAG_CANCEL = 'a cancelled sticky drag leaves the order unchanged and clears the state';
const CLASSIC_DRAG = 'classic sticky drag still moves free coordinates';
const DRAG_STEPS = 6;

const expectedReorder = function (before, dragId, targetId, side) {
  var ids = before.slice();
  var from = ids.indexOf(dragId);
  if (from === -1) return null;
  ids.splice(from, 1);
  var at = ids.indexOf(targetId);
  if (at === -1) return null;
  ids.splice(at + (side === 'after' ? 1 : 0), 0, dragId);
  return ids;
};
/* CDP 真实输入：mouseMoved → mousePressed → 若干 mouseMoved → mouseReleased。
   Chrome 由鼠标输入合成 pointerdown/pointermove/pointerup（pointerType=mouse），
   页面监听的就是这一套，所以这里测的是真实命中测试，不是 dispatchEvent 的假事件。 */
const mouseEvent = async (type, x, y, extra) => send('Input.dispatchMouseEvent', Object.assign({
  type: type, x: x, y: y, pointerType: 'mouse',
}, extra || {}));
const dragPath = function (from, to, steps) {
  var out = [];
  var count = steps || DRAG_STEPS;
  for (var i = 1; i <= count; i += 1) {
    out.push({ x: Math.round(from.x + (to.x - from.x) * i / count), y: Math.round(from.y + (to.y - from.y) * i / count) });
  }
  return out;
};
const pressAndMove = async (from, path) => {
  const events = ['mouseMoved@' + from.x + ',' + from.y, 'mousePressed@' + from.x + ',' + from.y];
  await mouseEvent('mouseMoved', from.x, from.y, { button: 'none', buttons: 0 });
  await mouseEvent('mousePressed', from.x, from.y, { button: 'left', buttons: 1, clickCount: 1 });
  for (const point of path) {
    await mouseEvent('mouseMoved', point.x, point.y, { button: 'left', buttons: 1 });
    events.push('mouseMoved@' + point.x + ',' + point.y);
    await sleep(24);
  }
  return events;
};
const releaseAt = async (point) => mouseEvent('mouseReleased', point.x, point.y, { button: 'left', buttons: 0, clickCount: 1 });
const readStickyDrag = () => run(function () {
  var P = window.PaperOS;
  var marks = [];
  var found = document.querySelectorAll('.sticky.is-drop-before, .sticky.is-drop-after');
  for (var i = 0; i < found.length; i += 1) {
    marks.push({ id: found[i].getAttribute('data-id'), side: found[i].classList.contains('is-drop-before') ? 'before' : 'after' });
  }
  var dragging = document.querySelectorAll('.sticky.is-dragging');
  var selection = '';
  try { selection = String(document.getSelection() ? document.getSelection().toString() : ''); } catch (err) { selection = ''; }
  var sample = dragging.length ? dragging[0] : document.querySelector('.sticky');
  var sampleStyle = sample ? getComputedStyle(sample) : null;
  return {
    markers: marks,
    markerCount: marks.length,
    marker: marks.length ? marks[0] : null,
    draggingCount: dragging.length,
    draggedId: dragging.length ? dragging[0].getAttribute('data-id') : '',
    draggedPointerEvents: dragging.length ? getComputedStyle(dragging[0]).pointerEvents : '',
    userSelect: sampleStyle ? sampleStyle.userSelect : '',
    webkitUserSelect: sampleStyle ? (sampleStyle.webkitUserSelect || '') : '',
    orderingClass: document.documentElement.classList.contains('is-sticky-ordering'),
    selectionLength: selection.length,
    selectionPreview: selection.slice(0, 48),
    order: P.data.listActiveStickies().map(function (one) { return one.id; }),
  };
});
const readStickyDragAfter = (draggedId) => runWith(function (id) {
  var P = window.PaperOS;
  var card = document.querySelector('.sticky[data-id="' + id + '"]');
  var status = P.storage.getDataStatus ? P.storage.getDataStatus() : null;
  return {
    order: P.data.listActiveStickies().map(function (one) { return one.id; }),
    orderingClass: document.documentElement.classList.contains('is-sticky-ordering'),
    draggingCount: document.querySelectorAll('.sticky.is-dragging').length,
    pointerEvents: card ? getComputedStyle(card).pointerEvents : 'missing',
    inlinePointerEvents: card ? card.style.pointerEvents : 'missing',
    marks: document.querySelectorAll('.is-drop-before, .is-drop-after').length,
    phase: status ? status.phase : '',
  };
}, [draggedId || '']);
const stickyDragGeometry = () => run(function () {
  var P = window.PaperOS;
  var win = document.querySelector('.window[data-app="stickies"]');
  if (!win) return { error: 'no stickies window' };
  var board = win.querySelector('[data-testid="sticky-board"]');
  if (board) { board.scrollLeft = 0; board.scrollTop = 0; }
  var cards = win.querySelectorAll('.sticky');
  var viewportW = document.documentElement.clientWidth;
  var viewportH = document.documentElement.clientHeight;
  var out = [];
  for (var i = 0; i < cards.length; i += 1) {
    var rect = cards[i].getBoundingClientRect();
    var handle = cards[i].querySelector('.sticky__drag') || cards[i].querySelector('.sticky__head');
    var hrect = handle ? handle.getBoundingClientRect() : null;
    out.push({
      id: cards[i].getAttribute('data-id'),
      rect: { left: Math.round(rect.left), top: Math.round(rect.top), right: Math.round(rect.right), bottom: Math.round(rect.bottom), width: Math.round(rect.width), height: Math.round(rect.height) },
      handle: hrect ? { x: Math.round(hrect.left + hrect.width / 2), y: Math.round(hrect.top + hrect.height / 2) } : null,
      inView: rect.left >= 0 && rect.top >= 0 && rect.right <= viewportW && rect.bottom <= viewportH,
      style: { left: cards[i].style.left, top: cards[i].style.top },
    });
  }
  return { viewport: { w: viewportW, h: viewportH }, cards: out, order: P.data.listActiveStickies().map(function (one) { return one.id; }) };
});
const openStickyBoard = async (skin) => {
  await runWith(function (wanted) {
    var P = window.PaperOS;
    P.data.setPrefs({ skin: wanted });
    P.shell.applyPrefs();
    P.wm.getWindows().forEach(function (one) { P.wm.close(one.id); });
    return true;
  }, [skin]);
  await waitAnimationsIdle(40);
  await sleep(250);
  await run(function () { window.PaperOS.wm.open('stickies'); return true; });
  await waitAnimationsIdle(40);
  await sleep(250);
};
const waitSaved = async () => {
  await ev('try { window.PaperOS.storage.flush(); } catch (err) {}');
  for (let i = 0; i < 30; i += 1) {
    const phase = await run(function () {
      var P = window.PaperOS;
      return P.storage.getDataStatus ? P.storage.getDataStatus().phase : '';
    });
    if (phase === 'saved') return phase;
    await sleep(80);
  }
  return 'pending';
};

await openStickyBoard('modern');
const dragGeom = await stickyDragGeometry();
const dragGeomOk = !!(dragGeom && !dragGeom.error && dragGeom.cards && dragGeom.cards.length >= 3
  && dragGeom.cards[0].handle && dragGeom.cards[2].handle
  && dragGeom.cards[0].inView && dragGeom.cards[2].inView);
let dragMid = null;
let dragAfter = null;
let dragEvents = [];
let dragPoint = null;
let dragExpected = null;
if (dragGeomOk) {
  const from = dragGeom.cards[0];
  const target = dragGeom.cards[2];
  /* 目标点取第 3 张卡右侧：|offsetX| > |offsetY| 且 offsetX > 0 → 落点语义固定为 after。 */
  dragPoint = { x: Math.round(target.rect.left + target.rect.width * 0.78), y: Math.round(target.rect.top + target.rect.height / 2) };
  dragEvents = await pressAndMove(from.handle, dragPath(from.handle, dragPoint));
  for (let i = 0; i < 8; i += 1) {
    await sleep(70);
    dragMid = await readStickyDrag();
    if (dragMid && dragMid.markerCount) break;
  }
  await releaseAt(dragPoint);
  await sleep(300);
  await waitAnimationsIdle(30);
  const phase = await waitSaved();
  dragAfter = await readStickyDragAfter(dragMid && dragMid.draggedId ? dragMid.draggedId : '');
  if (dragAfter) dragAfter.phase = phase || dragAfter.phase;
  dragExpected = (dragMid && dragMid.markerCount === 1 && dragMid.marker && dragMid.draggedId
    && dragMid.draggedId === from.id)
    ? expectedReorder(dragGeom.order, dragMid.draggedId, dragMid.marker.id, dragMid.marker.side) : null;
}
const dragMarkerOk = !!(dragMid && dragMid.markerCount >= 1 && dragMid.marker
  && dragMid.marker.id !== dragMid.draggedId && dragMid.draggingCount === 1);
if (dragMarkerOk) ok(DRAG_MARKER, JSON.stringify({ marker: dragMid.marker, draggedId: dragMid.draggedId, draggingCount: dragMid.draggingCount, draggedPointerEvents: dragMid.draggedPointerEvents, order: dragMid.order, events: dragEvents }));
else bad(DRAG_MARKER, JSON.stringify({ geometry: dragGeomOk ? undefined : dragGeom, mid: dragMid, dragPoint: dragPoint, events: dragEvents }));
const dragOrderOk = !!(dragExpected && dragAfter && dragGeom
  && JSON.stringify(dragAfter.order) === JSON.stringify(dragExpected)
  && JSON.stringify(dragAfter.order) !== JSON.stringify(dragGeom.order));
if (dragOrderOk) ok(DRAG_ORDER, JSON.stringify({ before: dragGeom.order, after: dragAfter.order, expected: dragExpected, marker: dragMid.marker, events: dragEvents }));
else bad(DRAG_ORDER, JSON.stringify({ before: dragGeom && dragGeom.order, after: dragAfter && dragAfter.order, expected: dragExpected, marker: dragMid && dragMid.marker, events: dragEvents }));
const dragSelectionOk = !!(dragMid && dragMid.selectionLength === 0 && dragMid.orderingClass === true
  && dragMid.userSelect === 'none');
if (dragSelectionOk) ok(DRAG_SELECTION, JSON.stringify({ selectionLength: dragMid.selectionLength, selectionPreview: dragMid.selectionPreview, orderingClass: dragMid.orderingClass, userSelect: dragMid.userSelect, events: dragEvents }));
else bad(DRAG_SELECTION, JSON.stringify({ selectionLength: dragMid && dragMid.selectionLength, selectionPreview: dragMid && dragMid.selectionPreview, orderingClass: dragMid && dragMid.orderingClass, userSelect: dragMid && dragMid.userSelect, webkitUserSelect: dragMid && dragMid.webkitUserSelect, events: dragEvents }));
const dragCleanupOk = !!(dragAfter && dragAfter.orderingClass === false && dragAfter.draggingCount === 0
  && dragAfter.pointerEvents !== 'none' && dragAfter.marks === 0);
if (dragCleanupOk) ok(DRAG_CLEANUP, JSON.stringify({ orderingClass: dragAfter.orderingClass, draggingCount: dragAfter.draggingCount, pointerEvents: dragAfter.pointerEvents, inlinePointerEvents: dragAfter.inlinePointerEvents, marks: dragAfter.marks }));
else bad(DRAG_CLEANUP, JSON.stringify({ after: dragAfter }));

/* 落盘：flush 到 saved 后整页 reload，顺序必须还在（不是只看内存里的 snapshotData）。 */
let reloadedOrder = null;
let reloadedReady = false;
if (dragOrderOk) {
  await markLeaving();
  await send('Page.reload', { ignoreCache: true });
  reloadedReady = await waitReady();
  await sleep(400);
  await waitAnimationsIdle(40);
  await run(function () {
    var P = window.PaperOS;
    if (P.tour && P.tour.close) P.tour.close();
    var dialog = document.querySelector('.paper-dialog[open]');
    if (dialog) {
      var buttons = dialog.querySelectorAll('.dialog-actions .paper-btn');
      var target = null;
      for (var i = 0; i < buttons.length; i += 1) {
        if (buttons[i].classList.contains('paper-btn--ghost')) { target = buttons[i]; break; }
      }
      if (!target && buttons.length) target = buttons[0];
      if (target) target.click();
    }
    return true;
  });
  await sleep(300);
  reloadedOrder = await run(function () {
    var P = window.PaperOS;
    return {
      order: P.data.listActiveStickies().map(function (one) { return one.id; }),
      skin: P.data.getPrefs().skin,
      dialogs: document.querySelectorAll('.paper-dialog[open]').length,
    };
  });
}
const reloadOk = !!(reloadedReady && reloadedOrder && dragExpected
  && JSON.stringify(reloadedOrder.order) === JSON.stringify(dragExpected));
if (reloadOk) ok(DRAG_RELOAD, JSON.stringify({ reloaded: reloadedOrder.order, expected: dragExpected, skin: reloadedOrder.skin }));
else bad(DRAG_RELOAD, JSON.stringify({ ready: reloadedReady, reloaded: reloadedOrder, expected: dragExpected }));

/* pointercancel：拖到一半取消 → 只清状态、顺序不变（既有契约）。取消事件用页面监听的
   pointercancel 派发（CDP 没有 pointercancel 的原生入口；主路径已由真实鼠标输入覆盖）。 */
let cancelMid = null;
let cancelAfter = null;
let cancelEvents = [];
if (reloadOk) {
  await openStickyBoard('modern');
  const cancelGeom = await stickyDragGeometry();
  const cancelGeomOk = !!(cancelGeom && !cancelGeom.error && cancelGeom.cards && cancelGeom.cards.length >= 3
    && cancelGeom.cards[0].handle && cancelGeom.cards[2].handle
    && cancelGeom.cards[0].inView && cancelGeom.cards[2].inView);
  if (cancelGeomOk) {
    const from = cancelGeom.cards[0];
    const target = cancelGeom.cards[2];
    const point = { x: Math.round(target.rect.left + target.rect.width * 0.78), y: Math.round(target.rect.top + target.rect.height / 2) };
    cancelEvents = await pressAndMove(from.handle, dragPath(from.handle, point));
    for (let i = 0; i < 8; i += 1) {
      await sleep(70);
      cancelMid = await readStickyDrag();
      if (cancelMid && cancelMid.markerCount) break;
    }
    await runWith(function (at) {
      document.dispatchEvent(new PointerEvent('pointercancel', {
        bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0,
        clientX: at.x, clientY: at.y,
      }));
      return true;
    }, [point]);
    cancelEvents.push('pointercancel@' + point.x + ',' + point.y);
    await releaseAt(point);
    await sleep(260);
    await waitAnimationsIdle(30);
    cancelAfter = await run(function () {
      var P = window.PaperOS;
      var marks = document.querySelectorAll('.is-drop-before, .is-drop-after').length;
      var stuck = [];
      var cards = document.querySelectorAll('.sticky');
      for (var i = 0; i < cards.length; i += 1) {
        if (cards[i].style.pointerEvents === 'none') stuck.push(cards[i].getAttribute('data-id'));
      }
      return {
        order: P.data.listActiveStickies().map(function (one) { return one.id; }),
        orderingClass: document.documentElement.classList.contains('is-sticky-ordering'),
        draggingCount: document.querySelectorAll('.sticky.is-dragging').length,
        marks: marks,
        stuckPointerEvents: stuck,
      };
    });
  }
}
const cancelOk = !!(cancelMid && cancelMid.markerCount >= 1 && cancelMid.orderingClass === true
  && cancelAfter && reloadedOrder
  && JSON.stringify(cancelAfter.order) === JSON.stringify(reloadedOrder.order)
  && cancelAfter.orderingClass === false && cancelAfter.draggingCount === 0
  && cancelAfter.marks === 0 && cancelAfter.stuckPointerEvents.length === 0);
if (cancelOk) ok(DRAG_CANCEL, JSON.stringify({ mid: { marker: cancelMid.marker, orderingClass: cancelMid.orderingClass }, order: cancelAfter.order, orderingClass: cancelAfter.orderingClass, marks: cancelAfter.marks, stuckPointerEvents: cancelAfter.stuckPointerEvents, events: cancelEvents }));
else bad(DRAG_CANCEL, JSON.stringify({ mid: cancelMid, after: cancelAfter, before: reloadedOrder && reloadedOrder.order, events: cancelEvents }));

/* classic 不回归：classic 下拖动仍是自由坐标（x/y 变化、顺序不变、没有插入线）。 */
await openStickyBoard('classic');
const classicGeom = await run(function () {
  var P = window.PaperOS;
  var win = document.querySelector('.window[data-app="stickies"]');
  if (!win) return { error: 'no stickies window' };
  var board = win.querySelector('[data-testid="sticky-board"]');
  if (board) { board.scrollLeft = 0; board.scrollTop = 0; }
  var card = win.querySelector('.sticky');
  if (!card) return { error: 'no card' };
  var handle = card.querySelector('.sticky__drag') || card.querySelector('.sticky__head');
  var rect = handle ? handle.getBoundingClientRect() : null;
  var id = card.getAttribute('data-id');
  var one = P.data.listStickies().filter(function (s) { return s.id === id; })[0];
  return {
    id: id,
    handle: rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null,
    inView: !!rect && rect.left >= 0 && rect.top >= 0,
    style: { left: card.style.left, top: card.style.top },
    data: one ? { x: one.x, y: one.y } : null,
    order: P.data.listActiveStickies().map(function (s) { return s.id; }),
  };
});
let classicAfter = null;
let classicEvents = [];
if (classicGeom && !classicGeom.error && classicGeom.handle && classicGeom.inView) {
  const dest = { x: classicGeom.handle.x + 80, y: classicGeom.handle.y + 60 };
  classicEvents = await pressAndMove(classicGeom.handle, dragPath(classicGeom.handle, dest, 4));
  await releaseAt(dest);
  await sleep(260);
  await waitAnimationsIdle(30);
  classicAfter = await runWith(function (id) {
    var P = window.PaperOS;
    var card = document.querySelector('.sticky[data-id="' + id + '"]');
    var one = P.data.listStickies().filter(function (s) { return s.id === id; })[0];
    return {
      style: card ? { left: card.style.left, top: card.style.top } : null,
      data: one ? { x: one.x, y: one.y } : null,
      marks: document.querySelectorAll('.is-drop-before, .is-drop-after, .is-dragging').length,
      orderingClass: document.documentElement.classList.contains('is-sticky-ordering'),
      order: P.data.listActiveStickies().map(function (s) { return s.id; }),
    };
  }, [classicGeom.id]);
}
const classicMoved = !!(classicGeom && classicAfter && classicGeom.data && classicAfter.data
  && (classicAfter.data.x !== classicGeom.data.x || classicAfter.data.y !== classicGeom.data.y)
  && JSON.stringify(classicAfter.order) === JSON.stringify(classicGeom.order)
  && classicAfter.marks === 0 && classicAfter.orderingClass === false);
if (classicMoved) ok(CLASSIC_DRAG, JSON.stringify({ before: classicGeom.data, after: classicAfter.data, order: classicAfter.order, orderingClass: classicAfter.orderingClass, events: classicEvents }));
else bad(CLASSIC_DRAG, JSON.stringify({ geometry: classicGeom, after: classicAfter, events: classicEvents }));
/* 恢复调用方的皮肤，后面的 Group C 仍按原基线跑。 */
await runWith(function (wanted) {
  var P = window.PaperOS;
  if (P.data.getPrefs().skin !== wanted) { P.data.setPrefs({ skin: wanted }); P.shell.applyPrefs(); }
  return true;
}, [SKIN]);
await waitAnimationsIdle(40);

/* ---------------- Group C: 04 §8 boundary states ---------------- */
const emptyState = await run(function () {
  var P = window.PaperOS;
  P.data.listPrompts('').forEach(function (one) { P.data.deletePrompt(one.id); });
  P.wm.open('prompts');
  var win = document.querySelector('.window[data-app="prompts"]');
  var empty = win ? win.querySelector('.prompts-empty') : null;
  var bar = win ? win.querySelector('.prompts-main__bar') : null;
  return { prompts: P.data.listPrompts('').length, empty: !!empty, barHidden: !!(bar && bar.hidden) };
});
if (emptyState && emptyState.prompts === 0 && emptyState.empty) ok('prompts empty state renders when the library is empty', JSON.stringify(emptyState));
else bad('prompts empty state renders when the library is empty', JSON.stringify(emptyState));
if (emptyState && emptyState.barHidden) ok('the prompt bar stays hidden while nothing is selected', JSON.stringify(emptyState));
else bad('the prompt bar stays hidden while nothing is selected', JSON.stringify(emptyState));

const longContent = await run(function () {
  var P = window.PaperOS;
  var longTitle = new Array(301).join('长标题');
  var longBody = new Array(6001).join('正');
  var prompt = P.data.createPrompt({ title: longTitle.slice(0, 300), body: longBody.slice(0, 5000) });
  var sticky = P.data.createSticky({ text: 'x' });
  P.data.updateSticky(sticky.id, { text: longBody });
  var saved = P.data.listStickies().filter(function (one) { return one.id === sticky.id; })[0];
  P.wm.open('prompts');
  var win = document.querySelector('.window[data-app="prompts"]');
  var titleInput = win ? win.querySelector('#prompt-title, [data-testid="prompt-title"]') : null;
  var scrollWidth = titleInput ? titleInput.scrollWidth : 0;
  var clientWidth = titleInput ? titleInput.clientWidth : 0;
  return {
    promptTitle: prompt && prompt.title ? prompt.title.length : 0,
    promptTitleMax: P.PROMPT_TITLE_MAX,
    stickyText: saved ? saved.text.length : 0,
    titleScroll: scrollWidth,
    titleClient: clientWidth,
    overflowX: Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth)
  };
});
const titleCapOk = longContent && longContent.promptTitle === Math.min(300, longContent.promptTitleMax || 0) && longContent.promptTitleMax > 0;
if (titleCapOk) ok('a 300-char prompt title is capped by the documented title limit', JSON.stringify({ stored: longContent.promptTitle, cap: longContent.promptTitleMax }));
else bad('a 300-char prompt title is capped by the documented title limit', JSON.stringify(longContent));
if (longContent && longContent.stickyText === 5000) ok('sticky bodies are capped at 5000 chars, not truncated mid-write', JSON.stringify({ length: longContent.stickyText }));
else bad('sticky bodies are capped at 5000 chars, not truncated mid-write', JSON.stringify(longContent));
if (longContent && longContent.overflowX === 0) ok('long titles/bodies cause no page-level horizontal overflow', JSON.stringify({ overflowX: longContent.overflowX, titleScroll: longContent.titleScroll, titleClient: longContent.titleClient }));
else bad('long titles/bodies cause no page-level horizontal overflow', JSON.stringify(longContent));

const multiWindow = await run(function () {
  var P = window.PaperOS;
  P.wm.open('notes');
  P.wm.open('calendar');
  return { windows: P.wm.getWindows().length, apps: P.wm.getWindows().map(function (one) { return one.appId; }) };
});
if (multiWindow && multiWindow.windows >= 3) ok('three windows can be open at once', JSON.stringify(multiWindow));
else bad('three windows can be open at once', JSON.stringify(multiWindow));

const oldData = await run(function () {
  var P = window.PaperOS;
  var legacy = {
    format: 'paper-os/workspace', version: 2,
    nodes: [], stickies: [{ id: 'sticky_legacy', text: '旧数据', color: 'butter', x: 40, y: 40, z: 3, createdAt: 1, updatedAt: 2 }],
    tasks: [], prompts: [], prefs: { skin: 'modern' }, meta: { updatedAt: 3 }
  };
  var before = P.data.getPrefs().skin;
  var beforeBlocked = !!(P.storage && P.storage.blocked);
  var result = P.ingestWorkspace(legacy);
  return {
    result: !!result,
    blocked: !!(P.storage && P.storage.blocked),
    beforeBlocked: beforeBlocked,
    skin: P.data.getPrefs().skin,
    stickies: P.data.listActiveStickies().length
  };
});
if (oldData && oldData.result && oldData.blocked === false && oldData.stickies >= 1) ok('old v2 data still hydrates and is editable', JSON.stringify(oldData));
else bad('old v2 data still hydrates and is editable', JSON.stringify(oldData));

const darkContrast = await run(function () {
  var P = window.PaperOS;
  P.data.setPrefs({ theme: 'dark' });
  P.shell.applyPrefs();
  P.wm.open('notes');
  return { theme: document.documentElement.getAttribute('data-theme') || '' };
});
await waitAnimationsIdle(40);
const darkColors = await settle(function () {
  var input = document.querySelector('.note-title-input');
  var sheet = document.querySelector('.editor-sheet');
  if (!input || !sheet) return { error: 'notes parts missing' };
  return { color: getComputedStyle(input).color, background: getComputedStyle(sheet).backgroundColor };
});
const lum = (rgb) => {
  const m = /rgba?\(([0-9.]+), ?([0-9.]+), ?([0-9.]+)/.exec(String(rgb || ''));
  if (!m) return null;
  const ch = [m[1], m[2], m[3]].map((value) => {
    const c = Number(value) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
};
const contrast = (() => {
  const a = lum(darkColors && darkColors.color);
  const b = lum(darkColors && darkColors.background);
  if (a === null || b === null) return null;
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
})();
if (contrast !== null && contrast >= 4.5) ok('dark mode keeps the note title readable', JSON.stringify({ contrast: contrast, colors: darkColors }));
else bad('dark mode keeps the note title readable', JSON.stringify({ contrast: contrast, colors: darkColors }));

/* narrow viewport: no horizontal overflow (animation gate first) */
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 820, deviceScaleFactor: 3, mobile: false });
await waitAnimationsIdle(40);
const narrowState = await settle(function () {
  var root = document.documentElement;
  return { viewportW: root.clientWidth, overflowX: Math.round(root.scrollWidth - root.clientWidth) };
});
if (narrowState && narrowState.viewportW === 420 && narrowState.overflowX === 0) ok('420x820 has no page-level horizontal overflow', JSON.stringify(narrowState));
else bad('420x820 has no page-level horizontal overflow', JSON.stringify(narrowState));
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 960, deviceScaleFactor: 1, mobile: false });
await waitAnimationsIdle(40);

/* reduced motion: no running animations after opening a window.
   不一次取值：轮询到 getAnimations() 无 running（5s 超时），超时才是真失败；
   采样数与耗时进 detail；隐藏页会让动画"永远 running"，所以先确认可见。 */
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
const reducedVisible = await ensureVisible();
await run(function () { window.PaperOS.wm.open('draw'); return true; });
await sleep(250);
const reduced = await waitNoRunningAnimations(5000);
const reducedDetail = {
  samples: reduced.samples,
  waitedMs: reduced.waitedMs,
  visibility: reduced.last && reduced.last.visibility,
  guard: reducedVisible,
  running: reduced.last ? reduced.last.running : -1,
  names: reduced.last ? reduced.last.names : [],
};
if (reduced.ok && reducedVisible.visible) ok('reduced motion leaves no running animation after opening a window', JSON.stringify(reducedDetail));
else bad('reduced motion leaves no running animation after opening a window', JSON.stringify(reducedDetail));
await send('Emulation.setEmulatedMedia', { features: [] });

/* read-only + newer data: boot a page with a v99 host snapshot.
   先收掉窗口并等布局保存落定：pagehide 里只要 dirty/pending 就会补写 recovery journal，
   而 journal 会无条件盖掉新页面的 host 快照（本文件曾因此偶发 blocked=false）。 */
await ev('try { var P = window.PaperOS; if (P.wm) P.wm.getWindows().forEach(function (w) { P.wm.close(w.id); }); } catch (err) {}');
await sleep(420);
await ev('try { window.PaperOS.storage.flush(); } catch (err) {}');
for (let i = 0; i < 30; i += 1) {
  const phase = await run(function () {
    var P = window.PaperOS;
    return P.storage.getDataStatus ? P.storage.getDataStatus().phase : '';
  });
  if (phase === 'saved') break;
  await sleep(80);
}
await sleep(150);
await ev('try { window.localStorage.removeItem("paper-os.recovery.v1"); } catch (err) {}');
const newerUrl = pathToFileURL(join(WORK, 'page.newer.html')).href;
const newerSnapshot = {
  format: 'paper-os/workspace', version: 99, nodes: [], stickies: [], tasks: [], prompts: [], prefs: {},
  meta: { updatedAt: 4102444800000 },
};
/* 新页面的 boot 脚本先删 recovery journal：journal 在 Storage.init 里无条件覆盖 host 快照，
   只要上一页 pagehide 写过一份，v99 快照就会被无视（实测偶发 blocked=false）。
   这一段在主脚本之前执行，所以删得掉。 */
const newerBoot = '<' + 'script>try { window.localStorage.removeItem("paper-os.recovery.v1"); } catch (err) {}'
  + 'window.__SCHEDULE_HOST_MODE__=true;window.__SCHEDULE_HOST_SNAPSHOT__='
  + JSON.stringify(newerSnapshot).replace(/</g, '\\u003c') + ';' + '<' + '/script>' + '<script>';
writeFileSync(join(WORK, 'page.newer.html'), pageText.replace('<script>', newerBoot), 'utf8');
await markLeaving();
await send('Page.navigate', { url: newerUrl });
const newerReady = await waitReady();
await sleep(500);
const readOnly = await run(function () {
  var P = window.PaperOS;
  var notice = document.querySelector('.read-only, [data-testid="read-only"], .os-notice');
  return {
    blocked: !!(P.storage && P.storage.blocked),
    noticeText: notice ? String(notice.textContent || '').trim().slice(0, 40) : '',
    bodyText: String(document.body.textContent || '').indexOf('只读') !== -1
  };
});
if (newerReady && readOnly && readOnly.blocked === true) ok('a newer-version workspace boots read-only', JSON.stringify(readOnly));
else bad('a newer-version workspace boots read-only', JSON.stringify({ ready: newerReady, readOnly: readOnly }));
if (readOnly && (readOnly.noticeText || readOnly.bodyText)) ok('the read-only state is explained on screen', JSON.stringify(readOnly));
else bad('the read-only state is explained on screen', JSON.stringify(readOnly));

/* English variant: empty prompts copy is not CJK */
if (PAGE_EN_URL) {
  await send('Emulation.clearDeviceMetricsOverride');
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await markLeaving();
  await send('Page.navigate', { url: PAGE_EN_URL });
  const enReady = await waitReady();
  await sleep(400);
  await waitAnimationsIdle(40);
  const english = await run(function () {
    var P = window.PaperOS;
    P.data.listPrompts('').forEach(function (one) { P.data.deletePrompt(one.id); });
    P.wm.open('prompts');
    var win = document.querySelector('.window[data-app="prompts"]');
    var empty = win ? win.querySelector('.prompts-empty') : null;
    var text = empty ? String(empty.textContent || '') : '';
    return { lang: P.lang || '', title: text.slice(0, 60), cjk: (text.match(/[\u4e00-\u9fff]/g) || []).length, empty: !!empty };
  });
  if (enReady && english && english.empty && english.cjk === 0) ok('the English prompts empty state has no CJK copy', JSON.stringify(english));
  else bad('the English prompts empty state has no CJK copy', JSON.stringify({ ready: enReady, english: english }));
} else {
  bad('the English prompts empty state has no CJK copy', 'no English page variant in client.js');
}

if (pageErrors.length) bad('no page exceptions during the K3 assertions', pageErrors.slice(0, 3).join(' | '));
else ok('no page exceptions during the K3 assertions');

const failedFinal = checks.filter((one) => !one[0]);
console.log('RUN-FINGERPRINT ' + JSON.stringify({
  build: BUILD,
  skin: SKIN,
  mutate: MUTATE || null,
  checks: { pass: checks.length - failedFinal.length, fail: failedFinal.length },
}));
console.log('checks: PASS ' + (checks.length - failedFinal.length) + ' / FAIL ' + failedFinal.length + ' / SKIN ' + SKIN + (MUTATE ? ' / MUTATE ' + MUTATE : ''));
ws.close();
proc.kill();
await sleep(200);
dropWork();
process.exit(failedFinal.length ? 1 : 0);
