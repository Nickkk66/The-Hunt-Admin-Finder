import test from 'node:test';
import assert from 'node:assert/strict';
import { RobloxClient, RobloxApiError } from '../src/robloxClient.js';

function stub(responses) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    const next = responses.shift();
    if (!next) throw new Error(`no stubbed response for ${url}`);
    return next();
  };
  return calls;
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('retries once with a fresh csrf token after a 403', async () => {
  const calls = stub([
    () => json({ errors: [{ message: 'Token Validation Failed' }] }, 403, { 'x-csrf-token': 'TOKEN123' }),
    () => json({ userPresences: [] }),
  ]);
  const client = new RobloxClient({ cookie: 'x', minIntervalMs: 0 });
  const res = await client.post('https://presence.roblox.com/v1/presence/users', { userIds: [1] });
  assert.deepEqual(res, { userPresences: [] });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers['x-csrf-token'], 'TOKEN123');
});

test('honours retry-after on a 429', async () => {
  stub([
    () => json({}, 429, { 'retry-after': '0.05' }),
    () => json({ ok: true }),
  ]);
  const client = new RobloxClient({ cookie: 'x', minIntervalMs: 0 });
  const started = Date.now();
  assert.deepEqual(await client.get('https://groups.roblox.com/v1/groups/1'), { ok: true });
  assert.ok(Date.now() - started >= 45, 'should have waited out the retry-after');
});

test('gives up on a persistent 401 with a helpful message', async () => {
  stub([() => json({ errors: [{ message: 'Authorization has been denied' }] }, 401)]);
  const client = new RobloxClient({ minIntervalMs: 0 });
  await assert.rejects(
    () => client.get('https://groups.roblox.com/v1/groups/1/roles/2/users'),
    (err) => err instanceof RobloxApiError && err.status === 401 && /ROBLOSECURITY/.test(err.body),
  );
});

test('does not loop forever when the same csrf token keeps failing', async () => {
  const calls = stub([
    () => json({}, 403, { 'x-csrf-token': 'SAME' }),
    () => json({}, 403, { 'x-csrf-token': 'SAME' }),
  ]);
  const client = new RobloxClient({ cookie: 'x', minIntervalMs: 0 });
  await assert.rejects(() => client.post('https://presence.roblox.com/v1/presence/users', {}));
  assert.equal(calls.length, 2);
});
