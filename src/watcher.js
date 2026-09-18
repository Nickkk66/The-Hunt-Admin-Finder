import { createLogger } from './log.js';
import { fetchRoleMembers, findRole, getGroup, getRoles } from './groups.js';
import { PresenceType, fetchPresences, presenceName } from './presence.js';
import { universeIdForPlace, getUniverseInfo } from './universes.js';
import { matchesTarget, hitKey, shouldNotify, isLocationHidden } from './matching.js';
import { buildHitEmbed, sendEmbeds } from './discord.js';
import { readState, writeState } from './store.js';
import { FollowManager } from './follows.js';
import { ChallengeRequiredError } from './robloxClient.js';
import { sleep } from './queue.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;

export class Watcher {
  constructor(client, config) {
    this.client = client;
    this.config = config;
    this.log = createLogger(config.name);
    this.follows = new FollowManager(client, {
      minIntervalMs: config.probe?.minIntervalMs ?? 1500,
      logger: this.log.child('follow'),
    });
    this.state = null;
    this.members = [];
    this.groupName = null;
    this.roleName = null;
    this.gameNames = new Map();
    this.stopped = false;
    this.lastTick = null;
    this.recentHits = [];
  }

  /** Snapshot for the local dashboard. */
  status() {
    return {
      name: this.config.name,
      itemName: this.config.itemName ?? null,
      group: this.groupName,
      rank: this.roleName,
      members: this.members.length,
      probing: Boolean(this.config.probe?.enabled),
      dryRun: Boolean(this.config.probe?.dryRun),
      activeFollows: Object.keys(this.state?.follows ?? {}).length,
      probePausedUntil: this.state?.probePausedUntil ?? 0,
      pollIntervalSeconds: this.config.pollIntervalSeconds,
      lastTick: this.lastTick,
      recentHits: this.recentHits,
      stopped: this.stopped,
    };
  }

  async init({ forceRefresh = false } = {}) {
    this.state = await readState(this.config.name, {
      members: [],
      membersFetchedAt: 0,
      notified: {},
      follows: {},
      probe: {},
      probePausedUntil: 0,
    });
    this.state.notified ??= {};
    this.state.follows ??= {};
    this.state.probe ??= {};

    const group = await getGroup(this.client, this.config.groupId);
    this.groupName = group?.name ?? `group ${this.config.groupId}`;

    const roles = await getRoles(this.client, this.config.groupId);
    const role = findRole(roles, this.config.rank);
    if (!role) {
      const names = roles.map((r) => `"${r.name}" (rank ${r.rank}, ${r.memberCount} members)`).join(', ');
      throw new Error(`Rank "${this.config.rank}" not found in ${this.groupName}. Available: ${names}`);
    }
    this.roleName = role.name;
    this.log.info(`${this.groupName} -> rank "${role.name}" (roleSetId ${role.id}, ${role.memberCount} members)`);

    const ageMs = Date.now() - (this.state.membersFetchedAt ?? 0);
    const stale = ageMs > this.config.memberCacheHours * HOUR;
    const roleChanged = this.state.roleSetId !== role.id;

    if (forceRefresh || stale || roleChanged || !this.state.members?.length) {
      this.log.info('scraping the rank member list (this takes a minute the first time)...');
      this.members = await fetchRoleMembers(this.client, this.config.groupId, role.id, {
        logger: this.log,
        onPage: (total, page) => {
          if (page % 5 === 0) this.log.info(`  ...${total} members so far`);
        },
      });
      this.state.members = this.members;
      this.state.membersFetchedAt = Date.now();
      this.state.roleSetId = role.id;
      await writeState(this.config.name, this.state);
      this.log.info(`cached ${this.members.length} members`);
    } else {
      this.members = this.state.members;
      this.log.info(
        `using cached member list (${this.members.length} members, ${Math.round(ageMs / MINUTE)} min old)`,
      );
    }

    const outstanding = Object.keys(this.state.follows).length;
    if (outstanding) this.log.info(`${outstanding} follow(s) left over from a previous run; they'll expire normally`);
  }

