#!/usr/bin/env node
/**
 * Migration gate for dsh-plugin-control-your-schedule.
 *
 * The page's migration ladder sits between the migrate-begin / migrate-end marker comments and
 * deliberately touches no DOM, no P.util and no P.ui, so it can run here in
 * plain Node. That keeps "upgrading never loses data" a machine-checked fact
 * instead of a promise.
 *
 * Exit 0 only when every assertion passes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
/* Two layouts must both work:
   - factory: <root>/plugin/assets/paper-os.html
   - release repo: <root>/assets/paper-os.html (the package is the repo root) */
const PAGE = [
  join(ROOT, 'plugin', 'assets', 'paper-os.html'),
  join(ROOT, 'assets', 'paper-os.html'),
].find((candidate) => existsSync(candidate));
const FIXTURE_V1 = join(HERE, 'fixtures', 'workspace-v1.json');

const checks = [];
const ok = (name, detail = '') => { checks.push([true, name, detail]); console.log('PASS | ' + name + (detail ? ' | ' + detail : '')); };
const bad = (name, detail = '') => { checks.push([false, name, detail]); console.log('FAIL | ' + name + ' | ' + detail); };

function extractLadder(page) {
  const begin = page.indexOf('/* @migrate-begin */');
  const end = page.indexOf('/* @migrate-end */');
  if (begin === -1 || end === -1) throw new Error('migration markers not found in paper-os.html');
  return page.slice(begin, end);
}

function loadMigrator(page) {
  const code = extractLadder(page);
  // The block only defines MIGRATIONS and P.migrateWorkspace; give it a P.
  const factory = new Function('P', code + '\nreturn P;');
  const P = {
    schemaVersion: Number(/P\.schemaVersion = (\d+);/.exec(page)[1]),
    TASK_PRIORITIES: [],
  };
  factory(P);
  return P;
}

if (!PAGE) {
  console.log('FAIL | page not found | looked for plugin/assets and assets/paper-os.html');
  console.log('checks: PASS 0 / FAIL 1');
  process.exit(1);
}
const page = readFileSync(PAGE, 'utf8');
let P;
try {
  P = loadMigrator(page);
  ok('migration block loads in Node', 'schemaVersion=' + P.schemaVersion);
} catch (error) {
  bad('migration block loads in Node', String(error.message));
  console.log('checks: PASS 0 / FAIL 1');
  process.exit(1);
}

if (typeof P.migrateWorkspace !== 'function') {
  bad('P.migrateWorkspace exists', 'missing');
  console.log('checks: PASS 0 / FAIL 1');
  process.exit(1);
}
ok('P.migrateWorkspace exists');

const v1 = JSON.parse(readFileSync(FIXTURE_V1, 'utf8'));
// Keep a handle on the exact object we hand over, so "not mutated" is testable.
const callerInput = JSON.parse(JSON.stringify(v1));
const result = P.migrateWorkspace(callerInput);

