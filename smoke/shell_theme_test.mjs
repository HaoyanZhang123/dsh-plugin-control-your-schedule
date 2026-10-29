#!/usr/bin/env node
/**
 * Shell theme gate for dsh-plugin-control-your-schedule.
 *
 * The panel enters through an iframe that does not exist yet when the panel
 * paints, so the shell itself must contribute no colour: no warm paper
 * constants, no opaque mask, no offset frame. The page then hides its own
 * content until body.os-ready, which means a correct <html data-theme> in the
 * srcdoc is enough to prevent a white/dark flash.
 *
 * The colour audit parses every rule in the shell sheet and only accepts
 * transparent / var(--dsw-*) / inherit / currentColor / none / 0 for
 * background*, border* and color (a border shorthand may also carry its width
 * and style). Literal colours fail by name, and a warm paper tint is rejected
 * in hex and rgb(a) form as well, var() fallbacks included.
 *
 * Everything is read from source: the CSS is extracted from src/client.src.js
 * and the page from assets/paper-os.html. The built client.js is never used
 * here (it is a generated artifact and may be stale while the page is edited).
 *
 * Usage:
 *   node smoke/shell_theme_test.mjs               # real files must be green
 *   node smoke/shell_theme_test.mjs --self-test   # known-bad inputs must go red
 *
 * Exit 0 only when every assertion passes. No third-party dependencies.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SELF_TEST = process.argv.includes('--self-test');

/* Two layouts must both work:
   - factory: <root>/plugin/{src,assets}/...
   - release repo: <root>/{src,assets}/... (the package is the repo root) */
const CLIENT_SRC = [
  join(ROOT, 'plugin', 'src', 'client.src.js'),
  join(ROOT, 'src', 'client.src.js'),
].find((candidate) => existsSync(candidate));
const PAGE = [
  join(ROOT, 'plugin', 'assets', 'paper-os.html'),
  join(ROOT, 'assets', 'paper-os.html'),
].find((candidate) => existsSync(candidate));

/* The warm paper palette this gate exists to keep out of the shell. */
const WARM = ['#f1e7d4', '#f2ead9', '#f4ecdd', 'rgba(155,83,58', '#fbf4e6', '#8b816d', '#9b533a', '#fffaf1'];

function fail(message) {
  console.log('FAIL | ' + message);
  console.log('checks: PASS 0 / FAIL 1 / SKIP 0');
  process.exit(1);
}

if (!CLIENT_SRC) fail('client source not found | looked for plugin/src and src/client.src.js');
if (!PAGE) fail('page not found | looked for plugin/assets and assets/paper-os.html');

const baseSrc = readFileSync(CLIENT_SRC, 'utf8');
const pageSource = readFileSync(PAGE, 'utf8');

/* ---------- extraction ---------- */

function sliceBetween(text, begin, end) {
  const start = text.indexOf(begin);
  if (start === -1) return '';
  const stop = text.indexOf(end, start);
  if (stop === -1) return '';
  return text.slice(start, stop + end.length);
}

function extractCss(src) {
  const marker = 'var CSS = [';
  const start = src.indexOf(marker);
  if (start === -1) throw new Error('var CSS = [ not found in client.src.js');
  const end = src.indexOf("].join('')", start);
  if (end === -1) throw new Error('].join("") not found after var CSS = [');
  const literal = src.slice(start + marker.length - 1, end + 1);
  const parts = new Function('return ' + literal)();
  if (!Array.isArray(parts)) throw new Error('CSS is not an array literal');
  return parts.join('');
}

function extractShellBlock(src) {
  const block = sliceBetween(src, '/* @shell-theme-begin */', '/* @shell-theme-end */');
  if (!block) throw new Error('@shell-theme-begin/@shell-theme-end markers not found in client.src.js');
  return block;
}

function ruleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(escaped + '\\s*\\{').exec(css);
  if (!match) return '';
  const start = match.index + match[0].length;
  const end = css.indexOf('}', start);
  if (end === -1) return '';
  return css.slice(start, end);
}

function functionBody(src, signature) {
  const start = src.indexOf(signature);
  if (start === -1) return '';
  const open = src.indexOf('{', start);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return '';
}

