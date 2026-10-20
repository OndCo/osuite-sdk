#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { runHookCli } from './osuite_runtime.mjs';
await runHookCli({ host: 'codex', runtimeId: 'codex_plugin', installDir: fileURLToPath(new URL('..', import.meta.url)), event: 'SessionStart' });
