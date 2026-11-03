#!/usr/bin/env node
/**
 * AC-05 classic visual regression: compare the 0.5.2 baseline build with the
 * current build, pixel by pixel, in three viewports and two desk states.
 *
 * STATUS: ACTIVE (task-10 closed). The threshold was set from a measured run on
 * the frozen anchor, not guessed: with one shared pre-seeded "existing classic
 * workspace", the fixed clock/random and the delayed modals settled, both
 * 1440x960 and 787x627 measured 0.0000% (0 pixels) of difference over the two
 * desk states. DIFF_THRESHOLD_PERCENT is 0.01% noise margin; the two reverse
 * mutations must exceed it by orders of magnitude.
 *
 * Plan:
 *   1. baseline page = `git show HEAD:.../plugin/client.js` (read-only, written to
 *      %TEMP%; never committed), current page = plugin/client.js;
 *   2. same CDP skeleton as smoke/page_e2e.mjs (headless Edge/Chrome, profile in
 *      %TEMP%, removed afterwards);
 *   3. fixed clock + fixed Math.random; the same host snapshot (an existing
 *      classic workspace) is injected into BOTH variants so the first screen
 *      cannot differ because of first-run UI; the skin chooser and the tour are
 *      closed and the fixture is verified quiet before any pixel is taken;
 *   4. three viewports (1440x960 / 787x627 / 420x820), two states each (empty
 *      desk, stickies + notes open); 420 is a contract assertion (windows inside
 *      the viewport, title bars reachable, no horizontal overflow), not pixel
 *      equality;
 *   5. per pair: decode both PNGs (no third-party deps), print the percentage of
 *      differing pixels and the top five 32x32 regions, FAIL when over threshold
 *      and write the diff image into output/_probe/classic-diff/;
 *   6. a fixed-clock/fixed-seed page fingerprint (tokens + key geometry) is the
 *      second, independent signal.
 *
 * Usage (from the project directory):
 *   node smoke/classic_visual_regression.mjs --plan            # plan only, no browser
 *   node smoke/classic_visual_regression.mjs                   # real run (needs a browser)
 *   node smoke/classic_visual_regression.mjs --fingerprint-only
 *   node smoke/classic_visual_regression.mjs --narrow-contract
 *   node smoke/classic_visual_regression.mjs --measure-only     # data, not a verdict
 *
 * Reverse audit (07 §4; raw output in receipts/K7-classic-visual.md):
 *   --mutate=modern-leak-bare-rule   add a bare `.dock { padding: 9px }` rule so it
 *                                    also hits classic -> must point at red pairs
 *   --mutate=classic-tint-2pct       shift one classic paper tone by ~2% -> must
 *                                    point at red pairs
 *   A mutation whose anchor no longer exists FAILs with `mutation did not apply`
 *   instead of silently proving nothing.
 *
 * No third-party dependencies, no absolute paths in the repo, explicit UTF-8.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync, deflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CLIENT = join(ROOT, 'plugin', 'client.js');
/* 证据只落工作区根 output/（与 page_e2e 的 OUT 同一套写法）：
   ROOT 是项目目录 projects/<name>，往上两级才是工作区根。 */
const DIFF_DIR = join(ROOT, '..', '..', 'output', '_probe', 'classic-diff');
const PLAN_ONLY = process.argv.includes('--plan');
const FINGERPRINT_ONLY = process.argv.includes('--fingerprint-only');
const NARROW_CONTRACT_ONLY = process.argv.includes('--narrow-contract');
/* 只报数据、不下结论：给阈值定量用（宽视口不触发夹取，数字与竞态无关）。 */
const MEASURE_ONLY = process.argv.includes('--measure-only');
const KEEP_SHOTS = process.argv.includes('--keep-shots');
const MUTATE = ((process.argv.find((one) => one.indexOf('--mutate=') === 0)) || '').slice('--mutate='.length);
/* 聚合门禁用 --expect-build=<sha16> 把"这次门禁判的构建"传进来：
   当前 client.js 与它不一致就直接 FAIL 并打印期望/实际，不继续产出误导性的对照结论。 */
const EXPECT_BUILD = ((process.argv.find((one) => one.indexOf('--expect-build=') === 0)) || '').slice('--expect-build='.length);

/* ---------- 判定阈值（实测依据见 receipts/K7-classic-visual.md） ----------
   冻结锚 776f366d1a85d3d5 上，干净夹具（同一份预置工作区 + 关掉选择页/导览 +
   固定时钟/随机 + 几何稳定窗）在 1440x960 与 787x627 两种桌面状态下实测
   **0.000000%（0 像素；连 PIXEL_TOLERANCE=0 都是 0 像素）**，且两轮一致 ——
   同一机器上经典渲染是逐像素确定的。阈值取 0.01%（1440x960 约 138 像素 /
   787x627 物理 2361x1881 约 444 像素）作抗子像素抖动的噪声余量，比"经典视觉被
   改动"的信号低两个数量级；两条反向变异（裸规则泄漏 / 经典色偏 2%）用它判红。 */
