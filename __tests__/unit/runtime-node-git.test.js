import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildActionContext } from '../../sdk/runtime/context.mjs';

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
const config = { host: 'codex', agentId: 'agent-test', runtimeId: 'codex_hooks', mode: 'enforce' };
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'osuite-node-git-')); roots.push(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'absent') } }).trim();
  git('init', '-b', 'main');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'isolated test fixture');
  git('remote', 'add', 'origin', 'git@github.com:example/fixture.git');
  return { root, git };
}
async function module() {
  expect(existsSync(path.resolve('sdk/runtime/git.mjs')), 'Node Git publication binding exists').toBe(true);
  return import('../../sdk/runtime/git.mjs');
}

describe('Node Git publication exact-action binding', () => {
  it('collects actual local repository and immutable commit evidence without pushing', async () => {
    const { collectGitPublication } = await module();
    const { root, git } = fixture();
    const publication = collectGitPublication('git push origin main', root);
    expect(publication).toMatchObject({ schema_version: 'osuite.git_publication.v1', working_directory: realpathSync(root), repository: 'github.com/example/fixture', source_commit: git('rev-parse', 'HEAD') });
    const context = buildActionContext({ tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd: root }, config);
    expect(JSON.parse(context.input_summary).git_publication).toEqual(publication);
  });
  it('refuses expansive flags, wrappers, multiple refs and credential-bearing remote URLs', async () => {
    const { collectGitPublication } = await module();
    const { root, git } = fixture();
    for (const command of ['git push', 'git push --force origin main', 'git push origin :main', 'git push origin main dev', 'git push origin main && echo more', 'env X=y git push origin main', 'git push origin main\n']) expect(collectGitPublication(command, root)).toBeNull();
    git('remote', 'set-url', 'origin', 'https://user:secret@github.com/example/fixture.git');
    expect(collectGitPublication('git push origin main', root)).toBeNull();
  });
  it.each([['remote.origin.mirror', 'true'], ['push.followTags', 'true'], ['push.recurseSubmodules', 'on-demand'], ['remote.origin.receivepack', 'custom-command'], ['push.pushOption', 'ci.skip']])('rejects side-effect-expanding config %s', async (key, value) => {
    const { collectGitPublication } = await module();
    const { root, git } = fixture(); git('config', key, value);
    expect(collectGitPublication('git push origin main', root)).toBeNull();
  });
  it('refuses release after source drift or missing returned server publication evidence', async () => {
    const { validateGitPublication } = await module();
    const { root, git } = fixture();
    const context = buildActionContext({ tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd: root }, config);
    const server = { action: { input_summary: context.input_summary } };
    expect(validateGitPublication(context, server)).toBe(true);
    expect(validateGitPublication(context, { action: { input_summary: '{}' } })).toBe(false);
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'isolated drift fixture');
    expect(validateGitPublication(context, server)).toBe(false);
  });
});
