#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { runCursorHookCli } from '../../sdk/runtime/cursor.mjs';
await runCursorHookCli({ installDir: fileURLToPath(new URL('.', import.meta.url)), event: 'preToolUse' });
