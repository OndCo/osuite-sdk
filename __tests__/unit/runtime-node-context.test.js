import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
const config = { agentId: 'agent-test', runtimeId: 'claude_code_hooks', host: 'claude', mode: 'enforce', installChannel: 'project_settings', settingsScope: 'project' };
async function modules() {
  expect(existsSync(path.resolve('sdk/runtime/context.mjs')), 'Node tool mapping exists').toBe(true);
  return import('../../sdk/runtime/context.mjs');
}

describe('Node runtime context contracts', () => {
  it('loads only the install dotenv and honors environment precedence without mutating process state', async () => {
    expect(existsSync(path.resolve('sdk/runtime/config.mjs')), 'Node config exists').toBe(true);
    const { loadRuntimeConfig } = await import('../../sdk/runtime/config.mjs');
    const root = mkdtempSync(path.join(tmpdir(), 'osuite-node-config-'));
    roots.push(root);
    writeFileSync(path.join(root, '.env'), 'OSUITE_BASE_URL=https://tenant.example\nOSUITE_AGENT_ID=agent-file\nOSUITE_HOOK_MODE=strict\nOSUITE_API_KEY=fixture-key\n', { mode: 0o600 });
    const env = { OSUITE_AGENT_ID: 'agent-shell' };
    expect(loadRuntimeConfig({ installDir: root, env, host: 'claude' })).toMatchObject({
      baseUrl: 'https://tenant.example', agentId: 'agent-shell', apiKey: 'fixture-key', mode: 'strict', guardFailureMode: 'block',
    });
    expect(env).toEqual({ OSUITE_AGENT_ID: 'agent-shell' });
  });

  it('preserves plugin secure defaults and legacy managed dotenv precedence without changing process env', async () => {
    const { loadRuntimeConfig } = await import('../../sdk/runtime/config.mjs');
    const root = mkdtempSync(path.join(tmpdir(), 'osuite-plugin-config-'));
    roots.push(root);
    writeFileSync(path.join(root, '.env'), 'OSUITE_API_KEY=old-env\nOSUITE_AGENT_ID=old-agent\n', { mode: 0o600 });
    writeFileSync(path.join(root, '.env.osuite'), 'OSUITE_API_KEY=managed-env\nOSUITE_AGENT_ID=managed-agent\n', { mode: 0o600 });
    expect(loadRuntimeConfig({ installDir: root, runtimeId: 'codex_plugin', host: 'codex', env: {} })).toMatchObject({
      apiKey: 'managed-env', agentId: 'managed-agent', signatureMode: 'required', guardFailureMode: 'block',
      installChannel: 'plugin', settingsScope: 'managed', trustedProjectRequired: true,
    });
    expect(loadRuntimeConfig({ installDir: root, runtimeId: 'codex_plugin', host: 'codex', env: { OSUITE_API_KEY: 'shell-env', OSUITE_HOOK_MODE: 'observe' } }))
      .toMatchObject({ apiKey: 'shell-env', mode: 'observe' });
    expect(loadRuntimeConfig({ installDir: root, runtimeId: 'codex_hooks', host: 'codex', env: {} })).toMatchObject({ apiKey: 'old-env' });
  });

  it('binds complete tool inputs independently of display text, including Unicode, arrays and key order', async () => {
    const { buildActionContext, deriveToolUseId } = await modules();
    const data = { session_id: 'session', tool_name: 'Read', tool_input: { path: 'src/a', offset: 1, limit: 20 } };
    const first = buildActionContext(data, config);
    expect(first).toMatchObject({ agent_id: 'agent-test', runtime_session_id: 'session', runtime_family: 'tool_hook_runtime' });
    expect(first.adapter_mode).toBe('hook');
    expect(first.tool_input_digest).toMatch(/^[a-f0-9]{64}$/);
    const reordered = { ...data, tool_input: { limit: 20, offset: 1, path: 'src/a' } };
    expect(buildActionContext(reordered, config).tool_input_digest).toBe(first.tool_input_digest);
    expect(deriveToolUseId(reordered)).toBe(deriveToolUseId(data));
    expect(deriveToolUseId({ ...data, tool_input: { ...data.tool_input, offset: 2 } })).not.toBe(deriveToolUseId(data));
    expect(buildActionContext({ ...data, tool_input: ['\u4e2d\u6587', 1] }, config).tool_input_digest).not.toBe(first.tool_input_digest);
    expect(deriveToolUseId({ ...data, id: 42 })).toBe('42');
  });

  it('rejects IDs and summaries exceeding the existing server schema', async () => {
    const { buildActionContext } = await modules();
    expect(() => buildActionContext({ tool_name: 'Read', tool_use_id: 'x'.repeat(129) }, config)).toThrow(/schema/i);
    expect(() => buildActionContext({ tool_name: 'Read', session_id: 'x'.repeat(129) }, config)).toThrow(/schema|evidence/i);
    expect(() => buildActionContext({ tool_name: 'Read', tool_input: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`key${i}`, 'x'.repeat(400)])) }, config)).toThrow(/schema/i);
  });

  it('retains full Bash goals for server classification and rejects schema overflow instead of truncating', async () => {
    const { buildActionContext } = await modules();
    const command = `printf harmless ${'x'.repeat(200)} && git push origin main`;
    const result = buildActionContext({ session_id: 'session', tool_name: 'Bash', tool_input: { command } }, config);
    expect(result.declared_goal).toBe(`Bash: ${command}`);
    expect(result.reversible).toBe(false);
    expect(() => buildActionContext({ tool_name: 'Bash', tool_input: { command: 'x'.repeat(2000) } }, config)).toThrow(/evidence|schema/i);
  });

  it.each([
    ['git push origin main', 'deploy', 80, false],
    ['git -c push.default=simple push origin main', 'deploy', 80, false],
    ['/usr/bin/git push origin main', 'deploy', 80, false],
    ['env GIT_SSH_COMMAND=ssh git push origin main', 'deploy', 80, false],
    ['command git push origin main', 'deploy', 80, false],
    ['bash -c "git push origin main"', 'deploy', 80, false],
    ['git push origin feature/demo', 'deploy', 62, false],
    ['git push --force origin main', 'deploy', 92, false],
    ['git status --short', 'monitor', 10, true],
    ['rg "git push" plugins runtime-adapters', 'other', 20, true],
    ['npm run build', 'build', 30, true],
    ['kubectl get pods', 'monitor', 28, true],
    ['kubectl apply -f prod.yaml', 'deploy', 85, false],
    ['terraform plan', 'review', 38, true],
    ['terraform apply -auto-approve', 'deploy', 90, false],
    ['az keyvault secret show --name prod-api-key', 'security', 74, true],
  ])('preserves reference classification for %s', async (command, actionType, risk, reversible) => {
    const { buildActionContext } = await modules();
    expect(buildActionContext({ tool_name: 'Bash', tool_input: { command } }, config)).toMatchObject({
      action_type: actionType, risk_score: risk, reversible,
    });
  });

  it.each(['echo $(git push origin main)', 'rg --pre script pattern .', "sed -n '1e' file", 'unknown-command', 'git status > file'])
  ('does not call unparsed shell syntax a complete observation: %s', async command => {
    const { buildActionContext } = await modules();
    const result = buildActionContext({ tool_name: 'Bash', tool_input: { command } }, config);
    expect(JSON.parse(result.input_summary).classification_status).toBe('incomplete');
  });

  it('retains sensitive-file and external-share context without shipping edit contents by default', async () => {
    const { buildActionContext, summarizeToolInput } = await modules();
    const edit = { file_path: '/project/.env', content: 'PRIVATE CONTENT' };
    expect(buildActionContext({ tool_name: 'Write', tool_input: edit }, config)).toMatchObject({ action_type: 'security', risk_score: 85 });
    expect(summarizeToolInput(edit)).toEqual({ file_path: '/project/.env', content: { length: 15, sha256: expect.any(String) } });
    expect(JSON.stringify(summarizeToolInput(edit))).not.toContain('PRIVATE CONTENT');
    const shared = buildActionContext({ tool_name: 'mcp__slack__send', tool_input: { url: 'https://file.io/example', description: 'customer export' } }, config);
    expect(JSON.parse(shared.input_summary)).toMatchObject({ destination_type: 'public_file_host', destination_visibility: 'external_public', sensitive_categories: ['customer_data'] });
    expect(shared).toMatchObject({ privacy_review_required: true, data_minimization_declared: false });
  });

  it('honors the explicit legacy full-input capture option without making it the default', async () => {
    const { buildActionContext } = await modules();
    const data = { tool_name: 'Write', tool_input: { file_path: 'fixture.txt', content: 'explicitly captured fixture text' } };
    const full = buildActionContext(data, { ...config, captureToolInput: 'full' });
    const summary = buildActionContext(data, config);
    expect(JSON.parse(full.input_summary).tool_input_summary).toEqual(data.tool_input);
    expect(summary.input_summary).not.toContain(data.tool_input.content);
    expect(full.tool_input_digest).toBe(summary.tool_input_digest);
  });

  it.each([['default', 'manual'], ['acceptEdits', 'accept_edits'], ['bypassPermissions', 'bypass'], ['auto', 'auto']])
  ('records native permission mode %s as observation, never authority', async (native, normalized) => {
    const { buildActionContext } = await modules();
    const context = buildActionContext({ tool_name: 'Read', tool_input: {}, permission_mode: native }, config);
    expect(context.runtime_permission_mode).toBe(normalized);
    expect(context).not.toHaveProperty('approved');
  });
});