/* ---------- sandboxed embed ---------- */

function hostEnv(options) {
  const opts = options || {};
  const platform = opts.platform === undefined ? 'win32' : opts.platform;
  const dark = !!opts.dark;
  const clearance = opts.clearance === undefined ? '48px' : opts.clearance;
  const document = {
    documentElement: { getAttribute: (name) => (name === 'data-platform' ? platform : null) },
    body: { hasAttribute: (name) => name === 'data-ds-dark-theme' && dark },
  };
  const getComputedStyle = () => ({
    getPropertyValue: (name) => (name === '--dsh-frame-top-clearance' ? clearance : ''),
  });
  return { document, getComputedStyle };
}

function buildWorld(src, page) {
  const block = extractShellBlock(src);
  const factory = new Function(
    'basePage',
    'document',
    'getComputedStyle',
    block + '\nreturn { embed: embed, firstFrameTheme: firstFrameTheme, hostTopClearance: hostTopClearance, firstFramePage: firstFramePage };'
  );
  return {
    src,
    css: extractCss(src),
    page,
    embed: (env) => factory(() => page, env.document, env.getComputedStyle).embed,
  };
}

/* 夹具故意保留 version: 3（0.5.0 的 schemaVersion 是 4）：它顺带就是一份
   「v3 快照仍能被宿主读取」的活样本。本套件断言的是 prefs 解析，不是版本号。 */
function snapshotWith(prefs, extra) {
  return Object.assign({ format: 'paper-os/workspace', version: 3, prefs: Object.assign({}, prefs), meta: { updatedAt: 1 } }, extra || {});
}

/* ---------- CSS declarations: the colour whitelist below ---------- */

/* Only these properties can carry a colour. border-radius / border-width /
   border-style never do, so they stay out of the audit. */
const COLOUR_PROP = /^(?:background(?:-color)?|color|border(?:-(?:top|right|bottom|left))?(?:-color)?)$/;

const COLOUR_KEYWORDS = ['transparent', 'inherit', 'currentcolor', 'none', '0'];
const BORDER_STYLE = ['solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset', 'hidden'];

/* Split a rule body into declarations, ignoring ';' inside url()/var() parens. */
function splitDeclarations(body) {
  const chunks = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) {
      chunks.push(body.slice(start, i));
      start = i + 1;
    }
  }
  chunks.push(body.slice(start));
  const out = [];
  for (const chunk of chunks) {
    const text = chunk.trim();
    if (!text) continue;
    const at = text.indexOf(':');
    if (at === -1) continue;
    out.push({ prop: text.slice(0, at).trim().toLowerCase(), value: text.slice(at + 1).trim() });
  }
  return out;
}

/* Every rule in the sheet, at-rules included (their inner blocks are recursed). */
function parseRules(css) {
  const rules = [];
  function collect(text, prefix) {
    let depth = 0;
    let selectorStart = 0;
    let bodyStart = -1;
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === '{') {
        if (depth === 0) bodyStart = i + 1;
        depth += 1;
      } else if (text[i] === '}') {
        depth -= 1;
        if (depth === 0 && bodyStart !== -1) {
          const selector = text.slice(selectorStart, bodyStart - 1).trim();
          const body = text.slice(bodyStart, i);
          if (body.indexOf('{') !== -1) collect(body, prefix + selector + ' ');
          else rules.push({ selector: (prefix + selector).trim(), declarations: splitDeclarations(body) });
          selectorStart = i + 1;
          bodyStart = -1;
        }
      }
    }
  }
  collect(css, '');
  return rules;
}

/* Whitespace-separated tokens, parens kept together. */
function tokensOf(value) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && /\s/.test(ch)) {
      if (i > start) out.push(value.slice(start, i));
      start = i + 1;
    }
  }
  if (value.length > start) out.push(value.slice(start));
  return out.map((token) => token.trim()).filter(Boolean);
}

function isHostToken(token) {
  return /^var\(\s*--dsw-[a-z0-9-]+\s*(?:,[\s\S]*)?\)$/i.test(token);
}

