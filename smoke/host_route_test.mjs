import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temp = await mkdtemp(join(tmpdir(), 'cys-host-route-'));
process.env.DSH_HOME = temp;
let route = null;
let disposed = false;
const routes = [];
const ctx = {
  connection: { fetch: { register(candidate) {
    routes.push(candidate);
    if (!route) route = candidate;
    return async () => { disposed = true; };
  } } },
  effect(fn) { return fn(); },
};
ctx.__routes = routes;
const entry = existsSync(new URL('../plugin/index.js', import.meta.url)) ? '../plugin/index.js' : '../index.js';
const mod = await import(new URL(entry + '?test=' + Date.now(), import.meta.url).href);
mod.apply(ctx);
assert.ok(route, 'host route was not registered');
// Two routes register: the bundled font first, then the workspace store.
route = routes.find((r) => r.path === '/api/control-your-schedule/workspace');
assert.ok(route, 'workspace route was not registered');
assert.equal(route.path, '/api/control-your-schedule/workspace');
assert.deepEqual([...route.methods].sort(), ['DELETE', 'GET', 'POST']);

const endpoint = 'http://host/api/control-your-schedule/workspace';
const snapshot = { format: 'paper-os/workspace', version: 1, meta: { updatedAt: 1 }, nodes: [], stickies: [], tasks: [] };

let response = await route.fetch(new Request(endpoint, { method: 'GET' }));
let body = await response.json();
assert.equal(response.status, 200);
assert.equal(body.ok, true);
assert.equal(body.snapshot, null);

response = await route.fetch(new Request(endpoint, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshot }),
}));
assert.equal(response.status, 200);
assert.equal((await response.json()).ok, true);

response = await route.fetch(new Request(endpoint, { method: 'GET' }));
body = await response.json();
assert.equal(body.ok, true);
assert.equal(body.snapshot.format, 'paper-os/workspace');
assert.equal(body.snapshot.nodes.length, 0);
const stored = JSON.parse(await readFile(join(temp, 'control-your-schedule', 'workspace.json'), 'utf8'));
assert.equal(stored.snapshot.format, 'paper-os/workspace');

response = await route.fetch(new Request(endpoint, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshot: { hello: 'world' } }),
}));
assert.equal(response.status, 400);

// --- schema upgrade must leave a recoverable copy behind ---
// Store a v1 snapshot, then write a v2 one. The host knows nothing about the
// workspace schema; it only has to notice the version moved and keep the old file.
response = await route.fetch(new Request(endpoint, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ snapshot: { format: 'paper-os/workspace', version: 1, meta: { updatedAt: 2 }, nodes: [], stickies: [], tasks: [{ id: 'a' }] } }),
}));
assert.equal(response.status, 200);

response = await route.fetch(new Request(endpoint, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ snapshot: { format: 'paper-os/workspace', version: 2, meta: { updatedAt: 3 }, nodes: [], stickies: [], tasks: [] } }),
}));
assert.equal(response.status, 200);

const backupPath = join(temp, 'control-your-schedule', 'workspace.v1.backup.json');
assert.ok(existsSync(backupPath), 'v1 backup was not written when the schema version moved');
const backup = JSON.parse(await readFile(backupPath, 'utf8'));
assert.equal(backup.snapshot.version, 1, 'backup must keep the pre-upgrade snapshot');
assert.equal(backup.snapshot.tasks.length, 1, 'backup must keep the pre-upgrade tasks');

// A second v2 write must not clobber the existing backup.
response = await route.fetch(new Request(endpoint, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ snapshot: { format: 'paper-os/workspace', version: 2, meta: { updatedAt: 4 }, nodes: [], stickies: [], tasks: [] } }),
}));
assert.equal(response.status, 200);
const backupAgain = JSON.parse(await readFile(backupPath, 'utf8'));
assert.equal(backupAgain.snapshot.meta.updatedAt, 2, 'the first backup must stay authoritative');

// --- the bundled handwriting font is served, not inlined ---
const fontRoute = ctx.__routes && ctx.__routes.find((r) => r.path === '/api/control-your-schedule/font');
assert.ok(fontRoute, 'font route was not registered');
const fontResponse = await fontRoute.fetch(new Request('http://host/api/control-your-schedule/font'));
assert.equal(fontResponse.status, 200);
assert.equal(fontResponse.headers.get('content-type'), 'font/woff2');
const fontBytes = new Uint8Array(await fontResponse.arrayBuffer());
assert.ok(fontBytes.byteLength > 200000, 'served font looks empty');
assert.equal(String.fromCharCode(fontBytes[0], fontBytes[1], fontBytes[2], fontBytes[3]), 'wOF2');

