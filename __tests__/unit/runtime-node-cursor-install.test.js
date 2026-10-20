import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildNodeRuntimeBootstrap, findHookInstallations, hookCredentials, installBlockers, installProjectFile } from '../../sdk/projectHooks.js';

const roots = [];
function project() { const root = mkdtempSync(path.join(tmpdir(), "osuite cursor ' fixture ")); roots.push(root); return root; }
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
const install = (root, bundle) => Object.entries(bundle.files).map(([name, body]) => installProjectFile(root, name, body));

describe('Cursor project installation uses the native flat schema', () => {
  it.each(['cursor', 'cursor_hooks'])('builds portable Node-only %s assets and configured commands run in an isolated project', target => {
    const root = project();
    const bundle = buildNodeRuntimeBootstrap(target, { recommended_env: 'OSUITE_HOOK_MODE=enforce' }, { projectRoot: root });
    const settings = JSON.parse(bundle.files['.cursor/hooks.json']);
    expect(settings.version).toBe(1);
    expect(Object.keys(settings.hooks).sort()).toEqual(['postToolUse', 'postToolUseFailure', 'preToolUse', 'sessionEnd', 'sessionStart', 'stop']);
    expect(settings.hooks.preToolUse).toEqual([{ command: 'node .cursor/hooks/osuite_pretool.mjs', timeout: 60, failClosed: true }]);
    expect(settings.hooks.postToolUseFailure).toEqual(settings.hooks.postToolUse);
    expect(bundle.files['.cursor/runtime/cursor.mjs']).toContain('runCursorHookCli');
    expect(Object.keys(bundle.files).some(file => file.endsWith('.py'))).toBe(false);
    expect(bundle.node_runtime).toMatchObject({ settings_path: '.cursor/hooks.json', requires_host_trust_review: true });
    expect(installBlockers(install(root, bundle))).toEqual([]);
    const [found] = findHookInstallations(root, ['cursor']);
    expect(found).toMatchObject({ runtime: 'cursor', installDir: '.cursor', hostEnabled: true, problems: [] });
    const env = { PATH: path.dirname(process.execPath), HOME: root, TMPDIR: root };
    const pre = spawnSync('/bin/sh', ['-c', found.pretool.command], { cwd: root, env, input: 'invalid', encoding: 'utf8', timeout: 5000 });
    expect(pre.status, pre.stderr).toBe(2);
    expect(JSON.parse(pre.stdout).permission).toBe('deny');
    const server = JSON.parse(bundle.files['.cursor/mcp.json']).mcpServers.osuite_runtime_governance;
    expect(server).toEqual({ type: 'stdio', command: 'node', args: ['${workspaceFolder}/.cursor/server/osuite_runtime_mcp.mjs'] });
    const mcp = spawnSync(server.command, server.args.map(arg => arg.replace('${workspaceFolder}', root)), {
      cwd: root, env, input: '{"jsonrpc":"2.0","id":1,"method":"ping"}\n', encoding: 'utf8', timeout: 5000,
    });
    expect(mcp.status, mcp.stderr).toBe(0);
    expect(JSON.parse(mcp.stdout).result).toEqual({});
    expect(install(root, bundle).every(row => row.status === 'unchanged')).toBe(true);
  });

  it('preserves unrelated hooks, top-level metadata, and unrelated MCP servers', () => {
    const root = project(); mkdirSync(path.join(root, '.cursor'));
    const existing = { version: 1, metadata: { owner: 'fixture' }, hooks: { preToolUse: [{ command: 'custom-audit', matcher: 'Shell' }] } };
    writeFileSync(path.join(root, '.cursor/hooks.json'), JSON.stringify(existing));
    writeFileSync(path.join(root, '.cursor/mcp.json'), JSON.stringify({ mcpServers: { docs: { command: 'custom-docs' } } }));
    expect(installBlockers(install(root, buildNodeRuntimeBootstrap('cursor', {}, { projectRoot: root })))).toEqual([]);
    const settings = JSON.parse(readFileSync(path.join(root, '.cursor/hooks.json')));
    expect(settings.metadata).toEqual(existing.metadata);
    expect(settings.hooks.preToolUse[0]).toEqual(existing.hooks.preToolUse[0]);
    expect(settings.hooks.preToolUse).toHaveLength(2);
    expect(JSON.parse(readFileSync(path.join(root, '.cursor/mcp.json'))).mcpServers.docs).toEqual({ command: 'custom-docs' });
  });

  it('uses .cursor/.env and the same observe default for diagnostics as the runtime', () => {
    const root = project(); install(root, buildNodeRuntimeBootstrap('cursor'));
    writeFileSync(path.join(root, '.cursor/.env'), 'OSUITE_BASE_URL=https://fixture.invalid\nOSUITE_API_KEY=synthetic-key\n', { mode: 0o600 });
    const found = findHookInstallations(root, ['cursor'])[0];
    expect(hookCredentials(root, found, {})).toEqual({ baseUrl: 'https://fixture.invalid', apiKey: 'synthetic-key',
      envFile: '.cursor/.env', hookMode: 'observe' });
  });

  it('preserves disabled intent and custom matching commands instead of silently replacing or double-registering', () => {
    const root = project(); mkdirSync(path.join(root, '.cursor'));
    const existing = { version: 1, disableAllHooks: true, hooks: { preToolUse: [{ command: 'node /custom/osuite_pretool.mjs --reviewed', matcher: 'Read', failClosed: false }] } };
    writeFileSync(path.join(root, '.cursor/hooks.json'), JSON.stringify(existing));
    const reports = install(root, buildNodeRuntimeBootstrap('cursor', {}, { projectRoot: root }));
    const settings = JSON.parse(readFileSync(path.join(root, '.cursor/hooks.json')));
    expect(settings.disableAllHooks).toBe(true);
    expect(settings.hooks.preToolUse).toEqual(existing.hooks.preToolUse);
    expect(installBlockers(reports).join(' ')).toMatch(/preserved/);
    expect(findHookInstallations(root, ['cursor'])[0].hostEnabled).toBe(false);
  });

  it('does not add registrations when existing disableAllHooks intent is present, even though Cursor does not document that flag', () => {
    const root = project(); mkdirSync(path.join(root, '.cursor'));
    const body = JSON.stringify({ version: 1, disableAllHooks: true, hooks: {} });
    writeFileSync(path.join(root, '.cursor/hooks.json'), body);
    const template = buildNodeRuntimeBootstrap('cursor').files['.cursor/hooks.json'];
    const report = installProjectFile(root, '.cursor/hooks.json', template, { force: true });
    expect(report.status).toBe('unchanged');
    expect(installBlockers([report]).join(' ')).toMatch(/intent.*preserved/i);
    expect(readFileSync(path.join(root, '.cursor/hooks.json'), 'utf8')).toBe(body);
  });

  it('does not qualify or replace a same-name hook configured as a prompt rather than a Node command', () => {
    const root = project(); const bundle = buildNodeRuntimeBootstrap('cursor'); install(root, bundle);
    const settings = JSON.parse(bundle.files['.cursor/hooks.json']);
    settings.hooks.preToolUse[0].type = 'prompt';
    writeFileSync(path.join(root, '.cursor/hooks.json'), JSON.stringify(settings));
    expect(findHookInstallations(root, ['cursor'])[0].problems.join(' ')).toMatch(/command.*type/);
    expect(installBlockers(install(root, bundle)).join(' ')).toMatch(/preserved/);
    expect(JSON.parse(readFileSync(path.join(root, '.cursor/hooks.json'))).hooks.preToolUse[0].type).toBe('prompt');
  });

  it.each([{ version: 2, hooks: {} }, { version: 1, hooks: false }, { version: 1, hooks: { preToolUse: {} } }])
  ('refuses incompatible config without writing over it: %j', settings => {
    const root = project(); mkdirSync(path.join(root, '.cursor'));
    const body = JSON.stringify(settings);
    writeFileSync(path.join(root, '.cursor/hooks.json'), body);
    const bundle = buildNodeRuntimeBootstrap('cursor', {}, { projectRoot: root });
    const report = installProjectFile(root, '.cursor/hooks.json', bundle.files['.cursor/hooks.json'], { force: true });
    expect(report.status).toBe('error');
    expect(readFileSync(path.join(root, '.cursor/hooks.json'), 'utf8')).toBe(body);
  });

  it('does not qualify an installed prehook without failClosed or with a partial matcher', () => {
    const root = project();
    const bundle = buildNodeRuntimeBootstrap('cursor', {}, { projectRoot: root }); install(root, bundle);
    const settings = JSON.parse(bundle.files['.cursor/hooks.json']);
    settings.hooks.preToolUse[0].failClosed = false;
    settings.hooks.preToolUse[0].matcher = 'Shell';
    writeFileSync(path.join(root, '.cursor/hooks.json'), JSON.stringify(settings));
    expect(findHookInstallations(root, ['cursor'])[0].problems.join(' ')).toMatch(/failClosed|matcher/);
    const reports = install(root, bundle);
    expect(installBlockers(reports).join(' ')).toMatch(/preserved/);
    expect(JSON.parse(readFileSync(path.join(root, '.cursor/hooks.json'))).hooks.preToolUse[0].failClosed).toBe(false);
  });

  it('never writes global or ordinary development hook settings', () => {
    const root = project();
    const bundle = buildNodeRuntimeBootstrap('cursor', {}, { projectRoot: root });
    expect(Object.keys(bundle.files).every(file => file.startsWith('.cursor/'))).toBe(true);
    install(root, bundle);
    expect(existsSync(path.join(root, '.claude'))).toBe(false);
    expect(existsSync(path.join(root, '.codex'))).toBe(false);
  });
});
