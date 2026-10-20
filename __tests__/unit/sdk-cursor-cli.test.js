import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CREDENTIAL_PATHS } from '../../sdk/credentials.js';

const cli = path.resolve('sdk/cli.js');
const roots = [];
function project() {
  const root = mkdtempSync(path.join(tmpdir(), "osuite cursor cli ' "));
  roots.push(root);
  return root;
}
function run(root, args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', timeout: 10000,
    env: { PATH: path.dirname(process.execPath), HOME: root, NO_COLOR: '1', OSUITE_NO_BROWSER: '1' } });
}
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe('Cursor CLI enrollment identity', () => {
  it('installs packaged Cursor hooks rather than falling through to generic SDK setup', () => {
    const root = project();
    const fixture = path.join(root, 'bootstrap.json');
    writeFileSync(fixture, '{"files":{}}');
    const result = run(root, ['init', 'cursor', '--from', fixture]);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(existsSync(path.join(root, '.cursor/hooks/osuite_pretool.mjs'))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(root, '.cursor/hooks.json'))).hooks.preToolUse[0].failClosed).toBe(true);
    expect(result.stdout).toContain('osuite connect cursor');
    expect(existsSync(path.join(root, '.claude'))).toBe(false);
    expect(existsSync(path.join(root, '.codex'))).toBe(false);
  });

  it('detects Cursor in a Cursor-only project without enrolling or creating files during dry run', () => {
    const root = project();
    mkdirSync(path.join(root, '.cursor'));
    const result = run(root, ['connect', 'auto', '--dry-run']);
    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('Detected runtime     cursor');
    expect(result.stdout).toContain('would install project hook files for cursor');
    expect(existsSync(path.join(root, '.cursor/.env'))).toBe(false);
    expect(existsSync(path.join(root, '.osuite'))).toBe(false);
    expect(CREDENTIAL_PATHS).toContain('.cursor/.env');
  });
});
