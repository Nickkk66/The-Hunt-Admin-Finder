#!/usr/bin/env node
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

/**
 * Scaffolds the two files the watcher needs but cannot ship: .env (your cookie
 * and webhooks) and watchers.json (what to watch). Both are gitignored. Never
 * overwrites an existing file, so re-running this is safe.
 */

const COPIES = [
  ['.env.example', '.env'],
  ['watchers.example.json', 'watchers.json'],
];

const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  console.error(`Node ${process.versions.node} is too old. This needs Node 20 or newer: https://nodejs.org`);
  process.exit(1);
}

let created = 0;
for (const [from, to] of COPIES) {
  if (existsSync(to)) {
    console.log(`kept    ${to} (already exists, left alone)`);
    continue;
  }
  await copyFile(from, to);
  console.log(`created ${to}`);
  created++;
}

/**
 * Both files are gitignored and never overwritten, so a repo that gains a new
 * watcher leaves everyone who set up earlier with a config that silently lacks
 * it. Nothing errors - the watcher just isn't there, or its webhook expands to
 * an empty string and every alert is dropped. So diff against the examples and
 * say what drifted.
 */
const envKeys = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => l.slice(0, l.indexOf('=')).trim());

const envText = await readFile('.env', 'utf8');
const missingKeys = envKeys(await readFile('.env.example', 'utf8')).filter(
  (k) => !envKeys(envText).includes(k),
);

if (missingKeys.length) {
  await writeFile('.env', `${envText.replace(/\n*$/, '\n')}\n${missingKeys.map((k) => `${k}=`).join('\n')}\n`);
  console.log(`added  ${missingKeys.join(', ')} to .env (they were missing, and are blank)`);
}

const names = (cfg) => (cfg.watchers ?? []).map((w) => w.name);
const mine = JSON.parse(await readFile('watchers.json', 'utf8'));
const missingWatchers = names(JSON.parse(await readFile('watchers.example.json', 'utf8'))).filter(
  (n) => !names(mine).includes(n),
);

if (missingWatchers.length) {
  console.log('');
  console.log(`Your watchers.json has no: ${missingWatchers.join(', ')}`);
  console.log('That file is yours and never overwritten, so a watcher added to the repo after you');
  console.log('set up is not in it. Copy the block you want out of watchers.example.json, or move');
  console.log('watchers.json aside and re-run this to start from the current example.');
}

// A freshly copied .env has empty values; say so rather than letting the first
// run fail with a vague auth error.
const blanks = (await readFile('.env', 'utf8'))
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#') && l.endsWith('='))
  .map((l) => l.slice(0, -1));

console.log('');
if (blanks.length) {
  console.log(`Still blank in .env: ${blanks.join(', ')}`);
  console.log('');
  console.log('  ROBLOX_COOKIE      roblox.com -> DevTools -> Application -> Cookies');
  console.log('                     -> .ROBLOSECURITY -> copy the WHOLE value');
  console.log('  DISCORD_WEBHOOK_*  Server Settings -> Integrations -> Webhooks -> Copy URL');
  console.log('');
  console.log('Fill those in, then: npm run ui');
} else {
  console.log(created ? 'Filled in already. Next: npm run ui' : 'Looks ready. Next: npm run ui');
}
