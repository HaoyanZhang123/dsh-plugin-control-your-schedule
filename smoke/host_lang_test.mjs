#!/usr/bin/env node
/**
 * Host language gate for dsh-plugin-control-your-schedule.
 *
 * The shell resolves one language for the whole plugin: prefs.lang when the user
 * pinned one inside the desk, otherwise the host locale. That language decides
 * which built page variant loads AND which dictionary row the composer entry and
 * the panel chrome render, so it must not silently drift back to the host
 * locale. This gate pins both halves.
 *
 * Everything is read from source (src/client.src.js): the @shell-theme block and
 * the @dictionary block are evaluated outside the plugin. No browser, no DSH.
 *
 * Usage:
 *   node smoke/host_lang_test.mjs               # real source must be green
 *   node smoke/host_lang_test.mjs --self-test   # known-bad inputs must go red
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
   - factory: <root>/plugin/src/client.src.js
   - release repo: <root>/src/client.src.js (the package is the repo root) */
const CLIENT_SRC = [
  join(ROOT, 'plugin', 'src', 'client.src.js'),
  join(ROOT, 'src', 'client.src.js'),
].find((candidate) => existsSync(candidate));

function fail(message) {
  console.log('FAIL | ' + message);
  console.log('checks: PASS 0 / FAIL 1 / SKIP 0');
  process.exit(1);
}

if (!CLIENT_SRC) fail('client source not found | looked for plugin/src and src/client.src.js');

/* Normalise line endings once: the workspace checks the file out with CRLF on
   Windows and LF elsewhere, and the self-test mutations anchor on whole lines. */
const baseSrc = readFileSync(CLIENT_SRC, 'utf8').replace(/\r\n/g, '\n');

/* ---------- extraction ---------- */

function sliceBetween(text, begin, end) {
  const start = text.indexOf(begin);
  if (start === -1) return '';
  const stop = text.indexOf(end, start);
  if (stop === -1) return '';
  return text.slice(start, stop + end.length);
}

const ZH_PAGE = '<html lang="zh-CN" data-motion="system" data-hand="kai" data-theme="light"><head><script>x</script></head><body></body></html>';
const EN_PAGE = '<html lang="en" data-motion="system" data-hand="kai" data-theme="light"><head><script>x</script></head><body></body></html>';

function buildWorld(src) {
  const themeBlock = sliceBetween(src, '/* @shell-theme-begin */', '/* @shell-theme-end */');
  if (!themeBlock) throw new Error('@shell-theme-begin/@shell-theme-end markers missing');
  const dictBlock = sliceBetween(src, '/* @dictionary-begin */', '/* @dictionary-end */');
  if (!dictBlock) throw new Error('@dictionary-begin/@dictionary-end markers missing');

  const shellFactory = new Function(
    'basePage', 'document', 'getComputedStyle',
    themeBlock + '\nreturn { embed: embed, resolveLang: resolveLang, normalizeLang: normalizeLang, setLocaleHost: function (v) { localeHost = v; } };'
  );
  const dictFactory = new Function(dictBlock + '\nreturn { DICTIONARY: DICTIONARY, textFor: textFor };');

  const asked = [];
  const document = {
    documentElement: { getAttribute: (name) => (name === 'data-platform' ? 'win32' : null) },
    body: { hasAttribute: (name) => name === 'data-ds-dark-theme' && false },
  };
  const getComputedStyle = () => ({ getPropertyValue: () => '' });
  const pages = { zh: ZH_PAGE, en: EN_PAGE };
  const api = shellFactory(
    (lang) => { asked.push(lang === 'en' ? 'en' : 'zh'); return pages[lang === 'en' ? 'en' : 'zh']; },
    document,
    getComputedStyle
  );
  const dict = dictFactory();
  return { src, api, dict, asked };
}

/* 夹具故意保留 version: 3（0.5.0 的 schemaVersion 是 4）：它顺带就是一份
   「v3 快照仍能被宿主读取」的活样本。本套件断言的是语言解析，不是版本号。 */
