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
// 端口固定 + 上一个进程没退干净 = 新测试连到旧浏览器，测的是旧页面和旧状态，
// 表现是一堆逻辑上不可能的失败。改成按 pid 取一个不冲突的端口。
const PORT = 9533 + (process.pid % 400);

const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const BROWSER = CANDIDATES.find((p) => existsSync(p));
/* SKIP is not a pass: exit 3 is the project convention for "could not run here"
   (run_all_checks.py maps it to an explicit SKIP instead of a silent PASS). */
if (!BROWSER) { console.log('SKIP | no headless browser found'); process.exit(3); }
if (!existsSync(CLIENT)) { console.log('FAIL | client.js missing'); process.exit(1); }
mkdirSync(OUT, { recursive: true });

// Decode the page that ships inside the bundle, so the test covers the artifact.
const client = readFileSync(CLIENT, 'utf8');
const match = /var PAGE_B64 = '([A-Za-z0-9+/=]+)'/.exec(client);
if (!match) { console.log('FAIL | PAGE_B64 not found in client.js'); process.exit(1); }
// 每次用独立 profile：上一个进程若还没退干净，删目录会 EPERM，整轮测试直接崩。
// 这跟产品无关，是测试自己的健壮性；留着旧目录比让门禁随机变红好。
const PROFILE = join(OUT, 'profile-page-e2e-' + process.pid + '-' + Date.now());
const PAGE = join(OUT, 'page.published.html');
writeFileSync(PAGE, Buffer.from(match[1], 'base64').toString('utf8'));
// The build ships two page variants; the English one must exist or the gate is meaningless.
const enMatch = /var PAGE_B64_EN = '([A-Za-z0-9+/=]+)'/.exec(client);
const PAGE_EN = join(OUT, 'page.published.en.html');
if (enMatch) writeFileSync(PAGE_EN, Buffer.from(enMatch[1], 'base64').toString('utf8'));

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
if (schema === 3) ok('schema is v3'); else bad('schema is v3', String(schema));

// The Chinese page is the source of truth: it runs with the zh runtime and F() keeps the wording.
const zhRuntime = await ev('({ lang: (window.PaperOS && window.PaperOS.lang) || "", sample: window.PaperOS ? window.PaperOS.F("{n} 张纸页", 2) : "" })');
if (zhRuntime && zhRuntime.lang === 'zh' && zhRuntime.sample === '2 张纸页') ok('the Chinese page runs with P.lang=zh', JSON.stringify(zhRuntime));
else bad('the Chinese page runs with P.lang=zh', JSON.stringify(zhRuntime));

const seededPrompts = await run(function () {
  var P = window.PaperOS;
  return { samples: P.data.getExampleCounts().prompts, total: P.data.listPrompts('').length };
});
if (seededPrompts && seededPrompts.samples === 3) ok('first run seeds three sample prompts', JSON.stringify(seededPrompts));
else bad('first run seeds three sample prompts', JSON.stringify(seededPrompts));

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

// --- window titlebar: kicker + title, but never the same word twice ---
const zhHeading = await run(function () {
  var P = window.PaperOS;
  P.wm.open('prompts');
  var win = document.querySelector('.window[data-app=prompts]');
  if (!win) return { error: 'no prompts window' };
  var heading = win.querySelector('.window__heading');
  var titleEl = win.querySelector('.window__title');
  return {
    kicker: (win.querySelector('.window__app-name') || {}).textContent || '',
    title: (titleEl || {}).textContent || '',
    single: !!(heading && heading.classList.contains('is-single')),
    titleHidden: !!(titleEl && titleEl.hidden)
  };
});
if (zhHeading && !zhHeading.single && !zhHeading.titleHidden && zhHeading.kicker === 'PROMPTS' && zhHeading.title === '提示词') ok('different kicker and title both stay visible', JSON.stringify(zhHeading));
else bad('different kicker and title both stay visible', JSON.stringify(zhHeading));

