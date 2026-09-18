const cache = new Map();

/** placeId -> universeId, memoized (presence sometimes omits universeId). */
export async function universeIdForPlace(client, placeId) {
  if (!placeId) return null;
  if (cache.has(placeId)) return cache.get(placeId);

  try {
    const res = await client.get(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`);
    const universeId = res?.universeId ?? null;
    cache.set(placeId, universeId);
    return universeId;
  } catch {
    cache.set(placeId, null);
    return null;
  }
}

export async function getUniverseInfo(client, universeId) {
  const res = await client.get(`https://games.roblox.com/v1/games?universeIds=${universeId}`);
  return res?.data?.[0] ?? null;
}
