import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STATE_DIR = await mkdtemp(join(tmpdir(), 'hunt-probe-'));
process.env.LOG_LEVEL = 'error';

const { RobloxClient } = await import('../src/robloxClient.js');
const { Watcher } = await import('../src/watcher.js');

const TARGET_UNIVERSE = 111;
const TARGET_PLACE = 222;

/**
 * 1001 visible in the target, 1013 hidden but revealed by following (in the
 * target), 1017 hidden and revealed in a different game, 1019 hidden and stays
 * hidden, 1023 hidden but already followed by the user.
 */
function makeNetwork() {
  const calls = { follow: [], unfollow: [], followingExists: 0, webhooks: [] };
  const revealed = new Set();

  const presenceFor = (id) => {
    const base = { userId: id, userPresenceType: 0, lastLocation: '' };
    if (id === 1001) {
      return { ...base, userPresenceType: 2, universeId: TARGET_UNIVERSE, placeId: TARGET_PLACE, gameId: 'job-visible', lastLocation: 'The Hunt' };
    }
    if (id === 1013) {
      return revealed.has(id)
        ? { ...base, userPresenceType: 2, universeId: TARGET_UNIVERSE, placeId: TARGET_PLACE, gameId: 'job-hidden-1', lastLocation: 'The Hunt' }
        : { ...base, userPresenceType: 2 };
    }
    if (id === 1017) {
      return revealed.has(id)
        ? { ...base, userPresenceType: 2, universeId: 999, placeId: 999, gameId: 'job-other', lastLocation: 'Adopt Me!' }
        : { ...base, userPresenceType: 2 };
    }
    if (id === 1019 || id === 1023) return { ...base, userPresenceType: 2 };
    return base;
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
    if (u.includes('users/authenticated')) return json({ id: 42, name: 'me' });
    if (/groups\/\d+$/.test(u)) return json({ id: 1, name: 'Fake Group', memberCount: 9000 });
    if (u.endsWith('/roles')) return json({ roles: [{ id: 8, name: 'Team Member', rank: 100, memberCount: 5 }] });
    if (u.includes('/roles/8/users')) {
      return json({
        nextPageCursor: null,
        data: [1001, 1013, 1017, 1019, 1023].map((id) => ({ userId: id, username: `u${id}`, displayName: `U ${id}` })),
      });
    }
    if (u.includes('presence/users')) return json({ userPresences: body.userIds.map(presenceFor) });
    if (u.includes('following-exists')) {
      calls.followingExists += 1;
      return json({ followings: body.targetUserIds.map((id) => ({ userId: id, isFollowing: id === 1023 })) });
    }
    if (u.includes('/follow')) {
      const id = Number(u.match(/users\/(\d+)\/follow/)[1]);
      calls.follow.push(id);
      if (id === 1013 || id === 1017) revealed.add(id); // follower-only joins
      return json({ success: true });
    }
    if (u.includes('/unfollow')) {
      const id = Number(u.match(/users\/(\d+)\/unfollow/)[1]);
      calls.unfollow.push(id);
      revealed.delete(id);
      return json({ success: true });
    }
        if (u.includes('avatar-headshot')) {
      const ids = new URL(u).searchParams.get('userIds').split(',').map(Number);
      return json({ data: ids.map((id) => ({ targetId: id, state: 'Completed', imageUrl: `https://tr.rbxcdn.com/${id}.png` })) });
    }
    if (u.includes('/universe')) return json({ universeId: TARGET_UNIVERSE });
    if (u.includes('games?universeIds=')) return json({ data: [{ id: TARGET_UNIVERSE, name: 'The Hunt', rootPlaceId: TARGET_PLACE }] });
    throw new Error(`unstubbed: ${u}`);
  };

  return calls;
}

function makeWatcher(overrides = {}) {
  const client = new RobloxClient({ cookie: 'fake', minIntervalMs: 0, maxConcurrent: 4 });
  return new Watcher(client, {
    name: `probe-${Math.random().toString(36).slice(2, 8)}`,
    itemName: 'Silver Wings',
    groupId: 1,
    rank: 'Team Member',
    webhookUrl: 'https://discord.test/api/webhooks/1/x',
    pollIntervalSeconds: 5,
    memberCacheHours: 6,
    presenceBatchSize: 50,
    renotifyMinutes: 30,
    notifyOnUnknownGame: false,
    target: { universeIds: [TARGET_UNIVERSE], placeIds: [TARGET_PLACE], nameMatch: 'The Hunt' },
    probe: {
      enabled: true,
      maxPerCycle: 10,
      maxActiveFollows: 60,
      minIntervalMs: 0,
      settleMs: 5,
      recheckAttempts: 2,
      keepFollowMinutes: 60,
      targetGraceMinutes: 20,
      opaqueBackoffHours: 12,
      pauseOnErrorMinutes: 30,
      unfollowOnExit: true,
      ...overrides,
    },
  });
}