const DIFF_THRESHOLD_PERCENT = 0.01; // measured noise 0.000000% on the frozen anchor
/* 第二道信号（task-10 补充）：固定时钟/种子下把经典的关键令牌与几何序列化成短 hash。 */
const REQUIRE_FINGERPRINT_MATCH = true;  // --fingerprint-only 模式下按硬信号处理
/* Lead 裁定（2026-11-03）：1440/787 必须像素等同；420 暂用契约断言，等 420 窗口
   几何的成因定性后再决定是否也要求像素等同。 */
const PIXEL_VIEWPORTS = ['1440x960', '787x627'];
const CONTRACT_VIEWPORT = '420x820';
/* 每通道差 > 0 就算"不同像素"：实测同一构建两套页面逐像素相同，容差没有存在必要；
   留 0 才能让 2% 色偏（每通道 -6）这种小改动也有判定力。 */
const PIXEL_TOLERANCE = 0;
const REGION_GRID = 32;              // 32x32 区域用于前五差异报告
const BASE_REF = 'HEAD';             // 0.6.0 打 tag 后改成 tag；当前 HEAD = 0.5.2 发布提交
/* ---------- 共同夹具：一份"已存在的老工作区" ----------
   两种构建都必须看到同一份数据、同一套模态收尾，否则像素差会被第一屏的
   导览卡片/只读提示/首次提示卡污染（实测污染时 1440x960/desktop 差 1.1%，
   干净后 0.0000%）。工作区不带 prefs.skin / meta.skinPromptVersion：
   0.5.2 与 0.6.0 都把它当"老用户工作区"。 */
const FIXTURE_STAMP = 4102444800000;
const FIXTURE_SNAPSHOT = {
  format: 'paper-os/workspace',
  version: 4,
  exportedAt: '2026-10-01T00:00:00.000Z',
  prefs: {
    paperTone: 'cream', paperTexture: true, showGrid: true, motion: 'system', theme: 'system',
    handFont: 'kai', lang: 'system', welcomeDismissed: true, dockOrder: [],
  },
  meta: {
    createdAt: 1793600000000, updatedAt: FIXTURE_STAMP, seededAt: 0, welcomeDocId: '',
    promptsSeededAt: 1793600000000, sampleClearedAt: 1793600000000,
  },
  nodes: [], stickies: [], tasks: [], prompts: [],
};
const FIXTURE_BOOT = '<' + 'script>window.__SCHEDULE_HOST_MODE__=true;window.__SCHEDULE_HOST_SNAPSHOT__='
  + JSON.stringify(FIXTURE_SNAPSHOT).replace(/</g, '\\u003c') + ';<' + '/script>';

const VIEWPORTS = [
  { id: '1440x960', width: 1440, height: 960, scale: 1 },
  { id: '787x627', width: 787, height: 627, scale: 3 },
  { id: '420x820', width: 420, height: 820, scale: 3 },
];
const STATES = [
  { id: 'desktop', windows: [] },
  { id: 'stickies-notes', windows: ['stickies', 'notes'] },
];
const VARIANTS = ['baseline', 'current'];

const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];

const PLAN = {
  purpose: 'AC-05 classic visual regression vs the 0.5.2 baseline build',
  baseline: 'git show ' + BASE_REF + ':.../plugin/client.js',
  viewports: VIEWPORTS.map((one) => one.id),
  states: STATES.map((one) => one.id),
  fixtures: ['data-skin=classic', 'shared host snapshot (existing classic workspace)', 'chooser closed', 'tour closed', 'fixed clock', 'fixed Math.random', 'geometry stable window'],
  thresholdPercent: DIFF_THRESHOLD_PERCENT,
  pixelTolerance: PIXEL_TOLERANCE,
  mutations: ['modern-leak-bare-rule', 'classic-tint-2pct'],
  evidenceDir: 'output/_probe/classic-diff/',
};

function fail(message) {
  console.log('FAIL | ' + message);
  process.exit(1);
}

function skip(message) {
  console.log('SKIP | ' + message);
  process.exit(3);
}

if (PLAN_ONLY) {
  console.log('PLAN ' + JSON.stringify(PLAN, null, 2));
  console.log('NOTE | --plan only prints the plan; it is not evidence');
  process.exit(0);
}
if (!existsSync(CLIENT)) fail('plugin/client.js missing');
if (MUTATE && MUTATE !== 'modern-leak-bare-rule' && MUTATE !== 'classic-tint-2pct') {
  fail('unknown --mutate=' + MUTATE);
}

/* ---------- baseline + current page sources ---------- */

function decodePage(clientText) {
  const found = /var PAGE_B64 = '([A-Za-z0-9+/=]+)'/.exec(clientText);
  if (!found) fail('PAGE_B64 not found in a client build');
  return Buffer.from(found[1], 'base64').toString('utf8');
}

