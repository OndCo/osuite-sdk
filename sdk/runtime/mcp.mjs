import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApiClient, isObject, safeId, sha256 } from './protocol.mjs';
import { loadRuntimeConfig } from './config.mjs';
import { createStateStore } from './state.mjs';
import { rejectionFenceUnchanged, resolveRemotePosture } from './posture.mjs';
import { applyPosture, emitRuntimeEvent, openSession, trackPostureRejections } from './hook.mjs';
import { buildActionContext } from './context.mjs';
import { admitAction, cavaFingerprint, matchesAction } from './admission.mjs';
import { validateGitPublication } from './git.mjs';

const COVERAGE = 'Advisory MCP governance bridge, not an execution gateway. Direct resource access and alternative tools are outside coverage.';
const string = { type: 'string' };
const tool = (name, description, properties, required = []) => ({ name, description, inputSchema: { type: 'object', properties, required } });
export const MCP_TOOLS = [
  tool('osuite_begin_session', 'Open an OSuite governance session; does not execute tools.', { client_name: string, client_version: string, session_label: string }),
  tool('osuite_preflight_action', 'Check current policy and request one-use admission for exactly this tool input. Does not execute it.', {
    action_type: string, declared_goal: string, risk_score: { type: 'number' }, tool_name: string, tool_use_id: string,
    tool_input: {}, systems_touched: { type: 'array', items: string }, reversible: { type: 'boolean' }, metadata: { type: 'object' },
  }, ['action_type', 'declared_goal', 'tool_name', 'tool_input']),
  tool('osuite_record_assumption', 'Record an assumption for an action opened through this bridge.', { action_id: string, assumption: string, basis: string }, ['action_id', 'assumption']),
  tool('osuite_wait_for_approval', 'Observe review status. A GET is not execution authority; resubmit the exact input through preflight.', { action_id: string, timeout_seconds: { type: 'number' } }, ['action_id']),
  tool('osuite_complete_action', 'Record an explicit caller-reported outcome. This is not independent host proof of completion.', {
    action_id: string, status: { enum: ['completed', 'failed', 'cancelled'] }, output_summary: string,
    side_effects: { type: 'array', items: {} }, artifacts_created: { type: 'array', items: {} },
  }, ['action_id', 'status']),
  tool('osuite_replay_link', 'Return the Studio replay URL for this action.', { action_id: string }, ['action_id']),
  tool('osuite_end_session', 'Mark the bridge conversation as ended; never infer tool outcomes.', { reason: string }),
];

function result(data, error = false) {
  const payload = { effect_executed: false, ...data };
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, ...(error ? { isError: true } : {}) };
}
const failure = message => result({ authorized: false, error: message }, true);

