#!/usr/bin/env node
/**
 * Composer popup anchor gate (0.6.1).
 *
 * Two things are proved here, both without a real DSH:
 *
 * 1. Geometry: `promptPopoverBox` is extracted from
 *    plugin/src/client.src.js between its marker comments and run in plain Node,
 *    so the flip/clamp rules that decide where the popup lands are proven on the
 *    production function instead of a second copy.
 * 2. Containment: the popup must be portaled to <body>. DSH 0.2.2 gives the
 *    composer seat `will-change: transform` while a conversation is active,
 *    which makes that ancestor the containing block for `position: fixed`
 *    descendants; before 0.6.1 the popup was a child of the composer chip, so
 *    every viewport coordinate was added to the seat's origin and the panel
 *    landed near the bottom edge or off-screen.
 *
 * `--self-test` re-runs the same checks on deliberately broken sources and
 * fails unless each mutation is caught (a gate that cannot go red is not a gate).
 *
 * Exit 0 only when every assertion passes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SELF_TEST = process.argv.includes('--self-test');
const [SRC] = [
  join(ROOT, 'plugin', 'src', 'client.src.js'),
  join(ROOT, 'src', 'client.src.js'),
].filter((candidate) => existsSync(candidate));
if (!SRC) {
  console.log('FAIL | client source not found');
  process.exit(1);
}
const source = readFileSync(SRC, 'utf8');

const checks = [];
const ok = (name, detail = '') => { checks.push([true, name]); console.log('PASS | ' + name + (detail ? ' | ' + detail : '')); };
const bad = (name, detail = '') => { checks.push([false, name]); console.log('FAIL | ' + name + ' | ' + detail); };

function boxModel(text) {
  const begin = text.indexOf('/* @popover-box-begin */');
  const end = text.indexOf('/* @popover-box-end */');
  if (begin === -1 || end === -1) throw new Error('popover box markers missing in ' + SRC);
  const block = text.slice(begin, end);
  return new Function(block + '\nreturn promptPopoverBox;')();
}

/* ---------- 1. geometry ---------- */

const VIEWPORT = { width: 1440, height: 900 };
const PANEL = { width: 340, height: 320 };

function geometryResults(text) {
  const results = [];
  const add = (name, pass, detail) => results.push({ name, pass, detail });
  let box;
  try {
    box = boxModel(text);
  } catch (error) {
    add('popover box loads in Node', false, String(error && error.message));
    return results;
  }

  const above = box({ left: 300, top: 800, bottom: 824 }, PANEL, VIEWPORT, 8);
  add('hangs above the anchor when there is room',
    above.left === 300 && above.top === 472,
    JSON.stringify(above) + ' expected {"left":300,"top":472}');

  const below = box({ left: 300, top: 40, bottom: 64 }, PANEL, VIEWPORT, 8);
  add('flips below the anchor when the top is tight',
    below.top === 72 && below.left === 300,
    JSON.stringify(below) + ' expected {"left":300,"top":72}');

  const rightClamped = box({ left: 1300, top: 800, bottom: 824 }, PANEL, VIEWPORT, 8);
  add('clamps the right edge inside the viewport',
    rightClamped.left === VIEWPORT.width - 8 - PANEL.width,
    JSON.stringify(rightClamped) + ' expected left ' + String(VIEWPORT.width - 8 - PANEL.width));

  const leftClamped = box({ left: -40, top: 800, bottom: 824 }, PANEL, VIEWPORT, 8);
  add('clamps the left edge inside the viewport',
    leftClamped.left === 8,
    JSON.stringify(leftClamped) + ' expected left 8');

  const tall = box({ left: 100, top: 100, bottom: 124 }, { width: 340, height: 1200 }, VIEWPORT, 8);
  add('a panel taller than the viewport stays at the top margin',
    tall.top === 8,
    JSON.stringify(tall) + ' expected top 8');

  const fallback = box({ left: 1300, top: 800, bottom: 824 }, { width: 0, height: 0 }, VIEWPORT, 8);
  add('unknown panel size falls back to 320 and still clamps',
    fallback.left === VIEWPORT.width - 8 - 320,
    JSON.stringify(fallback) + ' expected left ' + String(VIEWPORT.width - 8 - 320));

  const fractional = box({ left: 300.6, top: 800.2, bottom: 824.9 }, { width: 340.4, height: 320.7 }, VIEWPORT, 8);
  add('the result is integer pixels',
    Number.isInteger(fractional.left) && Number.isInteger(fractional.top),
    JSON.stringify(fractional));

  return results;
}

