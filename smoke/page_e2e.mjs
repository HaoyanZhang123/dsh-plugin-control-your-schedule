#!/usr/bin/env node
/**
 * Real-browser check for the paper desk (headless Edge/Chrome via CDP).
 * Loads the page embedded in the built client.js, i.e. exactly what users get.
 * Screenshots land in output/_probe/cys-e2e.
 * Exit 0 only when every assertion passes. No third-party dependencies.
 *
 * Note: this file contains no template literals on purpose - expressions are
 * passed as function sources, so nothing can be truncated by a stray backtick.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLIENT = join(ROOT, 'plugin', 'client.js');
const OUT = join(ROOT, '..', '..', 'output', '_probe', 'cys-e2e');
const PORT = 9533;

const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const BROWSER = CANDIDATES.find((p) => existsSync(p));
if (!BROWSER) { console.log('SKIP | no headless browser found'); process.exit(0); }
if (!existsSync(CLIENT)) { console.log('FAIL | client.js missing'); process.exit(1); }
mkdirSync(OUT, { recursive: true });

// Decode the page that ships inside the bundle, so the test covers the artifact.
const client = readFileSync(CLIENT, 'utf8');
const match = /var PAGE_B64 = '([A-Za-z0-9+/=]+)'/.exec(client);
if (!match) { console.log('FAIL | PAGE_B64 not found in client.js'); process.exit(1); }
const PROFILE = join(OUT, 'profile-page-e2e');
rmSync(PROFILE, { recursive: true, force: true });
const PAGE = join(OUT, 'page.published.html');
writeFileSync(PAGE, Buffer.from(match[1], 'base64').toString('utf8'));

const checks = [];
const ok = (n, d) => { checks.push([true, n]); console.log('PASS | ' + n + (d ? ' | ' + d : '')); };
const bad = (n, d) => { checks.push([false, n]); console.log('FAIL | ' + n + ' | ' + d); };

const proc = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  '--allow-file-access-from-files', '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + PROFILE, 'about:blank',
], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 100; i += 1) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch (err) { /* not up yet */ }
  await sleep(200);
}
if (!wsUrl) { console.log('FAIL | could not attach to browser'); proc.kill(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0;
const pending = new Map();
const pageErrors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    pageErrors.push((d && d.exception && d.exception.description) || (d && d.text) || 'exception');
  }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params) => new Promise((r) => {
  const id = ++msgId; pending.set(id, r); ws.send(JSON.stringify({ id, method, params: params || {} }));
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
const shot = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, name + '.png'), Buffer.from(s.result.data, 'base64'));
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: pathToFileURL(PAGE).href });

const waitReady = async () => {
  for (let i = 0; i < 80; i += 1) {
    await sleep(250);
    if (await ev('!!window.__PAPER_OS_READY__')) return true;
  }
  return false;
};
if (!(await waitReady())) {
  bad('page boots', 'never became ready');
  console.log('checks: PASS 0 / FAIL 1');
  proc.kill();
  process.exit(1);
}
ok('page boots');

const version = await ev('window.PaperOS.version');
if (version && version !== '__PAGE_VERSION__') ok('page version injected by the build', String(version));
else bad('page version injected by the build', String(version));
const schema = await ev('window.PaperOS.schemaVersion');
if (schema === 2) ok('schema is v2'); else bad('schema is v2', String(schema));

// --- first open fills the work area ---
const geometry = await run(function () {
  var P = window.PaperOS;
  P.wm.open('stickies');
  var w = P.wm.getWindows().filter(function (x) { return x.appId === 'stickies'; })[0];
  if (!w) return null;
  var stage = document.getElementById('stage');
  return { w: w.bounds.w, h: w.bounds.h, stageW: stage.clientWidth };
});
if (geometry && geometry.w > 700) ok('first open fills the work area', JSON.stringify(geometry));
else bad('first open fills the work area', JSON.stringify(geometry));

// --- day seal ---
const seal = await run(function () {
  var el = document.getElementById('day-seal');
  return el ? el.textContent.replace(/\s+/g, '') : '';
});
if (seal && seal.indexOf('宜') === 0) ok('day seal shows 宜…', seal);
else bad('day seal shows 宜…', JSON.stringify(seal));