function snapshotWith(prefs) {
  return { format: 'paper-os/workspace', version: 3, prefs: Object.assign({}, prefs), meta: { updatedAt: 1 } };
}

function htmlTag(html) {
  return (html.match(/<html\b[^>]*>/i) || [''])[0];
}

function pageLang(html) {
  const found = htmlTag(html).match(/lang="([^"]*)"/);
  return found ? found[1] : '(missing)';
}

function injectedLang(html) {
  const found = html.match(/window\.__SCHEDULE_LANG__="([a-z]+)"/);
  return found ? found[1] : '(missing)';
}

/* ---------- checks ---------- */

const checks = [];
function check(name, run) { checks.push({ name, run }); }

/* 1-6: the variant that loads follows the resolved language. */
check('host zh: no prefs resolves zh', (w) => {
  w.api.setLocaleHost('zh');
  const got = w.api.resolveLang(null);
  return { pass: got === 'zh', detail: 'resolveLang(null)=' + got };
});

check('host zh: uses the zh page variant', (w) => {
  w.api.setLocaleHost('zh');
  const html = w.api.embed(null, true);
  return { pass: pageLang(html) === 'zh-CN', detail: pageLang(html) };
});

check('host zh: injects __SCHEDULE_LANG__=zh', (w) => {
  w.api.setLocaleHost('zh');
  const html = w.api.embed(null, true);
  return { pass: injectedLang(html) === 'zh', detail: injectedLang(html) };
});

check('host en: uses the en page variant', (w) => {
  w.api.setLocaleHost('en');
  const html = w.api.embed(null, true);
  return { pass: pageLang(html) === 'en', detail: pageLang(html) };
});

check('host en: injects __SCHEDULE_LANG__=en', (w) => {
  w.api.setLocaleHost('en');
  const html = w.api.embed(null, true);
  return { pass: injectedLang(html) === 'en', detail: injectedLang(html) };
});

check('host en: asks basePage for the en variant only', (w) => {
  w.api.setLocaleHost('en');
  w.asked.length = 0;
  w.api.embed(null, true);
  const asked = w.asked.join(',');
  return { pass: asked === 'en', detail: 'asked=' + asked };
});

/* 7-14: prefs.lang wins over the host, everything else falls back to the host. */
check('prefs.lang=zh beats an en host', (w) => {
  w.api.setLocaleHost('en');
  const got = w.api.resolveLang(snapshotWith({ lang: 'zh' }));
  return { pass: got === 'zh', detail: 'got ' + got };
});

check('prefs.lang=en beats a zh host', (w) => {
  w.api.setLocaleHost('zh');
  const got = w.api.resolveLang(snapshotWith({ lang: 'en' }));
  return { pass: got === 'en', detail: 'got ' + got };
});

check('prefs.lang=en: the page variant is en', (w) => {
  w.api.setLocaleHost('zh');
  const html = w.api.embed(snapshotWith({ lang: 'en' }), true);
  return { pass: pageLang(html) === 'en', detail: pageLang(html) };
});

check('prefs.lang=zh: the page variant is zh', (w) => {
  w.api.setLocaleHost('en');
  const html = w.api.embed(snapshotWith({ lang: 'zh' }), true);
  return { pass: pageLang(html) === 'zh-CN', detail: pageLang(html) };
});

check('prefs.lang=system follows a zh host', (w) => {
  w.api.setLocaleHost('zh');
  const got = w.api.resolveLang(snapshotWith({ lang: 'system' }));
  return { pass: got === 'zh', detail: 'got ' + got };
});

check('prefs.lang=system follows an en host', (w) => {
  w.api.setLocaleHost('en');
  const got = w.api.resolveLang(snapshotWith({ lang: 'system' }));
  return { pass: got === 'en', detail: 'got ' + got };
});

