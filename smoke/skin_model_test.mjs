#!/usr/bin/env node
/**
 * Skin gate for dsh-plugin-control-your-schedule (0.6.0, wave K1).
 *
 * Two things are proven here, both read from source and never from a rebuilt
 * artifact:
 *
 * 1. The skin preference / upgrade-prompt model: the pure block between the
 *    @skin-model-begin and @skin-model-end marker comments in
 *    plugin/assets/paper-os.html, executed in plain Node. The functions the
 *    page runs are the ones under test -- this suite carries no second copy of
 *    the rules, so it cannot drift away from production.
 *
 * 2. The first frame: client.src.js must read snapshot.prefs.skin through the
 *    whitelist and put data-skin on the <html> tag of the srcdoc together with
 *    data-theme. Without it a modern workspace paints classic and then jumps.
 *
 * 3. The read-only seal (05 §6), source level only: the page must refuse to
 *    post a save and the shell must not queue one while the workspace is
 *    blocked. This proves the guards are wired, not AC-22: zero POST on a real
 *    host still needs the real bridge / CDP gate.
 *
 * Usage:
 *   node smoke/skin_model_test.mjs               # real files must be green
 *   node smoke/skin_model_test.mjs --self-test   # known-bad inputs must go red
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

function fail(message) {
  console.log('FAIL | ' + message);
  console.log('checks: PASS 0 / FAIL 1 / SKIP 0');
  process.exit(1);
}

if (!CLIENT_SRC) fail('client source not found | looked for plugin/src and src/client.src.js');
if (!PAGE) fail('page not found | looked for plugin/assets and assets/paper-os.html');

const clientSource = readFileSync(CLIENT_SRC, 'utf8');
const pageSource = readFileSync(PAGE, 'utf8');

/* ---------- markers and extraction ---------- */

const SKIN_BEGIN = '/* @skin-model-begin */';
const SKIN_END = '/* @skin-model-end */';
const SHELL_BEGIN = '/* @shell-theme-begin */';
const SHELL_END = '/* @shell-theme-end */';

function sliceBetween(text, begin, end) {
  const start = text.indexOf(begin);
  if (start === -1) return '';
  const stop = text.indexOf(end, start);
  if (stop === -1) return '';
  return text.slice(start + begin.length, stop);
}

/* The block declares these names itself; the return statement only hands the
   production functions to the harness. Nothing is re-implemented in the test. */
function loadSkinModel(block) {
  const handover = '\nreturn { SKIN_IDS: SKIN_IDS, SKIN_DEFAULT: SKIN_DEFAULT,'
    + ' SKIN_PROMPT_VERSION_MAX: SKIN_PROMPT_VERSION_MAX,'
    + ' normalizeSkin: normalizeSkin, normalizePromptVersion: normalizePromptVersion,'
    + ' parseVersion: parseVersion, compareVersions: compareVersions,'
    + ' decideSkinPrompt: decideSkinPrompt };';
  return new Function(block + handover)();
}

function buildWorld(client, page) {
  const shellBlock = sliceBetween(client, SHELL_BEGIN, SHELL_END);
  if (!shellBlock) {
    throw new Error('@shell-theme-begin/@shell-theme-end markers missing in ' + CLIENT_SRC);
  }
  /* typeof on an undeclared name is safe, so a missing firstFrameSkin is a named
     failure instead of a ReferenceError that hides the other assertions. */
  const factory = new Function(
    'basePage',
    'document',
    'getComputedStyle',
    shellBlock + '\nreturn { embed: embed,'
      + ' firstFrameSkin: typeof firstFrameSkin === "undefined" ? null : firstFrameSkin };'
  );
  const skinBlock = sliceBetween(page, SKIN_BEGIN, SKIN_END);
  let skin = null;
  let skinError = '';
  if (skinBlock) {
    try {
      skin = loadSkinModel(skinBlock);
    } catch (error) {
      skinError = String(error && error.message ? error.message : error);
    }
  }
  const make = (env) => factory(() => page, env.document, env.getComputedStyle);
  return {
    client,
    page,
    skinBlock,
    skin,
    skinError,
    make,
    embed: (env) => make(env).embed,
  };
}

/* ---------- fixtures ---------- */

/* Only prefs/meta are read on the first frame; the version number is filler. */
function snapshotWith(prefs, extra) {
  return Object.assign({
    format: 'paper-os/workspace',
    version: 4,
    prefs: Object.assign({}, prefs || {}),
    meta: { updatedAt: 1 },
  }, extra || {});
}

function hostEnv(options) {
  const opts = options || {};
  const dark = !!opts.dark;
  const document = {
    documentElement: { getAttribute: () => null },
    body: { hasAttribute: (name) => name === 'data-ds-dark-theme' && dark },
  };
  const getComputedStyle = () => ({ getPropertyValue: () => '' });
  return { document, getComputedStyle };
}

const htmlTag = (html) => (html.match(/<html\b[^>]*>/i) || [''])[0];

function attr(tag, name) {
  const found = new RegExp(name + '="([^"]*)"').exec(tag);
  return found ? found[1] : '(missing)';
}

function countOf(tag, needle) {
  return (tag.split(needle).length - 1);
}