function readBaselineClient() {
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const rel = CLIENT.slice(repoRoot.length + 1).split(sep).join('/');
  try {
    return execFileSync('git', ['show', BASE_REF + ':' + rel], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    skip('baseline build not available from git (' + BASE_REF + '); nothing to compare');
    return '';
  }
}

const currentText = readFileSync(CLIENT, 'utf8');
const baselineText = readBaselineClient();
const pages = { baseline: decodePage(baselineText), current: decodePage(currentText) };

/* Reverse-audit mutations: applied to the CURRENT page only, in memory, written to
   %TEMP% so nothing misleading lands in the repo. 两条都必须"改到了东西"：
   锚点没命中就直接 FAIL（mutation did not apply），不许把空操作当反向证据。 */
function mutateCurrentPage(text) {
  if (MUTATE === 'modern-leak-bare-rule') {
    /* 现代块里的裸规则本来只该给 modern；泄漏成经典也生效 = 经典被现代 CSS 污染。
       两条作用于不同视口都可见的部件（应用坞 + 顶栏），避免“只抓宽视口”。 */
    return text.replace('</style>', '.dock { padding: 9px; }\n.topbar { background-color: #f9fafb; }\n</style>');
  }
  if (MUTATE === 'classic-tint-2pct') {
    /* 经典桌面渐变的收尾色偏 2%（#f1f3f5 -> #ebedef，每通道 -6）：
       桌面底色大面积可见，只要阈值有判定力就必须超阈。 */
    return text.replace('--desk-b: #f1f3f5;', '--desk-b: #ebedef;');
  }
  return text;
}
if (MUTATE) {
  const mutated = mutateCurrentPage(pages.current);
  if (mutated === pages.current) fail('mutation did not apply: ' + MUTATE + ' (anchor missing in the current page)');
  pages.current = mutated;
}

const FINGERPRINTS = {
  baseline: { bytes: Buffer.byteLength(baselineText), sha256: createHash('sha256').update(baselineText).digest('hex').slice(0, 16) },
  current: { bytes: Buffer.byteLength(currentText), sha256: createHash('sha256').update(currentText).digest('hex').slice(0, 16) },
  mutate: MUTATE || null,
};
console.log('FINGERPRINT ' + JSON.stringify(FINGERPRINTS));
if (EXPECT_BUILD && FINGERPRINTS.current.sha256 !== EXPECT_BUILD) {
  fail('build anchor mismatch | expected sha16=' + EXPECT_BUILD + ' | actual sha16=' + FINGERPRINTS.current.sha256
    + ' | actual bytes=' + FINGERPRINTS.current.bytes + ' | refusing to compare against a different build');
}

if (!FINGERPRINT_ONLY && !NARROW_CONTRACT_ONLY && !MEASURE_ONLY && DIFF_THRESHOLD_PERCENT === null) {
  skip('DIFF_THRESHOLD_PERCENT is TODO: first record the baseline/current diff on a frozen build, then set the threshold');
}

/* ---------- minimal PNG decode (RGBA8, non-interlaced) ---------- */

function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let colourType = 0;
  let bitDepth = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colourType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += length + 12;
  }
  if (bitDepth !== 8 || (colourType !== 6 && colourType !== 2)) {
    throw new Error('unsupported PNG (depth ' + bitDepth + ', colour type ' + colourType + ')');
  }
  const channels = colourType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor];
    cursor += 1;
    const line = raw.subarray(cursor, cursor + stride);
    cursor += stride;
    const current = Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? current[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : (pb <= pc ? up : upLeft);
      }
      current[x] = value & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const from = x * channels;
      const to = (y * width + x) * 4;
      out[to] = current[from];
      out[to + 1] = current[from + 1];
      out[to + 2] = current[from + 2];
      out[to + 3] = channels === 4 ? current[from + 3] : 255;
    }
    previous = current;
  }
  return { width, height, pixels: out };
}

/* ---------- minimal PNG write (RGBA8) for the diff image ---------- */

function encodePng(width, height, pixels) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc32 = (buffer) => {
    let c = 0xffffffff;
    for (let i = 0; i < buffer.length; i += 1) c = table[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData), 0);
    return Buffer.concat([length, typeAndData, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- diff ---------- */

function comparePng(baselineBuffer, currentBuffer) {
  const a = decodePng(baselineBuffer);
  const b = decodePng(currentBuffer);
  if (a.width !== b.width || a.height !== b.height) {
    return { sizeMismatch: true, a: [a.width, a.height], b: [b.width, b.height] };
  }
  const regions = new Map();
  let different = 0;
  const diffPixels = Buffer.alloc(a.width * a.height * 4);
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      const at = (y * a.width + x) * 4;
      const delta = Math.max(
        Math.abs(a.pixels[at] - b.pixels[at]),
        Math.abs(a.pixels[at + 1] - b.pixels[at + 1]),
        Math.abs(a.pixels[at + 2] - b.pixels[at + 2])
      );
      if (delta > PIXEL_TOLERANCE) {
        different += 1;
        diffPixels[at] = 255;
        diffPixels[at + 1] = 40;
        diffPixels[at + 2] = 40;
        diffPixels[at + 3] = 255;
        const key = Math.floor(x / REGION_GRID) + ',' + Math.floor(y / REGION_GRID);
        regions.set(key, (regions.get(key) || 0) + 1);
      } else {
        diffPixels[at] = b.pixels[at];
        diffPixels[at + 1] = b.pixels[at + 1];
        diffPixels[at + 2] = b.pixels[at + 2];
        diffPixels[at + 3] = 255;
      }
    }
  }
  const total = a.width * a.height;
  const top = Array.from(regions.entries())
    .sort((one, two) => two[1] - one[1])
    .slice(0, 5)
    .map(([key, count]) => {
      const [gx, gy] = key.split(',').map(Number);
      return { x: gx * REGION_GRID, y: gy * REGION_GRID, pixels: count };
    });
  return { sizeMismatch: false, width: a.width, height: a.height, percent: (different / total) * 100, top, diffPixels };
}

