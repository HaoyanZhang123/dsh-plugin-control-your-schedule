#!/usr/bin/env node
/**
 * Real-browser check for the paper desk (headless Edge/Chrome via CDP).
 * Loads the page embedded in the built client.js, i.e. exactly what users get.
 * Screenshots land in output/_probe/cys-e2e; the browser profile lives in the OS
 * temp dir and is removed after the run, so repeated runs cannot bloat the workspace.
 * Exit 0 only when every assertion passes. No third-party dependencies.
 *
 * Note: this file contains no template literals on purpose - expressions are
 * passed as function sources, so nothing can be truncated by a stray backtick.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
/* 开发树是 <项目>/plugin/client.js，发布仓是 <包根>/client.js；两种布局都要能跑（GitHub CI 用后者）。 */
const CLIENT = [join(ROOT, 'plugin', 'client.js'), join(ROOT, 'client.js')]
  .find((candidate) => existsSync(candidate)) || join(ROOT, 'plugin', 'client.js');
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
const RUN_BUILD = {
  sha16: createHash('sha256').update(client).digest('hex').slice(0, 16),
  bytes: Buffer.byteLength(client, 'utf8'),
};
const match = /var PAGE_B64 = '([A-Za-z0-9+/=]+)'/.exec(client);
if (!match) { console.log('FAIL | PAGE_B64 not found in client.js'); process.exit(1); }
// 浏览器 profile 是缓存级产物：每轮独立、放系统临时目录，跑完就删。
// 放工作区会让每个 Edge profile 带出十万级小文件（2026-10 实测单轮累积到 6.7GB），
// 所以 profile 一律进 tmpdir；删不掉也只污染 %TEMP%，不再污染 output/。
const PROFILE = join(tmpdir(), 'cys-e2e-profile-' + process.pid + '-' + Date.now());
const dropProfile = () => {
  try { rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch (err) { /* 临时目录，删不掉交给 OS；不影响门禁结论 */ }
};
const PAGE = join(OUT, 'page.published.html');
const pageText = Buffer.from(match[1], 'base64').toString('utf8');
writeFileSync(PAGE, pageText);
// The build ships two page variants; the English one must exist or the gate is meaningless.
const enMatch = /var PAGE_B64_EN = '([A-Za-z0-9+/=]+)'/.exec(client);
const PAGE_EN = join(OUT, 'page.published.en.html');
if (enMatch) writeFileSync(PAGE_EN, Buffer.from(enMatch[1], 'base64').toString('utf8'));

/* --mutate= 只给"改门禁的正反审计"用，不进 run_all_checks：
   - skip-close / tour-first：破坏首次启动夹具，断言必须红；
   - no-apply-skin / switch-reloads：改解码出来的页面字符串，只在 %TEMP% 的副本里跑
     （产线页面不动，output/ 也不留可被误当证据的页面副本，跑完即删）。 */
const MUTATE = (process.argv.find((one) => one.indexOf('--mutate=') === 0) || '').slice('--mutate='.length);
/* --mutate-page= 只改解码后的页面字符串、不接管夹具，也不强制红/绿：
   用来做"必须仍然绿"的反向审计（例如常驻过渡不得把深色读成过渡起点）。 */
const MUTATE_PAGE = (process.argv.find((one) => one.indexOf('--mutate-page=') === 0) || '').slice('--mutate-page='.length);
const PAGE_MUTATIONS = {
  'no-apply-skin': (text) => text.replace('applySkin(prefs.skin);', ''),
  'switch-reloads': (text) => text.replace(
    'function finishSkinChoice(selection) {',
    'function finishSkinChoice(selection) { try { location.reload(); } catch (err) {}'
  ),
  /* task-6 反向审计：删掉经典作用域隐藏规则（改选择器让它失效），经典侧控制按钮变可见。 */
  'no-classic-hide': (text) => text.replace(
    'html:not([data-skin="modern"]) .window__controls {',
    'html:not([data-skin="modern"]) .window__controls--never {'
  ),
  /* task-6 反向审计：让按钮走私有的 DOM 关闭（不调 P.wm.close），窗口状态不再同步。 */
  'controls-private': (text) => text.replace(
    "else if (action === 'close') P.wm.close(win.id);",
    "else if (action === 'close') { win.el.remove(); }"
  ),
  /* resize 反向审计：resize 路径不再夹窗口。当前实现有两条夹取路径
     （refreshLayout 里的 clampBounds，以及 settleWindowLayout 里的 fitWindowIntoArea），
     两个都必须去掉，否则另一个会兜底、变异变成空操作。 */
  'no-resize-clamp': (text) => text
    .replace('var clamped = clampBounds(source, area);', 'var clamped = source;')
    .replace('if (fitWindowIntoArea(w)) { fitted = true; layoutProbe.clamps += 1; }', '/* mutated: settle clamp removed */;'),
  /* resize 反向审计：只在 open/restore 时夹，resize 触发时不再收敛（等价于旧实现）。 */
  'clamp-only-on-open': (text) => text.replace(
    '  function onViewportResize() {\n    layoutProbe.resizes += 1;',
    '  function onViewportResize() {\n    layoutProbe.resizes += 1;\n    /* mutated: resize never settles */\n    if (true) return;'
  ),
  /* resize 反向审计：收敛只跑一次、去掉 0/60/140ms 的复核（可能表现为红，也可能表现为
     settleSamples 显著上升；两种都记录，不预设结论）。 */
  'settle-single-pass': (text) => text
    .replace('for (var pass = 0; pass < 3; pass += 1) {', 'for (var pass = 0; pass < 1; pass += 1) {')
    .replace('    settleTimer = setTimeout(again, 0);', '    /* mutated: no re-check */;'),
  /* 紧急程度分档反向审计：把 modern 的 urgent 改回经典 sage → 分档断言必须红。 */
  'modern-urgent-sage': (text) => text.replace('  --m-prio-urgent: #7f9f79;', '  --m-prio-urgent: #7b8f72;'),
  /* 载体一致性反向审计：只改 pip 按钮的 urgent 颜色 → 三处一致断言必须红。 */
  'one-carrier-drift': (text) => text.replace(
    'html[data-skin="modern"] .task-pip-btn[data-priority="urgent"]::after { background: var(--m-prio-urgent); }',
    'html[data-skin="modern"] .task-pip-btn[data-priority="urgent"]::after { background: #123456; }'
  ),
  /* 暗色结构层反向审计：把 dark 令牌改成浅色，结构断言必须点名红。 */
  'dark-token-light': (text) => text.replace('  --m-surface-solid: #232428;', '  --m-surface-solid: #fcfcfd;'),
  /* 暗色视觉层的"不得假红"审计：去掉 is-skin-switching 作用域，模拟常驻过渡的旧实现。
     这类跑法用 --mutate-page=，期望整轮 FAIL 0（等稳定必须生效，不能读到过渡起点）。 */
  'transition-permanent': (text) => text.split('html[data-skin="modern"].is-skin-switching ').join('html[data-skin="modern"] '),
  /* task-13 反向审计①：把 decideSkinPrompt 的"相等或更旧不弹"改成"总是弹"。
     期望点名红 `reloading the same version does not prompt again`（同版本还弹）。 */
  'skin-prompt-always': (text) => text.replace(
    "    return compareVersions(current, seen) > 0\n      ? { show: true, reason: 'upgrade' }\n      : { show: false, reason: 'same-or-older' };",
    "    /* mutated: every boot counts as an upgrade */\n    return { show: true, reason: 'upgrade' };"
  ),
  /* task-13 反向审计②：markSkinPromptSeen 不写 meta。期望点名红
     `closing the upgrade chooser records the current version and keeps classic`（关闭后版本没记）。 */
  'mark-seen-noop': (text) => text.replace(
    '    state.meta.skinPromptVersion = next;\n    state.meta.updatedAt = Date.now();',
    '    /* mutated: the prompt version is never recorded */\n'
  ),
};
let PAGE_URL = pathToFileURL(PAGE).href;
let MUTATED_PAGE = '';
const PAGE_MUTATION_ID = (MUTATE && PAGE_MUTATIONS[MUTATE]) ? MUTATE : MUTATE_PAGE;
if (PAGE_MUTATION_ID && PAGE_MUTATIONS[PAGE_MUTATION_ID]) {
  const mutated = PAGE_MUTATIONS[PAGE_MUTATION_ID](pageText);
  if (mutated === pageText) {
    console.log('FAIL | mutation did not apply: ' + PAGE_MUTATION_ID);
    process.exit(1);
  }
  MUTATED_PAGE = join(tmpdir(), 'cys-e2e-mutated-' + process.pid + '.html');
  writeFileSync(MUTATED_PAGE, mutated);
  PAGE_URL = pathToFileURL(MUTATED_PAGE).href;
}
const dropMutatedPage = () => {
  if (!MUTATED_PAGE) return;
  try { rmSync(MUTATED_PAGE, { force: true }); } catch (err) { /* temp file */ }
};

const checks = [];
const pendingList = [];
const cleared = [];
const seenNames = new Set();

/* ---------- MODERN_PENDING 登记表（--skin=modern 才生效） ----------
   登记的不是"允许一直红"，而是"这条要由哪一波销账"：没登记的红照常 FAIL；
   登记了却变绿打 PENDING-CLEARED 提醒销账；K7 收口用
   --require-modern-clean（表非空 / 有登记名没出现 → FAIL）。 */
/* 目前为空：K2 构建（client.js 01:22:14）后，现代窗口在窄视口/矮窗口下也已
   重新夹取边界，最近一轮 `--skin=modern` 是 FAIL 0 / PENDING 0。以后新登记的红
   必须写清由哪一波销账，K7 收口要求本表为空（--require-modern-clean）。 */
/* 销账规则（Lead 裁定 2026-11-03）：一条登记项只有在**同一构建连跑 3 次同结果**、
   三次都 PASS 时才能从本表删除。只看到一次 PASS 就销账是错误口径（见回执 §8 自审）。 */
const MODERN_PENDING = {};

function pendingVerdict(name, passed, modern, table) {
  const registry = table || MODERN_PENDING;
  const wave = modern ? (registry[name] || '') : '';
  if (!wave) return passed ? 'pass' : 'fail';
  return passed ? 'cleared' : 'pending';
}

/* 回弹前兆：一次测量要 >= 8 个连续样本才稳，说明布局在回弹。
   这不是失败，但批量日志要能一眼筛出来，所以做成输出标记而不是只写在回执里。 */
/* 回弹前兆 = 值在稳定过程中反复横跳（settleChanges >= 3），不是采样总数：
   样本多只说明稳得慢（现代皮肤更重），是性能信号，不作废轮次（Lead 裁定 2026-11-03）。 */
const SETTLE_SUSPECT_CHANGES = 3;
function settleTag(detail) {
  const found = /settleChanges=(\d+)/.exec(String(detail || ''));
  return found && Number(found[1]) >= SETTLE_SUSPECT_CHANGES ? '[settle-suspect] ' : '';
}
const ok = (n, d) => {
  seenNames.add(n);
  if (pendingVerdict(n, true, SKIN === 'modern') === 'cleared') {
    cleared.push(n);
    console.log('PENDING-CLEARED | ' + n + ' | ' + MODERN_PENDING[n] + ' | 已变绿，该销账');
  }
  checks.push([true, n]);
  console.log('PASS | ' + settleTag(d) + n + (d ? ' | ' + d : ''));
};
const bad = (n, d) => {
  seenNames.add(n);
  if (pendingVerdict(n, false, SKIN === 'modern') === 'pending') {
    pendingList.push({ name: n, wave: MODERN_PENDING[n] });
    console.log('PENDING | ' + settleTag(d) + n + ' | ' + MODERN_PENDING[n] + ' | ' + d);
    return;
  }
  checks.push([false, n]);
  console.log('FAIL | ' + settleTag(d) + n + ' | ' + d);
};

/* ---------- 02 §3 first-run verdicts: one judgement function ----------
   新装首次启动的顺序是「皮肤选择页 → 关掉 → 导览」。三条断言都从同一组状态
   对象取证，真实运行、--self-test 与 --mutate 共用 firstRunVerdicts()：自检喂
   已知坏状态必须按名字变红，否则"夹具关掉了选择页"只是自说自话。 */
const FIRST_RUN_CARDS = 'a fresh install opens the skin chooser with two named cards';
const FIRST_RUN_ORDER = 'the tour starts only after the skin chooser closes';
const FIRST_RUN_CLOSE = 'closing the first-run skin chooser leaves no dialog open';

function firstRunVerdicts(before, after, closed) {
  const was = before || {};
  const now = after || {};
  const how = closed || {};
  const names = Array.isArray(was.names) ? was.names : [];
  const cardsOk = was.chooser === true && was.cards === 2;
  const namesOk = names.indexOf('纸屿经典') !== -1 && names.indexOf('原生柔光') !== -1;
  /* 顺序判据同时要求"选择页真的出现过"：没出现时不许空洞地变绿。 */
  const orderOk = was.chooser === true && was.tourOpen === false && now.tourOpen === true;
  const closeOk = how.clicked === true && now.dialogs === 0;
  return [
    {
      name: FIRST_RUN_CARDS,
      pass: cardsOk && namesOk,
      detail: cardsOk && namesOk
        ? 'two cards: ' + JSON.stringify(names)
        : 'chooser=' + JSON.stringify(was.chooser) + ' cards=' + JSON.stringify(was.cards) + ' names=' + JSON.stringify(names),
    },
    {
      name: FIRST_RUN_ORDER,
      pass: orderOk,
      detail: orderOk
        ? 'tour closed while the chooser was up, open after it closed'
        : 'chooser=' + JSON.stringify(was.chooser) + ' tour before=' + JSON.stringify(was.tourOpen)
          + ' tour after=' + JSON.stringify(now.tourOpen),
    },
    {
      name: FIRST_RUN_CLOSE,
      pass: closeOk,
      detail: closeOk
        ? 'closed by "' + String(how.label || '?') + '", dialogs left=' + JSON.stringify(now.dialogs)
        : 'clicked=' + JSON.stringify(how.clicked) + ' dialogs left=' + JSON.stringify(now.dialogs),
    },
  ];
}

/* ---------- task-7 双皮肤骨架：--skin=classic|modern ----------
   默认 classic，行为与退出码保持不变；modern 的断言只放在 if (skin === 'modern')
   分支里，也不接进 run_all_checks 的默认路径（K2 未完成期不许把红带进日常门禁）。
   切换行为按 02 §2：即时生效、不整页刷新、不丢窗口/便签正文/日历选中日/设置搜索词。
   与 firstRunVerdicts 一样只有一个判断函数，真实运行与 --self-test 共用。 */
const SKIN = ((process.argv.find((one) => one.indexOf('--skin=') === 0)) || '--skin=classic').slice('--skin='.length);
if (SKIN !== 'classic' && SKIN !== 'modern') {
  console.log('FAIL | --skin must be classic or modern, got ' + JSON.stringify(SKIN));
  process.exit(1);
}
/* 两种皮肤各自的正式顶栏高度（交接 04 §1 / 裁定 #2：经典 56、现代 58），容差 ±1。
   几何断言只说"band == clearance + 实测顶栏高度"和"顶栏高度落在该皮肤合同区间"，
   不再各写一份 56/58、104/106 的魔法数。 */
const SKIN_TOPBAR = { classic: 56, modern: 58 };
const SKIN_TOPBAR_TOLERANCE = 1;
const expectedTopbar = (skin) => SKIN_TOPBAR[skin] || SKIN_TOPBAR.classic;

/* 亮度只在测试侧算一次：深色断言用"够不够暗"判，不靠颜色字面量。 */
function luminanceOf(color) {
  const text = String(color || '').trim();
  const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(text);
  let red;
  let green;
  let blue;
  if (hex) {
    const raw = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
    red = parseInt(raw.slice(0, 2), 16);
    green = parseInt(raw.slice(2, 4), 16);
    blue = parseInt(raw.slice(4, 6), 16);
  } else {
    const found = /rgba?\(([0-9.]+), ?([0-9.]+), ?([0-9.]+)/.exec(text);
    if (!found) return null;
    red = Number(found[1]);
    green = Number(found[2]);
    blue = Number(found[3]);
  }
  const channels = [red, green, blue].map((value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}
const SKIN_SEEDED = 'the switch fixture seeds all four kinds of state before confirming';
const SKIN_APPLIED = 'confirming the skin chooser applies data-skin=modern at once';
const SKIN_NO_RELOAD = 'the skin switch happens without a full page reload';
const SKIN_KEEPS_WINDOWS = 'the skin switch keeps the open windows';
const SKIN_KEEPS_STICKY = 'the skin switch keeps the sticky body text';
const SKIN_KEEPS_DAY = 'the skin switch keeps the selected calendar day';
const SKIN_KEEPS_SEARCH = 'the skin switch keeps the settings search term';

function skinSwitchVerdicts(seeded, after) {
  const was = seeded || {};
  const now = after || {};
  const listKey = (value) => (Array.isArray(value) ? value.slice().sort().join(',') : '');
  const seededOk = Array.isArray(was.appIds) && was.appIds.length >= 2
    && typeof was.stickyText === 'string' && !!was.stickyText
    && typeof was.calDate === 'string' && !!was.calDate
    && typeof was.search === 'string' && !!was.search;
  const stickyOk = Array.isArray(now.stickyTexts) && now.stickyTexts.indexOf(was.stickyText) !== -1
    && Array.isArray(now.stickyInData) && now.stickyInData.indexOf(was.stickyText) !== -1;
  return [
    {
      name: SKIN_SEEDED,
      pass: seededOk,
      detail: seededOk
        ? 'windows ' + JSON.stringify(was.appIds) + ', sticky, day ' + JSON.stringify(was.calDate) + ', search ' + JSON.stringify(was.search)
        : 'windows=' + JSON.stringify(was.appIds) + ' sticky=' + JSON.stringify(was.stickyText)
          + ' day=' + JSON.stringify(was.calDate) + ' search=' + JSON.stringify(was.search),
    },
    {
      name: SKIN_APPLIED,
      pass: now.dataSkin === 'modern',
      detail: 'data-skin=' + JSON.stringify(now.dataSkin),
    },
    {
      name: SKIN_NO_RELOAD,
      pass: typeof was.instance === 'number' && now.instance === was.instance,
      detail: 'instance before=' + JSON.stringify(was.instance) + ' after=' + JSON.stringify(now.instance),
    },
    {
      name: SKIN_KEEPS_WINDOWS,
      pass: !!listKey(was.appIds) && listKey(now.appIds) === listKey(was.appIds),
      detail: 'before=' + JSON.stringify(was.appIds) + ' after=' + JSON.stringify(now.appIds),
    },
    {
      name: SKIN_KEEPS_STICKY,
      pass: stickyOk,
      detail: 'expected ' + JSON.stringify(was.stickyText) + ', data=' + JSON.stringify(now.stickyInData)
        + ', rendered=' + JSON.stringify(now.stickyTexts),
    },
    {
      name: SKIN_KEEPS_DAY,
      pass: !!was.calDate && now.calDate === was.calDate,
      detail: 'before=' + JSON.stringify(was.calDate) + ' after=' + JSON.stringify(now.calDate),
    },
    {
      name: SKIN_KEEPS_SEARCH,
      pass: !!was.search && now.search === was.search,
      detail: 'before=' + JSON.stringify(was.search) + ' after=' + JSON.stringify(now.search),
    },
  ];
}

/* ---------- task-6 第 2 步：窗口标题栏控制按钮（两套皮肤共用 DOM） ----------
   经典靠 html:not([data-skin="modern"]) .window__controls { display: none; } 隐藏
   （AC-05 不回归），modern 必须可见；行为必须走既有 P.wm.minimize/close，也就是
   与 Ctrl/Cmd+Alt+M/W 同一个入口。判定同样是纯函数：真实运行与 --self-test 共用。 */
const CONTROLS_PRESENT = 'the window title bar carries both window controls';
const CONTROLS_HIDDEN_CLASSIC = 'the window controls are hidden in the classic skin';
const CONTROLS_VISIBLE_MODERN = 'the window controls are visible in the modern skin';
const CONTROLS_MINIMIZE = 'the title-bar minimize does what Ctrl/Cmd+Alt+M does';
const CONTROLS_CLOSE = 'the title-bar close does what Ctrl/Cmd+Alt+W does';

function controlsActions(seen) {
  const s = seen || {};
  const names = Array.isArray(s.actionNames) ? s.actionNames : [];
  return {
    present: s.controls === true && names.indexOf('minimize') !== -1 && names.indexOf('close') !== -1,
    detail: 'controls=' + JSON.stringify(s.controls) + ' actions=' + JSON.stringify(names),
  };
}

function classicControlsVerdicts(seen) {
  const s = seen || {};
  const present = controlsActions(s);
  const hidden = s.display === 'none' && s.width === 0 && s.height === 0;
  return [
    { name: CONTROLS_PRESENT, pass: present.present, detail: present.present ? 'minimize + close in the DOM' : present.detail },
    {
      name: CONTROLS_HIDDEN_CLASSIC,
      pass: hidden,
      detail: hidden ? 'display:none, 0x0' : 'display=' + JSON.stringify(s.display) + ' size=' + s.width + 'x' + s.height,
    },
  ];
}

function modernControlsVerdicts(seen) {
  const s = seen || {};
  const present = controlsActions(s);
  const buttons = Array.isArray(s.buttons) ? s.buttons : [];
  const visible = s.display !== 'none' && s.width > 0 && s.height > 0
    && buttons.length === 2 && buttons.every((one) => one.w > 0 && one.h > 0);
  return [
    { name: CONTROLS_PRESENT, pass: present.present, detail: present.present ? 'minimize + close in the DOM' : present.detail },
    {
      name: CONTROLS_VISIBLE_MODERN,
      pass: visible,
      detail: visible
        ? 'display=' + s.display + ' size=' + s.width + 'x' + s.height
        : 'display=' + JSON.stringify(s.display) + ' size=' + s.width + 'x' + s.height + ' buttons=' + JSON.stringify(buttons),
    },
  ];
}

function controlBehaviourVerdicts(result) {
  const seen = result || {};
  const minButton = seen.minimizeButton || {};
  const minKey = seen.minimizeKey || {};
  const closeButton = seen.closeButton || {};
  const closeKey = seen.closeKey || {};
  const minOk = minButton.clicked === true && minButton.minimized === true && minButton.dom === true
    && minKey.minimized === true && minKey.dom === true;
  const closeOk = closeButton.clicked === true && closeButton.gone === true && closeKey.gone === true;
  return [
    {
      name: CONTROLS_MINIMIZE,
      pass: minOk,
      detail: 'button=' + JSON.stringify(minButton) + ' shortcut=' + JSON.stringify(minKey),
    },
    {
      name: CONTROLS_CLOSE,
      pass: closeOk,
      detail: 'button=' + JSON.stringify(closeButton) + ' shortcut=' + JSON.stringify(closeKey),
    },
  ];
}

/* ---------- task-13 升级路径：等价 0.5.2 工作区 → 皮肤选择页（AC-07/09、02 §5 场景 2/4/5） ----------
   夹具预置一份"等价 0.5.2 工作区"的 host 快照（无 prefs.skin、无 meta.skinPromptVersion），
   然后按用户路径走：选择页出现且默认 classic → 关闭记录当前版本 → 同版本重载不再弹 →
   把版本改旧再重载应再弹 → 勾「下次不再提醒我」并确认 → 永久关闭后再改旧版本也不弹 →
   确认 modern → prefs.skin/data-skin 立即变，重载后仍是 modern。
   断言名稳定；判定是纯函数，真实运行、--self-test 与 --mutate 共用（07 §4）。 */
const UPGRADE_CHOOSER = 'an equivalent 0.5.2 workspace opens the skin chooser';
const UPGRADE_DEFAULT_CLASSIC = 'the upgrade chooser highlights classic, not modern';
const UPGRADE_CLOSE_RECORDS = 'closing the upgrade chooser records the current version and keeps classic';
const UPGRADE_SAME_VERSION_QUIET = 'reloading the same version does not prompt again';
const UPGRADE_OLDER_VERSION_PROMPTS = 'an older recorded version prompts again on upgrade';
const UPGRADE_SUPPRESS_WRITES = 'suppress + confirm writes the permanent flag';
const UPGRADE_SUPPRESSED_QUIET = 'a suppressed workspace never prompts again, even after an upgrade';
const UPGRADE_MODERN_APPLIES = 'confirming modern switches the skin at once';
const UPGRADE_MODERN_PERSISTS = 'the chosen modern skin survives a reload';
const UPGRADE_OLDER_VERSION = '0.3.0';

function upgradePathVerdicts(seen) {
  const s = seen || {};
  const boot1 = s.boot1 || {};
  const closed = s.closed || {};
  const boot2 = s.boot2 || {};
  const boot3 = s.boot3 || {};
  const suppressed = s.suppressed || {};
  const boot4 = s.boot4 || {};
  const modern = s.modern || {};
  const boot5 = s.boot5 || {};
  const current = String(boot1.version || '');
  const names = Array.isArray(boot1.names) ? boot1.names : [];
  const cardsOk = boot1.ready === true && boot1.chooser === true && boot1.cards === 2
    && names.indexOf('纸屿经典') !== -1 && names.indexOf('原生柔光') !== -1;
  /* 老工作区必须走"从未提示 / 升级"分支：没有记录版本、不是只读、不重播首次导览。 */
  const chooserOk = cardsOk && boot1.seenVersion === '' && boot1.tourOpen === false
    && boot1.blocked === false && !!current;
  const defaultClassicOk = boot1.classicSelected === true && boot1.modernSelected === false
    && boot1.selectedOption === 'classic' && boot1.checkedValue === 'classic'
    && boot1.skin === 'classic' && boot1.prefsSkin === 'classic';
  const closeOk = closed.clicked === true && !!String(closed.label || '').trim()
    && closed.dialogs === 0 && closed.seenVersion === current
    && closed.skin === 'classic' && closed.suppressed === false && closed.version === current;
  const sameVersionOk = boot2.ready === true && boot2.chooser === false
    && boot2.seenVersion === current && boot2.skin === 'classic' && boot2.prefsSkin === 'classic';
  const olderPromptsOk = boot3.ready === true && boot3.chooser === true
    && boot3.seenVersion === UPGRADE_OLDER_VERSION && boot3.classicSelected === true
    && boot3.skin === 'classic';
  const suppressOk = suppressed.confirmed === true && suppressed.checked === true
    && suppressed.suppressed === true && suppressed.seenVersion === current
    && suppressed.skin === 'classic' && suppressed.dialogs === 0;
  const suppressedQuietOk = boot4.ready === true && boot4.chooser === false
    && boot4.suppressed === true && boot4.seenVersion === UPGRADE_OLDER_VERSION;
  const modernAppliesOk = modern.confirmed === true && modern.dataSkin === 'modern'
    && modern.prefsSkin === 'modern' && modern.dialogs === 0 && modern.chooser === false;
  const modernPersistsOk = boot5.ready === true && boot5.dataSkin === 'modern'
    && boot5.prefsSkin === 'modern' && boot5.chooser === false && boot5.seenVersion === current;
  return [
    {
      name: UPGRADE_CHOOSER,
      pass: chooserOk,
      detail: chooserOk
        ? 'cards=' + JSON.stringify(names) + ' seenVersion="" version=' + JSON.stringify(current) + ' tour=false'
        : 'ready=' + JSON.stringify(boot1.ready) + ' chooser=' + JSON.stringify(boot1.chooser)
          + ' cards=' + JSON.stringify(boot1.cards) + ' names=' + JSON.stringify(names)
          + ' seenVersion=' + JSON.stringify(boot1.seenVersion) + ' tour=' + JSON.stringify(boot1.tourOpen)
          + ' blocked=' + JSON.stringify(boot1.blocked),
    },
    {
      name: UPGRADE_DEFAULT_CLASSIC,
      pass: defaultClassicOk,
      detail: defaultClassicOk
        ? 'selected=classic checked=classic skin=classic prefs.skin=classic'
        : 'selected=' + JSON.stringify(boot1.selectedOption) + ' checked=' + JSON.stringify(boot1.checkedValue)
          + ' classic=' + JSON.stringify(boot1.classicSelected) + ' modern=' + JSON.stringify(boot1.modernSelected)
          + ' skin=' + JSON.stringify(boot1.skin) + ' prefs.skin=' + JSON.stringify(boot1.prefsSkin),
    },
    {
      name: UPGRADE_CLOSE_RECORDS,
      pass: closeOk,
      detail: closeOk
        ? 'closed by "' + String(closed.label) + '", seenVersion=' + JSON.stringify(current) + ', skin=classic, suppressed=false'
        : 'clicked=' + JSON.stringify(closed.clicked) + ' label=' + JSON.stringify(closed.label)
          + ' dialogs=' + JSON.stringify(closed.dialogs) + ' seenVersion=' + JSON.stringify(closed.seenVersion)
          + ' expected=' + JSON.stringify(current) + ' skin=' + JSON.stringify(closed.skin)
          + ' suppressed=' + JSON.stringify(closed.suppressed),
    },
    {
      name: UPGRADE_SAME_VERSION_QUIET,
      pass: sameVersionOk,
      detail: sameVersionOk
        ? 'second boot stayed quiet, seenVersion=' + JSON.stringify(current)
        : 'ready=' + JSON.stringify(boot2.ready) + ' chooser=' + JSON.stringify(boot2.chooser)
          + ' seenVersion=' + JSON.stringify(boot2.seenVersion) + ' skin=' + JSON.stringify(boot2.skin),
    },
    {
      name: UPGRADE_OLDER_VERSION_PROMPTS,
      pass: olderPromptsOk,
      detail: olderPromptsOk
        ? 'seenVersion=' + JSON.stringify(UPGRADE_OLDER_VERSION) + ' < ' + JSON.stringify(current) + ' → chooser shown, classic preselected'
        : 'ready=' + JSON.stringify(boot3.ready) + ' chooser=' + JSON.stringify(boot3.chooser)
          + ' seenVersion=' + JSON.stringify(boot3.seenVersion) + ' classicSelected=' + JSON.stringify(boot3.classicSelected),
    },
    {
      name: UPGRADE_SUPPRESS_WRITES,
      pass: suppressOk,
      detail: suppressOk
        ? 'skinPromptSuppressed=true, seenVersion=' + JSON.stringify(current) + ', skin=classic'
        : 'confirmed=' + JSON.stringify(suppressed.confirmed) + ' checked=' + JSON.stringify(suppressed.checked)
          + ' suppressed=' + JSON.stringify(suppressed.suppressed) + ' seenVersion=' + JSON.stringify(suppressed.seenVersion)
          + ' skin=' + JSON.stringify(suppressed.skin) + ' dialogs=' + JSON.stringify(suppressed.dialogs),
    },
    {
      name: UPGRADE_SUPPRESSED_QUIET,
      pass: suppressedQuietOk,
      detail: suppressedQuietOk
        ? 'no chooser after a downgraded version, suppressed=true'
        : 'ready=' + JSON.stringify(boot4.ready) + ' chooser=' + JSON.stringify(boot4.chooser)
          + ' suppressed=' + JSON.stringify(boot4.suppressed) + ' seenVersion=' + JSON.stringify(boot4.seenVersion),
    },
    {
      name: UPGRADE_MODERN_APPLIES,
      pass: modernAppliesOk,
      detail: modernAppliesOk
        ? 'data-skin=modern, prefs.skin=modern, no reload'
        : 'confirmed=' + JSON.stringify(modern.confirmed) + ' data-skin=' + JSON.stringify(modern.dataSkin)
          + ' prefs.skin=' + JSON.stringify(modern.prefsSkin) + ' dialogs=' + JSON.stringify(modern.dialogs),
    },
    {
      name: UPGRADE_MODERN_PERSISTS,
      pass: modernPersistsOk,
      detail: modernPersistsOk
        ? 'reload kept data-skin=modern and stayed quiet'
        : 'ready=' + JSON.stringify(boot5.ready) + ' data-skin=' + JSON.stringify(boot5.dataSkin)
          + ' prefs.skin=' + JSON.stringify(boot5.prefsSkin) + ' chooser=' + JSON.stringify(boot5.chooser)
          + ' seenVersion=' + JSON.stringify(boot5.seenVersion),
    },
  ];
}

/* 真机取数：只读 computed display / 包围盒 / data-win-action。 */
const readWindowControls = () => run(function () {
  var winEl = document.querySelector('.window[data-app="stickies"]') || document.querySelector('.window');
  var box = winEl ? winEl.querySelector('.window__controls') : null;
  var buttons = winEl ? winEl.querySelectorAll('.win-control') : [];
  var rect = box ? box.getBoundingClientRect() : null;
  var sizes = [];
  var names = [];
  for (var i = 0; i < buttons.length; i += 1) {
    var one = buttons[i].getBoundingClientRect();
    names.push(buttons[i].getAttribute('data-win-action') || '');
    sizes.push({ action: buttons[i].getAttribute('data-win-action') || '', w: Math.round(one.width), h: Math.round(one.height) });
  }
  return {
    controls: !!box,
    display: box ? getComputedStyle(box).display : '',
    width: rect ? Math.round(rect.width) : 0,
    height: rect ? Math.round(rect.height) : 0,
    actionNames: names,
    buttons: sizes,
    dataSkin: document.documentElement.getAttribute('data-skin') || ''
  };
});

/* 真机行为：按钮与 Ctrl/Cmd+Alt+M/W 各做一次，比较窗口管理器状态与 DOM 是否一致。
   用 prompts / draw 两个窗口，不碰首次启动夹具种下的 stickies/notes/calendar/settings。 */
const runControlBehaviour = () => run(function () {
  var P = window.PaperOS;
  function pressKey(key) {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: key,
      code: 'Key' + key.toUpperCase(),
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true
    }));
  }
  var openErrors = [];
  function openApp(id) {
    try { P.wm.open(id); } catch (err) { openErrors.push(id + ': ' + String((err && err.message) || err)); return null; }
    var list = P.wm.getWindows().filter(function (one) { return one.appId === id; });
    if (!list.length) openErrors.push(id + ': not in getWindows()');
    return list.length ? list[list.length - 1] : null;
  }
  /* 注意：publicWindow().id 是窗口 id（win_...），不是 appId；
     元素用 data-window-id 定位，getWindow() 用同一个窗口 id。 */
  function windowEl(winId) {
    return document.querySelector('.window[data-window-id="' + winId + '"]');
  }
  function minimizeByButton(winId) {
    var el = windowEl(winId);
    var button = el ? el.querySelector('[data-win-action="minimize"]') : null;
    if (button) button.click();
    var win = P.wm.getWindow(winId);
    return { clicked: !!button, minimized: !!(win && win.minimized), dom: !!(el && el.classList.contains('is-minimized')) };
  }
  function minimizeByKey(winId) {
    P.wm.focus(winId);
    pressKey('m');
    var win = P.wm.getWindow(winId);
    var el = windowEl(winId);
    return { minimized: !!(win && win.minimized), dom: !!(el && el.classList.contains('is-minimized')) };
  }
  function closeByButton(winId) {
    var el = windowEl(winId);
    var button = el ? el.querySelector('[data-win-action="close"]') : null;
    if (button) button.click();
    return { clicked: !!button, gone: !P.wm.getWindow(winId) };
  }
  function closeByKey(winId) {
    P.wm.focus(winId);
    pressKey('w');
    return { gone: !P.wm.getWindow(winId) };
  }
  var m1 = openApp('prompts');
  var m2 = openApp('draw');
  var minimizeButton = m1 ? minimizeByButton(m1.id) : { clicked: false, minimized: false, dom: false };
  var minimizeKey = m2 ? minimizeByKey(m2.id) : { minimized: false, dom: false };
  if (m1) P.wm.close(m1.id);
  if (m2) P.wm.close(m2.id);
  var c1 = openApp('prompts');
  var c2 = openApp('draw');
  var closeButton = c1 ? closeByButton(c1.id) : { clicked: false, gone: false };
  var closeKey = c2 ? closeByKey(c2.id) : { gone: false };
  if (c1 && P.wm.getWindow(c1.id)) P.wm.close(c1.id);
  if (c2 && P.wm.getWindow(c2.id)) P.wm.close(c2.id);
  var domApps = [];
  var allWindows = document.querySelectorAll('.window');
  for (var w = 0; w < allWindows.length; w += 1) domApps.push(allWindows[w].getAttribute('data-app'));
  return {
    minimizeButton: minimizeButton,
    minimizeKey: minimizeKey,
    closeButton: closeButton,
    closeKey: closeKey,
    windows: P.wm.getWindows().length,
    openErrors: openErrors,
    domApps: domApps
  };
});

if (process.argv.includes('--self-test')) {
  /* Judge the judge without a browser: no page load, no shot, no artifact. */
  const positiveBefore = { chooser: true, cards: 2, names: ['纸屿经典', '原生柔光'], dialogs: 1, tourOpen: false };
  const positiveAfter = { dialogs: 0, tourOpen: true };
  const positiveClose = { clicked: true, label: '关闭' };
  let failures = 0;
  for (const one of firstRunVerdicts(positiveBefore, positiveAfter, positiveClose)) {
    if (one.pass) console.log('PASS | ' + one.name + ' | ' + one.detail);
    else { failures += 1; console.log('FAIL | ' + one.name + ' | the clean first run must be green: ' + one.detail); }
  }
  const knownBad = [
    {
      id: 'the fixture never closes the chooser',
      before: positiveBefore,
      after: { dialogs: 1, tourOpen: false },
      closed: { clicked: false, label: '' },
      expect: FIRST_RUN_CLOSE,
    },
    {
      id: 'the tour is already open while the chooser is still up',
      before: { chooser: true, cards: 2, names: ['纸屿经典', '原生柔光'], dialogs: 1, tourOpen: true },
      after: positiveAfter,
      closed: positiveClose,
      expect: FIRST_RUN_ORDER,
    },
    {
      id: 'the chooser boots with a single card',
      before: { chooser: true, cards: 1, names: ['纸屿经典'], dialogs: 1, tourOpen: false },
      after: positiveAfter,
      closed: positiveClose,
      expect: FIRST_RUN_CARDS,
    },
    {
      id: 'no chooser appears on a fresh install',
      before: { chooser: false, cards: 0, names: [], dialogs: 0, tourOpen: false },
      after: positiveAfter,
      closed: { clicked: false, label: '' },
      expect: FIRST_RUN_CARDS,
    },
  ];
  let rejected = 0;
  for (const item of knownBad) {
    const found = firstRunVerdicts(item.before, item.after, item.closed).find((one) => one.name === item.expect);
    if (!found) { failures += 1; console.log('FAIL | self-test | unknown check name: ' + item.expect); }
    else if (found.pass) { failures += 1; console.log('FAIL | self-test | check stayed green on known-bad input: ' + found.name + ' (' + item.id + ')'); }
    else { rejected += 1; console.log('RED | ' + found.name + ' | rejected ' + item.id + ' | ' + found.detail); }
  }
  /* 双皮肤骨架：正向 + 翻面。坏状态分别是 applySkin 没生效、切换整页刷新、
     窗口/便签正文/日历选中日/设置搜索词任一丢失、以及夹具根本没造出状态。 */
  const cleanSeed = {
    instance: 0.5,
    appIds: ['notes', 'settings', 'calendar', 'stickies'],
    stickyText: '切换前写的便签正文',
    calDate: '2026-11-07',
    search: '切换前的搜索词',
  };
  const cleanAfter = {
    dataSkin: 'modern',
    instance: 0.5,
    tourOpen: true,
    dialogs: 0,
    appIds: ['notes', 'settings', 'calendar', 'stickies'],
    stickyTexts: ['切换前写的便签正文'],
    stickyInData: ['切换前写的便签正文'],
    calDate: '2026-11-07',
    search: '切换前的搜索词',
  };
  for (const one of skinSwitchVerdicts(cleanSeed, cleanAfter)) {
    if (one.pass) console.log('PASS | ' + one.name + ' | ' + one.detail);
    else { failures += 1; console.log('FAIL | ' + one.name + ' | the clean switch must be green: ' + one.detail); }
  }
  const skinBad = [
    { id: 'applySkin never runs', after: Object.assign({}, cleanAfter, { dataSkin: 'classic' }), expect: SKIN_APPLIED },
    { id: 'the switch reloads the page', after: Object.assign({}, cleanAfter, { instance: 0.9 }), expect: SKIN_NO_RELOAD },
    { id: 'an open window is lost', after: Object.assign({}, cleanAfter, { appIds: ['notes', 'calendar', 'stickies'] }), expect: SKIN_KEEPS_WINDOWS },
    { id: 'the sticky body is lost', after: Object.assign({}, cleanAfter, { stickyTexts: [], stickyInData: [] }), expect: SKIN_KEEPS_STICKY },
    { id: 'the selected day is lost', after: Object.assign({}, cleanAfter, { calDate: '' }), expect: SKIN_KEEPS_DAY },
    { id: 'the settings search is lost', after: Object.assign({}, cleanAfter, { search: '' }), expect: SKIN_KEEPS_SEARCH },
    {
      id: 'the fixture seeds nothing',
      seeded: { instance: 0.5, appIds: [], stickyText: '', calDate: '', search: '' },
      after: cleanAfter,
      expect: SKIN_SEEDED,
    },
  ];
  for (const item of skinBad) {
    const found = skinSwitchVerdicts(item.seeded || cleanSeed, item.after).find((one) => one.name === item.expect);
    if (!found) { failures += 1; console.log('FAIL | self-test | unknown check name: ' + item.expect); }
    else if (found.pass) { failures += 1; console.log('FAIL | self-test | check stayed green on known-bad input: ' + found.name + ' (' + item.id + ')'); }
    else { rejected += 1; console.log('RED | ' + found.name + ' | rejected ' + item.id + ' | ' + found.detail); }
  }
  /* 窗口控制按钮（task-6 第 2 步）：正向两侧 + 翻面。 */
  const cleanClassicControls = { controls: true, display: 'none', width: 0, height: 0, actionNames: ['minimize', 'close'] };
  const cleanModernControls = {
    controls: true, display: 'flex', width: 74, height: 24,
    actionNames: ['minimize', 'close'],
    buttons: [{ action: 'minimize', w: 24, h: 24 }, { action: 'close', w: 24, h: 24 }],
  };
  const cleanBehaviour = {
    minimizeButton: { clicked: true, minimized: true, dom: true },
    minimizeKey: { minimized: true, dom: true },
    closeButton: { clicked: true, gone: true },
    closeKey: { gone: true },
  };
  const controlPositive = [].concat(
    classicControlsVerdicts(cleanClassicControls),
    modernControlsVerdicts(cleanModernControls),
    controlBehaviourVerdicts(cleanBehaviour)
  );
  for (const one of controlPositive) {
    if (one.pass) console.log('PASS | ' + one.name + ' | ' + one.detail);
    else { failures += 1; console.log('FAIL | ' + one.name + ' | the clean window controls must be green: ' + one.detail); }
  }
  const controlBad = [
    {
      id: 'data-win-action is gone from the title bar',
      verdicts: classicControlsVerdicts({ controls: true, display: 'none', width: 0, height: 0, actionNames: ['minimize'] }),
      expect: CONTROLS_PRESENT,
    },
    {
      id: 'the classic scope rule no longer hides the controls',
      verdicts: classicControlsVerdicts({ controls: true, display: 'flex', width: 74, height: 24, actionNames: ['minimize', 'close'] }),
      expect: CONTROLS_HIDDEN_CLASSIC,
    },
    {
      id: 'the controls stay hidden in modern',
      verdicts: modernControlsVerdicts({ controls: true, display: 'none', width: 0, height: 0, actionNames: ['minimize', 'close'], buttons: [] }),
      expect: CONTROLS_VISIBLE_MODERN,
    },
    {
      id: 'the minimize button does nothing',
      verdicts: controlBehaviourVerdicts(Object.assign({}, cleanBehaviour, { minimizeButton: { clicked: true, minimized: false, dom: false } })),
      expect: CONTROLS_MINIMIZE,
    },
    {
      id: 'the minimize shortcut does nothing',
      verdicts: controlBehaviourVerdicts(Object.assign({}, cleanBehaviour, { minimizeKey: { minimized: false, dom: false } })),
      expect: CONTROLS_MINIMIZE,
    },
    {
      id: 'the close button does not close through the window manager',
      verdicts: controlBehaviourVerdicts(Object.assign({}, cleanBehaviour, { closeButton: { clicked: true, gone: false } })),
      expect: CONTROLS_CLOSE,
    },
    {
      id: 'the close shortcut does nothing',
      verdicts: controlBehaviourVerdicts(Object.assign({}, cleanBehaviour, { closeKey: { gone: false } })),
      expect: CONTROLS_CLOSE,
    },
  ];
  for (const item of controlBad) {
    const found = item.verdicts.find((one) => one.name === item.expect);
    if (!found) { failures += 1; console.log('FAIL | self-test | unknown check name: ' + item.expect); }
    else if (found.pass) { failures += 1; console.log('FAIL | self-test | check stayed green on known-bad input: ' + found.name + ' (' + item.id + ')'); }
    else { rejected += 1; console.log('RED | ' + found.name + ' | rejected ' + item.id + ' | ' + found.detail); }
  }
  /* task-13 升级路径：正向 + 翻面。每个坏状态只打中它该打中的那条断言。 */
  const cleanUpgrade = {
    boot1: {
      ready: true, version: '9.9.9', chooser: true, cards: 2, names: ['纸屿经典', '原生柔光'],
      selectedOption: 'classic', checkedValue: 'classic', classicSelected: true, modernSelected: false,
      dialogs: 1, tourOpen: false, skin: 'classic', prefsSkin: 'classic', suppressed: false, seenVersion: '',
      blocked: false,
    },
    closed: { clicked: true, label: '关闭', dialogs: 0, seenVersion: '9.9.9', skin: 'classic', suppressed: false, version: '9.9.9' },
    boot2: { ready: true, chooser: false, seenVersion: '9.9.9', skin: 'classic', prefsSkin: 'classic' },
    boot3: { ready: true, chooser: true, seenVersion: '0.3.0', classicSelected: true, skin: 'classic' },
    suppressed: { confirmed: true, checked: true, suppressed: true, seenVersion: '9.9.9', skin: 'classic', dialogs: 0 },
    boot4: { ready: true, chooser: false, suppressed: true, seenVersion: '0.3.0' },
    modern: { confirmed: true, dataSkin: 'modern', prefsSkin: 'modern', dialogs: 0, chooser: false },
    boot5: { ready: true, dataSkin: 'modern', prefsSkin: 'modern', chooser: false, seenVersion: '9.9.9' },
  };
  const upgradeBad = [
    {
      id: 'the old workspace never opens a chooser',
      patch: { boot1: Object.assign({}, cleanUpgrade.boot1, { chooser: false, cards: 0, names: [] }) },
      expect: UPGRADE_CHOOSER,
    },
    {
      id: 'the upgrade chooser preselects modern',
      patch: { boot1: Object.assign({}, cleanUpgrade.boot1, { selectedOption: 'modern', checkedValue: 'modern', classicSelected: false, modernSelected: true }) },
      expect: UPGRADE_DEFAULT_CLASSIC,
    },
    {
      id: 'closing never records the prompt version',
      patch: { closed: Object.assign({}, cleanUpgrade.closed, { seenVersion: '' }) },
      expect: UPGRADE_CLOSE_RECORDS,
    },
    {
      id: 'the same version keeps prompting',
      patch: { boot2: Object.assign({}, cleanUpgrade.boot2, { chooser: true }) },
      expect: UPGRADE_SAME_VERSION_QUIET,
    },
    {
      id: 'an upgrade from an older version stays quiet',
      patch: { boot3: Object.assign({}, cleanUpgrade.boot3, { chooser: false }) },
      expect: UPGRADE_OLDER_VERSION_PROMPTS,
    },
    {
      id: 'confirm never writes the permanent suppress flag',
      patch: { suppressed: Object.assign({}, cleanUpgrade.suppressed, { suppressed: false }) },
      expect: UPGRADE_SUPPRESS_WRITES,
    },
    {
      id: 'a permanently suppressed workspace prompts again',
      patch: { boot4: Object.assign({}, cleanUpgrade.boot4, { chooser: true }) },
      expect: UPGRADE_SUPPRESSED_QUIET,
    },
    {
      id: 'confirming modern leaves the classic skin on',
      patch: { modern: Object.assign({}, cleanUpgrade.modern, { dataSkin: 'classic', prefsSkin: 'classic' }) },
      expect: UPGRADE_MODERN_APPLIES,
    },
    {
      id: 'the modern choice is lost on the next boot',
      patch: { boot5: Object.assign({}, cleanUpgrade.boot5, { dataSkin: 'classic', prefsSkin: 'classic' }) },
      expect: UPGRADE_MODERN_PERSISTS,
    },
  ];
  const upgradePositive = upgradePathVerdicts(cleanUpgrade);
  for (const one of upgradePositive) {
    if (one.pass) console.log('PASS | ' + one.name + ' | ' + one.detail);
    else { failures += 1; console.log('FAIL | ' + one.name + ' | the clean upgrade path must be green: ' + one.detail); }
  }
  for (const item of upgradeBad) {
    const found = upgradePathVerdicts(Object.assign({}, cleanUpgrade, item.patch)).find((one) => one.name === item.expect);
    if (!found) { failures += 1; console.log('FAIL | self-test | unknown check name: ' + item.expect); }
    else if (found.pass) { failures += 1; console.log('FAIL | self-test | check stayed green on known-bad input: ' + found.name + ' (' + item.id + ')'); }
    else { rejected += 1; console.log('RED | ' + found.name + ' | rejected ' + item.id + ' | ' + found.detail); }
  }
  /* PENDING 登记表本身也要被审计：注册语义错，会把"红"悄悄洗成"待办"。 */
  const SELF_TEST_PENDING = { 'a registered assertion': 'K9' };
  const pendingCases = [
    { id: 'registered + failed in modern counts as pending', name: 'a registered assertion', passed: false, modern: true, expect: 'pending' },
    { id: 'registered + green in modern asks for closure', name: 'a registered assertion', passed: true, modern: true, expect: 'cleared' },
    { id: 'unregistered + failed in modern still fails', name: 'an assertion nobody registered', passed: false, modern: true, expect: 'fail' },
    { id: 'registered + failed in classic is not excused', name: 'a registered assertion', passed: false, modern: false, expect: 'fail' },
    { id: 'unregistered + green is a plain pass', name: 'an assertion nobody registered', passed: true, modern: true, expect: 'pass' },
  ];
  for (const item of pendingCases) {
    const got = pendingVerdict(item.name, item.passed, item.modern, SELF_TEST_PENDING);
    if (got === item.expect) console.log('PASS | modern pending registry: ' + item.id + ' | ' + got);
    else { failures += 1; console.log('FAIL | modern pending registry: ' + item.id + ' | got ' + got + ', expected ' + item.expect); }
  }
  console.log('self-test: cases ' + (knownBad.length + skinBad.length + controlBad.length + upgradeBad.length + pendingCases.length) + ' / rejected ' + rejected + ' / FAIL ' + failures);
  process.exit(failures ? 1 : 0);
}

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
if (!wsUrl) { console.log('FAIL | could not attach to browser'); proc.kill(); dropMutatedPage(); dropProfile(); process.exit(1); }

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
/* 导航是异步的：Page.navigate/Page.reload 未提交时 evaluate 会落回旧文档，而旧文档的
   __PAPER_OS_READY__ 仍是 true —— 会把上一页的状态当成新页面的结果（k3 只读夹具实测
   偶发 blocked=false）。导航前在旧文档写标记，waitReady 只认"标记不存在 + READY"。 */
const markLeaving = () => ev('try { window.__NAV_TOKEN__ = "leaving"; } catch (err) {}');

/* 动画闸（第三次踩同类坑：皮肤过渡 → 拖动过渡 → 窗口入场动画）：
   取任何几何/颜色之前，先等 document.getAnimations() 里没有 running 的动画。
   420 的 13,74,374,659 就是入场 scale(.985)+translateY(9) 的中间态，已排除。 */
const ANIMATIONS_IDLE = '(function () { if (!document.getAnimations) return true; var list = document.getAnimations(); for (var i = 0; i < list.length; i += 1) { if (list[i].playState === "running") return false; } return true; })()';
const waitAnimationsIdle = async (limit) => {
  for (let i = 0; i < (limit || 30); i += 1) {
    if (await ev(ANIMATIONS_IDLE)) return true;
    await sleep(80);
  }
  return false;
};
const shot = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, name + '.png'), Buffer.from(s.result.data, 'base64'));
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await markLeaving();
await send('Page.navigate', { url: PAGE_URL });

