import { createLogger } from './log.js';

const USERS_V1 = 'https://users.roblox.com/v1';

/** Usernames change; ids do not. Both endpoints cap out well above our list size. */
const BATCH = 100;

const norm = (s) => String(s ?? '').toLowerCase().trim();

/** Looks up display names for ids we already have. */
export async function fetchUsersByIds(client, userIds) {
  const out = [];
  for (let i = 0; i < userIds.length; i += BATCH) {
    const res = await client.post(`${USERS_V1}/users`, {
      userIds: userIds.slice(i, i + BATCH),
      excludeBannedUsers: false,
    });
    out.push(...(res?.data ?? []));
  }
  return out;
}

/** Turns usernames into ids. Unknown names simply do not come back. */
export async function fetchUsersByNames(client, usernames) {
  const out = [];
  for (let i = 0; i < usernames.length; i += BATCH) {
    const res = await client.post(`${USERS_V1}/usernames/users`, {
      usernames: usernames.slice(i, i + BATCH),
      excludeBannedUsers: false,
    });
    out.push(...(res?.data ?? []));
  }
  return out;
}

/**
 * Turns a configured watch list into the same `{userId, username, displayName}`
 * shape the group scraper produces, so the rest of the loop cannot tell the
 * difference.
 *
 * Best effort by design: an entry that already carries a `userId` survives a
 * dead users API, because the id is all the presence sweep actually needs. Only
 * name-only entries depend on the lookup working.
 */
export async function resolveUserList(client, entries, { logger = createLogger('users') } = {}) {
  const wanted = entries.filter((e) => e.userId || e.username);
  const byName = wanted.filter((e) => !e.userId && e.username);
  const resolved = new Map();

  if (byName.length) {
    try {
      const found = await fetchUsersByNames(client, byName.map((e) => e.username));
      for (const u of found) {
        resolved.set(norm(u.requestedUsername ?? u.name), u);
        resolved.set(norm(u.name), u);
      }
    } catch (err) {
      logger.warn(`username lookup failed (${err.message}); name-only entries will be skipped`);
    }
  }

  const list = [];
  for (const entry of wanted) {
    if (entry.userId) {
      list.push({ ...entry, userId: Number(entry.userId) });
      continue;
    }
    const hit = resolved.get(norm(entry.username));
    if (!hit) {
      logger.warn(
        `no Roblox account named "${entry.username}" - skipping. ` +
          'Put the numeric userId in the config instead; names are not unique enough to guess.',
      );
      continue;
    }
    logger.info(`resolved "${entry.username}" to userId ${hit.id}`);
    list.push({ ...entry, userId: hit.id, username: hit.name, displayName: hit.displayName ?? hit.name });
  }

  // One call fills in display names and catches anyone who has since renamed,
  // which matters because a stale username in an alert sends you to a dead
  // profile link. A failure here is cosmetic, so it never stops the watcher.
  const ids = list.map((u) => u.userId);
  if (ids.length) {
    try {
      const info = new Map((await fetchUsersByIds(client, ids)).map((u) => [u.id, u]));
      for (const user of list) {
        const found = info.get(user.userId);
        if (!found) {
          logger.warn(`userId ${user.userId} ("${user.username ?? '?'}") does not resolve to an account`);
          continue;
        }
        if (user.username && norm(user.username) !== norm(found.name)) {
          logger.warn(`userId ${user.userId} is "${found.name}" now, not "${user.username}" - using the live name`);
        }
        user.username = found.name;
        user.displayName = found.displayName ?? found.name;
      }
    } catch (err) {
      logger.warn(`user info lookup failed (${err.message}); falling back to the names in the config`);
    }
  }

  // The same person can land in the list twice - once by id, once by a name
  // that resolves to it, or just pasted twice. Left in, every duplicate costs a
  // presence slot on every sweep forever, so collapse them here.
  const seen = new Map();
  for (const u of list) {
    const existing = seen.get(u.userId);
    if (!existing) {
      seen.set(u.userId, {
        userId: u.userId,
        username: u.username ?? `user ${u.userId}`,
        displayName: u.displayName ?? u.username ?? `user ${u.userId}`,
        note: u.note ?? null,
      });
      continue;
    }
    logger.warn(`${existing.username} (${u.userId}) is in the list more than once; keeping one copy`);
    existing.note ??= u.note ?? null;
  }

  return [...seen.values()];
}
