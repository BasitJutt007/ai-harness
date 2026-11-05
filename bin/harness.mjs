#!/usr/bin/env node
// Thin launcher: registers the TypeScript loader, loads the owner's provider keys from their env file
// (names only are ever printed), then hands off to the core CLI.
import { register } from 'tsx/esm/api';

register();
const { main, loadUserEnv } = await import('../src/core/cli.ts');
const env = loadUserEnv();
for (const w of env.warnings) process.stderr.write(`harness: ${w}\n`);
const code = await main(process.argv.slice(2));
process.exitCode = code;
