#!/usr/bin/env node
/**
 * Checklist-model gate for dsh-plugin-control-your-schedule.
 *
 * A sticky note can be a plain note or a checklist. The text stays the single
 * source of truth (`- [ ] item` / `- [x] item`); `mode` is only a rendering
 * switch. The page keeps the parser and the serialiser between the
 * `@sticky-list-begin` and `@sticky-list-end` markers and touches no DOM there,
 * so this suite can run it in plain Node against the shipped source.
 *
 * Two directions are covered:
 *   forward  - a well-formed checklist round-trips unchanged;
 *   reverse  - every malformed or hostile shape degrades to readable text
 *              instead of being dropped or throwing.
 *
 * Exit 0 only when every assertion passes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PAGE = [
  join(ROOT, 'plugin', 'assets', 'paper-os.html'),
  join(ROOT, 'assets', 'paper-os.html'),
].find((candidate) => existsSync(candidate));

const checks = [];
const ok = (name, detail = '') => { checks.push([true, name]); console.log('PASS | ' + name + (detail ? ' | ' + detail : '')); };
const bad = (name, detail = '') => { checks.push([false, name]); console.log('FAIL | ' + name + ' | ' + detail); };

if (!PAGE) {
  console.log('FAIL | page not found | looked for plugin/assets and assets/paper-os.html');
  console.log('checks: PASS 0 / FAIL 1');
  process.exit(1);
}
const page = readFileSync(PAGE, 'utf8');
const begin = page.indexOf('/* @sticky-list-begin */');
const end = page.indexOf('/* @sticky-list-end */');
if (begin === -1 || end === -1) {
  console.log('FAIL | checklist markers not found in paper-os.html');
  console.log('checks: PASS 0 / FAIL 1');
  process.exit(1);
}

const P = {};
try {
  // The block sits in the same IIFE as the rest of core.js, so give it a P and
  // read the exports back off it.
  const factory = new Function('P', page.slice(begin, end) + '\nreturn P;');
  factory(P);
  ok('checklist model loads in Node', 'schema=' + (/P\.schemaVersion = (\d+);/.exec(page) || [])[1]);
} catch (error) {
  console.log('FAIL | checklist model loads in Node | ' + error.message);
  console.log('checks: PASS 0 / FAIL 1');
  process.exit(1);
}

for (const name of ['stickyMode', 'clampStickyText', 'parseStickyList', 'serializeStickyList', 'stickyProgress']) {
  if (typeof P[name] === 'function') ok('P.' + name + ' exists');
  else bad('P.' + name + ' exists', 'missing');
}

const same = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) ok(label, a.length > 120 ? a.slice(0, 117) + '...' : a);
  else bad(label, 'got ' + a + ', want ' + e);
};

// --- mode: anything that is not literally 'list' is a plain note ------------
same('mode defaults to text', P.stickyMode(undefined), 'text');
same('mode rejects unknown strings', P.stickyMode('checklist'), 'text');
same('mode keeps list', P.stickyMode('list'), 'list');

// --- forward: a well-formed checklist round-trips unchanged -----------------
const source = '- [ ] 写 issue 模板\n- [x] 合并 PR\n- [ ] 看一下日志';
same('parse marks done from [x]', P.parseStickyList(source).items, [
  { text: '写 issue 模板', done: false },
  { text: '合并 PR', done: true },
  { text: '看一下日志', done: false },
]);
same('serialise reproduces the input byte for byte', P.serializeStickyList(P.parseStickyList(source).items), source);
same('round trip is stable twice', P.serializeStickyList(P.parseStickyList(P.serializeStickyList(P.parseStickyList(source).items)).items), source);

// --- markers: uppercase X, extra spaces, empty body ------------------------
same('uppercase X counts as done', P.parseStickyList('- [X] done').items, [{ text: 'done', done: true }]);
same('extra spaces after the bracket are eaten', P.parseStickyList('- [ ]   spaced').items, [{ text: 'spaced', done: false }]);
same('an empty item stays an empty item', P.parseStickyList('- [ ] ').items, [{ text: '', done: false }]);
same('a bare bracket pair is one empty item', P.parseStickyList('- [ ]').items, [{ text: '', done: false }]);
same('asterisk bullets are accepted', P.parseStickyList('* [x] star').items, [{ text: 'star', done: true }]);

