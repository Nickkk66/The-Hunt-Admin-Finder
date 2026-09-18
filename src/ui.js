#!/usr/bin/env node
import { loadEnv } from './config.js';
import { startServer } from './server.js';

await loadEnv();
const portArg = process.argv.indexOf("--port");
const port = portArg > -1 ? Number(process.argv[portArg + 1]) : Number(process.env.UI_PORT) || 8787;
startServer({ port });
