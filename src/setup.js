#!/usr/bin/env node
import { copyFile, readFile } from 'node:fs/promises';
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
