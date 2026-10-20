import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256 } from '../../sdk/runtime/protocol.mjs';
import { POSTURE_SCHEMA } from '../../sdk/runtime/posture.mjs';

const config = { host: 'claude', runtimeId: 'claude_code_hooks', agentId: 'agent-test', apiKey: 'test-only-key',
  baseUrl: 'https://workspace.example', mode: 'enforce', guardFailureMode: 'block', signatureMode: 'workspace_key_optional',
  installChannel: 'project_settings', settingsScope: 'project', approvalWaitMs: 0 };
const event = { hook_event_name: 'PreToolUse', session_id: 'sess-test', tool_use_id: 'tool-test', tool_name: 'Bash', tool_input: { command: 'echo harmless' } };
const now = Date.now();
function posture(mode = 'enforce') {
  return { schema_version: POSTURE_SCHEMA, org_id: 'org-test', runtime_id: config.runtimeId,
    credential_id: 'key-test', credential_fingerprint: sha256(config.apiKey), targeting: { agent_id: config.agentId, provider: null },
    revision: sha256(mode), issued_at: new Date(now).toISOString(), valid_until: new Date(now + 300000).toISOString(),
    posture: { runtime_id: config.runtimeId, mode, on_guard_unavailable: 'block', require_signature: false, require_assumption_capture: false, approval_timeout_seconds: 600 } };
}
async function run({ input = event, host = 'claude', remote = posture(), guard = 'allow', status = 'running', failState = false, failGuard = false, cfg = {}, state = new Map() } = {}) {
  expect(existsSync(path.resolve('sdk/runtime/hook.mjs')), 'Node hook entry exists').toBe(true);
  const { runHook } = await import('../../sdk/runtime/hook.mjs');
  const requests = [];
  const store = { read: key => state.get(key) ?? null, remove: key => state.delete(key), write: (key, value) => {
    if (failState && key.startsWith('action:')) throw new Error('disk unavailable');
    state.set(key, JSON.parse(JSON.stringify(value)));
  } };
  store.update = (key, update) => { const next = update(store.read(key)); store.write(key, next); return next; };
  const api = { request: async (method, endpoint, body) => {
    requests.push({ method, endpoint, body });
    if (endpoint.includes('/posture?')) return remote ? { ok: true, status: 200, body: remote } : { ok: false, status: 0 };
    if (endpoint === '/api/guard') return failGuard ? { ok: false, status: 0 } : { ok: true, status: 200, body: { decision: guard } };
    if (endpoint === '/api/actions' && method === 'POST') return { ok: true, status: 200, body: {
      action_id: 'act-test', action: { action_id: 'act-test', status, tool_input_digest: body.tool_input_digest },
      decision: { decision: guard }, approval: status === 'cancelled' ? { state: 'not_requested' } : { state: 'pending' },
    } };
    if (endpoint === '/api/actions/act-held' && method === 'GET') return { ok: true, status: 200, body: { action: { action_id: 'act-held', status: 'running', approved_by: 'human', timestamp_end: null, approval_redeemed_at: null } } };
    return { ok: true, status: 200, body: { ok: true } };
  } };
  const result = await runHook(input, { ...config, host, ...cfg }, { api, store, now: () => now });
  return { result, requests, state };
}