/* ---------- assertion helpers ---------- */

function show(value) {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch (error) {
    return String(value);
  }
}

function sameJson(a, b) {
  return show(a) === show(b);
}

function verdict(problems, okDetail) {
  return { pass: problems.length === 0, detail: problems.length ? problems.join('; ') : okDetail };
}

function pushCase(problems, label, got, expected) {
  if (got !== expected) problems.push(label + ': got ' + show(got) + ', expected ' + show(expected));
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/* Every check is a named judgement over one world (a pair of sources). Naming
   them is what makes the reverse audit able to say which one caught the bug. */
const checks = [];
function check(name, run) {
  checks.push({ name, run });
}

function modelProblems(world) {
  if (world.skin) return [];
  if (!world.skinBlock) {
    return ['skin model block missing | expected @skin-model-begin / @skin-model-end in ' + PAGE];
  }
  return ['skin model block does not load in Node: ' + (world.skinError || 'unknown error')];
}

/* Runs the body only when the production model is really loaded. */
function withModel(world, body) {
  const problems = modelProblems(world);
  if (problems.length) return { pass: false, detail: problems.join('; ') };
  return body(world.skin);
}

function withShell(world, body) {
  try {
    return body(world);
  } catch (error) {
    return { pass: false, detail: 'shell block threw: ' + String(error && error.message ? error.message : error) };
  }
}

/* ---------- 1. frozen constants ---------- */

check('skin constants are frozen', (world) => withModel(world, (m) => {
  const problems = [];
  if (!sameJson(m.SKIN_IDS, ['classic', 'modern'])) {
    problems.push('SKIN_IDS=' + show(m.SKIN_IDS) + ' (expected ["classic","modern"])');
  }
  if (m.SKIN_DEFAULT !== 'classic') problems.push('SKIN_DEFAULT=' + show(m.SKIN_DEFAULT) + ' (expected "classic")');
  if (m.SKIN_PROMPT_VERSION_MAX !== 64) {
    problems.push('SKIN_PROMPT_VERSION_MAX=' + show(m.SKIN_PROMPT_VERSION_MAX) + ' (expected 64)');
  }
  ['normalizeSkin', 'normalizePromptVersion', 'parseVersion', 'compareVersions', 'decideSkinPrompt']
    .forEach((name) => {
      if (typeof m[name] !== 'function') problems.push(name + ' is not a function');
    });
  return verdict(problems, 'two skins, classic default, 64-char cap');
}));

/* ---------- 2. skin whitelist ---------- */

check('normalizeSkin is a strict whitelist with a classic fallback', (world) => withModel(world, (m) => {
  const problems = [];
  const cases = [
    ['classic', 'classic'],
    ['modern', 'modern'],
    ['', 'classic'],
    [null, 'classic'],
    [undefined, 'classic'],
    ['MODERN', 'classic'],
    ['Classic', 'classic'],
    ['paper', 'classic'],
    ['classic ', 'classic'],
    [0, 'classic'],
    [123, 'classic'],
    [true, 'classic'],
    [false, 'classic'],
    [{}, 'classic'],
    [[], 'classic'],
  ];
  for (const [input, expected] of cases) pushCase(problems, 'normalizeSkin(' + show(input) + ')', m.normalizeSkin(input), expected);
  if (!sameJson(m.SKIN_IDS, ['classic', 'modern'])) problems.push('SKIN_IDS is not the whitelist any more');
  return verdict(problems, 'modern/classic only, everything else is classic');
}));

/* ---------- 3. prompt version field whitelist ---------- */

check('normalizePromptVersion trims, caps at 64 and rejects junk', (world) => withModel(world, (m) => {
  const problems = [];
  /* 6 chars of core prefix plus 58/59 segments: exactly the 64-char boundary. */
  const exact64 = '1.0.0-' + 'a'.repeat(58);
  const long65 = '1.0.0-' + 'a'.repeat(59);
  if (exact64.length !== 64 || long65.length !== 65) problems.push('test fixture length mismatch');
  const cases = [
    ['0.6.0', '0.6.0'],
    ['  0.6.0  ', '0.6.0'],
    ['\t0.10.0\n', '0.10.0'],
    ['1.0.0-rc.2', '1.0.0-rc.2'],
    [exact64, exact64],
    [long65, ''],
    ['', ''],
    ['   ', ''],
    [null, ''],
    [undefined, ''],
    [6, ''],
    [6.5, ''],
    [true, ''],
    [{}, ''],
    [[], ''],
    ['1.2', ''],
    ['1', ''],
    ['abc', ''],
    ['v0.6.0', ''],
    ['0.6.0.1', ''],
    ['>=0.6.0', ''],
  ];
  for (const [input, expected] of cases) {
    pushCase(problems, 'normalizePromptVersion(' + show(input) + ')', m.normalizePromptVersion(input), expected);
  }
  /* Build metadata is ignored for comparison but must not make the value
     illegal: either the raw string or a canonical core is fine. */
  const withBuild = m.normalizePromptVersion('0.6.0+build.5');
  if (typeof withBuild !== 'string' || !withBuild) {
    problems.push('normalizePromptVersion("0.6.0+build.5")=' + show(withBuild) + ' (expected a legal version)');
  } else if (m.compareVersions(withBuild, '0.6.0') !== 0) {
    problems.push('normalizePromptVersion("0.6.0+build.5")=' + show(withBuild) + ' does not compare equal to 0.6.0');
  }
  return verdict(problems, 'trim + 64-char cap + strict parse');
}));

/* ---------- 4. strict semver parser ---------- */

check('parseVersion reads strict semver and ignores build metadata', (world) => withModel(world, (m) => {
  const problems = [];
  const cases = [
    ['0.6.0', [0, 6, 0], null],
    ['0.10.0', [0, 10, 0], null],
    ['2.3.4', [2, 3, 4], null],
    ['1.2.3-rc.1', [1, 2, 3], ['rc', '1']],
    ['1.0.0-rc.1+build.5', [1, 0, 0], ['rc', '1']],
    ['1.0.0+build.5', [1, 0, 0], null],
    ['0.2.1-rc.2', [0, 2, 1], ['rc', '2']],
    ['2.0.0-alpha.1.2', [2, 0, 0], ['alpha', '1', '2']],
  ];
  for (const [input, core, pre] of cases) {
    const parsed = m.parseVersion(input);
    if (!parsed || !sameJson(parsed.core, core) || !sameJson(parsed.pre, pre)) {
      problems.push('parseVersion(' + show(input) + ')=' + show(parsed) + ', expected core ' + show(core) + ' pre ' + show(pre));
      continue;
    }
    if (!Array.isArray(parsed.core) || parsed.core.some((n) => typeof n !== 'number')) {
      problems.push('parseVersion(' + show(input) + ').core is not an array of numbers');
    }
    if (parsed.pre !== null && (!Array.isArray(parsed.pre) || parsed.pre.some((s) => typeof s !== 'string'))) {
      problems.push('parseVersion(' + show(input) + ').pre is not null or string[]');
    }
  }
  const invalid = ['1.2', '1', 'abc', '', 'v0.6.0', '0.6.0.1', '>=0.6.0', null, undefined, 6, {}];
  for (const input of invalid) {
    let parsed;
    try {
      parsed = m.parseVersion(input);
    } catch (error) {
      problems.push('parseVersion(' + show(input) + ') threw: ' + String(error && error.message ? error.message : error));
      continue;
    }
    if (parsed !== null) problems.push('parseVersion(' + show(input) + ')=' + show(parsed) + ', expected null');
  }
  return verdict(problems, 'major.minor.patch + optional prerelease, build ignored');
}));

/* ---------- 5. version ordering ---------- */

check('compareVersions ranks numerically, then prerelease, then release', (world) => withModel(world, (m) => {
  const problems = [];
  const cases = [
    ['0.9.0', '0.10.0', -1, '0.9.0 is below 0.10.0 (numeric, not string order)'],
    ['0.10.0', '0.9.0', 1, '0.10.0 is above 0.9.0'],
    ['0.6.0', '0.6.0', 0, 'equal versions'],
    ['0.5.2', '0.6.0', -1, 'the 0.5.2 -> 0.6.0 upgrade'],
    ['0.6.0', '0.5.2', 1, 'the 0.6.0 -> 0.5.2 downgrade'],
    ['1.0.0', '1.0.0-rc.1', 1, 'release is above prerelease'],
    ['1.0.0-rc.1', '1.0.0', -1, 'prerelease is below release'],
    ['1.0.0-rc.2', '1.0.0-rc.10', -1, 'rc.2 before rc.10 (numeric segments)'],
    ['1.0.0-rc.10', '1.0.0-rc.2', 1, 'rc.10 after rc.2'],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1, 'more prerelease segments is higher'],
    ['1.0.0-alpha.1', '1.0.0-alpha', 1, 'fewer prerelease segments is lower'],
    ['1.0.0-1', '1.0.0-alpha', -1, 'a numeric segment sorts below a text segment'],
    ['1.0.0-alpha', '1.0.0-1', 1, 'a text segment sorts above a numeric one'],
    ['0.2.1-rc.2', '0.2.1-rc.2', 0, 'a prerelease compared with itself'],
    ['1.0.0+build.1', '1.0.0+build.2', 0, 'build metadata is ignored'],
    ['2.0.0', '10.0.0', -1, 'two-digit major'],
  ];
  for (const [a, b, expected, why] of cases) {
    pushCase(problems, 'compareVersions(' + a + ', ' + b + ') [' + why + ']', m.compareVersions(a, b), expected);
    pushCase(problems, 'compareVersions(' + b + ', ' + a + ') [reversed]', m.compareVersions(b, a), -expected);
  }
  return verdict(problems, 'numeric core, release over prerelease, numeric segments by value');
}));