// --- calendar dots ---
const dots = await run(function () {
  var P = window.PaperOS;
  P.wm.open('calendar');
  var shell = document.querySelector('.window[data-app=calendar]');
  if (!shell) return { error: 'no calendar window' };
  var doc = shell;
  var cells = [].slice.call(doc.querySelectorAll('.cal-day')).filter(function (c) { return c.querySelector('.cal-day__dot'); });
  if (!cells.length) return { error: 'no dots rendered' };
  var cell = cells[0];
  var dot = cell.querySelector('.cal-day__dot');
  var cellBox = cell.getBoundingClientRect();
  var padBottom = parseFloat(getComputedStyle(cell).paddingBottom) || 0;
  var numBox = cell.querySelector('.cal-day__num').getBoundingClientRect();
  var openRow = cell.querySelector('.cal-day__dot-row:not(.cal-day__dot-row--done)');
  var doneRow = cell.querySelector('.cal-day__dot-row--done');
  var openBox = openRow.getBoundingClientRect();
  var doneBox = doneRow.getBoundingClientRect();
  var doneDots = doneRow.querySelectorAll('.cal-day__dot').length;
  return {
    priority: dot.getAttribute('data-priority'),
    belowNumber: Math.round(openBox.top) >= Math.round(numBox.bottom) - 1,
    donePinnedToBottom: doneDots === 0 ? true : Math.round(cellBox.bottom - doneBox.bottom) <= padBottom + 2,
    doneBelowOpen: doneDots === 0 ? true : Math.round(doneBox.top) >= Math.round(openBox.top) - 1,
    total: doc.querySelectorAll('.cal-day__dot').length,
    done: doc.querySelectorAll('.cal-day__dot--done').length
  };
});
if (dots && !dots.error && dots.belowNumber) ok('calendar dots start below the day number', JSON.stringify(dots));
else bad('calendar dots start below the day number', JSON.stringify(dots));
if (dots && !dots.error && dots.donePinnedToBottom && dots.doneBelowOpen) ok('completed dots sink to the cell bottom, undone stay above', JSON.stringify(dots));
else bad('completed dots sink to the cell bottom, undone stay above', JSON.stringify(dots));
await run(function () {
  var P = window.PaperOS;
  P.wm.getWindows().forEach(function (w) {
    if (w.appId !== 'calendar') P.wm.close(w.id);
  });
});
await shot('page-calendar');
if (dots && dots.priority) ok('calendar dots carry a priority', dots.priority);
else bad('calendar dots carry a priority', JSON.stringify(dots));

// --- recurring task projection ---
const recurring = await run(function () {
  var P = window.PaperOS;
  var today = P.util.todayKey();
  var t = P.data.addTask(today, '每天读十页', { priority: 'important', repeat: 'daily' });
  P.data.setTaskDone(t.id, today, true);
  var pick = function (day) {
    return P.data.projectTasks(day).filter(function (x) { return x.id === t.id; });
  };
  var todayList = pick(today);
  return {
    visibleToday: todayList.length,
    doneToday: todayList[0] && todayList[0].done,
    visibleFuture: pick(P.util.addDaysKey(today, 4)).length,
    visibleUncheckedPast: pick(P.util.addDaysKey(today, -3)).length,
    checkins: todayList[0] && todayList[0].checkins
  };
});
if (recurring && recurring.visibleToday === 1 && recurring.doneToday === true) ok('recurring task shows today once, as done', JSON.stringify(recurring));
else bad('recurring task shows today once, as done', JSON.stringify(recurring));
if (recurring && recurring.visibleFuture === 0) ok('recurring task does not pre-fill future days');
else bad('recurring task does not pre-fill future days', JSON.stringify(recurring));
if (recurring && recurring.visibleUncheckedPast === 0) ok('unchecked past days stay empty');
else bad('unchecked past days stay empty', JSON.stringify(recurring));

