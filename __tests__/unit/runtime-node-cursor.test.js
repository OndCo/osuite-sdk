import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRuntimeConfig } from '../../sdk/runtime/config.mjs';
import { buildActionContext } from '../../sdk/runtime/context.mjs';
import { terminalOutcome } from '../../sdk/runtime/outcome.mjs';
import { sha256, toolInputDigest } from '../../sdk/runtime/protocol.mjs';

const input = {
  conversation_id: 'cursor-conversation', generation_id: 'cursor-generation',
  hook_event_name: 'preToolUse', tool_name: 'Shell', tool_use_id: 'cursor-tool',
  tool_input: { command: 'printf harmless', working_directory: '/fixture' }, cwd: '/fixture',
  user_email: 'private@example.invalid', transcript_path: '/private/transcript', cursor_version: 'fixture',
};
const config = { host: 'cursor', runtimeId: 'cursor_hooks', agentId: 'cursor-agent', apiKey: 'synthetic-cursor-key',
  baseUrl: 'https://fixture.invalid', mode: 'enforce', guardFailureMode: 'block', signatureMode: 'required',
  installChannel: 'project_settings', settingsScope: 'project', trustedProjectRequired: true, approvalWaitMs: 0 };
async function adapter() {
  expect(existsSync(path.resolve('sdk/runtime/cursor.mjs')), 'native Cursor protocol adapter exists').toBe(true);
  return import('../../sdk/runtime/cursor.mjs');
}
async function exercise({ data = input, guard = 'allow', available = true, state = new Map(), remoteMode = 'enforce' } = {}) {
  const { runCursorHook } = await adapter();
  const calls = [];
  const store = { read: key => state.get(key) ?? null, remove: key => state.delete(key),
    write: (key, value) => state.set(key, structuredClone(value)) };
  store.update = (key, transform) => { const next = transform(store.read(key)); store.write(key, next); return next; };
  const api = { request: async (method, endpoint, body) => {
    calls.push({ method, endpoint, body });
    const ok = body => ({ ok: true, status: 200, body });
    if (endpoint.includes('/posture?')) {
      if (!available) return { ok: false, status: 503 };
      const now = Date.now();
      return ok({ schema_version: 'osuite.runtime_posture.v1', org_id: 'org-fixture', runtime_id: config.runtimeId,
        credential_id: 'key-fixture', credential_fingerprint: sha256(config.apiKey), targeting: { agent_id: config.agentId, provider: null },
        revision: sha256(remoteMode), issued_at: new Date(now).toISOString(), valid_until: new Date(now + 60000).toISOString(),
        posture: { runtime_id: config.runtimeId, mode: remoteMode, on_guard_unavailable: 'block', require_signature: true,
          require_assumption_capture: false, approval_timeout_seconds: 600 } });
    }
    if (endpoint === '/api/guard') return ok({ decision: guard });
    if (endpoint === '/api/actions') return ok({ action_id: 'act-cursor', action: { action_id: 'act-cursor',
      status: guard.startsWith('require_') ? 'pending_approval' : 'running', agent_id: config.agentId,
      action_envelope: { runtime_session_id: body.runtime_session_id } }, decision: { decision: guard } });
    if (endpoint === '/api/runtime-sessions') return ok({ runtime_session: { runtime_session_id: body.runtime_session_id } });
    if (endpoint === '/api/actions/act-held') return ok({ action: { action_id: 'act-held', status: 'running', approved_by: 'reviewer' } });
    return ok({ ok: true, event: body });
  } };
  return { result: await runCursorHook(data, config, { store, api }), calls, state };
}

