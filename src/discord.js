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
  // No "Status" field: an alert only exists because they are in the game, so
  // restating it spends a column on nothing.
  const fields = [
    {
      name: 'Profile',
      value: `[${hit.username}](https://www.roblox.com/users/${hit.userId}/profile)`,
      inline: true,
    },
  ];

  // Long enough to say who they are, short enough not to bury the join link.
  if (hit.note) {
    const note = String(hit.note).trim();
    fields.push({ name: 'Who', value: note.length > 180 ? `${note.slice(0, 177)}...` : note, inline: false });
  }

  if (hit.confidence === 'probed') {
    fields.push({
      name: 'How we found them',
      value:
        'Their game was hidden, so the watcher followed them to see it. ' +
        'Stay followed until you have joined - their joins are follower-only.',
      inline: false,
    });
  } else if (hit.following) {
    fields.push({ name: 'Note', value: 'You are currently following them (probe follow).', inline: false });
  }

  if (hit.placeId) {
    fields.push({
      name: 'Experience',
      value: `[${hit.gameName ?? `place ${hit.placeId}`}](https://www.roblox.com/games/${hit.placeId})`,
      inline: true,
    });
  }

  if (hit.gameId && hit.placeId) {
    // Discord renders a fenced block on its own lines; inline backticks in the
    // same field came out as a run-on wall of text.
    fields.push({
      name: 'Join their exact server',
      value:
        `Open [the game page](https://www.roblox.com/games/${hit.placeId}), press F12, paste this:\n` +
        '```js\n' +
        `Roblox.GameLauncher.joinGameInstance(${hit.placeId}, "${hit.gameId}")\n` +
        '```',
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
    // Most people never set a display name, and "x (@x)" reads as a stutter.
    title: `${hit.displayName && hit.displayName !== hit.username ? `${hit.displayName} (@${hit.username})` : hit.username} is playing`,
    description: `Go join them to earn **${itemName}**.`,
    color,
    fields,
    // No avatar url beats a dead one: Discord leaves a blank gap for an image
    // it cannot fetch, which is what the old headshot-thumbnail endpoint gives.
    ...(hit.avatarUrl ? { thumbnail: { url: hit.avatarUrl } } : {}),
    footer: {
      text: hit.rankName ? `${hit.groupName ?? 'group'} - rank: ${hit.rankName}` : (hit.groupName ?? 'watch list'),
    },
    // No timestamp: Discord already stamps every message with when it arrived,
    // and an embed timestamp just prints "Today at ..." a second time.
  };
}
