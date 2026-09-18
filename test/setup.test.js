import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SETUP = join(ROOT, 'src', 'setup.js');

/** Runs setup.js in a throwaway cwd seeded with the two example files. */
async function scaffold() {
  const dir = await mkdtemp(join(tmpdir(), 'hunt-setup-'));
  await copyFile(join(ROOT, '.env.example'), join(dir, '.env.example'));
  await copyFile(join(ROOT, 'watchers.example.json'), join(dir, 'watchers.example.json'));
  return dir;
}

test('creates .env and watchers.json from the examples', async (t) => {
  const dir = await scaffold();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { stdout } = await run(process.execPath, [SETUP], { cwd: dir });
  assert.match(stdout, /created \.env/);
  assert.match(stdout, /created watchers\.json/);

  // the copy is a real copy, not an empty placeholder
  assert.equal(await readFile(join(dir, '.env'), 'utf8'), await readFile(join(ROOT, '.env.example'), 'utf8'));
  JSON.parse(await readFile(join(dir, 'watchers.json'), 'utf8'));
});

test('names the env vars that are still blank', async (t) => {
  const dir = await scaffold();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { stdout } = await run(process.execPath, [SETUP], { cwd: dir });
  assert.match(stdout, /ROBLOX_COOKIE/);
  assert.match(stdout, /DISCORD_WEBHOOK_SILVER_WINGS/);
});

test('never clobbers a filled-in config', async (t) => {
  const dir = await scaffold();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, '.env'), 'ROBLOX_COOKIE=mine\n');
  await writeFile(join(dir, 'watchers.json'), '{"watchers":[]}');

  const { stdout } = await run(process.execPath, [SETUP], { cwd: dir });
  assert.match(stdout, /kept {4}\.env/);
  assert.equal(await readFile(join(dir, '.env'), 'utf8'), 'ROBLOX_COOKIE=mine\n');
  assert.equal(await readFile(join(dir, 'watchers.json'), 'utf8'), '{"watchers":[]}');
  assert.doesNotMatch(stdout, /Still blank/);
});