describe('Cursor native hook protocol', () => {
  it('uses the Cursor observe default with block and signing safeguards, not a Claude or Codex identity', () => {
    expect(loadRuntimeConfig({ host: 'cursor', env: {} })).toMatchObject({ runtimeId: 'cursor_hooks', agentId: 'cursor',
      mode: 'observe', guardFailureMode: 'block', signatureMode: 'required', trustedProjectRequired: true });
  });

  it('preserves original tool identity/input while mapping session and event names without private common fields', async () => {
    const { normalizeCursorInput } = await adapter();
    const mapped = normalizeCursorInput(input);
    expect(mapped).toEqual({ hook_event_name: 'PreToolUse', session_id: input.conversation_id, cwd: input.cwd,
      tool_name: 'Shell', tool_use_id: input.tool_use_id, tool_input: input.tool_input });
    const context = buildActionContext(mapped, config);
    expect(context.declared_goal).toBe('Shell: printf harmless');
    expect(context.tool_input_digest).toBe(toolInputDigest('Shell', input.tool_input));
    expect(context.runtime_permission_source).toBe('cursor');
    expect(JSON.stringify(context)).not.toMatch(/private@example|private\/transcript|cursor_version/);
  });

  it.each(['conversation_id', 'tool_use_id', 'tool_input', 'cwd'])('refuses missing native %s evidence before any API request', async field => {
    const data = { ...input }; delete data[field];
    const { result, calls } = await exercise({ data });
    expect(result.exitCode).toBe(2);
    expect(result.stdout.permission).toBe('deny');
    expect(calls).toHaveLength(0);
  });

  it.each([
    { session_id: 'different-session' }, { tool_use_id: '../unsafe' }, { tool_input: '{}' },
    { tool_input: { command: '' } }, { hook_event_name: 'PreToolUse' },
  ])('fails closed on mismatched or foreign-shaped native evidence %j', async extra => {
    const { result, calls } = await exercise({ data: { ...input, ...extra } });
    expect(result).toMatchObject({ exitCode: 2, stdout: { permission: 'deny' } });
    expect(calls).toHaveLength(0);
  });

  it('requires verified posture and a fresh action POST before returning Cursor allow', async () => {
    const { result, calls, state } = await exercise();
    expect(result).toEqual({ exitCode: 0, stdout: { permission: 'allow' }, stderr: '' });
    expect(calls[0].endpoint).toBe('/api/runtimes/cursor_hooks/posture?agent_id=cursor-agent');
    expect(calls.find(call => call.endpoint === '/api/actions').body.tool_input_digest).toBe(toolInputDigest('Shell', input.tool_input));
    expect(state.get('action:cursor-tool')).toMatchObject({ runtime_session_id: input.conversation_id, tool_name: 'Shell', require_signature: true });
    expect(calls.find(call => call.body?.event_type === 'tool_preflight').body.payload.hook_mode).toBe('enforce');
  });

  it.each(['block', 'require_approval', 'require_dual_approval'])('returns deny, never unsupported ask, for %s', async guard => {
    const { result, state } = await exercise({ guard });
    expect(result.exitCode).toBe(2);
    expect(Object.keys(result.stdout).sort()).toEqual(['agent_message', 'permission', 'user_message']);
    expect(result.stdout.permission).toBe('deny');
    expect(result.stdout.user_message).toContain('OSuite');
    expect(state.has('action:cursor-tool')).toBe(false);
  });

  it('does not downgrade an unavailable enforcing posture to a native allow reply', async () => {
    const { result, calls } = await exercise({ available: false });
    expect(result.stdout.permission).toBe('deny');
    expect(calls.some(call => call.endpoint === '/api/guard')).toBe(false);
  });

  it('preserves explicit verified observe intent without labelling it enforcement', async () => {
    const { result, calls } = await exercise({ guard: 'block', remoteMode: 'observe' });
    expect(result.stdout.permission).toBe('allow');
    expect(result.stdout.user_message).toMatch(/observe/i);
    expect(result.stderr).toMatch(/observe/i);
    expect(calls.find(call => call.body?.event_type === 'tool_preflight').body.payload.hook_mode).toBe('observe');
  });

  it.each([[0, 'completed'], [3, 'failed']])('uses documented top-level Shell exitCode=%i metadata, never stdout, for %s', async (exitCode, status) => {
    const { normalizeCursorInput } = await adapter();
    const mapped = normalizeCursorInput({ ...input, hook_event_name: 'postToolUse',
      tool_output: JSON.stringify({ exitCode, stdout: '{"exitCode":0,"secret":"must not forward"}' }) });
    expect(terminalOutcome(config, mapped)?.status).toBe(status);
    expect(JSON.stringify(terminalOutcome(config, mapped))).not.toContain('secret');
  });

  it.each([{ isError: true }, { is_error: true }, { error: 'private error' }, { interrupted: true }])
  ('does not discard explicit errors when Shell reports a contradictory zero exit code: %j', async error => {
    const { normalizeCursorInput } = await adapter();
    const mapped = normalizeCursorInput({ ...input, hook_event_name: 'postToolUse',
      tool_output: JSON.stringify({ exitCode: 0, ...error }) });
    expect(terminalOutcome(config, mapped)?.status).toBe('failed');
    expect(JSON.stringify(mapped)).not.toContain('private error');
  });

  it.each(['not json', '{"stdout":"{\\"exitCode\\":0}"}', '{"exitCode":"0"}', 'null', '{"backgroundTaskId":"running","exitCode":0}'])
  ('does not invent terminal evidence from opaque or nonterminal output %s', async toolOutput => {
    const { normalizeCursorInput } = await adapter();
    const mapped = normalizeCursorInput({ ...input, hook_event_name: 'postToolUse', tool_output: toolOutput,
      tool_response: { exit_code: 0 } });
    expect(terminalOutcome(config, mapped)).toBeNull();
  });

  it('records an explicit native failure without forwarding the host error message', async () => {
    const { normalizeCursorInput } = await adapter();
    const mapped = normalizeCursorInput({ ...input, hook_event_name: 'postToolUseFailure',
      failure_type: 'timeout', is_interrupt: false, error_message: 'private command details' });
    expect(terminalOutcome(config, mapped)?.status).toBe('failed');
    expect(JSON.stringify(mapped)).not.toContain('private command details');
  });

  it.each(['sessionStart', 'sessionEnd'])('refreshes posture on %s but never claims its response blocks a session', async event => {
    const { result, calls } = await exercise({ data: { conversation_id: input.conversation_id, session_id: input.conversation_id, hook_event_name: event } });
    expect(result).toEqual({ exitCode: 0, stdout: {}, stderr: '' });
    expect(calls.some(call => call.endpoint.includes('/posture?'))).toBe(true);
    expect(calls.some(call => call.endpoint === '/api/actions')).toBe(false);
  });

  it('never emits a stop followup_message that would automatically submit another turn', async () => {
    const state = new Map([['pending:cursor-conversation', [{ action_id: 'act-held', tool_input_digest: 'abc' }]]]);
    const { result, calls } = await exercise({ state, data: { conversation_id: input.conversation_id, hook_event_name: 'stop' } });
    expect(result.stdout).toEqual({});
    expect(calls.some(call => call.endpoint === '/api/actions' && call.method === 'POST')).toBe(false);
  });

  it('launches real Node and returns only native deny JSON on malformed input without exposing stdin', async () => {
    await adapter();
    const child = spawnSync(process.execPath, [path.resolve('runtime-adapters/cursor/osuite_pretool.mjs')], {
      input: '{"secret":"not-closed', env: { PATH: path.dirname(process.execPath) }, encoding: 'utf8', timeout: 5000,
    });
    expect(child.status, child.stderr).toBe(2);
    expect(JSON.parse(child.stdout).permission).toBe('deny');
    expect(child.stderr).not.toContain('not-closed');
  });
});