/* 隐藏页不投递 resize / 不跑 rAF（ui-k4 16 连跑的根因）：
   导航后先把目标页带到前台，ready 必须同时满足「可见」，否则明确失败。
   若一直 hidden，haltReason 会说明原因，调用方把它打进 FAIL 详情。 */
/* ---------- 测量点可见性守卫（K2 §8.4b / K7 收口） ----------
   隐藏页会暂停 rAF 与 resize 投递：任何依赖事件驱动的测量都会被误判成产品缺陷。
   这里把可见性变成"每个 stage 前都重新断言"的条件：
   - 发现 hidden 先 Page.bringToFront 重试（有限次），成功计入 recoveries；
   - 重试后仍 hidden：记一次 visibility loss，该轮标记 INVALID（不是产品失败），
     由 RUN-FINGERPRINT 的 invalid 字段与退出码 4 表达，K7 的 3 连不计这一轮。 */
const VISIBILITY_RETRIES = 3;
const visibilityTrail = [];
const visibilityLostAt = [];
let visibilityRecoveries = 0;
let visibilityLosses = 0;
let lastVisibilityLossAt = 0;
const noteVisibility = (value) => {
  const state = String(value || 'unknown');
  if (visibilityTrail[visibilityTrail.length - 1] !== state) visibilityTrail.push(state);
  lastVisibility = state;
  return state;
};
const recoverVisibility = async (where) => {
  for (let attempt = 0; attempt < VISIBILITY_RETRIES; attempt += 1) {
    try { await send('Page.bringToFront'); } catch (err) { /* older targets */ }
    await sleep(160);
    if (noteVisibility(await ev('document.visibilityState')) === 'visible') {
      visibilityRecoveries += 1;
      return true;
    }
  }
  /* 同一段持续隐藏只记一次：几十个采样不该把计数刷成几十。 */
  if (Date.now() - lastVisibilityLossAt > 1200) {
    visibilityLosses += 1;
    lastVisibilityLossAt = Date.now();
    visibilityLostAt.push(String(where || 'measurement'));
  }
  return false;
};
/* 每个 stage 开始前调用：可见就继续；hidden 先救一次，救不回来也继续跑完
   （断言照实记录），但整轮在收口时标成 INVALID。 */