test.after(() => rm(process.env.STATE_DIR, { recursive: true, force: true }));

test('follows hidden users, notifies on the ones in the target, drops the rest', async () => {
  const calls = makeNetwork();
  const w = makeWatcher();
  await w.init();
  const hits = await w.tick();

  assert.deepEqual(hits.map((h) => h.userId).sort(), [1001, 1013]);
  assert.equal(hits.find((h) => h.userId === 1013).confidence, 'probed');
  assert.equal(hits.find((h) => h.userId === 1001).confidence, 'exact');

  // 1023 is already followed by the user, so we never touch them.
  assert.deepEqual(calls.follow.sort(), [1013, 1017, 1019]);
  assert.ok(!calls.unfollow.includes(1023), 'must never unfollow a pre-existing follow');

  // Following did nothing for 1019, so it is dropped immediately.
  assert.deepEqual(calls.unfollow, [1019]);

  // The two that revealed themselves stay followed for now.
  assert.deepEqual(Object.keys(w.state.follows).map(Number).sort(), [1013, 1017]);
  assert.equal(w.state.probe[1023].outcome, 'preexisting-opaque');
  assert.equal(w.state.probe[1019].outcome, 'opaque');
  assert.equal(w.state.probe[1017].outcome, 'revealed-other');
  assert.equal(calls.webhooks.length, 1);
});

test('does not re-probe an opaque user until the backoff lapses', async () => {
  const calls = makeNetwork();
  const w = makeWatcher();
  await w.init();
  await w.tick();
  const followsAfterFirst = calls.follow.length;

  await w.tick();
  assert.equal(calls.follow.length, followsAfterFirst, '1019 and 1023 must not be re-followed');
});

test('keeps the follow while the target is still in the game, then drops it', async () => {
  makeNetwork();
  const w = makeWatcher();
  await w.init();
  await w.tick();

  assert.ok(w.state.follows[1013], 'still following the person we want to join');

  // Pretend the keep window and the grace window both lapsed.
  const old = Date.now() - 3 * 60 * 60 * 1000;
  w.state.follows[1013].revealedAt = old;
  w.state.follows[1013].lastTargetSeenAt = old;
  w.state.follows[1017].revealedAt = old;

  await w.cleanupFollows();
  assert.equal(Object.keys(w.state.follows).length, 0);
});

test('cleanup keeps follows for someone still in the target game', async () => {
  makeNetwork();
  const w = makeWatcher();
  await w.init();
  await w.tick();

  await w.cleanupFollows();
  assert.ok(w.state.follows[1013], 'do not slam the door on a server you are about to join');
  assert.ok(!w.state.follows[1017], 'no reason to keep following someone in a different game');
});

test('dry run follows nobody', async () => {
  const calls = makeNetwork();
  const w = makeWatcher({ dryRun: true });
  await w.init();
  const hits = await w.tick();

  assert.deepEqual(calls.follow, []);
  assert.deepEqual(hits.map((h) => h.userId), [1001]);
});

test('probing disabled leaves hidden users alone', async () => {
  const calls = makeNetwork();
  const w = makeWatcher({ enabled: false });
  await w.init();
  const hits = await w.tick();

  assert.deepEqual(calls.follow, []);
  assert.equal(calls.followingExists, 0);
  assert.deepEqual(hits.map((h) => h.userId), [1001]);
});

test('a captcha challenge pauses probing instead of hammering', async () => {
  const calls = makeNetwork();
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (/\/users\/\d+\/follow$/.test(String(url))) {
      return new Response(JSON.stringify({ errors: [{ message: 'Challenge is required' }] }), {
        status: 403,
        headers: { 'content-type': 'application/json', 'rblx-challenge-type': 'captcha' },
      });
    }
    return inner(url, init);
  };

  const w = makeWatcher();
  await w.init();
  await w.tick();

  assert.ok(w.state.probePausedUntil > Date.now(), 'probing should be paused');
  assert.equal(calls.follow.length, 0);
  assert.ok(calls.followingExists >= 1);

  const before = w.state.probePausedUntil;
  await w.tick();
  assert.equal(w.state.probePausedUntil, before, 'second tick must not retry while paused');
});
