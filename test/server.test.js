import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STATE_DIR = await mkdtemp(join(tmpdir(), 'hunt-server-'));
// the dashboard tails whatever the console gets, so the sink respects LOG_LEVEL
process.env.LOG_LEVEL = 'info';

const { startServer } = await import('../src/server.js');

const realFetch = globalThis.fetch;
const posted = [];

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, init);
  if (u.includes('discord')) {
    posted.push(JSON.parse(init.body));
    return new Response(null, { status: 204 });
  }
  if (u.includes('users/authenticated')) {
    return new Response(JSON.stringify({ id: 42, name: 'me' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  throw new Error(`unstubbed: ${u}`);
};

const { server } = startServer({ port: 0 });
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  server.close();
  globalThis.fetch = realFetch;
  await rm(process.env.STATE_DIR, { recursive: true, force: true });
});

test('serves the same page github pages serves', async () => {
  const res = await realFetch(base + '/');
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(html, /Hunt Watcher/);
  assert.match(html, /api\/status/, 'the page must be able to detect live mode');
});

test('reports idle status before anything starts', async () => {
  const res = await realFetch(base + '/api/status');
  const body = await res.json();
  assert.equal(body.mode, 'local');
  assert.equal(body.running, false);
  assert.deepEqual(body.watchers, []);
});

test('proxies a webhook test', async () => {
  const res = await realFetch(base + '/api/test-webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ webhookUrl: 'https://discord.com/api/webhooks/1/x', name: 'silver-wings' }),
  });
  assert.equal(res.status, 200);
  assert.equal(posted.length, 1);
  assert.match(posted[0].embeds[0].description, /silver-wings/);
});

test('refuses to start without a cookie', async () => {
  const res = await realFetch(base + '/api/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      cookie: '',
      config: { watchers: [{ name: 'x', groupId: 1, rank: 'Team Member', target: { nameMatch: 'The Hunt' } }] },
    }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /cookie/i);
});

test('rejects a config that would never work', async () => {
  const res = await realFetch(base + '/api/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cookie: 'fake', config: { watchers: [{ name: 'x', groupId: 1 }] } }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /rank|target/i);
});

test('streams log lines to the dashboard', async () => {
  const res = await realFetch(base + '/api/logs?since=-1');
  const body = await res.json();
  assert.ok(Array.isArray(body.lines));
  assert.ok(body.lines.some((l) => /dashboard on http/.test(l.message)), 'startup line should be buffered');
});
