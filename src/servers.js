import { appendFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

/**
 * Finds one public server by its job id and returns how full it is.
 * The servers endpoint has no lookup-by-id, so this pages through the list
 * (100 per page) and gives up after `maxPages` to stay off the rate limiter.
 */
export async function findServer(client, placeId, gameId, { maxPages = 10 } = {}) {
  if (!placeId || !gameId) return null;
  let cursor = '';
  for (let page = 0; page < maxPages; page += 1) {
    const url =
      `https://games.roblox.com/v1/games/${placeId}/servers/Public?limit=100&sortOrder=Desc` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const res = await client.get(url);
    const hit = res?.data?.find((s) => s.id === gameId);
    if (hit) return { playing: hit.playing ?? null, maxPlayers: hit.maxPlayers ?? null };
    cursor = res?.nextPageCursor;
    if (!cursor) break;
  }
  return null;
}

/** Player counts for a hit: their exact server (when visible) and the whole experience. */
export async function playerCounts(client, { placeId, gameId, universeId }, { getUniverseInfo, log } = {}) {
  const counts = { serverPlaying: null, serverMax: null, gamePlaying: null };

  if (universeId && getUniverseInfo) {
    const info = await getUniverseInfo(client, universeId).catch((err) => {
      log?.debug(`universe ${universeId} lookup failed: ${err.message}`);
      return null;
    });
    counts.gamePlaying = info?.playing ?? null;
  }

  if (placeId && gameId) {
    const server = await findServer(client, placeId, gameId).catch((err) => {
      log?.debug(`server lookup for ${gameId} failed: ${err.message}`);
      return null;
    });
    if (server) {
      counts.serverPlaying = server.playing;
      counts.serverMax = server.maxPlayers;
    }
  }

  return counts;
}

export function describeCounts(hit) {
  const parts = [];
  if (hit.serverPlaying != null) {
    const full = hit.serverMax != null && hit.serverPlaying >= hit.serverMax ? ' (FULL)' : '';
    parts.push(`${hit.serverPlaying}/${hit.serverMax ?? '?'} in their server${full}`);
  } else if (hit.gameId) {
    parts.push('their server is not in the public list (private/reserved or too deep to find)');
  }
  if (hit.gamePlaying != null) parts.push(`${hit.gamePlaying.toLocaleString('en-US')} playing the game`);
  return parts.join(', ');
}

/** userId -> headshot image url (Discord needs a direct image, not the redirecting legacy endpoint). */
export async function headshotUrls(client, userIds) {
  const out = new Map();
  if (!userIds.length) return out;
  const res = await client.get(
    `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userIds.join(',')}&size=150x150&format=Png&isCircular=false`,
  );
  for (const t of res?.data ?? []) if (t.state === 'Completed' && t.imageUrl) out.set(t.targetId, t.imageUrl);
  return out;
}

const HEADER = 'time,watcher,username,userId,game,placeId,serverId,serverPlaying,serverMax,gamePlaying,confidence\n';

const csv = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Appends one row per sighting so there is a written record of who was on and how busy it was. */
export async function recordSightings(watcherName, hits, { path = process.env.SIGHTINGS_FILE || 'sightings.csv', now = new Date() } = {}) {
  if (!hits.length) return;
  if (!existsSync(path)) await writeFile(path, HEADER);
  const rows = hits.map((h) =>
    [
      now.toISOString(),
      watcherName,
      h.username,
      h.userId,
      h.gameName,
      h.placeId,
      h.gameId,
      h.serverPlaying,
      h.serverMax,
      h.gamePlaying,
      h.confidence,
    ]
      .map(csv)
      .join(','),
  );
  await appendFile(path, rows.join('\n') + '\n');
}