/* ---------- browser harness ---------- */

const BROWSER = CANDIDATES.find((one) => existsSync(one));
if (!BROWSER) skip('no headless browser found');

mkdirSync(DIFF_DIR, { recursive: true });
const WORK = join(tmpdir(), 'classic-visual-' + process.pid + '-' + Date.now());
const PROFILE = join(WORK, 'profile');
mkdirSync(WORK, { recursive: true });
const dropWork = () => {
  if (KEEP_SHOTS) { console.log('KEEP-SHOTS ' + WORK); return; }
  try { rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (error) { /* temp */ }
};
const pageFiles = Object.fromEntries(VARIANTS.map((variant) => {
  const file = join(WORK, variant + '.html');
  const source = pages[variant];
  const at = source.indexOf('<script>');
  if (at < 0) fail('built page has no <script> tag; cannot inject the shared fixture');
  /* 两种构建都注入同一份"老工作区"host 快照：第一屏不再出现首次导览/只读提示，
     像素对照才是在比经典表面而不是比启动态。 */
  writeFileSync(file, source.slice(0, at) + FIXTURE_BOOT + source.slice(at), 'utf8');
  return [variant, file];
}));
const SHOTS = Object.fromEntries(VARIANTS.map((variant) => [variant, join(WORK, 'shots-' + variant)]));
for (const variant of VARIANTS) mkdirSync(SHOTS[variant], { recursive: true });

/* 端口按 pid 派生：两个视觉对照并发跑（例如聚合门禁 + 单独跑）时，
   固定端口会让后启动的进程 attach 到前一个浏览器，读到别人的页面/快照。 */
const PORT = 9983 + (process.pid % 400);
const browser = spawn(BROWSER, [
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
if (!wsUrl) { console.log('FAIL | could not attach to the browser'); browser.kill(); dropWork(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
};
const send = (method, params) => new Promise((r) => {
  const id = ++msgId;
  pending.set(id, r);
  ws.send(JSON.stringify({ id, method, params: params || {} }));
});
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text };
  return r.result && r.result.result ? r.result.result.value : undefined;
};
const run = (fn) => ev('(' + fn.toString() + ')()');
const runWith = (fn, args) => ev('(' + fn.toString() + ')(' + (args || []).map((one) => JSON.stringify(one)).join(',') + ')');
/* 动画闸（和 page_e2e 同一条纪律）：入场/过渡未结束不取指纹、不截图。 */
const ANIMATIONS_IDLE = '(function () { if (!document.getAnimations) return true; var list = document.getAnimations(); for (var i = 0; i < list.length; i += 1) { if (list[i].playState === "running") return false; } return true; })()';
const waitAnimationsIdle = async (limit) => {
  for (let i = 0; i < (limit || 30); i += 1) {
    if (await ev(ANIMATIONS_IDLE)) return true;
    await sleep(80);
  }
  return false;
};
/* 隐藏页不投递 resize / 不跑 rAF（ui-k4 定性）：导航后带到前台，ready 必须可见。 */
const waitReady = async () => {
  try { await send('Page.bringToFront'); } catch (err) { /* older targets */ }
  let hidden = 0;
  for (let i = 0; i < 80; i += 1) {
    await sleep(250);
    if (await ev('document.visibilityState !== "visible"')) {
      hidden += 1;
      if (hidden % 4 === 0) { try { await send('Page.bringToFront'); } catch (err) { /* older targets */ } }
      continue;
    }
    hidden = 0;
    if (await ev('!!window.__PAPER_OS_READY__')) return true;
  }
  return false;
};
const shot = async (file) => {
  const result = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  writeFileSync(file, Buffer.from(result.result.data, 'base64'));
};
/* 落定一页的夹具：延迟模态（选择页 420ms / 导览 1100ms）都出来并关掉，
   再确认"没有 dialog / 没有 tour / 没有首次提示卡 / 没有只读提示条"。 */
const settleFixture = async () => {
  await sleep(1600);
  for (let round = 0; round < 10; round += 1) {
    const closed = await run(function () {
      var closed = [];
      var dialog = document.querySelector('.paper-dialog[open]');
      if (dialog) {
        var buttons = dialog.querySelectorAll('.dialog-actions .paper-btn');
        var target = null;
        for (var i = 0; i < buttons.length; i += 1) {
          if (buttons[i].classList.contains('paper-btn--ghost')) { target = buttons[i]; break; }
        }
        if (!target && buttons.length) target = buttons[0];
        if (target) { target.click(); closed.push('dialog:' + String(target.textContent || '').trim()); }
      }
      var P = window.PaperOS;
      if (P && P.tour && typeof P.tour.close === 'function') { P.tour.close(); closed.push('tour-close'); }
      return closed;
    });
    await sleep(450);
    const quiet = await run(function () {
      var firstRun = document.getElementById('first-run');
      var notice = document.querySelector('[data-testid="desk-notice"]');
      return {
        dialogs: document.querySelectorAll('.paper-dialog[open]').length,
        tour: !!document.querySelector('.tour.is-open'),
        firstRun: firstRun ? !firstRun.hidden : false,
        notice: notice ? String(notice.textContent || '').slice(0, 60) : '',
        visibility: document.visibilityState,
      };
    });
    if (quiet && quiet.dialogs === 0 && quiet.tour === false && quiet.firstRun === false && quiet.notice === '') {
      return { ok: true, rounds: round, closed: closed, quiet: quiet };
    }
  }
  return { ok: false, closed: [], quiet: null };
};
/* 截图完到下一次导航之间：先 flush 落定（否则 pagehide 会补写 recovery journal），
   再清掉 localStorage（journal 在 init 里无条件覆盖 host 快照）。 */
const resetStorage = async () => {
  await ev('try { if (window.PaperOS && window.PaperOS.storage && window.PaperOS.storage.flush) window.PaperOS.storage.flush(); } catch (err) {}');
  for (let i = 0; i < 30; i += 1) {
    const phase = await ev('window.PaperOS && window.PaperOS.storage && window.PaperOS.storage.getDataStatus ? window.PaperOS.storage.getDataStatus().phase : "unknown"');
    if (phase === 'saved' || phase === 'unknown') break;
    await sleep(80);
  }
  await ev('try { window.localStorage.clear(); } catch (err) {}');
};

/* 几何稳定窗（和 page_e2e 同一条纪律）：连续 3 次采样完全相同才截图/取指纹，
   入场动画中间态（420 的 scale(.985)+translateY(9)）不会被当成经典几何。 */
const GEOMETRY_SAMPLE = function () {
  var root = document.documentElement;
  function box(sel) {
    var el = document.querySelector(sel);
    if (!el) return null;
    var rect = el.getBoundingClientRect();
    return [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)];
  }
  var wins = [];
  var list = document.querySelectorAll('.window');
  for (var i = 0; i < list.length; i += 1) {
    var one = list[i].getBoundingClientRect();
    wins.push([Math.round(one.left), Math.round(one.top), Math.round(one.width), Math.round(one.height)].join(','));
  }
  return { topbar: box('.topbar'), dock: box('.dock'), dayCard: box('.day-card'), windows: wins, viewport: [root.clientWidth, root.clientHeight] };
};
const waitStableGeometry = async (need, limit) => {
  const want = need || 3;
  let previous = '';
  let streak = 0;
  for (let i = 0; i < (limit || 40); i += 1) {
    if (!(await ev(ANIMATIONS_IDLE))) { streak = 0; previous = ''; await sleep(80); continue; }
    const now = JSON.stringify(await run(GEOMETRY_SAMPLE));
    if (now === previous) streak += 1; else streak = 1;
    previous = now;
    if (streak >= want) return { ok: true, samples: i + 1 };
    await sleep(100);
  }
  return { ok: false, samples: limit || 40 };
};

/* Fixed clock + random: the date card and the seeded samples must not drift
   between the two variants (or between runs). */
const FREEZE = [
  '(function () {',
  '  var fixed = new Date(2026, 10, 3, 9, 41, 0).getTime();',
  '  var RealDate = Date;',
  '  function FakeDate(value) {',
  '    if (!(this instanceof FakeDate)) return new RealDate(fixed).toString();',
  '    return arguments.length ? new RealDate(value) : new RealDate(fixed);',
  '  }',
  '  FakeDate.prototype = RealDate.prototype;',
  '  FakeDate.now = function () { return fixed; };',
  '  FakeDate.parse = RealDate.parse;',
  '  FakeDate.UTC = RealDate.UTC;',
  '  window.Date = FakeDate;',
  '  var seed = 12345;',
  '  Math.random = function () { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };',
  '})();',
].join('\n');

/* 页面自报指纹：只读经典表面（令牌 / 关键几何 / 文案 / 窗口数量）。
   固定时钟与固定 Math.random 之后，同一构建必须给出同一个 hash。 */
const collectFingerprint = function () {
  var root = document.documentElement;
  var cs = getComputedStyle(root);
  function token(name) { return String(cs.getPropertyValue(name) || '').trim(); }
  function box(sel) {
    var el = document.querySelector(sel);
    if (!el) return null;
    var rect = el.getBoundingClientRect();
    return [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)];
  }
  var dockButtons = [];
  var buttons = document.querySelectorAll('.dock__btn');
  for (var i = 0; i < buttons.length; i += 1) {
    var buttonRect = buttons[i].getBoundingClientRect();
    dockButtons.push(Math.round(buttonRect.width) + 'x' + Math.round(buttonRect.height));
  }
  var windows = document.querySelectorAll('.window');
  var windowBoxes = [];
  for (var w = 0; w < windows.length; w += 1) {
    var windowRect = windows[w].getBoundingClientRect();
    windowBoxes.push([Math.round(windowRect.left), Math.round(windowRect.top), Math.round(windowRect.width), Math.round(windowRect.height)].join(','));
  }
  return {
    skin: root.getAttribute('data-skin') || '',
    theme: root.getAttribute('data-theme') || '',
    tokens: { paper: token('--paper'), ink: token('--ink'), radiusWin: token('--radius-win'), dockHeight: token('--dock-height') },
    fonts: { serif: token('--font-serif'), hand: token('--font-hand') },
    topbar: box('.topbar'),
    dock: box('.dock'),
    dayCard: box('.day-card'),
    windows: windowBoxes,
    dockButtons: dockButtons.join('|')
  };
};
const fingerprintHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

