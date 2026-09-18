import { createLogger } from './log.js';
import { fetchRoleMembers, findRole, getGroup, getRoles } from './groups.js';
import { PresenceType, fetchPresences, presenceName } from './presence.js';
import { universeIdForPlace, getUniverseInfo } from './universes.js';
import { matchesTarget, hitKey, shouldNotify } from './matching.js';
import { buildHitEmbed, sendEmbeds } from './discord.js';
import { readState, writeState } from './store.js';
import { sleep } from './queue.js';

export class Watcher {
  constructor(client, config) {
    this.client = client;
    this.config = config;
    this.log = createLogger(config.name);
    this.state = null;
    this.members = [];
    this.groupName = null;
    this.roleName = null;
    this.gameNames = new Map();
    this.stopped = false;
  }

  async init({ forceRefresh = false } = {}) {
    this.state = await readState(this.config.name, { members: [], membersFetchedAt: 0, notified: {} });

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
    const stale = ageMs > this.config.memberCacheHours * 3_600_000;
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
        `using cached member list (${this.members.length} members, ${Math.round(ageMs / 60000)} min old)`,
      );
    }
  }

  /** One presence sweep. Returns the hits that were notified. */
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

    const byId = new Map(this.members.map((m) => [m.userId, m]));
    const inGame = presences.filter((p) => p.userPresenceType === PresenceType.IN_GAME);

    const hits = [];
    for (const presence of inGame) {
      if (!presence.universeId && presence.placeId) {
        presence.universeId = await universeIdForPlace(this.client, presence.placeId);
      }

      const verdict = matchesTarget(presence, this.config.target, {
        notifyOnUnknownGame: this.config.notifyOnUnknownGame,
      });
      if (!verdict.match) continue;

      const member = byId.get(presence.userId) ?? { username: `user ${presence.userId}` };
      hits.push({
        userId: presence.userId,
        username: member.username,
        displayName: member.displayName ?? member.username,
        placeId: presence.placeId ?? presence.rootPlaceId ?? null,
        gameId: presence.gameId ?? null,
        universeId: presence.universeId ?? null,
        gameName: await this.#gameName(presence.universeId, presence.lastLocation),
        statusText: `${presenceName(presence.userPresenceType)} (${verdict.confidence})`,
        confidence: verdict.confidence,
        groupName: this.groupName,
        rankName: this.roleName,
      });
    }

    this.log.info(
      `checked ${presences.length} members in ${((Date.now() - started) / 1000).toFixed(0)}s: ` +
        `${inGame.length} in a game, ${hits.length} in the target experience`,
    );

    return this.#notify(hits);
  }

  async #gameName(universeId, lastLocation) {
    if (!universeId) return lastLocation || null;
    if (this.gameNames.has(universeId)) return this.gameNames.get(universeId);
    const info = await getUniverseInfo(this.client, universeId).catch(() => null);
    const name = info?.name ?? lastLocation ?? null;
    this.gameNames.set(universeId, name);
    return name;
  }

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
    const ttl = Math.max(this.config.renotifyMinutes * 60_000 * 4, 6 * 3_600_000);
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
      if (ageMs > this.config.memberCacheHours * 3_600_000) {
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
