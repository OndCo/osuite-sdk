import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as hooks from '../../sdk/projectHooks.js';

const roots = [];
function root() { const value = mkdtempSync(path.join(tmpdir(), "osuite node ' install ")); roots.push(value); return value; }
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
function bootstrap(runtime, projectRoot, files = {}) {
  expect(hooks.buildNodeRuntimeBootstrap, 'SDK exports the complete Node bootstrap overlay').toBeTypeOf('function');
  return hooks.buildNodeRuntimeBootstrap(runtime, { runtime: { id: runtime }, recommended_env: 'OSUITE_HOOK_MODE=observe', files }, { projectRoot });
}
function install(project, bundle) {
  return Object.entries(bundle.files).map(([name, contents]) => hooks.installProjectFile(project, name, contents));
}

describe('Packaged Node runtime installation', () => {
  it.each(['claude', 'codex'])('installs a self-contained %s Node hook and MCP bridge with no Python, dependency installation or repository imports', runtime => {
    const project = root();
    const directory = runtime === 'claude' ? '.claude' : '.codex';
    const files = { [`${directory}/hooks/osuite_pretool.py`]: 'legacy', ...(runtime === 'claude' ? { '.claude/settings.local.json': '{"hooks":{}}' } : {}) };
    const bundle = bootstrap(runtime, project, files);
    expect(bundle.recommended_env).toBe('OSUITE_HOOK_MODE=observe');
    expect(Object.keys(bundle.files).some(file => file.endsWith('.py'))).toBe(false);
    expect(bundle.files[`${directory}/runtime/mcp.mjs`]).toBeTruthy();
    expect(bundle.files[`${directory}/runtime/hook.mjs`]).toBeTruthy();
    if (runtime === 'claude') expect(bundle.files).not.toHaveProperty('.claude/settings.local.json');
    expect(hooks.installBlockers(install(project, bundle))).toEqual([]);
    const installations = hooks.findHookInstallations(project, [runtime]);
    expect(installations).toHaveLength(1);
    expect(installations[0].pretool.command).toContain('osuite_pretool.mjs');
    expect(installations[0].problems).toEqual([]);
    const child = spawnSync('/bin/sh', ['-c', installations[0].pretool.command], { cwd: tmpdir(), input: 'bad-json', encoding: 'utf8', env: { PATH: path.dirname(process.execPath) }, timeout: 5000 });
    expect(child.status, child.stderr).toBe(2);
    expect(JSON.parse(child.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    const mcp = spawnSync(process.execPath, [path.join(project, directory, 'server/osuite_runtime_mcp.mjs')], { input: '{"jsonrpc":"2.0","id":1,"method":"ping"}\n', encoding: 'utf8', env: { PATH: path.dirname(process.execPath) }, timeout: 5000 });
    expect(mcp.status, mcp.stderr).toBe(0);
    expect(JSON.parse(mcp.stdout).result).toEqual({});
  });
  it('migrates stock legacy commands once without removing old files or re-enabling disabled hooks', () => {
    const project = root(); mkdirSync(path.join(project, '.claude/hooks'), { recursive: true });
    const existing = { disableAllHooks: true, hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'python3 .claude/hooks/osuite_pretool.py' }] }] } };
    writeFileSync(path.join(project, '.claude/settings.json'), JSON.stringify(existing));
    writeFileSync(path.join(project, '.claude/hooks/osuite_pretool.py'), 'legacy-custom-body');
    const bundle = bootstrap('claude', project);
    const reports = install(project, bundle);
    const settings = JSON.parse(readFileSync(path.join(project, '.claude/settings.json')));
    expect(settings.disableAllHooks).toBe(true);
    expect(settings.hooks.PreToolUse.flatMap(g => g.hooks)).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('osuite_pretool.mjs');
    expect(readFileSync(path.join(project, '.claude/hooks/osuite_pretool.py'), 'utf8')).toBe('legacy-custom-body');
    expect(hooks.installBlockers(reports).join(' ')).toContain('disableAllHooks');
    expect(hooks.findHookInstallations(project)[0].hostEnabled).toBe(false);
    expect(install(project, bundle).every(report => report.status === 'unchanged')).toBe(true);
  });
  it('does not install duplicate project hooks when the existing OSuite registration is in local settings', () => {
    const project = root(); mkdirSync(path.join(project, '.claude'), { recursive: true });
    writeFileSync(path.join(project, '.claude/settings.local.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'python3 .claude/hooks/osuite_pretool.py' }] }] } }));
    const bundle = bootstrap('claude', project);
    install(project, bundle);
    expect(existsSync(path.join(project, '.claude/settings.json'))).toBe(false);
    expect(hooks.findHookInstallations(project)[0].pretool.settingsPath).toBe('.claude/settings.local.json');
  });
  it('preserves custom legacy hook commands and reports a migration blocker instead of silently double-running', () => {
    const project = root(); mkdirSync(path.join(project, '.claude'), { recursive: true });
    const command = 'python3 /custom/security/osuite_pretool.py --special';
    writeFileSync(path.join(project, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command }] }] } }));
    const reports = install(project, bootstrap('claude', project));
    const settings = JSON.parse(readFileSync(path.join(project, '.claude/settings.json')));
    expect(settings.hooks.PreToolUse.flatMap(g => g.hooks).map(h => h.command)).toEqual([command]);
    expect(hooks.installBlockers(reports).join(' ')).toMatch(/legacy|migration/i);
  });
  it('merges only the OSuite MCP registration, preserving unrelated servers and Codex disabled flags', () => {
    const project = root(); mkdirSync(path.join(project, '.codex'));
    writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { command: 'custom-docs' } } }));
    install(project, bootstrap('claude', project));
    const mcp = JSON.parse(readFileSync(path.join(project, '.mcp.json')));
    expect(mcp.mcpServers.docs).toEqual({ command: 'custom-docs' });
    expect(mcp.mcpServers.osuite_runtime_governance.command).toBe('node');
    writeFileSync(path.join(project, '.codex/config.toml'), '[features]\nhooks = false\ncodex_hooks = false\n');
    const reports = install(project, bootstrap('codex', project));
    const toml = readFileSync(path.join(project, '.codex/config.toml'), 'utf8');
    expect(toml).toContain('hooks = false');
    expect(toml).toContain('codex_hooks = false');
    expect(hooks.installBlockers(reports).join(' ')).toContain('hooks');
  });

  it('reports a retained Python or custom Codex MCP registration as a blocker, not a Node-only success', () => {
    const project = root(); mkdirSync(path.join(project, '.codex'));
    const existing = '[mcp_servers.osuite_runtime_governance]\ncommand = "python3"\nargs = ["custom.py"]\n';
    writeFileSync(path.join(project, '.codex/config.toml'), existing);
    const reports = install(project, bootstrap('codex', project));
    expect(readFileSync(path.join(project, '.codex/config.toml'), 'utf8')).toContain(existing.trim());
    expect(hooks.installBlockers(reports).join(' ')).toMatch(/MCP.*preserved|preserved.*MCP/);
  });

  it('does not call duplicate project/local OSuite hook registrations a safe single installation', () => {
    const project = root(); mkdirSync(path.join(project, '.claude'));
    const registered = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'python3 .claude/hooks/osuite_pretool.py' }] }] } };
    for (const name of ['settings.json', 'settings.local.json']) writeFileSync(path.join(project, '.claude', name), JSON.stringify(registered));
    install(project, bootstrap('claude', project));
    expect(hooks.findHookInstallations(project)[0].problems.join(' ')).toMatch(/multiple|duplicate/i);
    expect(readFileSync(path.join(project, '.claude/settings.local.json'), 'utf8')).toContain('osuite_pretool.py');
  });
});
