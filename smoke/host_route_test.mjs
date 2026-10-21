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

response = await route.fetch(new Request(endpoint, { method: 'DELETE' }));
assert.equal(response.status, 200);
response = await route.fetch(new Request(endpoint, { method: 'GET' }));
assert.equal((await response.json()).snapshot, null);

await rm(temp, { recursive: true, force: true });
console.log('PASS | host route stores, reads, clears, backs up on schema change and serves the font');