/* ---------- 6. invalid inputs are refused, never ranked ---------- */

check('compareVersions refuses invalid inputs instead of ranking them', (world) => withModel(world, (m) => {
  const problems = [];
  const long65 = '1.0.0-' + 'a'.repeat(59);
  const invalid = ['1.2', '1', 'abc', '', 'v0.6.0', '0.6.0.1', '>=0.6.0', null, undefined, 6, {}, long65];
  for (const bad of invalid) {
    pushCase(problems, 'compareVersions("0.6.0", ' + show(bad) + ')', m.compareVersions('0.6.0', bad), null);
    pushCase(problems, 'compareVersions(' + show(bad) + ', "0.6.0")', m.compareVersions(bad, '0.6.0'), null);
  }
  pushCase(problems, 'compareVersions on two invalid values', m.compareVersions('abc', '1.2'), null);
  return verdict(problems, 'null on either side means no answer, never a guess');
}));

/* ---------- 7. prompt decision: first run ---------- */

const REASONS = ['first-run', 'suppressed', 'never', 'upgrade', 'same-or-older', 'invalid-version'];

function describeInput(input) {
  if (!input || typeof input !== 'object') return 'decideSkinPrompt(' + show(input) + ')';
  return 'decideSkinPrompt({version:' + show(input.version)
    + ', seenVersion:' + show(input.seenVersion)
    + ', suppressed:' + show(input.suppressed)
    + ', firstRun:' + show(input.firstRun) + '})';
}

