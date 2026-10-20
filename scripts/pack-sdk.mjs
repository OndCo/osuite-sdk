import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (!process.env.npm_execpath) throw new Error('Run this script through npm run pack:sdk.');
mkdirSync(new URL('../output/', import.meta.url), { recursive: true });
const result = spawnSync(process.execPath, [process.env.npm_execpath, 'pack', './sdk',
  '--ignore-scripts', '--pack-destination', 'output', '--json'], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