const stageGuard = async (label) => {
  const state = noteVisibility(await ev('document.visibilityState'));
  if (state === 'visible') return true;
  const recovered = await recoverVisibility(label);
  if (!recovered) console.log('VISIBILITY-LOST | ' + String(label) + ' | document.visibilityState=' + JSON.stringify(state));
  return recovered;
};
const ensureVisibleForSample = async (where) => {
  if (noteVisibility(await ev('document.visibilityState')) === 'visible') return true;
  return recoverVisibility(where);
};
let lastVisibility = '';
let readyHaltReason = '';
const waitReady = async () => {
  try { await send('Page.bringToFront'); } catch (err) { /* older targets */ }
  let hidden = 0;
  for (let i = 0; i < 80; i += 1) {
    await sleep(250);
    if (noteVisibility(await ev('document.visibilityState')) !== 'visible') {
      hidden += 1;
      /* 隐藏页不重试 bringToFront 就会一路等到 20s 超时：每 4 拍再要一次前台。 */
      if (hidden % 4 === 0) {
        try { await send('Page.bringToFront'); } catch (err) { /* older targets */ }
      }
      if (i === 79) readyHaltReason = 'document.visibilityState=' + JSON.stringify(lastVisibility) + ' (hidden page pauses rAF/resize)';
      continue;
    }
    hidden = 0;
    if (await ev('typeof window.__NAV_TOKEN__ === "undefined" && !!window.__PAPER_OS_READY__')) return true;
  }
  if (!readyHaltReason) readyHaltReason = 'READY never became true (visibility=' + JSON.stringify(lastVisibility) + ')';
  return false;
};
await stageGuard('first boot');
if (!(await waitReady())) {
  bad('page boots', 'never became ready | ' + readyHaltReason);
  console.log('checks: PASS 0 / FAIL 1');
  proc.kill();
  dropMutatedPage();
  dropProfile();
  process.exit(1);
}
ok('page boots');

/* ---------- 02 §3 首次启动：皮肤选择页先出现，关掉它之后才是导览 ----------
   全新 profile 就是全新安装。K1 起页面一起来就弹真模态（P.ui.dialog 的
   <dialog> + .skin-choice），不先按用户路径关掉它，后面每一条命中 DOM 的断言
   都会被模态吃掉（未加夹具时人工复跑：PASS 157 / FAIL 10，失败多为
   bandHit:false 与焦点/点击落在 dialog 上）。 */
const firstRunState = () => run(function () {
  var dialog = document.querySelector('.paper-dialog[open]');
  var choice = dialog ? dialog.querySelector('.skin-choice') : null;
  var names = [];
  if (choice) {
    var nodes = choice.querySelectorAll('.skin-choice__name');
    for (var i = 0; i < nodes.length; i += 1) names.push(String(nodes[i].textContent || '').trim());
  }
  return {
    chooser: !!choice,
    cards: choice ? choice.querySelectorAll('.skin-choice__card').length : 0,
    names: names,
    dialogs: document.querySelectorAll('.paper-dialog[open]').length,
    tourOpen: !!document.querySelector('.tour.is-open'),
    skin: document.documentElement.getAttribute('data-skin') || ''
  };
});

let firstRunBefore = { chooser: false, cards: 0, names: [], dialogs: 0, tourOpen: false, skin: '' };
for (let i = 0; i < 24; i += 1) {
  firstRunBefore = (await firstRunState()) || firstRunBefore;
  if (firstRunBefore.chooser) break;
  await sleep(150);
}

/* --mutate 专用：把"导览先开、选择页还在"的叠加态真的造出来。 */
if (MUTATE === 'tour-first') {
  await ev('try { window.PaperOS.tour.start(); } catch (err) {}');
  await sleep(220);
  firstRunBefore = (await firstRunState()) || firstRunBefore;
}

/* ---------- task-7 双皮肤骨架：classic 走「关闭」保持现状；modern 走「确认」，
   并验证 02 §2 的即时生效 / 不整页刷新 / 不丢状态。 --skin=modern 不接进
   run_all_checks 默认路径（K2 未完成期把红带进日常门禁没有意义）。 */
const classicMutation = MUTATE === 'skip-close' || MUTATE === 'tour-first';
const pageMutation = MUTATE === 'no-apply-skin' || MUTATE === 'switch-reloads';
const controlMutation = MUTATE === 'no-classic-hide' || MUTATE === 'controls-private';
/* 每个变异要求跑的皮肤：控制按钮作用域在 classic 侧验，行为在 modern 侧验。 */
const MUTATION_SKIN = {
  'skip-close': 'classic',
  'tour-first': 'classic',
  'no-classic-hide': 'classic',
  'no-apply-skin': 'modern',
  'switch-reloads': 'modern',
  'controls-private': 'modern',
  'dark-token-light': 'modern',
  'no-resize-clamp': 'classic',
  'clamp-only-on-open': 'classic',
  'settle-single-pass': 'classic',
  'modern-urgent-sage': 'modern',
  'one-carrier-drift': 'modern',
};
const effectiveSkin = MUTATION_SKIN[MUTATE] || SKIN;

const finishMutation = async () => {
  /* 变异跑只为证明断言真的会红：不看后面，直接收口（kill + 删 profile/临时页照旧）。 */
  if (!checks.some((one) => !one[0])) {
    bad('mutation ' + MUTATE, 'known-bad state stayed green: the fixture assertion is vacuous');
  }
  const left = checks.filter((one) => !one[0]);
  console.log('checks: PASS ' + (checks.length - left.length) + ' / FAIL ' + left.length);
  ws.close();
  proc.kill();
  await sleep(200);
  dropMutatedPage();
  dropProfile();
  process.exit(1);
};

let firstRunClose = { clicked: false, label: '' };