function decideProblems(m, cases) {
  const problems = [];
  for (const [input, expectedShow, expectedReason] of cases) {
    let out;
    try {
      out = m.decideSkinPrompt(input);
    } catch (error) {
      problems.push(describeInput(input) + ' threw ' + String(error && error.message ? error.message : error));
      continue;
    }
    if (!out || typeof out.show !== 'boolean') {
      problems.push(describeInput(input) + ' returned ' + show(out) + ' (show must be a boolean)');
      continue;
    }
    if (out.show !== expectedShow) {
      problems.push(describeInput(input) + ': show=' + show(out.show) + ', expected ' + show(expectedShow));
    }
    if (out.reason !== expectedReason) {
      problems.push(describeInput(input) + ': reason=' + show(out.reason) + ', expected ' + show(expectedReason));
    }
    if (REASONS.indexOf(out.reason) === -1) {
      problems.push(describeInput(input) + ': reason ' + show(out.reason) + ' is outside the frozen vocabulary');
    }
  }
  return problems;
}

check('decideSkinPrompt: a first run wins over everything', (world) => withModel(world, (m) => {
  const problems = decideProblems(m, [
    [{ version: '0.6.0', seenVersion: '0.6.0', suppressed: true, firstRun: true }, true, 'first-run'],
    [{ version: '0.6.0', seenVersion: '', suppressed: false, firstRun: true }, true, 'first-run'],
    [{ version: '0.5.2', seenVersion: '0.6.0', suppressed: false, firstRun: true }, true, 'first-run'],
    [{ version: '0.6.0', seenVersion: 'abc', suppressed: false, firstRun: true }, true, 'first-run'],
  ]);
  return verdict(problems, 'firstRun short-circuits history and suppression');
}));

/* ---------- 8. prompt decision: suppression and empty history ---------- */

check('decideSkinPrompt: permanent suppression and a missing history', (world) => withModel(world, (m) => {
  const problems = decideProblems(m, [
    [{ version: '0.6.0', seenVersion: '0.5.2', suppressed: true, firstRun: false }, false, 'suppressed'],
    [{ version: '0.6.0', seenVersion: '', suppressed: true, firstRun: false }, false, 'suppressed'],
    [{ version: '0.6.0', seenVersion: '', suppressed: false }, true, 'never'],
    [{ version: '0.6.0', seenVersion: null, suppressed: false }, true, 'never'],
    [{ version: '0.6.0', seenVersion: 'abc', suppressed: false }, true, 'never'],
    [{ version: '0.6.0', seenVersion: '1.2', suppressed: false }, true, 'never'],
    [{ version: '0.6.0' }, true, 'never'],
  ]);
  return verdict(problems, 'suppressed stays quiet, no legal history means never shown');
}));

/* ---------- 9. prompt decision: upgrade only ---------- */

check('decideSkinPrompt: only a real upgrade shows', (world) => withModel(world, (m) => {
  const problems = decideProblems(m, [
    [{ version: '0.6.0', seenVersion: '0.5.2' }, true, 'upgrade'],
    [{ version: '0.10.0', seenVersion: '0.9.0' }, true, 'upgrade'],
    [{ version: '1.0.0', seenVersion: '1.0.0-rc.1' }, true, 'upgrade'],
    [{ version: '0.6.0', seenVersion: '0.6.0' }, false, 'same-or-older'],
    [{ version: '0.6.0', seenVersion: '0.6.0+build.9' }, false, 'same-or-older'],
    [{ version: '0.5.2', seenVersion: '0.6.0' }, false, 'same-or-older'],
    [{ version: '1.0.0-rc.1', seenVersion: '1.0.0' }, false, 'same-or-older'],
  ]);
  return verdict(problems, 'equal and older versions never prompt');
}));

/* ---------- 10. prompt decision: invalid current version ---------- */

