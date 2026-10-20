import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStateStore } from '../../sdk/runtime/state.mjs';
import { toolInputDigest } from '../../sdk/runtime/protocol.mjs';

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
const secret = 'PRIVATE_OUTPUT_DO_NOT_RECORD';
const input = { session_id: 'sess-test', tool_use_id: 'tool-test', tool_name: 'Bash', tool_input: { command: 'printf harmless' } };
async function fixture({ state: extraState = {}, host = 'codex', respond } = {}) {
  expect(existsSync(path.resolve('sdk/runtime/outcome.mjs')), 'Node outcome recorder exists').toBe(true);
  const { recordOutcome } = await import('../../sdk/runtime/outcome.mjs');
  const root = mkdtempSync(path.join(tmpdir(), 'osuite-node-outcome-'));
  roots.push(root);
  const config = { stateDir: root, host, baseUrl: 'https://studio.example', apiKey: 'key-a', agentId: 'agent-a', runtimeId: 'codex_hooks' };
  const store = createStateStore(config);
  const state = { schema: 'osuite.node_action.v1', action_id: 'act-test', runtime_session_id: input.session_id,
    tool_name: input.tool_name, tool_use_id: input.tool_use_id, tool_input_digest: toolInputDigest(input.tool_name, input.tool_input), ...extraState };
  store.write('action:tool-test', state);
  const requests = [];
  const api = { request: async (method, endpoint, body) => {
    const request = { method, endpoint, body };
    requests.push(request);
    const override = respond?.(request);
    if (override) return override;
    return { ok: true, status: 200, body: method === 'PATCH' ? { action: { action_id: 'act-test', ...body } } : { ok: true, event: body } };
  } };
  return { config, store, state, requests, run: data => recordOutcome(config, data, { api, store, now: () => Date.parse('2026-10-20T00:00:00Z') }) };
}