describe('Runnable Node hook orchestration', () => {
  it('fetches scoped posture before guard, persists exact input state before releasing, and emits doctor-compatible events', async () => {
    const { result, requests, state } = await run();
    expect(result.exitCode).toBe(0);
    expect(requests[0].endpoint).toContain('/api/runtimes/claude_code_hooks/posture?agent_id=agent-test');
    expect(requests.filter(r => r.endpoint === '/api/guard')).toHaveLength(1);
    expect(state.get('action:tool-test')).toMatchObject({ schema: 'osuite.node_action.v1', action_id: 'act-test', tool_use_id: 'tool-test', runtime_session_id: 'sess-test' });
    expect(state.get('action:tool-test')).not.toHaveProperty('tool_input');
    expect(requests.find(r => r.body?.event_type === 'tool_allowed')?.body).toMatchObject({ action_id: 'act-test', payload: { decision: 'allow', hook_mode: 'enforce' } });
    expect(result.stdout).not.toHaveProperty('hookSpecificOutput.permissionDecision');
  });
  it.each(['claude', 'codex'])('denies through the documented %s pre-tool protocol without unsupported continue/ask fields', async host => {
    const { result } = await run({ host, guard: 'block' });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: expect.any(String) } });
    expect(result.stderr).toContain('policy');
  });
  it.each([{}, [], null, { tool_name: 'Bash', tool_input: { command: 'x'.repeat(2000) } }])('fails closed on missing or invalid invocation evidence', async input => {
    const { result, requests } = await run({ input });
    expect(result.exitCode).toBe(2);
    expect(requests.filter(r => r.endpoint === '/api/actions')).toHaveLength(0);
  });
  it('does not release an enforce call if receipt state cannot be persisted', async () => {
    expect((await run({ failState: true })).result).toMatchObject({ exitCode: 2, stderr: expect.stringContaining('receipt') });
  });
  it('does not fall back to local observe on failed remote refresh after an enforce posture', async () => {
    const first = await run();
    const second = await run({ state: first.state, remote: null, cfg: { mode: 'observe' }, guard: 'block' });
    expect(second.result.exitCode).toBe(2);
  });
  it('blocks unverified or unavailable remote posture in enforce even with availability allow configured', async () => {
    const { result, requests } = await run({ remote: null, cfg: { guardFailureMode: 'allow' } });
    expect(result.exitCode).toBe(2);
    expect(requests.filter(r => r.endpoint === '/api/guard')).toHaveLength(0);
  });
  it('preserves explicit fresh observe intent without reporting governance authorization', async () => {
    const { result, requests, state } = await run({ remote: posture('observe'), guard: 'block' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.systemMessage).toMatch(/observe|not authorized/i);
    expect(state.has('action:tool-test')).toBe(false);
    expect(requests.find(r => r.body?.event_type === 'tool_blocked')?.body.payload.decision).toBe('observe_would_block');
  });
  it('honors explicit availability allow only after valid posture and labels the gap', async () => {
    const remote = posture(); remote.posture.on_guard_unavailable = 'allow';
    const { result, state } = await run({ remote, failGuard: true });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.systemMessage).toContain('Not governed');
    expect(state.has('action:tool-test')).toBe(false);
    expect(state.get('governance-gap')).toMatchObject({ calls: 1 });
  });
  it('preserves a held exact-action reference without caching authorization', async () => {
    const { result, state } = await run({ guard: 'require_dual_approval', status: 'pending_approval' });
    expect(result.exitCode).toBe(2);
    expect(state.get('pending:sess-test')).toEqual([expect.objectContaining({ action_id: 'act-test', tool_input_digest: expect.any(String) })]);
    expect(state.has('action:tool-test')).toBe(false);
  });
  it('reports a doctor hold without telling anyone it executed or caching an approval', async () => {
    const { result, state, requests } = await run({ guard: 'require_approval', status: 'cancelled', cfg: { installCheck: true } });
    expect(result.exitCode).toBe(2);
    expect(state.has('action:tool-test')).toBe(false);
    expect(requests.find(r => r.body?.event_type === 'install_check_policy_result')?.body.payload).toMatchObject({ approval_state: 'not_requested', install_check: true });
  });
  it('marks an allowed doctor probe as diagnostic in persisted receipt state', async () => {
    const { state } = await run({ cfg: { installCheck: true } });
    expect(state.get('action:tool-test').install_check).toBe(true);
  });
  it('refreshes configuration at SessionStart without creating an action', async () => {
    const { result, requests } = await run({ input: { session_id: 'sess-test', hook_event_name: 'SessionStart' } });
    expect(result.exitCode).toBe(0);
    expect(requests[0].endpoint).toContain('/posture?');
    expect(requests.some(r => r.endpoint === '/api/actions')).toBe(false);
  });
  it('Stop observes a grant but never redeems or repeats the side effect and avoids stop loops', async () => {
    const state = new Map([['pending:sess-test', [{ action_id: 'act-held', tool_input_digest: 'abc', agent_id: config.agentId, runtime_session_id: 'sess-test' }]]]);
    const { result, requests } = await run({ state, input: { session_id: 'sess-test', hook_event_name: 'Stop' } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatchObject({ decision: 'block', reason: expect.stringContaining('exactly the same') });
    expect(requests.some(r => r.endpoint === '/api/actions' && r.method === 'POST')).toBe(false);
    state.set('pending:sess-test', [{ action_id: 'act-held', tool_input_digest: 'abc' }]);
    expect((await run({ state, input: { session_id: 'sess-test', hook_event_name: 'Stop', stop_hook_active: true } })).result.stdout).not.toHaveProperty('decision');
  });
  it('the real Node launcher accepts BOM input and rejects malformed JSON without Python or leaking stdin', () => {
    const script = path.resolve('runtime-adapters/claude-code/osuite_pretool.mjs');
    expect(existsSync(script), 'Node-only launcher exists').toBe(true);
    const child = spawnSync(process.execPath, [script], { input: '\uFEFF{"sensitive":"bad-json"', encoding: 'utf8', env: { PATH: path.dirname(process.execPath) }, timeout: 5000 });
    expect(child.status).toBe(2);
    expect(child.stderr).not.toContain('sensitive');
    expect(JSON.parse(child.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});
