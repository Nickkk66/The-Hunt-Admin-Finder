import { createLogger } from './log.js';

const HEADSHOT_URL = 'https://thumbnails.roblox.com/v1/users/avatar-headshot';

/**
 * Avatar headshots for the Discord embed.
 *
 * The old `roblox.com/headshot-thumbnail/image?userId=` url this project used to
 * embed is a dead endpoint - Discord fetches it, gets nothing back, and renders
 * the embed with an empty thumbnail slot. The thumbnails API is the current way:
 * it answers with a real rbxcdn url, which Discord can actually load.
 *
 * Returns a Map of userId -> image url. Anyone whose thumbnail is still
 * rendering (`state: "Pending"`) or blocked is left out on purpose: a broken
 * image is worse in an embed than no image.
 */
export async function fetchHeadshots(client, userIds, { size = '150x150', logger = createLogger('thumbs') } = {}) {
  const out = new Map();
  const ids = [...new Set(userIds)].filter(Boolean);

  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const url = `${HEADSHOT_URL}?userIds=${chunk.join(',')}&size=${size}&format=Png&isCircular=false`;
    let res;
    try {
      res = await client.get(url);
    } catch (err) {
      // Cosmetic data. An alert with no picture still tells you where to go.
      logger.warn(`headshot lookup failed (${err.message}); alerts will have no avatar`);
      continue;
    }
    for (const entry of res?.data ?? []) {
      if (entry.state === 'Completed' && entry.imageUrl) out.set(entry.targetId, entry.imageUrl);
    }
  }

  return out;
}