export function createMcpServer(localConfig, dependencies = {}) {
  let store = dependencies.store;
  let sessionId = `sess_${randomUUID()}`;
  const ensureStore = () => (store ||= createStateStore(localConfig));
  const baseApi = () => dependencies.api || createApiClient(localConfig);
  const fenceUnchanged = active => rejectionFenceUnchanged(localConfig, ensureStore(), active.fence) === true;
  const accessChanged = () => failure('Runtime access changed during this request. No execution is authorized. Do not retry automatically; reconcile in Studio.');
  const checkedResult = (active, data, error = false) => fenceUnchanged(active) ? result(data, error) : accessChanged();

  async function current() {
    const remote = await resolveRemotePosture(localConfig, { api: baseApi(), store: ensureStore(), now: Date.now() });
    const fence = remote.rejectionFence;
    if (!remote.available || remote.blocked) return null;
    const config = applyPosture(localConfig, remote.posture);
    if (config.signatureMode === 'required' && !config.privateKeyBase64) return null;
    return { config, fence, api: trackPostureRejections(dependencies.api || createApiClient(config), localConfig, store) };
  }

  async function complete(args, state, { api, config }) {
    if (state.authorized !== true || !['completed', 'failed', 'cancelled'].includes(args.status)) return failure('An admitted action and an explicit terminal status are required.');
    if (state.outcome_report && state.outcome_report.outcome.status !== args.status) return failure('A different outcome is already pending acknowledgement; reconcile rather than replace it.');
    const key = `mcp:${args.action_id}`;
    const report = state.outcome_report || {
      outcome: { status: args.status, timestamp_end: new Date().toISOString(),
        output_summary: `MCP caller reported ${args.status}; not independently verified by a host completion event.` },
      action_reported: false,
    };
    state.outcome_report = report;
    store.write(key, state);
    if (!report.action_reported) {
      const response = await api.request('PATCH', `/api/actions/${encodeURIComponent(args.action_id)}`, report.outcome);
      const action = response.body?.action;
      if (!response.ok || response.status !== 200 || action?.action_id !== args.action_id || action?.status !== report.outcome.status || action?.timestamp_end !== report.outcome.timestamp_end) {
        return result({ recorded: false, action_id: args.action_id, message: 'Outcome acknowledgement is pending. Do not repeat the side effect.' }, true);
      }
      report.action_reported = true; store.write(key, state);
    }
    const event = {
      event_id: `evt_mcp_outcome_${sha256(`${args.action_id}|${report.outcome.timestamp_end}`).slice(0, 24)}`,
      runtime_session_id: state.context.runtime_session_id, event_type: args.status === 'completed' ? 'tool_completed' : 'tool_failed',
      action_id: args.action_id, tool_name: state.tool_name, tool_use_id: state.context.tool_use_id,
      payload: { status: args.status, outcome_source: 'mcp_caller_report', hook_mode: state.mode },
    };
    const response = await api.request('POST', `/api/runtime-sessions/${encodeURIComponent(event.runtime_session_id)}/events`, event);
    if (!response.ok || response.status !== 200 || response.body?.ok !== true || !isObject(response.body.event)
        || ['runtime_session_id', 'action_id', 'tool_use_id', 'event_type'].some(field => response.body.event[field] !== event[field])
        || response.body.event.payload?.status !== args.status || response.body.event.payload?.outcome_source !== 'mcp_caller_report') {
      return result({ recorded: false, action_id: args.action_id, message: 'Outcome event acknowledgement is pending. Do not repeat the side effect.' }, true);
    }
    return result({ recorded: true, action_id: args.action_id, status: args.status, outcome_source: 'mcp_caller_report' });
  }

  async function callTool(name, args = {}) {
    try {
      if (!MCP_TOOLS.some(item => item.name === name) || !isObject(args)) return failure('Unknown tool or invalid arguments.');
      if (['osuite_record_assumption', 'osuite_wait_for_approval', 'osuite_complete_action', 'osuite_replay_link'].includes(name) && !safeId(args.action_id)) return failure('A valid action_id is required.');
      if (name === 'osuite_replay_link') return result({ action_id: args.action_id, replay_href: `${localConfig.baseUrl}/replay/${encodeURIComponent(args.action_id)}` });
      const state = args.action_id ? ensureStore().read(`mcp:${args.action_id}`) : null;
      if (args.action_id && (!isObject(state) || state.schema !== 'osuite.mcp_action.v1')) return failure('This action has no admitted or held context in this bridge. Reconcile its record in Studio.');
      const active = await current();
      if (!active) return failure('Verified runtime posture or required signing is unavailable; no execution is authorized.');
      const { api, config } = active;
      if (!fenceUnchanged(active)) return accessChanged();
      if (name === 'osuite_complete_action') {
        const completed = await complete(args, state, active);
        if (completed.structuredContent.recorded !== true) return completed;
        if (!fenceUnchanged(active)) return accessChanged();
        const key = `mcp:${args.action_id}`;
        store.remove(key);
        if (!fenceUnchanged(active)) { store.write(key, state); return accessChanged(); }
        return completed;
      }
      if (name === 'osuite_record_assumption') {
        if (typeof args.assumption !== 'string' || !args.assumption.trim() || args.assumption.length > 4000) return failure('A bounded assumption is required.');
        const response = await api.request('POST', '/api/assumptions', { action_id: args.action_id, assumption: args.assumption,
          basis: typeof args.basis === 'string' ? args.basis.slice(0, 1000) : 'MCP caller statement', validated: false });
        if (!response.ok || !isObject(response.body?.assumption)) return failure('Assumption acknowledgement is pending.');
        await emitRuntimeEvent(api, config, state.context, 'assumption_recorded', args.action_id, { source: 'mcp_caller_report' });
        return checkedResult(active, { action_id: args.action_id, recorded: true, validated: false });
      }
      if (name === 'osuite_wait_for_approval') {
        const requested = Number(args.timeout_seconds ?? 30);
        const deadline = performance.now() + (Number.isFinite(requested) ? Math.max(0, Math.min(40, requested)) * 1000 : 0);
        do {
          if (!fenceUnchanged(active)) return accessChanged();
          const response = await api.request('GET', `/api/actions/${encodeURIComponent(args.action_id)}`, undefined, { timeoutMs: 2000 });
          if ([401, 403, 409].includes(response.status)) return failure('Approval access was rejected. Do not retry automatically; reconcile in Studio.');
          if (!fenceUnchanged(active)) return accessChanged();
          if (response.ok) {
            const action = response.body?.action || response.body;
            if (!matchesAction(response.body, state.context, { actionId: args.action_id, fingerprint: state.fingerprint })) return failure('Approval evidence no longer matches the held tool input.');
            if (action.status === 'running') {
              const observed = Boolean(action.approved_by || action.approved_at) && action.approval_redeemed_at == null && action.timestamp_end == null;
              return checkedResult(active, { action_id: args.action_id, approved: false, approval_observed: observed, authorized: false, status: 'running',
                message: observed ? 'Submit exactly the same tool input through osuite_preflight_action again. A GET does not redeem a grant or authorize execution.'
                  : 'The outcome may be unknown or already consumed. Do not retry automatically; reconcile in Studio.' });
            }
            if (action.status !== 'pending_approval') return checkedResult(active, { action_id: args.action_id, approved: false, authorized: false, status: action.status, message: 'The held request is closed. Do not retry automatically.' });
          }
          if (performance.now() >= deadline) break;
          await delay(Math.min(3000, deadline - performance.now()));
        } while (performance.now() < deadline);
        return checkedResult(active, { action_id: args.action_id, approved: false, authorized: false, status: 'timeout', message: 'Still held; do not execute this call.' });
      }
      await openSession(api, config, { session_id: sessionId }, store);
      if (!fenceUnchanged(active)) return accessChanged();
      if (name === 'osuite_begin_session') return checkedResult(active, { runtime_session_id: sessionId, runtime_adapter_id: config.runtimeId, mode: config.mode, guard_failure_mode: config.guardFailureMode, coverage: COVERAGE });
      if (name === 'osuite_end_session') {
        await emitRuntimeEvent(api, config, { runtime_session_id: sessionId }, 'session_ended', null, { source: 'mcp_caller_report' });
        if (!fenceUnchanged(active)) return accessChanged();
        const ended = sessionId; sessionId = `sess_${randomUUID()}`;
        return checkedResult(active, { ended_runtime_session_id: ended });
      }
      if (typeof args.action_type !== 'string' || !args.action_type || args.action_type.length > 128 || typeof args.declared_goal !== 'string' || !args.declared_goal || args.declared_goal.length > 2000 || !Object.hasOwn(args, 'tool_input')) return failure('A bounded action_type, declared_goal and complete tool_input are required.');
      const data = { session_id: sessionId, tool_name: args.tool_name, tool_input: args.tool_input, tool_use_id: args.tool_use_id || `tool_${randomUUID()}` };
      const context = buildActionContext(data, config);
      if (args.tool_name !== 'Bash') context.declared_goal = args.declared_goal;
      if (Number.isSafeInteger(args.risk_score) && args.risk_score >= 0 && args.risk_score <= 100) context.risk_score = Math.max(context.risk_score, args.risk_score);
      if (args.reversible === false) context.reversible = false;
      const eventContext = { ...context, tool_name: args.tool_name };
      await emitRuntimeEvent(api, config, eventContext, 'tool_preflight', null, { tool_input_digest: context.tool_input_digest, source: 'mcp_bridge' });
      if (!fenceUnchanged(active)) return accessChanged();
      const admitted = await admitAction(context, { api, config: { ...config, approvalWaitMs: 0 }, beforeRelease: response => validateGitPublication(context, response) });
      if (admitted.actionId && (admitted.authorized || admitted.decision === 'require_approval')) {
        const key = `mcp:${admitted.actionId}`;
        const previous = store.read(key);
        if (previous?.outcome_report) return failure('An outcome is already pending for this action. Reconcile before any retry.');
        store.write(key, { schema: 'osuite.mcp_action.v1', authorized: admitted.authorized, context, mode: config.mode,
          tool_name: args.tool_name, fingerprint: cavaFingerprint(admitted.response) });
      }
      const eventType = admitted.degraded ? 'governance_unavailable' : admitted.authorized ? 'tool_allowed' : admitted.decision === 'require_approval' ? 'tool_requires_approval' : 'tool_blocked';
      await emitRuntimeEvent(api, config, eventContext, eventType, admitted.actionId, { decision: admitted.degraded ? 'guard_unavailable' : admitted.decision, source: 'mcp_bridge' });
      return checkedResult(active, { decision: admitted.decision, authorized: admitted.authorized === true && config.mode !== 'observe',
        action_id: admitted.actionId || null, runtime_session_id: sessionId, coverage: COVERAGE,
        ...(admitted.degraded ? { degraded: true } : {}),
        message: admitted.authorized ? 'Current policy admitted this exact input. This bridge did not execute it.' : 'No execution is authorized. Review the action in Studio; do not retry automatically.',
      }, !admitted.authorized && admitted.decision !== 'require_approval');
    } catch { return failure('The governance request could not be confirmed. No execution is authorized; do not retry a side effect automatically.'); }
  }

  async function handleRequest(request) {
    if (!isObject(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    if (!Object.hasOwn(request, 'id')) return null;
    const response = { jsonrpc: '2.0', id: request.id };
    if (request.method === 'initialize') return { ...response, result: {
      protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(request.params?.protocolVersion) ? request.params.protocolVersion : '2025-11-25',
      capabilities: { tools: {} }, serverInfo: { name: 'osuite_runtime_governance', version: '1.1.1-node' }, instructions: COVERAGE,
    } };
    if (request.method === 'ping') return { ...response, result: {} };
    if (request.method === 'tools/list') return { ...response, result: { tools: MCP_TOOLS } };
    if (request.method === 'tools/call') return { ...response, result: await callTool(request.params?.name, request.params?.arguments ?? {}) };
    return { ...response, error: { code: -32601, message: 'Method not found' } };
  }
  return { callTool, handleRequest };
}

export async function runMcpCli(options = {}) {
  const server = createMcpServer(loadRuntimeConfig(options));
  let buffer = Buffer.alloc(0), framing = null;
  const maximum = 1048576;
  const write = payload => {
    if (!payload) return;
    const encoded = JSON.stringify(payload);
    process.stdout.write(framing === 'legacy' ? `Content-Length: ${Buffer.byteLength(encoded)}\r\n\r\n${encoded}` : `${encoded}\n`);
  };
  try {
    for await (const chunk of process.stdin) {
      buffer = Buffer.concat([buffer, chunk]);
      // Backpressure processes one request at a time; neither framing accepts unbounded messages.
      while (buffer.length) {
        if (!framing && buffer.length >= 1) framing = buffer[0] === 67 || buffer[0] === 99 ? 'legacy' : 'ndjson';
        let body;
        if (framing === 'legacy') {
          const end = buffer.indexOf('\r\n\r\n');
          if (end < 0) { if (buffer.length > 8192) throw new Error('Oversized header'); break; }
          const match = buffer.subarray(0, end).toString('ascii').match(/^Content-Length: ([0-9]+)\r?$/im);
          const length = match ? Number(match[1]) : NaN;
          if (!Number.isSafeInteger(length) || length < 1 || length > maximum) throw new Error('Invalid frame');
          if (buffer.length < end + 4 + length) break;
          body = buffer.subarray(end + 4, end + 4 + length); buffer = buffer.subarray(end + 4 + length);
        } else {
          const end = buffer.indexOf(10);
          if (end < 0) break;
          if (end > maximum) throw new Error('Oversized message');
          body = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
          if (!body.toString('utf8').trim()) continue;
        }
        try {
          const decoded = new TextDecoder('utf-8', { fatal: true }).decode(body);
          write(await server.handleRequest(JSON.parse(decoded)));
        } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
      }
      if (buffer.length > maximum + 8192) throw new Error('Oversized message');
    }
    if (buffer.length) throw new Error('Incomplete message');
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid or oversized MCP message' } });
    process.exitCode = 1;
  }
}
