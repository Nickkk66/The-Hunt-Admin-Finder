import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const STATE_DIR = process.env.STATE_DIR || '.state';

const safeName = (name) => String(name).replace(/[^a-z0-9._-]+/gi, '_');

export function statePath(name) {
  return join(STATE_DIR, `${safeName(name)}.json`);
}

export async function readState(name, fallback = {}) {
  try {
    return JSON.parse(await readFile(statePath(name), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return fallback;
  }
}

export async function writeState(name, data) {
  const path = statePath(name);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, path);
}