function isLength(token) {
  return /^(?:0|-?\d*\.?\d+(?:px|em|rem|%|vh|vw|ch|ex|pt))$/.test(token);
}

/* transparent / var(--dsw-*) / inherit / currentColor / none / 0, per property.
   A border shorthand may also carry its width and style keywords. */
function declarationIsTokenDriven(prop, value) {
  const tokens = tokensOf(value);
  if (!tokens.length) return false;
  if (prop.indexOf('border') === 0) {
    return tokens.every((token) => {
      const lower = token.toLowerCase();
      return isHostToken(token)
        || COLOUR_KEYWORDS.indexOf(lower) !== -1
        || isLength(token)
        || BORDER_STYLE.indexOf(lower) !== -1;
    });
  }
  if (tokens.length !== 1) return false;
  const lower = tokens[0].toLowerCase();
  return COLOUR_KEYWORDS.indexOf(lower) !== -1 || isHostToken(tokens[0]);
}

/* Literal colours in hex or rgb(a) form, inside var() fallbacks too. */
function colourLiterals(value) {
  const out = [];
  const hex = /#([0-9a-fA-F]{3,8})\b/g;
  let match;
  while ((match = hex.exec(value)) !== null) {
    let digits = match[1];
    if (digits.length === 3) digits = digits[0] + digits[0] + digits[1] + digits[1] + digits[2] + digits[2];
    if (digits.length >= 6) {
      out.push({
        text: match[0],
        r: parseInt(digits.slice(0, 2), 16),
        g: parseInt(digits.slice(2, 4), 16),
        b: parseInt(digits.slice(4, 6), 16),
      });
    }
  }
  const rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g;
  while ((match = rgb.exec(value)) !== null) {
    out.push({ text: match[0], r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) });
  }
  return out;
}

/* The flash colour family: a light, low-chroma warm tint (r >= g >= b). This is
   how rgba(241, 231, 212, .94) is caught without listing it by hand. */
function isWarmPaperTint(colour) {
  const max = Math.max(colour.r, colour.g, colour.b);
  const min = Math.min(colour.r, colour.g, colour.b);
  return max - min <= 48 && min >= 150 && colour.r - colour.b >= 10 && colour.r >= colour.g && colour.g >= colour.b;
}

/* ---------- checks ---------- */

const checks = [];
function check(name, run) { checks.push({ name, run }); }

check('shell CSS carries no warm paper constants', (w) => {
  const hits = WARM.filter((needle) => w.css.indexOf(needle) !== -1);
  return {
    pass: hits.length === 0,
    detail: hits.length ? 'still present: ' + hits.join(', ') : 'none of ' + WARM.length + ' warm constants in ' + w.css.length + ' chars of shell CSS',
  };
});

check('panel and frame paint transparent', (w) => {
  const problems = [];
  const panel = ruleBody(w.css, '.cys-panel');
  const frame = ruleBody(w.css, '.cys-frame');
  if (!panel) problems.push('.cys-panel rule missing');
  else if (!/background:\s*transparent/.test(panel)) problems.push('.cys-panel background is not transparent');
  if (!frame) problems.push('.cys-frame rule missing');
  else {
    if (!/background:\s*transparent/.test(frame)) problems.push('.cys-frame background is not transparent');
    if (!/inset:\s*0/.test(frame)) problems.push('.cys-frame is not inset:0');
  }
  return { pass: problems.length === 0, detail: problems.join('; ') || 'both transparent, frame inset:0' };
});

check('the frame does not consume the macOS clearance', (w) => {
  const problems = [];
  if (w.css.indexOf('--dsh-frame-top-clearance') !== -1) {
    problems.push('the iframe CSS still reads --dsh-frame-top-clearance; the page must paint that strip');
  }
  if (/html\[data-platform="darwin"\]/.test(w.css)) problems.push('a darwin html[...] shell rule is back');
  return { pass: problems.length === 0, detail: problems.join('; ') || 'clearance only travels into the page' };
});

