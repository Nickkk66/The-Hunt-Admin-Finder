#!/usr/bin/env node
import { loadConfig, loadEnv } from './config.js';
import { RobloxClient } from './robloxClient.js';
import { Watcher } from './watcher.js';
import { log } from './log.js';

/** Mirrors how the config builder names webhook env vars. */
const envKeyFor = (name) =>
  'DISCORD_WEBHOOK_' + String(name || 'watcher').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');

function parseArgs(argv) {
  const args = { once: false, refresh: false, only: null, config: 'watchers.json', unfollowAll: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--once') args.once = true;
    else if (a === '--refresh') args.refresh = true;
    else if (a === '--unfollow-all') args.unfollowAll = true;
    else if (a === '--only') args.only = String(argv[++i] ?? '').split(',').map((n) => n.trim()).filter(Boolean);
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const HELP = `
the-hunt-admin-finder

  npm start                 watch every enabled watcher forever
  npm run once              run a single sweep and exit
  npm run resolve <link>    turn a roblox share link into ids for watchers.json

Flags:
  --once            one sweep, then exit
  --refresh         re-scrape the group member list even if the cache is warm
  --only <names>    run these watchers by name, comma separated, even if
                    they are disabled in the config (e.g. --only obsidian-wings)
  --config <path>   config file (default watchers.json)
  --unfollow-all    undo every follow the probe made, then exit
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  await loadEnv();
  const config = await loadConfig(args.config);

  if (!config.roblox.cookie) {
    log.warn(
      'No ROBLOX_COOKIE set. Group member listing and presence both require a logged-in cookie; ' +
        'expect 401/403 without one.',
    );
  }

  const client = new RobloxClient({
    cookie: config.roblox.cookie,
    maxConcurrent: config.roblox.maxConcurrent,
    minIntervalMs: config.roblox.minIntervalMs,
  });

  const me = await client.whoami().catch((err) => {
    log.error(`cookie check failed: ${err.message}`);
    return null;
  });
  if (me) log.info(`authenticated as ${me.name} (${me.id})`);

  // --only overrides `enabled`, so you can run a parked watcher for one sweep
  // without editing the config back and forth.
  let selected = args.only
    ? config.watchers.filter((w) => args.only.includes(w.name))
    : config.watchers.filter((w) => w.enabled !== false);
  if (!selected.length) {
    log.error(
      args.only
        ? `no watcher named ${args.only.map((n) => `"${n}"`).join(' or ')}. Config has: ${config.watchers.map((w) => w.name).join(', ')}`
        : 'no enabled watchers in config',
    );
    process.exitCode = 1;
    return;
  }

  // An unset ${DISCORD_WEBHOOK_...} expands to an empty string, so a watcher
  // with a stale .env sweeps happily and drops every alert at the last step.
  // That failure is invisible until you notice you were never pinged, so say it
  // at startup instead of once per missed hit.
  const muted = selected.filter((w) => !w.webhookUrl);
  for (const w of muted) {
    log.error(
      `"${w.name}" has no webhook url, so it will find people and tell you nothing. ` +
        `Set ${envKeyFor(w.name)} in .env (it is in .env.example).`,
    );
  }
  if (muted.length === selected.length) {
    log.error('every selected watcher is muted; fix .env before this is worth running');
    process.exitCode = 1;
    return;
  }

  const watchers = selected.map((w) => new Watcher(client, w));

  for (const watcher of watchers) {
    await watcher.init({ forceRefresh: args.refresh });
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) process.exit(1); // second ctrl-c: give up on cleanup
    shuttingDown = true;
    log.info('shutting down, cleaning up follows (ctrl-c again to skip)...');
    for (const w of watchers) w.stop();
    await cleanup(watchers);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (args.unfollowAll) {
    let total = 0;
    for (const watcher of watchers) total += await watcher.cleanupFollows({ force: true });
    log.info(`done, unfollowed ${total} user(s)`);
    return;
  }

  if (args.once) {
    for (const watcher of watchers) await watcher.tick();
    await cleanup(watchers);
    return;
  }

  log.info(`watching ${watchers.length} rank(s); ctrl-c to stop`);
  await Promise.all(watchers.map((w) => w.run()));
}

/** Drops probe follows that are no longer useful. Never blocks exit for long. */
async function cleanup(watchers) {
  const jobs = watchers
    .filter((w) => w.config.probe?.enabled && w.config.probe?.unfollowOnExit)
    .map((w) => w.cleanupFollows().catch((err) => log.warn(`cleanup failed for ${w.config.name}: ${err.message}`)));
  if (!jobs.length) return;
  await Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, 30000))]);
}

main().catch((err) => {
  log.error(err.stack || err.message);
  process.exitCode = 1;
});
