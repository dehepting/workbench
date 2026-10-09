#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from '../src/env.js';
import { openStore } from '../src/store.js';
import { startServer } from '../src/server.js';
import { startMcp } from '../src/mcp.js';
import { startWorker } from '../src/worker.js';

loadEnv();

const args = process.argv.slice(2);
const dataDir = process.env.WORKBENCH_DATA || join(homedir(), '.workbench');
const db = openStore(dataDir);

if (args.includes('--mcp')) {
  startMcp(db);
} else if (args.includes('--worker')) {
  const i = args.indexOf('--worker');
  startWorker(db, {
    agent: args[i + 1] || process.env.WORKBENCH_AGENT || 'worker-1',
    exec: process.env.WORKBENCH_WORKER_EXEC || null,
  });
} else {
  startServer(db);
}
