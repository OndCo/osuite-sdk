import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256 } from '../../sdk/runtime/protocol.mjs';
import { invalidatePostureCache, resolveRemotePosture } from '../../sdk/runtime/posture.mjs';

const cfg = { host: 'codex', runtimeId: 'codex_plugin', agentId: 'agent-test', apiKey: 'test-key', baseUrl: 'https://workspace.example', mode: 'enforce', signatureMode: 'required', privateKeyBase64: 'test-injected-api', guardFailureMode: 'block', installChannel: 'plugin', settingsScope: 'managed', approvalWaitMs: 0 };
const args = { action_type: 'other', declared_goal: 'Harmless fixture', tool_name: 'Bash', tool_input: { command: 'echo harmless' }, tool_use_id: 'tool-test' };
async function server({ guard = 'allow', createdStatus = 'running', remote = true, getStatus = 'running', patchAck = true, eventAck = true, mode = 'enforce', guardFailureMode = 'block', failGuard = false, state = new Map(), onRequest, onWrite } = {}) {
  expect(existsSync(path.resolve('sdk/runtime/mcp.mjs')), 'Node MCP bridge exists').toBe(true);
  const { createMcpServer } = await import('../../sdk/runtime/mcp.mjs');
  const requests = [];
  let createdContext;
  const api = { request: async (method, endpoint, body) => {
    requests.push({ method, endpoint, body });
    const override = await onRequest?.({ method, endpoint, body, store, api });
    if (override) return override;
    if (endpoint.includes('/posture?')) {
      const now = Date.now();
      return remote ? { ok: true, status: 200, body: {
        schema_version: 'osuite.runtime_posture.v1', org_id: 'org-test', credential_id: 'key-test', credential_fingerprint: sha256(cfg.apiKey),
        runtime_id: cfg.runtimeId, targeting: { agent_id: cfg.agentId, provider: null }, revision: sha256('revision'),
        issued_at: new Date(now).toISOString(), valid_until: new Date(now + 300000).toISOString(),
        posture: { runtime_id: cfg.runtimeId, mode, on_guard_unavailable: guardFailureMode, require_signature: true, require_assumption_capture: false, approval_timeout_seconds: 600 },
      } } : { ok: false, status: 0 };
    }
    if (endpoint === '/api/runtime-sessions') return { ok: true, status: 200, body: { runtime_session: { runtime_session_id: body.runtime_session_id } } };
    if (endpoint === '/api/guard') return failGuard ? { ok: false, status: 503, error: 'http_error' } : { ok: true, status: 200, body: { decision: guard } };
    if (endpoint === '/api/actions' && method === 'POST') { createdContext = body; return { ok: true, status: 200, body: {
      action_id: 'act-test', action: { action_id: 'act-test', status: createdStatus, tool_input_digest: body.tool_input_digest }, decision: { decision: guard },
    } }; }
    if (endpoint === '/api/actions/act-test' && method === 'GET') return { ok: true, status: 200, body: { action: {
      action_id: 'act-test', status: getStatus, tool_input_digest: createdContext.tool_input_digest, approved_by: 'human', approval_redeemed_at: null, timestamp_end: null,
    } } };
    if (method === 'PATCH') return { ok: true, status: 200, body: { action: { action_id: patchAck ? 'act-test' : 'wrong', ...body } } };
    if (endpoint.endsWith('/events')) return { ok: true, status: 200, body: { ok: eventAck, event: body } };
    if (endpoint === '/api/assumptions') return { ok: true, status: 200, body: { assumption: body } };
    return { ok: true, status: 200, body: { ok: true } };
  } };
  const store = { read: key => state.get(key) || null, write: (key, value) => { state.set(key, structuredClone(value)); onWrite?.({ key, store }); }, remove: key => state.delete(key) };
  store.update = (key, update) => { const next = update(store.read(key)); store.write(key, next); return next; };
  return { bridge: createMcpServer({ ...cfg, mode, guardFailureMode }, { api, store }), requests, state };
}