for (const result of geometryResults(source)) {
  if (result.pass) ok(result.name, result.detail); else bad(result.name, result.detail);
}

/* ---------- 2. containment + skin scoping ---------- */

const staticResults = [];
const addStatic = (name, pass, detail) => staticResults.push({ name, pass, detail });

function staticChecks(text) {
  const results = [];
  const add = (name, pass, detail) => results.push({ name, pass, detail });
  add('the client requires react-dom',
    text.includes("require('react-dom')"),
    text.includes("require('react-dom')") ? 'require(\'react-dom\')' : 'require(\'react-dom\') missing');
  add('the popup is portaled to the document body',
    text.includes('ReactDOM.createPortal(panel, document.body)'),
    text.includes('ReactDOM.createPortal(panel, document.body)') ? 'createPortal(panel, document.body)' : 'the popup is still a child of the composer chip');
  const deadSelector = '.cys-prompt-root[data-cys-skin="modern"] .cys-prompt-pop{';
  add('the popup skin is no longer scoped through the composer root',
    !text.includes(deadSelector),
    text.includes(deadSelector) ? 'the ancestor-scoped popup selector is back' : 'data-cys-skin travels on the panel');
  add('the panel carries its own skin attribute',
    text.includes("'data-cys-skin': uiSkin,"),
    text.includes("'data-cys-skin': uiSkin,") ? 'panel[data-cys-skin]' : 'panel[data-cys-skin] missing');
  const resets = (text.match(/setPos\(null\)/g) || []).length;
  add('opening and closing both drop stale coordinates',
    resets >= 2,
    String(resets) + ' setPos(null) call(s), expected 2');
  return results;
}

for (const result of staticChecks(source)) {
  if (result.pass) ok(result.name, result.detail); else bad(result.name, result.detail);
}

/* ---------- 3. mutation self-test ---------- */

const MUTATIONS = [
  {
    label: 'right-edge clamp removed',
    check: 'clamps the right edge inside the viewport',
    apply: (text) => text.replace('if (left + width > viewport.width - m) left = viewport.width - m - width;', '/* mutated: no right clamp */;'),
    kind: 'geometry',
  },
  {
    label: 'flip removed (the popup always tries to sit above)',
    check: 'flips below the anchor when the top is tight',
    apply: (text) => text.replace('var top = above >= m ? above : anchor.bottom + m;', 'var top = above;'),
    kind: 'geometry',
  },
  {
    label: 'bottom clamp removed',
    check: 'a panel taller than the viewport stays at the top margin',
    apply: (text) => text.replace('if (top + height > viewport.height - m) top = viewport.height - m - height;', '/* mutated: no bottom clamp */;'),
    kind: 'geometry',
  },
  {
    label: 'popup rendered in the composer subtree again',
    check: 'the popup is portaled to the document body',
    apply: (text) => text.replace('ReactDOM.createPortal(panel, document.body)', 'panel'),
    kind: 'static',
  },
];

let mutationsCaught = 0;
if (!SELF_TEST) {
  console.log('NOTE | mutation self-test runs separately: node smoke/popover_anchor_test.mjs --self-test');
} else {
  for (const mutation of MUTATIONS) {
    const mutated = mutation.apply(source);
    if (mutated === source) {
      bad('self-test: ' + mutation.label + ' mutation applied', 'the mutation changed nothing (source drifted)');
      continue;
    }
    const results = mutation.kind === 'geometry' ? geometryResults(mutated) : staticChecks(mutated);
    const target = results.filter((result) => result.name === mutation.check)[0];
    if (target && target.pass === false) {
      mutationsCaught += 1;
      ok('self-test catches: ' + mutation.label, target.detail);
    } else if (!target) {
      bad('self-test catches: ' + mutation.label, 'the assertion named "' + mutation.check + '" disappeared');
    } else {
      bad('self-test catches: ' + mutation.label, 'the mutated source still passed "' + mutation.check + '"');
    }
  }
  if (mutationsCaught === MUTATIONS.length) ok('mutation self-test catches every planted defect', mutationsCaught + '/' + MUTATIONS.length);
  else bad('mutation self-test catches every planted defect', mutationsCaught + '/' + MUTATIONS.length);
}

const failed = checks.filter((check) => !check[0]);
console.log('checks: PASS ' + (checks.length - failed.length) + ' / FAIL ' + failed.length);
process.exit(failed.length ? 1 : 0);