check('every rule is parsed and its colour declarations are collected', (w) => {
  const rules = parseRules(w.css);
  const control = ['.cys-panel', '.cys-frame', '.cys-loading', '.cys-btn', '.cys-host-note', '.cys-prompt-pop'];
  const missing = control.filter((selector) => !rules.some((rule) => rule.selector === selector));
  const checked = rules.reduce((sum, rule) => sum + rule.declarations.filter((decl) => COLOUR_PROP.test(decl.prop)).length, 0);
  const problems = [];
  if (missing.length) problems.push('rule not parsed: ' + missing.join(', '));
  if (checked === 0) problems.push('no background/border/color declaration was collected');
  return { pass: problems.length === 0, detail: problems.join('; ') || rules.length + ' rules, ' + checked + ' colour declarations audited' };
});

check('every background/border/color declaration is a host token', (w) => {
  const offences = [];
  for (const rule of parseRules(w.css)) {
    for (const decl of rule.declarations) {
      if (!COLOUR_PROP.test(decl.prop)) continue;
      if (!declarationIsTokenDriven(decl.prop, decl.value)) {
        offences.push(rule.selector + ' { ' + decl.prop + ': ' + decl.value + ' }');
      }
    }
  }
  const detail = offences.length
    ? offences.length + ' hard-coded: ' + offences.slice(0, 4).join(' | ')
    : 'every colour is transparent / var(--dsw-*) / inherit / currentColor / none / 0';
  return { pass: offences.length === 0, detail };
});

check('no warm paper tint in any colour notation', (w) => {
  const offences = [];
  for (const rule of parseRules(w.css)) {
    for (const decl of rule.declarations) {
      if (!COLOUR_PROP.test(decl.prop)) continue;
      for (const literal of colourLiterals(decl.value)) {
        if (isWarmPaperTint(literal)) offences.push(rule.selector + ' { ' + decl.prop + ': ' + literal.text + ' }');
      }
    }
  }
  const detail = offences.length
    ? 'warm tint: ' + offences.slice(0, 4).join(' | ')
    : 'no light warm tint in any hex/rgb(a) value, var() fallbacks included';
  return { pass: offences.length === 0, detail };
});

check('loading mask waits 300ms and yields to ready', (w) => {
  const problems = [];
  const start = w.src.indexOf('bridge.maskTimer = setTimeout');
  const snippet = start === -1 ? '' : w.src.slice(start, start + 420);
  if (!snippet) problems.push('no delayed mask timer');
  else if (!/setMaskVisible\(true\);[\s\S]*?\}, 300\);/.test(snippet)) problems.push('mask timer is not a 300ms delay');
  if (w.src.indexOf("status === 'loading' && maskVisible") === -1) problems.push('mask render is not gated on maskVisible');
  if (w.src.indexOf("if (next !== 'loading' && bridge.maskTimer)") === -1) problems.push('ready does not cancel a pending mask');
  if (w.src.indexOf('setMaskVisible(false)') === -1) problems.push('mask is never hidden again');
  return { pass: problems.length === 0, detail: problems.join('; ') || 'mask only after 300ms, cleared on ready' };
});