// --- resolve / restore ---
const resolved = await run(function () {
  var P = window.PaperOS;
  var today = P.util.todayKey();
  var t = P.data.addTask(today, '收拾书桌', { repeat: 'daily' });
  P.data.setTaskDone(t.id, today, true);
  P.data.resolveTask(t.id);
  var row = P.data.projectTasks(today).filter(function (x) { return x.id === t.id; })[0];
  var tomorrow = P.data.projectTasks(P.util.addDaysKey(today, 1)).filter(function (x) { return x.id === t.id; });
  P.data.unresolveTask(t.id);
  var backToday = P.data.projectTasks(today).filter(function (x) { return x.id === t.id; });
  var backTomorrow = P.data.projectTasks(P.util.addDaysKey(today, 1)).filter(function (x) { return x.id === t.id; });
  return {
    resolved: row && row.resolved,
    checkins: row && row.checkins,
    tomorrowAfterResolve: tomorrow.length,
    todayAfterUndo: backToday.length,
    tomorrowAfterUndo: backTomorrow.length
  };
});
if (resolved && resolved.resolved === true && resolved.tomorrowAfterResolve === 0 && resolved.todayAfterUndo === 1 && resolved.tomorrowAfterUndo === 0) ok('resolve stops future instances and is reversible', JSON.stringify(resolved));
else bad('resolve stops future instances and is reversible', JSON.stringify(resolved));
if (resolved && resolved.checkins === 1) ok('resolved row reports 打卡 days', String(resolved.checkins));
else bad('resolved row reports 打卡 days', JSON.stringify(resolved));

// --- stickies ---
const sticky = await run(function () {
  var P = window.PaperOS;
  var a = P.data.createSticky({ text: '第一张', color: 'butter', x: 20, y: 20 });
  var b = P.data.createSticky({ text: '第二张', color: 'sage', x: 40, y: 40 });
  P.data.raiseSticky(a.id);
  var live = P.data.listStickies();
  var onTop = live[live.length - 1].id === a.id;
  var baseLive = live.length;
  var baseTrash = P.data.listTrashedStickies().length;
  P.data.deleteSticky(b.id);
  var trashed = P.data.listTrashedStickies().length - baseTrash;
  var liveAfter = P.data.listStickies().length;
  P.data.restoreSticky(b.id);
  var restored = P.data.listStickies().length;
  return { onTop: onTop, trashed: trashed, liveAfter: liveAfter, restored: restored, baseLive: baseLive };
});
if (sticky && sticky.onTop && sticky.trashed === 1 && sticky.liveAfter === sticky.baseLive - 1 && sticky.restored === sticky.baseLive) ok('sticky z-order + trash + restore', JSON.stringify(sticky));
else bad('sticky z-order + trash + restore', JSON.stringify(sticky));

// --- sticky drag from the card body (not just a handle) ---
const drag = await run(function () {
  var P = window.PaperOS;
  var created = P.data.createSticky({ text: '拖我', color: 'butter', x: 40, y: 40 });
  P.wm.open('stickies');
  var card = document.querySelector('.sticky[data-id=' + created.id + ']');
  if (!card) return { error: 'card not rendered' };
  var startX = parseInt(card.style.left, 10);
  var startY = parseInt(card.style.top, 10);
  var box = card.getBoundingClientRect();
  // Grab the empty area under the text, which used to be dead space.
  var x = box.left + box.width / 2;
  var y = box.top + box.height - 18;
  var opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true };
  card.dispatchEvent(new PointerEvent('pointerdown', opts));
  document.dispatchEvent(new PointerEvent('pointermove', Object.assign({}, opts, { clientX: x + 60, clientY: y + 40 })));
  document.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, opts, { clientX: x + 60, clientY: y + 40 })));
  var after = document.querySelector('.sticky[data-id=' + created.id + ']');
  return {
    start: { x: startX, y: startY },
    end: { x: parseInt(after.style.left, 10), y: parseInt(after.style.top, 10) },
    dragged: parseInt(after.style.left, 10) !== startX
  };
});
if (drag && drag.dragged) ok('sticky moves when grabbed by the card body', JSON.stringify(drag));
else bad('sticky moves when grabbed by the card body', JSON.stringify(drag));

// --- trash dialog lists what was deleted ---
const trashUi = await run(function () {
  var P = window.PaperOS;
  var s = P.data.createSticky({ text: '进废纸篓', color: 'rose', x: 60, y: 60 });
  P.data.deleteSticky(s.id);
  var btn = document.querySelector('[data-testid=open-trash]');
  if (!btn) return { error: 'no trash button' };
  btn.click();
  var dialog = document.querySelector('.paper-dialog[open]');
  var text = dialog ? dialog.textContent : '';
  var listed = text.indexOf('进废纸篓') !== -1;
  var days = text.indexOf(String(P.data.trashDays)) !== -1;
  if (dialog) dialog.close();
  return { opened: !!dialog, listed: listed, mentionsRetention: days };
});
if (trashUi && trashUi.opened && trashUi.listed && trashUi.mentionsRetention) ok('trash dialog lists deleted notes and states retention', JSON.stringify(trashUi));
else bad('trash dialog lists deleted notes and states retention', JSON.stringify(trashUi));