  /** One presence sweep, plus a probe pass over the people we can't see. */
  async tick() {
    const userIds = this.members.map((m) => m.userId);
    if (!userIds.length) {
      this.log.warn('no members cached, nothing to check');
      return [];
    }

    const started = Date.now();
    const presences = await fetchPresences(this.client, userIds, {
      batchSize: this.config.presenceBatchSize,
      logger: this.log,
    });

    const inGame = presences.filter((p) => p.userPresenceType === PresenceType.IN_GAME);
    const hits = [];
    const hidden = [];

    for (const presence of inGame) {
      if (!presence.universeId && presence.placeId) {
        presence.universeId = await universeIdForPlace(this.client, presence.placeId);
      }

      const verdict = matchesTarget(presence, this.config.target, {
        notifyOnUnknownGame: this.config.notifyOnUnknownGame,
      });

      if (verdict.match) {
        hits.push(await this.#toHit(presence, verdict));
      } else if (isLocationHidden(presence)) {
        hidden.push(presence);
      }
    }

    this.log.info(
      `checked ${presences.length} members in ${((Date.now() - started) / 1000).toFixed(0)}s: ` +
        `${inGame.length} in a game, ${hits.length} visibly in the target, ${hidden.length} hiding their game`,
    );

    const probed = await this.#probeHidden(hidden);
    hits.push(...probed);

    await this.#reconcileFollows(presences);

    const notified = await this.#notify(hits);

    this.lastTick = {
      at: Date.now(),
      durationMs: Date.now() - started,
      checked: presences.length,
      inGame: inGame.length,
      hidden: hidden.length,
      matched: hits.length,
      notified: notified.length,
    };
    if (notified.length) {
      this.recentHits = [
        ...notified.map((h) => ({
          at: Date.now(),
          userId: h.userId,
          username: h.username,
          displayName: h.displayName,
          confidence: h.confidence,
          placeId: h.placeId,
          gameId: h.gameId,
          gameName: h.gameName,
        })),
        ...this.recentHits,
      ].slice(0, 25);
    }

    return notified;
  }

  async #toHit(presence, verdict) {
    const member = this.members.find((m) => m.userId === presence.userId) ?? {
      username: `user ${presence.userId}`,
    };
    return {
      userId: presence.userId,
      username: member.username,
      displayName: member.displayName ?? member.username,
      placeId: presence.placeId ?? presence.rootPlaceId ?? null,
      gameId: presence.gameId ?? null,
      universeId: presence.universeId ?? null,
      gameName: await this.#gameName(presence.universeId, presence.lastLocation),
      statusText: `${presenceName(presence.userPresenceType)} (${verdict.confidence})`,
      confidence: verdict.confidence,
      following: Boolean(this.state.follows[presence.userId]),
      groupName: this.groupName,
      rankName: this.roleName,
    };
  }

