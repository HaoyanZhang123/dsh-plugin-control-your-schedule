import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const name = 'dsh-plugin-control-your-schedule';
export const inject = ['connection'];

const ROUTE = '/api/control-your-schedule/workspace';
const MAX_BYTES = 32 * 1024 * 1024;

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

async function writeWorkspace(snapshot) {
  const file = workspaceFile();
  await mkdir(dirname(file), { recursive: true });
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
