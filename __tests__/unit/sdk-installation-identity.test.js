import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getInstallationIdentity } from '../../sdk/installationIdentity.js';

const roots = [];
const makeRoot = () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'osuite-installation-id-'));
  roots.push(root);
  return root;
};
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

describe('protected project/runtime installation metadata', () => {
  it('persists the same identity only for the same project and runtime', () => {
    const root = makeRoot();
    const first = getInstallationIdentity(root, '.codex/.env', 'codex');
    expect(getInstallationIdentity(root, '.codex/.env', 'codex')).toEqual(first);
    const second = getInstallationIdentity(root, '.claude/.env', 'claude');
    const otherProject = getInstallationIdentity(makeRoot(), '.codex/.env', 'codex');
    expect(new Set([first, second, otherProject].map(value => value.installation_id)).size).toBe(3);
    expect(new Set([first, second, otherProject].map(value => value.agent_id)).size).toBe(3);
    expect(fs.statSync(path.join(root, '.codex/.env.identity.json')).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(root, '.codex/.gitignore'), 'utf8')).toContain('/.env.identity.json');
    expect(Object.keys(first).sort()).toEqual(['agent_id', 'installation_id', 'runtime', 'schema_version']);
  });

  it('does not read, write, or repair identity state during a dry run', () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, '.osuite'));
    const file = path.join(root, '.osuite/.env.identity.json');
    fs.writeFileSync(file, 'deliberately invalid');
    expect(getInstallationIdentity(root, '.osuite/.env', 'sdk', { dryRun: true }).agent_id).toMatch(/^sdk-runtime-/);
    expect(fs.readFileSync(file, 'utf8')).toBe('deliberately invalid');
    expect(fs.existsSync(path.join(root, '.gitignore'))).toBe(false);
  });

  it.each(['{', JSON.stringify({ schema_version: 'osuite.installation.v1', runtime: 'sdk', installation_id: 'shared', agent_id: 'sdk-runtime' })])(
    'refuses invalid identity metadata without minting a replacement (%s)', raw => {
      const root = makeRoot();
      fs.mkdirSync(path.join(root, '.osuite'));
      const file = path.join(root, '.osuite/.env.identity.json');
      fs.writeFileSync(file, raw, { mode: 0o600 });
      expect(() => getInstallationIdentity(root, '.osuite/.env', 'sdk')).toThrow(/identity/);
      expect(fs.readFileSync(file, 'utf8')).toBe(raw);
    });

  it('refuses a symlink or repository-tracked identity instead of trusting a shared copy', () => {
    const root = makeRoot();
    const outside = makeRoot();
    const original = getInstallationIdentity(outside, '.osuite/.env', 'sdk');
    fs.mkdirSync(path.join(root, '.osuite'));
    fs.symlinkSync(path.join(outside, '.osuite/.env.identity.json'), path.join(root, '.osuite/.env.identity.json'));
    expect(() => getInstallationIdentity(root, '.osuite/.env', 'sdk')).toThrow(/symlink|symbolic/i);
    expect(getInstallationIdentity(outside, '.osuite/.env', 'sdk')).toEqual(original);

    const tracked = makeRoot();
    const identity = getInstallationIdentity(tracked, '.osuite/.env', 'sdk');
    execFileSync('git', ['init', '--quiet'], { cwd: tracked });
    execFileSync('git', ['add', '--force', '--', '.osuite/.env.identity.json'], { cwd: tracked });
    expect(() => getInstallationIdentity(tracked, '.osuite/.env', 'sdk')).toThrow(/tracked/i);
    expect(JSON.parse(fs.readFileSync(path.join(tracked, '.osuite/.env.identity.json'), 'utf8'))).toEqual(identity);
  });
});
