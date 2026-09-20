import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildConfig } from './config.js';
import { RobloxClient } from './robloxClient.js';
import { Watcher } from './watcher.js';
import { sendEmbeds } from './discord.js';
import { addSink, createLogger } from './log.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = join(HERE, '..', 'docs', 'index.html');
const LOG_BUFFER = 500;

/**
 * Serves the same page GitHub Pages serves, but from localhost, where it can
 * actually drive the watchers. Loopback only, and nothing is written to disk:
 * the cookie and webhook urls live in memory until the process exits.
 */
export function startServer({ port = 8787, host = '127.0.0.1' } = {}) {
  const log = createLogger('ui');
  const runtime = { client: null, watchers: [], running: false, startedAt: 0, error: null };
  const logs = [];
  let seq = 0;

  addSink((line) => {
    logs.push({ ...line, seq: seq++ });
    if (logs.length > LOG_BUFFER) logs.splice(0, logs.length - LOG_BUFFER);
  });

  const json = (res, status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
    });
    res.end(payload);
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 2_000_000) {
          reject(new Error('request body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch (err) {
          reject(new Error(`invalid JSON body: ${err.message}`));
        }
      });
      req.on('error', reject);
    });

  async function start(body) {
    if (runtime.running) throw new Error('already running');

    const config = buildConfig(body.config ?? {}, { cookie: body.cookie ?? '' });
    if (!config.roblox.cookie) throw new Error('a .ROBLOSECURITY cookie is required to talk to Roblox');

    const enabled = config.watchers.filter((w) => w.enabled !== false);
    if (!enabled.length) throw new Error('no enabled watchers in the config');

    runtime.error = null;
    runtime.client = new RobloxClient({
      cookie: config.roblox.cookie,
      maxConcurrent: config.roblox.maxConcurrent,
      minIntervalMs: config.roblox.minIntervalMs,
    });

    const me = await runtime.client.whoami();
    log.info(`authenticated as ${me?.name ?? 'unknown'} (${me?.id ?? '?'})`);

    const muted = enabled.filter((w) => !w.webhookUrl);
    for (const w of muted) log.error(`"${w.name}" has no webhook url and will tell you nothing when it finds someone`);
    if (muted.length === enabled.length) throw new Error('every watcher is missing its webhook url; nothing would reach you');

    runtime.watchers = enabled.map((w) => new Watcher(runtime.client, w));
    runtime.running = true;
    runtime.startedAt = Date.now();

    // Kick the loops off in the background; the UI polls /api/status for progress.
    (async () => {
      try {
        for (const watcher of runtime.watchers) await watcher.init();
        await Promise.all(runtime.watchers.map((w) => w.run()));
      } catch (err) {
        runtime.error = err.message;
        runtime.running = false;
        log.error(`watchers stopped: ${err.message}`);
      }
    })();

    return { authenticatedAs: me?.name ?? null, watchers: runtime.watchers.length };
  }

  async function stop() {
    for (const w of runtime.watchers) w.stop();
    const cleanup = runtime.watchers
      .filter((w) => w.config.probe?.enabled && w.config.probe?.unfollowOnExit)
      .map((w) => w.cleanupFollows().catch((err) => log.warn(`cleanup failed: ${err.message}`)));
    await Promise.race([Promise.all(cleanup), new Promise((r) => setTimeout(r, 20000))]);
    runtime.running = false;
    runtime.watchers = [];
    runtime.client = null;
    log.info('stopped');
    return { stopped: true };
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = await readFile(PAGE, 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/status') {
        json(res, 200, {
          mode: 'local',
          running: runtime.running,
          startedAt: runtime.startedAt,
          error: runtime.error,
          watchers: runtime.watchers.map((w) => w.status()),
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/logs') {
        const since = Number(url.searchParams.get('since') ?? -1);
        json(res, 200, { lines: logs.filter((l) => l.seq > since), cursor: seq - 1 });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/start') {
        json(res, 200, await start(await readBody(req)));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/stop') {
        json(res, 200, await stop());
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/test-webhook') {
        const body = await readBody(req);
        const ok = await sendEmbeds(
          body.webhookUrl,
          [
            {
              title: 'Test alert',
              description: `If you can read this, the webhook for **${body.name ?? 'this watcher'}** works.`,
              color: body.color ?? 0xc0c0c0,
              timestamp: new Date().toISOString(),
            },
          ],
          { username: body.username ?? 'The Hunt Watcher', logger: log },
        );
        json(res, ok ? 200 : 502, { ok });
        return;
      }

      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
  });

  server.listen(port, host, () => {
    log.info(`dashboard on http://${host}:${port} (loopback only, nothing is saved to disk)`);
  });

  return { server, stop };
}