// --- notes ---
const note = await run(function () {
  var P = window.PaperOS;
  P.wm.open('notes');
  var shell = document.querySelector('.window[data-app=notes]');
  if (!shell) return { error: 'no notes window' };
  var doc = shell;
  doc.querySelector('[data-testid=new-note]').click();
  var input = doc.querySelector('[data-testid=note-title]');
  var body = doc.querySelector('[data-testid=note-body]');
  return { titleValue: input.value, titlePlaceholder: input.placeholder, bodyPlaceholder: body.placeholder };
});
if (note && note.titleValue === '' && /名字/.test(note.titlePlaceholder || '')) ok('new note title is a placeholder, not literal text', JSON.stringify(note));
else bad('new note title is a placeholder, not literal text', JSON.stringify(note));
if (note && note.bodyPlaceholder === '从这里开始写，纸会自动收好。') ok('note body placeholder uses a comma');
else bad('note body placeholder uses a comma', JSON.stringify(note && note.bodyPlaceholder));

// --- drawing ---
const drawing = await run(function () {
  var P = window.PaperOS;
  P.wm.open('draw');
  var shell = document.querySelector('.window[data-app=draw]');
  if (!shell) return { error: 'no draw window' };
  var doc = shell;
  var nav = { prev: !!doc.querySelector('[data-gallery-prev]'), next: !!doc.querySelector('[data-gallery-next]') };
  var del = !!doc.querySelector('[data-delete-drawing]');
  var created = P.data.createDrawing({ name: '删掉我' });
  var before = P.data.listDrawings().length;
  P.data.deleteNode(created.id);
  return { nav: nav, del: del, before: before, after: P.data.listDrawings().length };
});
if (drawing && drawing.nav.prev && drawing.nav.next && drawing.del) ok('drawing shelf has paging + delete', JSON.stringify(drawing.nav));
else bad('drawing shelf has paging + delete', JSON.stringify(drawing));
if (drawing && drawing.before - drawing.after === 1 && drawing.before > 0) ok('a drawing can be deleted', drawing.before + ' -> ' + drawing.after);
else bad('a drawing can be deleted', JSON.stringify(drawing));

// --- theme ---
await ev('window.PaperOS.data.setPrefs({ theme: "dark" }); window.PaperOS.shell.applyPrefs();');
await sleep(350);
const darkAttr = await ev('document.documentElement.getAttribute("data-theme")');
const darkBg = await ev('getComputedStyle(document.body).backgroundColor');
await shot('page-dark');
await ev('window.PaperOS.data.setPrefs({ theme: "light" }); window.PaperOS.shell.applyPrefs();');
await sleep(350);
const lightAttr = await ev('document.documentElement.getAttribute("data-theme")');
const lightBg = await ev('getComputedStyle(document.body).backgroundColor');
await shot('page-light');
if (darkAttr === 'dark' && lightAttr === 'light') ok('theme switches light/dark', darkAttr + ' / ' + lightAttr);
else bad('theme switches light/dark', darkAttr + ' / ' + lightAttr);
if (darkBg !== lightBg) ok('dark and light paint differently', darkBg + ' vs ' + lightBg);
else bad('dark and light paint differently', 'both ' + darkBg);
await ev('window.PaperOS.data.setPrefs({ theme: "system" }); window.PaperOS.shell.applyPrefs();');
const prefAttr = await ev('document.documentElement.getAttribute("data-theme-pref")');
const resolvedAttr = await ev('document.documentElement.getAttribute("data-theme")');
if (prefAttr === 'system' && (resolvedAttr === 'light' || resolvedAttr === 'dark')) ok('system mode resolves to a real theme', prefAttr + ' -> ' + resolvedAttr);
else bad('system mode resolves to a real theme', prefAttr + ' / ' + resolvedAttr);