check('decideSkinPrompt: an invalid current version stays silent and does not throw', (world) => withModel(world, (m) => {
  const long65 = '1.0.0-' + 'a'.repeat(59);
  const problems = decideProblems(m, [
    [{ version: '', seenVersion: '0.5.2' }, false, 'invalid-version'],
    [{ version: 'abc', seenVersion: '0.5.2' }, false, 'invalid-version'],
    [{ version: null, seenVersion: '0.5.2' }, false, 'invalid-version'],
    [{ version: '1.2', seenVersion: '0.5.2' }, false, 'invalid-version'],
    [{ version: long65, seenVersion: '0.5.2' }, false, 'invalid-version'],
  ]);
  /* Start-up must not throw because the injected product version is broken. */
  for (const input of [undefined, null, {}, { version: '0.6.0' }]) {
    try {
      const out = m.decideSkinPrompt(input);
      if (!out || typeof out.show !== 'boolean' || REASONS.indexOf(out.reason) === -1) {
        problems.push('decideSkinPrompt(' + show(input) + ') returned a malformed verdict: ' + show(out));
      }
    } catch (error) {
      problems.push('decideSkinPrompt(' + show(input) + ') threw: ' + String(error && error.message ? error.message : error));
    }
  }
  return verdict(problems, 'a broken product version is silent, start-up survives');
}));

/* ---------- 11. the extracted block is pure ---------- */

check('the skin model block is pure: no DOM, no P, no storage', (world) => {
  if (!world.skinBlock) {
    return { pass: false, detail: 'skin model block missing | expected @skin-model-begin / @skin-model-end in ' + PAGE };
  }
  const code = stripComments(world.skinBlock);
  const forbidden = [
    ['document.', 'touches the DOM'],
    ['window.', 'touches the host window'],
    ['localStorage.', 'writes storage directly'],
    ['sessionStorage.', 'writes storage directly'],
    ['hostFetch(', 'talks to the host bridge'],
    ['fetch(', 'does network I/O'],
    ['require(', 'requires a module'],
    ['P.', 'reaches into the page app object'],
    ['eval(', 'evaluates strings'],
    ['new Function', 'evaluates strings'],
    ['localeCompare', 'compares versions with locale rules'],
  ];
  const problems = [];
  for (const [needle, why] of forbidden) {
    if (code.indexOf(needle) !== -1) problems.push('the block ' + why + ' (' + needle + ')');
  }
  return verdict(problems, 'pure functions, runnable in plain Node');
});

/* ---------- 12. one comparison path ---------- */

