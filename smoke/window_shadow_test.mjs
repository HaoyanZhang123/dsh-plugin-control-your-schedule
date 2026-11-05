#!/usr/bin/env node
/**
 * Window-shadow gate (0.6.2).
 *
 * The defect it pins: every window painted its own large soft drop shadow, so N
 * overlapping windows stacked N shadows onto the same desk pixels. Measured at
 * 2px outside the window edge (0..255 luminance):
 *
 *   windows        1     2     3     4     5     6      (classic)
 *   darkening     16    25    33    40    47    54
 *   windows        1                                6   (modern)
 *   darkening     13                                64
 *
 * The fix gives the shadow to the focused window only, so the darkening must stay
 * flat as windows are added (measured 11 / 13 after the fix).
 *
 * The gate renders the real page in a headless browser, stacks windows on one
 * identical rect (so the union never changes and only the number of shadow
 * painters grows), and measures the same two pixels.
 *
 * `--self-test` re-runs the measurement with the pre-fix shadow rules injected and
 * fails unless the gate really goes red: a gate that cannot fail is not a gate.
 *
 *   node smoke/window_shadow_test.mjs              # real check (needs a browser)
 *   node smoke/window_shadow_test.mjs --self-test  # real check + mutation proof
 *
 * No browser => explicit SKIP (exit 3), never counted as a pass.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PAGE = join(ROOT, 'plugin', 'assets', 'paper-os.html');
const SELF_TEST = process.argv.includes('--self-test');

const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const BROWSER = CANDIDATES.find((one) => existsSync(one));
if (!BROWSER) {
  console.log('SKIP | window shadow | 原因：没有可用的无头浏览器（Edge/Chrome）');
  process.exit(3);
}
if (!existsSync(PAGE)) {
  console.log('FAIL | window shadow | 原因：plugin/assets/paper-os.html 不存在');
  process.exit(1);
}

/* ---------- measurements and thresholds ----------
   DARK_DELTA_MAX: how much darker the edge may get when 5 more windows appear.
   The defect measured +38 (classic) / +51 (modern); the fix measures +0..2.
   6 keeps room for sub-pixel noise while staying an order of magnitude below the
   defect, so the gate cannot pass a partial regression.
   DARK_MIN: the focused window must still float; removing every shadow would pass
   the flatness check but lose the design, so this is checked too (fix measured
   10..13; a shadowless build measures 0..1). */
const DARK_DELTA_MAX = 6;
const DARK_MIN = 4;
const STACK = { left: 80, top: 90, width: 520, height: 380 };
const VIEWPORT = { width: 1440, height: 900, scale: 2 };
const EDGE_X = STACK.left + STACK.width + 2;
const EDGE_Y = STACK.top + Math.round(STACK.height / 2);
const FAR_X = 1300;
const SKINS = ['classic', 'modern'];

/* The pre-fix rules, verbatim: this is what the mutation test replays. */
const LEGACY_CSS = [
  '.window:not(.is-focused){box-shadow:0 1px 0 rgba(255,255,255,.7) inset,0 22px 50px -32px rgba(57,57,57,.36),0 3px 9px rgba(57,57,57,.05) !important;}',
  'html[data-skin="modern"] .window{box-shadow:0 28px 80px -42px rgba(49,51,76,.36),0 3px 12px rgba(30,32,40,.04) !important;}',
].join('\n');

const checks = [];
const ok = (name, detail = '') => { checks.push([true, name]); console.log('PASS | ' + name + (detail ? ' | ' + detail : '')); };
const bad = (name, detail = '') => { checks.push([false, name]); console.log('FAIL | ' + name + ' | ' + detail); };

/* ---------- PNG decode (8-bit RGB/RGBA), same minimal decoder the pixel gates use ---------- */
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
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
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

function luminance(image, cssX, cssY) {
  const x = Math.min(image.width - 1, Math.max(0, Math.round(cssX * VIEWPORT.scale)));
  const y = Math.min(image.height - 1, Math.max(0, Math.round(cssY * VIEWPORT.scale)));
  const at = (y * image.width + x) * 4;
  return 0.2126 * image.pixels[at] + 0.7152 * image.pixels[at + 1] + 0.0722 * image.pixels[at + 2];
}

