import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesTarget, hitKey, shouldNotify } from '../src/matching.js';
import { parseShareInput, extractIdsFromShareResponse } from '../src/sharelinks.js';
import { findRole } from '../src/groups.js';
import { expandEnv } from '../src/config.js';

const TARGET = { universeIds: [111], placeIds: [222], nameMatch: 'The Hunt' };

test('matches on universe id', () => {
  const p = { userPresenceType: 2, universeId: 111, placeId: 999 };
  assert.equal(matchesTarget(p, TARGET).match, true);
});

test('matches on place id', () => {
  const p = { userPresenceType: 2, placeId: 222 };
  assert.equal(matchesTarget(p, TARGET).match, true);
});

test('matches on root place id', () => {
  const p = { userPresenceType: 2, placeId: 888, rootPlaceId: 222 };
  assert.equal(matchesTarget(p, TARGET).match, true);
});

test('ignores a different experience', () => {
  const p = { userPresenceType: 2, universeId: 777, placeId: 777, lastLocation: 'Adopt Me!' };
  assert.equal(matchesTarget(p, TARGET).match, false);
});

test('ignores anyone not in game', () => {
  for (const type of [0, 1, 3]) {
    assert.equal(matchesTarget({ userPresenceType: type, universeId: 111 }, TARGET).match, false);
  }
});

test('falls back to the location name when ids are unknown', () => {
  const p = { userPresenceType: 2, lastLocation: 'The Hunt: Mega Edition' };
  const v = matchesTarget(p, { nameMatch: 'The Hunt' });
  assert.equal(v.match, true);
  assert.equal(v.confidence, 'name');
});

test('hidden game details are skipped unless opted in', () => {
  const p = { userPresenceType: 2, lastLocation: '' };
  assert.equal(matchesTarget(p, TARGET).match, false);
  assert.equal(matchesTarget(p, TARGET, { notifyOnUnknownGame: true }).confidence, 'unknown');
});

test('dedupe key is per user per server', () => {
  assert.equal(hitKey({ userId: 1, gameId: 'abc' }), '1:abc');
  assert.notEqual(hitKey({ userId: 1, gameId: 'abc' }), hitKey({ userId: 1, gameId: 'def' }));
});

test('re-notify respects the cooldown', () => {
  const now = 1_000_000_000;
  const notified = { '1:abc': now - 10 * 60_000 };
  assert.equal(shouldNotify('1:abc', notified, { renotifyMinutes: 30, now }), false);
  assert.equal(shouldNotify('1:abc', notified, { renotifyMinutes: 5, now }), true);
  assert.equal(shouldNotify('2:xyz', notified, { renotifyMinutes: 30, now }), true);
});

test('parses the links from the brief', () => {
  assert.deepEqual(parseShareInput('https://www.roblox.com/share/g/1200769'), { kind: 'group', groupId: 1200769 });
  assert.deepEqual(parseShareInput('https://www.roblox.com/share/g/4199740'), { kind: 'group', groupId: 4199740 });
  assert.deepEqual(
    parseShareInput(
      'https://www.roblox.com/share?code=50ed9c732699e543871136655798ba15&type=ExperienceDetails&stamp=1789692064455',
    ),
    { kind: 'share', code: '50ed9c732699e543871136655798ba15', type: 'ExperienceDetails' },
  );
  assert.deepEqual(parseShareInput('https://www.roblox.com/games/920587237/Adopt-Me'), { kind: 'place', placeId: 920587237 });
});

test('digs ids out of a nested share payload', () => {
  const payload = { experienceInviteData: { universeId: '123', rootPlaceId: '456', inviterId: '789' } };
  assert.deepEqual(extractIdsFromShareResponse(payload), { placeId: 456, universeId: 123, inviterId: 789 });
});

test('finds ranks by name and by number', () => {
  const roles = [
    { id: 1, name: 'Guest', rank: 1, memberCount: 5 },
    { id: 2, name: 'Team  Member', rank: 100, memberCount: 2700 },
    { id: 3, name: 'Video Star', rank: 200, memberCount: 300 },
  ];
  assert.equal(findRole(roles, 'team member').id, 2);
  assert.equal(findRole(roles, 'Video Star').id, 3);
  assert.equal(findRole(roles, 200).id, 3);
  assert.equal(findRole(roles, 'Nope'), null);
});

test('config expands env placeholders', () => {
  process.env.TEST_HOOK = 'https://discord.test/hook';
  assert.deepEqual(expandEnv({ a: '${TEST_HOOK}', b: [1, '${TEST_HOOK}'] }), {
    a: 'https://discord.test/hook',
    b: [1, 'https://discord.test/hook'],
  });
});
