import { sleep } from './queue.js';
import { createLogger } from './log.js';

const MAX_EMBEDS_PER_MESSAGE = 10;

/** Posts embeds to a Discord webhook, chunked and 429-aware. */
export async function sendEmbeds(webhookUrl, embeds, { content, username, logger = createLogger('discord') } = {}) {
  if (!webhookUrl) {
    logger.warn('no webhook url configured; skipping notification');
    return false;
  }

  for (let i = 0; i < embeds.length; i += MAX_EMBEDS_PER_MESSAGE) {
    const chunk = embeds.slice(i, i + MAX_EMBEDS_PER_MESSAGE);
    const payload = {
      username: username || 'The Hunt Watcher',
      embeds: chunk,
    };
    if (i === 0 && content) payload.content = content;

    let attempt = 0;
    for (;;) {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok || res.status === 204) break;

      if (res.status === 429 && attempt < 5) {
        attempt += 1;
        const body = await res.json().catch(() => ({}));
        const waitMs = Math.ceil((body.retry_after ?? 1) * 1000) + 250;
        logger.warn(`discord 429, waiting ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }

      const text = await res.text().catch(() => '');
      logger.error(`discord webhook failed: ${res.status} ${text.slice(0, 300)}`);
      return false;
    }

    await sleep(400);
  }

  return true;
}

export function buildHitEmbed(hit, { color = 0xc0c0c0, itemName = 'the item' } = {}) {
  const fields = [
    {
      name: 'Profile',
      value: `[${hit.username}](https://www.roblox.com/users/${hit.userId}/profile)`,
      inline: true,
    },
    { name: 'Status', value: hit.statusText, inline: true },
  ];

  if (hit.placeId) {
    fields.push({
      name: 'Experience',
      value: `[${hit.gameName ?? `place ${hit.placeId}`}](https://www.roblox.com/games/${hit.placeId})`,
      inline: true,
    });
  }

  if (hit.gameId && hit.placeId) {
    fields.push({
      name: 'Join this exact server',
      value:
        '```' +
        `Roblox.GameLauncher.joinGameInstance(${hit.placeId}, "${hit.gameId}")` +
        '```\n' +
        `Paste that in the browser console on [the game page](https://www.roblox.com/games/${hit.placeId}), ` +
        'or use the deep link `' +
        `roblox://experiences/start?placeId=${hit.placeId}&gameInstanceId=${hit.gameId}` +
        '`',
      inline: false,
    });
  } else if (hit.placeId) {
    fields.push({
      name: 'Server',
      value: 'Server id hidden by their privacy settings. Join the experience and look for them.',
      inline: false,
    });
  }

  return {
    title: `${hit.displayName} (@${hit.username}) is playing`,
    description: `Go join them to earn **${itemName}**.`,
    color,
    fields,
    thumbnail: {
      url: `https://www.roblox.com/headshot-thumbnail/image?userId=${hit.userId}&width=150&height=150&format=png`,
    },
    footer: { text: `${hit.groupName ?? 'group'} - rank: ${hit.rankName ?? '?'}` },
    timestamp: new Date().toISOString(),
  };
}
