#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { runHookCli } from '../../sdk/runtime/hook.mjs';
await runHookCli({ host: 'claude', installDir: fileURLToPath(new URL('.', import.meta.url)), event: 'PreToolUse' });