check('workspace reads go through one cache and start-up prefetch', (w) => {
  const problems = [];
  const gets = (w.src.match(/hostFetch\('GET'\)/g) || []).length;
  if (gets !== 1) problems.push('hostFetch GET call sites: ' + gets + ' (expected exactly 1, inside loadWorkspace)');
  if (w.src.indexOf('function loadWorkspace(options)') === -1) problems.push('loadWorkspace is missing');
  if (!/ctx\.effect\(function \(\) \{\s*loadWorkspace\(\)/.test(w.src)) problems.push('no start-up prefetch effect');
  const panel = functionBody(w.src, 'function PaperPanel()');
  if (!panel) problems.push('PaperPanel not found');
  else if (panel.indexOf('loadWorkspace()') === -1) problems.push('PaperPanel does not read the cached workspace');
  const prompts = functionBody(w.src, 'function loadPrompts(options)');
  if (!prompts) problems.push('loadPrompts not found');
  else if (prompts.indexOf('loadWorkspace(options)') === -1) problems.push('loadPrompts does not share the cache');
  if (w.src.indexOf('invalidateWorkspace();') === -1) problems.push('no landed write invalidates the cache');
  return { pass: problems.length === 0, detail: problems.join('; ') || 'one GET, prefetched, invalidated on write' };
});

check('first frame theme: snapshot prefs win, the host decides otherwise', (w) => {
  const problems = [];
  /* The page's own CSS carries html[data-theme=...] selectors and the page now
     declares --cys-top-clearance itself, so every assertion below is scoped to
     the single <html ...> opening tag the shell rewrites. */
  const htmlTag = (html) => (html.match(/<html\b[^>]*>/i) || [''])[0];
  const themeOf = (env, snapshot) => {
    const found = /data-theme="([a-z]+)"/.exec(htmlTag(w.embed(env)(snapshot, true)));
    return found ? found[1] : '(missing)';
  };
  const cases = [
    ['prefs.theme=dark over a light host', { dark: false }, snapshotWith({ theme: 'dark' }), 'dark'],
    ['prefs.theme=light over a dark host', { dark: true }, snapshotWith({ theme: 'light' }), 'light'],
    ['theme=system follows a dark host', { dark: true }, snapshotWith({ theme: 'system' }), 'dark'],
    ['theme=system follows a light host', { dark: false }, snapshotWith({ theme: 'system' }), 'light'],
    ['no snapshot follows a dark host', { dark: true }, null, 'dark'],
    ['no snapshot follows a light host', { dark: false }, null, 'light'],
    ['theme missing follows a dark host', { dark: true }, snapshotWith({}), 'dark'],
  ];
  for (const [label, env, snapshot, expected] of cases) {
    const got = themeOf(hostEnv(env), snapshot);
    if (got !== expected) problems.push(label + ': expected data-theme=' + expected + ', got ' + got);
  }
  const darkHtml = w.embed(hostEnv({ dark: false }))(snapshotWith({ theme: 'dark' }), true);
  const darkTag = htmlTag(darkHtml);
  if ((darkTag.match(/data-theme=/g) || []).length !== 1) problems.push('the html tag carries more than one data-theme');
  if (!/<html lang="zh-CN"[^>]*data-motion="system"[^>]*data-hand="kai"/.test(darkTag)) {
    problems.push('existing html attributes (lang/data-motion/data-hand) were dropped');
  }
  const strip = (html) => html
    .replace(/<html\b[^>]*>/i, '<html>')
    .replace(/<script>window\.__SCHEDULE_HOST_MODE__=[\s\S]*?<\/script>/, '');
  if (strip(darkHtml) !== strip(w.page)) problems.push('embed changed something other than the html tag');
  return { pass: problems.length === 0, detail: problems.join('; ') || 'prefs -> host -> light, nothing else touched' };
});

check('darwin clearance reaches the page as --cys-top-clearance', (w) => {
  const problems = [];
  const tagOf = (env) => {
    const html = w.embed(hostEnv(env))(snapshotWith({ theme: 'light' }), true);
    return (html.match(/<html\b[^>]*>/i) || [''])[0];
  };
  const darwinTag = tagOf({ platform: 'darwin', clearance: '48px' });
  if (!/style="--cys-top-clearance:48px"/.test(darwinTag)) problems.push('darwin 48px not written into the page html tag');
  if (!/data-theme="light"/.test(darwinTag)) problems.push('writing the clearance dropped data-theme');
  /* The page declares its own 0px default; what must never happen is the shell
     writing a clearance the host did not publish (or publishing it off darwin). */
  const forbidden = [
    ['non-darwin host', { platform: 'win32', clearance: '48px' }],
    ['absent host value', { platform: 'darwin', clearance: '' }],
    ['non-px host value', { platform: 'darwin', clearance: 'auto' }],
  ];
  for (const [label, env] of forbidden) {
    if (tagOf(env).indexOf('--cys-top-clearance') !== -1) problems.push(label + ': the shell wrote a clearance it should not have');
  }
  return { pass: problems.length === 0, detail: problems.join('; ') || 'darwin px only, dropped when absent' };
});

check('embed keeps the host boot payload in front of the page script', (w) => {
  const problems = [];
  const out = w.embed(hostEnv({}))(snapshotWith({ theme: 'dark' }), true);
  const bootAt = out.indexOf('<script>window.__SCHEDULE_HOST_MODE__=true;window.__SCHEDULE_HOST_SNAPSHOT__=');
  if (bootAt === -1) problems.push('host mode/snapshot payload missing');
  else if (bootAt !== out.indexOf('<script>')) problems.push('the boot payload is not the first script in the page');
  const nasty = snapshotWith({}, { prompts: [{ id: 'p1', body: '</script><b>x</b>' }] });
  if (w.embed(hostEnv({}))(nasty, true).indexOf('\\u003c/script>') === -1) {
    problems.push('snapshot serialisation no longer escapes <');
  }
  return { pass: problems.length === 0, detail: problems.join('; ') || 'payload first, snapshot escaped' };
});

check('page hides its content until os-ready (theme-only first frame is enough)', (w) => {
  const problems = [];
  if (w.page.indexOf('body.os-ready .os') === -1) problems.push('body.os-ready .os rule missing');
  const osBody = ruleBody(w.page, '.os');
  if (!osBody) problems.push('.os rule not found');
  else if (!/opacity:\s*0/.test(osBody)) problems.push('.os is not hidden before os-ready');
  if ((w.page.match(/<html\b/g) || []).length !== 1) problems.push('the page must carry exactly one <html> tag');
  return { pass: problems.length === 0, detail: problems.join('; ') || 'content hidden until os-ready, one html tag' };
});

function runAll(world) {
  const results = [];
  for (const item of checks) {
    let result;
    try {
      result = item.run(world);
    } catch (error) {
      result = { pass: false, detail: 'threw: ' + String(error && error.message ? error.message : error) };
    }
    results.push({ name: item.name, pass: !!result.pass, detail: result.detail || '' });
  }
  return results;
}

function report(results, label) {
  let passed = 0;
  let failed = 0;
  for (const result of results) {
    if (result.pass) {
      passed += 1;
      console.log('PASS | ' + result.name + ' | ' + result.detail);
    } else {
      failed += 1;
      console.log('FAIL | ' + result.name + ' | ' + result.detail);
    }
  }
  console.log(label + ': PASS ' + passed + ' / FAIL ' + failed + ' / SKIP 0');
  return failed;
}

/* ---------- known-bad inputs (--self-test) ---------- */

const mutations = [
  {
    id: 'warm panel background',
    mutate: (src) => src.replace(/(\.cys-panel\{[^}]*?)background:transparent/, '$1background:#f4ecdd'),
    expect: ['shell CSS carries no warm paper constants', 'panel and frame paint transparent'],
  },
  {
    id: 'darwin frame offset rule',
    mutate: (src) => src.replace(
      'var CSS = [',
      'var CSS = [\n      \'html[data-platform="darwin"] .cys-frame{top:var(--dsh-frame-top-clearance,48px);height:calc(100% - var(--dsh-frame-top-clearance,48px));}\','
    ),
    expect: ['the frame does not consume the macOS clearance'],
  },
  {
    id: 'opaque loading background',
    mutate: (src) => src.replace(/(\.cys-loading\{[^}]*?)background:var\(--dsw-alias-bg-base,transparent\)/, '$1background:#f4ecdd'),
    expect: [
      'every background/border/color declaration is a host token',
      'shell CSS carries no warm paper constants',
      'no warm paper tint in any colour notation',
    ],
  },
  {
    id: 'warm rgba background on the panel',
    mutate: (src) => src.replace(/(\.cys-panel\{[^}]*?)background:transparent/, '$1background:rgba(241,231,212,.94)'),
    expect: [
      'every background/border/color declaration is a host token',
      'no warm paper tint in any colour notation',
    ],
  },
  {
    id: 'a second .cys-panel rule appended with warm rgba',
    mutate: (src) => src.replace("var CSS = [", "var CSS = [\n      '.cys-panel{position:relative;background:rgba(241,231,212,.94);}',"),
    expect: [
      'every background/border/color declaration is a host token',
      'no warm paper tint in any colour notation',
    ],
  },
  {
    id: 'warm rgba hidden in a var() fallback',
    mutate: (src) => src.replace(
      'background:var(--dsw-alias-bg-base,transparent)',
      'background:var(--dsw-alias-bg-base,rgba(241,231,212,.94))'
    ),
    expect: ['no warm paper tint in any colour notation'],
  },
  {
    id: 'named colour on the frame',
    mutate: (src) => src.replace(/(\.cys-frame\{[^}]*?)background:transparent/, '$1background:beige'),
    expect: ['every background/border/color declaration is a host token'],
  },
  {
    id: 'mask shown immediately',
    mutate: (src) => src.replace('}, 300);', '}, 0);'),
    expect: ['loading mask waits 300ms and yields to ready'],
  },
  {
    id: 'no start-up prefetch',
    mutate: (src) => src.replace(/loadWorkspace\(\)\.catch\(function \(\) \{[^}]*\}\);/, 'void 0;'),
    expect: ['workspace reads go through one cache and start-up prefetch'],
  },
  {
    id: 'panel fetches the workspace itself',
    mutate: (src) => src.replace('loadWorkspace().then(function (data) {', "hostFetch('GET').then(function (data) {"),
    expect: ['workspace reads go through one cache and start-up prefetch'],
  },
  {
    id: 'embed ignores the theme',
    mutate: (src) => src.replace(
      'firstFramePage(basePage(lang), firstFrameTheme(snapshot), hostTopClearance())',
      "firstFramePage(basePage(lang), 'light', hostTopClearance())"
    ),
    expect: ['first frame theme: snapshot prefs win, the host decides otherwise'],
  },
  {
    id: 'embed ignores the clearance',
    mutate: (src) => src.replace(
      'firstFramePage(basePage(lang), firstFrameTheme(snapshot), hostTopClearance())',
      "firstFramePage(basePage(lang), firstFrameTheme(snapshot), '')"
    ),
    expect: ['darwin clearance reaches the page as --cys-top-clearance'],
  },
  {
    id: 'prefs no longer override the host theme',
    mutate: (src) => src.replace("if (wanted === 'light' || wanted === 'dark') return wanted;", 'if (wanted && false) return wanted;'),
    expect: ['first frame theme: snapshot prefs win, the host decides otherwise'],
  },
];

/* ---------- main ---------- */

let world;
try {
  world = buildWorld(baseSrc, pageSource);
} catch (error) {
  fail('shell block/CSS extraction: ' + String(error && error.message ? error.message : error));
}

const baseResults = runAll(world);
let failed = report(baseResults, 'checks');

if (!SELF_TEST) {
  process.exit(failed === 0 ? 0 : 1);
}

/* Self-audit: every known-bad input must actually turn its check red, and the
   mutation must really have applied, otherwise "green" proves nothing. */
let selfFailed = failed;
let rejected = 0;
for (const mutation of mutations) {
  const mutated = mutation.mutate(baseSrc);
  if (mutated === baseSrc) {
    selfFailed += 1;
    console.log('FAIL | self-test | mutation did not apply: ' + mutation.id);
    continue;
  }
  let mutatedWorld;
  try {
    mutatedWorld = buildWorld(mutated, pageSource);
  } catch (error) {
    selfFailed += 1;
    console.log('FAIL | self-test | mutated source no longer parses (' + mutation.id + '): ' + String(error && error.message ? error.message : error));
    continue;
  }
  const mutatedResults = runAll(mutatedWorld);
  for (const expected of mutation.expect) {
    const found = mutatedResults.find((item) => item.name === expected);
    if (!found) {
      selfFailed += 1;
      console.log('FAIL | self-test | unknown check name: ' + expected);
    } else if (found.pass) {
      selfFailed += 1;
      console.log('FAIL | self-test | check stayed green on known-bad input: ' + expected + ' (' + mutation.id + ')');
    } else {
      rejected += 1;
      console.log('RED | ' + expected + ' | rejected ' + mutation.id + ' | ' + found.detail);
    }
  }
}
console.log('self-test: mutations ' + mutations.length + ' / rejected ' + rejected + ' / FAIL ' + selfFailed);
process.exit(selfFailed === 0 ? 0 : 1);
