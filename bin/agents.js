#!/usr/bin/env node
// Multi-agent orchestrator CLI

import { openStore } from '../src/store.js';
import { startOrchestrator } from '../src/orchestrator.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dataDir = process.env.WORKBENCH_DATA || join(homedir(), '.workbench');
const db = openStore(dataDir);

startOrchestrator(db);
