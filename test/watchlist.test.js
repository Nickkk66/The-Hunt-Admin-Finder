import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STATE_DIR = await mkdtemp(join(tmpdir(), 'hunt-list-'));
process.env.LOG_LEVEL = 'error';

const { buildConfig, normalizeUsers } = await import('../src/config.js');
const { RobloxClient } = await import('../src/robloxClient.js');
const { Watcher } = await import('../src/watcher.js');

const TARGET_UNIVERSE = 111;
const TARGET_PLACE = 222;

test.after(() => rm(process.env.STATE_DIR, { recursive: true, force: true }));

// --- config -----------------------------------------------------------------

test('normalizeUsers takes ids, names, profile links and objects', () => {
  const list = normalizeUsers([
    2204301,
    '65141229',
    'WaffleTrades',
    '@javie12',
    'https://www.roblox.com/users/431900130/profile',
    { userId: 1, username: 'someone', note: 'why', enabled: false },
  ]);

  assert.deepEqual(
    list.map((u) => [u.userId, u.username, u.enabled]),
    [
      [2204301, null, true],
      [65141229, null, true],
      [null, 'WaffleTrades', true],
      [null, 'javie12', true],
      [431900130, null, true],
      [1, 'someone', false],
    ],
  );
  assert.equal(list[5].note, 'why');
  assert.equal(normalizeUsers(undefined), null, 'a watcher with no list stays a group watcher');
});

const base = {
  name: 'obsidian-wings',
  itemName: 'Obsidian Wings',
  webhookUrl: 'https://discord.test/api/webhooks/1/x',
  target: { nameMatch: 'The Hunt' },
};
const build = (w) => buildConfig({ watchers: [{ ...base, ...w }] }).watchers[0];

test('a watch-list watcher needs no group, and a group watcher still needs a rank', () => {
  const w = build({ users: [2204301] });
  assert.equal(w.users.length, 1);
  assert.equal(w.groupId, undefined);

  assert.throws(() => build({ groupId: 1200769 }), /missing "rank"/);
  assert.throws(() => build({}), /missing "groupId" \(or a "users" list\)/);
});

test('config rejects watch lists that would silently watch nobody', () => {
  assert.throws(() => build({ users: [] }), /"users" is empty/);
  assert.throws(
    () => build({ users: [{ userId: 1, enabled: false }] }),
    /every entry in "users" is disabled/,
  );
  assert.throws(() => build({ users: [{ note: 'no id, no name' }] }), /neither a userId nor a username/);
  assert.throws(
    () => build({ users: [2204301], groupId: 1200769, rank: 'Team Member' }),
    /pick one/,
  );
});

// --- watcher ----------------------------------------------------------------

/**
 * 2204301 is configured by id, "WaffleTrades" only by name, and "Ghostacct" is
 * a name Roblox does not know. Only the first two should end up watched, and
 * only the one in the target game should ping.
 */
function makeNetwork({ usernamesFail = false } = {}) {
  const calls = { webhooks: [], presenceIds: [] };

  const presenceFor = (id) => {
    if (id === 2204301) {
      return {
        userId: id,
        userPresenceType: 2,
        universeId: TARGET_UNIVERSE,
        placeId: TARGET_PLACE,
        gameId: 'job-1',
        lastLocation: 'The Hunt',
      };
    }
    return { userId: id, userPresenceType: 1, lastLocation: 'Website' };
  };

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(init.body) : null;
    const json = (payload, status = 200) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

    if (u.includes('discord')) {
      calls.webhooks.push(body);
      return new Response(null, { status: 204 });
    }
    if (u.includes('usernames/users')) {
      if (usernamesFail) return json({ errors: [{ message: 'nope' }] }, 503);
      const known = { waffletrades: { id: 2672900117, name: 'WaffleTrades', displayName: 'Waffle' } };
      return json({
        data: body.usernames
          .map((n) => known[n.toLowerCase()] && { requestedUsername: n, ...known[n.toLowerCase()] })
          .filter(Boolean),
      });
    }
    if (/users\.roblox\.com\/v1\/users$/.test(u)) {
      const names = { 2204301: 'Fangwing', 2672900117: 'WaffleTrades' };
      return json({
        data: body.userIds
          .filter((id) => names[id])
          .map((id) => ({ id, name: names[id], displayName: names[id] })),
      });
    }
    if (u.includes('presence/users')) {
      calls.presenceIds.push(...body.userIds);
      return json({ userPresences: body.userIds.map(presenceFor) });
    }
    if (u.includes('games?universeIds=')) {
      return json({ data: [{ id: TARGET_UNIVERSE, name: 'The Hunt', rootPlaceId: TARGET_PLACE }] });
    }
    if (u.includes('groups.roblox.com')) throw new Error('a watch list must not touch the group api');
    throw new Error(`unstubbed: ${u}`);
  };

  return calls;
}