// --- the empty placeholder copy is gone ---
const noPlaceholder = await run(function () {
  var P = window.PaperOS;
  var today = P.util.todayKey();
  P.data.addTask(today, '没有状态文字的一条');
  P.wm.open('calendar');
  var shell = document.querySelector('.window[data-app=calendar]');
  var rows = shell.querySelectorAll('.task-item');
  var target = null;
  for (var i = 0; i < rows.length; i += 1) {
    var t = rows[i].querySelector('.task-title');
    if (t && t.textContent === '没有状态文字的一条') { target = rows[i]; break; }
  }
  if (!target) return { error: 'row not rendered' };
  return { meta: target.querySelector('.task-item__meta').textContent.trim() };
});
if (noPlaceholder && noPlaceholder.meta === '') ok('unfinished one-off task shows no placeholder copy', JSON.stringify(noPlaceholder));
else bad('unfinished one-off task shows no placeholder copy', JSON.stringify(noPlaceholder));

// --- a daily task appears once on each of the next days, and again after check-in ---
const dailyRun = await ev('(' + (function () {
  var P = window.PaperOS, U = P.util;
  var start = U.todayKey();
  var t = P.data.addTask(start, '每日回归', { repeat: 'daily' });
  function on(day) { return P.data.projectTasks(day, day).filter(function (x) { return x.id === t.id; }); }
  var days = [];
  for (var d = 0; d < 4; d += 1) {
    var day = U.addDaysKey(start, d);
    var list = on(day);
    days.push({ count: list.length, done: list[0] ? list[0].done : null });
  }
  P.data.setTaskDone(t.id, start, true);
  var nextDay = on(U.addDaysKey(start, 1))[0];
  return {
    days: days,
    todayDone: on(start)[0].done,
    tomorrowDone: nextDay ? nextDay.done : null,
    tomorrowCurrent: nextDay ? nextDay.current : null,
  };
}).toString() + ')()');
const dailyOk = dailyRun && Array.isArray(dailyRun.days) && dailyRun.days.length === 4
  && dailyRun.days.every(function (d) { return d.count === 1; })
  && dailyRun.todayDone === true
  && dailyRun.tomorrowDone === false
  && dailyRun.tomorrowCurrent === true;
if (dailyOk) ok('a daily task appears once per day and resets after check-in', JSON.stringify(dailyRun));
else bad('a daily task appears once per day and resets after check-in', JSON.stringify(dailyRun));

// --- no floating hints at all (user asked for none) ---
const noToast = await run(function () {
  var P = window.PaperOS;
  P.ui.toast('这条不该出现', { kind: 'info' });
  P.ui.toast('这条也不该出现', { kind: 'error' });
  return { nodes: document.querySelectorAll('.toast').length };
});
if (noToast && noToast.nodes === 0) ok('floating hints are switched off', JSON.stringify(noToast));
else bad('floating hints are switched off', JSON.stringify(noToast));

// --- the priority popover lists the four levels and nothing else ---
const popoverShape = await run(function () {
  var P = window.PaperOS;
  P.wm.open('calendar');
  var shell = document.querySelector('.window[data-app=calendar]');
  var pip = shell.querySelector('.task-pip-btn');
  if (!pip) return { error: 'no pip' };
  pip.click();
  var pop = document.querySelector('.priority-popover');
  if (!pop) return { error: 'popover did not open' };
  var labels = [];
  pop.querySelectorAll('.priority-popover__label').forEach(function (el) { labels.push(el.textContent); });
  var out = { items: pop.querySelectorAll('.priority-popover__item').length, hints: pop.querySelectorAll('.priority-popover__hint').length, labels: labels };
  document.body.click();
  return out;
});
if (popoverShape && popoverShape.items === 4 && popoverShape.hints === 0) ok('priority popover shows only the four levels', JSON.stringify(popoverShape));
else bad('priority popover shows only the four levels', JSON.stringify(popoverShape));

