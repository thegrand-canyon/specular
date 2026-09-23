#!/usr/bin/env node
/** Writes mcp-server/openapi.json from the shared tool registry. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApi } from './openapi.js';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'openapi.json');
fs.writeFileSync(out, JSON.stringify(buildOpenApi(), null, 2) + '\n');
console.log(`wrote ${out}`);