check('an unrecognised prefs.lang follows the host', (w) => {
  w.api.setLocaleHost('en');
  const got = w.api.resolveLang(snapshotWith({ lang: 'fr' }));
  return { pass: got === 'en', detail: 'got ' + got };
});

check('no snapshot follows the host', (w) => {
  w.api.setLocaleHost('en');
  const got = w.api.resolveLang(null);
  return { pass: got === 'en', detail: 'got ' + got };
});

/* 15-20: locale ids as DSH publishes them. */
check('zh-CN normalises to zh', (w) => {
  const got = w.api.normalizeLang('zh-CN');
  return { pass: got === 'zh', detail: String(got) };
});

check('zh-TW normalises to zh', (w) => {
  const got = w.api.normalizeLang('zh-TW');
  return { pass: got === 'zh', detail: String(got) };
});

check('en-US normalises to en', (w) => {
  const got = w.api.normalizeLang('en-US');
  return { pass: got === 'en', detail: String(got) };
});

check('EN (uppercase) normalises to en', (w) => {
  const got = w.api.normalizeLang('EN');
  return { pass: got === 'en', detail: String(got) };
});

check('an unsupported language is not claimed', (w) => {
  const got = w.api.normalizeLang('ja');
  return { pass: got === null, detail: String(got) };
});

check('an unknown host id does not move the language', (w) => {
  w.api.setLocaleHost('en');
  const got = w.api.resolveLang(snapshotWith({ lang: 'ja' }));
  return { pass: got === 'en', detail: 'got ' + got };
});

check('embed never rewrites the page lang attribute', (w) => {
  const html = w.api.embed(snapshotWith({ lang: 'en' }), true);
  const tag = htmlTag(html);
  const count = (tag.match(/lang=/g) || []).length;
  const ok = count === 1 && tag.indexOf('lang="en"') !== -1;
  return { pass: ok, detail: tag };
});

/* 22-27: the dictionary is the single source for both languages. */
check('zh and en declare the same key set', (w) => {
  const zh = Object.keys(w.dict.DICTIONARY.zh).sort();
  const en = Object.keys(w.dict.DICTIONARY.en).sort();
  const missing = zh.filter((key) => en.indexOf(key) === -1);
  const extra = en.filter((key) => zh.indexOf(key) === -1);
  const ok = missing.length === 0 && extra.length === 0;
  return { pass: ok, detail: ok ? zh.length + ' keys in both' : 'missing in en: ' + missing.join(',') + ' | missing in zh: ' + extra.join(',') };
});

check('no empty or non-string translations', (w) => {
  const bad = [];
  for (const lang of ['zh', 'en']) {
    for (const [key, value] of Object.entries(w.dict.DICTIONARY[lang])) {
      if (typeof value !== 'string' || value.trim() === '') bad.push(lang + ':' + key);
    }
  }
  return { pass: bad.length === 0, detail: bad.length ? 'blank: ' + bad.join(',') : 'every value is a non-empty string' };
});

check('every key the UI asks for exists in both languages', (w) => {
  const used = [];
  const patterns = [/\btextFor\(uiLang,\s*'([^']+)'/g, /\bt\('([^']+)'/g];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(w.src)) !== null) used.push(match[1]);
  }
  const missing = used.filter((key) => !Object.prototype.hasOwnProperty.call(w.dict.DICTIONARY.zh, key)
    || !Object.prototype.hasOwnProperty.call(w.dict.DICTIONARY.en, key));
  const unique = [...new Set(used)];
  return { pass: missing.length === 0 && unique.length > 0, detail: missing.length ? 'not in the dictionary: ' + [...new Set(missing)].join(',') : unique.length + ' keys referenced, all present' };
});

check('interpolation fills {n} for both languages', (w) => {
  const zh = w.dict.textFor('zh', 'prompt.count', { n: 3 });
  const en = w.dict.textFor('en', 'prompt.count', { n: 3 });
  const untouched = w.dict.textFor('en', 'prompt.count', {});
  const ok = zh === '提示词 · 3 条' && en === 'Prompts · 3' && untouched === 'Prompts · {n}';
  return { pass: ok, detail: JSON.stringify({ zh: zh, en: en, untouched: untouched }) };
});