// --- theme ---
// 便签右下角日期的可读性：深色下曾经是深棕压在深色便签上（同色），
// 这里按 WCAG 相对亮度实测「日期色（含透明度叠到便签底）对便签底色」的对比度。
const runWith = (fn, args) => ev('(' + fn.toString() + ')(' + args.map(function (one) { return JSON.stringify(one); }).join(',') + ')');
const stickyContrast = (selector) => runWith(function (sel) {
  var P = window.PaperOS;
  P.wm.open('stickies');
  if (!P.data.listStickies().length) P.data.createSticky({ text: '对比度', color: 'butter', x: 30, y: 30 });
  var card = document.querySelector('.sticky');
  if (!card) return { error: 'no sticky card' };
  var target = card.querySelector(sel);
  if (!target) return { error: 'no node for ' + sel };
  function parse(value) {
    var m = /rgba?\(([^)]+)\)/.exec(value || '');
    if (!m) return null;
    var parts = m[1].split(',').map(function (one) { return parseFloat(one); });
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  function lum(c) {
    function ch(v) { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
  }
  var fgRaw = getComputedStyle(target).color;
  var bgRaw = getComputedStyle(card).backgroundColor;
  var fg = parse(fgRaw);
  var bg = parse(bgRaw);
  if (!fg || !bg) return { error: 'unparsable colors', fg: fgRaw, bg: bgRaw };
  var mixed = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
  var hi = Math.max(lum(mixed), lum(bg));
  var lo = Math.min(lum(mixed), lum(bg));
  return {
    selector: sel,
    ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100,
    color: fgRaw,
    background: bgRaw,
    text: String(target.textContent || '').trim()
  };
}, [selector]);
/* 截图前先关导览：导览层带 0.46 遮罩，会把整页压暗，不能当验收图。 */
const closeTour = async () => {
  await ev('try { window.PaperOS.tour.close(); } catch (err) {}');
  await sleep(280);
};
await ev('window.PaperOS.data.setPrefs({ theme: "dark" }); window.PaperOS.shell.applyPrefs();');
await sleep(350);
const darkAttr = await ev('document.documentElement.getAttribute("data-theme")');
const darkBg = await ev('getComputedStyle(document.body).backgroundColor');
await closeTour();
await shot('page-dark');
const darkStickyDate = await stickyContrast('.sticky__date');
const darkStickyTag = await stickyContrast('.sticky__foot .sample-tag');
/* 中文深色便签页：把便签窗口提到最前，单独留一张可读性截图。 */
await run(function () {
  var P = window.PaperOS;
  P.wm.open('stickies');
  var wins = P.wm.getWindows().filter(function (w) { return w.appId === 'stickies'; });
  if (wins.length) P.wm.focus(wins[0].id);
});
await closeTour();
await shot('page-dark-sticky');
await ev('window.PaperOS.data.setPrefs({ theme: "light" }); window.PaperOS.shell.applyPrefs();');
await sleep(350);
const lightAttr = await ev('document.documentElement.getAttribute("data-theme")');
const lightBg = await ev('getComputedStyle(document.body).backgroundColor');
await closeTour();
await shot('page-light');
const lightStickyDate = await stickyContrast('.sticky__date');
if (darkAttr === 'dark' && lightAttr === 'light') ok('theme switches light/dark', darkAttr + ' / ' + lightAttr);
else bad('theme switches light/dark', darkAttr + ' / ' + lightAttr);
if (darkBg !== lightBg) ok('dark and light paint differently', darkBg + ' vs ' + lightBg);
else bad('dark and light paint differently', 'both ' + darkBg);
if (darkStickyDate && darkStickyDate.ratio >= 3) ok('the sticky date stays readable in dark', JSON.stringify(darkStickyDate));
else bad('the sticky date stays readable in dark', JSON.stringify(darkStickyDate));
/* 「示例」小标签也是元信息：深色下曾经 1.54:1。中英文页面同一套配色，同一口径。 */
if (darkStickyTag && darkStickyTag.ratio >= 3) ok('the sample tag stays readable on a dark sticky', JSON.stringify(darkStickyTag));
else bad('the sample tag stays readable on a dark sticky', JSON.stringify(darkStickyTag));
if (lightStickyDate && lightStickyDate.ratio >= 1.8) ok('the sticky date stays meta-quiet in light but does not vanish', JSON.stringify(lightStickyDate));
else bad('the sticky date stays meta-quiet in light but does not vanish', JSON.stringify(lightStickyDate));
await ev('window.PaperOS.data.setPrefs({ theme: "system" }); window.PaperOS.shell.applyPrefs();');
const prefAttr = await ev('document.documentElement.getAttribute("data-theme-pref")');
const resolvedAttr = await ev('document.documentElement.getAttribute("data-theme")');
if (prefAttr === 'system' && (resolvedAttr === 'light' || resolvedAttr === 'dark')) ok('system mode resolves to a real theme', prefAttr + ' -> ' + resolvedAttr);
else bad('system mode resolves to a real theme', prefAttr + ' / ' + resolvedAttr);

// --- macOS top clearance: the page paints the inset band itself ---
// The shell now keeps the frame at inset 0 on macOS and hands the clearance in
// through --cys-top-clearance, so the page's own top bar has to grow upwards by
// exactly that much: the band ends up painted by the paper top bar instead of the
// shell colour. Nothing below may assume 48px - a second, arbitrary value proves
// the CSS consumes the variable instead of hard-coding the macOS number.
const clearance = await run(function () {
  var P = window.PaperOS;
  if (P.tour && P.tour.close) P.tour.close();
  var rootEl = document.documentElement;
  var topbar = document.querySelector('.topbar');
  var stage = document.getElementById('stage');
  var os = document.getElementById('os');
  var row = document.querySelector('.topbar__left');
  if (!topbar || !stage || !os || !row) return { error: 'shell parts missing' };
  var probe = function (value) {
    rootEl.style.setProperty('--cys-top-clearance', value);
    var tb = topbar.getBoundingClientRect();
    var st = stage.getBoundingClientRect();
    var ob = os.getBoundingClientRect();
    var rb = row.getBoundingClientRect();
    var cs = getComputedStyle(topbar);
    var hit = document.elementFromPoint(Math.round(tb.left + tb.width / 2), 24);
    return {
      height: Math.round(tb.height),
      top: Math.round(tb.top),
      width: Math.round(tb.width),
      padTop: Math.round(parseFloat(cs.paddingTop) || 0),
      rowTop: Math.round(rb.top),
      stageTop: Math.round(st.top),
      stageHeight: Math.round(st.height),
      osHeight: Math.round(ob.height),
      overflowX: Math.round(rootEl.scrollWidth - rootEl.clientWidth),
      bandHit: !!(hit && hit.closest && hit.closest('.topbar')),
      painted: cs.backgroundImage !== 'none',
      tourOpen: !!document.querySelector('.tour.is-open')
    };
  };
  var base = probe('0px');
  var mac = probe('48px');
  var other = probe('37px');
  var back = probe('');
  return { base: base, mac: mac, other: other, back: back, viewport: window.innerHeight };
});
const ctBase = (clearance && clearance.base) || {};
const ctMac = (clearance && clearance.mac) || {};
const ctOther = (clearance && clearance.other) || {};
const ctBack = (clearance && clearance.back) || {};
const ctViewport = clearance && clearance.viewport;
if (!clearance || clearance.error) bad('top clearance probe runs', JSON.stringify(clearance));
else if (ctBase.height === 56 && ctBase.padTop === 0 && ctBase.top === 0) ok('top bar sits flush at the top when there is no clearance', JSON.stringify(ctBase));
else bad('top bar sits flush at the top when there is no clearance', JSON.stringify(ctBase));
if (!clearance || clearance.error) bad('the 48px band is painted by the page top bar', 'probe failed');
else if (ctMac.top === 0 && ctMac.height === 104 && ctMac.bandHit && ctMac.painted && !ctMac.tourOpen) ok('the 48px band is painted by the page top bar', JSON.stringify(ctMac));
else bad('the 48px band is painted by the page top bar', JSON.stringify(ctMac));
if (!clearance || clearance.error) bad('top bar content keeps its row, shifted by exactly the clearance', 'probe failed');
else if (ctMac.padTop === 48 && ctMac.rowTop - ctBase.rowTop === 48) ok('top bar content keeps its row, shifted by exactly the clearance', 'padTop=' + ctMac.padTop + ' rowTop ' + ctBase.rowTop + ' -> ' + ctMac.rowTop);
else bad('top bar content keeps its row, shifted by exactly the clearance', 'padTop=' + ctMac.padTop + ' rowTop ' + ctBase.rowTop + ' -> ' + ctMac.rowTop);
if (!clearance || clearance.error) bad('the stage gives up the clearance and the desk keeps 100dvh', 'probe failed');
else if (ctMac.stageTop === 104 && ctMac.stageHeight === ctBase.stageHeight - 48 && ctMac.osHeight === ctViewport) ok('the stage gives up the clearance and the desk keeps 100dvh', 'stage ' + ctBase.stageHeight + ' -> ' + ctMac.stageHeight + ', desk=' + ctMac.osHeight);
else bad('the stage gives up the clearance and the desk keeps 100dvh', JSON.stringify(ctMac));
if (!clearance || clearance.error) bad('the clearance band causes no horizontal overflow', 'probe failed');
else if (ctMac.overflowX === 0 && ctMac.width === ctBase.width) ok('the clearance band causes no horizontal overflow', 'overflowX=' + ctMac.overflowX + ' width=' + ctMac.width);
else bad('the clearance band causes no horizontal overflow', 'overflowX=' + ctMac.overflowX + ' width=' + ctMac.width);
if (!clearance || clearance.error) bad('the band is driven by the variable, not a hard-coded 48px', 'probe failed');
else if (ctOther.height === 93 && ctOther.padTop === 37 && ctOther.stageHeight === ctBase.stageHeight - 37 && ctOther.bandHit) ok('the band is driven by the variable, not a hard-coded 48px', JSON.stringify(ctOther));
else bad('the band is driven by the variable, not a hard-coded 48px', JSON.stringify(ctOther));
if (!clearance || clearance.error) bad('clearing the variable restores the 56px top bar', 'probe failed');
else if (ctBack.height === 56 && ctBack.padTop === 0 && ctBack.rowTop === ctBase.rowTop && ctBack.stageHeight === ctBase.stageHeight && ctBack.overflowX === 0) ok('clearing the variable restores the 56px top bar', JSON.stringify(ctBack));
else bad('clearing the variable restores the 56px top bar', JSON.stringify(ctBack));

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

// --- 状态两项各占整行，不许逐字竖排（回归：10px 首列挤压中文） ---
const repeatRow = await run(function () {
  var shell = document.querySelector('.window[data-app=calendar]');
  var btn = shell.querySelector('[aria-label^=编辑待办], [aria-label^="编辑待办"]');
  if (!btn) return { error: 'no edit button' };
  btn.click();
  var dialog = document.querySelector('.paper-dialog[open]');
  if (!dialog) return { error: 'no dialog' };
  var labels = dialog.querySelectorAll('.priority-list--repeat .priority-option__label');
  var out = { count: labels.length, rows: [], labels: [] };
  for (var i = 0; i < labels.length; i += 1) {
    var r = labels[i].getBoundingClientRect();
    out.rows.push({ w: Math.round(r.width), h: Math.round(r.height) });
    out.labels.push(labels[i].textContent);
  }
  dialog.close();
  return out;
});
if (repeatRow && repeatRow.count === 2
    && repeatRow.labels.join('|') === '仅限今日|每天，直到解决'
    && repeatRow.rows.every(function (row) { return row.h < 30 && row.w > 60; })) {
  ok('repeat status renders on one line each', JSON.stringify(repeatRow));
} else {
  bad('repeat status renders on one line each', JSON.stringify(repeatRow));
}

// --- 命令面板已经并进设置：只有一个入口，Ctrl+K 落在命令分区 ---
const commandHome = await run(function () {
  var P = window.PaperOS;
  P.tour.close();
  var overlay = document.querySelector('.palette-layer, .palette');
  var topbarButton = document.getElementById('palette-btn');
  P.shell.openSettings('commands');
  var win = P.wm.getWindows().filter(function (w) { return w.appId === 'settings'; })[0];
  var shellEl = document.querySelector('.window[data-app="settings"]');
  var nav = shellEl ? shellEl.querySelector('[data-section="commands"]') : null;
  return {
    overlayGone: !overlay,
    topbarButtonGone: !topbarButton,
    settingsOpened: !!win,
    commandPanel: !!document.querySelector('[data-section-panel="commands"] .command-sheet'),
    navLabel: nav ? nav.textContent : null
  };
});
if (commandHome && commandHome.overlayGone && commandHome.topbarButtonGone && commandHome.settingsOpened
    && commandHome.commandPanel && commandHome.navLabel === '命令与应用') {
  ok('command palette lives inside settings only', JSON.stringify(commandHome));
} else {
  bad('command palette lives inside settings only', JSON.stringify(commandHome));
}

// --- 命令列表真的能过滤、能回车执行 ---
const commandRun = await run(function () {
  var P = window.PaperOS;
  var input = document.querySelector('[data-command-input]');
  if (!input) return { error: 'no input' };
  input.value = '便签';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  var rows = document.querySelectorAll('.command-item');
  var first = rows[0];
  var name = first ? first.querySelector('.command-item__name').textContent : null;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  var settingsWindow = P.wm.getWindows().filter(function (w) { return w.appId === 'settings'; })[0];
  var stickyWindow = P.wm.getWindows().filter(function (w) { return w.appId === 'stickies'; })[0];
  return {
    filtered: rows.length,
    firstName: name,
    settingsCollapsed: settingsWindow ? !!settingsWindow.minimized : false,
    openedApp: !!stickyWindow
  };
});
if (commandRun && commandRun.filtered >= 1 && commandRun.firstName === '打开 便签'
    && commandRun.openedApp && commandRun.settingsCollapsed) {
  ok('command list filters and runs from the settings panel', JSON.stringify(commandRun));
} else {
  bad('command list filters and runs from the settings panel', JSON.stringify(commandRun));
}

// --- 应用坞顺序：拖拽持久化、未知 id 丢弃、缺项补齐 ---
const dockOrder = await run(function () {
  var P = window.PaperOS;
  var before = Array.prototype.map.call(document.querySelectorAll('[data-dock-app]'), function (n) { return n.getAttribute('data-dock-app'); });
  P.data.setPrefs({ dockOrder: ['draw', 'nope', 'stickies', 'draw'] });
  P.shell.buildDock();
  var after = Array.prototype.map.call(document.querySelectorAll('[data-dock-app]'), function (n) { return n.getAttribute('data-dock-app'); });
  P.data.setPrefs({ dockOrder: [] });
  P.shell.buildDock();
  var reset = Array.prototype.map.call(document.querySelectorAll('[data-dock-app]'), function (n) { return n.getAttribute('data-dock-app'); });
  return { before: before, after: after, reset: reset, apps: before.length };
});
if (dockOrder && dockOrder.after[0] === 'draw' && dockOrder.after[1] === 'stickies'
    && dockOrder.after.length === dockOrder.apps
    && dockOrder.after.join(',') !== dockOrder.before.join(',')
    && dockOrder.reset.join(',') === dockOrder.before.join(',')) {
  ok('dock order is persisted, de-duplicated and completed', JSON.stringify(dockOrder));
} else {
  bad('dock order is persisted, de-duplicated and completed', JSON.stringify(dockOrder));
}

// --- 真拖拽：pointerdown → 移动 → pointerup，顺序落盘 ---
const dockDrag = await run(function () {
  var P = window.PaperOS;
  var buttons = Array.prototype.slice.call(document.querySelectorAll('[data-dock-app]'));
  var first = buttons[0];
  var last = buttons[buttons.length - 1];
  var a = first.getBoundingClientRect();
  var b = last.getBoundingClientRect();
  var opts = { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true };
  first.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ clientX: a.left + a.width / 2, clientY: a.top + a.height / 2 }, opts)));
  window.dispatchEvent(new PointerEvent('pointermove', Object.assign({ clientX: b.left + b.width + 30, clientY: a.top + a.height / 2 }, opts)));
  window.dispatchEvent(new PointerEvent('pointerup', Object.assign({ clientX: b.left + b.width + 30, clientY: a.top + a.height / 2 }, opts)));
  var after = Array.prototype.map.call(document.querySelectorAll('[data-dock-app]'), function (n) { return n.getAttribute('data-dock-app'); });
  var saved = P.data.getPrefs().dockOrder;
  var clicked = null;
  return { before: buttons.length, movedTo: after.indexOf(first.getAttribute('data-dock-app')), after: after, saved: saved, draggingLeft: !!document.querySelector('.dock__btn.is-dragging') };
});
if (dockDrag && dockDrag.movedTo === dockDrag.before - 1 && !dockDrag.draggingLeft
    && JSON.stringify(dockDrag.saved) === JSON.stringify(dockDrag.after)) {
  ok('dragging a dock icon reorders and persists', JSON.stringify(dockDrag));
} else {
  bad('dragging a dock icon reorders and persists', JSON.stringify(dockDrag));
}