/* 420x820 契约：窗口完整落在视口/工作区内、标题栏可点、页面没有横向溢出。
   不判像素（窄视口允许“把越界窗口收进来”这种必要改动，但必须成因可解释）。 */
const evaluateNarrowContract = function () {
  var root = document.documentElement;
  var P = window.PaperOS;
  var area = (P.wm && P.wm.getWorkArea) ? P.wm.getWorkArea() : null;
  var viewportW = root.clientWidth;
  var viewportH = root.clientHeight;
  var boxes = [];
  var list = document.querySelectorAll('.window');
  for (var i = 0; i < list.length; i += 1) {
    var rect = list[i].getBoundingClientRect();
    boxes.push({ left: Math.round(rect.left), top: Math.round(rect.top), right: Math.round(rect.right), bottom: Math.round(rect.bottom), w: Math.round(rect.width), h: Math.round(rect.height) });
  }
  var outsideViewport = boxes.filter(function (box) {
    return box.left < -1 || box.top < -1 || box.right > viewportW + 1 || box.bottom > viewportH + 1;
  }).length;
  var withinArea = area ? boxes.every(function (box) {
    return box.left >= area.x - 1 && box.top >= area.y - 1 && box.right <= area.x + area.w + 1 && box.bottom <= area.y + area.h + 1;
  }) : null;
  var bars = document.querySelectorAll('.window__titlebar');
  var titlebarsVisible = true;
  for (var b = 0; b < bars.length; b += 1) {
    var bar = bars[b].getBoundingClientRect();
    if (bar.left < -1 || bar.right > viewportW + 1 || bar.top < -1 || bar.bottom > viewportH + 1) titlebarsVisible = false;
  }
  var overflowX = Math.round(root.scrollWidth - root.clientWidth);
  var overflowY = Math.round(root.scrollHeight - root.clientHeight);
  /* workArea 是“窗口可以停靠的区域”，经典窗口允许自由摆放，因此它只作为信息打印，
     不作为判据；判据是：不越出视口、标题栏可点、页面无横向溢出。 */
  /* 空桌面没有窗口可裁，契约只要求不溢出；有窗口时再要求都在视口内。 */
  var pass = outsideViewport === 0 && titlebarsVisible && overflowX === 0;
  return {
    pass: pass,
    viewport: { w: viewportW, h: viewportH },
    windows: boxes,
    workArea: area,
    outsideViewport: outsideViewport,
    withinWorkArea: withinArea,
    titlebarsVisible: titlebarsVisible,
    overflowX: overflowX,
    overflowY: overflowY
  };
};

