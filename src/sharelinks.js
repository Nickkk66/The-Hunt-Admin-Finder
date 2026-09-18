const RESOLVE_URL = 'https://apis.roblox.com/sharelinks/v1/resolve-link';

/** Pulls the `code` / id out of whatever roblox.com/share flavour you paste in. */
export function parseShareInput(input) {
  const raw = String(input).trim();

  // https://www.roblox.com/share/g/1200769  -> group
  const groupPath = raw.match(/roblox\.com\/share\/g\/(\d+)/i);
  if (groupPath) return { kind: 'group', groupId: Number(groupPath[1]) };

  // https://www.roblox.com/groups/1200769/Name
  const groupClassic = raw.match(/roblox\.com\/groups\/(\d+)/i);
  if (groupClassic) return { kind: 'group', groupId: Number(groupClassic[1]) };

  // https://www.roblox.com/games/1234567/Name  -> place
  const place = raw.match(/roblox\.com\/games\/(\d+)/i);
  if (place) return { kind: 'place', placeId: Number(place[1]) };

  // https://www.roblox.com/share?code=<hex>&type=ExperienceDetails
  try {
    const url = new URL(raw);
    const code = url.searchParams.get('code');
    if (code) {
      return { kind: 'share', code, type: url.searchParams.get('type') || 'ExperienceDetails' };
    }
  } catch {
    /* not a URL, fall through */
  }

  if (/^[0-9a-f]{20,}$/i.test(raw)) return { kind: 'share', code: raw, type: 'ExperienceDetails' };
  if (/^\d+$/.test(raw)) return { kind: 'id', id: Number(raw) };

  return { kind: 'unknown', raw };
}

/** Resolves a /share?code=... link. Needs an authenticated cookie. */
export async function resolveShareCode(client, code, linkType = 'ExperienceDetails') {
  return client.post(RESOLVE_URL, { linkId: code, linkType });
}

/** Digs the placeId/universeId out of a resolve-link response, whatever shape it arrives in. */
export function extractIdsFromShareResponse(payload) {
  const found = { placeId: null, universeId: null, inviterId: null };
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === 'object') {
        walk(value);
        continue;
      }
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      if (/^(rootPlaceId|placeId)$/i.test(key) && !found.placeId) found.placeId = n;
      if (/^universeId$/i.test(key) && !found.universeId) found.universeId = n;
      if (/^(inviterId|userId)$/i.test(key) && !found.inviterId) found.inviterId = n;
    }
  };
  walk(payload);
  return found;
}
