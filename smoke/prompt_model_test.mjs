#!/usr/bin/env node
/**
 * Prompt model gate: the pure part of the composer entry, extracted from
 * plugin/src/client.src.js between the marker comments and run in plain Node.
 *
 * Why: the insertion rules are the risky part of this feature (caret insert,
 * empty-draft fallback, busy refusal). Keeping them pure means they can be
 * proven here instead of only on a real machine.
 *
 * Exit 0 only when every assertion passes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const [SRC] = [
  join(ROOT, 'plugin', 'src', 'client.src.js'),
  join(ROOT, 'src', 'client.src.js'),
].filter((candidate) => existsSync(candidate));
if (!SRC) {
  console.log('FAIL | client source not found');
  process.exit(1);
}
const source = readFileSync(SRC, 'utf8');
const begin = source.indexOf('/* @prompt-model-begin */');
const end = source.indexOf('/* @prompt-model-end */');
if (begin === -1 || end === -1) {
  console.log('FAIL | prompt model markers missing in ' + SRC);
  process.exit(1);
}
const block = source.slice(begin, end);

const checks = [];
const ok = (name, detail = '') => { checks.push([true, name]); console.log('PASS | ' + name + (detail ? ' | ' + detail : '')); };
const bad = (name, detail = '') => { checks.push([false, name]); console.log('FAIL | ' + name + ' | ' + detail); };

let model;
try {
  model = new Function(block + '\nreturn { normalizePrompts, applyPrompt };')();
  ok('prompt model loads in Node');
} catch (error) {
  bad('prompt model loads in Node', error.message);
  console.log('checks: PASS 0 / FAIL 1');
  process.exit(1);
}

// --- normalizePrompts ------------------------------------------------------
const normalized = model.normalizePrompts({
  prompts: [
    { id: 'a', title: '旧', body: '第一行', pinned: false, updatedAt: 10 },
    { id: 'b', title: '', body: '掉标题的', pinned: true, updatedAt: 20 },
    { id: 'c', body: '', pinned: false, updatedAt: 30 },
    { id: 123, body: '无效 id' },
    { id: 'd', title: '无正文' },
    null,
  ],
});
if (normalized.length === 3 && normalized[0].id === 'b' && normalized[1].id === 'c' && normalized[2].id === 'a') ok('normalizePrompts keeps valid rows and sorts pinned first', JSON.stringify(normalized.map((p) => p.id)));
else bad('normalizePrompts keeps valid rows and sorts pinned first', JSON.stringify(normalized));
if (normalized[0].title === '未命名提示词') ok('a missing title gets the placeholder', normalized[0].title);
else bad('a missing title gets the placeholder', JSON.stringify(normalized[0] && normalized[0].title));
if (model.normalizePrompts(null).length === 0) ok('a snapshot without prompts normalizes to an empty list');
else bad('a snapshot without prompts normalizes to an empty list');
if (model.normalizePrompts({ prompts: 'nope' }).length === 0) ok('a malformed prompts field normalizes to an empty list');
else bad('a malformed prompts field normalizes to an empty list');

// --- applyPrompt -----------------------------------------------------------
const calls = [];
const caretActions = {
  captureInsertion() { calls.push('capture'); return { start: 3, end: 3, draftRev: 7 }; },
  insertText(text, span) { calls.push('insert:' + span.draftRev); return true; },
  setDraft() { calls.push('draft'); },
};
let result = model.applyPrompt(caretActions, '多行\n提示词');
if (result.ok && result.via === 'insert' && calls.join(',') === 'capture,insert:7') ok('a usable caret inserts through insertText', calls.join(','));
else bad('a usable caret inserts through insertText', JSON.stringify(result) + ' ' + calls.join(','));

const emptyDraftCalls = [];
const staleActions = {
  captureInsertion() { emptyDraftCalls.push('capture'); return { start: 0, end: 0, draftRev: 1 }; },
  insertText() { emptyDraftCalls.push('insert'); return false; },
  setDraft(text) { emptyDraftCalls.push('draft:' + text.length); },
};
result = model.applyPrompt(staleActions, '正文段落\n第二段');
if (result.ok && result.via === 'draft' && emptyDraftCalls.join(',') === 'capture,insert,draft:8') ok('a rejected insertion falls back to a whole-draft fill', emptyDraftCalls.join(','));
else bad('a rejected insertion falls back to a whole-draft fill', JSON.stringify(result) + ' ' + emptyDraftCalls.join(','));

const retryCalls = [];
const retryActions = {
  captureInsertion() { retryCalls.push('capture'); return { start: 1, end: 1, draftRev: retryCalls.length }; },
  insertText() { retryCalls.push('insert'); return false; },
};
result = model.applyPrompt(retryActions, '重试');
if (!result.ok && result.reason === 'busy' && retryCalls.filter((c) => c === 'insert').length === 2) ok('a busy composer is refused after one retry', retryCalls.join(','));
else bad('a busy composer is refused after one retry', JSON.stringify(result) + ' ' + retryCalls.join(','));

const throwingActions = {
  captureInsertion() { throw new Error('editor disposed'); },
  insertText() { throw new Error('editor disposed'); },
  setDraft(text) { throwingActions.restored = text; },
};
result = model.applyPrompt(throwingActions, '恢复');
if (result.ok && result.via === 'draft' && throwingActions.restored === '恢复') ok('a throwing editor still restores the text through setDraft');
else bad('a throwing editor still restores the text through setDraft', JSON.stringify(result));

const noApi = model.applyPrompt(null, '正文');
if (!noApi.ok && noApi.reason === 'unavailable') ok('a missing action face is refused instead of throwing');
else bad('a missing action face is refused instead of throwing', JSON.stringify(noApi));

const blank = model.applyPrompt(caretActions, '   ');
if (!blank.ok && blank.reason === 'empty') ok('blank prompt bodies are refused');
else bad('blank prompt bodies are refused', JSON.stringify(blank));

const failed = checks.filter((c) => !c[0]);
console.log('checks: PASS ' + (checks.length - failed.length) + ' / FAIL ' + failed.length);
process.exit(failed.length ? 1 : 0);