  async #gameName(universeId, lastLocation) {
    if (!universeId) return lastLocation || null;
    if (this.gameNames.has(universeId)) return this.gameNames.get(universeId);
    const info = await getUniverseInfo(this.client, universeId).catch(() => null);
    const name = info?.name ?? lastLocation ?? null;
    this.gameNames.set(universeId, name);
    return name;
  }

  // ---------------------------------------------------------------------------
  // Probing: follow people whose game is hidden, look again, keep or drop.
  // ---------------------------------------------------------------------------

  #probeConfig() {
    const p = this.config.probe ?? {};
    return {
      enabled: p.enabled ?? false,
      maxPerCycle: p.maxPerCycle ?? 10,
      maxActiveFollows: p.maxActiveFollows ?? 60,
      settleMs: p.settleMs ?? 4000,
      recheckAttempts: p.recheckAttempts ?? 2,
      keepFollowMinutes: p.keepFollowMinutes ?? 60,
      targetGraceMinutes: p.targetGraceMinutes ?? 20,
      opaqueBackoffHours: p.opaqueBackoffHours ?? 12,
      pauseOnErrorMinutes: p.pauseOnErrorMinutes ?? 30,
      unfollowOnExit: p.unfollowOnExit ?? true,
      dryRun: p.dryRun ?? false,
    };
  }

  #probeBackoffMs(outcome, cfg) {
    switch (outcome) {
      case 'opaque':
      case 'preexisting-opaque':
        return cfg.opaqueBackoffHours * HOUR;
      case 'follow-failed':
        return 2 * HOUR;
      default:
        return 30 * MINUTE;
    }
  }

  #pauseProbing(minutes, why) {
    this.state.probePausedUntil = Date.now() + minutes * MINUTE;
    this.log.warn(`pausing follow-probing for ${minutes} min: ${why}`);
  }

  async #probeHidden(hidden) {
    const cfg = this.#probeConfig();
    if (!cfg.enabled || !hidden.length) return [];

    const now = Date.now();
    if (now < (this.state.probePausedUntil ?? 0)) {
      this.log.debug(`probing paused for another ${Math.ceil((this.state.probePausedUntil - now) / MINUTE)} min`);
      return [];
    }

    const activeFollows = Object.keys(this.state.follows).length;
    const budget = Math.min(cfg.maxPerCycle, cfg.maxActiveFollows - activeFollows);
    if (budget <= 0) {
      this.log.warn(
        `at the follow ceiling (${activeFollows}/${cfg.maxActiveFollows}); not probing until some expire`,
      );
      return [];
    }

    const candidates = [];
    for (const presence of hidden) {
      const id = presence.userId;
      if (this.state.follows[id]) continue; // already followed and still hidden
      const record = this.state.probe[id];
      if (record && now - record.lastProbedAt < this.#probeBackoffMs(record.outcome, cfg)) continue;
      candidates.push(presence);
      if (candidates.length >= budget) break;
    }
    if (!candidates.length) {
      this.log.debug(`${hidden.length} hidden, none eligible to probe right now`);
      return [];
    }

    const ids = candidates.map((c) => c.userId);

    // Never unfollow somebody the user follows for their own reasons, and don't
    // bother re-following them: if we already follow them and they are still
    // hidden, their privacy is Friends-or-tighter and following cannot help.
    let existing;
    try {
      existing = await this.follows.followingExists(ids);
    } catch (err) {
      this.#handleProbeError(err, 'following-exists check');
      return [];
    }

    const toFollow = [];
    for (const id of ids) {
      if (existing.get(id)) {
        this.state.probe[id] = { lastProbedAt: now, outcome: 'preexisting-opaque' };
      } else {
        toFollow.push(id);
      }
    }
    if (!toFollow.length) return [];

    if (cfg.dryRun) {
      this.log.info(`[dry run] would follow ${toFollow.length} hidden user(s): ${toFollow.join(', ')}`);
      return [];
    }

    this.log.info(`probing ${toFollow.length} hidden user(s) by following them`);

    let aborted = false;
    const followed = await this.follows.followMany(toFollow, {
      onError: (id, err) => {
        if (err instanceof ChallengeRequiredError) {
          this.#pauseProbing(cfg.pauseOnErrorMinutes, err.message);
          aborted = true;
          return true;
        }
        if (err?.status === 429) {
          this.#pauseProbing(cfg.pauseOnErrorMinutes, 'Roblox rate limited the follow endpoint');
          aborted = true;
          return true;
        }
        this.log.warn(`could not follow ${id}: ${err.message}`);
        this.state.probe[id] = { lastProbedAt: now, outcome: 'follow-failed' };
        return false;
      },
    });

    for (const id of followed) {
      this.state.follows[id] = { followedAt: now, source: 'probe' };
    }
    if (!followed.length) {
      await writeState(this.config.name, this.state);
      return [];
    }

    // Presence is cached server-side for a few seconds, so give it a moment.
    const stillUnknown = new Set(followed);
    const revealed = new Map();

    for (let attempt = 0; attempt < cfg.recheckAttempts && stillUnknown.size && !aborted; attempt += 1) {
      await sleep(cfg.settleMs);
      let fresh;
      try {
        fresh = await fetchPresences(this.client, [...stillUnknown], {
          batchSize: this.config.presenceBatchSize,
          logger: this.log,
        });
      } catch (err) {
        this.log.warn(`presence re-check failed: ${err.message}`);
        break;
      }
      for (const presence of fresh) {
        if (isLocationHidden(presence)) continue;
        revealed.set(presence.userId, presence);
        stillUnknown.delete(presence.userId);
      }
    }

    const hits = [];
    for (const [id, presence] of revealed) {
      if (!presence.universeId && presence.placeId) {
        presence.universeId = await universeIdForPlace(this.client, presence.placeId);
      }
      const verdict = matchesTarget(presence, this.config.target, { notifyOnUnknownGame: false });
      const record = this.state.follows[id] ?? { followedAt: now, source: 'probe' };
      record.revealedAt = now;
      this.state.follows[id] = record;

      if (verdict.match) {
        record.lastTargetSeenAt = now;
        this.state.probe[id] = { lastProbedAt: now, outcome: 'revealed-target' };
        hits.push(await this.#toHit(presence, { ...verdict, confidence: 'probed' }));
      } else {
        this.state.probe[id] = { lastProbedAt: now, outcome: 'revealed-other' };
      }
    }

    // Following did not help these ones: privacy is Friends or No one. Drop them.
    if (stillUnknown.size) {
      const wasted = [...stillUnknown];
      for (const id of wasted) this.state.probe[id] = { lastProbedAt: now, outcome: 'opaque' };
      const dropped = await this.follows.unfollowMany(wasted, {
        onError: (id, err) => {
          this.log.warn(`could not unfollow ${id}: ${err.message}`);
          return err instanceof ChallengeRequiredError;
        },
      });
      for (const id of dropped) delete this.state.follows[id];
      this.log.info(
        `probe result: ${revealed.size} revealed, ${wasted.length} still hidden (unfollowed ${dropped.length})`,
      );
    } else {
      this.log.info(`probe result: ${revealed.size} revealed, 0 still hidden`);
    }

    await writeState(this.config.name, this.state);
    return hits;
  }

  #handleProbeError(err, what) {
    const cfg = this.#probeConfig();
    if (err instanceof ChallengeRequiredError) {
      this.#pauseProbing(cfg.pauseOnErrorMinutes, err.message);
      return;
    }
    this.log.warn(`${what} failed: ${err.message}`);
  }

  /**
   * Drops follows we no longer need. A follow is kept while the user is in the
   * target game (plus a grace window) so you can actually join them - unfollowing
   * the second you spot them would slam the door you just opened.
   */
  async #reconcileFollows(presences) {
    const cfg = this.#probeConfig();
    const now = Date.now();
    const byId = new Map(presences.map((p) => [p.userId, p]));
    const expired = [];

    for (const [rawId, record] of Object.entries(this.state.follows)) {
      const id = Number(rawId);
      if (record.source !== 'probe') continue;

      const presence = byId.get(id);
      if (presence) {
        const verdict = matchesTarget(presence, this.config.target, { notifyOnUnknownGame: false });
        if (verdict.match) {
          record.lastTargetSeenAt = now;
          continue;
        }
      }

      const keepUntil = Math.max(
        (record.revealedAt ?? record.followedAt) + cfg.keepFollowMinutes * MINUTE,
        (record.lastTargetSeenAt ?? 0) + cfg.targetGraceMinutes * MINUTE,
      );
      if (now > keepUntil) expired.push(id);
    }

    if (!expired.length) return;

    const dropped = await this.follows.unfollowMany(expired, {
      onError: (id, err) => {
        this.log.warn(`could not unfollow ${id}: ${err.message}`);
        return err instanceof ChallengeRequiredError;
      },
    });
    for (const id of dropped) delete this.state.follows[id];
    if (dropped.length) this.log.info(`unfollowed ${dropped.length} expired probe follow(s)`);
    await writeState(this.config.name, this.state);
  }

  /** Unfollows everything this tool followed. `force` ignores the grace window. */
  async cleanupFollows({ force = false } = {}) {
    const cfg = this.#probeConfig();
    const now = Date.now();
    const ids = [];
    let kept = 0;

    for (const [rawId, record] of Object.entries(this.state?.follows ?? {})) {
      if (record.source !== 'probe') continue;
      const stillUseful =
        !force && (record.lastTargetSeenAt ?? 0) + cfg.targetGraceMinutes * MINUTE > now;
      if (stillUseful) {
        kept += 1;
        continue;
      }
      ids.push(Number(rawId));
    }

    if (!ids.length) {
      if (kept) this.log.info(`kept ${kept} follow(s) for users you may still want to join`);
      return 0;
    }

    const dropped = await this.follows.unfollowMany(ids, {
      onError: (id, err) => {
        this.log.warn(`could not unfollow ${id}: ${err.message}`);
        return false;
      },
    });
    for (const id of dropped) delete this.state.follows[id];
    await writeState(this.config.name, this.state);
    this.log.info(`unfollowed ${dropped.length} user(s)${kept ? `, kept ${kept} still in the target game` : ''}`);
    return dropped.length;
  }

  // ---------------------------------------------------------------------------

  async #notify(hits) {
    const now = Date.now();
    this.state.notified ??= {};

    const fresh = hits.filter((h) =>
      shouldNotify(hitKey(h), this.state.notified, { renotifyMinutes: this.config.renotifyMinutes, now }),
    );

    if (!fresh.length) {
      if (hits.length) this.log.debug(`${hits.length} hits, all inside the re-notify cooldown`);
      await this.#pruneNotified(now);
      return [];
    }

    const embeds = fresh.map((h) =>
      buildHitEmbed(h, { color: this.config.embedColor ?? 0xc0c0c0, itemName: this.config.itemName ?? 'the item' }),
    );
    const content =
      fresh.length === 1
        ? `**${fresh[0].displayName}** is on right now. Go get ${this.config.itemName ?? 'the item'}.`
        : `**${fresh.length}** ${this.roleName}s are in the game right now.`;

    const ok = await sendEmbeds(this.config.webhookUrl, embeds, {
      content,
      username: this.config.webhookUsername ?? 'The Hunt Watcher',
      logger: this.log,
    });

    if (ok) {
      for (const h of fresh) this.state.notified[hitKey(h)] = now;
      this.log.info(`notified about ${fresh.length} player(s): ${fresh.map((h) => h.username).join(', ')}`);
    }

    await this.#pruneNotified(now);
    return fresh;
  }

  async #pruneNotified(now) {
    const ttl = Math.max(this.config.renotifyMinutes * MINUTE * 4, 6 * HOUR);
    for (const [key, at] of Object.entries(this.state.notified ?? {})) {
      if (now - at > ttl) delete this.state.notified[key];
    }
    await writeState(this.config.name, this.state);
  }

  async run() {
    while (!this.stopped) {
      try {
        await this.tick();
      } catch (err) {
        this.log.error(`tick failed: ${err.message}`);
      }
      if (this.stopped) break;

      const ageMs = Date.now() - (this.state.membersFetchedAt ?? 0);
      if (ageMs > this.config.memberCacheHours * HOUR) {
        this.log.info('member cache expired, re-scraping the rank');
        await this.init().catch((err) => this.log.error(`member refresh failed: ${err.message}`));
      }

      await sleep(this.config.pollIntervalSeconds * 1000);
    }
  }

  stop() {
    this.stopped = true;
  }
}