describe('Node post-tool evidence', () => {
  it.each([
    [{ exit_code: 0, stdout: `Error: ${secret}` }, 'completed'],
    [{ exit_code: 7, stdout: secret }, 'failed'],
    [{ isError: true, content: [{ type: 'text', text: secret }] }, 'failed'],
    [{ structuredContent: { exit_code: 0, output: secret } }, 'completed'],
    [{ exit_code: 0, error: secret }, 'failed'],
    [{ exit_code: 0, interrupted: true }, 'failed'],
  ])('uses structured terminal metadata only: %j', async (response, status) => {
    const f = await fixture();
    expect(await f.run({ ...input, tool_response: response })).toMatchObject({ recorded: true });
    expect(f.requests.map(x => x.method)).toEqual(['PATCH', 'POST']);
    expect(f.requests[0].body).toMatchObject({ status, timestamp_end: '2026-10-20T00:00:00.000Z' });
    expect(f.requests[1].body).toMatchObject({ action_id: 'act-test', tool_use_id: 'tool-test', payload: { status } });
    expect(JSON.stringify(f.requests)).not.toContain(secret);
    expect(f.store.read('action:tool-test')).toBeNull();
  });

  it.each([undefined, null, {}, [], 'Process exited with code 0', '{"exit_code":0}',
    { stdout: secret }, { exit_code: null, session_id: 123 }, { exit_code: false }, { exit_code: '0' }])
  ('does not invent completion for unsupported Codex output %j', async response => {
    const f = await fixture();
    expect(await f.run({ ...input, hook_event_name: 'PostToolUse', tool_response: response })).toMatchObject({ recorded: false, reason: 'terminal_evidence_missing' });
    expect(f.requests).toHaveLength(0);
    expect(f.store.read('action:tool-test')).toEqual(f.state);
  });

  it('understands the documented Claude successful Bash and failure events without parsing output', async () => {
    const success = await fixture({ host: 'claude' });
    expect(await success.run({ ...input, hook_event_name: 'PostToolUse', tool_response: { stdout: secret, stderr: '', interrupted: false, isImage: false } }))
      .toMatchObject({ recorded: true });
    expect(success.requests[0].body.status).toBe('completed');
    const failure = await fixture({ host: 'claude' });
    expect(await failure.run({ ...input, hook_event_name: 'PostToolUseFailure', error: secret }))
      .toMatchObject({ recorded: true });
    expect(failure.requests[0].body.status).toBe('failed');
    expect(JSON.stringify(failure.requests)).not.toContain(secret);
  });

  it('does not mark a Claude background launch as the command completing', async () => {
    const f = await fixture({ host: 'claude' });
    expect(await f.run({ ...input, hook_event_name: 'PostToolUse', tool_response: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg-task' } }))
      .toMatchObject({ recorded: false });
    expect(f.requests).toHaveLength(0);
  });

  it('retains the same content-free outcome across PATCH failure, then sends the event only after acknowledgement', async () => {
    let unavailable = true;
    const f = await fixture({ respond: request => unavailable && request.method === 'PATCH' ? { ok: false, status: 503 } : null });
    expect(await f.run({ ...input, tool_response: { exit_code: 7, stdout: secret } })).toMatchObject({ recorded: false });
    const pending = f.store.read('action:tool-test');
    expect(pending.outcome_report.action_reported).toBe(false);
    expect(JSON.stringify(pending)).not.toContain(secret);
    unavailable = false;
    expect(await f.run(input)).toMatchObject({ recorded: true });
    expect(f.requests.map(x => x.method)).toEqual(['PATCH', 'PATCH', 'POST']);
    expect(f.requests[1].body).toEqual(f.requests[0].body);
  });

  it('retains the pending event stage and does not repeat acknowledged PATCH', async () => {
    let unavailable = true;
    const f = await fixture({ respond: request => unavailable && request.method === 'POST' ? { ok: false, status: 503 } : null });
    expect(await f.run({ ...input, tool_response: { exit_code: 0 } })).toMatchObject({ recorded: false });
    expect(f.store.read('action:tool-test').outcome_report.action_reported).toBe(true);
    unavailable = false;
    expect(await f.run(input)).toMatchObject({ recorded: true });
    expect(f.requests.map(x => x.method)).toEqual(['PATCH', 'POST', 'POST']);
    expect(f.requests[1].body).toEqual(f.requests[2].body);
  });

  it.each([
    { ok: true, status: 202, body: {} }, { ok: true, status: 200, body: { ok: true } },
    { ok: true, status: 200, body: { action: { action_id: 'other', status: 'completed' } } },
  ])('does not accept a misleading PATCH acknowledgement %j', async response => {
    const f = await fixture({ respond: () => response });
    expect(await f.run({ ...input, tool_response: { exit_code: 0 } })).toMatchObject({ recorded: false });
    expect(f.requests).toHaveLength(1);
    expect(f.store.read('action:tool-test').outcome_report.action_reported).toBe(false);
  });

  it('does not accept a generic event HTTP 200 as a receipt', async () => {
    const f = await fixture({ respond: request => request.method === 'POST' ? { ok: true, status: 200, body: { ok: true } } : null });
    expect(await f.run({ ...input, tool_response: { exit_code: 0 } })).toMatchObject({ recorded: false });
    expect(f.store.read('action:tool-test').outcome_report.action_reported).toBe(true);
  });

  it('does not use state from another tool input or session', async () => {
    const f = await fixture();
    for (const changed of [{ ...input, session_id: 'other' }, { ...input, tool_input: { command: 'different' } }]) {
      expect(await f.run({ ...changed, tool_response: { exit_code: 0 } })).toMatchObject({ recorded: false, reason: 'state_binding_mismatch' });
    }
    expect(f.requests).toHaveLength(0);
    expect(f.store.read('action:tool-test')).toEqual(f.state);
  });

  it('does not replay an unversioned cached success inferred by older hooks', async () => {
    const f = await fixture({ state: { outcome_report: { outcome: { status: 'completed', timestamp_end: 'old', output_summary: 'old' }, action_reported: true } } });
    expect(await f.run(input)).toMatchObject({ recorded: false, reason: 'untrusted_outcome_state' });
    expect(f.requests).toHaveLength(0);
    expect(f.store.read('action:tool-test')).toEqual(f.state);
  });

  it('closes an inert doctor probe as cancelled, never as a real successful tool execution', async () => {
    const f = await fixture({ state: { install_check: true } });
    expect(await f.run({ ...input, hook_event_name: 'PostToolUse', tool_response: { exit_code: 0 } })).toMatchObject({ recorded: true });
    expect(f.requests[0].body).toMatchObject({ status: 'cancelled', output_summary: expect.stringMatching(/diagnostic.*not executed/i) });
    expect(f.requests[1].body).toMatchObject({ event_type: 'turn_stopped', payload: { status: 'cancelled', install_check: true } });
    expect(f.requests.some(r => r.body.event_type === 'tool_completed')).toBe(false);
  });

  it('uses the same full-input fallback ID in pre and post hooks', async () => {
    const { deriveToolUseId } = await import('../../sdk/runtime/context.mjs');
    const f = await fixture();
    const data = { ...input, tool_use_id: undefined };
    const id = deriveToolUseId(data);
    f.store.write(`action:${id}`, { ...f.state, tool_use_id: id });
    expect(await f.run({ ...data, tool_response: { exit_code: 0 } })).toMatchObject({ recorded: true });
    expect(f.requests[1].body.tool_use_id).toBe(id);
  });
});
