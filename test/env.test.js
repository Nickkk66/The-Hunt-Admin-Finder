import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadEnv } from '../src/config.js';

test('loads values from a readable .env', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hunt-env-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = join(dir, '.env');
  await writeFile(file, 'HUNT_TEST_READABLE="yes"\n# comment\n\n');
  await loadEnv(file);
  assert.equal(process.env.HUNT_TEST_READABLE, 'yes');
});

test('survives a .env that exists but cannot be read', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hunt-env-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // A directory named .env fails the open the same way an antivirus lock or an
  // un-hydrated cloud placeholder does: it exists, it just will not read.
  const blocked = join(dir, '.env');
  await mkdir(blocked);

  const warnings = [];
  const realWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  t.after(() => {
    console.warn = realWarn;
  });

  await assert.doesNotReject(loadEnv(blocked));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /cannot read/);
  assert.match(warnings[0], /continuing without it/);
});

test('a missing .env is silent, not a warning', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hunt-env-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const warnings = [];
  const realWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  t.after(() => {
    console.warn = realWarn;
  });

  await assert.doesNotReject(loadEnv(join(dir, 'nope.env')));
  assert.equal(warnings.length, 0);
});
