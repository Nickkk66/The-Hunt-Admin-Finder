import { createLogger } from './log.js';

const GROUPS_V1 = 'https://groups.roblox.com/v1';

export async function getGroup(client, groupId) {
  return client.get(`${GROUPS_V1}/groups/${groupId}`);
}

export async function getRoles(client, groupId) {
  const res = await client.get(`${GROUPS_V1}/groups/${groupId}/roles`);
  return res?.roles ?? [];
}

/** Matches a role by name (case/space-insensitive) or by numeric rank value. */
export function findRole(roles, wanted) {
  if (wanted === null || wanted === undefined) return null;

  if (typeof wanted === 'number' || /^\d+$/.test(String(wanted).trim())) {
    const rank = Number(wanted);
    return roles.find((r) => r.rank === rank) ?? null;
  }

  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
  const target = norm(wanted);
  return (
    roles.find((r) => norm(r.name) === target) ??
    roles.find((r) => norm(r.name).includes(target)) ??
    null
  );
}

/**
 * Pages every user in a role. 2.7k members is ~27 requests at 100/page,
 * so this is cached upstream rather than run on every poll.
 */
export async function fetchRoleMembers(client, groupId, roleSetId, { onPage, logger = createLogger('groups') } = {}) {
  const members = [];
  let cursor = '';
  let page = 0;

  do {
    const url =
      `${GROUPS_V1}/groups/${groupId}/roles/${roleSetId}/users` +
      `?limit=100&sortOrder=Asc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await client.get(url);
    const batch = res?.data ?? [];

    for (const u of batch) {
      members.push({
        userId: u.userId,
        username: u.username,
        displayName: u.displayName ?? u.username,
      });
    }

    page += 1;
    cursor = res?.nextPageCursor ?? '';
    logger.debug(`page ${page}: +${batch.length} members (total ${members.length})`);
    onPage?.(members.length, page);
  } while (cursor);

  return members;
}