if (!result.ok) {
  bad('v1 migrates', JSON.stringify(result));
} else {
  ok('v1 migrates', 'from v' + result.from);
  const snap = result.snapshot;

  if (snap.version === P.schemaVersion) ok('version is current', 'v' + snap.version);
  else bad('version is current', 'v' + snap.version);

  // Nothing outside tasks/stickies/meta may change.
  const same = (label, a, b) => {
    if (JSON.stringify(a) === JSON.stringify(b)) ok(label + ' preserved');
    else bad(label + ' preserved', 'differs');
  };
  same('nodes (pages + drawings)', snap.nodes, v1.nodes);
  same('prefs', snap.prefs, v1.prefs);
  same('desktop (window layout)', snap.desktop, v1.desktop);

  if (snap.tasks.length === v1.tasks.length) ok('task count preserved', String(snap.tasks.length));
  else bad('task count preserved', v1.tasks.length + ' -> ' + snap.tasks.length);

  // Every preserved key must keep its exact value; only "done" may disappear.
  let removedKeys = new Set();
  let valueMismatch = [];
  v1.tasks.forEach((before, i) => {
    const after = snap.tasks[i] || {};
    Object.keys(before).forEach((key) => {
      if (key === 'done') { if (!('done' in after)) removedKeys.add(key); return; }
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) valueMismatch.push(after.id + '.' + key);
    });
  });
  // Must FAIL when the legacy flag survives: that is the whole point of the migration.
  if (removedKeys.size === 1 && removedKeys.has('done')) ok('legacy "done" is dropped', [...removedKeys].join(','));
  else bad('legacy "done" is dropped', 'removed=' + ([...removedKeys].join(',') || 'none'));
  if (valueMismatch.length === 0) ok('no preserved task value changed');
  else bad('no preserved task value changed', valueMismatch.join(', '));

  const doneTask = snap.tasks.find((t) => t.id === 'task_done');
  const openTask = snap.tasks.find((t) => t.id === 'task_open');
  if (doneTask && JSON.stringify(doneTask.doneOn) === JSON.stringify(['2026-10-18'])) ok('done:true becomes doneOn:[date]');
  else bad('done:true becomes doneOn:[date]', JSON.stringify(doneTask && doneTask.doneOn));
  if (openTask && Array.isArray(openTask.doneOn) && openTask.doneOn.length === 0) ok('done:false becomes doneOn:[]');
  else bad('done:false becomes doneOn:[]', JSON.stringify(openTask && openTask.doneOn));

  const defaultsOk = snap.tasks.every((t) => t.priority === 'none' && t.repeat === 'once' && t.resolvedAt === 0);
  if (defaultsOk) ok('old tasks default to none / once / unresolved');
  else bad('old tasks default to none / once / unresolved', 'not all tasks defaulted');

  const zOk = snap.stickies.every((s, i) => typeof s.z === 'number' && s.z === i + 1);
  if (zOk) ok('stickies get a stable z', '1..' + snap.stickies.length);
  else bad('stickies get a stable z', JSON.stringify(snap.stickies.map((s) => s.z)));
  same('sticky text/color/position preserved', snap.stickies.map((s) => [s.id, s.text, s.color, s.x, s.y]), v1.stickies.map((s) => [s.id, s.text, s.color, s.x, s.y]));

  if (snap.meta.migratedFrom === 1) ok('meta records migratedFrom=1');
  else bad('meta records migratedFrom=1', JSON.stringify(snap.meta.migratedFrom));

  // v3 只做加法：提示词库出现，并铺上三条原生示例；别的既有内容不变。
  const sampleIds = ['prompt_sample_research', 'prompt_sample_align', 'prompt_sample_agents'];
  const seeded = Array.isArray(snap.prompts) ? snap.prompts : [];
  if (seeded.length === 3 && sampleIds.every((id) => seeded.some((p) => p.id === id))) ok('v1 -> v3 seeds the three native prompts');
  else bad('v1 -> v3 seeds the three native prompts', JSON.stringify(seeded.map((p) => p.id)));
  if (seeded.every((p) => p.sample === true)) ok('native prompts are marked as samples');
  else bad('native prompts are marked as samples', JSON.stringify(seeded.map((p) => p.sample)));

  // --- v2 -> v3 carries every v2 value through untouched ---
  const v2 = JSON.parse(JSON.stringify(v1));
  v2.version = 2;
  v2.tasks = [{ id: 'task_v2', date: '2026-10-18', title: '旧待办', priority: 'urgent', repeat: 'daily', doneOn: ['2026-10-18'], resolvedAt: 0, createdAt: 1, updatedAt: 2 }];
  v2.prompts = undefined;
  const fromV2 = P.migrateWorkspace(JSON.parse(JSON.stringify(v2)));
  if (!fromV2.ok) {
    bad('v2 migrates', JSON.stringify(fromV2));
  } else {
    const s2 = fromV2.snapshot;
    if (s2.version === P.schemaVersion) ok('v2 migration reaches the current version', 'v' + s2.version);
    else bad('v2 migration reaches the current version', 'v' + s2.version);
    same('v2 nodes preserved', s2.nodes, v2.nodes);
    same('v2 stickies preserved', s2.stickies, v2.stickies);
    same('v2 tasks preserved', s2.tasks, v2.tasks);
    same('v2 desktop preserved', s2.desktop, v2.desktop);
    if (Array.isArray(s2.prompts) && s2.prompts.length === 3) ok('v2 -> v3 seeds the three native prompts');
    else bad('v2 -> v3 seeds the three native prompts', JSON.stringify(s2.prompts && s2.prompts.length));

    // 一个含有提示词的 v3 快照原样保留
    const withPrompt = JSON.parse(JSON.stringify(s2));
    withPrompt.prompts = [{ id: 'prompt_a', title: '标题', body: '正文\n第二行', pinned: true, createdAt: 3, updatedAt: 4 }];
    const kept = P.migrateWorkspace(JSON.parse(JSON.stringify(withPrompt)));
    if (kept.ok && JSON.stringify(kept.snapshot.prompts) === JSON.stringify(withPrompt.prompts)) ok('v3 prompt entries pass through unchanged');
    else bad('v3 prompt entries pass through unchanged', JSON.stringify(kept.ok && kept.snapshot.prompts));
  }

  // --- v3 -> v4 只加一个数据版本：nodes/stickies/tasks/prompts/prefs 逐值不动 ---
  // 迁移本身不发明 note.pinned；缺省 false 由 validateWorkspace 补（page_e2e 的
  // ingest 往返断言覆盖那一层），所以这里对「没有该字段的旧纸页」按 !!pinned 读 false。
  const v3 = JSON.parse(JSON.stringify(v1));
  v3.version = 3;
  v3.prompts = [{ id: 'prompt_v3', title: '旧提示词', body: '正文', pinned: false, createdAt: 5, updatedAt: 6 }];
  v3.nodes = v3.nodes.map((node) => (
    node.kind === 'note' ? Object.assign({}, node, { pinned: true }) : node
  ));
  v3.nodes.push({
    id: 'doc_nopin',
    type: 'doc',
    kind: 'note',
    name: '没有置顶字段',
    parentId: 'folder_notes',
    content: 'v3 写的纸页',
    sample: false,
    createdAt: 1792600000000,
    updatedAt: 1792600000000,
  });
  const v3Input = JSON.parse(JSON.stringify(v3));
  const fromV3 = P.migrateWorkspace(v3Input);
  if (!fromV3.ok) {
    bad('v3 migrates', JSON.stringify(fromV3));
  } else {
    const s3 = fromV3.snapshot;
    if (s3.version === 4 && P.schemaVersion === 4) ok('v3 migration reaches v4', 'v' + s3.version);
    else bad('v3 migration reaches v4', 'v' + s3.version + ' / schema ' + P.schemaVersion);

    const pinnedNote = s3.nodes.filter((node) => node.id === 'doc_welcome')[0];
    const plainNote = s3.nodes.filter((node) => node.id === 'doc_nopin')[0];
    if (pinnedNote && pinnedNote.pinned === true) ok('v3 note with pinned:true keeps it', 'doc_welcome');
    else bad('v3 note with pinned:true keeps it', JSON.stringify(pinnedNote && pinnedNote.pinned));
    if (plainNote && !plainNote.pinned) ok('v3 note without pinned reads as false', 'doc_nopin.pinned=' + ('pinned' in (plainNote || {}) ? String(plainNote.pinned) : 'absent -> false'));
    else bad('v3 note without pinned reads as false', JSON.stringify(plainNote && plainNote.pinned));

    same('v3 nodes preserved', s3.nodes, v3.nodes);
    same('v3 stickies preserved', s3.stickies, v3.stickies);
    same('v3 tasks preserved', s3.tasks, v3.tasks);
    same('v3 prompts preserved', s3.prompts, v3.prompts);
    same('v3 prefs preserved', s3.prefs, v3.prefs);
    if (s3.meta.migratedFrom === 3) ok('v3 migration records migratedFrom=3');
    else bad('v3 migration records migratedFrom=3', JSON.stringify(s3.meta.migratedFrom));
    if (JSON.stringify(v3Input) === JSON.stringify(v3)) ok('v3 input snapshot not mutated');
    else bad('v3 input snapshot not mutated', 'caller object was modified');
  }

  // Idempotent: migrating an already-current snapshot changes nothing.
  const again = P.migrateWorkspace(JSON.parse(JSON.stringify(snap)));
  if (again.ok && JSON.stringify(again.snapshot) === JSON.stringify(snap)) ok('migration is idempotent');
  else bad('migration is idempotent', 'second pass changed the snapshot');

  // The caller's object must come back untouched. Compare the object that was
  // actually passed in (a clone), otherwise this assertion can never fail.
  if (JSON.stringify(callerInput) === JSON.stringify(v1)) ok('input snapshot not mutated');
  else bad('input snapshot not mutated', 'caller object was modified');
}

