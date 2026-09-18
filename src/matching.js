import { PresenceType } from './presence.js';

/**
 * Decides whether a presence record counts as "playing the target game".
 * Pure function so it can be tested without touching the network.
 *
 * @param {object} presence  a userPresences entry, optionally enriched with
 *                           a resolved `universeId`.
 * @param {object} target    { universeIds?, placeIds?, nameMatch? }
 * @param {object} [opts]    { notifyOnUnknownGame }
 * @returns {{match: boolean, confidence: 'exact'|'name'|'unknown'|null, reason: string}}
 */
export function matchesTarget(presence, target = {}, { notifyOnUnknownGame = false } = {}) {
  if (!presence || presence.userPresenceType !== PresenceType.IN_GAME) {
    return { match: false, confidence: null, reason: 'not in game' };
  }

  const universeIds = (target.universeIds ?? []).map(Number).filter(Boolean);
  const placeIds = (target.placeIds ?? []).map(Number).filter(Boolean);

  const theirUniverse = Number(presence.universeId) || null;
  const theirPlaces = [presence.placeId, presence.rootPlaceId].map(Number).filter(Boolean);

  if (theirUniverse && universeIds.includes(theirUniverse)) {
    return { match: true, confidence: 'exact', reason: `universe ${theirUniverse}` };
  }

  if (theirPlaces.some((p) => placeIds.includes(p))) {
    return { match: true, confidence: 'exact', reason: `place ${theirPlaces.join('/')}` };
  }

  // Some place ids in the same universe are not in our list; a universe id we
  // resolved separately is authoritative, so a mismatch here is a real miss.
  const knowsLocation = Boolean(theirUniverse || theirPlaces.length);

  if (!knowsLocation) {
    const loc = String(presence.lastLocation ?? '').trim();
    if (target.nameMatch && loc && new RegExp(target.nameMatch, 'i').test(loc)) {
      return { match: true, confidence: 'name', reason: `lastLocation "${loc}"` };
    }
    if (notifyOnUnknownGame) {
      return { match: true, confidence: 'unknown', reason: 'in game, details hidden' };
    }
    return { match: false, confidence: null, reason: 'in game but details hidden' };
  }

  if (target.nameMatch) {
    const loc = String(presence.lastLocation ?? '').trim();
    if (loc && new RegExp(target.nameMatch, 'i').test(loc)) {
      return { match: true, confidence: 'name', reason: `lastLocation "${loc}"` };
    }
  }

  return { match: false, confidence: null, reason: 'different experience' };
}

/**
 * True when someone is in an experience but Roblox will not tell us which one.
 * Usually means their "who can join me" privacy is set to Followers, Friends or
 * No one - the first of those is the case follow-probing can open up.
 */
export function isLocationHidden(presence) {
  if (!presence || presence.userPresenceType !== PresenceType.IN_GAME) return false;
  return !presence.universeId && !presence.placeId && !presence.rootPlaceId;
}

/** Dedupe key: one alert per user per server, unless the cooldown lapses. */
export function hitKey(presence) {
  return `${presence.userId}:${presence.gameId ?? presence.placeId ?? 'unknown'}`;
}

export function shouldNotify(key, notified, { renotifyMinutes = 30, now = Date.now() } = {}) {
  const last = notified[key];
  if (!last) return true;
  return now - last >= renotifyMinutes * 60_000;
}