// --- switching to daily must not make the task vanish from that day ---
const anchorDay = await run(function () {
  var P = window.PaperOS;
  var today = P.util.todayKey();
  var past = P.util.addDaysKey(today, -2);
  var created = P.data.addTask(past, '改成每天也别消失');
  var shell = document.querySelector('.window[data-app=calendar]');
  var cell = shell.querySelector('.cal-day[data-date="' + past + '"]');
  if (!cell) return { error: 'past cell not in this month view' };
  cell.click();
  var shell2 = document.querySelector('.window[data-app=calendar]');
  var rows = shell2.querySelectorAll('.task-item');
  var chip = null;
  for (var i = 0; i < rows.length; i += 1) {
    if (rows[i].getAttribute('data-task-id') === created.id) { chip = rows[i].querySelector('.task-repeat'); break; }
  }
  if (!chip) return { error: 'row not rendered on its anchor day' };
  var before = chip.textContent;
  chip.click();
  return { before: before, taskId: created.id, past: past };
});
await sleep(500);
// run() serialises the function, so values must be passed as JSON literals, not closures.
const anchorAfter = anchorDay && anchorDay.taskId
  ? await ev('(function(){var P=window.PaperOS;var id=' + JSON.stringify(anchorDay.taskId)
      + ';var past=' + JSON.stringify(anchorDay.past)
      + ';var shell=document.querySelector(".window[data-app=calendar]");'
      + 'var rows=shell.querySelectorAll(".task-item");var row=null;'
      + 'for(var i=0;i<rows.length;i+=1){if(rows[i].getAttribute("data-task-id")===id){row=rows[i];break;}}'
      + 'return {stillThere:!!row,chip:row?row.querySelector(".task-repeat").textContent:null,'
      + 'projected:P.data.projectTasks(past).filter(function(t){return t.id===id;}).length};})()')
  : null;
if (anchorDay && anchorDay.before === '仅今日' && anchorAfter && anchorAfter.stillThere && anchorAfter.chip === '每天' && anchorAfter.projected === 1) ok('switching to daily keeps the task on its anchor day', JSON.stringify(anchorAfter));
else bad('switching to daily keeps the task on its anchor day', JSON.stringify({ before: anchorDay, after: anchorAfter }));

// --- task rows carry their own controls (dot + repeat chip) ---
const rowControls = await run(function () {
  var P = window.PaperOS;
  P.wm.open('calendar');
  var shell = document.querySelector('.window[data-app=calendar]');
  if (!shell) return { error: 'no calendar window' };
  var row = shell.querySelector('.task-item');
  if (!row) return { error: 'no task row' };
  return {
    hasPip: !!row.querySelector('.task-pip-btn'),
    hasChip: !!row.querySelector('.task-repeat'),
    chipText: row.querySelector('.task-repeat') ? row.querySelector('.task-repeat').textContent : null,
  };
});
if (rowControls && rowControls.hasPip && rowControls.hasChip) ok('task row has a priority dot and a repeat chip', JSON.stringify(rowControls));
else bad('task row has a priority dot and a repeat chip', JSON.stringify(rowControls));

// --- the dot opens a 4-colour popover and the choice sticks ---
const popover = await run(function () {
  var P = window.PaperOS;
  var shell = document.querySelector('.window[data-app=calendar]');
  var pip = shell.querySelector('.task-pip-btn');
  if (!pip) return { error: 'no pip' };
  pip.click();
  var pop = document.querySelector('.priority-popover');
  if (!pop) return { error: 'popover did not open' };
  var items = pop.querySelectorAll('.priority-popover__item');
  var count = items.length;
  items[0].click();
  var after = document.querySelector('.window[data-app=calendar]').querySelector('.task-pip-btn');
  return { options: count, closed: !document.querySelector('.priority-popover'), priority: after.getAttribute('data-priority') };
});
if (popover && popover.options === 4 && popover.closed && popover.priority === 'urgent-important') ok('priority popover picks a level and sticks', JSON.stringify(popover));
else bad('priority popover picks a level and sticks', JSON.stringify(popover));

// --- an existing task can actually be edited (this used to throw) ---
const editDialog = await run(function () {
  var shell = document.querySelector('.window[data-app=calendar]');
  var btn = shell.querySelector('[aria-label^=编辑待办], [aria-label^="编辑待办"]');
  if (!btn) return { error: 'no edit button' };
  btn.click();
  var dialog = document.querySelector('.paper-dialog[open]');
  var options = dialog ? dialog.querySelectorAll('.priority-option').length : 0;
  if (dialog) dialog.close();
  return { opened: !!dialog, options: options };
});
if (editDialog && editDialog.opened === true) ok('existing task opens its detail dialog', JSON.stringify(editDialog));
else bad('existing task opens its detail dialog', JSON.stringify(editDialog));

