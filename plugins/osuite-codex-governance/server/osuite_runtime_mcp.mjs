#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { runMcpCli } from '../hooks/osuite_runtime.mjs';
await runMcpCli({ host: 'codex', runtimeId: 'codex_plugin', installDir: fileURLToPath(new URL('..', import.meta.url)) });