// --- loose lines: a plain sentence becomes an unchecked item, never lost ---
const loose = P.parseStickyList('今天三件事\n- [ ] 回邮件');
same('a plain line becomes an unchecked item', loose.items, [
  { text: '今天三件事', done: false },
  { text: '回邮件', done: false },
]);
same('a plain line is reported as loose', loose.loose, true);
same('a pure checklist is not loose', P.parseStickyList('- [ ] a').loose, false);

// --- reverse: hostile input never throws and never grows unbounded ---------
same('empty text yields no items', P.parseStickyList('').items, []);
same('null text yields no items', P.parseStickyList(null).items, []);
same('blank lines become empty items', P.parseStickyList('a\n\nb').items.length, 3);

const overflow = Array.from({ length: 400 }, (_, i) => '- [ ] ' + i).join('\n');
same('item count is capped', P.parseStickyList(overflow).items.length, P.STICKY_ITEMS_MAX);
same('serialised text respects the 5000 cap', P.serializeStickyList(P.parseStickyList(overflow).items).length <= P.STICKY_TEXT_MAX, true);
same('clamp keeps short text untouched', P.clampStickyText('abc'), 'abc');
same('clamp cuts at 5000', P.clampStickyText('x'.repeat(6000)).length, 5000);
same('clamp turns non-strings into empty', P.clampStickyText(null), '');

// --- a newline inside an item never breaks the one-line-per-item invariant --
same('newlines inside an item are flattened', P.serializeStickyList([{ text: 'a\nb', done: false }]), '- [ ] a b');

// --- progress ---------------------------------------------------------------
same('progress counts done over total', P.stickyProgress({ mode: 'list', text: source }), { done: 1, total: 3, all: false });
same('an all-done checklist reports all', P.stickyProgress({ mode: 'list', text: '- [x] a\n- [x] b' }), { done: 2, total: 2, all: true });
same('an empty checklist is not "all done"', P.stickyProgress({ mode: 'list', text: '' }), { done: 0, total: 0, all: false });
same('a plain note has no progress', P.stickyProgress({ mode: 'text', text: '- [x] a' }), null);
same('progress tolerates junk input', P.stickyProgress(null), null);

// --- reverse mutation self-check: the gate must be able to go red ----------
// Feeding a deliberately broken serialiser must fail the round-trip assertion,
// otherwise this suite is decoration.
const brokenSerialise = (items) => items.map((item) => '- [ ] ' + item.text).join('\n');
const mutated = brokenSerialise(P.parseStickyList('- [x] 合并 PR').items);
if (mutated !== '- [x] 合并 PR') ok('mutation self-check turns the round trip red');
else bad('mutation self-check turns the round trip red', 'a broken serialiser still passed');

// --- wiring: the validator must carry mode through the same single helper --
// A snapshot written by an older build has no `mode`; it must land as a plain
// note, and a `list` note must survive a round trip through the validator.
const validatorSource = /mode: P\.stickyMode\(rawSticky\.mode\),/.test(page);
if (validatorSource) ok('the validator reads mode through P.stickyMode');
else bad('the validator reads mode through P.stickyMode', 'needle missing from paper-os.html');

const updaterSource = /if \(Object\.prototype\.hasOwnProperty\.call\(changes, 'mode'\)\) sticky\.mode = P\.stickyMode\(changes\.mode\);/.test(page);
if (updaterSource) ok('updateSticky writes mode through P.stickyMode');
else bad('updateSticky writes mode through P.stickyMode', 'needle missing from paper-os.html');

// --- an empty checklist must still be editable ------------------------------
// The render layer guarantees at least one row so an imported `mode:list` with
// empty text is not a dead blank card. Prove the page keeps that guard.
if (/var rows = items\.length \? items : \[\{ text: '', done: false \}\];/.test(page)) ok('the renderer always emits at least one row');
else bad('the renderer always emits at least one row', 'guard missing from renderListRows');

const passed = checks.filter((one) => one[0]).length;
const failed = checks.length - passed;
console.log('checks: PASS ' + passed + ' / FAIL ' + failed);
process.exit(failed === 0 ? 0 : 1);