// --- a finished dot is grey, never the priority colour ---
const doneDot = await run(function () {
  var shell = document.querySelector('.window[data-app=calendar]');
  var done = shell.querySelector('.cal-day__dot--done');
  var open = null;
  var all = shell.querySelectorAll('.cal-day__dot');
  for (var i = 0; i < all.length; i += 1) {
    if (!all[i].classList.contains('cal-day__dot--done')) { open = all[i]; break; }
  }
  if (!done) return { error: 'no finished dot' };
  return {
    done: getComputedStyle(done).backgroundColor,
    open: open ? getComputedStyle(open).backgroundColor : null,
  };
});
if (doneDot && doneDot.done && doneDot.open && doneDot.done !== doneDot.open) ok('finished dot is grey, unfinished keeps its colour', JSON.stringify(doneDot));
else bad('finished dot is grey, unfinished keeps its colour', JSON.stringify(doneDot));

// --- per-app view survives into the saved snapshot ---
const viewState = await run(function () {
  var P = window.PaperOS;
  for (var i = 0; i < 14; i += 1) {
    P.data.createSticky({ text: '便签 ' + i, color: 'butter', x: 24 + (i % 3) * 230, y: 42 + Math.floor(i / 3) * 200 });
  }
  P.wm.open('stickies');
  var shell = document.querySelector('.window[data-app=stickies]');
  var board = shell.querySelector('.sticky-board');
  var scrolled = false;
  if (board.scrollHeight > board.clientHeight + 40) {
    board.scrollTop = 220;
    board.dispatchEvent(new Event('scroll'));
    scrolled = board.scrollTop > 0;
  }
  return { scrolled: scrolled };
});
await sleep(900);
const viewInSnapshot = await run(function () {
  var P = window.PaperOS;
  var win = P.wm.getWindows().filter(function (w) { return w.appId === 'stickies'; })[0];
  var snap = P.storage.capture();
  var saved = (snap.desktop.windows || []).filter(function (w) { return w.appId === 'stickies'; })[0];
  return {
    live: win && win.params ? win.params.view : null,
    saved: saved && saved.params ? saved.params.view : null,
  };
});
if (viewState && viewState.scrolled && viewInSnapshot && viewInSnapshot.saved) ok('sticky scroll position reaches the saved snapshot', JSON.stringify(viewInSnapshot));
else bad('sticky scroll position reaches the saved snapshot', JSON.stringify({ viewState: viewState, snap: viewInSnapshot }));

// --- the teardown path can force a synchronous save ---
const flushNow = await run(function () {
  var P = window.PaperOS;
  return { kind: typeof P.storage.flushNow, ran: P.storage.flushNow ? P.storage.flushNow() : null };
});
if (flushNow && flushNow.kind === 'function' && flushNow.ran !== false) ok('storage exposes a synchronous flushNow for teardown');
else bad('storage exposes a synchronous flushNow for teardown', JSON.stringify(flushNow));