if (effectiveSkin === 'classic') {
  /* 像用户一样按「关闭」（ghost 动作 = 非确认关闭，保持经典皮肤）。不按确认：
     确认会写永久关闭开关，升级提示的场景就不一样了。 */
  if (MUTATE !== 'skip-close') {
    firstRunClose = (await run(function () {
      var dialog = document.querySelector('.paper-dialog[open]');
      if (!dialog) return { clicked: false, label: '' };
      var buttons = dialog.querySelectorAll('.dialog-actions .paper-btn');
      var target = null;
      for (var i = 0; i < buttons.length; i += 1) {
        if (buttons[i].classList.contains('paper-btn--ghost')) { target = buttons[i]; break; }
      }
      if (!target && buttons.length) target = buttons[0];
      if (!target) return { clicked: false, label: '' };
      var label = String(target.textContent || '').trim();
      target.click();
      return { clicked: true, label: label };
    })) || { clicked: false, label: '' };
  }

  /* 关闭后：(1) 不再有打开的 dialog；(2) 导览这时才允许出现（关闭后 320ms 起）。 */
  let firstRunAfter = { dialogs: 1, tourOpen: false };
  for (let i = 0; i < 30; i += 1) {
    firstRunAfter = (await firstRunState()) || firstRunAfter;
    if (firstRunAfter.dialogs === 0 && firstRunAfter.tourOpen) break;
    if (MUTATE === 'skip-close' && i >= 6) break;
    await sleep(150);
  }

  for (const one of firstRunVerdicts(firstRunBefore, firstRunAfter, firstRunClose)) {
    if (one.pass) ok(one.name, one.detail);
    else bad(one.name, one.detail);
  }

  /* 经典侧作用域断言：控制按钮的 DOM 存在，但 CSS 必须把它们藏起来（AC-05 不回归）。
     只读 computed display 与包围盒，不看截图。 */
  await ev('try { window.PaperOS.wm.open("stickies"); } catch (err) {}');
  await sleep(150);
  await waitAnimationsIdle();
  const classicControls = await readWindowControls();
  for (const one of classicControlsVerdicts(classicControls)) {
    if (one.pass) ok(one.name, one.detail);
    else bad(one.name, one.detail);
  }
  await ev('try { var P = window.PaperOS; P.wm.getWindows().forEach(function (w) { if (w.appId === "stickies") P.wm.close(w.id); }); } catch (err) {}');

  if (classicMutation || MUTATE === 'no-classic-hide') await finishMutation();
} else {
  /* modern：先在模态后面把"切换不该丢"的状态造出来（模态开着用户点不到别处，
     e2e 用公开 API 与程序点击造状态；断言只看切换前后是否还在），再走确认路径。 */
  const seeded = (await run(function () {
    var P = window.PaperOS;
    /* 不刷新判据：这个实例标记只活在本 document，整页刷新就没了。 */
    window.__INSTANCE__ = Math.random();
    var opened = [];
    function openOne(id, params) {
      try { P.wm.open(id, params); opened.push(id); } catch (err) { /* 记在 opened 里 */ }
    }
    openOne('stickies');
    openOne('notes');
    openOne('calendar');
    openOne('settings', { section: 'commands' });
    var made = null;
    try { made = P.data.createSticky({ text: '切换前写的便签正文' }); } catch (err) { made = null; }
    /* 日历：点一个本月、非今天的格子 */
    var picked = '';
    var cells = document.querySelectorAll('.cal-day[data-date]');
    for (var i = 0; i < cells.length; i += 1) {
      var cell = cells[i];
      if (cell.classList.contains('is-outside') || cell.classList.contains('is-today')) continue;
      cell.click();
      picked = cell.getAttribute('data-date') || '';
      break;
    }
    /* 设置里的搜索词 */
    var input = document.querySelector('[data-command-input]');
    var typed = '';
    if (input) {
      typed = '切换前的搜索词';
      input.value = typed;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    var wins = [];
    try { wins = P.wm.getWindows().filter(function (w) { return !w.minimized; }).map(function (w) { return w.appId; }); } catch (err) { wins = []; }
    return {
      instance: typeof window.__INSTANCE__ === 'number' ? window.__INSTANCE__ : null,
      appIds: wins,
      stickyText: made && made.text ? made.text : '',
      calDate: picked,
      search: typed,
      opened: opened
    };
  })) || null;

  /* 确认路径：选第二张卡（原生柔光）+ 点确认，走 finishSkinChoice 的确认分支。 */
  firstRunClose = (await run(function () {
    var dialog = document.querySelector('.paper-dialog[open]');
    if (!dialog) return { clicked: false, label: '' };
    var card = dialog.querySelector('[data-skin-option="modern"]');
    if (card) {
      var pick = card.querySelector('input');
      if (pick) pick.click();
      else card.click();
    }
    var buttons = dialog.querySelectorAll('.dialog-actions .paper-btn');
    var target = null;
    for (var i = 0; i < buttons.length; i += 1) {
      if (buttons[i].classList.contains('paper-btn--ink')) { target = buttons[i]; break; }
    }
    if (!target && buttons.length) target = buttons[buttons.length - 1];
    if (!target) return { clicked: false, label: '' };
    var label = String(target.textContent || '').trim();
    target.click();
    return { clicked: true, label: label };
  })) || { clicked: false, label: '' };

  const readAfterSwitch = () => run(function () {
    var P = window.PaperOS;
    var selected = document.querySelector('.cal-day.is-selected[data-date]');
    var input = document.querySelector('[data-command-input]');
    var areas = document.querySelectorAll('.sticky__text');
    var texts = [];
    for (var i = 0; i < areas.length; i += 1) texts.push(String(areas[i].value || ''));
    var wins = [];
    try { wins = P.wm.getWindows().filter(function (w) { return !w.minimized; }).map(function (w) { return w.appId; }); } catch (err) { wins = []; }
    var stickies = [];
    try { stickies = P.data.listStickies().map(function (one) { return one.text; }); } catch (err) { stickies = []; }
    return {
      dataSkin: document.documentElement.getAttribute('data-skin') || '',
      instance: typeof window.__INSTANCE__ === 'number' ? window.__INSTANCE__ : null,
      tourOpen: !!document.querySelector('.tour.is-open'),
      dialogs: document.querySelectorAll('.paper-dialog[open]').length,
      appIds: wins,
      stickyTexts: texts,
      stickyInData: stickies,
      calDate: selected ? selected.getAttribute('data-date') : '',
      search: input ? String(input.value || '') : ''
    };
  });

  let afterSwitch = {
    dataSkin: '', instance: null, tourOpen: false, dialogs: 1,
    appIds: [], stickyTexts: [], stickyInData: [], calDate: '', search: '',
  };
  for (let i = 0; i < 30; i += 1) {
    const current = await readAfterSwitch();
    if (current && !current.__err) afterSwitch = current;
    if (afterSwitch.dataSkin === 'modern' && afterSwitch.dialogs === 0 && afterSwitch.tourOpen) break;
    await sleep(150);
  }

  for (const one of firstRunVerdicts(firstRunBefore, afterSwitch, firstRunClose)) {
    if (one.pass) ok(one.name, one.detail);
    else bad(one.name, one.detail);
  }
  for (const one of skinSwitchVerdicts(seeded, afterSwitch)) {
    if (one.pass) ok(one.name, one.detail);
    else bad(one.name, one.detail);
  }

  /* modern 侧：控制按钮必须真的可见，且点击行为与 Ctrl/Cmd+Alt+M/W 同一入口。 */
  await waitAnimationsIdle();
  const modernControls = await readWindowControls();
  for (const one of modernControlsVerdicts(modernControls)) {
    if (one.pass) ok(one.name, one.detail);
    else bad(one.name, one.detail);
  }
  await waitAnimationsIdle();
  const controlBehaviour = await runControlBehaviour();
  for (const one of controlBehaviourVerdicts(controlBehaviour)) {
    if (one.pass) ok(one.name, one.detail);
    else bad(one.name, one.detail);
  }

  /* 夹具种下的窗口在断言完成后收掉：后面的布局/焦点/窄面板断言按 classic 的
     同一起点跑，不让"夹具留窗"改写它们的窗口状态前提。 */
  await ev('try { var P = window.PaperOS; P.wm.getWindows().forEach(function (w) { if (["stickies", "notes", "calendar", "settings"].indexOf(w.appId) !== -1) P.wm.close(w.id); }); } catch (err) {}');
  await sleep(200);

  if (pageMutation || MUTATE === 'controls-private') await finishMutation();
}

/* 导览带 0.46 遮罩，留着会压暗截图、吃掉点击：夹具自己收尾。 */
await ev('try { window.PaperOS.tour.close(); } catch (err) {}');
await sleep(260);

const version = await ev('window.PaperOS.version');
if (version && version !== '__PAGE_VERSION__') ok('page version injected by the build', String(version));
else bad('page version injected by the build', String(version));
const schema = await ev('window.PaperOS.schemaVersion');
if (schema === 5) ok('schema is v5'); else bad('schema is v5', String(schema));

// The Chinese page is the source of truth: it runs with the zh runtime and F() keeps the wording.
const zhRuntime = await ev('({ lang: (window.PaperOS && window.PaperOS.lang) || "", sample: window.PaperOS ? window.PaperOS.F("{n} 张纸页", 2) : "" })');
if (zhRuntime && zhRuntime.lang === 'zh' && zhRuntime.sample === '2 张纸页') ok('the Chinese page runs with P.lang=zh', JSON.stringify(zhRuntime));
else bad('the Chinese page runs with P.lang=zh', JSON.stringify(zhRuntime));

const seededPrompts = await run(function () {
  var P = window.PaperOS;
  return { samples: P.data.getExampleCounts().prompts, total: P.data.listPrompts('').length };
});
if (seededPrompts && seededPrompts.samples === 5) ok('first run seeds five sample prompts', JSON.stringify(seededPrompts));
else bad('first run seeds five sample prompts', JSON.stringify(seededPrompts));

await stageGuard("first open fills the work area");
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

await stageGuard("day seal");
// --- day seal ---
const seal = await run(function () {
  var el = document.getElementById('day-seal');
  return el ? el.textContent.replace(/\s+/g, '') : '';
});
if (seal && seal.indexOf('宜') === 0) ok('day seal shows 宜…', seal);
else bad('day seal shows 宜…', JSON.stringify(seal));

await stageGuard("calendar dots");
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

await stageGuard("R7 日历：中文表头周一…周日、SELECTED DAY 小标题删除、日期行仍在");
// --- R7 日历：中文表头周一…周日、SELECTED DAY 小标题删除、日期行仍在 ---
const calendarChrome = await run(function () {
  var shell = document.querySelector('.window[data-app=calendar]');
  if (!shell) return { error: 'no calendar window' };
  var header = shell.querySelector('.calendar-weekdays');
  var cells = [];
  if (header) {
    var spans = header.querySelectorAll('span');
    for (var i = 0; i < spans.length; i += 1) cells.push(spans[i].textContent);
  }
  var selected = shell.querySelector('[data-selected-date]');
  return {
    weekdays: cells.join(''),
    kickerParagraphs: shell.querySelectorAll('.calendar-tasks__date p').length,
    selectedDate: selected ? selected.textContent.trim() : ''
  };
});
if (calendarChrome && !calendarChrome.error && calendarChrome.weekdays === '周一周二周三周四周五周六周日') ok('the zh weekday header runs Monday to Sunday', calendarChrome.weekdays);
else bad('the zh weekday header runs Monday to Sunday', JSON.stringify(calendarChrome && calendarChrome.weekdays));
if (calendarChrome && !calendarChrome.error && calendarChrome.kickerParagraphs === 0 && calendarChrome.selectedDate) ok('the SELECTED DAY kicker is gone but the date line stays', JSON.stringify({ kickerParagraphs: calendarChrome.kickerParagraphs, selectedDate: calendarChrome.selectedDate }));
else bad('the SELECTED DAY kicker is gone but the date line stays', JSON.stringify(calendarChrome));

await stageGuard("recurring task projection");
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

await stageGuard("resolve / restore");
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

await stageGuard("stickies");
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

await stageGuard("sticky drag from the card body (not just a handle)");
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

await stageGuard("trash dialog lists what was deleted");
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

await stageGuard("notes");
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
  /* 正文是 contenteditable，没有 placeholder 属性可读：占位提示由 CSS
     .note-body:empty::before 的 content: attr(placeholder) 画出来。
     这里读计算样式，测的是用户真正看到的那行字，而不是某个属性存在。 */
  var drawn = '';
  try { drawn = String(window.getComputedStyle(body, '::before').content || ''); } catch (err) { drawn = ''; }
  return {
    titleValue: input.value,
    titlePlaceholder: input.placeholder,
    bodyPlaceholder: body.getAttribute('placeholder'),
    bodyDrawnPlaceholder: drawn.replace(/^"|"$/g, ''),
    bodyEditable: body.getAttribute('contenteditable'),
    bodyEmpty: body.childNodes.length === 0
  };
});
if (note && note.titleValue === '' && /名字/.test(note.titlePlaceholder || '')) ok('new note title is a placeholder, not literal text', JSON.stringify(note));
else bad('new note title is a placeholder, not literal text', JSON.stringify(note));
if (note && note.bodyPlaceholder === '从这里开始写，纸会自动收好。') ok('note body placeholder uses a comma');
else bad('note body placeholder uses a comma', JSON.stringify(note && note.bodyPlaceholder));
if (note && note.bodyDrawnPlaceholder === '从这里开始写，纸会自动收好。') ok('an empty note actually paints its placeholder', JSON.stringify(note.bodyDrawnPlaceholder));
else bad('an empty note actually paints its placeholder', JSON.stringify(note && note.bodyDrawnPlaceholder));
if (note && note.bodyEditable === 'true' && note.bodyEmpty === true) ok('the note body is an empty contenteditable block editor', JSON.stringify({ editable: note.bodyEditable, empty: note.bodyEmpty }));
else bad('the note body is an empty contenteditable block editor', JSON.stringify(note && { editable: note.bodyEditable, empty: note.bodyEmpty }));

await stageGuard("R6/R1 纸页：面包屑删除；置顶开关 / 徽标 / 排序 / 快照往返");
// --- R6/R1 纸页：面包屑删除；置顶开关 / 徽标 / 排序 / 快照往返 ---
const notePin = await run(function () {
  var P = window.PaperOS;
  P.wm.open('notes');
  var shell = document.querySelector('.window[data-app=notes]');
  if (!shell) return { error: 'no notes window' };
  var created = P.data.createNote({ name: '置顶回归纸页', content: '刷新与导入都不能丢。' });
  P.wm.open('notes', { docId: created.id });
  var btn = shell.querySelector('[data-testid="note-pin"]');
  if (!btn) return { error: 'no pin button' };
  var before = { text: btn.textContent, pressed: btn.getAttribute('aria-pressed'), disabled: btn.disabled };
  btn.click();
  var node = P.data.getNode(created.id);
  var list = P.data.listNotes();
  var pinned = {
    value: node ? node.pinned : null,
    pressed: btn.getAttribute('aria-pressed'),
    text: btn.textContent,
    badges: shell.querySelectorAll('.note-item__pin').length,
    firstId: list.length ? list[0].id : null
  };
  var snap = P.data.snapshotData();
  var ingested = P.ingestWorkspace(JSON.parse(JSON.stringify(snap)));
  var back = ingested && ingested.ok ? ingested.snapshot.nodes.filter(function (n) { return n.id === created.id; })[0] : null;
  var roundTrip = back ? back.pinned : null;
  btn.click();
  var cleared = P.data.getNode(created.id);
  var off = {
    value: cleared ? cleared.pinned : null,
    pressed: btn.getAttribute('aria-pressed'),
    text: btn.textContent,
    badges: shell.querySelectorAll('.note-item__pin').length
  };
  return {
    id: created.id,
    breadcrumb: !!document.querySelector('[data-breadcrumb]'),
    before: before,
    pinned: pinned,
    roundTrip: roundTrip,
    off: off
  };
});
if (notePin && !notePin.error && notePin.breadcrumb === false) ok('the notes editor has no breadcrumb', 'no [data-breadcrumb] in the page');
else bad('the notes editor has no breadcrumb', JSON.stringify(notePin && notePin.breadcrumb));
if (notePin && !notePin.error && notePin.before.text === '置顶' && notePin.before.pressed === 'false' && notePin.before.disabled === false) ok('the note pin starts unpressed', JSON.stringify(notePin.before));
else bad('the note pin starts unpressed', JSON.stringify(notePin && notePin.before));
if (notePin && !notePin.error && notePin.pinned.value === true && notePin.pinned.pressed === 'true' && notePin.pinned.text === '取消置顶' && notePin.pinned.badges === 1 && notePin.pinned.firstId === notePin.id) ok('pinning a note sets the flag, the pressed state, the badge and the order', JSON.stringify(notePin.pinned));
else bad('pinning a note sets the flag, the pressed state, the badge and the order', JSON.stringify(notePin && notePin.pinned));
if (notePin && !notePin.error && notePin.roundTrip === true) ok('a pinned note survives the workspace round-trip', 'pinned=' + notePin.roundTrip);
else bad('a pinned note survives the workspace round-trip', JSON.stringify(notePin && notePin.roundTrip));
if (notePin && !notePin.error && notePin.off.value === false && notePin.off.pressed === 'false' && notePin.off.text === '置顶' && notePin.off.badges === 0) ok('the note pin can be turned off again', JSON.stringify(notePin.off));
else bad('the note pin can be turned off again', JSON.stringify(notePin && notePin.off));

await stageGuard("drawing");
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

await stageGuard("window titlebar: kicker + title, but never the same word twice");
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

await stageGuard("theme");
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

await stageGuard("macOS top clearance: the page paints the inset band itself");
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
/* 顶栏高度按皮肤取合同值（classic 56 / modern 58，±1），band 高度只由
   "实测顶栏高度 + 注入的 clearance" 推出；换皮肤不需要改这些断言。 */
const barContract = expectedTopbar(effectiveSkin);
const barWithinContract = Math.abs(ctBase.height - barContract) <= SKIN_TOPBAR_TOLERANCE;
const barContractDetail = ' skin=' + effectiveSkin + ' expected=' + barContract + '+/-' + SKIN_TOPBAR_TOLERANCE;
if (!clearance || clearance.error) bad('top clearance probe runs', JSON.stringify(clearance));
else if (barWithinContract && ctBase.padTop === 0 && ctBase.top === 0) ok('top bar sits flush at the top when there is no clearance', JSON.stringify(ctBase) + barContractDetail);
else bad('top bar sits flush at the top when there is no clearance', JSON.stringify(ctBase) + barContractDetail);
if (!clearance || clearance.error) bad('the 48px band is painted by the page top bar', 'probe failed');
else if (ctMac.top === 0 && ctMac.height === ctBase.height + 48 && ctMac.bandHit && ctMac.painted && !ctMac.tourOpen) ok('the 48px band is painted by the page top bar', JSON.stringify(ctMac) + ' band==' + ctBase.height + '+48');
else bad('the 48px band is painted by the page top bar', JSON.stringify(ctMac) + ' band?=' + ctBase.height + '+48');
if (!clearance || clearance.error) bad('top bar content keeps its row, shifted by exactly the clearance', 'probe failed');
else if (ctMac.padTop === 48 && ctMac.rowTop - ctBase.rowTop === 48) ok('top bar content keeps its row, shifted by exactly the clearance', 'padTop=' + ctMac.padTop + ' rowTop ' + ctBase.rowTop + ' -> ' + ctMac.rowTop);
else bad('top bar content keeps its row, shifted by exactly the clearance', 'padTop=' + ctMac.padTop + ' rowTop ' + ctBase.rowTop + ' -> ' + ctMac.rowTop);
if (!clearance || clearance.error) bad('the stage gives up the clearance and the desk keeps 100dvh', 'probe failed');
else if (ctMac.stageTop === ctMac.height && ctMac.stageHeight === ctBase.stageHeight - 48 && ctMac.osHeight === ctViewport) ok('the stage gives up the clearance and the desk keeps 100dvh', 'stage ' + ctBase.stageHeight + ' -> ' + ctMac.stageHeight + ', desk=' + ctMac.osHeight);
else bad('the stage gives up the clearance and the desk keeps 100dvh', JSON.stringify(ctMac) + ' stageTop?=' + ctMac.height);
if (!clearance || clearance.error) bad('the clearance band causes no horizontal overflow', 'probe failed');
else if (ctMac.overflowX === 0 && ctMac.width === ctBase.width) ok('the clearance band causes no horizontal overflow', 'overflowX=' + ctMac.overflowX + ' width=' + ctMac.width);
else bad('the clearance band causes no horizontal overflow', 'overflowX=' + ctMac.overflowX + ' width=' + ctMac.width);
if (!clearance || clearance.error) bad('the band is driven by the variable, not a hard-coded 48px', 'probe failed');
else if (ctOther.height === ctBase.height + 37 && ctOther.padTop === 37 && ctOther.stageHeight === ctBase.stageHeight - 37 && ctOther.bandHit) ok('the band is driven by the variable, not a hard-coded 48px', JSON.stringify(ctOther) + ' band?=' + ctBase.height + '+37');
else bad('the band is driven by the variable, not a hard-coded 48px', JSON.stringify(ctOther) + ' band?=' + ctBase.height + '+37');
if (!clearance || clearance.error) bad('clearing the variable restores the base top bar', 'probe failed');
else if (ctBack.height === ctBase.height && ctBack.padTop === 0 && ctBack.rowTop === ctBase.rowTop && ctBack.stageHeight === ctBase.stageHeight && ctBack.overflowX === 0) ok('clearing the variable restores the base top bar', JSON.stringify(ctBack) + ' base=' + ctBase.height);
else bad('clearing the variable restores the base top bar', JSON.stringify(ctBack) + ' base=' + ctBase.height);

