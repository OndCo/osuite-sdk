import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = file => JSON.parse(readFileSync(path.join(root, file), 'utf8'));

describe('additive governed native tools SDK package', () => {
  it('adds an ESM-only subpath without changing old root exports or dependencies', () => {
    const pkg = read('sdk/package.json');
    expect(pkg.exports['./governed-tools']).toEqual({ import: './governed-tools.mjs' });
    expect(pkg.exports['.']).toEqual({ import: './osuite.js', require: './index.cjs' });
    expect(pkg.engines.node).toBe('>=18.0.0');
    expect(pkg.dependencies).toEqual({});
    expect(pkg.files).toContain('governed-tools/*.mjs');
    expect(pkg.version).not.toBe('2.10.2');
  });

  it('gives an explicit Node 24 requirement before loading SQLite on other majors', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      'try { const m = await import("./sdk/governed-tools.mjs"); console.log(typeof m.createGovernedTools, typeof m.wrapMcpClient); } catch(e) { console.log(e.code); process.exitCode = 24; }'], { cwd: root, encoding: 'utf8' });
    if (Number(process.versions.node.split('.')[0]) === 24) {
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('function function');
    } else {
      expect(result.status).toBe(24);
      expect(result.stdout.trim()).toBe('NODE_24_REQUIRED');
    }
  });
});
