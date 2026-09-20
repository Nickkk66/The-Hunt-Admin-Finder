import { sleep } from './queue.js';
import { createLogger } from './log.js';

const MAX_EMBEDS_PER_MESSAGE = 10;

/** Posts embeds to a Discord webhook, chunked and 429-aware. */
/**
 * Turns the configured ping into Discord mention syntax. Accepts a bare user id,
 * "role:<id>", "@here", "@everyone", or an already-formatted <@...> mention.
 */
export function mentionFor(ping) {
  const p = String(ping ?? '').trim();
  if (!p) return '';
  if (/^\d{15,22}$/.test(p)) return `<@${p}>`;
  const role = p.match(/^role:(\d{15,22})$/i);
  if (role) return `<@&${role[1]}>`;
  if (p === '@here' || p === '@everyone' || /^<@[!&]?\d+>$/.test(p)) return p;
  return '';
}

export async function sendEmbeds(webhookUrl, embeds, { content, username, ping = false, logger = createLogger('discord') } = {}) {
  if (!webhookUrl) {
    logger.warn('no webhook url configured; skipping notification');
    return false;
  }

  for (let i = 0; i < embeds.length; i += MAX_EMBEDS_PER_MESSAGE) {
    const chunk = embeds.slice(i, i + MAX_EMBEDS_PER_MESSAGE);
    const payload = {
      username: username || 'The Hunt Watcher',
      embeds: chunk,
      // Only let the message ping when we asked it to; player names can't sneak in an @everyone.
      allowed_mentions: ping ? { parse: ['users', 'roles', 'everyone'] } : { parse: [] },
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

const ITEM_EMOJI = [
  [/gold/i, '🥇'],
  [/silver/i, '🥈'],
  [/bronze/i, '🥉'],
];

/**
 * The badge that says at a glance which watcher fired. An explicit "emoji" in
 * watchers.json wins; otherwise it is inferred from the item name.
 */
export function itemEmoji(itemName, explicit) {
  const e = String(explicit ?? '').trim();
  if (e) return e;
  for (const [re, emoji] of ITEM_EMOJI) if (re.test(itemName ?? '')) return emoji;
  return '🏅';
}

/** Web join link: opens the Roblox app straight into their server (Discord only links http/https). */
export function joinUrl(placeId, gameId) {
  const base = `https://www.roblox.com/games/start?placeId=${placeId}`;
  return gameId ? `${base}&gameInstanceId=${gameId}` : base;
}

export function buildHitEmbed(hit, { color = 0xc0c0c0, itemName = 'the item', emoji = '' } = {}) {
  const badge = emoji ? `${emoji} ` : '';
  const profileUrl = `https://www.roblox.com/users/${hit.userId}/profile`;
  const gameName = hit.gameName ?? (hit.placeId ? `place ${hit.placeId}` : 'the game');
  const gameLink = hit.placeId ? `[${gameName}](https://www.roblox.com/games/${hit.placeId})` : `**${gameName}**`;
  const join = hit.placeId ? joinUrl(hit.placeId, hit.gameId) : null;

  const lines = [`Playing ${gameLink} · go get ${badge}**${itemName}**`];
  if (join && !hit.gameId) {
    lines.push('-# Their server is hidden, so this opens the game - look for them once you are in.');
  }
  if (hit.confidence === 'probed') {
    lines.push('-# Found by following them. Stay followed until you have joined.');
  }

  const fields = [];
  if (hit.serverPlaying != null) {
    const full = hit.serverMax != null && hit.serverPlaying >= hit.serverMax;
    fields.push({
      name: 'Their server',
      value: `**${hit.serverPlaying}/${hit.serverMax ?? '?'}**${full ? ' 🔴 FULL' : ''}`,
      inline: true,
    });
  }
  if (hit.gamePlaying != null) {
    fields.push({ name: 'Playing the game', value: `**${hit.gamePlaying.toLocaleString('en-US')}**`, inline: true });
  }

  const embed = {
    author: {
      name: hit.displayName && hit.displayName !== hit.username ? `${hit.displayName} (@${hit.username})` : hit.username,
      url: profileUrl,
    },
    title: join ? (hit.gameId ? '▶  Join their server' : '▶  Open the game') : undefined,
    url: join ?? undefined,
    description: lines.join('\n'),
    color,
    fields,
    footer: { text: `${badge}${itemName} · ${hit.groupName ?? 'group'} · ${hit.rankName ?? '?'}` },
    timestamp: new Date().toISOString(),
  };
  if (hit.avatarUrl) {
    embed.author.icon_url = hit.avatarUrl;
    embed.thumbnail = { url: hit.avatarUrl };
  }
  return embed;
}