await stageGuard("R5 顶栏：时钟删除、可见文字清零，但 #save-text 的播报节点与齿轮仍活");
// --- R5 顶栏：时钟删除、可见文字清零，但 #save-text 的播报节点与齿轮仍活 ---
const topbarEmpty = await run(function () {
  var P = window.PaperOS;
  if (P.tour && P.tour.close) P.tour.close();
  var right = document.querySelector('.topbar__right');
  var saveText = document.getElementById('save-text');
  var gear = document.getElementById('settings-btn');
  var pill = document.getElementById('save-pill');
  if (!right || !saveText || !gear || !pill) return { error: 'topbar parts missing' };
  var cs = getComputedStyle(saveText);
  var box = saveText.getBoundingClientRect();
  /* .sr-only 仍有 1x1 rect，不能用 getClientRects().length === 0 判断不可见；
     这里按 D-01 的口径同时核对 class / 计算尺寸 / 定位与裁切。 */
  var visible = [];
  var nodes = right.querySelectorAll('*');
  for (var i = 0; i < nodes.length; i += 1) {
    var el = nodes[i];
    if (el.classList.contains('sr-only')) continue;
    if (el.children.length) continue;
    var text = (el.textContent || '').trim();
    if (text) visible.push(text);
  }
  return {
    hasClock: !!document.querySelector('.clock'),
    clockTime: !!document.getElementById('clock-time'),
    saveTextPresent: !!saveText,
    saveTextClass: String(saveText.className || ''),
    saveTextContent: String(saveText.textContent || '').trim(),
    saveRect: { w: box.width, h: box.height },
    savePosition: cs.position,
    saveClip: cs.clip || cs.clipPath || '',
    pillRect: (function () { var r = pill.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
    visibleText: visible.join(''),
    gearPresent: !!gear
  };
});
const clockGone = topbarEmpty && !topbarEmpty.error && topbarEmpty.hasClock === false && topbarEmpty.clockTime === false;
if (clockGone) ok('the topbar clock is gone', JSON.stringify({ clock: topbarEmpty.hasClock, clockTime: topbarEmpty.clockTime }));
else bad('the topbar clock is gone', JSON.stringify(topbarEmpty));
/* 保存文字按皮肤分档（K7 双皮肤分档的活，先做掉）：
   classic 继续是 1x1 的 sr-only 播报节点；modern 允许把它显示成标签，
   但必须有真实文字，不能两头都空着。 */
const saveSrOnly = topbarEmpty && !topbarEmpty.error
  && topbarEmpty.saveTextPresent
  && topbarEmpty.saveTextClass.split(/\s+/).indexOf('sr-only') !== -1
  && topbarEmpty.saveRect.w <= 1.5 && topbarEmpty.saveRect.h <= 1.5
  && topbarEmpty.savePosition === 'absolute'
  && /rect\(0(px)?, 0(px)?, 0(px)?, 0(px)?\)/.test(topbarEmpty.saveClip);
const saveVisible = topbarEmpty && !topbarEmpty.error
  && topbarEmpty.saveTextPresent
  && topbarEmpty.saveRect.w > 4 && topbarEmpty.saveRect.h > 6
  && String(topbarEmpty.saveTextContent || '') !== '';
const saveOk = effectiveSkin === 'modern' ? saveVisible : saveSrOnly;
const saveDetail = JSON.stringify({
  skin: effectiveSkin,
  className: topbarEmpty && topbarEmpty.saveTextClass,
  rect: topbarEmpty && topbarEmpty.saveRect,
  position: topbarEmpty && topbarEmpty.savePosition,
  clip: topbarEmpty && topbarEmpty.saveClip,
  text: topbarEmpty && topbarEmpty.saveTextContent,
});
if (saveOk) ok('the save text follows the classic sr-only / modern visible contract', saveDetail);
else bad('the save text follows the classic sr-only / modern visible contract', saveDetail);
if (topbarEmpty && !topbarEmpty.error && topbarEmpty.visibleText === '') ok('the topbar right side shows no visible text', JSON.stringify({ visible: topbarEmpty.visibleText, pill: topbarEmpty.pillRect }));
else bad('the topbar right side shows no visible text', JSON.stringify(topbarEmpty && topbarEmpty.visibleText));
await ev('document.getElementById("settings-btn").click()');
await sleep(420);
const gearOpen = await run(function () {
  var P = window.PaperOS;
  var win = P.wm.getWindows().filter(function (w) { return w.appId === 'settings' && !w.minimized; })[0];
  return { opened: !!win, shell: !!document.querySelector('.window[data-app=settings]') };
});
if (gearOpen && gearOpen.opened && gearOpen.shell) ok('the settings gear still opens settings', JSON.stringify(gearOpen));
else bad('the settings gear still opens settings', JSON.stringify(gearOpen));

await stageGuard("R4 设置：解释性文字清零，名称/语言三选/命令脚注仍在");
// --- R4 设置：解释性文字清零，名称/语言三选/命令脚注仍在 ---
const settingsCopy = await run(function () {
  var shell = document.querySelector('.window[data-app=settings]');
  if (!shell) return { error: 'no settings window' };
  var count = function (sel) { return shell.querySelectorAll(sel).length; };
  var select = shell.querySelector('[data-lang-select]');
  var footer = shell.querySelector('.command-sheet__footer');
  var about = shell.querySelector('.about-sheet');
  return {
    panels: count('[data-section-panel]'),
    intros: count('.settings-section__intro'),
    descs: count('.setting-row__desc'),
    notes: count('.settings-note'),
    actionDescs: count('.setting-action__desc'),
    aboutParagraphs: about ? about.querySelectorAll('p').length : -1,
    langOptions: select ? select.options.length : -1,
    commandFooter: footer ? footer.textContent.replace(/\s+/g, ' ').trim() : ''
  };
});
if (settingsCopy && !settingsCopy.error && settingsCopy.panels === 5 && settingsCopy.intros === 0 && settingsCopy.descs === 0 && settingsCopy.notes === 0 && settingsCopy.actionDescs === 0 && settingsCopy.aboutParagraphs === 0) {
  ok('settings explainer copy is gone from all five panels', JSON.stringify(settingsCopy));
} else {
  bad('settings explainer copy is gone from all five panels', JSON.stringify(settingsCopy));
}
if (settingsCopy && settingsCopy.langOptions === 3) ok('the language row still offers three options', 'options=' + settingsCopy.langOptions);
else bad('the language row still offers three options', JSON.stringify(settingsCopy && settingsCopy.langOptions));
const footerOk = settingsCopy && settingsCopy.commandFooter.indexOf('↑↓ 选择') !== -1 && settingsCopy.commandFooter.indexOf('Enter 打开') !== -1;
if (footerOk) ok('the command footer keeps its key hints', settingsCopy.commandFooter);
else bad('the command footer keeps its key hints', JSON.stringify(settingsCopy && settingsCopy.commandFooter));
await run(function () {
  var P = window.PaperOS;
  P.wm.getWindows().forEach(function (w) { if (w.appId === 'settings') P.wm.close(w.id); });
});

await stageGuard("the empty placeholder copy is gone");
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

await stageGuard("a daily task appears once on each of the next days, and again after check-in");
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

await stageGuard("no floating hints at all (user asked for none)");
// --- no floating hints at all (user asked for none) ---
const noToast = await run(function () {
  var P = window.PaperOS;
  P.ui.toast('这条不该出现', { kind: 'info' });
  P.ui.toast('这条也不该出现', { kind: 'error' });
  return { nodes: document.querySelectorAll('.toast').length };
});
if (noToast && noToast.nodes === 0) ok('floating hints are switched off', JSON.stringify(noToast));
else bad('floating hints are switched off', JSON.stringify(noToast));

await stageGuard("the priority popover lists the four levels and nothing else");
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

await stageGuard("switching to daily must not make the task vanish from that day");
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
if (anchorDay && anchorDay.before === '今日' && anchorAfter && anchorAfter.stillThere && anchorAfter.chip === '每天' && anchorAfter.projected === 1) ok('switching to daily keeps the task on its anchor day', JSON.stringify(anchorAfter));
else bad('switching to daily keeps the task on its anchor day', JSON.stringify({ before: anchorDay, after: anchorAfter }));

await stageGuard("task rows carry their own controls (dot + repeat chip)");
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

await stageGuard("the dot opens a 4-colour popover and the choice sticks");
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

await stageGuard("an existing task can actually be edited (this used to throw)");
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

await stageGuard("状态两项各占整行，不许逐字竖排（回归：10px 首列挤压中文）");
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
    && repeatRow.labels.join('|') === '今日|每天，直到解决'
    && repeatRow.rows.every(function (row) { return row.h < 30 && row.w > 60; })) {
  ok('repeat status renders on one line each', JSON.stringify(repeatRow));
} else {
  bad('repeat status renders on one line each', JSON.stringify(repeatRow));
}

await stageGuard("R7 待办详情：四档 + 状态共 6 项、解释性 hint 清零、打卡行仍在");
// --- R7 待办详情：四档 + 状态共 6 项、解释性 hint 清零、打卡行仍在 ---
const taskDialogShape = await run(function () {
  var shell = document.querySelector('.window[data-app=calendar]');
  var btn = shell ? shell.querySelector('[aria-label^=编辑待办], [aria-label^="编辑待办"]') : null;
  if (!btn) return { error: 'no edit button' };
  btn.click();
  var dialog = document.querySelector('.paper-dialog[open]');
  if (!dialog) return { error: 'no dialog' };
  var note = dialog.querySelector('.dialog-note');
  var out = {
    options: dialog.querySelectorAll('.priority-option').length,
    hints: dialog.querySelectorAll('.priority-option__hint').length,
    note: note ? note.textContent.trim() : ''
  };
  dialog.close();
  return out;
});
if (taskDialogShape && !taskDialogShape.error && taskDialogShape.options === 6 && taskDialogShape.hints === 0) ok('the task dialog keeps six options and no explainer hints', JSON.stringify(taskDialogShape));
else bad('the task dialog keeps six options and no explainer hints', JSON.stringify(taskDialogShape));
if (taskDialogShape && !taskDialogShape.error && taskDialogShape.note.indexOf('首次出现在') === 0) ok('the task dialog keeps the first-seen line', taskDialogShape.note);
else bad('the task dialog keeps the first-seen line', JSON.stringify(taskDialogShape && taskDialogShape.note));

await stageGuard("命令面板已经并进设置：只有一个入口，Ctrl+K 落在命令分区");
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

await stageGuard("命令列表真的能过滤、能回车执行");
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

await stageGuard("应用坞顺序：拖拽持久化、未知 id 丢弃、缺项补齐");
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

await stageGuard("真拖拽：pointerdown → 移动 → pointerup，顺序落盘");
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

await stageGuard("拖到最左/最右/坞外都要有确定落点，不能「往左拖反而跑到末尾」");
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

await stageGuard("点图标仍然只打开，不会被 6px 阈值误当成拖拽");
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

await stageGuard("拖完不应该顺手把应用打开（浏览器会补发一次 click）");
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

await stageGuard("取消手势不能落盘：pointercancel 只清理，不提交");
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

await stageGuard("命令列表：活动项要能被读屏跟着走");
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


await stageGuard("深色下前景窗口必须和普通窗口分得开");
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

await stageGuard("深色下坞提示条必须看得清（白底白字第 N 次）");
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

await stageGuard("Ctrl+K 真的落到命令分区（走键盘 handler，不是直接调 API）");
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

await stageGuard("键盘移动应用坞要播报位置");
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

await stageGuard("R2 应用坞：拖动中邻居让位、落位两帧内清干净、减少动效不位移但仍换位");
// --- R2 应用坞：拖动中邻居让位、落位两帧内清干净、减少动效不位移但仍换位 ---
const dockMotion = await run(function () {
  var P = window.PaperOS;
  function buttons() { return Array.prototype.slice.call(document.querySelectorAll('[data-dock-app]')); }
  function matrixX(value) {
    var m = /matrix\(([^)]+)\)/.exec(String(value || ''));
    if (!m) return null;
    var parts = m[1].split(',').map(function (v) { return parseFloat(v); });
    return parts.length === 6 ? parts[4] : null;
  }
  function snapshotDock() {
    return buttons().map(function (node) {
      return {
        id: node.getAttribute('data-dock-app'),
        transform: node.style.transform,
        translate: node.style.translate,
        computed: getComputedStyle(node).transform
      };
    });
  }
  function reset(motion) {
    P.data.setPrefs({ motion: motion, dockOrder: [] });
    P.shell.applyPrefs();
    P.shell.buildDock();
  }
  function dragAcross() {
    var list = buttons();
    var first = list[0];
    var third = list[2];
    var a = first.getBoundingClientRect();
    var c = third.getBoundingClientRect();
    var startX = a.left + a.width / 2;
    var startY = a.top + a.height / 2;
    var endX = c.left + c.width / 2 + 16;
    var opts = { bubbles: true, pointerId: 71, pointerType: 'mouse', button: 0, isPrimary: true };
    first.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ clientX: startX, clientY: startY }, opts)));
    window.dispatchEvent(new PointerEvent('pointermove', Object.assign({ clientX: endX, clientY: startY }, opts)));
    var dragging = document.querySelector('.dock__btn.is-dragging');
    var before = { id: first.getAttribute('data-dock-app'), order: buttons().map(function (n) { return n.getAttribute('data-dock-app'); }) };
    var during = {
      dragging: !!dragging,
      draggedX: dragging ? matrixX(getComputedStyle(dragging).transform) : null,
      rows: snapshotDock(),
      neighboursMoved: buttons().filter(function (node) {
        return node !== dragging && (node.style.transform !== '' || getComputedStyle(node).transform !== 'none');
      }).length
    };
    window.dispatchEvent(new PointerEvent('pointerup', Object.assign({ clientX: endX, clientY: startY }, opts)));
    var sync = {
      draggingLeft: !!document.querySelector('.dock__btn.is-dragging'),
      saved: P.data.getPrefs().dockOrder.slice(),
      dom: buttons().map(function (n) { return n.getAttribute('data-dock-app'); }),
      rows: snapshotDock()
    };
    return { before: before, during: during, sync: sync };
  }
  function afterFrames(result) {
    return new Promise(function (resolve) {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          resolve({
            before: result.before,
            during: result.during,
            sync: result.sync,
            after: { draggingLeft: !!document.querySelector('.dock__btn.is-dragging'), rows: snapshotDock() }
          });
        });
      });
    });
  }

  reset('system');
  return afterFrames(dragAcross()).then(function (normal) {
    reset('reduce');
    return afterFrames(dragAcross()).then(function (reduced) {
      P.data.setPrefs({ motion: 'system', dockOrder: [] });
      P.shell.applyPrefs();
      P.shell.buildDock();
      return { normal: normal, reduced: reduced };
    });
  });
});

const normalDock = dockMotion && dockMotion.normal;
const reducedDock = dockMotion && dockMotion.reduced;
if (normalDock && normalDock.during.dragging && normalDock.during.draggedX !== null && Math.abs(normalDock.during.draggedX) > 30) ok('the dragged dock icon follows the pointer', JSON.stringify({ x: normalDock.during.draggedX }));
else bad('the dragged dock icon follows the pointer', JSON.stringify(normalDock && normalDock.during));
if (normalDock && normalDock.during.neighboursMoved >= 1) ok('neighbouring dock icons make room during the drag', 'moved=' + normalDock.during.neighboursMoved);
else bad('neighbouring dock icons make room during the drag', JSON.stringify(normalDock && normalDock.during.rows));
const dockSettled = normalDock && normalDock.sync && !normalDock.sync.draggingLeft
  && normalDock.sync.saved.join(',') === normalDock.sync.dom.join(',')
  && normalDock.sync.saved.length === normalDock.sync.dom.length
  && normalDock.sync.dom[0] !== normalDock.before.id;
if (dockSettled) ok('dropping settles the new order and drops is-dragging', JSON.stringify({ before: normalDock.before.order, after: normalDock.sync.dom }));
else bad('dropping settles the new order and drops is-dragging', JSON.stringify(normalDock && { before: normalDock.before, sync: normalDock.sync }));
const inlineClean = (frames) => frames && frames.rows && frames.rows.every(function (row) {
  return row.transform === '' && row.translate === '' && row.computed === 'none';
});
if (inlineClean(normalDock && normalDock.after)) ok('every inline dock transform is cleared within two frames', JSON.stringify(normalDock.after.rows));
else bad('every inline dock transform is cleared within two frames', JSON.stringify(normalDock && normalDock.after));
if (reducedDock && reducedDock.during.neighboursMoved === 0) ok('reduced motion keeps neighbours still during the drag', 'moved=0');
else bad('reduced motion keeps neighbours still during the drag', JSON.stringify(reducedDock && reducedDock.during));
const reducedSettled = reducedDock && reducedDock.sync && !reducedDock.sync.draggingLeft
  && reducedDock.sync.saved.join(',') === reducedDock.sync.dom.join(',')
  && reducedDock.sync.dom[0] !== reducedDock.before.id
  && inlineClean(reducedDock.sync) && inlineClean(reducedDock.after);
if (reducedSettled) ok('reduced motion still reorders the dock', JSON.stringify({ before: reducedDock.before.order, after: reducedDock.sync.dom }));
else bad('reduced motion still reorders the dock', JSON.stringify(reducedDock && { before: reducedDock.before, sync: reducedDock.sync }));


await stageGuard("a finished dot is grey, never the priority colour");
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

await stageGuard("R3 紧急程度配色：浅色 / 深色，dot 载体实读");
// --- R3 紧急程度配色：浅色 / 深色，dot 载体实读 ---
/* 紧急程度配色按皮肤分档（Lead 裁定 2026-11-03）：
   classic 仍是 sage 系；modern 用 03/裁定 #2 照 Demo 取的四组值（浅/深各一套）。
   同时守"三处载体同色"：月历点 / 待办 pip / pip 按钮的伪元素。 */
const PRIORITY_LEVELS = ['urgent-important', 'important', 'urgent', 'none'];
const PRIORITY_EXPECT = {
  classic: {
    light: { 'urgent-important': 'rgb(216, 164, 160)', important: 'rgb(217, 196, 124)', urgent: 'rgb(123, 143, 114)', none: 'rgb(190, 190, 190)' },
    dark: { 'urgent-important': 'rgb(185, 117, 111)', important: 'rgb(183, 162, 92)', urgent: 'rgb(147, 168, 138)', none: 'rgb(150, 150, 150)' },
  },
  modern: {
    light: { 'urgent-important': 'rgb(198, 123, 127)', important: 'rgb(197, 165, 82)', urgent: 'rgb(127, 159, 121)', none: 'rgb(163, 166, 171)' },
    dark: { 'urgent-important': 'rgb(211, 144, 143)', important: 'rgb(212, 183, 104)', urgent: 'rgb(147, 178, 140)', none: 'rgb(182, 185, 190)' },
  },
};
const priorityColors = await run(function () {
  var P = window.PaperOS;
  var host = document.createElement('div');
  host.style.position = 'fixed';
  host.style.left = '-9999px';
  host.style.top = '0';
  document.body.appendChild(host);
  var levels = ['urgent-important', 'important', 'urgent', 'none'];
  function readCarrier(className, pseudo) {
    var out = {};
    levels.forEach(function (level) {
      var node = document.createElement('span');
      node.className = className;
      node.setAttribute('data-priority', level);
      host.appendChild(node);
      var style = getComputedStyle(node, pseudo || null);
      out[level] = style.backgroundColor;
    });
    return out;
  }
  function readAll() {
    return { dot: readCarrier('cal-day__dot'), pip: readCarrier('task-pip'), pipButton: readCarrier('task-pip-btn', '::after') };
  }
  P.data.setPrefs({ theme: 'light' });
  P.shell.applyPrefs();
  var light = readAll();
  P.data.setPrefs({ theme: 'dark' });
  P.shell.applyPrefs();
  var dark = readAll();
  P.data.setPrefs({ theme: 'light' });
  P.shell.applyPrefs();
  host.parentNode.removeChild(host);
  var distinct = {};
  levels.forEach(function (level) { distinct[light.dot[level]] = true; });
  return { light: light, dark: dark, lightDistinct: Object.keys(distinct).length };
});
const priorityExpectForSkin = PRIORITY_EXPECT[effectiveSkin] || PRIORITY_EXPECT.classic;
for (const theme of ['light', 'dark']) {
  const problems = [];
  const seen = priorityColors && priorityColors[theme] ? priorityColors[theme].dot : null;
  if (!seen) problems.push('probe missing');
  else {
    for (const level of PRIORITY_LEVELS) {
      if (seen[level] !== priorityExpectForSkin[theme][level]) {
        problems.push(level + ': got ' + JSON.stringify(seen[level]) + ', expected ' + priorityExpectForSkin[theme][level]);
      }
    }
  }
  if (problems.length) bad(theme + ' urgency dots follow the per-skin palette', problems.join('; ') + ' skin=' + effectiveSkin);
  else ok(theme + ' urgency dots follow the per-skin palette', JSON.stringify(seen) + ' skin=' + effectiveSkin);
}
/* 三处载体同色：同一个 level 在 dot / pip / pipButton 上必须是同一个颜色（非空才比较）。 */
const carrierProblems = [];
for (const theme of ['light', 'dark']) {
  const carriers = priorityColors && priorityColors[theme] ? priorityColors[theme] : null;
  if (!carriers) { carrierProblems.push(theme + ': probe missing'); continue; }
  for (const level of PRIORITY_LEVELS) {
    const values = ['dot', 'pip', 'pipButton']
      .map((name) => carriers[name] && carriers[name][level])
      .filter((value) => !!value && value !== 'rgba(0, 0, 0, 0)');
    const unique = Array.from(new Set(values));
    if (unique.length > 1) carrierProblems.push(theme + '/' + level + ': ' + JSON.stringify(values));
  }
}
if (carrierProblems.length) bad('priority colours agree across the calendar dot, task pip and pip button', carrierProblems.join('; '));
else ok('priority colours agree across the calendar dot, task pip and pip button', 'same colour on every carrier');
if (priorityColors && priorityColors.lightDistinct === 4) ok('the four urgency levels paint four different colours', 'distinct=' + priorityColors.lightDistinct);
else bad('the four urgency levels paint four different colours', JSON.stringify(priorityColors && priorityColors.light));

await stageGuard("per-app view survives into the saved snapshot");
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

await stageGuard("the teardown path can force a synchronous save");
// --- the teardown path can force a synchronous save ---
const flushNow = await run(function () {
  var P = window.PaperOS;
  return { kind: typeof P.storage.flushNow, ran: P.storage.flushNow ? P.storage.flushNow() : null };
});
if (flushNow && flushNow.kind === 'function' && flushNow.ran !== false) ok('storage exposes a synchronous flushNow for teardown');
else bad('storage exposes a synchronous flushNow for teardown', JSON.stringify(flushNow));

await stageGuard("dark mode must actually be dark (measured, not assumed)");
// --- dark mode must actually be dark (measured, not assumed) ---
/* 分两层测，避免"同帧取到过渡起点"：
   (a) 结构层：--m-surface-solid 的解析值不经过渡，读它即时可信；
   (b) 视觉层：切到深色后等过渡稳定（连续两次采样一致，最多约 1.4s）再读实际背景。
   反向审计里"把过渡改成常驻"必须仍然绿——那证明 (b) 的等稳定真的生效。 */