await send('Page.enable');
await send('Runtime.enable');

const results = [];
/* 每一组的结论都留一份：失败时把 builds + 六组 percent/top5 一起打印，
   避免只看 fingerprint 行看不出红在哪。 */
const pairResults = [];
for (const variant of VARIANTS) {
  for (const viewport of VIEWPORTS) {
    for (const state of STATES) {
      const injected = await send('Page.addScriptToEvaluateOnNewDocument', { source: FREEZE });
      const scriptId = injected.result && injected.result.identifier;
      await send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 });
      await send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.scale, mobile: false,
      });
      /* 上一页可能留下 journal/缓存：先落定并清掉，再导航（host 快照才会被采用）。 */
      await resetStorage();
      await send('Page.navigate', { url: pathToFileURL(pageFiles[variant]).href });
      const ready = await waitReady();
      if (!ready) { results.push({ variant, viewport: viewport.id, state: state.id, error: 'never ready' }); continue; }
      /* 夹具必须干净：延迟模态全部关掉 + 没有首次提示卡/只读提示条。不干净就不截图，
         否则像素差是启动态污染，不是经典回归证据。 */
      const fixture = await settleFixture();
      if (!fixture.ok) {
        console.log('FAIL | fixture ' + viewport.id + '/' + state.id + ' | ' + JSON.stringify(fixture));
        results.push({ variant, viewport: viewport.id, state: state.id, error: 'fixture not settled', fixture });
        continue;
      }
      await run(function () {
        document.documentElement.setAttribute('data-skin', 'classic');
        return true;
      });
      if (state.windows.length) await runWith(function (ids) {
        ids.forEach(function (id) { window.PaperOS.wm.open(id); });
        return true;
      }, [state.windows]);
      const stable = await waitStableGeometry(3, 40);
      if (!stable.ok) console.log('INFO | geometry did not settle | ' + viewport.id + '/' + state.id + ' | ' + variant);
      const idle = await waitAnimationsIdle(40);
      if (!idle) console.log('INFO | animations still running after 3.2s | ' + viewport.id + '/' + state.id + ' | ' + variant);
      const fingerprint = await run(collectFingerprint);
      const hash = fingerprintHash(fingerprint);
      console.log('PAGE-FINGERPRINT ' + JSON.stringify({ variant, viewport: viewport.id, state: state.id, hash }));
      const contract = (viewport.id === CONTRACT_VIEWPORT) ? await run(evaluateNarrowContract) : null;
      if (contract && (NARROW_CONTRACT_ONLY || state.id === 'stickies-notes')) {
        console.log('NARROW-CONTRACT ' + JSON.stringify({ variant, viewport: viewport.id, state: state.id, narrow: contract }));
      }
      let frame = null;
      if (!FINGERPRINT_ONLY && !NARROW_CONTRACT_ONLY) {
        frame = join(SHOTS[variant], viewport.id + '-' + state.id + '.png');
        await shot(frame);
      }
      if (scriptId) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId });
      results.push({ variant, viewport: viewport.id, state: state.id, frame, fingerprint, hash, contract, fixture, stable });
    }
  }
}