// --- 拖到最左/最右/坞外都要有确定落点，不能「往左拖反而跑到末尾」 ---
const dockEdges = await run(function () {
  var P = window.PaperOS;
  function dragRightmostTo(x) {
    P.data.setPrefs({ dockOrder: [] });
    P.shell.buildDock();
    var buttons = Array.prototype.slice.call(document.querySelectorAll('[data-dock-app]'));
    var last = buttons[buttons.length - 1];
    var r = last.getBoundingClientRect();
    var o = { bubbles: true, pointerId: 21, pointerType: 'mouse', button: 0, isPrimary: true };
    last.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ clientX: r.left + 8, clientY: r.top + 8 }, o)));
    window.dispatchEvent(new PointerEvent('pointermove', Object.assign({ clientX: x, clientY: r.top + 8 }, o)));
    window.dispatchEvent(new PointerEvent('pointerup', Object.assign({ clientX: x, clientY: r.top + 8 }, o)));
    var order = P.data.getPrefs().dockOrder;
    P.data.setPrefs({ dockOrder: [] });
    P.shell.buildDock();
    return order;
  }
  var first = document.querySelector('[data-dock-app]').getBoundingClientRect();
  var lastBtn = document.querySelectorAll('[data-dock-app]')[4].getBoundingClientRect();
  var toLeft = dragRightmostTo(first.left - 80);
  var toRight = dragRightmostTo(lastBtn.right + 200);
  return { toLeft: toLeft, toRight: toRight };
});
if (dockEdges && dockEdges.toLeft[0] === 'draw' && dockEdges.toRight[4] === 'draw') {
  ok('dropping at the edges lands where the pointer is', JSON.stringify(dockEdges));
} else {
  bad('dropping at the edges lands where the pointer is', JSON.stringify(dockEdges));
}

// 这一段会动窗口（点击坞图标=聚焦/最小化）。跑完把现场恢复，
// 否则后面的日历/提示词用例会对着被最小化的窗口找节点。
const restoreDesk = async () => {
  await run(function () {
    var P = window.PaperOS;
    P.data.setPrefs({ dockOrder: [] });
    P.shell.buildDock();
    P.wm.getWindows().forEach(function (w) {
      if (w.appId === 'settings') { P.wm.close(w.id); return; }
      if (w.minimized) P.wm.restore(w.id);
    });
    return 1;
  });
  await sleep(120);
};

// --- 点图标仍然只打开，不会被 6px 阈值误当成拖拽 ---
const dockClick = await run(function () {
  var P = window.PaperOS;
  P.data.setPrefs({ dockOrder: [] });
  P.shell.buildDock();
  var btn = document.querySelector('[data-dock-app="calendar"]');
  var r = btn.getBoundingClientRect();
  var opts = { bubbles: true, pointerId: 2, pointerType: 'mouse', button: 0, isPrimary: true };
  btn.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ clientX: r.left + 4, clientY: r.top + 4 }, opts)));
  window.dispatchEvent(new PointerEvent('pointermove', Object.assign({ clientX: r.left + 7, clientY: r.top + 6 }, opts)));
  window.dispatchEvent(new PointerEvent('pointerup', Object.assign({ clientX: r.left + 7, clientY: r.top + 6 }, opts)));
  btn.click();
  var out = {
    orderUntouched: JSON.stringify(P.data.getPrefs().dockOrder) === '[]',
    calendarWindow: !!P.wm.getWindows().filter(function (w) { return w.appId === 'calendar'; })[0]
  };
  return out;
});
if (dockClick && dockClick.orderUntouched && dockClick.calendarWindow) {
  ok('a small jitter still counts as a click', JSON.stringify(dockClick));
} else {
  bad('a small jitter still counts as a click', JSON.stringify(dockClick));
}

await restoreDesk();

// --- 拖完不应该顺手把应用打开（浏览器会补发一次 click） ---
const dockDragNoClick = await run(function () {
  var P = window.PaperOS;
  P.data.setPrefs({ dockOrder: [] });
  P.shell.buildDock();
  // 先关掉 notes，这样「被拖拽后的补发 click 打开」才会真的多出一扇窗
  P.wm.getWindows().forEach(function (w) { if (w.appId === 'notes') P.wm.close(w.id); });
  var before = P.wm.getWindows().filter(function (w) { return w.appId === 'notes'; }).length;
  var buttons = Array.prototype.slice.call(document.querySelectorAll('[data-dock-app]'));
  var bs = buttons.filter(function (n) { return n.getAttribute('data-dock-app') === 'notes'; })[0];
  if (!bs) return { error: 'notes button missing' };
  var a = bs.getBoundingClientRect();
  var o = { bubbles: true, pointerId: 7, pointerType: 'mouse', button: 0, isPrimary: true };
  bs.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ clientX: a.left + 10, clientY: a.top + 10 }, o)));
  window.dispatchEvent(new PointerEvent('pointermove', Object.assign({ clientX: a.left + 90, clientY: a.top + 10 }, o)));
  window.dispatchEvent(new PointerEvent('pointerup', Object.assign({ clientX: a.left + 90, clientY: a.top + 10 }, o)));
  bs.click();
  var after = P.wm.getWindows().filter(function (w) { return w.appId === 'notes'; }).length;
  P.data.setPrefs({ dockOrder: [] });
  P.shell.buildDock();
  return { before: before, after: after };
});
await restoreDesk();

// --- 取消手势不能落盘：pointercancel 只清理，不提交 ---
const dockCancel = await run(function () {
  var P = window.PaperOS;
  P.data.setPrefs({ dockOrder: [] });
  P.shell.buildDock();
  var buttons = Array.prototype.slice.call(document.querySelectorAll('[data-dock-app]'));
  var first = buttons[0];
  var third = buttons[2];
  var a = first.getBoundingClientRect();
  var c = third.getBoundingClientRect();
  var o = { bubbles: true, pointerId: 31, pointerType: 'touch', button: 0, isPrimary: true };
  first.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ clientX: a.left + 20, clientY: a.top + 20 }, o)));
  window.dispatchEvent(new PointerEvent('pointermove', Object.assign({ clientX: c.left + 20, clientY: a.top + 20 }, o)));
  var midway = { dragging: !!document.querySelector('.dock__btn.is-dragging'), marker: !!document.querySelector('.is-drop-before, .is-drop-after') };
  window.dispatchEvent(new PointerEvent('pointercancel', Object.assign({ clientX: c.left + 20, clientY: a.top + 20 }, o)));
  var afterCancel = {
    order: P.data.getPrefs().dockOrder,
    dragging: !!document.querySelector('.dock__btn.is-dragging'),
    marker: !!document.querySelector('.is-drop-before, .is-drop-after')
  };
  return { midway: midway, afterCancel: afterCancel };
});
if (dockCancel && dockCancel.midway.dragging && dockCancel.midway.marker
    && Array.isArray(dockCancel.afterCancel.order) && dockCancel.afterCancel.order.length === 0
    && !dockCancel.afterCancel.dragging && !dockCancel.afterCancel.marker) {
  ok('a cancelled gesture leaves no order and no leftovers', JSON.stringify(dockCancel));
} else {
  bad('a cancelled gesture leaves no order and no leftovers', JSON.stringify(dockCancel));
}

