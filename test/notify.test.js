import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STATE_DIR = await mkdtemp(join(tmpdir(), 'hunt-notify-'));
process.env.LOG_LEVEL = 'error';
process.env.SIGHTINGS_FILE = join(process.env.STATE_DIR, 'sightings.csv');

const { RobloxClient } = await import('../src/robloxClient.js');
const { Watcher } = await import('../src/watcher.js');
const { recentFindings, clearFindings } = await import('../src/findings.js');
const { itemEmoji } = await import('../src/discord.js');

const TARGET_UNIVERSE = 111;
const TARGET_PLACE = 222;

/** 1001 and 1002 are both visibly in the target game. */
function makeNetwork() {
  const calls = { webhooks: [] };

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
    if (u.endsWith('/roles')) return json({ roles: [{ id: 8, name: 'Video Star', rank: 100, memberCount: 2 }] });
    if (u.includes('/roles/8/users')) {
      return json({
        nextPageCursor: null,
        data: [
          { userId: 1001, username: 'collie', displayName: 'Collie' },
          { userId: 1002, username: 'muffin', displayName: 'Muffin' },
        ],
      });
    }
    if (u.includes('presence/users')) {
      return json({
        userPresences: body.userIds.map((id) => ({
          userId: id,
          userPresenceType: 2,
          universeId: TARGET_UNIVERSE,
          placeId: TARGET_PLACE,
          gameId: `job-${id}`,
          lastLocation: 'The Hunt',
        })),
      });
    }
    if (u.includes('/universe')) return json({ universeId: TARGET_UNIVERSE });
    if (u.includes('games?universeIds=')) {
      return json({ data: [{ id: TARGET_UNIVERSE, name: 'The Hunt', rootPlaceId: TARGET_PLACE }] });
    }
    if (u.includes('thumbnails')) return json({ data: [] });
    if (u.includes('games/v1/games')) return json({ data: [] });
    return json({ data: [] });
  };

  return calls;
}

function makeWatcher(overrides = {}) {
  const client = new RobloxClient({ cookie: 'fake', minIntervalMs: 0, maxConcurrent: 4 });
  return new Watcher(client, {
    name: `notify-${Math.random().toString(36).slice(2, 8)}`,
    itemName: 'Golden Wings',
    emoji: '🥇',
    groupId: 1,
    rank: 'Video Star',
    webhookUrl: 'https://discord.test/api/webhooks/1/x',
    webhookUsername: 'Golden Wings Watcher',
    pollIntervalSeconds: 5,
    memberCacheHours: 6,
    presenceBatchSize: 50,
    renotifyMinutes: 30,
    notifyOnUnknownGame: false,
    target: { universeIds: [TARGET_UNIVERSE], placeIds: [TARGET_PLACE], nameMatch: 'The Hunt' },
    probe: { enabled: false },
    ...overrides,
  });
}

test.after(() => rm(process.env.STATE_DIR, { recursive: true, force: true }));

test('infers the medal from the item name, and an explicit emoji wins', () => {
  assert.equal(itemEmoji('Golden Wings'), '🥇');
  assert.equal(itemEmoji('Silver Wings'), '🥈');
  assert.equal(itemEmoji('Something Else'), '🏅');
  assert.equal(itemEmoji('Golden Wings', '👑'), '👑');
});

test('every alert reads the same way, whether or not the player is new', async () => {
  const calls = makeNetwork();
  await clearFindings();
  const w = makeWatcher();
  await w.init();

  await w.tick();
  const first = calls.webhooks.at(-1).content;

  // Second round: same people, no longer newcomers, cooldown cleared.
  w.state.notified = {};
  await w.tick();
  const second = calls.webhooks.at(-1).content;

  assert.equal(first, second, 'a repeat sighting must not be phrased differently');
  assert.doesNotMatch(first, /just showed up/, 'the old duplicated sentence is gone');
  assert.match(first, /(is|are) in The Hunt right now\.$/);
  assert.match(first, /^🥇 /, 'leads with the watcher badge');
});

test('one player and several players use the same sentence shape', async () => {
  const calls = makeNetwork();
  const w = makeWatcher();
  await w.init();
  await w.tick();

  const content = calls.webhooks.at(-1).content;
  assert.match(content, /^🥇 \*\*2\*\* Video Stars are in The Hunt right now\.$/);
});

test('the badge reaches the webhook name and the embed', async () => {
  const calls = makeNetwork();
  const w = makeWatcher();
  await w.init();
  await w.tick();

  const payload = calls.webhooks.at(-1);
  assert.equal(payload.username, '🥇 Golden Wings Watcher');
  assert.match(payload.embeds[0].description, /go get 🥇 \*\*Golden Wings\*\*/);
  assert.match(payload.embeds[0].footer.text, /^🥇 Golden Wings · /);
});

test('with no webhook it still records the find, so the dashboard works alone', async () => {
  makeNetwork();
  await clearFindings();
  const w = makeWatcher({ webhookUrl: '', itemName: 'Silver Wings', emoji: '🥈' });
  await w.init();

  const hits = await w.tick();
  assert.equal(hits.length, 2, 'hits are still returned without a webhook');

  const found = recentFindings();
  assert.equal(found.length, 2);
  assert.equal(found[0].emoji, '🥈');
  assert.equal(found[0].itemName, 'Silver Wings');
  assert.ok(found[0].joinUrl.includes(String(TARGET_PLACE)));
  assert.ok(found.some((f) => f.displayName === 'Collie'));

  assert.ok(Object.keys(w.state.notified).length > 0, 'still deduped so it does not repeat forever');
  const csv = await readFile(process.env.SIGHTINGS_FILE, 'utf8');
  assert.match(csv, /collie/);
});

test('a separate process can read the findings (watcher and dashboard are not the same process)', async () => {
  makeNetwork();
  await clearFindings();
  const w = makeWatcher({ webhookUrl: '' });
  await w.init();
  await w.tick();

  // The launcher runs src/index.js while the dashboard is src/ui.js, so the
  // page only works if findings survive outside the process that made them.
  const { execFileSync } = await import('node:child_process');
  const script = `
    const { loadFindings } = await import(${JSON.stringify(new URL('../src/findings.js', import.meta.url).href)});
    const found = await loadFindings();
    console.log(JSON.stringify(found.map((f) => f.displayName)));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env },
    encoding: 'utf8',
  });
  const names = JSON.parse(out.trim().split('\n').at(-1));
  assert.deepEqual(names.sort(), ['Collie', 'Muffin']);
});
