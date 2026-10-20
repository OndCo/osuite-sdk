import { canonicalJson, isObject, safeId, sha256, toolInputDigest } from './protocol.mjs';
import { deriveToolUseId } from './context.mjs';

const pending = reason => ({ recorded: false, reason });

export function terminalOutcome(config, data, now = Date.now()) {
  const response = data.tool_response;
  let status;
  let summary;
  if (config.host === 'claude' && data.hook_event_name === 'PostToolUseFailure' && typeof data.error === 'string') {
    status = 'failed';
    summary = 'Runtime emitted PostToolUseFailure; details omitted.';
  } else if (isObject(response)) {
    const structured = isObject(response.structuredContent) ? response.structuredContent : response;
    const error = [response, structured].some(value => value.error || value.isError === true || value.is_error === true || value.interrupted === true);
    const exitCode = Object.hasOwn(response, 'exit_code') ? response.exit_code : structured.exit_code;
    if (error) {
      status = 'failed';
      summary = 'Runtime reported a tool error; details omitted.';
    } else if (Number.isSafeInteger(exitCode)) {
      status = exitCode === 0 ? 'completed' : 'failed';
      summary = `Runtime reported exit_code=${exitCode}; output omitted.`;
    } else if (config.host === 'claude' && data.hook_event_name === 'PostToolUse'
        && !response.backgroundTaskId && !response.background_task_id && !response.session_id
        && data.tool_input?.run_in_background !== true) {
      status = 'completed';
      summary = 'Claude Code emitted a successful PostToolUse event; output omitted.';
    }
  }
  // Codex may return stdout verbatim. Even JSON-looking strings are not metadata.
  return status ? { status, output_summary: summary, timestamp_end: new Date(now).toISOString() } : null;
}

function validReport(report, provenance) {
  const outcome = report?.outcome;
  return isObject(outcome) && (provenance.schema === 'osuite.diagnostic_terminal_report.v1' ? outcome.status === 'cancelled' : ['completed', 'failed'].includes(outcome.status))
    && Object.keys(outcome).sort().join(',') === 'output_summary,status,timestamp_end'
    && typeof outcome.output_summary === 'string' && Number.isFinite(Date.parse(outcome.timestamp_end))
    && typeof report.action_reported === 'boolean'
    && canonicalJson(report.provenance) === canonicalJson(provenance);
}

export async function recordOutcome(config, data, { api, store, now = Date.now } = {}) {
  if (!isObject(data)) return pending('invalid_hook_input');
  const toolId = deriveToolUseId(data);
  if (!safeId(toolId)) return pending('invalid_tool_id');
  const key = `action:${toolId}`;
  let state;
  try { state = store.read(key); } catch { return pending('unreadable_action_state'); }
  if (state === null) return { recorded: false, reason: null };
  if (!isObject(state) || state.schema !== 'osuite.node_action.v1' || !safeId(state.action_id)
      || (state.runtime_session_id && !safeId(state.runtime_session_id))) return pending('invalid_action_state');
  if (state.tool_use_id !== toolId || (data.session_id && data.session_id !== state.runtime_session_id)
      || (data.tool_name && data.tool_name !== state.tool_name)
      || (data.tool_input !== undefined && toolInputDigest(data.tool_name || state.tool_name, data.tool_input) !== state.tool_input_digest)) {
    return pending('state_binding_mismatch');
  }
  if (state.require_signature && !config.privateKeyBase64) return pending('signing_unavailable');
  const provenance = { schema: state.install_check ? 'osuite.diagnostic_terminal_report.v1' : 'osuite.structured_terminal_report.v1', action_id: state.action_id, tool_use_id: toolId };
  let report = state.outcome_report;
  if (report !== undefined && !validReport(report, provenance)) return pending('untrusted_outcome_state');
  if (report === undefined) {
    const outcome = state.install_check ? { status: 'cancelled', timestamp_end: new Date(now()).toISOString(),
      output_summary: 'Inert diagnostic hook probe; the tool was not executed.' } : terminalOutcome(config, data, now());
    if (!outcome) return pending('terminal_evidence_missing');
    report = { outcome, action_reported: false, provenance };
    state.outcome_report = report;
    try { store.write(key, state); } catch { return pending('state_persistence_failed'); }
  }
  const outcome = report.outcome;
  if (!report.action_reported) {
    const response = await api.request('PATCH', `/api/actions/${encodeURIComponent(state.action_id)}`, outcome, { timeoutMs: 2000 });
    const action = response.body?.action;
    if (!response.ok || response.status !== 200 || !isObject(action)
        || action.action_id !== state.action_id || action.status !== outcome.status || action.timestamp_end !== outcome.timestamp_end) {
      return pending('outcome_acknowledgement_pending');
    }
    report.action_reported = true;
    try { store.write(key, state); } catch { return pending('state_persistence_failed'); }
  }
  if (state.runtime_session_id) {
    const event = {
      event_id: `evt_outcome_${sha256(`${state.runtime_session_id}|${state.action_id}|${toolId}|${outcome.timestamp_end}`).slice(0, 24)}`,
      runtime_session_id: state.runtime_session_id,
      event_type: state.install_check ? 'turn_stopped' : outcome.status === 'completed' ? 'tool_completed' : 'tool_failed',
      tool_name: state.tool_name, tool_use_id: toolId, action_id: state.action_id,
      timestamp: outcome.timestamp_end,
      payload: { status: outcome.status, output_summary: outcome.output_summary, ...(state.install_check ? { install_check: true } : {}) },
    };
    const response = await api.request('POST', `/api/runtime-sessions/${encodeURIComponent(state.runtime_session_id)}/events`, event, { timeoutMs: 2000 });
    const acknowledged = response.body?.event;
    if (!response.ok || response.status !== 200 || response.body?.ok !== true || !isObject(acknowledged)
        || ['runtime_session_id', 'event_type', 'tool_use_id', 'action_id'].some(field => acknowledged[field] !== event[field])
        || acknowledged.payload?.status !== outcome.status) return pending('event_acknowledgement_pending');
  }
  try { store.remove(key); } catch { return pending('state_cleanup_pending'); }
  return { recorded: true };
}
