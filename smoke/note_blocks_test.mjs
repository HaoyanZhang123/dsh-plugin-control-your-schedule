#!/usr/bin/env node
/**
 * Block-model gate for dsh-plugin-control-your-schedule.
 *
 * The note body is stored as blocks (text / image). The page keeps the
 * normaliser and the text projection between the `@blocks-begin` and
 * `@blocks-end` markers and touches no DOM there, so this suite can run it in
 * plain Node against the shipped source.
 *
 * Two directions are covered:
 *   forward  - a well-formed block list survives round-tripping unchanged;
 *   reverse  - every malformed shape is dropped or refused, and never reaches
 *              the projection (an unknown block must not become searchable
 *              text, and an image id must never escape the asset folder).
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
const begin = page.indexOf('/* @blocks-begin */');
const end = page.indexOf('/* @blocks-end */');
if (begin === -1 || end === -1) {
  console.log('FAIL | block markers not found in paper-os.html');
  console.log('checks: PASS 0 / FAIL 1');
  process.exit(1);
}

const P = {};
try {
  // The block sits in the same IIFE as the rest of core.js, so give it a P and
  // read the exports back off it.
  const factory = new Function('P', page.slice(begin, end) + '\nreturn P;');
  factory(P);
  ok('block model loads in Node', 'schema=' + (/P\.schemaVersion = (\d+);/.exec(page) || [])[1]);
} catch (error) {
  console.log('FAIL | block model loads in Node | ' + error.message);
  console.log('checks: PASS 0 / FAIL 1');
  process.exit(1);
}

for (const name of ['normalizeNoteBlocks', 'noteBlocksText', 'noteBlocksFromText', 'noteAssetId']) {
  if (typeof P[name] === 'function') ok('P.' + name + ' exists');
  else bad('P.' + name + ' exists', 'missing');
}

const ID = 'ast_0123456789ab';

// --- forward: a well-formed list survives unchanged ---
const good = [
  { type: 'text', text: '第一段\n第二段' },
  { type: 'image', assetId: ID, w: 1280, h: 720, bytes: 186432, mime: 'image/jpeg' },
  { type: 'text', text: '图后面的字' },
];
const normalised = P.normalizeNoteBlocks(good);
if (JSON.stringify(normalised) === JSON.stringify(good)) ok('a well-formed block list round-trips unchanged');
else bad('a well-formed block list round-trips unchanged', JSON.stringify(normalised));

const projection = P.noteBlocksText(normalised);
if (projection === '第一段\n第二段\n\n图后面的字') ok('content projects from text blocks only', JSON.stringify(projection));
else bad('content projects from text blocks only', JSON.stringify(projection));

// Legacy text becomes exactly one text block, verbatim.
const wrapped = P.noteBlocksFromText('旧正文\n换行');
if (JSON.stringify(wrapped) === JSON.stringify([{ type: 'text', text: '旧正文\n换行' }])) ok('legacy content becomes one text block, verbatim');
else bad('legacy content becomes one text block, verbatim', JSON.stringify(wrapped));
if (JSON.stringify(P.noteBlocksFromText('')) === '[]') ok('empty legacy content becomes no blocks');
else bad('empty legacy content becomes no blocks', JSON.stringify(P.noteBlocksFromText('')));

// --- reverse: malformed shapes must be dropped, never passed through ---
const unknown = P.normalizeNoteBlocks([
  { type: 'text', text: '留着' },
  { type: 'video', src: 'x' },
  { type: 'image', assetId: '../../etc/passwd' },
  { type: 'image', assetId: ID, mime: 'text/html' },
  null,
  'nope',
  { type: 'text', text: '' },
]);
if (unknown.length === 2) ok('unknown / malformed blocks are dropped', JSON.stringify(unknown.map((b) => b.type)));
else bad('unknown / malformed blocks are dropped', JSON.stringify(unknown));
if (unknown[1] && unknown[1].assetId === ID && unknown[1].mime === '') ok('an image keeps a valid id and drops a bad mime');
else bad('an image keeps a valid id and drops a bad mime', JSON.stringify(unknown[1]));
if (P.noteBlocksText(unknown).indexOf('passwd') === -1) ok('a rejected image never leaks into the projection');
else bad('a rejected image never leaks into the projection', P.noteBlocksText(unknown));

// An escaping id must be refused before it can reach a filesystem join.
for (const evil of ['../x', 'ast_SHORT', 'ast_' + 'a'.repeat(40), '', null, 42, 'ast_0123456789ab/x']) {
  if (P.noteAssetId(evil) === '') ok('asset id refused: ' + JSON.stringify(evil));
  else bad('asset id refused: ' + JSON.stringify(evil), P.noteAssetId(evil));
}

// Caps are enforced by truncation, not by throwing.
const manyText = [];
for (let i = 0; i < P.NOTE_BLOCKS_MAX + 40; i += 1) manyText.push({ type: 'text', text: 'x' + i });
if (P.normalizeNoteBlocks(manyText).length === P.NOTE_BLOCKS_MAX) ok('block count is capped', String(P.NOTE_BLOCKS_MAX));
else bad('block count is capped', String(P.normalizeNoteBlocks(manyText).length));

const manyImages = [];
for (let i = 0; i < P.NOTE_IMAGES_MAX + 5; i += 1) manyImages.push({ type: 'image', assetId: 'ast_' + String(i).padStart(12, '0') });
if (P.normalizeNoteBlocks(manyImages).length === P.NOTE_IMAGES_MAX) ok('image count is capped', String(P.NOTE_IMAGES_MAX));
else bad('image count is capped', String(P.normalizeNoteBlocks(manyImages).length));

const longText = P.normalizeNoteBlocks([{ type: 'text', text: '字'.repeat(P.NOTE_TEXT_MAX + 500) }]);
if (longText.length === 1 && longText[0].text.length === P.NOTE_TEXT_MAX) ok('one text block is capped at NOTE_TEXT_MAX');
else bad('one text block is capped at NOTE_TEXT_MAX', String(longText[0] && longText[0].text.length));

const hugeBytes = P.normalizeNoteBlocks([{ type: 'image', assetId: ID, bytes: 99 * 1024 * 1024 }]);
if (hugeBytes[0] && hugeBytes[0].bytes === P.NOTE_IMAGE_MAX_BYTES) ok('image byte count is clamped');
else bad('image byte count is clamped', JSON.stringify(hugeBytes[0]));

const weirdDims = P.normalizeNoteBlocks([{ type: 'image', assetId: ID, w: -5, h: 'tall' }]);
if (weirdDims[0] && weirdDims[0].w === 0 && weirdDims[0].h === 0) ok('non-numeric dimensions become 0');
else bad('non-numeric dimensions become 0', JSON.stringify(weirdDims[0]));

if (P.normalizeNoteBlocks(null).length === 0 && P.normalizeNoteBlocks(undefined).length === 0) ok('a missing block list is an empty list');
else bad('a missing block list is an empty list', 'not empty');

const failed = checks.filter((c) => !c[0]);
console.log('checks: PASS ' + (checks.length - failed.length) + ' / FAIL ' + failed.length);
process.exit(failed.length ? 1 : 0);