await restoreDesk();

// --- 命令列表：活动项要能被读屏跟着走 ---
const commandAria = await run(function () {
  var P = window.PaperOS;
  P.shell.openSettings('commands');
  var input = document.querySelector('[data-command-input]');
  if (!input) return { error: 'no input' };
  var role = input.getAttribute('role');
  var controls = input.getAttribute('aria-controls');
  var firstDesc = input.getAttribute('aria-activedescendant');
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  var secondDesc = input.getAttribute('aria-activedescendant');
  var target = secondDesc ? document.getElementById(secondDesc) : null;
  var listbox = controls ? document.getElementById(controls) : null;
  return {
    role: role, controls: controls, bound: !!listbox,
    firstDesc: firstDesc, secondDesc: secondDesc,
    descIsOption: !!(target && target.getAttribute('role') === 'option'),
    changed: firstDesc !== secondDesc
  };
});
if (commandAria && commandAria.role === 'combobox' && commandAria.bound && commandAria.descIsOption && commandAria.changed) {
  ok('command list announces the active option', JSON.stringify(commandAria));
} else {
  bad('command list announces the active option', JSON.stringify(commandAria));
}


// --- 深色下前景窗口必须和普通窗口分得开 ---
const darkFocus = await run(function () {
  var P = window.PaperOS;
  P.data.setPrefs({ theme: 'dark' });
  P.shell.applyPrefs();
  P.wm.open('calendar');
  P.wm.open('notes');
  var wins = P.wm.getWindows();
  var focusedEl = document.querySelector('.window.is-focused');
  var otherEl = document.querySelector('.window:not(.is-focused)');
  var out = {
    focused: focusedEl ? getComputedStyle(focusedEl).boxShadow : null,
    other: otherEl ? getComputedStyle(otherEl).boxShadow : null,
    borderFocused: focusedEl ? getComputedStyle(focusedEl).borderTopColor : null,
    borderOther: otherEl ? getComputedStyle(otherEl).borderTopColor : null
  };
  // 只认阴影差异：边框在不同主题下本来就不同，拿它当证据会掩盖「投影被压平」。
  out.differs = !!out.focused && !!out.other && out.focused !== out.other;
  P.data.setPrefs({ theme: 'light' });
  P.shell.applyPrefs();
  return out;
});
if (darkFocus && darkFocus.differs) ok('dark mode still separates the focused window', JSON.stringify(darkFocus));
else bad('dark mode still separates the focused window', JSON.stringify(darkFocus));

// --- 深色下坞提示条必须看得清（白底白字第 N 次） ---
const darkTooltip = await run(function () {
  var P = window.PaperOS;
  P.data.setPrefs({ theme: 'dark' });
  P.shell.applyPrefs();
  function lum(rgb) {
    var m = /rgba?\(([0-9.]+), ?([0-9.]+), ?([0-9.]+)/.exec(rgb);
    if (!m) return null;
    var ch = [m[1], m[2], m[3]].map(function (v) {
      var c = Number(v) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }
  var tips = document.querySelectorAll('.dock__tip');
  var worst = null;
  for (var i = 0; i < tips.length; i += 1) {
    var cs = getComputedStyle(tips[i]);
    var fg = lum(cs.color);
    var bg = lum(cs.backgroundColor);
    if (fg === null || bg === null) continue;
    var hi = Math.max(fg, bg);
    var lo = Math.min(fg, bg);
    var ratio = (hi + 0.05) / (lo + 0.05);
    if (worst === null || ratio < worst.ratio) {
      worst = { ratio: Math.round(ratio * 100) / 100, color: cs.color, bg: cs.backgroundColor, text: tips[i].textContent };
    }
  }
  P.data.setPrefs({ theme: 'light' });
  P.shell.applyPrefs();
  return { count: tips.length, worst: worst };
});
if (darkTooltip && darkTooltip.count >= 5 && darkTooltip.worst && darkTooltip.worst.ratio >= 4.5) {
  ok('dark dock tooltip stays readable', JSON.stringify(darkTooltip.worst));
} else {
  bad('dark dock tooltip stays readable', JSON.stringify(darkTooltip));
}

// --- Ctrl+K 真的落到命令分区（走键盘 handler，不是直接调 API）---
const ctrlKOpen = await run(function () {
  var P = window.PaperOS;
  P.wm.getWindows().forEach(function (w) { if (w.appId === 'settings') P.wm.close(w.id); });
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  var win = P.wm.getWindows().filter(function (w) { return w.appId === 'settings'; })[0];
  var panel = document.querySelector('[data-section-panel="commands"]');
  return {
    opened: !!win,
    panelVisible: !!(panel && !panel.hidden),
    overlay: !!document.querySelector('.palette-layer')
  };
});
// 分区渲染会把焦点放到搜索框，但那是一次 setTimeout(40)，所以等一拍再读。
await sleep(400);
const ctrlKFocus = await run(function () {
  var input = document.querySelector('[data-command-input]');
  return { focusedInput: !!(input && document.activeElement === input) };
});
const ctrlK = Object.assign({}, ctrlKOpen, ctrlKFocus);
await run(function () {
  var P = window.PaperOS;
  P.wm.getWindows().forEach(function (w) { if (w.appId === 'settings') P.wm.close(w.id); });
  return 1;
});
if (ctrlK && ctrlK.opened && ctrlK.panelVisible && ctrlK.focusedInput && !ctrlK.overlay) ok('Ctrl+K opens the command section in settings', JSON.stringify(ctrlK));
else bad('Ctrl+K opens the command section in settings', JSON.stringify(ctrlK));

// --- 键盘移动应用坞要播报位置 ---
const dockAnnounce = await run(function () {
  var P = window.PaperOS;
  P.data.setPrefs({ dockOrder: [] });
  P.shell.buildDock();
  var btn = document.querySelectorAll('[data-dock-app]')[1];
  btn.focus();
  btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true }));
  var live = document.getElementById('dock-live');
  return { text: live ? live.textContent : null, order: P.data.getPrefs().dockOrder };
});
if (dockAnnounce && /第 3 位，共 5 位/.test(dockAnnounce.text || '')) {
  ok('keyboard reorder announces the new position', JSON.stringify(dockAnnounce));
} else {
  bad('keyboard reorder announces the new position', JSON.stringify(dockAnnounce));
}

if (dockDragNoClick && dockDragNoClick.before === dockDragNoClick.after) {
  ok('a finished drag does not also open the app', JSON.stringify(dockDragNoClick));
} else {
  bad('a finished drag does not also open the app', JSON.stringify(dockDragNoClick));
}


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

// --- prompts app: CRUD, search, pin, persistence, clearing samples ---
const promptApi = await run(function () {
  var P = window.PaperOS;
  if (!P || !P.data.createPrompt) return { __err: 'createPrompt missing' };
  P.wm.open('prompts');
  var w = P.wm.getWindows().filter(function (x) { return x.appId === 'prompts'; })[0];
  var created = P.data.createPrompt({ title: '', body: '第一行标题取自正文\n第二行内容' });
  return {
    opened: !!w,
    created: created ? { title: created.title, body: created.body, pinned: created.pinned, sample: created.sample } : null,
    count: P.data.listPrompts('').length
  };
});
if (promptApi && promptApi.opened) ok('prompts app opens');
else bad('prompts app opens', JSON.stringify(promptApi));
if (promptApi && promptApi.created && promptApi.created.title === '第一行标题取自正文') ok('empty title falls back to the first body line', promptApi.created.title);
else bad('empty title falls back to the first body line', JSON.stringify(promptApi && promptApi.created));
if (promptApi && promptApi.created && promptApi.created.body.indexOf('\n') !== -1) ok('prompt body keeps its newlines');
else bad('prompt body keeps its newlines', JSON.stringify(promptApi && promptApi.created));
if (promptApi && promptApi.created && promptApi.created.sample === false) ok('user prompts are not marked as samples');
else bad('user prompts are not marked as samples', JSON.stringify(promptApi && promptApi.created));