const darkStructural = await run(function () {
  var P = window.PaperOS;
  P.data.setPrefs({ theme: 'dark' });
  P.shell.applyPrefs();
  P.wm.open('notes');
  var root = document.documentElement;
  return {
    theme: root.getAttribute('data-theme') || '',
    skin: root.getAttribute('data-skin') || '',
    token: getComputedStyle(root).getPropertyValue('--m-surface-solid').trim()
  };
});
const readDarkSurfaces = () => run(function () {
  function bg(sel) {
    var el = document.querySelector(sel);
    return el ? getComputedStyle(el).backgroundColor : '';
  }
  /* 只测刚刚打开的 notes 窗口：querySelector('.window__body') 会先命中别的残留
     窗口，常驻过渡下那个旧窗口可能停在过渡起点，把断言读成假红。 */
  var scope = document.querySelector('[data-app="notes"]') || document;
  function scoped(sel) {
    var el = scope.querySelector(sel);
    return el ? getComputedStyle(el).backgroundColor : bg(sel);
  }
  return { windowBody: scoped('.window__body'), notesEditor: scoped('.notes-editor'), editorSheet: scoped('.editor-sheet') };
});
let darkSurfaceKey = '';
let darkSurfaces = null;
for (let i = 0; i < 14; i += 1) {
  const now = await readDarkSurfaces();
  const key = JSON.stringify(now);
  if (darkSurfaceKey && key === darkSurfaceKey) { darkSurfaces = now; break; }
  darkSurfaceKey = key;
  darkSurfaces = now;
  await sleep(120);
}
const darkContrast = await run(function () {
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
  var out = {};
  var tourTitle = document.querySelector('.tour__title');
  var card = document.querySelector('.tour__card');
  if (tourTitle && card) out.tourTitle = ratio(getComputedStyle(tourTitle).color, getComputedStyle(card).backgroundColor);
  var noteTitle = document.querySelector('.note-title-input');
  var noteBg = document.querySelector('.editor-sheet');
  if (noteTitle && noteBg) out.noteText = ratio(getComputedStyle(noteTitle).color, getComputedStyle(noteBg).backgroundColor);
  return out;
});
const darkTokenLum = luminanceOf(darkStructural && darkStructural.token);
if (effectiveSkin === 'modern') {
  const tokenOk = darkStructural && darkStructural.theme === 'dark' && darkTokenLum !== null && darkTokenLum < 0.2;
  const tokenDetail = JSON.stringify({
    theme: darkStructural && darkStructural.theme,
    token: darkStructural && darkStructural.token,
    lum: darkTokenLum === null ? null : Math.round(darkTokenLum * 1000) / 1000,
  });
  if (tokenOk) ok('the modern dark surface token resolves dark', tokenDetail);
  else bad('the modern dark surface token resolves dark', tokenDetail);
}
const darkSurfaceNames = Object.keys(darkSurfaces || {}).filter(function (name) { return !!darkSurfaces[name]; });
const darkLightSurfaces = darkSurfaceNames.filter(function (name) {
  const value = luminanceOf(darkSurfaces[name]);
  return value !== null && value > 0.35;
});
if (darkSurfaceNames.length >= 2 && darkLightSurfaces.length === 0) ok('dark mode has no near-white surfaces', JSON.stringify(darkSurfaces) + ' settled over ' + (darkSurfaceNames.length) + ' surfaces');
else bad('dark mode has no near-white surfaces', JSON.stringify({ surfaces: darkSurfaces, light: darkLightSurfaces }));
const darkContrasts = darkContrast || {};
const weakContrasts = Object.keys(darkContrasts).filter(function (key) { return darkContrasts[key] !== null && darkContrasts[key] < 4.5; });
if (Object.keys(darkContrasts).length && weakContrasts.length === 0) ok('dark mode text stays readable', JSON.stringify(darkContrasts));
else bad('dark mode text stays readable', JSON.stringify(darkContrasts));
/* 结构层反向审计：令牌被改成浅色后，上面那句 must 红；变绿就是断言没抓住。 */
if (MUTATE === 'dark-token-light') await finishMutation();

await stageGuard("field round-trip through the real ingest gate");
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

await stageGuard("prompts app: CRUD, search, pin, persistence, clearing samples");
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
  return {
    listFound: !!list,
    items: items.length,
    countText: counts ? counts.textContent : '',
    hasSearch: !!search,
    firstTitle: (P.data.listPrompts('')[0] || {}).title || '',
    editorTitle: (document.querySelector('[data-testid="prompt-title"]') || {}).value || ''
  };
});
if (promptDom && promptDom.listFound && promptDom.items >= 4) ok('prompt list renders rows', 'rows=' + promptDom.items + ' ' + promptDom.countText);
else bad('prompt list renders rows', JSON.stringify(promptDom));
if (promptDom && promptDom.hasSearch) ok('prompt list has a search box');
else bad('prompt list has a search box', JSON.stringify(promptDom));
if (promptDom && promptDom.editorTitle === '调研同类产品再动手') ok('editor opens on the first prompt', promptDom.editorTitle);
else bad('editor opens on the first prompt', JSON.stringify(promptDom && promptDom.editorTitle));

await stageGuard("R8 提示词窗口：动作组贴右（D-05 口径：不用 marginLeft === \"auto\"）");
// --- R8 提示词窗口：动作组贴右（D-05 口径：不用 marginLeft === "auto"） ---
// 空态整条 bar 隐藏无法在真机上造出空库（打开即选中第一条），它的源码分支由
// run_all_checks 的 expected needle「prompt bar hides when nothing is selected」守着。
const promptActions = await run(function () {
  var shell = document.querySelector('.window[data-app=prompts]');
  if (!shell) return { error: 'no prompts window' };
  var actions = shell.querySelector('.prompts-main__actions');
  var bar = shell.querySelector('.prompts-main__bar');
  if (!actions || !bar) return { error: 'no actions/bar' };
  var ab = actions.getBoundingClientRect();
  var bb = bar.getBoundingClientRect();
  var cs = getComputedStyle(actions);
  return {
    actionsVisible: actions.getClientRects().length > 0 && cs.display !== 'none' && !actions.hidden,
    marginLeft: parseFloat(cs.marginLeft) || 0,
    rightGap: Math.round((bb.right - ab.right) * 10) / 10,
    barVisible: bar.getClientRects().length > 0 && !bar.hidden,
    buttons: actions.querySelectorAll('.paper-btn').length,
    titleRowGone: !document.querySelector('[data-testid="prompt-heading"]'),
    railFootGone: !document.querySelector('.prompts-rail__foot')
  };
});
const promptActionsOk = promptActions && !promptActions.error && promptActions.actionsVisible
  && promptActions.marginLeft > 0 && Math.abs(promptActions.rightGap) <= 1
  && promptActions.barVisible && promptActions.buttons === 4;
if (promptActionsOk) ok('the prompt actions sit flush right of the bar', JSON.stringify(promptActions));
else bad('the prompt actions sit flush right of the bar', JSON.stringify(promptActions));
if (promptActions && !promptActions.error && promptActions.titleRowGone && promptActions.railFootGone) ok('the prompts window has no title row or rail foot', JSON.stringify({ heading: promptActions.titleRowGone, railFoot: promptActions.railFootGone }));
else bad('the prompts window has no title row or rail foot', JSON.stringify(promptActions));

const uiNew = await run(function () {
  var button = document.querySelector('[data-testid="new-prompt"]');
  if (!button) return { __err: 'new button missing' };
  var before = window.PaperOS.data.listPrompts('').length;
  button.click();
  var titleInput = document.querySelector('[data-testid="prompt-title"]');
  return {
    before: before,
    after: window.PaperOS.data.listPrompts('').length,
    editorTitle: titleInput ? titleInput.value : null,
    titlePlaceholder: titleInput ? titleInput.placeholder : null
  };
});
if (uiNew && uiNew.after === uiNew.before + 1) ok('the new button creates a prompt');
else bad('the new button creates a prompt', JSON.stringify(uiNew));
if (uiNew && uiNew.editorTitle === '' && uiNew.titlePlaceholder === '未命名提示词') ok('a new prompt opens with an empty title + placeholder', JSON.stringify({ placeholder: uiNew.titlePlaceholder }));
else bad('a new prompt opens with an empty title + placeholder', JSON.stringify(uiNew));

await stageGuard("typing must survive the autosave round-trip");
// --- typing must survive the autosave round-trip ---
// Regression 0.3.0: every commit rebuilt the editor DOM, so focus died after the
// first keystroke and the field could only be filled by pasting. These drive the
// real input path (CDP Input.insertText), not element.value.
await send('Runtime.evaluate', { expression: "document.querySelector('[data-testid=\"prompt-title\"]').focus()" });
await send('Input.insertText', { text: '打字标题' });
await sleep(500);
await send('Input.insertText', { text: '续写' });
// 自动保存是 180ms 防抖：250ms 在慢机器上会读到还没 flush 的旧值（实测偶发）。
await sleep(520);
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
if (promptSeeding && promptSeeding.legacyOk && promptSeeding.legacyCount === 5) ok('a v3 file without a prompts field gets the native samples', 'count=' + promptSeeding.legacyCount);
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
const nativeIds = ['prompt_sample_agents', 'prompt_sample_align', 'prompt_sample_comm', 'prompt_sample_depth', 'prompt_sample_research'];
if (samples && samples.restored === 5 && JSON.stringify(samples.backIds) === JSON.stringify(nativeIds)) ok('the native samples can be put back from the empty state', JSON.stringify(samples.backIds));
else bad('the native samples can be put back from the empty state', JSON.stringify(samples && { restored: samples.restored, backIds: samples.backIds }));

await stageGuard("reload keeps data");
// --- reload keeps data ---
await run(function () {
  var P = window.PaperOS;
  P.wm.open('calendar');
  P.data.addTask(P.util.todayKey(), '刷新后还在', { priority: 'urgent' });
  P.storage.flush();
});
/* 用户不会在“保存中”的瞬间刷新页面：先等保存确认（≤3s）。超时=保存没落盘，
   单独一条断言点名，不混进 data survives a reload 的解释。 */
const saveBeforeReload = await (async () => {
  const started = Date.now();
  let status = null;
  for (let i = 0; i < 30; i += 1) {
    status = await run(function () {
      var P = window.PaperOS;
      var value = P.storage.getDataStatus();
      return { phase: value.phase, dirty: !!value.dirty };
    });
    if (status && status.phase === 'saved') break;
    await sleep(100);
  }
  return { status: status, waitedMs: Date.now() - started };
})();
if (saveBeforeReload.status && saveBeforeReload.status.phase === 'saved') ok('the save is confirmed before a reload', JSON.stringify(saveBeforeReload));
else bad('the save is confirmed before a reload', JSON.stringify(saveBeforeReload));
await markLeaving();
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
else bad('data survives a reload', JSON.stringify({ titles: survived && survived.titles, saveBeforeReload: saveBeforeReload }));
if (survived && survived.windows.indexOf('calendar') !== -1) ok('open windows survive a reload', JSON.stringify(survived.windows));
else bad('open windows survive a reload', JSON.stringify(survived && survived.windows));

await stageGuard("the clearance survives the narrow (side-panel) breakpoint");
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
await waitAnimationsIdle();
const settledPhase = await ev('window.PaperOS.storage.getStatus().phase');
if (settledPhase === 'saved') ok('the resize settles its pending layout save', 'phase=' + settledPhase);
else bad('the resize settles its pending layout save', 'phase=' + settledPhase);
const nwBase = (narrow && narrow.base) || {};
const nwMac = (narrow && narrow.mac) || {};
const nwBack = (narrow && narrow.back) || {};
if (!narrow || narrow.error) bad('the clearance band works at the narrow panel breakpoint', JSON.stringify(narrow));
else if (narrow.viewportW === 800 && nwMac.padTop === 48 && nwMac.height === nwBase.height + 48 && nwMac.rowTop - nwBase.rowTop === 48) ok('the clearance band works at the narrow panel breakpoint', JSON.stringify(narrow) + ' band?=' + nwBase.height + '+48');
else bad('the clearance band works at the narrow panel breakpoint', JSON.stringify(narrow) + ' band?=' + nwBase.height + '+48');
if (!narrow || narrow.error) bad('the narrow top bar stays free of horizontal overflow and collapses back', 'probe failed');
else if (nwMac.overflowX === 0 && nwMac.width === nwBase.width && nwBack.height === nwBase.height && nwBack.padTop === 0 && nwBack.rowTop === nwBase.rowTop) ok('the narrow top bar stays free of horizontal overflow and collapses back', JSON.stringify(narrow) + ' base=' + nwBase.height);
else bad('the narrow top bar stays free of horizontal overflow and collapses back', JSON.stringify(narrow) + ' base=' + nwBase.height);

await stageGuard("resize 确定性夹具");
// --- resize 确定性夹具 ---------------------------------------------------
// 这 3 条抓的是真实缺陷：视口缩水后已开的窗口保留旧 bounds（1082 > 787）→ 横向越界，
// onViewportResize 没有重新夹取（0.5.2 起就缺，不是 K2 引入）。所以测量场景必须是
// "窗口先开着 → 再改视口 → 等稳定 → 断言被夹进工作区"，不许改成"先关窗再测"。
// 确定性靠：固定起始桌面（1400x900 全新页面）→ 只开一个窗口 → 轮询到相邻两次 rect
// 完全相同才断言；不靠固定 sleep。
const deskReset = async () => {
  await ev('try { var P = window.PaperOS; if (P.tour && P.tour.close) P.tour.close(); var dialogs = document.querySelectorAll(".paper-dialog[open]"); for (var i = 0; i < dialogs.length; i += 1) { if (dialogs[i].close) dialogs[i].close(); } P.wm.getWindows().forEach(function (w) { P.wm.close(w.id); }); } catch (err) {}');
  for (let i = 0; i < 25; i += 1) {
    const left = await ev('window.PaperOS && window.PaperOS.wm ? window.PaperOS.wm.getWindows().length : -1');
    if (left === 0) return true;
    await sleep(80);
  }
  return false;
};
/* 稳定 = 连续 N 次测量完全相同（默认 6 次 ≈ 500ms 观测窗）。
   只要求"相邻两次相同"会在夹取/动画落地前就接受（2026-11-03 探针：失败跑都停在
   settleSamples=2），把异步布局的最小观测窗写死在这里，避免靠 sleep 碰运气。 */
const SETTLE_STREAK = 6;
let settleMax = 0;
let settleChangesMax = 0;
const settlePageValue = async (fn, args, limit, streakNeeded) => {
  const need = streakNeeded || SETTLE_STREAK;
  let previous = '';
  let latest = null;
  let samples = 0;
  let streak = 0;
  let changes = 0;
  /* 每次测量前先重新断言可见（不是只在 ready 时守一次）。 */
  await ensureVisibleForSample('settle start');
  for (let i = 0; i < (limit || 40); i += 1) {
    const idle = await ev(ANIMATIONS_IDLE);
    let visible = noteVisibility(await ev('document.visibilityState')) === 'visible';
    if (!visible) visible = await ensureVisibleForSample('settle sample');
    const now = await runWith(fn, args || []);
    samples = i + 1;
    if (samples > settleMax) settleMax = samples;
    latest = now;
    const key = JSON.stringify(now);
    /* 动画还在跑就把 streak 清零：入场/过渡的中间态绝不能算“稳定”。 */
    if (previous && key !== previous) changes += 1;
    if (!idle || !visible || !previous || key !== previous) streak = 1;
    else streak += 1;
    previous = key;
    if (idle && visible && streak >= need) break;
    await sleep(100);
  }
  if (changes > settleChangesMax) settleChangesMax = changes;
  return { value: latest, samples: samples, stable: streak, changes: changes };
};
/* 固定起始桌面：1400x900 全新页面 + 桌面清空。返回 { ok, halt }。 */
const bootDesktop = async (config) => {
  await send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 });
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await markLeaving();
  await send('Page.navigate', { url: PAGE_URL });
  const ready = await waitReady();
  if (!ready) return { ok: false, halt: 'ready | ' + readyHaltReason };
  await ev('try { var P = window.PaperOS; if (P.tour && P.tour.close) P.tour.close(); var d = document.querySelector(".paper-dialog[open]"); if (d && d.close) d.close(); } catch (err) {}');
  await sleep(220);
  const emptied = await deskReset();
  if (!emptied) {
    return {
      ok: false,
      halt: 'deskReset left windows open | visibility=' + JSON.stringify(lastVisibility)
        + ' windows=' + JSON.stringify(await ev('window.PaperOS && window.PaperOS.wm ? window.PaperOS.wm.getWindows().length : -1')),
    };
  }
  return { ok: true, halt: '' };
};
/* 真实场景：窗口先在 1400x900 开着（保留旧 bounds）→ 改到目标视口 → 等稳定 → 量。 */
const measureAfterShrink = async (config) => {
  const started = await bootDesktop(config);
  if (!started.ok) return { ready: false, halt: started.halt, empty: false, before: null, value: null };
  /* 开窗后轮询到窗口元素真的出现（带超时）；仍没有就 dump 现场证据，交给断言点名。 */
  let present = false;
  for (let attempt = 0; attempt < 3 && !present; attempt += 1) {
    await runWith(function (appId) { window.PaperOS.wm.open(appId); return true; }, [config.appId]);
    for (let i = 0; i < 20; i += 1) {
      present = await runWith(function (appId) { return !!document.querySelector('.window[data-app="' + appId + '"]'); }, [config.appId]);
      if (present) break;
      await sleep(100);
    }
    if (!present) await sleep(200);
  }
  let openDump = null;
  if (!present) {
    openDump = await run(function () {
      var P = window.PaperOS;
      var focused = null;
      try { focused = P.wm && P.wm.getFocused ? P.wm.getFocused() : null; } catch (err) { focused = null; }
      return {
        wmWindows: P.wm && P.wm.getWindows ? P.wm.getWindows().length : -1,
        domWindows: document.querySelectorAll('.window').length,
        bootError: window.__PAPER_OS_BOOT_ERROR__ || '',
        dialogOpen: !!document.querySelector('dialog[open]'),
        focused: focused && focused.id ? focused.id : null,
        visibility: document.visibilityState,
        skin: document.documentElement.getAttribute('data-skin') || ''
      };
    });
  }
  /* 内容选择器可能比窗口晚一拍（夹具问题）：轮询到 before() 真的能读到内容再取样；
     仍读不到就 dump DOM 摘要给断言点名，而不是把 null 当结论。 */
  let contentReady = false;
  for (let i = 0; i < 30; i += 1) {
    const probe = await runWith(config.before, []);
    if (probe && probe.width) { contentReady = true; break; }
    await sleep(100);
  }
  let contentDump = null;
  if (!contentReady) {
    contentDump = await runWith(function (appId) {
      var win = document.querySelector('.window[data-app=\"' + appId + '\"]');
      return {
        appId: appId,
        windows: document.querySelectorAll('.window').length,
        winFound: !!win,
        innerHTML: win ? String(win.innerHTML || '').length : 0,
        children: win ? win.children.length : 0,
        visibility: document.visibilityState,
        hasFocus: document.hasFocus ? document.hasFocus() : null,
        bootError: window.__PAPER_OS_BOOT_ERROR__ || ''
      };
    }, [config.appId]);
  }
  const beforeSettled = await settlePageValue(config.before, []);
  await send('Emulation.setTouchEmulationEnabled', { enabled: !!config.touch, maxTouchPoints: config.touch ? 5 : 1 });
  await send('Emulation.setDeviceMetricsOverride', {
    width: config.width,
    height: config.height,
    deviceScaleFactor: config.scale || 1,
    mobile: !!config.mobile,
  });
  const measured = await settlePageValue(config.measure, []);
  const layoutDump = await run(function () {
    var P = window.PaperOS;
    var probe = null;
    try { probe = P.wm && P.wm._internals && P.wm._internals.dumpLayout ? P.wm._internals.dumpLayout().probe : null; } catch (err) { probe = String((err && err.message) || err); }
    return {
      probe: probe,
      visibility: document.visibilityState,
      hasFocus: document.hasFocus ? document.hasFocus() : null
    };
  });
  return {
    ready: true,
    empty: true,
    before: beforeSettled.value,
    beforeSamples: beforeSettled.samples,
    value: measured.value,
    samples: measured.samples,
    changes: measured.changes,
    openDump: openDump,
    contentDump: contentDump,
    layoutDump: layoutDump,
  };
};

await stageGuard("issue #1：300% 缩放等效的 787x627 面板不得退化成整屏手机");
// --- issue #1：300% 缩放等效的 787x627 面板不得退化成整屏手机 ---
// 判据来自 03-K1：整屏只允许出现在 (max-width:600px) 或触屏窄面板。
const stage787 = await measureAfterShrink({
  width: 787, height: 627, scale: 3, mobile: false, touch: false, appId: 'prompts',
  before: function () {
    var win = document.querySelector('.window[data-app="prompts"]');
    var rect = win ? win.getBoundingClientRect() : null;
    return { width: rect ? Math.round(rect.width) : null, viewportW: document.documentElement.clientWidth };
  },
  measure: function () {
    var root = document.documentElement;
    var win = document.querySelector('.window[data-app="prompts"]');
    if (!win) return { error: 'prompts window missing' };
    var rect = win.getBoundingClientRect();
    var grip = win.querySelector('.win-resize--se');
    var bar = win.querySelector('.window__titlebar');
    var app = win.querySelector('.prompts-app');
    var list = win.querySelector('.prompts-list');
    var rows = 0;
    var acc = 0;
    if (list) {
      var items = list.children;
      for (var i = 0; i < items.length && i < 5; i += 1) {
        acc += items[i].getBoundingClientRect().height;
        if (acc <= list.clientHeight) rows += 1;
      }
    }
    var cols = app ? getComputedStyle(app).gridTemplateColumns.split(' ').length : 0;
    return {
      viewportW: root.clientWidth,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      left: Math.round(rect.left),
      rightGap: Math.round(root.clientWidth - rect.left - rect.width),
      fullBleed: Math.abs(rect.width - root.clientWidth) <= 1,
      resize: grip ? getComputedStyle(grip).display : 'missing',
      cursor: bar ? getComputedStyle(bar).cursor : 'missing',
      cols: cols,
      listH: list ? list.clientHeight : 0,
      rows: rows,
      overflowX: Math.round(root.scrollWidth - root.clientWidth)
    };
  },
});
if (stage787.ready && stage787.before && stage787.before.width > 787) ok('the 787 measurement starts from a window wider than the viewport', JSON.stringify({ startWidth: stage787.before.width, targetViewport: 787, settleSamples: stage787.beforeSamples, openDump: stage787.openDump, contentDump: stage787.contentDump, halt: stage787.halt }));
else bad('the 787 measurement starts from a window wider than the viewport', JSON.stringify({ startWidth: stage787.before && stage787.before.width, targetViewport: 787, settleSamples: stage787.beforeSamples, openDump: stage787.openDump, contentDump: stage787.contentDump, halt: stage787.halt }));
const sheet787 = await run(function () {
  return { isSheet: (typeof window.PaperOS.wm.isSheet === 'function') ? window.PaperOS.wm.isSheet() : null };
});
if (sheet787 && sheet787.isSheet === false) ok('787x627 is not the phone sheet', JSON.stringify(sheet787));
else bad('787x627 is not the phone sheet', JSON.stringify(sheet787));
const shape787 = stage787.value;
if (shape787 && !shape787.error && !shape787.fullBleed && shape787.left >= 8 && shape787.rightGap >= 8) ok('787x627 keeps paper margins', JSON.stringify(shape787) + ' settleSamples=' + stage787.samples + ' settleChanges=' + stage787.changes);
else bad('787x627 keeps paper margins', JSON.stringify(shape787) + ' settleSamples=' + stage787.samples + ' settleChanges=' + stage787.changes + ' layout=' + JSON.stringify(stage787.layoutDump) + ' content=' + JSON.stringify(stage787.contentDump));
if (shape787 && shape787.resize === 'block' && shape787.cursor === 'grab') ok('787x627 window can be dragged and resized', JSON.stringify(shape787));
else bad('787x627 window can be dragged and resized', JSON.stringify(shape787));
if (shape787 && shape787.cols >= 2 && shape787.listH >= 250 && shape787.rows >= 3) ok('787x627 prompt list keeps three full rows in two columns', JSON.stringify(shape787));
else bad('787x627 prompt list keeps three full rows in two columns', JSON.stringify(shape787));
if (shape787 && shape787.overflowX === 0) ok('787x627 has no horizontal overflow', JSON.stringify(shape787));
else bad('787x627 has no horizontal overflow', JSON.stringify(shape787));