/* ---------- fingerprint comparison (works before pixel thresholds exist) ---------- */
let fingerprintFailures = 0;
for (const viewport of VIEWPORTS) {
  for (const state of STATES) {
    const baseline = results.find((one) => one.variant === 'baseline' && one.viewport === viewport.id && one.state === state.id);
    const current = results.find((one) => one.variant === 'current' && one.viewport === viewport.id && one.state === state.id);
    const label = viewport.id + '/' + state.id;
    if (!baseline || !current || !baseline.hash || !current.hash) {
      console.log('FAIL | fingerprint ' + label + ' | missing side');
      fingerprintFailures += 1;
      continue;
    }
    if (MEASURE_ONLY) {
      console.log('INFO | fingerprint ' + label + ' | ' + (baseline.hash === current.hash
        ? 'match'
        : 'differs | baseline=' + JSON.stringify(baseline.fingerprint) + ' | current=' + JSON.stringify(current.fingerprint)));
      continue;
    }
    if (baseline.hash === current.hash) {
      console.log('PASS | fingerprint ' + label + ' | ' + current.hash);
    } else {
      const detail = { baseline: baseline.hash, current: current.hash, baselineValues: baseline.fingerprint, currentValues: current.fingerprint };
      console.log((REQUIRE_FINGERPRINT_MATCH ? 'FAIL' : 'FINGERPRINT-DIFF') + ' | fingerprint ' + label + ' | ' + JSON.stringify(detail));
      if (REQUIRE_FINGERPRINT_MATCH) fingerprintFailures += 1;
    }
  }
}
mkdirSync(DIFF_DIR, { recursive: true });
const currentSha = FINGERPRINTS.current.sha256;
const fingerprintFile = join(DIFF_DIR, 'fingerprint-' + currentSha + '.json');
writeFileSync(fingerprintFile, JSON.stringify({
  mode: FINGERPRINT_ONLY ? 'fingerprint-only' : (NARROW_CONTRACT_ONLY ? 'narrow-contract' : 'measurement'),
  builds: FINGERPRINTS,
  requireFingerprintMatch: REQUIRE_FINGERPRINT_MATCH,
  entries: results.map((one) => ({ variant: one.variant, viewport: one.viewport, state: one.state, hash: one.hash, fingerprint: one.fingerprint, contract: one.contract })),
}, null, 2), 'utf8');
console.log('FINGERPRINT-ARTIFACT ' + JSON.stringify({ file: 'output/_probe/classic-diff/fingerprint-' + currentSha + '.json', build: currentSha }));

if (NARROW_CONTRACT_ONLY) {
  let narrowFailures = 0;
  for (const variant of VARIANTS) {
    const entries = results.filter((one) => one.variant === variant && one.contract);
    const narrow = entries.length ? entries[entries.length - 1].contract : null;
    if (!narrow) { console.log('FAIL | narrow contract ' + variant + ' | no measurement'); narrowFailures += 1; continue; }
    console.log((narrow.pass ? 'PASS' : 'FAIL') + ' | narrow contract ' + variant + ' | ' + JSON.stringify({ viewport: narrow.viewport, windows: narrow.windows, workArea: narrow.workArea, outsideViewport: narrow.outsideViewport, withinWorkArea: narrow.withinWorkArea, titlebarsVisible: narrow.titlebarsVisible, overflowX: narrow.overflowX }));
    if (!narrow.pass) narrowFailures += 1;
  }
  console.log('classic visual narrow contract: variants ' + VARIANTS.length + ' / FAIL ' + narrowFailures);
  ws.close();
  browser.kill();
  await sleep(200);
  dropWork();
  process.exit(narrowFailures ? 1 : 0);
}

if (FINGERPRINT_ONLY) {
  console.log('classic visual fingerprints: pairs ' + (VIEWPORTS.length * STATES.length) + ' / FAIL ' + fingerprintFailures);
  ws.close();
  browser.kill();
  await sleep(200);
  dropWork();
  process.exit(fingerprintFailures ? 1 : 0);
}

