import { createLogger } from './log.js';

const PRESENCE_URL = 'https://presence.roblox.com/v1/presence/users';

export const PresenceType = {
  OFFLINE: 0,
  ONLINE: 1,
  IN_GAME: 2,
  IN_STUDIO: 3,
};

export const presenceName = (t) =>
  ({ 0: 'Offline', 1: 'Online (website/app)', 2: 'In game', 3: 'In Studio' })[t] ?? `Unknown (${t})`;

/**
 * Looks up presence for an arbitrary number of users, in batches.
 * Roblox caps the payload, so keep batchSize <= 100.
 *
 * Heads up: placeId / universeId / gameId come back null unless the user's
 * privacy settings let you see what they are playing. Presence type still
 * tells you they are in *something*.
 */
export async function fetchPresences(client, userIds, { batchSize = 50, onBatch, logger = createLogger('presence') } = {}) {
  const out = [];
  const size = Math.max(1, Math.min(100, batchSize));

  for (let i = 0; i < userIds.length; i += size) {
    const chunk = userIds.slice(i, i + size);
    const res = await client.post(PRESENCE_URL, { userIds: chunk });
    const batch = res?.userPresences ?? [];
    out.push(...batch);
    logger.debug(`presence ${Math.min(i + size, userIds.length)}/${userIds.length}`);
    onBatch?.(out.length, userIds.length);
  }

  return out;
}
