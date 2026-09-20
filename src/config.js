import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

/** Minimal .env loader so the project stays dependency-free. */
export async function loadEnv(path = '.env') {
  if (!existsSync(path)) return;

  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    // A .env that exists but won't open (antivirus lock, an un-hydrated cloud
    // placeholder, odd ACLs) is not worth dying over: the same values can come
    // from the real environment, and the dashboard takes them from its form.
    console.warn(`warning: cannot read ${path} (${err.code ?? err.message}) - continuing without it`);
    return;
  }

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

/** Expands ${VAR} references inside config strings from the environment. */
export function expandEnv(value) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name) => process.env[name] ?? '');
  }
  if (Array.isArray(value)) return value.map(expandEnv);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnv(v)]));
  }
  return value;
}

const DEFAULTS = {
  pollIntervalSeconds: 90,
  memberCacheHours: 6,
  presenceBatchSize: 50,
  renotifyMinutes: 30,
  notifyOnUnknownGame: false,
  enabled: true,
};

const PROBE_DEFAULTS = {
  enabled: false,
  maxPerCycle: 10,
  maxActiveFollows: 60,
  minIntervalMs: 1500,
  settleMs: 4000,
  recheckAttempts: 2,
  keepFollowMinutes: 60,
  targetGraceMinutes: 20,
  opaqueBackoffHours: 12,
  pauseOnErrorMinutes: 30,
  unfollowOnExit: true,
  dryRun: false,
};

/**
 * Normalises a watch list into `{userId?, username?, note, enabled}` entries.
 *
 * Accepts a bare id, a username, a profile link or a full object, because the
 * three of those you actually have on hand depend on where you found the person.
 * Returns null when the watcher has no list at all, which is how a plain
 * group-rank watcher is told apart from a watch-list one.
 */
export function normalizeUsers(raw) {
  if (raw === null || raw === undefined) return null;
  const list = Array.isArray(raw) ? raw : [raw];

  return list.map((entry) => {
    if (typeof entry === 'number') return { userId: entry, username: null, note: null, enabled: true };

    if (typeof entry === 'string') {
      const trimmed = entry.trim();
      const profile = trimmed.match(/roblox\.com\/users\/(\d+)/i);
      if (profile) return { userId: Number(profile[1]), username: null, note: null, enabled: true };
      if (/^\d+$/.test(trimmed)) return { userId: Number(trimmed), username: null, note: null, enabled: true };
      return { userId: null, username: trimmed.replace(/^@/, ''), note: null, enabled: true };
    }

    if (entry && typeof entry === 'object') {
      const userId = Number(entry.userId ?? entry.id) || null;
      const username = entry.username ?? entry.name ?? null;
      return {
        userId,
        username: username ? String(username).trim().replace(/^@/, '') : null,
        displayName: entry.displayName ?? null,
        note: entry.note ?? null,
        enabled: entry.enabled !== false,
      };
    }

    return { userId: null, username: null, note: null, enabled: true };
  });
}

/** Shapes a raw config object. Shared by the file loader and the local UI. */
export function buildConfig(raw, { cookie = '' } = {}) {
  const expanded = expandEnv(raw);

  const watchers = (expanded.watchers ?? []).map((w) => ({
    ...DEFAULTS,
    ...expanded.defaults,
    ...w,
    users: normalizeUsers(w.users),
    probe: { ...PROBE_DEFAULTS, ...expanded.defaults?.probe, ...w.probe },
  }));
  for (const w of watchers) validateWatcher(w);

  return {
    roblox: {
      cookie: cookie || process.env.ROBLOX_COOKIE || expanded.roblox?.cookie || '',
      maxConcurrent: expanded.roblox?.maxConcurrent ?? 2,
      minIntervalMs: expanded.roblox?.minIntervalMs ?? 250,
    },
    watchers,
  };
}

export async function loadConfig(path = 'watchers.json') {
  if (!existsSync(path)) {
    throw new Error(
      `Config not found at ${path}. Copy watchers.example.json to watchers.json and fill it in.`,
    );
  }
  return buildConfig(JSON.parse(await readFile(path, 'utf8')));
}

function validateWatcher(w) {
  const problems = [];
  if (!w.name) problems.push('missing "name"');

  // A watcher is either a group rank (scrape the members) or an explicit list
  // of people. Both is a config mistake worth catching early, because only one
  // of them would ever be used.
  const hasList = Array.isArray(w.users);
  const hasGroup = Boolean(w.groupId || w.rank);
  if (hasList && hasGroup) {
    problems.push('has both "users" and "groupId"/"rank" - pick one, a watcher watches a list or a rank');
  } else if (hasList) {
    if (!w.users.length) problems.push('"users" is empty');
    else if (!w.users.some((u) => u.enabled !== false)) problems.push('every entry in "users" is disabled');
    for (const u of w.users) {
      if (u.enabled !== false && !u.userId && !u.username) {
        problems.push('a "users" entry has neither a userId nor a username');
      }
    }
  } else {
    if (!w.groupId) problems.push('missing "groupId" (or a "users" list)');
    if (!w.rank) problems.push('missing "rank"');
  }
  const hasTarget =
    (w.target?.universeIds?.length ?? 0) > 0 ||
    (w.target?.placeIds?.length ?? 0) > 0 ||
    Boolean(w.target?.nameMatch);
  if (!hasTarget) {
    problems.push('target needs at least one of universeIds, placeIds or nameMatch (run `npm run resolve`)');
  }
  if (w.probe?.enabled) {
    if (w.probe.maxPerCycle > 25) {
      problems.push('probe.maxPerCycle above 25 is a great way to get your account captcha-walled');
    }
    if (w.probe.minIntervalMs < 500) problems.push('probe.minIntervalMs below 500 is too fast for follow calls');
    if (w.probe.maxActiveFollows < w.probe.maxPerCycle) {
      problems.push('probe.maxActiveFollows must be at least probe.maxPerCycle');
    }
  }

  if (problems.length) {
    throw new Error(`Watcher "${w.name ?? '(unnamed)'}" is invalid: ${problems.join('; ')}`);
  }
}