check('an unknown language renders Chinese', (w) => {
  const got = w.dict.textFor('fr', 'prompt.title');
  return { pass: got === '提示词', detail: JSON.stringify(got) };
});

check('an unknown key falls back to the key itself', (w) => {
  const got = w.dict.textFor('en', 'prompt.does-not-exist');
  return { pass: got === 'prompt.does-not-exist', detail: JSON.stringify(got) };
});

check('shell chrome renders through textFor(uiLang), not the host-bound t()', (w) => {
  const problems = [];
  if (w.src.indexOf("textFor(uiLang, 'prompt.title')") === -1) problems.push('the composer title is not rendered from the resolved language');
  if (w.src.indexOf("textFor(uiLang, 'panel.frameTitle')") === -1) problems.push('the frame title is not rendered from the resolved language');
  if (/\btranslate\(/.test(w.src)) problems.push('a translate() call survived (host-bound)');
  const tCalls = (w.src.match(/\bt\('([^']+)'/g) || []);
  const foreign = tCalls.filter((call) => call !== "t('panel'");
  if (foreign.length) problems.push('t() is still used for UI text: ' + foreign.join(','));
  return { pass: problems.length === 0, detail: problems.join('; ') || 'composer + panel chrome follow uiLang; t() kept for the sidebar label only' };
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
    id: 'unsupported host language is claimed as en',
    mutate: (src) => src.replace(
      "      if (text === 'en' || text.indexOf('en-') === 0 || text.indexOf('en_') === 0) return 'en';\n      return null;",
      "      if (text === 'en' || text.indexOf('en-') === 0 || text.indexOf('en_') === 0) return 'en';\n      return 'en';"
    ),
    expect: ['an unsupported language is not claimed'],
  },
  {
    id: 'prefs.lang is ignored',
    mutate: (src) => src.replace('return normalizeLang(prefs && prefs.lang) || localeHost;', 'return localeHost;'),
    expect: ['prefs.lang=zh beats an en host', 'prefs.lang=en beats a zh host', 'prefs.lang=en: the page variant is en', 'prefs.lang=zh: the page variant is zh'],
  },
  {
    id: 'page variant ignores the resolved language',
    mutate: (src) => src.replace('firstFramePage(basePage(lang),', "firstFramePage(basePage('zh'),"),
    expect: ['host en: uses the en page variant', 'prefs.lang=en: the page variant is en'],
  },
  {
    id: 'the en dictionary loses a key',
    mutate: (src) => src.replace("        'prompt.retry': 'Retry',\n", ''),
    expect: ['zh and en declare the same key set', 'every key the UI asks for exists in both languages'],
  },
  {
    id: 'a translation goes blank',
    mutate: (src) => src.replace("        'prompt.retry': 'Retry',", "        'prompt.retry': '   ',"),
    expect: ['no empty or non-string translations'],
  },
  {
    id: 'interpolation is dropped',
    mutate: (src) => src.replace('      if (!params) return template;', '      return template;'),
    expect: ['interpolation fills {n} for both languages'],
  },
  {
    id: 'chrome falls back to the host-bound t()',
    mutate: (src) => src.replace("textFor(uiLang, 'prompt.title')", "t('prompt.title')"),
    expect: ['shell chrome renders through textFor(uiLang), not the host-bound t()'],
  },
];

/* ---------- main ---------- */

let world;
try {
  world = buildWorld(baseSrc);
} catch (error) {
  fail('source extraction: ' + String(error && error.message ? error.message : error));
}

const baseResults = runAll(world);
let failed = report(baseResults, 'checks');

if (!SELF_TEST) {
  process.exit(failed === 0 ? 0 : 1);
}

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
    mutatedWorld = buildWorld(mutated);
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
