import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectCredentialFile, readCredentialFile, writeCredentialFile } from '../../sdk/credentials.js';

const directories = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'osuite-atomic-test-'));
  directories.push(root);
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  directories.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

describe('atomic credential helper', () => {
  it('does not invoke repository-configured filesystem monitors while inspecting credentials', () => {
    const root = fixture();
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe', env: { PATH: process.env.PATH, HOME: root } });
    git('init', '-q');
    fs.writeFileSync(path.join(root, 'placeholder'), 'synthetic');
    git('add', 'placeholder');
    const monitor = path.join(root, '.git', 'synthetic-monitor');
    fs.writeFileSync(monitor, '#!/bin/sh\nprintf unsafe > git-monitor-ran\nprintf "token\\0"\n', { mode: 0o700 });
    git('config', 'core.fsmonitor', monitor);
    inspectCredentialFile(root, '.osuite/.env');
    expect(fs.existsSync(path.join(root, 'git-monitor-ran'))).toBe(false);
  });

  it('refuses a tracked case alias on case-insensitive filesystems', ({ skip }) => {
    const root = fixture();
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe', env: { PATH: process.env.PATH, HOME: root } });
    git('init', '-q');
    fs.mkdirSync(path.join(root, '.osuite'));
    const file = path.join(root, '.osuite', '.ENV');
    fs.writeFileSync(file, 'tracked-placeholder');
    if (!fs.existsSync(path.join(root, '.osuite', '.env'))) return skip();
    git('add', '.osuite/.ENV');
    expect(() => writeCredentialFile(root, '.osuite/.env', 'synthetic-new-key')).toThrow(/tracked/);
    expect(fs.readFileSync(file, 'utf8')).toBe('tracked-placeholder');
  });

  it('syncs new directory entries in their parent before reporting a durable write', () => {
    const root = fixture();
    const opened = new Map();
    const synced = [];
    const open = fs.openSync;
    const sync = fs.fsyncSync;
    vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
      const fd = open(file, ...args);
      opened.set(fd, String(file));
      return fd;
    });
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      if (fs.fstatSync(fd).isDirectory()) synced.push(opened.get(fd));
      return sync(fd);
    });
    writeCredentialFile(root, '.osuite/.env', 'synthetic-new-key');
    expect(synced).toContain(fs.realpathSync(root));
    expect(synced).toContain(path.join(fs.realpathSync(root), '.osuite'));
  });

  it('keeps the old credential unchanged if fsync fails before atomic replacement', () => {
    const root = fixture();
    writeCredentialFile(root, '.osuite/.env', 'synthetic-old-key');
    const file = path.join(root, '.osuite/.env');
    const before = fs.statSync(file);
    vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw new Error('synthetic fsync failure'); });
    expect(() => writeCredentialFile(root, '.osuite/.env', 'synthetic-new-key')).toThrow('synthetic fsync failure');
    expect(fs.readFileSync(file, 'utf8')).toBe('synthetic-old-key');
    expect(fs.statSync(file).ino).toBe(before.ino);
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.includes('osuite-tmp'))).toEqual([]);
  });

  it('replaces an existing 0644 file atomically with 0600 instead of inheriting its permissions', () => {
    const root = fixture();
    writeCredentialFile(root, '.osuite/.env', 'synthetic-old-key');
    const file = path.join(root, '.osuite/.env');
    fs.chmodSync(file, 0o644);
    const before = fs.statSync(file);
    writeCredentialFile(root, '.osuite/.env', 'synthetic-new-key');
    expect(fs.statSync(file).ino).not.toBe(before.ino);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readCredentialFile(root, '.osuite/.env')).toBe('synthetic-new-key');
  });

  it('refuses hard-linked credentials and symlinked ignore files', () => {
    const root = fixture();
    fs.mkdirSync(path.join(root, '.osuite'));
    fs.writeFileSync(path.join(root, 'outside'), 'untouched');
    fs.linkSync(path.join(root, 'outside'), path.join(root, '.osuite/.env'));
    expect(() => writeCredentialFile(root, '.osuite/.env', 'new')).toThrow(/links/);
    fs.unlinkSync(path.join(root, '.osuite/.env'));
    fs.symlinkSync(path.join(root, 'outside'), path.join(root, '.osuite/.gitignore'));
    expect(() => writeCredentialFile(root, '.osuite/.env', 'new')).toThrow(/symlink/);
    expect(fs.readFileSync(path.join(root, 'outside'), 'utf8')).toBe('untouched');
  });
});