check('decideSkinPrompt shares the one comparison function', (world) => {
  if (!world.skinBlock) {
    return { pass: false, detail: 'skin model block missing | expected @skin-model-begin / @skin-model-end in ' + PAGE };
  }
  const calls = (world.skinBlock.match(/compareVersions\s*\(/g) || []).length;
  const problems = [];
  /* One definition plus at least one call site: a decision that compares
     versions on its own is a second rule set waiting to drift. */
  if (calls < 2) {
    problems.push('compareVersions has ' + calls + ' occurrence(s) in the block; the prompt decision must reuse it');
  }
  if (world.skinBlock.indexOf('compareVersions') === -1) problems.push('compareVersions is not declared in the block');
  return verdict(problems, 'one comparator, reused by the decision');
});

/* ---------- 13. the model is wired into the real preference path ---------- */

check('the page wires the skin model into the real preference path', (world) => {
  const problems = [];
  if (!world.skinBlock) {
    problems.push('skin model block missing | expected @skin-model-begin / @skin-model-end in ' + PAGE);
  }
  /* The model and the shell are two closures: the page cannot reach the bare
     function names of a different closure, so it consumes the model through a
     public export (P.skinModel) as well as -- in the same file -- by calling
     the names directly. Both spellings are accepted, but a call has to exist:
     a defined-and-exported-but-never-called model is a green gate over dead
     code. Deleting either call site turns this check red. */
  const outside = world.skinBlock ? world.page.split(world.skinBlock).join(' ') : world.page;
  const calls = [
    [
      'the skin prompt decision is never called outside the model block',
      ['P.skinModel.decide(', 'decideSkinPrompt('],
    ],
    [
      'the skin whitelist is never applied outside the model block',
      ['P.skinModel.normalize(', 'normalizeSkin('],
    ],
  ];
  for (const [why, forms] of calls) {
    if (!forms.some((form) => outside.indexOf(form) !== -1)) problems.push(why + ' (looked for ' + forms.join(' | ') + ')');
  }
  const needed = [
    ['skinPromptSuppressed', 'prefs.skinPromptSuppressed is not part of the page'],
    ['skinPromptVersion', 'meta.skinPromptVersion is not part of the page'],
  ];
  for (const [needle, why] of needed) {
    if (outside.indexOf(needle) === -1) problems.push(why);
  }
  /* A decision nobody branches on is the same as no decision: at least one of
     the frozen reasons has to be consumed outside the block. */
  const consumed = REASONS.filter((reason) => outside.indexOf("'" + reason + "'") !== -1);
  if (!consumed.length) problems.push('the page never branches on a decideSkinPrompt reason');
  if (world.page.indexOf('data-skin') === -1 && world.page.indexOf('dataset.skin') === -1) {
    problems.push('the page never applies the skin attribute it was given');
  }
  return verdict(problems, 'decision + whitelist called, both preference fields present, skin applied');
});

/* ---------- 14. first frame skin function ---------- */

check('first frame skin reads snapshot.prefs.skin', (world) => withShell(world, (w) => {
  const problems = [];
  const skinFn = w.make(hostEnv({})).firstFrameSkin;
  if (typeof skinFn !== 'function') {
    problems.push('firstFrameSkin is missing from the @shell-theme block in ' + CLIENT_SRC);
    return verdict(problems, '');
  }
  const cases = [
    ['prefs.skin=modern', snapshotWith({ skin: 'modern' }), 'modern'],
    ['prefs.skin=classic', snapshotWith({ skin: 'classic' }), 'classic'],
    ['prefs.skin missing', snapshotWith({}), 'classic'],
    ['prefs.skin empty', snapshotWith({ skin: '' }), 'classic'],
    ['prefs.skin junk', snapshotWith({ skin: 'paper' }), 'classic'],
    ['prefs.skin uppercase', snapshotWith({ skin: 'MODERN' }), 'classic'],
    ['no prefs at all', { format: 'paper-os/workspace', version: 4 }, 'classic'],
    ['no snapshot', null, 'classic'],
    /* Reading snapshot.skin instead of snapshot.prefs.skin would be a bug. */
    ['skin outside prefs', { skin: 'modern' }, 'classic'],
  ];
  for (const [label, snapshot, expected] of cases) {
    pushCase(problems, 'firstFrameSkin(' + label + ')', skinFn(snapshot), expected);
  }
  return verdict(problems, 'prefs.skin whitelisted, classic fallback');
}));

/* ---------- 15. first frame puts both attributes on the html tag ---------- */

check('first frame page carries both data-theme and data-skin', (world) => withShell(world, (w) => {
  const problems = [];
  const cases = [
    ['dark theme + modern skin', { dark: false }, snapshotWith({ theme: 'dark', skin: 'modern' }), 'dark', 'modern'],
    ['light theme + classic skin', { dark: true }, snapshotWith({ theme: 'light', skin: 'classic' }), 'light', 'classic'],
    ['host dark + default skin', { dark: true }, snapshotWith({}), 'dark', 'classic'],
    ['no snapshot', { dark: false }, null, 'light', 'classic'],
    ['junk skin falls back', { dark: false }, snapshotWith({ skin: 'paper' }), 'light', 'classic'],
  ];
  for (const [label, env, snapshot, theme, skin] of cases) {
    const tag = htmlTag(w.make(hostEnv(env)).embed(snapshot, true));
    if (!tag) {
      problems.push(label + ': no <html> tag in the embedded page');
      continue;
    }
    if (attr(tag, 'data-theme') !== theme) {
      problems.push(label + ': data-theme=' + attr(tag, 'data-theme') + ', expected ' + theme);
    }
    if (attr(tag, 'data-skin') !== skin) {
      problems.push(label + ': data-skin=' + attr(tag, 'data-skin') + ', expected ' + skin);
    }
    if (countOf(tag, 'data-theme=') !== 1) {
      problems.push(label + ': data-theme appears ' + countOf(tag, 'data-theme=') + ' times on the html tag');
    }
    if (countOf(tag, 'data-skin=') !== 1) {
      problems.push(label + ': data-skin appears ' + countOf(tag, 'data-skin=') + ' times on the html tag');
    }
  }
  return verdict(problems, 'one html tag, both attributes, correct values');
}));

/* ---------- 16. the skin injection leaves the tag alone ---------- */

check('first frame skin leaves the rest of the html tag alone', (world) => withShell(world, (w) => {
  const tag = htmlTag(w.make(hostEnv({ dark: false })).embed(snapshotWith({ theme: 'light', skin: 'modern' }), true));
  const problems = [];
  if (!tag) problems.push('no <html> tag in the embedded page');
  else {
    if (tag.indexOf('data-skin="modern"') === -1) problems.push('data-skin=modern is missing from the html tag');
    if (tag.indexOf('data-theme="light"') === -1) problems.push('adding data-skin dropped data-theme');
    if (tag.indexOf('lang="zh-CN"') === -1) problems.push('the skin injection dropped lang from the html tag');
    if (tag.indexOf('data-motion="system"') === -1) problems.push('the skin injection dropped data-motion');
    if (tag.indexOf('data-hand="kai"') === -1) problems.push('the skin injection dropped data-hand');
  }
  return verdict(problems, 'skin added, lang/motion/hand/theme untouched');
}));

/* ---------- 17/18. read-only seal (source-level approximation) ----------
   05 §6 needs a page half AND a shell half, because pagehide / flush-now / the
   shell queue can all write while the page itself is blocked. These two checks
   are source-level only: they prove the guards exist and are wired into the
   paths that could write. They do NOT prove AC-22 (zero POST on a real host) --
   that still needs the real bridge / CDP gate. */

function functionBodyOf(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) return '';
  const open = source.indexOf('{', start);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return '';
}