function makeWatcher(users, overrides = {}) {
  // maxRetries 0 so the 'lookup is down' case fails fast instead of backing off for 30s.
  const client = new RobloxClient({ cookie: 'fake', minIntervalMs: 0, maxConcurrent: 4, maxRetries: 0 });
  return new Watcher(client, {
    ...build({ users }),
    name: `list-${Math.random().toString(36).slice(2, 8)}`,
    target: { universeIds: [TARGET_UNIVERSE], placeIds: [TARGET_PLACE], nameMatch: 'The Hunt' },
    probe: { enabled: false },
    ...overrides,
  });
}

test('resolves a watch list, skips names Roblox does not know, and pings the hit', async () => {
  const calls = makeNetwork();
  const w = makeWatcher([
    { userId: 2204301, username: 'Fangwing', note: "Zarc's alt" },
    'WaffleTrades',
    'Ghostacct',
    { userId: 999, username: 'Parked', enabled: false },
  ]);

  await w.init();
  assert.deepEqual(w.members.map((m) => m.userId), [2204301, 2672900117]);
  assert.equal(w.members[1].username, 'WaffleTrades', 'a name-only entry gets resolved to an id');
  assert.ok(!w.members.some((m) => m.userId === 999), 'a parked entry is not watched');

  const hits = await w.tick();
  assert.deepEqual(hits.map((h) => h.userId), [2204301]);
  assert.equal(hits[0].note, "Zarc's alt", 'the note rides along to Discord');
  assert.equal(calls.webhooks.length, 1);
  assert.match(calls.webhooks[0].embeds[0].footer.text, /watch list/i);
  assert.ok(!calls.presenceIds.includes(999));
});

test('a dead username lookup does not take the ids down with it', async () => {
  makeNetwork({ usernamesFail: true });
  const w = makeWatcher([{ userId: 2204301, username: 'Fangwing' }, 'WaffleTrades']);

  await w.init();
  assert.deepEqual(w.members.map((m) => m.userId), [2204301]);
  assert.deepEqual((await w.tick()).map((h) => h.userId), [2204301]);
});

test('the same person twice is watched once', async () => {
  const calls = makeNetwork();
  // Once by id, once by the name that resolves to that same id.
  const w = makeWatcher([{ userId: 2672900117, note: 'by id' }, 'WaffleTrades', 2672900117]);

  await w.init();
  assert.deepEqual(w.members.map((m) => m.userId), [2672900117]);
  assert.equal(w.members[0].note, 'by id', 'the first entry\'s note survives');

  await w.tick();
  assert.deepEqual(calls.presenceIds, [2672900117], 'a duplicate must not cost a presence slot');
});

test('a live rename wins over the name in the config', async () => {
  makeNetwork();
  // 2204301 is "Fangwing" upstream; the config still calls them by an old name.
  const w = makeWatcher([{ userId: 2204301, username: 'OldName' }]);
  await w.init();
  assert.equal(w.members[0].username, 'Fangwing');
});
