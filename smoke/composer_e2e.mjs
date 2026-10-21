#!/usr/bin/env node
/**
 * Real-machine check for the composer entry (opt-in: needs a running DSH web
 * with a token, because the entry only exists inside the host page).
 *
 *   DSH_BASE=http://127.0.0.1:37157 DSH_WEB_TOKEN=... node smoke/composer_e2e.mjs
 *
 * Exit 0 only when every assertion passes. No token => explicit SKIP (exit 3),
 * which the gate runner counts separately and never as a pass.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.env.DSH_BASE || '';
const TOKEN = process.env.DSH_WEB_TOKEN || '';
if (!BASE || !TOKEN) {
  console.log('SKIP | composer entry | 需要 DSH_BASE + DSH_WEB_TOKEN（真机 DSH）');
  process.exit(3);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', '..', 'output', '_probe', 'cys-composer');
mkdirSync(OUT, { recursive: true });
const PORT = 9537;
const PROFILE = join(OUT, 'profile');
rmSync(PROFILE, { recursive: true, force: true });

const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const BROWSER = CANDIDATES.find((p) => existsSync(p));
if (!BROWSER) {
  console.log('SKIP | composer entry | 没有可用的无头浏览器');
  process.exit(3);
}

const checks = [];
const ok = (name, detail = '') => { checks.push([true, name]); console.log('PASS | ' + name + (detail ? ' | ' + detail : '')); };
const bad = (name, detail = '') => { checks.push([false, name]); console.log('FAIL | ' + name + ' | ' + detail); };

const proc = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE, 'about:blank',
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
if (!wsUrl) { console.log('FAIL | could not attach to the browser'); proc.kill(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
const pageErrors = [];
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') {
    const d = message.params.exceptionDetails;
    pageErrors.push((d.exception && d.exception.description) || d.text);
  }
  if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
};
const send = (method, params) => new Promise((res) => {
  const current = ++id;
  pending.set(current, res);
  ws.send(JSON.stringify({ id: current, method, params: params || {} }));
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

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: BASE + '/?token=' + encodeURIComponent(TOKEN) });
await sleep(6000);

const entry = await run(function () {
  var buttons = Array.prototype.slice.call(document.querySelectorAll('button'));
  var entry = buttons.filter(function (b) { return (b.getAttribute('aria-haspopup') === 'dialog') && /提示词/.test(b.textContent || ''); })[0];
  return {
    found: !!entry,
    label: entry ? (entry.textContent || '').trim() : '',
    expanded: entry ? entry.getAttribute('aria-expanded') : null,
  };
});
if (entry && entry.found) ok('composer shows the prompt entry', entry.label);
else bad('composer shows the prompt entry', JSON.stringify(entry));

let opened = null;
if (entry && entry.found) {
  opened = await run(function () {
    var buttons = Array.prototype.slice.call(document.querySelectorAll('button'));
    var entry = buttons.filter(function (b) { return (b.getAttribute('aria-haspopup') === 'dialog') && /提示词/.test(b.textContent || ''); })[0];
    entry.click();
    var dialog = document.querySelector('[role="dialog"][aria-label="提示词"]');
    return {
      open: !!dialog,
      items: dialog ? dialog.querySelectorAll('[role="option"]').length : 0,
      hint: dialog ? (dialog.textContent || '').slice(0, 80) : '',
    };
  });
  if (opened && opened.open) ok('the prompt panel opens', 'items=' + opened.items);
  else bad('the prompt panel opens', JSON.stringify(opened));
}

if (opened && opened.open && opened.items > 0) {
  const filled = await run(function () {
    var dialog = document.querySelector('[role="dialog"][aria-label="提示词"]');
    var option = dialog.querySelector('[role="option"]');
    var body = option ? option.querySelector('.cys-prompt-pop__body') : null;
    var expected = body ? body.textContent : '';
    option.click();
    var editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
    return {
      expected: expected.slice(0, 40),
      draft: editor ? (editor.innerText || '').slice(0, 200) : null,
      stillOpen: !!document.querySelector('[role="dialog"][aria-label="提示词"]'),
    };
  });
  if (filled && filled.draft && filled.expected && filled.draft.indexOf(filled.expected.slice(0, 20)) !== -1) ok('picking a prompt fills the draft', JSON.stringify({ expected: filled.expected }));
  else bad('picking a prompt fills the draft', JSON.stringify(filled));
  if (filled && filled.stillOpen === false) ok('the panel closes after filling');
  else bad('the panel closes after filling', JSON.stringify(filled && filled.stillOpen));
}

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result && shot.result.data) {
  writeFileSync(join(OUT, 'composer-entry.png'), Buffer.from(shot.result.data, 'base64'));
  console.log('SHOT ' + join(OUT, 'composer-entry.png'));
}

if (!pageErrors.length) ok('no page exceptions');
else bad('no page exceptions', pageErrors.slice(0, 3).join(' | '));

const failed = checks.filter((c) => !c[0]);
console.log('checks: PASS ' + (checks.length - failed.length) + ' / FAIL ' + failed.length);
ws.close();
proc.kill();
process.exit(failed.length ? 1 : 0);