check('read-only seal: the page refuses to save and answers flush-now', (world) => {
  const page = world.page;
  const problems = [];
  if (page.indexOf('function isReadOnly()') === -1) problems.push('isReadOnly() is missing');
  const postSave = functionBodyOf(page, 'function postSave()');
  if (!postSave) problems.push('postSave() is missing');
  else if (postSave.indexOf('isReadOnly()') === -1) {
    problems.push('postSave() no longer bails out on a read-only workspace (pagehide + visibilitychange ride on it)');
  }
  const postReady = functionBodyOf(page, 'function postReady()');
  if (!postReady || postReady.indexOf('readOnly') === -1) problems.push('the ready message does not carry readOnly');
  const statusAt = page.indexOf("send('status'");
  if (statusAt === -1) problems.push('no status message is sent when the read-only state changes');
  else if (page.slice(statusAt, statusAt + 120).indexOf('readOnly') === -1) {
    problems.push('the status message does not carry readOnly');
  }
  /* flush-now must not flush a read-only workspace, and its reply must say so. */
  const flushAt = page.indexOf('P.storage.flushNow()');
  if (flushAt === -1) problems.push('the flush-now handler is missing');
  else if (page.slice(Math.max(0, flushAt - 160), flushAt).indexOf('isReadOnly()') === -1) {
    problems.push('flush-now still flushes a read-only workspace');
  }
  if ((page.match(/readOnly: isReadOnly\(\)/g) || []).length < 2) {
    problems.push('the readOnly flag is missing from the ready and/or the flush-now reply');
  }
  if (page.indexOf("window.addEventListener('pagehide', postSave);") === -1) problems.push('pagehide is not routed through postSave');
  if (page.indexOf("document.addEventListener('visibilitychange'") === -1) problems.push('visibilitychange is not routed through postSave');
  return verdict(problems, 'source-level: postSave, flush-now, ready and status all carry the gate');
});

check('read-only seal: the shell drops saves and restarts', (world) => {
  const client = world.client;
  const problems = [];
  if (client.indexOf('readOnly: false') === -1) problems.push('the bridge literal has no readOnly flag');
  const guarded = [
    ['function flush(keepalive)', 'flush'],
    ['function queueSave(snapshot)', 'queueSave'],
    ['function applyRestart(payload)', 'applyRestart'],
  ];
  for (const [signature, label] of guarded) {
    const body = functionBodyOf(client, signature);
    if (!body) problems.push(label + '() is missing');
    else if (body.indexOf('bridge.readOnly') === -1) problems.push(label + '() does not check bridge.readOnly');
  }
  if (client.indexOf("kind === 'status'") === -1) problems.push('the shell never handles a status message');
  /* ready / status / snapshot must all refresh the flag: a read-only state that
     appears after boot (session restore failing validation) is otherwise lost. */
  if ((client.match(/readOnly = data\.readOnly === true/g) || []).length < 2) {
    problems.push('readOnly is not synced from at least two message kinds');
  }
  return verdict(problems, 'source-level: queueSave/flush/applyRestart guarded, state synced from messages');
});

/* ---------- 19/20. composer entry shares the shell skin resolver ---------- */

check('the shell resolves the composer skin through one shared whitelist', (world) => {
  const problems = [];
  const source = world.client;
  if (source.indexOf('function resolveSkin(snapshot)') === -1) problems.push('resolveSkin() is missing');
  const firstBody = functionBodyOf(source, 'function firstFrameSkin(snapshot)');
  if (!firstBody) problems.push('firstFrameSkin() is missing');
  else if (firstBody.indexOf('resolveSkin(') === -1) problems.push('firstFrameSkin no longer reuses resolveSkin');
  if (source.indexOf("prefs && prefs.skin === 'modern' ? 'modern' : 'classic'") === -1) {
    problems.push('resolveSkin is not the single whitelist expression');
  }
  if (source.indexOf("'data-cys-skin': uiSkin") === -1) problems.push('the composer chrome is not bound to uiSkin');
  if (source.indexOf('resolveSkin(latestSnapshot)') === -1) problems.push('uiSkin is not refreshed through resolveSkin');
  return verdict(problems, 'one resolver, reused by the first frame and the composer chrome');
});

check('the composer modern styles are scoped to data-cys-skin=modern', (world) => {
  const problems = [];
  const source = world.client;
  if (source.indexOf("'.cys-prompt-root{") === -1) problems.push('the .cys-prompt-root base rule is missing');
  const scoped = (source.match(/\[data-cys-skin="modern"\]/g) || []).length;
  if (scoped < 5) problems.push('modern composer rules are not scoped: only ' + scoped + ' [data-cys-skin="modern"] selectors');
  if (source.indexOf('[data-cys-skin="classic"]') !== -1) problems.push('a classic-scoped composer selector exists (skin scoping is not a whitelist)');
  return verdict(problems, scoped + ' modern composer selectors under data-cys-skin=modern');
});

/* ---------- run and report ---------- */

function runAll(currentWorld) {
  const results = [];
  for (const item of checks) {
    let result;
    try {
      result = item.run(currentWorld);
    } catch (error) {
      result = { pass: false, detail: 'threw: ' + String(error && error.message ? error.message : error) };
    }
    results.push({ name: item.name, pass: !!result.pass, detail: result.detail || '' });
  }
  return results;
}

function report(results, label) {
  let passed = 0;
  let failures = 0;
  for (const result of results) {
    if (result.pass) {
      passed += 1;
      console.log('PASS | ' + result.name + (result.detail ? ' | ' + result.detail : ''));
    } else {
      failures += 1;
      console.log('FAIL | ' + result.name + ' | ' + result.detail);
    }
  }
  console.log(label + ': PASS ' + passed + ' / FAIL ' + failures + ' / SKIP 0');
  return failures;
}

