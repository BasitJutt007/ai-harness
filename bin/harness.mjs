#!/usr/bin/env node
// Thin launcher: registers the TypeScript loader, then hands off to the core CLI.
import { register } from 'tsx/esm/api';

register();
const { main } = await import('../src/core/cli.ts');
const code = await main(process.argv.slice(2));
process.exitCode = code;
