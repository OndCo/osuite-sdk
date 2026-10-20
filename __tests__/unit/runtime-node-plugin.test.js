import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
const source = path.resolve('plugins/osuite-codex-governance');

function isolatedPlugin() {
  const root = mkdtempSync(path.join(tmpdir(), 'osuite-node-plugin-'));
  roots.push(root);
  const plugin = path.join(root, 'detached plugin');
  cpSync(source, plugin, { recursive: true });
  return { root, plugin, env: { PATH: path.dirname(process.execPath), HOME: root, TMPDIR: root, PLUGIN_ROOT: plugin } };
}

describe('Standalone Node Codex plugin source package', () => {
  it('versions the Node release and publishes the planned public source URL', () => {
    const manifest = JSON.parse(readFileSync(path.join(source, '.codex-plugin/plugin.json'), 'utf8'));
    expect(manifest.version).toBe('1.1.0');
    expect(manifest.repository).toBe('https://github.com/OndCo/osuite-sdk');
  });

  it('keeps root sandbox controls out of the features table in the opt-in template', () => {
    const config = readFileSync(path.join(source, 'config.toml.partial'), 'utf8');
    const beforeFeatures = config.split('[features]')[0];
    expect(beforeFeatures).toContain('approval_policy = "on-request"');
    expect(beforeFeatures).toContain('sandbox_mode = "workspace-write"');
    expect(config).toMatch(/\[features\]\s+hooks = true/);
    expect(config).not.toMatch(/^plugin_hooks\s*=/m);
    expect(config).toMatch(/\[sandbox_workspace_write\]\s+network_access = false/);
    expect(config).not.toMatch(/OSUITE_API_KEY|PRIVATE_KEY|\/Users\//);
  });

  it('requires exact-input fresh admission after approval observation and states the advisory boundary', () => {
    const skill = readFileSync(path.join(source, 'skills/osuite-governed-runtime/SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\nname: osuite-governed-runtime\ndescription: .+\n---/);
    expect(skill).toMatch(/GET is not\s+execution authority/i);
    expect(skill).toMatch(/fresh.*osuite_preflight_action/i);
    expect(skill).toContain('tool_use_id');
    expect(skill).toContain('tool_name');
    expect(skill).toContain('tool_input');
    expect(skill).toContain('authorized: true');
    expect(skill).toMatch(/enforce.*strict/i);
    expect(skill).toMatch(/unknown.*do not retry/i);
    expect(skill).toMatch(/advisory.*not an execution gateway/i);
    expect(skill).toContain('effect_executed: false');
    expect(skill).toContain('mcp_caller_report');
  });

  it('selects Node for native hook and MCP registrations with a bounded hook timeout', () => {
    const hooks = JSON.parse(readFileSync(path.join(source, 'hooks.json'), 'utf8')).hooks;
    for (const event of ['PreToolUse', 'PostToolUse', 'SessionStart']) {
      const handler = hooks[event]?.[0]?.hooks?.[0];
      expect(handler?.command).toMatch(/^node "\$PLUGIN_ROOT\/hooks\/osuite_\w+\.mjs"$/);
      expect(handler.timeout).toBe(60);
    }
    const server = JSON.parse(readFileSync(path.join(source, '.mcp.json'), 'utf8')).mcpServers.osuite_runtime_governance;
    expect(server.command).toBe('node');
    expect(server.args).toEqual(['./server/osuite_runtime_mcp.mjs']);
    expect(server.env.OSUITE_SIGNATURE_MODE).toBe('required');
  });

  it('ships a deterministic built-in-only runtime bundle matching the shared SDK sources', async () => {
    expect(existsSync(path.join(source, 'hooks/build-node-runtime.mjs'))).toBe(true);
    const { renderNodeRuntime } = await import('../../plugins/osuite-codex-governance/hooks/build-node-runtime.mjs');
    const expected = await renderNodeRuntime();
    const actual = readFileSync(path.join(source, 'hooks/osuite_runtime.mjs'), 'utf8');
    expect(actual).toBe(expected);
    expect(actual).not.toMatch(/from ["'](?:\.\.\/|esbuild)/);
  });

  it('runs detached hook entrypoints with no SDK checkout, npm packages or Python in PATH', () => {
    const { root, plugin, env } = isolatedPlugin();
    const pre = spawnSync(process.execPath, [path.join(plugin, 'hooks/osuite_pretool.mjs')], { cwd: root, env, input: '{}', encoding: 'utf8', timeout: 5000 });
    expect(pre.status, pre.stderr).toBe(2);
    expect(JSON.parse(pre.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    const post = spawnSync(process.execPath, [path.join(plugin, 'hooks/osuite_posttool.mjs')], { cwd: root, env, input: '{"hook_event_name":"PostToolUse"}', encoding: 'utf8', timeout: 5000 });
    expect(post.status, post.stderr).toBe(0);
    expect(() => JSON.parse(post.stdout)).not.toThrow();
  });

  it('runs the detached MCP bridge using current NDJSON and emits only protocol responses', () => {
    const { root, plugin, env } = isolatedPlugin();
    const requests = [
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    ];
    const child = spawnSync(process.execPath, [path.join(plugin, 'server/osuite_runtime_mcp.mjs')], { cwd: root, env,
      input: `${requests.map(JSON.stringify).join('\n')}\n`, encoding: 'utf8', timeout: 5000 });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stderr).toBe('');
    const replies = child.stdout.trim().split('\n').map(JSON.parse);
    expect(replies).toHaveLength(2);
    expect(replies[0]).toMatchObject({ id: 0, result: { protocolVersion: '2025-11-25' } });
    expect(replies[1].result.tools).toHaveLength(7);
  });
});