/* ---------- main ---------- */

let world;
try {
  world = buildWorld(clientSource, pageSource);
} catch (error) {
  fail('source extraction: ' + String(error && error.message ? error.message : error));
}

const baseResults = runAll(world);
let failed = report(baseResults, 'checks');

if (!SELF_TEST) {
  process.exit(failed === 0 ? 0 : 1);
}

/* Reverse audit: every known-bad input must turn the named check red, and the
   mutation must really have applied, otherwise "green" proves nothing. */
const mutations = [
  {
    id: 'skin whitelist folded to one value',
    kind: 'block',
    mutate: (block) => block.split("'modern'").join("'classic'"),
    expect: ['normalizeSkin is a strict whitelist with a classic fallback'],
  },
  {
    id: 'version cap lifted above 64',
    kind: 'block',
    mutate: (block) => block.replace(/SKIN_PROMPT_VERSION_MAX\s*=\s*\d+/, 'SKIN_PROMPT_VERSION_MAX = 640'),
    expect: ['normalizePromptVersion trims, caps at 64 and rejects junk'],
  },
  {
    id: 'an equal version is reported as an upgrade',
    kind: 'block',
    mutate: (block) => block.split("'same-or-older'").join("'upgrade'"),
    expect: ['decideSkinPrompt: only a real upgrade shows'],
  },
  {
    id: 'the html tag drops data-skin',
    kind: 'client',
    mutate: (src) => src.split('data-skin="').join('data-skinx="'),
    expect: ['first frame page carries both data-theme and data-skin'],
  },
  {
    id: 'the first frame stops reading prefs.skin',
    kind: 'client',
    mutate: (src) => src.split('prefs.skin').join('prefs.nope'),
    expect: ['first frame skin reads snapshot.prefs.skin'],
  },
  {
    id: 'the shell resolver loses the modern branch',
    kind: 'client',
    mutate: (src) => src.replace("prefs && prefs.skin === 'modern' ? 'modern' : 'classic'", "'classic'"),
    expect: ['the shell resolves the composer skin through one shared whitelist', 'first frame skin reads snapshot.prefs.skin'],
  },
  {
    id: 'the composer modern styles lose their skin scope',
    kind: 'client',
    mutate: (src) => src.replace('[data-cys-skin="modern"]', '[data-cys-skin="classic"]'),
    expect: ['the composer modern styles are scoped to data-cys-skin=modern'],
  },
  {
    id: 'the client whitelist forgets modern',
    kind: 'client',
    mutate: (src) => src.split("'modern'").join("'classic'"),
    expect: ['first frame skin reads snapshot.prefs.skin'],
  },
  {
    id: 'the page saves even when the workspace is read-only',
    kind: 'page',
    mutate: (src) => src.split('if (isReadOnly()) return;').join(''),
    expect: ['read-only seal: the page refuses to save and answers flush-now'],
  },
  {
    id: 'the shell stops checking the read-only flag',
    kind: 'client',
    mutate: (src) => src.split('if (bridge.readOnly)').join('if (false)'),
    expect: ['read-only seal: the shell drops saves and restarts'],
  },
];

let selfFailed = failed;
let rejected = 0;
for (const mutation of mutations) {
  let mutatedWorld = null;
  if (mutation.kind === 'block') {
    const mutatedBlock = world.skinBlock ? mutation.mutate(world.skinBlock) : '';
    if (mutatedBlock === world.skinBlock) {
      selfFailed += 1;
      console.log('FAIL | self-test | mutation did not apply: ' + mutation.id);
      continue;
    }
    const mutatedPage = pageSource.split(world.skinBlock).join(mutatedBlock);
    try {
      mutatedWorld = buildWorld(clientSource, mutatedPage);
    } catch (error) {
      selfFailed += 1;
      console.log('FAIL | self-test | mutated page no longer parses (' + mutation.id + '): '
        + String(error && error.message ? error.message : error));
      continue;
    }
  } else if (mutation.kind === 'page') {
    const mutatedPage = mutation.mutate(pageSource);
    if (mutatedPage === pageSource) {
      selfFailed += 1;
      console.log('FAIL | self-test | mutation did not apply: ' + mutation.id);
      continue;
    }
    try {
      mutatedWorld = buildWorld(clientSource, mutatedPage);
    } catch (error) {
      selfFailed += 1;
      console.log('FAIL | self-test | mutated page no longer parses (' + mutation.id + '): '
        + String(error && error.message ? error.message : error));
      continue;
    }
  } else {
    const mutatedClient = mutation.mutate(clientSource);
    if (mutatedClient === clientSource) {
      selfFailed += 1;
      console.log('FAIL | self-test | mutation did not apply: ' + mutation.id);
      continue;
    }
    try {
      mutatedWorld = buildWorld(mutatedClient, pageSource);
    } catch (error) {
      selfFailed += 1;
      console.log('FAIL | self-test | mutated client no longer parses (' + mutation.id + '): '
        + String(error && error.message ? error.message : error));
      continue;
    }
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
