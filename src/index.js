#!/usr/bin/env node
import { loadConfig, loadEnv } from './config.js';
import { RobloxClient } from './robloxClient.js';
import { Watcher } from './watcher.js';
import { log } from './log.js';

function parseArgs(argv) {
  const args = { once: false, refresh: false, only: null, config: 'watchers.json' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--once') args.once = true;
    else if (a === '--refresh') args.refresh = true;
    else if (a === '--only') args.only = argv[++i];
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
  --only <name>     run a single watcher by name (e.g. silver-wings)
  --config <path>   config file (default watchers.json)
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

  let selected = config.watchers.filter((w) => w.enabled !== false);
  if (args.only) selected = selected.filter((w) => w.name === args.only);
  if (!selected.length) {
    log.error(args.only ? `no enabled watcher named "${args.only}"` : 'no enabled watchers in config');
    process.exitCode = 1;
    return;
  }

  const watchers = selected.map((w) => new Watcher(client, w));

  for (const watcher of watchers) {
    await watcher.init({ forceRefresh: args.refresh });
  }

  const shutdown = () => {
    log.info('shutting down...');
    for (const w of watchers) w.stop();
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (args.once) {
    for (const watcher of watchers) await watcher.tick();
    return;
  }

  log.info(`watching ${watchers.length} rank(s); ctrl-c to stop`);
  await Promise.all(watchers.map((w) => w.run()));
}

main().catch((err) => {
  log.error(err.stack || err.message);
  process.exitCode = 1;
});