// --- dark mode must actually be dark (measured, not assumed) ---
const darkAudit = await run(function () {
  var P = window.PaperOS;
  P.data.setPrefs({ theme: 'dark' });
  P.shell.applyPrefs();
  P.wm.open('notes');
  function lum(rgb) {
    var m = /rgba?\(([0-9.]+), ?([0-9.]+), ?([0-9.]+)/.exec(rgb);
    if (!m) return null;
    var ch = [m[1], m[2], m[3]].map(function (v) {
      var c = Number(v) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }
  function ratio(a, b) {
    var la = lum(a), lb = lum(b);
    if (la === null || lb === null) return null;
    var hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }
  function bgOf(sel) {
    var el = document.querySelector(sel);
    if (!el) return null;
    return getComputedStyle(el).backgroundColor;
  }
  function fgOf(sel) {
    var el = document.querySelector(sel);
    if (!el) return null;
    return getComputedStyle(el).color;
  }
  var out = { surfaces: {}, contrast: {} };
  ['.window__body', '.notes-editor', '.editor-sheet'].forEach(function (sel) {
    var bg = bgOf(sel);
    if (bg) out.surfaces[sel] = { bg: bg, lum: lum(bg) };
  });
  var tourTitle = document.querySelector('.tour__title');
  if (tourTitle) {
    var card = document.querySelector('.tour__card');
    out.contrast.tourTitle = ratio(getComputedStyle(tourTitle).color, getComputedStyle(card).backgroundColor);
  }
  var noteTitle = fgOf('.note-title-input');
  var noteBg = bgOf('.editor-sheet');
  if (noteTitle && noteBg) out.contrast.noteText = ratio(noteTitle, noteBg);
  return out;
});
const surfaces = darkAudit && darkAudit.surfaces ? Object.keys(darkAudit.surfaces) : [];
const lightSurfaces = surfaces.filter(function (sel) { return darkAudit.surfaces[sel].lum > 0.35; });
if (surfaces.length >= 2 && lightSurfaces.length === 0) ok('dark mode has no near-white surfaces', JSON.stringify(darkAudit.surfaces));
else bad('dark mode has no near-white surfaces', JSON.stringify(darkAudit && darkAudit.surfaces));
const contrasts = darkAudit && darkAudit.contrast ? darkAudit.contrast : {};
const weak = Object.keys(contrasts).filter(function (k) { return contrasts[k] !== null && contrasts[k] < 4.5; });
if (Object.keys(contrasts).length && weak.length === 0) ok('dark mode text stays readable', JSON.stringify(contrasts));
else bad('dark mode text stays readable', JSON.stringify(contrasts));

// --- field round-trip through the real ingest gate ---
const roundTrip = await run(function () {
  var P = window.PaperOS;
  P.data.setPrefs({ theme: 'light' });
  P.shell.applyPrefs();
  var today = P.util.todayKey();
  var task = P.data.addTask(today, '回环用例', { priority: 'urgent', repeat: 'daily' });
  P.data.setTaskDone(task.id, today, true);
  var sticky = P.data.createSticky({ text: '回环便签', color: 'sky', x: 12, y: 34 });
  P.data.raiseSticky(sticky.id);
  var snapshot = P.storage.capture();
  var ingested = P.ingestWorkspace(JSON.parse(JSON.stringify(snapshot)));
  if (!ingested.ok) return { error: ingested.error };
  var s = ingested.snapshot;
  var t = s.tasks.filter(function (x) { return x.title === '回环用例'; })[0];
  var k = s.stickies.filter(function (x) { return x.text === '回环便签'; })[0];
  return {
    task: t ? { priority: t.priority, repeat: t.repeat, doneOn: t.doneOn, resolvedAt: t.resolvedAt } : null,
    sticky: k ? { color: k.color, z: typeof k.z, trashedAt: k.trashedAt } : null
  };
});
if (roundTrip && roundTrip.task && roundTrip.task.priority === 'urgent' && roundTrip.task.repeat === 'daily' && roundTrip.task.doneOn.length === 1 && roundTrip.task.resolvedAt === 0) ok('task fields survive validate round-trip', JSON.stringify(roundTrip.task));
else bad('task fields survive validate round-trip', JSON.stringify(roundTrip));
if (roundTrip && roundTrip.sticky && roundTrip.sticky.color === 'sky' && roundTrip.sticky.z === 'number' && roundTrip.sticky.trashedAt === 0) ok('sticky fields survive validate round-trip', JSON.stringify(roundTrip.sticky));
else bad('sticky fields survive validate round-trip', JSON.stringify(roundTrip));

// --- reload keeps data ---
await run(function () {
  var P = window.PaperOS;
  P.wm.open('calendar');
  P.data.addTask(P.util.todayKey(), '刷新后还在', { priority: 'urgent' });
  P.storage.flush();
});
await sleep(1200);
await send('Page.reload', { ignoreCache: false });
const ready2 = await waitReady();
const survived = await run(function () {
  var P = window.PaperOS;
  if (!P) return null;
  return {
    titles: P.data.projectTasks(P.util.todayKey()).map(function (t) { return t.title; }),
    windows: P.wm.getWindows().map(function (w) { return w.appId; })
  };
});
if (ready2 && survived && survived.titles.indexOf('刷新后还在') !== -1) ok('data survives a reload');
else bad('data survives a reload', JSON.stringify(survived && survived.titles));
if (survived && survived.windows.indexOf('calendar') !== -1) ok('open windows survive a reload', JSON.stringify(survived.windows));
else bad('open windows survive a reload', JSON.stringify(survived && survived.windows));

if (!pageErrors.length) ok('no page exceptions');
else bad('no page exceptions', pageErrors.slice(0, 3).join(' | '));

await shot('page-final');
const failed = checks.filter((c) => !c[0]);
console.log('checks: PASS ' + (checks.length - failed.length) + ' / FAIL ' + failed.length);
ws.close();
proc.kill();
process.exit(failed.length ? 1 : 0);