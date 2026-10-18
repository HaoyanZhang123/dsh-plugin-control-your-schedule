import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temp = await mkdtemp(join(tmpdir(), 'cys-host-route-'));
process.env.DSH_HOME = temp;
let route = null;
let disposed = false;
const ctx = {
  connection: { fetch: { register(candidate) { route = candidate; return async () => { disposed = true; }; } } },
  effect(fn) { return fn(); },
};
const entry = existsSync(new URL('../plugin/index.js', import.meta.url)) ? '../plugin/index.js' : '../index.js';
const mod = await import(new URL(entry + '?test=' + Date.now(), import.meta.url).href);
mod.apply(ctx);
assert.ok(route, 'host route was not registered');
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

response = await route.fetch(new Request(endpoint, { method: 'DELETE' }));
assert.equal(response.status, 200);
response = await route.fetch(new Request(endpoint, { method: 'GET' }));
assert.equal((await response.json()).snapshot, null);

await rm(temp, { recursive: true, force: true });
console.log('PASS | host route stores, reads and clears the workspace');