// --- note image assets: bytes on disk, ids in the snapshot ---
const assetRoute = ctx.__routes && ctx.__routes.find((r) => r.path === '/api/control-your-schedule/assets');
assert.ok(assetRoute, 'asset route was not registered');
assert.deepEqual([...assetRoute.methods].sort(), ['DELETE', 'GET', 'PUT']);
const assetEndpoint = 'http://host/api/control-your-schedule/assets';

// A 1x1 PNG: real bytes, so "served the same thing back" is testable.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const assetId = 'ast_0123456789ab';

response = await assetRoute.fetch(new Request(assetEndpoint + '?id=' + assetId, { method: 'GET' }));
assert.equal(response.status, 404, 'an unknown asset must be a 404, not an empty 200');

response = await assetRoute.fetch(new Request(assetEndpoint + '?id=' + assetId, {
  method: 'PUT',
  headers: { 'content-type': 'image/png', 'x-asset-width': '1', 'x-asset-height': '1' },
  body: PNG,
}));
assert.equal(response.status, 200);
assert.equal((await response.json()).bytes, PNG.byteLength);

response = await assetRoute.fetch(new Request(assetEndpoint + '?id=' + assetId, { method: 'GET' }));
assert.equal(response.status, 200);
assert.equal(response.headers.get('content-type'), 'image/png');
const served = Buffer.from(await response.arrayBuffer());
assert.equal(served.equals(PNG), true, 'served bytes must equal the uploaded bytes');

const assetDir = join(temp, 'control-your-schedule', 'assets');
assert.ok(existsSync(join(assetDir, assetId + '.bin')), 'asset bytes were not written next to the workspace');
assert.equal(JSON.parse(await readFile(join(assetDir, assetId + '.json'), 'utf8')).mime, 'image/png');
// The snapshot must stay free of image bytes: the whole point of the split.
assert.ok(JSON.stringify(JSON.parse(await readFile(join(temp, 'control-your-schedule', 'workspace.json'), 'utf8'))).length < 4000);

response = await assetRoute.fetch(new Request(assetEndpoint, { method: 'GET' }));
assert.deepEqual((await response.json()).ids, [assetId], 'the id listing must report exactly the stored asset');

// --- reverse side: every rejection must name its reason ---
for (const bad of ['../escape', 'ast_short', 'ast_0123456789ab/../../x', '']) {
  const escaped = await assetRoute.fetch(new Request(assetEndpoint + '?id=' + encodeURIComponent(bad), { method: 'GET' }));
  assert.equal(escaped.status, 400, 'bad id must be refused: ' + JSON.stringify(bad));
}
assert.equal(existsSync(join(temp, 'control-your-schedule', 'escape.bin')), false);

response = await assetRoute.fetch(new Request(assetEndpoint + '?id=' + assetId, {
  method: 'PUT', headers: { 'content-type': 'text/html' }, body: '<script>',
}));
assert.equal(response.status, 415, 'a non-image content type must be refused');

response = await assetRoute.fetch(new Request(assetEndpoint + '?id=' + assetId, {
  method: 'PUT', headers: { 'content-type': 'image/png' }, body: Buffer.alloc(4 * 1024 * 1024 + 1),
}));
assert.equal(response.status, 413, 'an oversized asset must be refused');

response = await assetRoute.fetch(new Request(assetEndpoint + '?id=' + assetId, { method: 'DELETE' }));
assert.equal(response.status, 200);
assert.equal(existsSync(join(assetDir, assetId + '.bin')), false);
assert.equal(existsSync(join(assetDir, assetId + '.json')), false);
response = await assetRoute.fetch(new Request(assetEndpoint + '?id=' + assetId, { method: 'DELETE' }));
assert.equal(response.status, 200, 'deleting a missing asset stays idempotent');

response = await route.fetch(new Request(endpoint, { method: 'DELETE' }));
assert.equal(response.status, 200);
response = await route.fetch(new Request(endpoint, { method: 'GET' }));
assert.equal((await response.json()).snapshot, null);

await rm(temp, { recursive: true, force: true });
console.log('PASS | host route stores, reads, clears, backs up on schema change, serves the font and stores note images');
