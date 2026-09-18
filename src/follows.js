import { createLogger } from './log.js';
import { RequestQueue, sleep } from './queue.js';

const FRIENDS_V1 = 'https://friends.roblox.com/v1';

/**
 * Follow / unfollow helpers for your own account.
 *
 * Why this exists: Roblox's "who can join me" privacy setting has a Followers
 * option. Presence hides placeId/gameId from anyone who is not allowed to join,
 * so following such a user makes their current server visible to you. Users set
 * to Friends or No one stay opaque no matter what we do.
 *
 * These are writes on your account. Roblox is far touchier about follow churn
 * than about read traffic, so every call here goes through its own slow queue.
 */
export class FollowManager {
  constructor(client, { minIntervalMs = 1500, logger = createLogger('follow') } = {}) {
    this.client = client;
    this.queue = new RequestQueue({ maxConcurrent: 1, minIntervalMs });
    this.log = logger;
  }

  /**
   * Which of these users do we already follow? Used to avoid a pointless
   * re-follow and, more importantly, to never unfollow someone the user
   * followed themselves.
   */
  async followingExists(userIds) {
    const out = new Map();
    if (!userIds.length) return out;

    for (let i = 0; i < userIds.length; i += 50) {
      const chunk = userIds.slice(i, i + 50);
      const res = await this.client.post(`${FRIENDS_V1}/user/following-exists`, { targetUserIds: chunk });
      for (const row of res?.followings ?? []) {
        out.set(Number(row.userId), Boolean(row.isFollowing));
      }
      // Anything the API skipped counts as "not following".
      for (const id of chunk) if (!out.has(id)) out.set(id, false);
    }
    return out;
  }

  follow(userId) {
    return this.queue.run(async () => {
      const res = await this.client.post(`${FRIENDS_V1}/users/${userId}/follow`, {});
      this.log.debug(`followed ${userId}`);
      return res;
    });
  }

  unfollow(userId) {
    return this.queue.run(async () => {
      const res = await this.client.post(`${FRIENDS_V1}/users/${userId}/unfollow`, {});
      this.log.debug(`unfollowed ${userId}`);
      return res;
    });
  }

  /** Follows a batch one at a time. `onError` returning true aborts the rest. */
  async followMany(userIds, { onError } = {}) {
    const followed = [];
    for (const id of userIds) {
      try {
        await this.follow(id);
        followed.push(id);
      } catch (err) {
        if (onError?.(id, err)) break;
      }
    }
    return followed;
  }

  async unfollowMany(userIds, { onError } = {}) {
    const done = [];
    for (const id of userIds) {
      try {
        await this.unfollow(id);
        done.push(id);
      } catch (err) {
        // "You are not following this user" is a success as far as we care.
        if (err?.status === 400) {
          done.push(id);
          continue;
        }
        if (onError?.(id, err)) break;
      }
    }
    return done;
  }
}

export { sleep };