const promptDom = await run(function () {
  var P = window.PaperOS;
  var list = document.querySelector('[data-testid="prompt-list"]');
  var counts = document.querySelector('[data-testid="prompt-count-total"]');
  var items = document.querySelectorAll('[data-testid="prompt-item"]');
  var search = document.querySelector('[data-testid="prompt-search"]');
  var head = document.querySelector('[data-testid="prompt-heading"]');
  return {
    listFound: !!list,
    items: items.length,
    countText: counts ? counts.textContent : '',
    hasSearch: !!search,
    firstTitle: (P.data.listPrompts('')[0] || {}).title || '',
    heading: head ? head.textContent : '',
    editorTitle: (document.querySelector('[data-testid="prompt-title"]') || {}).value || ''
  };
});
if (promptDom && promptDom.listFound && promptDom.items >= 4) ok('prompt list renders rows', 'rows=' + promptDom.items + ' ' + promptDom.countText);
else bad('prompt list renders rows', JSON.stringify(promptDom));
if (promptDom && promptDom.hasSearch) ok('prompt list has a search box');
else bad('prompt list has a search box', JSON.stringify(promptDom));
if (promptDom && promptDom.editorTitle === '调研同类产品再动手') ok('editor opens on the first prompt', promptDom.editorTitle);
else bad('editor opens on the first prompt', JSON.stringify(promptDom && promptDom.heading));

const uiNew = await run(function () {
  var button = document.querySelector('[data-testid="new-prompt"]');
  if (!button) return { __err: 'new button missing' };
  var before = window.PaperOS.data.listPrompts('').length;
  button.click();
  var titleInput = document.querySelector('[data-testid="prompt-title"]');
  var heading = document.querySelector('[data-testid="prompt-heading"]');
  return {
    before: before,
    after: window.PaperOS.data.listPrompts('').length,
    editorTitle: titleInput ? titleInput.value : null,
    titlePlaceholder: titleInput ? titleInput.placeholder : null,
    heading: heading ? heading.textContent : ''
  };
});
if (uiNew && uiNew.after === uiNew.before + 1) ok('the new button creates a prompt');
else bad('the new button creates a prompt', JSON.stringify(uiNew));
if (uiNew && uiNew.editorTitle === '' && uiNew.titlePlaceholder === '未命名提示词' && uiNew.heading === '未命名提示词') ok('a new prompt opens with an empty title + placeholder', JSON.stringify({ placeholder: uiNew.titlePlaceholder }));
else bad('a new prompt opens with an empty title + placeholder', JSON.stringify(uiNew));

// --- typing must survive the autosave round-trip ---
// Regression 0.3.0: every commit rebuilt the editor DOM, so focus died after the
// first keystroke and the field could only be filled by pasting. These drive the
// real input path (CDP Input.insertText), not element.value.
await send('Runtime.evaluate', { expression: "document.querySelector('[data-testid=\"prompt-title\"]').focus()" });
await send('Input.insertText', { text: '打字标题' });
await sleep(500);
await send('Input.insertText', { text: '续写' });
await sleep(250);
const typedTitle = await run(function () {
  var t = document.querySelector('[data-testid="prompt-title"]');
  var first = window.PaperOS.data.listPrompts('')[0];
  return {
    value: t ? t.value : null,
    focused: document.activeElement === t,
    stored: first ? first.title : null
  };
});
if (typedTitle && typedTitle.value === '打字标题续写') ok('typing into the title keeps focus past the autosave', typedTitle.value);
else bad('typing into the title keeps focus past the autosave', JSON.stringify(typedTitle));
if (typedTitle && typedTitle.focused) ok('the title field still owns focus after saving');
else bad('the title field still owns focus after saving', JSON.stringify(typedTitle && typedTitle.focused));
if (typedTitle && typedTitle.stored === '打字标题续写') ok('the typed title reached the store', typedTitle.stored);
else bad('the typed title reached the store', JSON.stringify(typedTitle && typedTitle.stored));

await send('Runtime.evaluate', { expression: "document.querySelector('[data-testid=\"prompt-body\"]').focus()" });
await send('Input.insertText', { text: '第一行' });
await sleep(350);
await send('Input.insertText', { text: '第二行' });
await sleep(250);
const typedBody = await run(function () {
  var b = document.querySelector('[data-testid="prompt-body"]');
  var first = window.PaperOS.data.listPrompts('')[0];
  return {
    value: b ? b.value : null,
    focused: document.activeElement === b,
    stored: first ? first.body : null
  };
});
if (typedBody && typedBody.value === '第一行第二行') ok('typing into the body keeps focus past the autosave', typedBody.value);
else bad('typing into the body keeps focus past the autosave', JSON.stringify(typedBody));
if (typedBody && typedBody.focused) ok('the body field still owns focus after saving');
else bad('the body field still owns focus after saving', JSON.stringify(typedBody && typedBody.focused));
if (typedBody && typedBody.stored === '第一行第二行') ok('the typed body reached the store', typedBody.stored);
else bad('the typed body reached the store', JSON.stringify(typedBody && typedBody.stored));

const pinned = await run(function () {
  var P = window.PaperOS;
  var first = P.data.listPrompts('')[0];
  P.data.updatePrompt(first.id, { pinned: true });
  var listed = P.data.listPrompts('')[0];
  return { id: first.id, topId: listed.id, pinned: listed.pinned };
});
if (pinned && pinned.topId === pinned.id && pinned.pinned === true) ok('pinned prompt sorts first');
else bad('pinned prompt sorts first', JSON.stringify(pinned));

const searched = await run(function () {
  var P = window.PaperOS;
  var hit = P.data.listPrompts('第二行内容');
  var miss = P.data.listPrompts('不存在的关键词xyz');
  return { hit: hit.length, miss: miss.length };
});
if (searched && searched.hit >= 1 && searched.miss === 0) ok('search matches body text and rejects misses', JSON.stringify(searched));
else bad('search matches body text and rejects misses', JSON.stringify(searched));

const renamed = await run(function () {
  var P = window.PaperOS;
  var first = P.data.listPrompts('')[0];
  P.data.updatePrompt(first.id, { title: '改过的标题' });
  return P.data.getPrompt(first.id).title;
});
if (renamed === '改过的标题') ok('prompt title can be edited');
else bad('prompt title can be edited', String(renamed));

const duplicated = await run(function () {
  var P = window.PaperOS;
  var first = P.data.listPrompts('')[0];
  var before = P.data.listPrompts('').length;
  var copy = P.data.duplicatePrompt(first.id);
  return { before: before, after: P.data.listPrompts('').length, title: copy ? copy.title : null };
});
if (duplicated && duplicated.after === duplicated.before + 1 && /副本/.test(duplicated.title || '')) ok('prompt can be duplicated', JSON.stringify(duplicated));
else bad('prompt can be duplicated', JSON.stringify(duplicated));

const deleted = await run(function () {
  var P = window.PaperOS;
  var all = P.data.listPrompts('');
  var victim = all[all.length - 1];
  var before = all.length;
  P.data.deletePrompt(victim.id);
  return { before: before, after: P.data.listPrompts('').length, gone: P.data.getPrompt(victim.id) === null };
});
if (deleted && deleted.after === deleted.before - 1 && deleted.gone) ok('prompt can be deleted');
else bad('prompt can be deleted', JSON.stringify(deleted));

const promptRoundTrip = await run(function () {
  var P = window.PaperOS;
  /* pick the prompt whose body we created above, not "whatever is first" */
  var target = P.data.listPrompts('第二行内容')[0];
  if (!target) return { __err: 'target prompt missing' };
  var snap = P.data.snapshotData();
  var ingested = P.ingestWorkspace(JSON.parse(JSON.stringify(snap)));
  if (!ingested.ok) return { __err: ingested.error };
  var back = ingested.snapshot.prompts.filter(function (p) { return p.id === target.id; })[0];
  return {
    count: ingested.snapshot.prompts.length,
    kept: back ? { title: back.title, body: back.body, pinned: back.pinned } : null
  };
});
if (promptRoundTrip && promptRoundTrip.kept && promptRoundTrip.kept.body === '第一行标题取自正文\n第二行内容' && promptRoundTrip.kept.title === '第一行标题取自正文') ok('prompt fields survive validate round-trip', JSON.stringify(promptRoundTrip.kept));
else bad('prompt fields survive validate round-trip', JSON.stringify(promptRoundTrip));

const promptSeeding = await run(function () {
  var P = window.PaperOS;
  var snap = P.data.snapshotData();
  /* a v3 file written before the library existed has no prompts key at all */
  var legacy = JSON.parse(JSON.stringify(snap));
  legacy.version = 3;
  delete legacy.prompts;
  var legacyResult = P.ingestWorkspace(legacy);
  /* but an explicitly emptied library (the user cleared the examples) must stay empty */
  var emptied = JSON.parse(JSON.stringify(snap));
  emptied.prompts = [];
  emptied.meta = Object.assign({}, emptied.meta, { sampleClearedAt: Date.now(), promptsSeededAt: Date.now() });
  var emptyResult = P.ingestWorkspace(emptied);
  return {
    legacyOk: legacyResult.ok,
    legacyCount: legacyResult.ok ? legacyResult.snapshot.prompts.length : -1,
    emptyOk: emptyResult.ok,
    emptyCount: emptyResult.ok ? emptyResult.snapshot.prompts.length : -1
  };
});
if (promptSeeding && promptSeeding.legacyOk && promptSeeding.legacyCount === 3) ok('a v3 file without a prompts field gets the native samples', 'count=' + promptSeeding.legacyCount);
else bad('a v3 file without a prompts field gets the native samples', JSON.stringify(promptSeeding));
if (promptSeeding && promptSeeding.emptyOk && promptSeeding.emptyCount === 0) ok('an emptied prompt library is not refilled', 'count=' + promptSeeding.emptyCount);
else bad('an emptied prompt library is not refilled', JSON.stringify(promptSeeding));