/* ---------- the page under test: one copy per skin so prefs are baked in ---------- */
const WORK = join(tmpdir(), 'cys-window-shadow-' + process.pid);
mkdirSync(WORK, { recursive: true });
const PROFILE = join(WORK, 'profile');
rmSync(PROFILE, { recursive: true, force: true });

function pageFor(skin) {
  const snapshot = {
    format: 'paper-os/workspace',
    version: 4,
    nodes: [], stickies: [], tasks: [], prompts: [],
    prefs: { skin, theme: 'light', lang: 'zh', skinPromptSuppressed: true },
    meta: { updatedAt: Date.now(), skinPromptVersion: '0.6.1' },
  };
  const boot = '<' + 'script>window.__SCHEDULE_HOST_MODE__=true;window.__SCHEDULE_HOST_SNAPSHOT__='
    + JSON.stringify(snapshot).replace(/</g, '\\u003c') + ';window.__PAPER_LANG__="zh";<' + '/script>';
  const file = join(WORK, 'page-' + skin + '.html');
  writeFileSync(file, readFileSync(PAGE, 'utf8').replace('<script>', boot + '<script>'));
  return pathToFileURL(file).href;
}

const PORT = 9771;
const proc = spawn(BROWSER, [
  '--headless=new', '--no-first-run', '--hide-scrollbars',
  '--remote-debugging-port=' + String(PORT), '--user-data-dir=' + PROFILE, 'about:blank',
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
if (!wsUrl) {
  rmSync(WORK, { recursive: true, force: true });
  console.log('FAIL | window shadow | 原因：无法连接到无头浏览器');
  proc.kill();
  process.exit(1);
}

const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let messageId = 0;
const pending = new Map();
const pageErrors = [];
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails;
    pageErrors.push((details.exception && details.exception.description) || details.text);
  }
  if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
};
const send = (method, params) => new Promise((resolve) => {
  const current = ++messageId;
  pending.set(current, resolve);
  ws.send(JSON.stringify({ id: current, method, params: params || {} }));
});
const ev = async (expression) => {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.result && response.result.exceptionDetails) {
    const details = response.result.exceptionDetails;
    return { __err: (details.exception && details.exception.description) || details.text };
  }
  return response.result && response.result.result ? response.result.result.value : undefined;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: VIEWPORT.scale, mobile: false,
});

/* Stack `count` windows on exactly one rect: the union never changes, so any
   change in the outside pixels comes from the number of shadow painters. */
const STACK_JS = 'window.__stackWindows = function (count) {'
  + 'var P = window.PaperOS;'
  + 'var ids = ["stickies","notes","calendar","prompts","draw","settings"];'
  + 'for (var k = 0; k < count; k += 1) {'
  + '  try { P.wm.open(ids[k]); } catch (e) {}'
  + '  var all = document.querySelectorAll(".window");'
  + '  var el = all[all.length - 1];'
  + '  if (!el) continue;'
  + '  el.style.left = "' + STACK.left + 'px";'
  + '  el.style.top = "' + STACK.top + 'px";'
  + '  el.style.width = "' + STACK.width + 'px";'
  + '  el.style.height = "' + STACK.height + 'px";'
  + '  el.style.transform = "none";'
  + '}'
  + 'var nodes = document.querySelectorAll(".window");'
  + 'var outer = [];'
  + 'for (var j = 0; j < nodes.length; j += 1) {'
  + '  var cs = getComputedStyle(nodes[j]);'
  + '  var layers = cs.boxShadow === "none" ? [] : cs.boxShadow.split(/,(?![^(]*\\))/);'
  + '  var outerLayers = layers.filter(function (one) { return one.indexOf("inset") === -1; });'
  + '  outer.push({ focused: nodes[j].classList.contains("is-focused"), outerLayers: outerLayers.length });'
  + '}'
  + 'return { windows: nodes.length, layers: outer };'
  + '};';