await stageGuard("300% 缩放的真实面板（约 408x489）：鼠标下是普通窗口，且内容可滚不许被裁");
// --- 300% 缩放的真实面板（约 408x489）：鼠标下是普通窗口，且内容可滚不许被裁 ---
const stage408 = await measureAfterShrink({
  width: 408, height: 489, scale: 3, mobile: false, touch: false, appId: 'notes',
  before: function () {
    var win = document.querySelector('.window[data-app="notes"]');
    var rect = win ? win.getBoundingClientRect() : null;
    return { width: rect ? Math.round(rect.width) : null, viewportW: document.documentElement.clientWidth };
  },
  measure: function () {
    var root = document.documentElement;
    var win = document.querySelector('.window[data-app="notes"]');
    if (!win) return { error: 'notes window missing' };
    var rect = win.getBoundingClientRect();
    var app = win.querySelector('.window__body > *');
    var grip = win.querySelector('.win-resize--se');
    return {
      isSheet: window.PaperOS.wm.isSheet(),
      viewportW: root.clientWidth,
      width: Math.round(rect.width),
      left: Math.round(rect.left),
      rightGap: Math.round(root.clientWidth - rect.left - rect.width),
      fullBleed: Math.abs(rect.width - root.clientWidth) <= 1,
      short: win.classList.contains('is-short'),
      scrollable: app ? app.scrollHeight > app.clientHeight + 1 : null,
      overflowY: app ? getComputedStyle(app).overflowY : null,
      resize: grip ? getComputedStyle(grip).display : 'missing',
      overflowX: Math.round(root.scrollWidth - root.clientWidth)
    };
  },
});
if (stage408.ready && stage408.before && stage408.before.width > 408) ok('the 408 measurement starts from a window wider than the viewport', JSON.stringify({ startWidth: stage408.before.width, targetViewport: 408, settleSamples: stage408.beforeSamples, openDump: stage408.openDump, contentDump: stage408.contentDump, halt: stage408.halt }));
else bad('the 408 measurement starts from a window wider than the viewport', JSON.stringify({ startWidth: stage408.before && stage408.before.width, targetViewport: 408, settleSamples: stage408.beforeSamples, openDump: stage408.openDump, contentDump: stage408.contentDump, halt: stage408.halt }));
const tiny408 = stage408.value;
if (tiny408 && !tiny408.error && tiny408.isSheet === false && tiny408.fullBleed === false && tiny408.left >= 8 && tiny408.rightGap >= 8) ok('408x489 with a mouse stays a real window', JSON.stringify(tiny408) + ' settleSamples=' + stage408.samples);
else bad('408x489 with a mouse stays a real window', JSON.stringify(tiny408) + ' settleSamples=' + stage408.samples + ' settleChanges=' + stage408.changes + ' layout=' + JSON.stringify(stage408.layoutDump) + ' content=' + JSON.stringify(stage408.contentDump));
if (tiny408 && tiny408.short === true && tiny408.scrollable === true && tiny408.overflowY === 'auto') ok('a short window can scroll instead of clipping', JSON.stringify(tiny408));
else bad('a short window can scroll instead of clipping', JSON.stringify(tiny408));
if (tiny408 && tiny408.resize === 'block' && tiny408.overflowX === 0) ok('the short window stays resizable without horizontal overflow', JSON.stringify(tiny408));
else bad('the short window stays resizable without horizontal overflow', JSON.stringify(tiny408));

await stageGuard("真触屏仍然整屏：开触摸模拟把 pointer: coarse 翻真，500x900 必须保持手机形态");
// --- 真触屏仍然整屏：开触摸模拟把 pointer: coarse 翻真，500x900 必须保持手机形态 ---
const stage500 = await measureAfterShrink({
  width: 500, height: 900, scale: 3, mobile: true, touch: true, appId: 'notes',
  before: function () {
    var win = document.querySelector('.window[data-app="notes"]');
    var rect = win ? win.getBoundingClientRect() : null;
    return { width: rect ? Math.round(rect.width) : null, viewportW: document.documentElement.clientWidth };
  },
  measure: function () {
    var P = window.PaperOS;
    var win = document.querySelector('.window[data-app="notes"]');
    var rect = win ? win.getBoundingClientRect() : null;
    var grip = win ? win.querySelector('.win-resize--se') : null;
    var open = P.wm.getWindows();
    return {
      isSheet: P.wm.isSheet(),
      viewportW: document.documentElement.clientWidth,
      fullBleed: rect ? Math.abs(rect.width - document.documentElement.clientWidth) <= 1 : null,
      width: rect ? Math.round(rect.width) : null,
      resize: grip ? getComputedStyle(grip).display : 'missing',
      bounds: open.length ? open[0].bounds : null
    };
  },
});
const sheet500 = stage500.value;
if (sheet500 && sheet500.isSheet === true && sheet500.fullBleed === true) ok('500x900 on a touch pointer still uses the phone sheet', JSON.stringify(sheet500));
else bad('500x900 on a touch pointer still uses the phone sheet', JSON.stringify(sheet500));
if (sheet500 && sheet500.resize === 'none') ok('the phone sheet hides the resize handles', JSON.stringify(sheet500));
else bad('the phone sheet hides the resize handles', JSON.stringify(sheet500));
if (sheet500 && sheet500.bounds && sheet500.viewportW && sheet500.bounds.w <= sheet500.viewportW) ok('window bounds stay honest inside the sheet', JSON.stringify(sheet500.bounds) + ' viewport=' + sheet500.viewportW + ' settleSamples=' + stage500.samples);
else bad('window bounds stay honest inside the sheet', JSON.stringify(sheet500 && { bounds: sheet500.bounds, viewportW: sheet500.viewportW }) + ' settleSamples=' + stage500.samples + ' settleChanges=' + stage500.changes + ' layout=' + JSON.stringify(stage500.layoutDump) + ' content=' + JSON.stringify(stage500.contentDump));

// 回到 1400x900 的确定桌面，后续段落从这里继续。
await send('Emulation.setTouchEmulationEnabled', { enabled: false });
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await markLeaving();
await send('Page.navigate', { url: PAGE_URL });
await waitReady();
await ev('try { var P = window.PaperOS; if (P.tour && P.tour.close) P.tour.close(); var d = document.querySelector(".paper-dialog[open]"); if (d && d.close) d.close(); } catch (err) {}');
await sleep(240);
const backSettled = await settlePageValue(function () {
  var P = window.PaperOS;
  P.wm.open('notes');
  var win = document.querySelector('.window[data-app="notes"]');
  var rect = win ? win.getBoundingClientRect() : null;
  return {
    isSheet: P.wm.isSheet(),
    width: rect ? Math.round(rect.width) : null,
    viewportW: document.documentElement.clientWidth
  };
});
const back1400 = backSettled.value;
if (back1400 && back1400.isSheet === false && back1400.width !== null && back1400.width < back1400.viewportW) ok('leaving the sheet restores the window bounds', JSON.stringify(back1400) + ' settleSamples=' + backSettled.samples);
else bad('leaving the sheet restores the window bounds', JSON.stringify(back1400) + ' settleSamples=' + backSettled.samples);
/* 多次视口切换会留下 layout/recovery journal；清掉再走后面的 newer-version 段落，
   否则 journal 会在 boot 时盖掉 host 快照（源码注释里写过的坑）。 */
await ev('try { window.localStorage.removeItem("paper-os.recovery.v1"); } catch (err) {}');
await ev('window.PaperOS.storage.flush()');
await sleep(260);

// 上面三次改视口各自触发了一次布局保存（180ms 防抖，420ms 落盘）。离开这一段之前
// 必须先把它落定：留着 pending 的话，下面 navigate 时的 pagehide 会写一份 recovery
// journal，而 journal 在 init 里优先于 host 快照（无条件覆盖 raw），既有的
//「更新版本只读」段落就会对着旧 journal 跑，四条断言全红。这与 narrow 段收尾同一机制。
await ev('window.PaperOS.storage.flush()');
await sleep(260);

await stageGuard("a workspace from a NEWER version must not hang the desk");
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
await markLeaving();
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

await stageGuard("task-13 upgrade path: an equivalent 0.5.2 workspace → skin chooser");
// --- task-13 upgrade path: an equivalent 0.5.2 workspace → skin chooser ---
/* 夹具：预置一份"等价 0.5.2 工作区"的 host 快照（无 prefs.skin、无 meta.skinPromptVersion）。
   每轮 boot 前先删 recovery journal（它无条件覆盖 host 快照），host 快照带远未来 updatedAt，
   压过本机 file:// 缓存，于是六轮 boot 都是可控的同一份数据。页面文件写在 output/_probe/cys-e2e
   （和 page.newer.html 同一址），跑完删除；浏览器 profile 仍在 %TEMP%。 */
const UPGRADE_FAR_FUTURE = 4102444800000;
const upgradeOldWorkspace = () => ({
  format: 'paper-os/workspace',
  version: 4,
  exportedAt: '2026-10-01T00:00:00.000Z',
  prefs: {
    paperTone: 'cream', paperTexture: true, showGrid: true, motion: 'system', theme: 'system',
    handFont: 'kai', lang: 'system', welcomeDismissed: true, dockOrder: [],
  },
  meta: {
    createdAt: 1793600000000, updatedAt: UPGRADE_FAR_FUTURE, seededAt: 0, welcomeDocId: '',
    promptsSeededAt: 1793600000000, sampleClearedAt: 1793600000000,
  },
  nodes: [], stickies: [], tasks: [], prompts: [],
});
const upgradeState = () => run(function () {
  var P = window.PaperOS;
  var dialog = document.querySelector('.paper-dialog[open]');
  var choice = dialog ? dialog.querySelector('.skin-choice') : null;
  var cards = choice ? choice.querySelectorAll('.skin-choice__card') : [];
  var names = [];
  var selectedOption = '';
  var classicSelected = false;
  var modernSelected = false;
  for (var i = 0; i < cards.length; i += 1) {
    var option = cards[i].getAttribute('data-skin-option') || '';
    var isOn = cards[i].classList.contains('is-selected');
    if (isOn) selectedOption = option;
    if (option === 'classic' && isOn) classicSelected = true;
    if (option === 'modern' && isOn) modernSelected = true;
    var nameNode = cards[i].querySelector('.skin-choice__name');
    names.push(nameNode ? String(nameNode.textContent || '').trim() : '');
  }
  var checked = document.querySelector('input[name="skin-choice"]:checked');
  var skinState = (P && P.data && P.data.getSkinState) ? P.data.getSkinState() : null;
  var prefs = (P && P.data && P.data.getPrefs) ? P.data.getPrefs() : null;
  var dataSkin = document.documentElement.getAttribute('data-skin') || '';
  return {
    ready: !!window.__PAPER_OS_READY__,
    version: P ? P.version : '',
    chooser: !!choice,
    cards: cards.length,
    names: names,
    selectedOption: selectedOption,
    checkedValue: checked ? String(checked.value || '') : '',
    classicSelected: classicSelected,
    modernSelected: modernSelected,
    dialogs: document.querySelectorAll('.paper-dialog[open]').length,
    tourOpen: !!document.querySelector('.tour.is-open'),
    skin: dataSkin,
    dataSkin: dataSkin,
    prefsSkin: prefs ? String(prefs.skin || '') : '',
    suppressed: skinState ? !!skinState.suppressed : null,
    seenVersion: skinState ? String(skinState.seenVersion || '') : '',
    blocked: !!(P && P.storage && P.storage.blocked),
  };
});
const upgradeBoot = async (label, snapshot) => {
  /* 先让上一页的 420ms 防抖写盘落定，再删 recovery journal：pagehide 里只要还有
     dirty/pending 就会补写一份 journal，而 journal 在 init 里无条件覆盖 host 快照
     （实测症状：boot4 读到上一轮的 skinPromptVersion）。 */
  await ev('try { window.PaperOS.storage.flush(); } catch (err) {}');
  for (let i = 0; i < 30; i += 1) {
    const status = await ev('window.PaperOS && window.PaperOS.storage && window.PaperOS.storage.getDataStatus ? window.PaperOS.storage.getDataStatus() : null');
    if (status && status.phase === 'saved') break;
    await sleep(100);
  }
  await ev('try { window.localStorage.removeItem("paper-os.recovery.v1"); } catch (err) {}');
  const source = MUTATED_PAGE ? readFileSync(MUTATED_PAGE, 'utf8') : pageText;
  const file = join(OUT, 'page.upgrade-' + label + '.html');
  const boot = '<' + 'script>window.__SCHEDULE_HOST_MODE__=true;window.__SCHEDULE_HOST_SNAPSHOT__='
    + JSON.stringify(snapshot).replace(/</g, '\\u003c') + ';<' + '/script>';
  const at = source.indexOf('<script>');
  writeFileSync(file, source.slice(0, at) + boot + source.slice(at), 'utf8');
  pageErrors.length = 0;
  await markLeaving();
  await send('Page.navigate', { url: pathToFileURL(file).href });
  return waitReady();
};
const upgradeWaitChooser = async (limit) => {
  let last = null;
  for (let i = 0; i < (limit || 34); i += 1) {
    last = (await upgradeState()) || last;
    if (last && last.chooser) return last;
    await sleep(150);
  }
  return last;
};
/* "不弹"的判据必须给足观测窗：选择页在 boot 后约 420ms 才被调度，
   所以等到 READY 后 2.4s 再连查三次，不能只看一眼就记绿。 */
const upgradeQuiet = async () => {
  await sleep(2400);
  let last = null;
  for (let i = 0; i < 3; i += 1) {
    last = (await upgradeState()) || last;
    if (last && last.chooser) return last;
    await sleep(300);
  }
  return last;
};
const upgradeSnapshotNow = () => runWith(function (stamp) {
  var P = window.PaperOS;
  var snap = P.data.snapshotData();
  snap.meta.updatedAt = stamp;
  return snap;
}, [UPGRADE_FAR_FUTURE]);
const UPGRADE_TEMP_PAGES = [];

const upgradeSeen = {};
upgradeSeen.boot1 = Object.assign({ ready: await upgradeBoot('1', upgradeOldWorkspace()), version: '' }, (await upgradeWaitChooser()) || {});
UPGRADE_TEMP_PAGES.push('page.upgrade-1.html');
/* 关闭（ghost = 非确认关闭）：必须记录当前版本、保持经典、不写永久关闭。 */
const upgradeClose = (await run(function () {
  var dialog = document.querySelector('.paper-dialog[open]');
  if (!dialog) return { clicked: false, label: '' };
  var buttons = dialog.querySelectorAll('.dialog-actions .paper-btn');
  var target = null;
  for (var i = 0; i < buttons.length; i += 1) {
    if (buttons[i].classList.contains('paper-btn--ghost')) { target = buttons[i]; break; }
  }
  if (!target && buttons.length) target = buttons[0];
  if (!target) return { clicked: false, label: '' };
  var label = String(target.textContent || '').trim();
  target.click();
  return { clicked: true, label: label };
})) || { clicked: false, label: '' };
let upgradeClosedState = null;
for (let i = 0; i < 30; i += 1) {
  const now = await upgradeState();
  if (now && now.dialogs === 0 && now.seenVersion) { upgradeClosedState = now; break; }
  await sleep(150);
}
upgradeSeen.closed = Object.assign({ clicked: upgradeClose.clicked, label: upgradeClose.label }, upgradeClosedState || {});

/* 同版本重载：把关闭后的工作区当成 host 快照再喂一次（等价宿主持久化后重开）。 */
const upgradeAfterClose = await upgradeSnapshotNow();
upgradeSeen.boot2 = Object.assign({ ready: await upgradeBoot('2', upgradeAfterClose) }, (await upgradeQuiet()) || {});
UPGRADE_TEMP_PAGES.push('page.upgrade-2.html');

/* 把记录版本改旧（模拟从更老版本升级）：必须再弹一次，且仍突出经典。 */
const upgradeOlder = await upgradeSnapshotNow();
upgradeOlder.meta.skinPromptVersion = UPGRADE_OLDER_VERSION;
upgradeSeen.boot3 = Object.assign({ ready: await upgradeBoot('3', upgradeOlder) }, (await upgradeWaitChooser()) || {});
UPGRADE_TEMP_PAGES.push('page.upgrade-3.html');

/* 勾「下次不再提醒我」+ 确认（不换皮肤）：永久关闭必须落盘。 */
const upgradeSuppress = (await run(function () {
  var dialog = document.querySelector('.paper-dialog[open]');
  if (!dialog) return { confirmed: false, checked: false, reason: 'no dialog' };
  var suppress = dialog.querySelector('.skin-choice__suppress input');
  if (suppress && !suppress.checked) suppress.click();
  var checked = !!(suppress && suppress.checked);
  var buttons = dialog.querySelectorAll('.dialog-actions .paper-btn');
  var target = null;
  for (var i = 0; i < buttons.length; i += 1) {
    if (buttons[i].classList.contains('paper-btn--ink')) { target = buttons[i]; break; }
  }
  if (!target && buttons.length) target = buttons[buttons.length - 1];
  if (!target) return { confirmed: false, checked: checked, reason: 'no confirm' };
  target.click();
  return { confirmed: true, checked: checked, reason: 'clicked' };
})) || { confirmed: false, checked: false, reason: 'evaluate failed' };
let upgradeSuppressedState = null;
for (let i = 0; i < 30; i += 1) {
  const now = await upgradeState();
  if (now && now.dialogs === 0 && now.suppressed === true) { upgradeSuppressedState = now; break; }
  await sleep(150);
}
upgradeSeen.suppressed = Object.assign({ confirmed: upgradeSuppress.confirmed, checked: upgradeSuppress.checked }, upgradeSuppressedState || {});

/* 永久关闭后再把版本改旧：不得再弹。 */
const upgradeSuppressedSnapshot = await upgradeSnapshotNow();
upgradeSuppressedSnapshot.meta.skinPromptVersion = UPGRADE_OLDER_VERSION;
upgradeSeen.boot4 = Object.assign({ ready: await upgradeBoot('4', upgradeSuppressedSnapshot) }, (await upgradeQuiet()) || {});
UPGRADE_TEMP_PAGES.push('page.upgrade-4.html');