const promptLimits = await run(function () {
  var P = window.PaperOS;
  var snap = P.data.snapshotData();
  /* body over the published cap must be refused by the single ingest gate */
  var tooLong = JSON.parse(JSON.stringify(snap));
  tooLong.prompts = [{ id: 'prompt_toolong', title: '超长', body: new Array(20002).join('x'), pinned: false, createdAt: 1, updatedAt: 1 }];
  var longResult = P.ingestWorkspace(tooLong);
  /* an id-less prompt must be refused too */
  var badId = JSON.parse(JSON.stringify(snap));
  badId.prompts = [{ id: 'has spaces', title: 't', body: 'b' }];
  var idResult = P.ingestWorkspace(badId);
  /* a non-array prompts field must be refused */
  var badShape = JSON.parse(JSON.stringify(snap));
  badShape.prompts = { nope: true };
  var shapeResult = P.ingestWorkspace(badShape);
  /* 301 entries exceed the library limit */
  var tooMany = JSON.parse(JSON.stringify(snap));
  tooMany.prompts = [];
  for (var i = 0; i < 301; i += 1) tooMany.prompts.push({ id: 'prompt_' + i, title: 't' + i, body: 'b' });
  var manyResult = P.ingestWorkspace(tooMany);
  return {
    tooLong: longResult.ok,
    badId: idResult.ok,
    badShape: shapeResult.ok,
    tooMany: manyResult.ok,
    cap: P.PROMPT_BODY_MAX,
    limit: P.PROMPT_LIMIT
  };
});
if (promptLimits && promptLimits.tooLong === false) ok('a prompt body past the cap is refused', 'cap=' + promptLimits.cap);
else bad('a prompt body past the cap is refused', JSON.stringify(promptLimits));
if (promptLimits && promptLimits.badId === false) ok('a prompt with an invalid id is refused');
else bad('a prompt with an invalid id is refused', JSON.stringify(promptLimits && promptLimits.badId));
if (promptLimits && promptLimits.badShape === false) ok('a non-array prompts field is refused');
else bad('a non-array prompts field is refused', JSON.stringify(promptLimits && promptLimits.badShape));
if (promptLimits && promptLimits.tooMany === false) ok('a library past the entry limit is refused', 'limit=' + promptLimits.limit);
else bad('a library past the entry limit is refused', JSON.stringify(promptLimits));

const samples = await run(function () {
  var P = window.PaperOS;
  var counts = P.data.getExampleCounts();
  var before = P.data.listPrompts('').length;
  var removed = P.data.clearExamples();
  var restored = P.data.insertSamplePrompts();
  var backIds = P.data.listPrompts('').filter(function (p) { return p.sample; }).map(function (p) { return p.id; }).sort();
  return {
    samplePrompts: counts.prompts,
    before: before,
    cleared: removed.prompts.length,
    after: P.data.listPrompts('').length - restored,
    left: 0,
    restored: restored,
    backIds: backIds
  };
});
if (samples && samples.samplePrompts >= 2 && samples.cleared === samples.samplePrompts && samples.left === 0 && samples.after === samples.before - samples.cleared) ok('sample prompts are counted and cleared with the other examples', JSON.stringify(samples));
else bad('sample prompts are counted and cleared with the other examples', JSON.stringify(samples));
const nativeIds = ['prompt_sample_agents', 'prompt_sample_align', 'prompt_sample_research'];
if (samples && samples.restored === 3 && JSON.stringify(samples.backIds) === JSON.stringify(nativeIds)) ok('the native samples can be put back from the empty state', JSON.stringify(samples.backIds));
else bad('the native samples can be put back from the empty state', JSON.stringify(samples && { restored: samples.restored, backIds: samples.backIds }));

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