async function measure(skin, count, legacyCss) {
  await send('Page.navigate', { url: pageFor(skin) + '?skin=' + skin + '&n=' + count + '&legacy=' + (legacyCss ? 1 : 0) });
  let ready = false;
  for (let i = 0; i < 80; i += 1) {
    await sleep(200);
    if (await ev('!!window.__PAPER_OS_READY__')) { ready = true; break; }
  }
  if (!ready) throw new Error('page never became ready (' + skin + ' / n=' + count + ')');
  await ev(STACK_JS);
  const state = await ev('window.__stackWindows(' + count + ')');
  if (legacyCss) {
    await ev('(function(){var t=document.createElement("style");t.id="legacy-shadow";t.textContent='
      + JSON.stringify(LEGACY_CSS) + ';document.head.appendChild(t);})()');
  }
  await sleep(650);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const image = decodePng(Buffer.from(shot.result.data, 'base64'));
  const edge = luminance(image, EDGE_X, EDGE_Y);
  const far = luminance(image, FAR_X, EDGE_Y);
  return { state, darkening: Math.round((far - edge) * 10) / 10, edge: Math.round(edge), far: Math.round(far) };
}

const results = {};
try {
  for (const skin of SKINS) {
    results[skin] = {};
    for (const count of [1, 6]) {
      results[skin][count] = await measure(skin, count, false);
      const row = results[skin][count];
      console.log('MEASURE | ' + skin + ' n=' + count + ' | edge=' + row.edge + ' far=' + row.far
        + ' darkening=' + row.darkening + ' windows=' + (row.state && row.state.windows));
    }
  }
  let restored = results;

  for (const skin of SKINS) {
    const one = results[skin][1];
    const six = results[skin][6];
    const delta = Math.round((six.darkening - one.darkening) * 10) / 10;
    if (delta <= DARK_DELTA_MAX) {
      ok(skin + ': the halo does not grow with the window count', 'n1=' + one.darkening + ' n6=' + six.darkening + ' delta=' + delta);
    } else {
      bad(skin + ': the halo does not grow with the window count', 'n1=' + one.darkening + ' n6=' + six.darkening + ' delta=' + delta);
    }
    if (one.darkening >= DARK_MIN) {
      ok(skin + ': the focused window still floats', 'darkening=' + one.darkening);
    } else {
      bad(skin + ': the focused window still floats', 'darkening=' + one.darkening + ' (every shadow was removed)');
    }
    const unfocused = (six.state && six.state.layers ? six.state.layers : []).filter((oneLayer) => !oneLayer.focused);
    const offenders = unfocused.filter((oneLayer) => oneLayer.outerLayers > 0);
    if (unfocused.length === 5 && offenders.length === 0) {
      ok(skin + ': unfocused windows paint no outer shadow', '5 unfocused windows, 0 outer layers');
    } else {
      bad(skin + ': unfocused windows paint no outer shadow',
        'unfocused=' + unfocused.length + ' with outer layers=' + offenders.length);
    }
  }

  if (SELF_TEST) {
    /* Replay the pre-fix CSS: the measurement must go red, otherwise the gate is
       blind and every green above is worthless. */
    const legacy = {};
    for (const skin of SKINS) {
      legacy[skin] = await measure(skin, 6, true);
      console.log('MUTATION | ' + skin + ' legacy shadow n=6 | darkening=' + legacy[skin].darkening);
    }
    for (const skin of SKINS) {
      const delta = Math.round((legacy[skin].darkening - results[skin][1].darkening) * 10) / 10;
      if (delta > DARK_DELTA_MAX) ok('self-test catches the pre-fix shadow (' + skin + ')', 'delta=' + delta);
      else bad('self-test catches the pre-fix shadow (' + skin + ')', 'delta=' + delta + ' did not exceed ' + DARK_DELTA_MAX);
    }
  }

  if (!pageErrors.length) ok('no page exceptions');
  else bad('no page exceptions', pageErrors.slice(0, 2).join(' | '));
} catch (error) {
  bad('window shadow measurement', String((error && error.message) || error));
} finally {
  ws.close();
  proc.kill();
  /* Windows keeps the profile directory locked until the browser process really
     exits; a cleanup failure must not turn a measured verdict into a crash. */
  await sleep(400);
  try {
    rmSync(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 });
  } catch (error) {
    console.log('NOTE | window shadow | 临时目录未清理干净（浏览器可能未退出）：' + String((error && error.message) || error));
  }
}

const failed = checks.filter((one) => !one[0]);
writeFileSync(join(HERE, '..', '..', '..', 'output', '_probe', 'window-shadow-last.json'),
  JSON.stringify({ checks: checks, results: results, selfTest: SELF_TEST }, null, 1));
console.log('checks: PASS ' + (checks.length - failed.length) + ' / FAIL ' + failed.length);
process.exit(failed.length ? 1 : 0);
