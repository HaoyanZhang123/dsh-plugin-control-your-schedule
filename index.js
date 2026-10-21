import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-plugin-control-your-schedule';
export const inject = ['connection'];

const ROUTE = '/api/control-your-schedule/workspace';
const FONT_ROUTE = '/api/control-your-schedule/font';
const MAX_BYTES = 32 * 1024 * 1024;

/* The desk lives in a same-origin srcdoc iframe, so the bundled handwriting
   font is served from here instead of being inlined into the page bundle. */
const FONT_FILE = join(dirname(fileURLToPath(import.meta.url)), 'assets', 'fonts', 'lxgw-wenkai-hand.woff2');

function dshHome() {
  const override = process.env.DSH_HOME;
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  return join(homedir(), '.dsh');
}

function workspaceFile() {
  return join(dshHome(), 'control-your-schedule', 'workspace.json');
}

function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

async function readWorkspace() {
  try {
    const text = await readFile(workspaceFile(), 'utf8');
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !parsed.snapshot || typeof parsed.snapshot !== 'object') return null;
    return parsed;
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function renameWithRetry(from, to) {
  const delays = [0, 20, 60, 140, 300];
  let last;
  for (const delay of delays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await rename(from, to);
      return;
    } catch (error) {
      last = error;
      if (!error || !['EACCES', 'EBUSY', 'EPERM'].includes(error.code)) break;
    }
  }
  throw last;
}

/**
 * Before the first write that changes the stored schema version, keep the old
 * file as workspace.v<old>.backup.json. This is schema-agnostic on purpose: the
 * host must not learn the workspace schema, it only has to make rollback and
 * recovery possible when a user upgrades the plugin.
 */
async function backupOnVersionChange(nextVersion) {
  const file = workspaceFile();
  let previous;
  try {
    previous = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    return null;
  }
  const oldVersion = previous && previous.snapshot ? previous.snapshot.version : undefined;
  if (oldVersion === undefined || oldVersion === nextVersion) return null;
  const backup = join(dirname(file), 'workspace.v' + String(oldVersion) + '.backup.json');
  try {
    await writeFile(backup, JSON.stringify(previous), { encoding: 'utf8', flag: 'wx' });
    return backup;
  } catch (error) {
    // EEXIST: an earlier backup of that version is already the authoritative one.
    if (error && error.code === 'EEXIST') return backup;
    return null;
  }
}

/**
 * Keep the immediately previous file as workspace.prev.json before every write.
 * The versioned backup only fires when the schema moves; this one also covers
 * same-version overwrites (external edits, a reinstall, a bad import), which is
 * exactly the case where a rejected snapshot used to vanish without a copy.
 */
async function keepPreviousFile() {
  const file = workspaceFile();
  try {
    const previous = await readFile(file, 'utf8');
    if (!previous.trim()) return null;
    const target = join(dirname(file), 'workspace.prev.json');
    await writeFile(target, previous, 'utf8');
    return target;
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    return null;
  }
}

async function writeWorkspace(snapshot) {
  const file = workspaceFile();
  await mkdir(dirname(file), { recursive: true });
  await backupOnVersionChange(snapshot && snapshot.version);
  await keepPreviousFile();
  const temp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  try {
    await writeFile(temp, JSON.stringify({ savedAt: Date.now(), snapshot }), 'utf8');
    await renameWithRetry(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

function validSnapshot(snapshot) {
  return !!snapshot
    && typeof snapshot === 'object'
    && snapshot.format === 'paper-os/workspace'
    && typeof snapshot.version === 'number';
}

export function apply(ctx) {
  const register = ctx.connection && ctx.connection.fetch && ctx.connection.fetch.register;
  if (typeof register !== 'function') {
    console.warn('control-your-schedule: connection.fetch is unavailable; host persistence disabled');
    return;
  }

  ctx.effect(() => register({
    path: FONT_ROUTE,
    methods: ['GET'],
    fetch: async () => {
      try {
        const bytes = await readFile(FONT_FILE);
        return new Response(bytes, {
          status: 200,
          headers: {
            'content-type': 'font/woff2',
            'content-length': String(bytes.byteLength),
            // Immutable per version: the filename is stable, so revalidate cheaply.
            'cache-control': 'public, max-age=604800',
          },
        });
      } catch (error) {
        // Missing font is a cosmetic fallback (system Kai), never a hard failure.
        return new Response('font unavailable', { status: 404, headers: { 'cache-control': 'no-store' } });
      }
    },
  }), 'control-your-schedule: bundled handwriting font');

  ctx.effect(() => register({
    path: ROUTE,
    methods: ['GET', 'POST', 'DELETE'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        if (request.method === 'GET') {
          const record = await readWorkspace();
          return json({
            ok: true,
            snapshot: record ? record.snapshot : null,
            savedAt: record ? record.savedAt : null,
          });
        }
        if (request.method === 'DELETE') {
          await rm(workspaceFile(), { force: true });
          return json({ ok: true, cleared: true });
        }
        if (request.method === 'POST') {
          const text = await request.text();
          if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
            return json({ ok: false, error: 'workspace is too large' }, 413);
          }
          let body;
          try {
            body = JSON.parse(text);
          } catch (error) {
            return json({ ok: false, error: 'invalid json' }, 400);
          }
          if (!body || !validSnapshot(body.snapshot)) {
            return json({ ok: false, error: 'invalid workspace snapshot' }, 400);
          }
          await writeWorkspace(body.snapshot);
          return json({ ok: true, savedAt: Date.now() });
        }
        return json({ ok: false, error: 'method not allowed' }, 405);
      } catch (error) {
        const message = error && error.message ? error.message : 'workspace storage failed';
        console.warn('control-your-schedule: workspace route failed:', message);
        return json({ ok: false, error: message }, 500);
      }
    },
  }), 'control-your-schedule: workspace persistence route');
}