// --- reverse side: bad inputs must fail loudly and name the reason ---
const newer = P.migrateWorkspace({ format: 'paper-os/workspace', version: P.schemaVersion + 1, nodes: [], stickies: [], tasks: [] });
if (!newer.ok && newer.reason === 'newer') ok('v(N+1) snapshot is refused', newer.detail);
else bad('v(N+1) snapshot is refused', JSON.stringify(newer));
if (!newer.ok && !newer.snapshot) ok('refused snapshot yields no data');
else bad('refused snapshot yields no data', 'returned a snapshot anyway');

const noFormat = P.migrateWorkspace({ version: 1, nodes: [], stickies: [], tasks: [] });
if (!noFormat.ok && noFormat.reason === 'format') ok('missing format marker is refused');
else bad('missing format marker is refused', JSON.stringify(noFormat));

const notObject = P.migrateWorkspace('nope');
if (!notObject.ok && notObject.reason === 'format') ok('non-object is refused');
else bad('non-object is refused', JSON.stringify(notObject));

const badVersion = P.migrateWorkspace({ format: 'paper-os/workspace', version: 'x' });
if (!badVersion.ok) ok('non-numeric version is refused');
else bad('non-numeric version is refused', JSON.stringify(badVersion));

const failed = checks.filter((c) => !c[0]);
console.log('checks: PASS ' + (checks.length - failed.length) + ' / FAIL ' + failed.length);
process.exit(failed.length ? 1 : 0);