describe('Node-only bundled MCP bridge', () => {
  it('keeps existing tool names and supports current newline-delimited initialize/list/ping without network side effects', () => {
    const script = path.resolve('plugins/osuite-codex-governance/server/osuite_runtime_mcp.mjs');
    expect(existsSync(script), 'Node MCP launcher exists').toBe(true);
    const request = [
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
    ].map(JSON.stringify).join('\n') + '\n';
    const child = spawnSync(process.execPath, [script], { input: request, encoding: 'utf8', env: { PATH: path.dirname(process.execPath) }, timeout: 5000 });
    expect(child.status, child.stderr).toBe(0);
    const responses = child.stdout.trim().split('\n').map(JSON.parse);
    expect(responses).toHaveLength(3);
    expect(responses[0]).toMatchObject({ id: 0, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} } } });
    expect(responses[1].result.tools.map(t => t.name)).toEqual(['osuite_begin_session', 'osuite_preflight_action', 'osuite_record_assumption', 'osuite_wait_for_approval', 'osuite_complete_action', 'osuite_replay_link', 'osuite_end_session']);
    expect(responses[2]).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
  });
  it('retains legacy Content-Length input compatibility without logging on stdout', () => {
    const script = path.resolve('plugins/osuite-codex-governance/server/osuite_runtime_mcp.mjs');
    expect(existsSync(script)).toBe(true);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const child = spawnSync(process.execPath, [script], { input: `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, encoding: 'utf8', env: { PATH: path.dirname(process.execPath) }, timeout: 5000 });
    expect(child.status).toBe(0);
    const [header, output] = child.stdout.split('\r\n\r\n');
    expect(header).toBe(`Content-Length: ${Buffer.byteLength(output)}`);
    expect(JSON.parse(output)).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  });
  it('preflight uses verified posture and authoritative POST admission, binding the full tool input', async () => {
    const { bridge, requests } = await server();
    const result = await bridge.callTool('osuite_preflight_action', args);
    expect(result.structuredContent).toMatchObject({ authorized: true, decision: 'allow', action_id: 'act-test', effect_executed: false });
    expect(requests[0].endpoint).toContain('/posture?');
    expect(requests.find(r => r.endpoint === '/api/actions').body).toMatchObject({ agent_id: cfg.agentId, declared_goal: 'Bash: echo harmless', tool_input_digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(result.structuredContent.coverage).toContain('not an execution gateway');
  });
  it.each([
    ['allow', 'enforce', 'running', false, 'tool_allowed'],
    ['warn', 'enforce', 'running', false, 'tool_allowed'],
    ['allow', 'enforce', 'running', true, 'governance_unavailable'],
    ['block', 'observe', 'blocked', false, 'tool_blocked'],
    ['require_approval', 'observe', 'pending_approval', false, 'tool_requires_approval'],
  ].flatMap(row => [false, true].map(recover => [...row, recover])))('fences late %s/%s response after rejection (status=%s outage=%s event=%s recovery=%s)', async (guard, mode, createdStatus, failGuard, eventType, recover) => {
    let rejected = false;
    const { bridge, state } = await server({ guard, mode, createdStatus, failGuard, guardFailureMode: 'allow', onRequest: async ({ body, store, api }) => {
      if (body?.event_type !== eventType) return;
      rejected = true;
      invalidatePostureCache(cfg, store);
      if (recover) expect((await resolveRemotePosture(cfg, { api, store })).available).toBe(true);
    } });
    const reply = await bridge.callTool('osuite_preflight_action', args);
    expect(rejected).toBe(true);
    expect(reply).toMatchObject({ isError: true, structuredContent: { authorized: false, effect_executed: false } });
    expect(reply.structuredContent.error).toMatch(/do not retry automatically/i);
    expect(reply.structuredContent.decision).not.toBe('allow');
    if (recover) expect(state.get('posture').rejected).toBe(false);
    if (!failGuard && mode === 'enforce') expect(state.get('mcp:act-test').context.tool_use_id).toBe('tool-test');
  });
  it('checks the fence after session state is written', async () => {
    const { bridge } = await server({ onWrite: ({ key, store }) => { if (key.startsWith('session:')) invalidatePostureCache(cfg, store); } });
    expect(await bridge.callTool('osuite_begin_session')).toMatchObject({ isError: true, structuredContent: { authorized: false } });
  });
  it.each(['osuite_end_session', 'osuite_record_assumption'])('%s does not return success after its final event rejects access', async name => {
    const { bridge } = await server({ onRequest: ({ body }) => ['session_ended', 'assumption_recorded'].includes(body?.event_type) ? { ok: false, status: 401, error: 'http_error' } : undefined });
    await bridge.callTool('osuite_preflight_action', args);
    expect(await bridge.callTool(name, name === 'osuite_end_session' ? {} : { action_id: 'act-test', assumption: 'fixture' })).toMatchObject({ isError: true, structuredContent: { authorized: false } });
  });
  it('GET approval observation never returns execution authority, redeems, or repeats the tool', async () => {
    const { bridge, requests } = await server({ guard: 'require_approval', createdStatus: 'pending_approval' });
    await bridge.callTool('osuite_preflight_action', args);
    const waited = await bridge.callTool('osuite_wait_for_approval', { action_id: 'act-test', timeout_seconds: 0 });
    expect(waited.structuredContent).toMatchObject({ approved: false, approval_observed: true, authorized: false, effect_executed: false });
    expect(waited.structuredContent.message).toMatch(/same.*preflight|preflight.*same/i);
    expect(requests.filter(r => r.endpoint === '/api/actions' && r.method === 'POST')).toHaveLength(1);
  });
  it.each([401, 403, 409])('approval GET HTTP %s stops polling, retains the hold and fences later fallback', async status => {
    const { bridge, requests, state } = await server({ guard: 'require_approval', createdStatus: 'pending_approval', guardFailureMode: 'allow',
      onRequest: ({ method, endpoint }) => method === 'GET' && endpoint.startsWith('/api/actions/') ? { ok: false, status, error: 'http_error' } : undefined });
    await bridge.callTool('osuite_preflight_action', args);
    const held = structuredClone(state.get('mcp:act-test'));
    const waited = await bridge.callTool('osuite_wait_for_approval', { action_id: 'act-test', timeout_seconds: 0.01 });
    expect(waited).toMatchObject({ isError: true, structuredContent: { authorized: false } });
    expect(waited.structuredContent.error).toMatch(/do not retry automatically/i);
    expect(state.get('posture-rejection')).toBeDefined();
    expect(state.get('mcp:act-test')).toEqual(held);
    expect(requests.filter(request => request.method === 'GET' && request.endpoint.startsWith('/api/actions/'))).toHaveLength(1);
    expect(requests.filter(request => request.endpoint === '/api/actions')).toHaveLength(1);
    const next = await server({ state, remote: false, failGuard: true, guardFailureMode: 'allow', onRequest: ({ endpoint }) => endpoint.includes('/posture?') ? { ok: false, status: 503, error: 'http_error' } : undefined });
    expect((await next.bridge.callTool('osuite_preflight_action', args)).structuredContent.authorized).toBe(false);
    expect(next.requests.some(request => request.endpoint === '/api/guard')).toBe(false);
  });
  it('suppresses stale observed approval after rejection and fresh recovery', async () => {
    const { bridge, state } = await server({ guard: 'require_approval', createdStatus: 'pending_approval', onRequest: async ({ method, endpoint, store, api }) => {
      if (method !== 'GET' || !endpoint.startsWith('/api/actions/')) return;
      invalidatePostureCache(cfg, store);
      await resolveRemotePosture(cfg, { api, store });
    } });
    await bridge.callTool('osuite_preflight_action', args);
    const waited = await bridge.callTool('osuite_wait_for_approval', { action_id: 'act-test', timeout_seconds: 0 });
    expect(waited).toMatchObject({ isError: true, structuredContent: { authorized: false } });
    expect(waited.structuredContent.approval_observed).not.toBe(true);
    expect(state.get('mcp:act-test').authorized).toBe(false);
  });
  it('a changed tool input must undergo a fresh guard and POST, never reuse an in-memory grant', async () => {
    const { bridge, requests } = await server();
    await bridge.callTool('osuite_preflight_action', args);
    await bridge.callTool('osuite_preflight_action', { ...args, tool_input: { command: 'echo changed' } });
    const posts = requests.filter(r => r.endpoint === '/api/actions');
    expect(posts).toHaveLength(2);
    expect(posts[0].body.tool_input_digest).not.toBe(posts[1].body.tool_input_digest);
  });
  it('blocks unavailable posture or malformed admission, without reporting that the caller executed', async () => {
    for (const opts of [{ remote: false }, { createdStatus: 'completed' }]) {
      const { bridge } = await server(opts);
      const result = await bridge.callTool('osuite_preflight_action', args);
      expect(result.structuredContent).toMatchObject({ authorized: false, effect_executed: false });
    }
  });
  it('requires explicit caller-reported completion and does not complete an unadmitted action', async () => {
    const { bridge, requests } = await server();
    expect((await bridge.callTool('osuite_complete_action', { action_id: 'act-test', status: 'completed' })).isError).toBe(true);
    await bridge.callTool('osuite_preflight_action', args);
    expect((await bridge.callTool('osuite_complete_action', { action_id: 'act-test' })).isError).toBe(true);
    const result = await bridge.callTool('osuite_complete_action', { action_id: 'act-test', status: 'completed', output_summary: 'secret-output-do-not-log' });
    expect(result.structuredContent).toMatchObject({ recorded: true, status: 'completed', outcome_source: 'mcp_caller_report', effect_executed: false });
    const completion = requests.find(r => r.body?.event_type === 'tool_completed');
    expect(completion.body.payload.outcome_source).toBe('mcp_caller_report');
    expect(completion.body.payload).not.toHaveProperty('output_summary');
  });
  it.each([{ patchAck: false }, { eventAck: false }])('retains pending completion after a missing or mismatched acknowledgement %j', async opts => {
    const { bridge, state } = await server(opts);
    await bridge.callTool('osuite_preflight_action', args);
    const result = await bridge.callTool('osuite_complete_action', { action_id: 'act-test', status: 'failed' });
    expect(result.structuredContent.recorded).toBe(false);
    expect(state.get('mcp:act-test').outcome_report).toMatchObject({ outcome: { status: 'failed' } });
  });
  it.each([401, 403, 409].flatMap(status => ['PATCH', 'event'].map(stage => [status, stage])))('outcome HTTP %s at %s retains report and invalidates same-credential posture', async (status, stage) => {
    const { bridge, requests, state } = await server({ onRequest: ({ method, body }) =>
      ((stage === 'PATCH' && method === 'PATCH') || (stage === 'event' && body?.event_type === 'tool_completed')) ? { ok: false, status, error: 'http_error' } : undefined });
    await bridge.callTool('osuite_preflight_action', args);
    const reply = await bridge.callTool('osuite_complete_action', { action_id: 'act-test', status: 'completed' });
    expect(reply.structuredContent.recorded).toBe(false);
    expect(state.get('posture-rejection')).toBeDefined();
    expect(state.get('mcp:act-test').outcome_report).toMatchObject({ outcome: { status: 'completed' }, action_reported: stage === 'event' });
    expect(requests.filter(request => request.method === 'PATCH')).toHaveLength(1);
  });
  it('retains completion evidence if rejection and recovery overtake the final acknowledgement', async () => {
    const { bridge, state } = await server({ onRequest: async ({ body, store, api }) => {
      if (body?.event_type !== 'tool_completed') return;
      invalidatePostureCache(cfg, store);
      await resolveRemotePosture(cfg, { api, store });
    } });
    await bridge.callTool('osuite_preflight_action', args);
    const reply = await bridge.callTool('osuite_complete_action', { action_id: 'act-test', status: 'completed' });
    expect(reply.isError).toBe(true);
    expect(reply.structuredContent.recorded).not.toBe(true);
    expect(state.get('mcp:act-test').outcome_report).toMatchObject({ outcome: { status: 'completed' }, action_reported: true });
  });
  it('rejects path traversal and unknown tools without reflecting sensitive arguments', async () => {
    const { bridge, requests } = await server();
    const result = await bridge.callTool('osuite_record_assumption', { action_id: '../../admin', assumption: 'SENSITIVE' });
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('SENSITIVE');
    expect((await bridge.callTool('invented', {})).isError).toBe(true);
  });
});