// --- the clearance survives the narrow (side-panel) breakpoint ---
// The panel is a sidebar, so the <=820px rules are the ones macOS really hits.
// There .topbar sets padding with a shorthand: if that shorthand drops the
// variable, padding-top collapses and the strip is left unpainted.
await send('Emulation.setDeviceMetricsOverride', { width: 800, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(320);
const narrow = await run(function () {
  var P = window.PaperOS;
  if (P.tour && P.tour.close) P.tour.close();
  var rootEl = document.documentElement;
  var topbar = document.querySelector('.topbar');
  var row = document.querySelector('.topbar__left');
  if (!topbar || !row) return { error: 'shell parts missing' };
  var probe = function (value) {
    rootEl.style.setProperty('--cys-top-clearance', value);
    var tb = topbar.getBoundingClientRect();
    var rb = row.getBoundingClientRect();
    var cs = getComputedStyle(topbar);
    return {
      width: Math.round(tb.width),
      height: Math.round(tb.height),
      padTop: Math.round(parseFloat(cs.paddingTop) || 0),
      rowTop: Math.round(rb.top),
      overflowX: Math.round(rootEl.scrollWidth - rootEl.clientWidth)
    };
  };
  var base = probe('0px');
  var mac = probe('48px');
  var back = probe('');
  return { base: base, mac: mac, back: back, viewportW: window.innerWidth };
});
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(320);
// The resize above schedules a layout save (180ms debounce, 420ms flush). Settle it
// here: an unload journal left dirty would be preferred over the host snapshot on the
// next boot, which is correct product behaviour and would wrongly break the
// newer-version check below.
await sleep(260);
await ev('window.PaperOS.storage.flush()');
await sleep(140);
const settledPhase = await ev('window.PaperOS.storage.getStatus().phase');
if (settledPhase === 'saved') ok('the resize settles its pending layout save', 'phase=' + settledPhase);
else bad('the resize settles its pending layout save', 'phase=' + settledPhase);
const nwBase = (narrow && narrow.base) || {};
const nwMac = (narrow && narrow.mac) || {};
const nwBack = (narrow && narrow.back) || {};
if (!narrow || narrow.error) bad('the clearance band works at the narrow panel breakpoint', JSON.stringify(narrow));
else if (narrow.viewportW === 800 && nwBase.height === 50 && nwMac.padTop === 48 && nwMac.height === 98 && nwMac.rowTop - nwBase.rowTop === 48) ok('the clearance band works at the narrow panel breakpoint', JSON.stringify(narrow));
else bad('the clearance band works at the narrow panel breakpoint', JSON.stringify(narrow));
if (!narrow || narrow.error) bad('the narrow top bar stays free of horizontal overflow and collapses back', 'probe failed');
else if (nwMac.overflowX === 0 && nwMac.width === nwBase.width && nwBack.height === 50 && nwBack.padTop === 0 && nwBack.rowTop === nwBase.rowTop) ok('the narrow top bar stays free of horizontal overflow and collapses back', JSON.stringify(narrow));
else bad('the narrow top bar stays free of horizontal overflow and collapses back', JSON.stringify(narrow));

// --- a workspace from a NEWER version must not hang the desk ---
// Regression: v2.3's boot called a helper it could not see (different IIFE),
// threw ReferenceError before setting READY, and the host stayed on the
// loading overlay forever. The desk must boot read-only and say so.
const newerPage = join(OUT, 'page.newer.html');
const newerSnapshot = {
  format: 'paper-os/workspace',
  version: 99,
  nodes: [],
  stickies: [],
  tasks: [],
  prompts: [],
  prefs: {},
  /* the host snapshot only wins when it is at least as fresh as the local
     cache, so this must carry a far-future stamp */
  meta: { updatedAt: 4102444800000 }
};
const bootScript = '<' + 'script>window.__SCHEDULE_HOST_MODE__=true;window.__SCHEDULE_HOST_SNAPSHOT__='
  + JSON.stringify(newerSnapshot).replace(/</g, '\\u003c') + ';<' + '/script>';
writeFileSync(newerPage, readFileSync(PAGE, 'utf8').replace('<script>', bootScript + '<script>'));
pageErrors.length = 0;
await send('Page.navigate', { url: pathToFileURL(newerPage).href });
let newerReady = false;
for (let i = 0; i < 60; i += 1) {
  await sleep(200);
  if (await ev('!!window.__PAPER_OS_READY__')) { newerReady = true; break; }
}
if (newerReady) ok('a newer-version workspace still boots (no infinite loading)');
else bad('a newer-version workspace still boots (no infinite loading)', 'READY never became true');
const newerState = await run(function () {
  var P = window.PaperOS;
  var notice = document.querySelector('[data-testid="desk-notice"]');
  return {
    blocked: !!(P && P.storage && P.storage.blocked),
    bootError: window.__PAPER_OS_BOOT_ERROR__ || '',
    notice: notice ? notice.textContent : '',
    text: document.body.innerText.slice(0, 400)
  };
});
if (newerState && newerState.blocked) ok('a newer-version workspace is opened read-only');
else bad('a newer-version workspace is opened read-only', JSON.stringify(newerState && { blocked: newerState.blocked }));
if (newerState && /只读/.test(newerState.notice) && /更新/.test(newerState.notice)) ok('the read-only state is explained on screen', newerState.notice.slice(0, 40));
else bad('the read-only state is explained on screen', JSON.stringify(newerState && newerState.notice));
if (!newerState || !newerState.bootError) ok('boot does not throw on a newer-version workspace');
else bad('boot does not throw on a newer-version workspace', newerState.bootError);
if (!pageErrors.length) ok('no page exceptions on a newer-version workspace');
else bad('no page exceptions on a newer-version workspace', pageErrors.slice(0, 2).join(' | '));

if (!pageErrors.length) ok('no page exceptions');
else bad('no page exceptions', pageErrors.slice(0, 3).join(' | '));

// --- the English variant: generated page, dictionary + F() templates ---
if (!enMatch) {
  bad('the build ships an English page variant', 'PAGE_B64_EN missing from client.js');
} else {
  pageErrors.length = 0;
  await send('Page.navigate', { url: pathToFileURL(PAGE_EN).href });
  let enReady = await waitReady();
  if (enReady) {
    // file:// storage is shared between the two variants here; the zh run left a saved
    // desk behind. User data is never translated, so the English pass starts clean.
    await ev('window.PaperOS.storage.clearAll()');
    await ev('try { window.localStorage.clear(); } catch (err) {}');
    await send('Page.reload', { ignoreCache: true });
    enReady = await waitReady();
    pageErrors.length = 0;
  }
  if (enReady) ok('the English page boots');
  else bad('the English page boots', 'READY never became true');

  const enShape = await ev('({ lang: document.documentElement.lang, paperLang: (window.PaperOS && window.PaperOS.lang) || "", templates: !!window.__PAPER_TEMPLATES__, version: (window.PaperOS && window.PaperOS.version) || "" })');
  if (enShape && enShape.lang === 'en' && enShape.paperLang === 'en') ok('the English page declares lang=en and runs with P.lang=en', JSON.stringify(enShape));
  else bad('the English page declares lang=en and runs with P.lang=en', JSON.stringify(enShape));
  if (enShape && enShape.templates) ok('the English page carries its F() templates');
  else bad('the English page carries its F() templates', JSON.stringify(enShape));

  // F(): plural selection in the real browser runtime
  const enTemplates = await run(function () {
    var F = window.PaperOS.F;
    return {
      one: F('{n} 张纸页', 1),
      many: F('{n} 张纸页', 3),
      mins: F('{n} 分钟前', 5),
      pair: F('共 {n} 件 · 完成 {m} 件', { n: 3, m: 1 }),
      left: F('今天还有 {n} 件事没做。', 1),
      plain: F('用{color}画', { color: 'Sage' })
    };
  });
  if (enTemplates && enTemplates.one === '1 page' && enTemplates.many === '3 pages' && enTemplates.mins === '5 minutes ago') ok('F() picks the English plural form', JSON.stringify(enTemplates));
  else bad('F() picks the English plural form', JSON.stringify(enTemplates));
  if (enTemplates && enTemplates.pair === '3 items · 1 done' && enTemplates.left === '1 to-do left for today.' && enTemplates.plain === 'Draw with Sage') ok('F() fills named placeholders in English', JSON.stringify(enTemplates));
  else bad('F() fills named placeholders in English', JSON.stringify(enTemplates));

  // no CJK anywhere the user can read it (whitelist: the 屿 seal mark).
  // Scanned twice: right after boot, and again once every app is mounted - most
  // aria-label / placeholder values only exist in the DOM while their window is open.
  const scanCjk = () => run(function () {
    var test = /[\u4e00-\u9fff]/;
    var out = { text: [], attrs: [], count: 0, chars: [] };
    function scan(value, bucket) {
      if (!value) return;
      var left = String(value).split('屿').join('');
      if (!test.test(left)) return;
      out.count += 1;
      var hits = left.match(/[\u4e00-\u9fff]/g) || [];
      hits.forEach(function (one) { if (out.chars.indexOf(one) === -1) out.chars.push(one); });
      if (bucket.length < 5) bucket.push(String(value).slice(0, 110));
    }
    scan(document.body.innerText, out.text);
    var nodes = document.querySelectorAll('[aria-label],[title],[placeholder],[alt]');
    for (var i = 0; i < nodes.length; i += 1) {
      scan(nodes[i].getAttribute('aria-label'), out.attrs);
      scan(nodes[i].getAttribute('title'), out.attrs);
      scan(nodes[i].getAttribute('placeholder'), out.attrs);
      scan(nodes[i].getAttribute('alt'), out.attrs);
    }
    return out;
  });
  const cjk = await scanCjk();
  if (cjk && cjk.count === 0) ok('the English page shows no CJK text outside the 屿 seal');
  else bad('the English page shows no CJK text outside the 屿 seal', JSON.stringify(cjk));

  // the desk itself: top bar, dock, and every app still opens in English
  const enUi = await run(function () {
    var P = window.PaperOS;
    var apps = ['stickies', 'prompts', 'notes', 'calendar', 'draw', 'settings'];
    var opened = [];
    apps.forEach(function (id) {
      try { P.wm.open(id); } catch (err) { /* reported below */ }
      var win = document.querySelector('.window[data-app=' + id + ']');
      opened.push({ id: id, ok: !!win, title: win ? (win.querySelector('.window__title') || {}).textContent || '' : '' });
    });
    return {
      opened: opened,
      dockButtons: document.querySelectorAll('[data-dock-app]').length,
      topbar: !!document.querySelector('.topbar'),
      topbarBrand: (document.querySelector('.brand__en') || {}).textContent || ''
    };
  });
  const enAllOpen = enUi && enUi.opened && enUi.opened.every(function (one) { return one.ok; });
  if (enAllOpen && enUi.dockButtons === 5 && enUi.topbar) ok('every app opens on the English page', JSON.stringify(enUi.opened.map(function (o) { return o.id; })));
  else bad('every app opens on the English page', JSON.stringify(enUi));
  const enTitles = enUi && enUi.opened ? enUi.opened.filter(function (one) { return /[\u4e00-\u9fff]/.test(one.title.split('屿').join('')); }) : [];
  if (enTitles.length === 0) ok('window titles are English');
  else bad('window titles are English', JSON.stringify(enTitles));
  const cjkOpen = await scanCjk();
  if (cjkOpen && cjkOpen.count === 0) ok('every open app stays CJK-free in text and attributes');
  else bad('every open app stays CJK-free in text and attributes', JSON.stringify(cjkOpen));

  // seal + weekday header read as English, not as half a Chinese word
  const enChrome = await run(function () {
    var seal = document.getElementById('day-seal');
    var cells = [];
    var header = document.querySelector('.calendar-weekdays');
    if (header) {
      var spans = header.querySelectorAll('span');
      for (var i = 0; i < spans.length; i += 1) cells.push(spans[i].textContent);
    }
    return {
      seal: seal ? seal.textContent.trim() : '',
      sealTitle: seal ? seal.getAttribute('title') : '',
      weekdays: cells.join('')
    };
  });
  const sealOk = enChrome && enChrome.seal && !/[\u4e00-\u9fff]/.test(enChrome.seal) && enChrome.seal.length <= 6;
  if (sealOk && enChrome.sealTitle && !/[\u4e00-\u9fff]/.test(enChrome.sealTitle)) ok('the day seal shows an English word with its English title', JSON.stringify(enChrome));
  else bad('the day seal shows an English word with its English title', JSON.stringify(enChrome));
  if (enChrome && enChrome.weekdays === 'MTWTFSS') ok('the weekday header is M T W T F S S', enChrome.weekdays);
  else bad('the weekday header is M T W T F S S', JSON.stringify(enChrome && enChrome.weekdays));

  // the guided tour carries inline <b>; its English comes from F() templates
  const enTour = await run(function () {
    var P = window.PaperOS;
    P.tour.start();
    var card = document.querySelector('.tour__card');
    var bodies = [];
    if (card) {
      var next = card.querySelector('[data-tour-next]');
      var body = card.querySelector('[data-tour-body]');
      bodies.push(body ? body.textContent : '');
      for (var i = 0; i < 5; i += 1) {
        if (!next || next.disabled) break;
        next.click();
        var again = card.querySelector('[data-tour-body]');
        bodies.push(again ? again.textContent : '');
      }
    }
    P.tour.close();
    return { bodies: bodies, kicker: card ? (card.querySelector('[data-tour-kicker]') || {}).textContent : '' };
  });
  const tourBad = enTour ? enTour.bodies.filter(function (one) { return /[\u4e00-\u9fff]/.test(String(one).split('屿').join('')); }) : ['tour did not open'];
  if (enTour && enTour.bodies.length >= 5 && tourBad.length === 0) ok('the guided tour reads as English', JSON.stringify(enTour.bodies.map(function (one) { return one.slice(0, 44); })));
  else bad('the guided tour reads as English', JSON.stringify(tourBad.length ? tourBad : enTour));
  if (enTour && enTour.bodies[0] && enTour.bodies[0].indexOf('bottom dock') !== -1) ok('the tour keeps its bold phrase and wording');
  else bad('the tour keeps its bold phrase and wording', JSON.stringify(enTour && enTour.bodies[0]));

  // settings -> appearance: the language row reflects prefs.lang and writes it back
  const langPref = await run(function () {
    var P = window.PaperOS;
    var select = document.querySelector('[data-lang-select]');
    if (!select) return { error: 'no language select' };
    var before = select.value;
    var prefsBefore = P.data.getPrefs().lang;
    select.value = 'en';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    var after = P.data.getPrefs().lang;
    select.value = 'system';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return { before: before, prefsBefore: prefsBefore, after: after, restored: P.data.getPrefs().lang, options: select.options.length };
  });
  if (langPref && langPref.before === 'system' && langPref.prefsBefore === 'system' && langPref.after === 'en' && langPref.restored === 'system' && langPref.options === 3) ok('the language row reads and writes prefs.lang', JSON.stringify(langPref));
  else bad('the language row reads and writes prefs.lang', JSON.stringify(langPref));

  // same word twice? "STICKY NOTES · Sticky notes" collapses to the kicker only
  const enHeading = await run(function () {
    var P = window.PaperOS;
    P.wm.open('prompts');
    var win = document.querySelector('.window[data-app=prompts]');
    if (!win) return { error: 'no prompts window' };
    var heading = win.querySelector('.window__heading');
    var titleEl = win.querySelector('.window__title');
    return {
      kicker: (win.querySelector('.window__app-name') || {}).textContent || '',
      title: (titleEl || {}).textContent || '',
      single: !!(heading && heading.classList.contains('is-single')),
      titleHidden: !!(titleEl && titleEl.hidden),
      barText: ((win.querySelector('.window__titlebar') || {}).textContent || '').replace(/\s+/g, ' ').trim()
    };
  });
  if (enHeading && enHeading.single && enHeading.titleHidden && enHeading.barText.indexOf('·') === -1) ok('a window whose kicker repeats its title shows the kicker once', JSON.stringify(enHeading));
  else bad('a window whose kicker repeats its title shows the kicker once', JSON.stringify(enHeading));

  // both themes on the English page, for the review screenshots (tour closed: no shade)
  await ev('window.PaperOS.data.setPrefs({ theme: "light" }); window.PaperOS.shell.applyPrefs();');
  await sleep(320);
  await closeTour();
  await shot('page-en-light');
  await ev('window.PaperOS.data.setPrefs({ theme: "dark" }); window.PaperOS.shell.applyPrefs();');
  await sleep(320);
  await closeTour();
  await shot('page-en-dark');
  /* 英文深色便签页，与中文那张对照。 */
  await run(function () {
    var P = window.PaperOS;
    P.wm.open('stickies');
    var wins = P.wm.getWindows().filter(function (w) { return w.appId === 'stickies'; });
    if (wins.length) P.wm.focus(wins[0].id);
  });
  await closeTour();
  await shot('page-en-dark-sticky');
  await ev('window.PaperOS.data.setPrefs({ theme: "system" }); window.PaperOS.shell.applyPrefs();');
  await sleep(160);

  if (!pageErrors.length) ok('no page exceptions on the English page');
  else bad('no page exceptions on the English page', pageErrors.slice(0, 3).join(' | '));
}

// --- cross-language data: a legacy sentinel title must not leak into the English UI ---
// A workspace written by the old build carries the Chinese sentinel as a real title. The
// page has to normalise it to an empty title on load and draw its own localized
// placeholder; the stored data must be clean afterwards. Deliberately no clearAll here:
// the point is that an old workspace loads and reads correctly in English.
const crossPage = join(OUT, 'page.en.cross.html');
/* Build the fixture from a snapshot the page itself produced, so the schema is valid by
   construction; only the prompt titles are the old-build values under test. */
const crossSnapshot = await ev('(function () { var P = window.PaperOS; var snap = P.data.snapshotData(); snap.prompts = [' +
  '{ id: P.util.uid(\'prompt\'), title: \'未命名提示词\', body: \'\', pinned: false, createdAt: 1, updatedAt: 4102444800000 },' +
  '{ id: P.util.uid(\'prompt\'), title: \'\', body: \'\', pinned: false, createdAt: 2, updatedAt: 4102444800000 }' +
  ']; snap.format = \'paper-os/workspace\'; snap.version = P.schemaVersion;' +
  ' snap.meta = Object.assign({}, snap.meta, { updatedAt: 4102444800000 }); snap.windows = []; return snap; })()');
const crossScript = '<' + 'script>window.__SCHEDULE_HOST_MODE__=true;window.__SCHEDULE_HOST_SNAPSHOT__='
  + JSON.stringify(crossSnapshot).replace(/</g, '\\u003c') + ';<' + '/script>';
writeFileSync(crossPage, readFileSync(PAGE_EN, 'utf8').replace('<script>', crossScript + '<script>'));
pageErrors.length = 0;
await send('Page.navigate', { url: pathToFileURL(crossPage).href });
await waitReady();
/* The previous page instance wrote a recovery journal on unload (pagehide). That journal
   is a legitimate preferred source and would mask the fixture under test - drop only that
   one key (never clearAll) and reload so the injected host workspace is the one loaded. */
await ev('try { window.localStorage.removeItem("paper-os.recovery.v1"); } catch (err) {}');
await send('Page.reload', { ignoreCache: true });
const crossReady = await waitReady();
if (crossReady) ok('the English page boots on a workspace written by the old build');
else bad('the English page boots on a workspace written by the old build', 'READY never became true');
const cross = await run(function () {
  var P = window.PaperOS;
  P.wm.open('prompts');
  var rows = document.querySelectorAll('[data-testid=prompt-item]');
  var names = [];
  for (var i = 0; i < rows.length; i += 1) {
    var nameEl = rows[i].querySelector('.prompt-item__name');
    names.push(nameEl ? nameEl.textContent : '');
  }
  var titles = P.data.listPrompts('').map(function (p) { return p.title; });
  var win = document.querySelector('.window[data-app=prompts]');
  var titleInput = document.querySelector('[data-testid=prompt-title]');
  var windowText = win ? win.innerText : '';
  var hits = windowText.split('屿').join('').match(/[\u4e00-\u9fff]/g) || [];
  return {
    rows: rows.length,
    names: names,
    titles: titles,
    placeholder: titleInput ? titleInput.placeholder : '',
    barTitle: (document.querySelector('[data-testid=prompt-heading]') || {}).textContent || '',
    cjk: hits.length,
    promptCount: P.data.listPrompts('').length,
    hasSnapshot: !!window.__SCHEDULE_HOST_SNAPSHOT__,
    hostMode: !!window.__SCHEDULE_HOST_MODE__,
    blocked: !!(P.storage && P.storage.blocked),
    bootError: window.__PAPER_OS_BOOT_ERROR__ || ''
  };
});
/* The fixture itself must load, otherwise the assertions below would pass on a freshly
   seeded desk and prove nothing. */
if (cross && cross.promptCount === 2 && cross.hasSnapshot && cross.hostMode && !cross.blocked) {
  ok('the cross-language fixture loads as a host workspace', JSON.stringify({ rows: cross.rows, promptCount: cross.promptCount }));
} else {
  bad('the cross-language fixture loads as a host workspace', JSON.stringify(cross && { promptCount: cross.promptCount, hasSnapshot: cross.hasSnapshot, hostMode: cross.hostMode, blocked: cross.blocked, bootError: cross.bootError }));
}
const crossTitlesClean = cross && Array.isArray(cross.titles) && cross.titles.length === 2
  && cross.titles.every(function (one) { return one === ''; });
if (crossTitlesClean) ok('a legacy sentinel title is normalised to an empty title in data', JSON.stringify(cross.titles));
else bad('a legacy sentinel title is normalised to an empty title in data', JSON.stringify(cross && cross.titles));
const crossPlaceholder = cross && cross.placeholder && !/[\u4e00-\u9fff]/.test(cross.placeholder);
const crossNamesOk = cross && cross.rows === 2 && cross.names.length === 2
  && cross.names.every(function (one) { return one === cross.placeholder; });
if (crossPlaceholder && crossNamesOk) ok('both untitled prompts show the English placeholder', JSON.stringify(cross.names));
else bad('both untitled prompts show the English placeholder', JSON.stringify(cross && { placeholder: cross.placeholder, names: cross.names, rows: cross.rows }));
const crossClean = cross && cross.cjk === 0 && !/[\u4e00-\u9fff]/.test(cross.barTitle || '');
if (crossClean) ok('an old workspace shows no CJK in the English prompt library', JSON.stringify({ cjk: cross.cjk, barTitle: cross.barTitle }));
else bad('an old workspace shows no CJK in the English prompt library', JSON.stringify(cross && { cjk: cross.cjk, barTitle: cross.barTitle }));
if (!pageErrors.length) ok('no page exceptions on the cross-language workspace');
else bad('no page exceptions on the cross-language workspace', pageErrors.slice(0, 3).join(' | '));

await shot('page-final');
const failed = checks.filter((c) => !c[0]);
console.log('checks: PASS ' + (checks.length - failed.length) + ' / FAIL ' + failed.length);
ws.close();
proc.kill();
process.exit(failed.length ? 1 : 0);