/* 手动打开选择页（真实入口：设置 → 外观 → 界面皮肤「选择」按钮）并确认 modern。 */
const upgradeSkinRow = await run(function () {
  var P = window.PaperOS;
  var opened = false;
  try { P.wm.open('settings', { section: 'appearance' }); opened = true; } catch (err) { opened = false; }
  var button = null;
  for (var i = 0; i < 40 && !button; i += 1) { button = document.querySelector('[data-skin-choose]'); }
  return { opened: opened, button: !!button, shellEntry: !!(P.shell && typeof P.shell.openSkinChooser === 'function') };
});
let upgradeManual = { clicked: false, via: '' };
for (let i = 0; i < 20; i += 1) {
  const clicked = await run(function () {
    var button = document.querySelector('[data-skin-choose]');
    if (!button) return { clicked: false, via: '' };
    button.click();
    return { clicked: true, via: 'settings-row' };
  });
  if (clicked && clicked.clicked) { upgradeManual = clicked; break; }
  await sleep(150);
}
if (!upgradeManual.clicked) {
  /* 兜底：设置按钮没渲染出来时走同一唯一入口（P.shell.openSkinChooser），
     并在详情里写明走的不是点击路径，避免把兜底当成真实点击证据。 */
  upgradeManual = (await run(function () {
    var P = window.PaperOS;
    if (!(P.shell && typeof P.shell.openSkinChooser === 'function')) return { clicked: false, via: '' };
    P.shell.openSkinChooser('manual');
    return { clicked: true, via: 'shell-entry' };
  })) || { clicked: false, via: '' };
}
let upgradeManualState = null;
for (let i = 0; i < 30; i += 1) {
  const now = await upgradeState();
  if (now && now.chooser) { upgradeManualState = now; break; }
  await sleep(150);
}
const upgradeModern = (await run(function () {
  var dialog = document.querySelector('.paper-dialog[open]');
  if (!dialog) return { confirmed: false };
  var card = dialog.querySelector('[data-skin-option="modern"]');
  if (card) {
    var input = card.querySelector('input');
    if (input) input.click(); else card.click();
  }
  var buttons = dialog.querySelectorAll('.dialog-actions .paper-btn');
  var target = null;
  for (var i = 0; i < buttons.length; i += 1) {
    if (buttons[i].classList.contains('paper-btn--ink')) { target = buttons[i]; break; }
  }
  if (!target && buttons.length) target = buttons[buttons.length - 1];
  if (!target) return { confirmed: false };
  target.click();
  return { confirmed: true };
})) || { confirmed: false };
let upgradeModernState = null;
for (let i = 0; i < 30; i += 1) {
  const now = await upgradeState();
  if (now && now.dialogs === 0 && now.skin === 'modern') { upgradeModernState = now; break; }
  await sleep(150);
}
upgradeSeen.modern = Object.assign({
  confirmed: upgradeModern.confirmed === true,
  manualVia: upgradeManual.via,
  manualChooser: !!(upgradeManualState && upgradeManualState.chooser),
  manualCards: upgradeManualState ? upgradeManualState.cards : 0,
  manualSelected: upgradeManualState ? upgradeManualState.selectedOption : '',
}, upgradeModernState || {});

/* 重载：选的 modern 必须第一帧就是 modern，且同版本不再弹选择页。 */
const upgradeModernSnapshot = await upgradeSnapshotNow();
upgradeSeen.boot5 = Object.assign({ ready: await upgradeBoot('5', upgradeModernSnapshot), dataSkinAtReady: '' }, {});
/* "第一帧"取证：READY 一成立立刻读 data-skin（不等稳定）。 */
upgradeSeen.boot5.dataSkinAtReady = await ev('document.documentElement.getAttribute("data-skin") || ""');
const upgradeBoot5Quiet = (await upgradeQuiet()) || {};
upgradeSeen.boot5 = Object.assign(upgradeSeen.boot5, upgradeBoot5Quiet);
UPGRADE_TEMP_PAGES.push('page.upgrade-5.html');
if (!pageErrors.length) ok('no page exceptions on the upgrade path');
else bad('no page exceptions on the upgrade path', pageErrors.slice(0, 3).join(' | '));
for (const one of upgradePathVerdicts(upgradeSeen)) {
  if (one.pass) ok(one.name, one.detail);
  else bad(one.name, one.detail);
}
for (const name of UPGRADE_TEMP_PAGES) {
  try { rmSync(join(OUT, name), { force: true }); } catch (err) { /* output dir cleanup */ }
}

await stageGuard("the English variant: generated page, dictionary + F() templates");
// --- the English variant: generated page, dictionary + F() templates ---
if (!enMatch) {
  bad('the build ships an English page variant', 'PAGE_B64_EN missing from client.js');
} else {
  pageErrors.length = 0;
  await markLeaving();
  await send('Page.navigate', { url: pathToFileURL(PAGE_EN).href });
  let enReady = await waitReady();
  if (enReady) {
    // file:// storage is shared between the two variants here; the zh run left a saved
    // desk behind. User data is never translated, so the English pass starts clean.
    await ev('window.PaperOS.storage.clearAll()');
    await ev('try { window.localStorage.clear(); } catch (err) {}');
    await markLeaving();
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
  if (enTour && enTour.bodies[4] && enTour.bodies[4].indexOf('Content saves automatically') !== -1) ok('the tour no longer mentions the save status', enTour.bodies[4].slice(0, 60));
  else bad('the tour no longer mentions the save status', JSON.stringify(enTour && enTour.bodies[4]));

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

await stageGuard("cross-language data: a legacy sentinel title must not leak into the English UI");
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
await markLeaving();
await send('Page.navigate', { url: pathToFileURL(crossPage).href });
await waitReady();
/* The previous page instance wrote a recovery journal on unload (pagehide). That journal
   is a legitimate preferred source and would mask the fixture under test - drop only that
   one key (never clearAll) and reload so the injected host workspace is the one loaded. */
await ev('try { window.localStorage.removeItem("paper-os.recovery.v1"); } catch (err) {}');
await markLeaving();
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
    /* 原来的状态行 [data-testid=prompt-heading] 已删；当前编辑对象改读标题输入框。 */
    editorTitle: titleInput ? titleInput.value : '',
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
const crossClean = cross && cross.cjk === 0 && !/[\u4e00-\u9fff]/.test(cross.editorTitle || '');
if (crossClean) ok('an old workspace shows no CJK in the English prompt library', JSON.stringify({ cjk: cross.cjk, editorTitle: cross.editorTitle }));
else bad('an old workspace shows no CJK in the English prompt library', JSON.stringify(cross && { cjk: cross.cjk, editorTitle: cross.editorTitle }));
if (!pageErrors.length) ok('no page exceptions on the cross-language workspace');
else bad('no page exceptions on the cross-language workspace', pageErrors.slice(0, 3).join(' | '));

await shot('page-final');
// --- 0.7.0 插图：粘贴 / 拖拽 / 选文件都走同一条入库路径 ---
// 这里打桩的只有"宿主资产接口"（P.noteAssets.prepare / put），块编辑器、DOM 序列化、
// 拖放落位与灯箱全是产品代码。之所以能打桩：宿主路由在真机上由 smoke/host_route_test.mjs
// 用真实文件系统验证过，真机 e2e 再调一次真实 HTTP 只是重复。
await stageGuard("0.7.0 pictures: paste, drop, reorder and lightbox");
await ev('(function () { window.__assetStub = { puts: 0, prepared: [] };' +
  ' var prep = window.PaperOS.noteAssets.prepare;' +
  ' window.PaperOS.noteAssets.prepare = async function (file) { var out = await prep(file);' +
  '   window.__assetStub.prepared.push({ name: file.name, w: out.width, h: out.height, bytes: out.blob.size, mime: out.mime });' +
  '   return out; };' +
  ' window.PaperOS.noteAssets.put = async function (prepared) { window.__assetStub.puts += 1;' +
  '   return { type: "image", assetId: "ast_" + String(window.__assetStub.puts).padStart(12, "0"),' +
  '     w: prepared.width, h: prepared.height, bytes: prepared.blob.size, mime: prepared.mime }; };' +
  ' return true; })()');

/* 造两张真图片（画布→PNG），再用与产品相同的入口灌进编辑器：
   一次走"选文件"（editor.addFiles），一次走"粘贴"（合成 ClipboardEvent），
   一次走"拖放"（合成 DragEvent）。三条路都必须走到同一个 addFiles。 */
const picture1 = await run(function () {
  var P = window.PaperOS;
  var note = P.data.createNote({ name: '插图回归纸页', content: '图前的一段字。' });
  P.wm.open('notes', { docId: note.id });
  return { id: note.id };
});
async function makePng(name, w, h, colour) {
  return ev('(function () { var c = document.createElement("canvas"); c.width = ' + w + '; c.height = ' + h + ';' +
    ' var ctx = c.getContext("2d"); ctx.fillStyle = "' + colour + '"; ctx.fillRect(0, 0, ' + w + ', ' + h + ');' +
    ' return new Promise(function (resolve) { c.toBlob(function (blob) {' +
    '   resolve({ dataUrl: c.toDataURL("image/png"), size: blob.size, name: "' + name + '" }); }, "image/png"); }); })()');
}
const pngA = await makePng('a.png', 320, 200, '#c96');
const pngB = await makePng('b.png', 640, 360, '#69c');
await ev('(function () { window.__pngA = ' + JSON.stringify(pngA) + '; window.__pngB = ' + JSON.stringify(pngB) + '; return true; })()');

// 1) 选文件：把文件塞进真实的 file input 并触发 change —— 走的就是产品的 change 监听。
const viaPicker = await ev('(async function () {' +
  ' var win = document.querySelector(".window[data-app=notes]");' +
  ' var input = win.querySelector("[data-testid=note-file-input]");' +
  ' if (!input) return { error: "no file input" };' +
  ' var blob = await (await fetch(window.__pngA.dataUrl)).blob();' +
  ' var file = new File([blob], window.__pngA.name, { type: "image/png" });' +
  ' var dt = new DataTransfer(); dt.items.add(file);' +
  ' input.files = dt.files;' +
  ' input.dispatchEvent(new Event("change", { bubbles: true }));' +
  ' await new Promise(function (r) { setTimeout(r, 800); });' +
  ' var P = window.PaperOS;' +
  ' var id = P.data.listNotes().filter(function (n) { return n.name === "插图回归纸页"; })[0].id;' +
  ' return { blocks: P.data.getNode(id).blocks,' +
  '   figures: document.querySelectorAll(".note-figure").length }; })()');
if (viaPicker && !viaPicker.error && viaPicker.figures === 1
  && Array.isArray(viaPicker.blocks) && viaPicker.blocks.filter(function (b) { return b.type === 'image'; }).length === 1) {
  ok('picking a file adds exactly one image block', JSON.stringify({ figures: viaPicker.figures }));
} else {
  bad('picking a file adds exactly one image block', JSON.stringify(viaPicker && { error: viaPicker.error, figures: viaPicker.figures, kinds: (viaPicker.blocks || []).map(function (b) { return b.type; }) }));
}

// 2) 粘贴：合成 paste 事件，剪贴板里带一张图。
const viaPaste = await ev('(async function () { var body = document.querySelector(".window[data-app=notes] .note-body");' +
  ' var win = document.querySelector(".window[data-app=notes]");' +
  ' var blob = await (await fetch(window.__pngB.dataUrl)).blob();' +
  ' var file = new File([blob], window.__pngB.name, { type: "image/png" });' +
  ' var dt = new DataTransfer(); dt.items.add(file);' +
  ' body.focus();' +
  ' var event = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });' +
  ' body.dispatchEvent(event);' +
  ' await new Promise(function (r) { setTimeout(r, 900); });' +
  ' return { figures: body.querySelectorAll(".note-figure").length,' +
  '   puts: window.__assetStub.puts, prepared: window.__assetStub.prepared }; })()');
if (viaPaste && viaPaste.figures === 2 && viaPaste.puts === 2) ok('pasting a picture adds a second image block', JSON.stringify({ figures: viaPaste.figures, puts: viaPaste.puts }));
else bad('pasting a picture adds a second image block', JSON.stringify(viaPaste));

// 3) 序列化回 blocks：图片块与文字块的顺序必须与 DOM 一致。
const serialized = await ev('(function () { var P = window.PaperOS;' +
  ' var id = P.data.listNotes().filter(function (n) { return n.name === "插图回归纸页"; })[0].id;' +
  ' var node = P.data.getNode(id);' +
  ' return { kinds: node.blocks.map(function (b) { return b.type; }),' +
  '   ids: node.blocks.filter(function (b) { return b.type === "image"; }).map(function (b) { return b.assetId; }),' +
  '   contentHasText: node.content.indexOf("图前的一段字。") !== -1,' +
  '   contentMentionsImages: /ast_/.test(node.content) }; })()');
if (serialized && serialized.kinds.join(',') === 'text,image,image') ok('the note stores text then two image blocks in DOM order', JSON.stringify(serialized.kinds));
else bad('the note stores text then two image blocks in DOM order', JSON.stringify(serialized));
if (serialized && serialized.contentHasText && !serialized.contentMentionsImages) ok('content stays a text-only projection of the blocks');
else bad('content stays a text-only projection of the blocks', JSON.stringify(serialized));

// 4) 拖动排序：把第一张图拖到第二张之后。
const reordered = await ev('(function () { var figures = Array.prototype.slice.call(document.querySelectorAll(".note-figure"));' +
  ' if (figures.length < 2) return { error: "need two figures" };' +
  ' var before = figures.map(function (f) { return f.getAttribute("data-asset"); });' +
  ' var dt = new DataTransfer();' +
  ' figures[0].dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));' +
  ' var rect = figures[1].getBoundingClientRect();' +
  ' figures[1].dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true, clientY: rect.bottom - 2 }));' +
  ' figures[1].dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));' +
  ' figures[0].dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));' +
  ' var after = Array.prototype.slice.call(document.querySelectorAll(".note-figure")).map(function (f) { return f.getAttribute("data-asset"); });' +
  '   var P = window.PaperOS;' +
  '   var id = P.data.listNotes().filter(function (n) { return n.name === "插图回归纸页"; })[0].id;' +
  '   var stored = P.data.getNode(id).blocks.filter(function (b) { return b.type === "image"; }).map(function (b) { return b.assetId; });' +
  '   return { before: before, after: after, stored: stored }; })()');
if (reordered && !reordered.error && reordered.before.join(',') === reordered.after.slice().reverse().join(',')) {
  ok('dragging one figure past another reorders the DOM');
} else {
  bad('dragging one figure past another reorders the DOM', JSON.stringify(reordered));
}
if (reordered && !reordered.error && reordered.stored.join(',') === reordered.after.join(',')) {
  ok('the reorder is written back to the stored blocks', JSON.stringify(reordered.stored));
} else {
  bad('the reorder is written back to the stored blocks', JSON.stringify(reordered && reordered.stored));
}

// 5) 灯箱：点眼睛开、Esc 关。
const lightbox = await run(function () {
  var figure = document.querySelector('.note-figure');
  if (!figure) return { error: 'no figure' };
  var zoom = figure.querySelector('[data-testid="note-figure-zoom"]');
  if (!zoom) return { error: 'no zoom button' };
  zoom.click();
  var dialog = document.querySelector('[data-testid="note-lightbox"]');
  var opened = !!(dialog && (dialog.open || dialog.hasAttribute('open')));
  if (dialog) dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
  var closed = !document.querySelector('[data-testid="note-lightbox"]');
  return { opened: opened, closed: closed };
});
if (lightbox && !lightbox.error && lightbox.opened && lightbox.closed) ok('the eye opens a lightbox and cancelling closes it', JSON.stringify(lightbox));
else bad('the eye opens a lightbox and cancelling closes it', JSON.stringify(lightbox));

// 6) 缺图：把一张图的 id 换成一个不存在的资产，必须渲染占位而不是抛错。
const missing = await run(function () {
  var P = window.PaperOS;
  var id = P.data.listNotes().filter(function (n) { return n.name === '插图回归纸页'; })[0].id;
  var blocks = P.data.getNode(id).blocks.map(function (b) {
    if (b.type !== 'image') return b;
    var copy = {}; Object.keys(b).forEach(function (k) { copy[k] = b[k]; });
    copy.assetId = 'ast_ffffffffffff';
    return copy;
  });
  P.data.updateNode(id, { blocks: blocks });
  P.wm.close ? P.wm.close('notes') : null;
  P.wm.open('notes', { docId: id });
  return new Promise(function (resolve) {
    setTimeout(function () {
      resolve({ missing: document.querySelectorAll('.note-figure.is-missing').length,
        bootError: window.__PAPER_OS_BOOT_ERROR__ || '' });
    }, 600);
  });
});
if (missing && missing.missing >= 1 && !missing.bootError) ok('a missing picture renders a placeholder instead of throwing', JSON.stringify(missing));
else bad('a missing picture renders a placeholder instead of throwing', JSON.stringify(missing));

// 7) 孤儿回收：磁盘上列出的 id 里，快照没引用的必须被 DELETE，被引用的必须留下。
const reclaim = await ev('(async function () { var P = window.PaperOS;' +
  ' var realFetch = window.fetch;' +
  ' var calls = { listed: 0, deleted: [] };' +
  ' var live = P.data.snapshotData();' +
  ' var referenced = [];' +
  ' live.nodes.forEach(function (n) { if (n.kind === "note" && n.blocks) n.blocks.forEach(function (b) {' +
  '   if (b.type === "image") referenced.push(b.assetId); }); });' +
  ' /* 挂一个假的资产接口：列出两张，其中一张没人引用。 */' +
  ' window.fetch = async function (url, init) {' +
  '   var target = String(url || "");' +
  '   if (target.indexOf("/api/control-your-schedule/assets") !== 0) return realFetch.apply(window, arguments);' +
  '   var method = (init && init.method) || "GET";' +
  '   if (method === "GET" && target.indexOf("?id=") === -1) {' +
  '     calls.listed += 1;' +
  '     return new Response(JSON.stringify({ ok: true, ids: [referenced[0], "ast_ffffffffff"] }),' +
  '       { status: 200, headers: { "content-type": "application/json" } });' +
  '   }' +
  '   if (method === "DELETE") { calls.deleted.push(target.split("id=")[1] || ""); return new Response("{}", { status: 200 }); }' +
  '   return new Response("{}", { status: 404 });' +
  ' };' +
  ' var result = await P.reclaimNoteAssets();' +
  ' window.fetch = realFetch;' +
  ' return { result: result, calls: calls, referenced: referenced }; })()');
if (reclaim && reclaim.calls.listed === 1
  && reclaim.calls.deleted.length === 1
  && reclaim.calls.deleted[0] === 'ast_ffffffffff') {
  ok('orphan pictures are deleted and referenced ones are kept', JSON.stringify(reclaim.calls.deleted));
} else {
  bad('orphan pictures are deleted and referenced ones are kept', JSON.stringify(reclaim && { calls: reclaim.calls, result: reclaim.result }));
}

// 8) 回收失败不能拖垮页面：接口不可达时返回计数而不是抛错。
const reclaimFails = await ev('(async function () { var P = window.PaperOS;' +
  ' var realFetch = window.fetch;' +
  ' window.fetch = async function () { throw new Error("offline"); };' +
  ' var result = await P.reclaimNoteAssets();' +
  ' window.fetch = realFetch;' +
  ' return result; })()');
if (reclaimFails && reclaimFails.deleted === 0 && reclaimFails.failed === 1) ok('a failed reclaim reports instead of throwing', JSON.stringify(reclaimFails));
else bad('a failed reclaim reports instead of throwing', JSON.stringify(reclaimFails));

if (!pageErrors.length) ok('no page exceptions during the picture assertions');
else bad('no page exceptions during the picture assertions', pageErrors.slice(0, 3).join(' | '));

// 工作区里不允许再出现 profile-*：这是「profile 必须放 %TEMP%」的回归守卫。
const profileLeftovers = readdirSync(OUT).filter((name) => name.startsWith('profile-'));
if (profileLeftovers.length) bad('no browser profile dirs accumulate under output/_probe/cys-e2e', profileLeftovers.join(', '));
/* PENDING 收口：登记过的红不算 FAIL 但单独计数并原样打印；没登记的红照常 FAIL。
   K7 收口用 --require-modern-clean：表非空、或表里有名字本轮没出现 → FAIL。 */
const requireClean = process.argv.includes('--require-modern-clean');
if (requireClean && SKIN !== 'modern') {
  bad('modern pending registry can be closed', '--require-modern-clean only makes sense together with --skin=modern');
} else if (requireClean && SKIN === 'modern') {
  const stale = Object.keys(MODERN_PENDING).filter((name) => !seenNames.has(name));
  if (Object.keys(MODERN_PENDING).length || stale.length) {
    bad('modern pending registry is empty', 'K7 收口：表里还有 ' + Object.keys(MODERN_PENDING).length
      + ' 条（本轮 PENDING ' + pendingList.length + '；没出现：' + (stale.join(', ') || '无') + '）');
  }
}
/* INVALID 不是产品失败：可见性在测量中被抢走时，这一轮的 FAIL 不能被当成证据。
   退出码 4 专门表示"本轮无效、请重跑"；只要还有真 FAIL 就先按 FAIL 退 1，
   但 RUN-FINGERPRINT 里 invalid=true 仍然让 K7 的 3 连拒绝这一轮。 */
const invalidRun = visibilityLosses > 0;
console.log('RUN-FINGERPRINT ' + JSON.stringify({
  build: RUN_BUILD,
  skin: SKIN,
  visibility: {
    trail: visibilityTrail,
    recoveries: visibilityRecoveries,
    losses: visibilityLosses,
    lostAt: visibilityLostAt,
  },
  settleSamplesMax: settleMax,
  settleChangesMax: settleChangesMax,
  invalid: invalidRun,
}));
const failed = checks.filter((c) => !c[0]);
const pendingWaves = {};
for (const one of pendingList) pendingWaves[one.wave] = (pendingWaves[one.wave] || 0) + 1;
console.log('checks: PASS ' + (checks.length - failed.length) + ' / FAIL ' + failed.length
  + (SKIN === 'modern' ? ' / PENDING ' + pendingList.length : ''));
if (pendingList.length) {
  console.log('pending: ' + Object.keys(pendingWaves).sort().map((wave) => wave + ' ' + pendingWaves[wave]).join(' / ')
    + ' | ' + pendingList.map((one) => one.name).join('; '));
}
if (cleared.length) console.log('pending-cleared: ' + Array.from(new Set(cleared)).join(', '));
if (invalidRun) {
  console.log('INVALID (visibility lost) | ' + visibilityLosses + ' loss(es) at ' + JSON.stringify(visibilityLostAt)
    + ' | 本轮不是产品失败证据，K7 3 连必须重跑这一轮');
}
ws.close();
proc.kill();
await sleep(300);
dropMutatedPage();
dropProfile();
process.exit(failed.length ? 1 : (invalidRun ? 4 : 0));
