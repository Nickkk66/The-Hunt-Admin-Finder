import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { joinUrl } from './discord.js';

/**
 * Every hit the watchers turn up, for the dashboard's "Found" panel.
 *
 * This is deliberately independent of Discord: the webhook is one destination
 * for a finding, not the definition of one. With no webhook configured at all
 * the watchers still fill this list.
 *
 * It is written to disk because the watcher and the dashboard are usually two
 * different processes - the launcher starts `src/index.js`, while the dashboard
 * is `src/ui.js`. An in-memory list would leave the page permanently empty.
 */
const MAX_FINDINGS = 200;
const findingsFile = () =>
  process.env.FINDINGS_FILE || join(process.env.STATE_DIR || '.state', 'findings.json');

const findings = [];
let seq = 0;
let writing = Promise.resolve();

async function persist() {
  const path = findingsFile();
  const snapshot = findings.slice(-MAX_FINDINGS);
  writing = writing
    .then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(snapshot));
      await rename(tmp, path);
    })
    .catch(() => {}); // a findings file we cannot write must never stop the watcher
  return writing;
}

export function recordFindings(watcherName, hits, { emoji = '', itemName = '', now = Date.now() } = {}) {
  const added = [];
  for (const h of hits) {
    const entry = {
      seq: seq++,
      at: now,
      watcher: watcherName,
      emoji,
      itemName,
      userId: h.userId,
      username: h.username,
      displayName: h.displayName ?? h.username,
      avatarUrl: h.avatarUrl ?? null,
      gameName: h.gameName ?? null,
      placeId: h.placeId ?? null,
      gameId: h.gameId ?? null,
      serverPlaying: h.serverPlaying ?? null,
      serverMax: h.serverMax ?? null,
      gamePlaying: h.gamePlaying ?? null,
      confidence: h.confidence ?? null,
      profileUrl: `https://www.roblox.com/users/${h.userId}/profile`,
      joinUrl: h.placeId ? joinUrl(h.placeId, h.gameId) : null,
    };
    findings.push(entry);
    added.push(entry);
  }
  if (findings.length > MAX_FINDINGS) findings.splice(0, findings.length - MAX_FINDINGS);
  if (added.length) persist();
  return added;
}

/** Newest first, so the page can render straight down the list. */
export function recentFindings(limit = 100) {
  return findings.slice(-limit).reverse();
}

/**
 * What the dashboard serves. Reads the file so it sees finds made by a watcher
 * running in another process; falls back to this process's own list.
 */
export async function loadFindings(limit = 100) {
  try {
    const onDisk = JSON.parse(await readFile(findingsFile(), 'utf8'));
    if (Array.isArray(onDisk) && onDisk.length) return onDisk.slice(-limit).reverse();
  } catch {
    // no file yet, or it is mid-write - fall through to memory
  }
  return recentFindings(limit);
}

export async function clearFindings() {
  findings.length = 0;
  seq = 0;
  await persist();
}