/* ---------- compare pairs ---------- */
let failures = 0;
let pairs = 0;
for (const viewport of VIEWPORTS) {
  for (const state of STATES) {
    const baseline = results.find((one) => one.variant === 'baseline' && one.viewport === viewport.id && one.state === state.id);
    const current = results.find((one) => one.variant === 'current' && one.viewport === viewport.id && one.state === state.id);
    if (!baseline || !current || baseline.error || current.error) {
      console.log('FAIL | ' + viewport.id + '/' + state.id + ' | screenshot missing ' + JSON.stringify({ baseline: baseline && baseline.error, current: current && current.error }));
      failures += 1;
      continue;
    }
    pairs += 1;
    if (viewport.id === CONTRACT_VIEWPORT) {
      const label = viewport.id + '/' + state.id;
      const left = baseline.contract;
      const right = current.contract;
      const ok = !!(left && right && left.pass && right.pass);
      console.log((ok ? 'PASS' : 'FAIL') + ' | narrow contract ' + label + ' | ' + JSON.stringify({ baseline: left && { pass: left.pass, windows: left.windows, workArea: left.workArea, overflowX: left.overflowX }, current: right && { pass: right.pass, windows: right.windows, workArea: right.workArea, overflowX: right.overflowX } }));
      pairResults.push({ pair: label, kind: 'narrow-contract', pass: ok });
      if (!ok) failures += 1;
      continue;
    }
    if (PIXEL_VIEWPORTS.indexOf(viewport.id) === -1) {
      console.log('INFO | ' + viewport.id + '/' + state.id + ' | 未登记判定方式（新增视口必须先登记阈值/契约）');
      continue;
    }
    const diff = comparePng(readFileSync(baseline.frame), readFileSync(current.frame));
    if (diff.sizeMismatch) {
      console.log('FAIL | ' + viewport.id + '/' + state.id + ' | size mismatch ' + JSON.stringify(diff));
      pairResults.push({ pair: viewport.id + '/' + state.id, kind: 'pixel', pass: false, sizeMismatch: true, detail: diff });
      failures += 1;
      continue;
    }
    const label = viewport.id + '/' + state.id;
    const detail = { percent: Math.round(diff.percent * 10000) / 10000, top5: diff.top, size: [diff.width, diff.height] };
    if (DIFF_THRESHOLD_PERCENT === null) {
      console.log('PIXEL-DIFF ' + label + ' | ' + JSON.stringify(detail));
      continue;
    }
    const pixelPass = diff.percent <= DIFF_THRESHOLD_PERCENT;
    pairResults.push({ pair: label, kind: 'pixel', pass: pixelPass, percent: detail.percent, top5: detail.top5, size: detail.size });
    if (!pixelPass) {
      failures += 1;
      const detailLine = 'FAIL | ' + label + ' | ' + JSON.stringify(detail);
      /* 反向审计不落图（07 §4.3）：变异轮次的 diff 图不能被误当真实回归证据。 */
      if (MUTATE) console.log(detailLine + ' | diff image suppressed (reverse-audit run)');
      else {
        const diffFile = join(DIFF_DIR, 'diff-' + viewport.id + '-' + state.id + '.png');
        writeFileSync(diffFile, encodePng(diff.width, diff.height, diff.diffPixels));
        console.log(detailLine + ' | diff image: output/_probe/classic-diff/' + viewport.id + '-' + state.id + '.png');
      }
    } else {
      console.log('PASS | ' + label + ' | ' + JSON.stringify(detail));
    }
  }
}

/* 结论块：builds + mutate + 六组 percent/top5 一次给全（红在哪一眼可读）。 */
console.log('SUMMARY ' + JSON.stringify({
  baseline: FINGERPRINTS.baseline,
  current: FINGERPRINTS.current,
  mutate: MUTATE || 'none',
  expectBuild: EXPECT_BUILD || '',
  thresholdPercent: DIFF_THRESHOLD_PERCENT,
  pairs: pairResults,
  failures: failures,
  fingerprintFailures: fingerprintFailures,
}));
console.log('RUN-FINGERPRINT ' + JSON.stringify({
  build: FINGERPRINTS,
  mutate: MUTATE || 'none',
  pairs: pairs,
  failures: failures,
  fingerprintFailures: fingerprintFailures,
}));
/* 跑到一半构建被换掉（有人在重建）：两次 sha 不一致就是"测的不是同一个靶"，直接 FAIL。 */
const afterText = readFileSync(CLIENT, 'utf8');
const afterSha = createHash('sha256').update(afterText).digest('hex').slice(0, 16);
if (afterSha !== FINGERPRINTS.current.sha256) {
  fail('build changed during the run | before sha16=' + FINGERPRINTS.current.sha256 + ' (' + FINGERPRINTS.current.bytes
    + ' B) | after sha16=' + afterSha + ' (' + Buffer.byteLength(afterText) + ' B) | this run is not evidence for either build');
}
console.log('classic visual: pairs ' + pairs + ' / threshold ' + DIFF_THRESHOLD_PERCENT + '% / mutate ' + (MUTATE || 'none')
  + ' / build baseline=' + FINGERPRINTS.baseline.sha256 + ' current=' + FINGERPRINTS.current.sha256
  + ' / FAIL ' + failures + ' / FINGERPRINT-FAIL ' + fingerprintFailures);
ws.close();
browser.kill();
await sleep(200);
dropWork();
if (MEASURE_ONLY) {
  console.log('measure-only: PIXEL-DIFF percentages above are data, not a verdict');
  process.exit(0);
}
/* 指纹是第二道信号：它红也必须是 FAIL（以前只有像素失败才退 1 —— 静默放过指纹红）。 */
process.exit((failures || fingerprintFailures) ? 1 : 0);
