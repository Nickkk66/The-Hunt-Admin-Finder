#!/usr/bin/env node
/**
 * Turns the links you actually have into the ids watchers.json needs.
 *
 *   npm run resolve "https://www.roblox.com/share/g/1200769"
 *   npm run resolve "https://www.roblox.com/share?code=...&type=ExperienceDetails"
 *   npm run resolve "Fangwing"
 *   npm run resolve "https://www.roblox.com/users/2204301/profile"
 */
import { loadEnv } from './config.js';
import { RobloxClient } from './robloxClient.js';
import { getRoles, getGroup } from './groups.js';
import { fetchUsersByIds, fetchUsersByNames } from './users.js';
import { parseShareInput, resolveShareCode, extractIdsFromShareResponse } from './sharelinks.js';
import { universeIdForPlace, getUniverseInfo } from './universes.js';
import { log } from './log.js';

async function describeGroup(client, groupId) {
  const group = await getGroup(client, groupId);
  console.log(`\nGroup ${groupId}: ${group?.name ?? '(unknown)'} - ${group?.memberCount ?? '?'} members`);
  const roles = await getRoles(client, groupId);
  console.log('Ranks:');
  for (const r of roles) {
    console.log(`  rank ${String(r.rank).padStart(3)}  roleSetId ${r.id}  ${r.memberCount ?? '?'} members  "${r.name}"`);
  }
  console.log(`\nwatchers.json -> "groupId": ${groupId}, "rank": "<one of the names above>"`);
}

async function describeExperience(client, { placeId, universeId }) {
  if (!universeId && placeId) universeId = await universeIdForPlace(client, placeId);
  const info = universeId ? await getUniverseInfo(client, universeId).catch(() => null) : null;

  console.log(`\nExperience: ${info?.name ?? '(name unavailable)'}`);
  console.log(`  universeId : ${universeId ?? '(unresolved)'}`);
  console.log(`  rootPlaceId: ${info?.rootPlaceId ?? placeId ?? '(unresolved)'}`);
  console.log(`  playing now: ${info?.playing ?? '?'}`);
  console.log('\nwatchers.json ->');
  console.log(
    JSON.stringify(
      { target: { universeIds: [universeId].filter(Boolean), placeIds: [info?.rootPlaceId ?? placeId].filter(Boolean) } },
      null,
      2,
    ),
  );
}

async function describeUsers(client, { userIds = [], usernames = [] }) {
  const found = [];
  if (usernames.length) {
    const hits = await fetchUsersByNames(client, usernames);
    found.push(...hits);
    for (const name of usernames) {
      if (!hits.some((u) => u.name.toLowerCase() === name.toLowerCase())) {
        console.log(`\nNo Roblox account is called "${name}".`);
      }
    }
  }
  if (userIds.length) found.push(...(await fetchUsersByIds(client, userIds)));

  if (!found.length) {
    console.log('\nNothing resolved. Double-check the spelling, or grab the id from the profile url.');
    return;
  }

  console.log('');
  for (const u of found) {
    console.log(`  ${u.name} (display "${u.displayName ?? u.name}")  userId ${u.id}`);
    console.log(`    https://www.roblox.com/users/${u.id}/profile`);
  }
  console.log('\nwatchers.json -> "users": [');
  console.log(
    found
      .map((u) => `  { "userId": ${u.id}, "username": ${JSON.stringify(u.name)}, "note": "" }`)
      .join(',\n'),
  );
  console.log(']');
  console.log(
    '\nNames are not unique - Roblox lets a freed-up name be taken again. If you got this ' +
      'name off a stream, check the profile link above is the person you meant before you trust the alert.',
  );
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.log('usage: npm run resolve "<roblox link, place id, group id or username>"');
    process.exitCode = 1;
    return;
  }

  await loadEnv();
  const client = new RobloxClient({ cookie: process.env.ROBLOX_COOKIE || '' });
  const parsed = parseShareInput(input);

  switch (parsed.kind) {
    case 'group':
      await describeGroup(client, parsed.groupId);
      break;

    case 'place':
      await describeExperience(client, { placeId: parsed.placeId });
      break;

    case 'user':
      await describeUsers(client, { userIds: [parsed.userId] });
      break;

    case 'username':
      await describeUsers(client, { usernames: [parsed.username] });
      break;

    case 'share': {
      if (!client.authenticated) {
        log.warn('share links resolve only with a ROBLOX_COOKIE set; this will probably 401');
      }
      const payload = await resolveShareCode(client, parsed.code, parsed.type);
      log.debug(JSON.stringify(payload, null, 2));
      const ids = extractIdsFromShareResponse(payload);
      if (!ids.placeId && !ids.universeId) {
        console.log('\nCould not find ids in the response. Raw payload:');
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      await describeExperience(client, ids);
      break;
    }

    case 'id':
      console.log(`Bare id ${parsed.id} is ambiguous. Trying it as a group first, then as a place.\n`);
      await describeGroup(client, parsed.id).catch((e) => console.log(`  not a group: ${e.message}`));
      await describeExperience(client, { placeId: parsed.id }).catch((e) => console.log(`  not a place: ${e.message}`));
      break;

    default:
      console.log(`Did not recognise "${input}".`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  log.error(err.stack || err.message);
  process.exitCode = 1;
});
