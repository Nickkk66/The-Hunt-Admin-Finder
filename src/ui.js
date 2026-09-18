#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { loadEnv } from './config.js';
import { startServer } from './server.js';

await loadEnv();
const args = process.argv.slice(2);
const flag = (name) => args.indexOf(name);

const portArg = flag('--port');
const port = portArg > -1 ? Number(args[portArg + 1]) : Number(process.env.UI_PORT) || 8787;

startServer({ port });

if (flag('--no-open') === -1) openBrowser(`http://127.0.0.1:${port}/`);

/** Best effort: if the platform's opener isn't there, the logged url still works. */
function openBrowser(url) {
  const [cmd, cmdArgs] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // no opener on this box; the user opens the url by hand
  }
}
