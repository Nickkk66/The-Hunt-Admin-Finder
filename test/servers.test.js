import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findServer, playerCounts, describeCounts, recordSightings } from '../src/servers.js';
import { buildHitEmbed } from '../src/discord.js';

function pagedClient(pages) {
  const calls = [];
  return {
    calls,
    async get(url) {
      calls.push(url);
      const cursor = new URL(url).searchParams.get('cursor');
      return pages[cursor ? Number(cursor) : 0];
    },
  };
}

test('finds a server a few pages deep', async () => {
  const client = pagedClient([
    { data: [{ id: 'a', playing: 30, maxPlayers: 30 }], nextPageCursor: '1' },
    { data: [{ id: 'b', playing: 12, maxPlayers: 30 }], nextPageCursor: null },
  ]);
  assert.deepEqual(await findServer(client, 1, 'b'), { playing: 12, maxPlayers: 30 });
  assert.equal(client.calls.length, 2);
});

test('gives up after maxPages', async () => {
  const client = pagedClient([{ data: [], nextPageCursor: '0' }]);
  assert.equal(await findServer(client, 1, 'zzz', { maxPages: 3 }), null);
  assert.equal(client.calls.length, 3);
});

test('counts combine the server and the whole game', async () => {
  const client = pagedClient([{ data: [{ id: 'job', playing: 30, maxPlayers: 30 }] }]);
  const counts = await playerCounts(
    client,
    { placeId: 1, gameId: 'job', universeId: 9 },
    { getUniverseInfo: async () => ({ playing: 4321 }) },
  );
  assert.deepEqual(counts, { serverPlaying: 30, serverMax: 30, gamePlaying: 4321 });
  assert.match(describeCounts(counts), /30\/30 in their server \(FULL\), 4,321 playing/);

  const embed = buildHitEmbed({ userId: 1, username: 'x', displayName: 'x', statusText: 's', ...counts });
  assert.match(embed.fields.find((f) => f.name === 'Their server').value, /30\/30\*\* 🔴 FULL/);
  assert.match(embed.fields.find((f) => f.name === 'Playing the game').value, /4,321/);
  assert.ok(!embed.fields.some((f) => f.name === 'Status'));
});

test('hidden server still reports the game total', async () => {
  const counts = await playerCounts({ get: async () => null }, { placeId: 1, universeId: 9 }, {
    getUniverseInfo: async () => ({ playing: 50 }),
  });
  assert.deepEqual(counts, { serverPlaying: null, serverMax: null, gamePlaying: 50 });
});

test('writes sightings to a csv', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hunt-sightings-'));
  const path = join(dir, 's.csv');
  const hit = { username: 'a,b', userId: 1, gameName: 'The Hunt', placeId: 2, gamePlaying: 7, confidence: 'exact' };
  await recordSightings('w', [hit], { path, now: new Date(0) });
  await recordSightings('w', [hit], { path, now: new Date(0) });
  const lines = (await readFile(path, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^time,watcher,username/);
  assert.equal(lines[1], '1970-01-01T00:00:00.000Z,w,"a,b",1,The Hunt,2,,,,7,exact');
  await rm(dir, { recursive: true, force: true });
});

test('embed title is a clickable join link to the exact server', () => {
  const embed = buildHitEmbed({ userId: 5, username: 'Deeter', displayName: 'Deeter', placeId: 7, gameId: 'abc', gameName: 'The Hunt' });
  assert.equal(embed.url, 'https://www.roblox.com/games/start?placeId=7&gameInstanceId=abc');
  assert.match(embed.title, /Join their server/);
  assert.equal(embed.author.name, 'Deeter');

  const hidden = buildHitEmbed({ userId: 5, username: 'Deeter', placeId: 7, gameName: 'The Hunt' });
  assert.equal(hidden.url, 'https://www.roblox.com/games/start?placeId=7');
  assert.match(hidden.description, /server is hidden/);
});

test('mentions accept ids, roles and @here', async () => {
  const { mentionFor } = await import('../src/discord.js');
  assert.equal(mentionFor('123456789012345678'), '<@123456789012345678>');
  assert.equal(mentionFor('role:123456789012345678'), '<@&123456789012345678>');
  assert.equal(mentionFor('@here'), '@here');
  assert.equal(mentionFor(''), '');
  assert.equal(mentionFor('bob'), '');
});
