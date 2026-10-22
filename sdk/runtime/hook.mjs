import { randomUUID } from 'node:crypto';
import { createApiClient, isObject, safeId } from './protocol.mjs';
import { createStateStore } from './state.mjs';
import { loadRuntimeConfig } from './config.mjs';
import { resolveRemotePosture } from './posture.mjs';
import { buildActionContext, deriveSessionId } from './context.mjs';
import { admitAction, cavaFingerprint, matchesAction } from './admission.mjs';
import { recordOutcome } from './outcome.mjs';
import { validateGitPublication } from './git.mjs';

const note = message => ({ exitCode: 0, stdout: message ? { systemMessage: `[OSuite] ${message}` } : {}, stderr: '' });
export function deny(message) {
  const reason = `[OSuite] ${message}`;
  return { exitCode: 2, stderr: reason, stdout: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } };
}

export function applyPosture(config, posture) {
  return { ...config, mode: posture.mode, guardFailureMode: posture.mode === 'strict' ? 'block' : posture.on_guard_unavailable,
    signatureMode: posture.require_signature ? 'required' : 'workspace_key_optional',
    requireAssumptionCapture: posture.require_assumption_capture, approvalTimeoutSeconds: posture.approval_timeout_seconds };
}

export async function emitRuntimeEvent(api, config, context, eventType, actionId = null, payload = {}) {
  return api.request('POST', `/api/runtime-sessions/${encodeURIComponent(context.runtime_session_id)}/events`, {
    event_id: `evt_${randomUUID()}`, runtime_session_id: context.runtime_session_id, event_type: eventType,
    tool_name: context.tool_name || null, tool_use_id: context.tool_use_id || null, action_id: actionId,
    payload: { hook_mode: config.mode, guard_failure_mode: config.guardFailureMode, ...payload },
  }, { timeoutMs: 1500 });
}

export async function openSession(api, config, data, store, now = Date.now()) {
  const sessionId = deriveSessionId(data, config);
  const marker = `session:${sessionId}`;
  const cached = store.read(marker);
  if (cached?.mode === config.mode && cached?.signature_mode === config.signatureMode && now - cached.at >= 0 && now - cached.at < 1800000) return sessionId;
  const response = await api.request('POST', '/api/runtime-sessions', {
    runtime_session_id: sessionId, agent_id: config.agentId, runtime_adapter_id: config.runtimeId,
    runtime_family: 'tool_hook_runtime', adapter_mode: 'hook', client_name: config.host,
    governance_posture: config.mode, signature_mode: config.signatureMode,
    install_channel: config.installChannel, settings_scope: config.settingsScope,
    trusted_project_required: config.trustedProjectRequired === true, status: 'active',
    metadata: { implementation: 'node', runtime_adapter_id: config.runtimeId },
  }, { timeoutMs: 1500 });
  if (response.ok && response.body?.runtime_session?.runtime_session_id === sessionId) {
    store.write(marker, { at: now, mode: config.mode, signature_mode: config.signatureMode });
  }
  return sessionId;
}

function rememberGap(store, reason, now) {
  try {
    const previous = store.read('governance-gap');
    store.write('governance-gap', { since: previous?.since || new Date(now).toISOString(), last_seen: new Date(now).toISOString(),
      calls: Math.min(Number(previous?.calls || 0) + 1, Number.MAX_SAFE_INTEGER), reason });
  } catch { /* The user still receives the explicit ungoverned notice. */ }
}

async function flushGap(api, config, context, store) {
  const gap = store.read('governance-gap');
  if (!gap) return;
  const response = await emitRuntimeEvent(api, config, context, 'governance_unavailable', null, {
    since: gap.since, last_seen: gap.last_seen, ungoverned_tool_calls: gap.calls, reason: gap.reason,
  });
  if (response.ok && response.body?.ok === true) store.remove('governance-gap');
}

function updatePending(store, context, entry = null) {
  const key = `pending:${context.runtime_session_id}`;
  const saved = store.read(key);
  const entries = (Array.isArray(saved) ? saved : []).filter(value => value.tool_input_digest !== context.tool_input_digest);
  if (entry) entries.push(entry);
  if (entries.length) store.write(key, entries.slice(-64));
  else store.remove(key);
}

async function stopHook(data, config, api, store) {
  const session = deriveSessionId(data, config), key = `pending:${session}`;
  const saved = store.read(key);
  if (!Array.isArray(saved) || !saved.length) return note();
  const retained = [], decided = [];
  const deadline = performance.now() + 3000;
  for (const entry of saved) {
    if (!safeId(entry.action_id)) continue;
    if (performance.now() >= deadline) { retained.push(entry); continue; }
    const response = await api.request('GET', `/api/actions/${encodeURIComponent(entry.action_id)}`, undefined, { timeoutMs: Math.max(1, deadline - performance.now()) });
    if (!response.ok) { retained.push(entry); continue; }
    const action = response.body?.action || response.body;
    if (!matchesAction(response.body, entry, { actionId: entry.action_id, fingerprint: entry.fingerprint })) {
      decided.push('Held action evidence no longer matches. Do not retry automatically; reconcile in Studio.'); continue;
    }
    if (action.status === 'pending_approval') { retained.push(entry); continue; }
    if (action.status === 'running' && (action.approved_by || action.approved_at) && action.approval_redeemed_at == null && action.timestamp_end == null) {
      decided.push('A held action was approved. Submit exactly the same tool call through OSuite again; current policy and one-use POST admission must still authorize it.');
    } else if (action.status === 'running') {
      decided.push('A held action has an uncertain execution outcome. Do not retry automatically; reconcile its action/replay in Studio.');
    } else decided.push('A held action was denied, expired, or closed. Do not retry automatically; tell the user.');
  }
  if (retained.length) store.write(key, retained); else store.remove(key);
  if (decided.length && !data.stop_hook_active) return { exitCode: 0, stderr: '', stdout: { decision: 'block', reason: `[OSuite] ${decided.join(' ')}` } };
  return note(decided.join(' ') || 'An action is still held for human review. No tool was executed by this hook.');
}

export async function runHook(data, localConfig, dependencies = {}) {
  const event = data?.hook_event_name || 'PreToolUse';
  const pre = event === 'PreToolUse';
  try {
    if (!isObject(data)) return deny('Invalid hook input. No execution was authorized.');
    // Validate before networking, including exact digest and schema bounds.
    const initialContext = pre ? buildActionContext(data, localConfig) : null;
    const store = dependencies.store || createStateStore(localConfig);
    const now = dependencies.now || Date.now;
    const apiFactory = dependencies.apiFactory || createApiClient;
    let api = dependencies.api || apiFactory(localConfig);
    if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
      const result = await recordOutcome(localConfig, data, { api, store, now });
      return note(result.reason ? 'Tool outcome is not yet acknowledged. Evidence was retained; do not repeat the side effect.' : '');
    }
    const remote = await resolveRemotePosture(localConfig, { api, store, now: now() });
    const config = { ...applyPosture(localConfig, remote.posture), ruleRollout: remote.ruleRollout,
      orgId: remote.orgId || localConfig.orgId };
    api = dependencies.api || apiFactory(config);
    if (event === 'Stop') return stopHook(data, config, api, store);
    if (remote.blocked) return pre ? deny('Verified runtime posture is unavailable or expired. Execution is blocked; reconnect or restore access.')
      : note('Verified runtime posture is unavailable. Enforce hooks will block execution until it can be verified.');
    if (!pre && event !== 'SessionStart' && event !== 'SessionEnd') return note('Unsupported hook event; no execution decision was made.');
    const session = await openSession(api, config, data, store, now());
    if (!pre) {
      await emitRuntimeEvent(api, config, { runtime_session_id: session }, event === 'SessionStart' ? 'session_started' : 'session_ended');
      return note(remote.available ? '' : 'Observe mode is active without verified remote posture. This is not governance authorization.');
    }
    const context = { ...initialContext, tool_name: data.tool_name };
    if (!remote.available) {
      rememberGap(store, 'posture_unavailable', now());
      return note('Not governed: remote posture is unavailable; explicit observe mode does not enforce OSuite policy.');
    }
    await emitRuntimeEvent(api, config, context, 'tool_preflight', null, { tool_input_digest: context.tool_input_digest, install_check: config.installCheck === true });
    const result = await admitAction(context, { api, config, ...dependencies.admission, beforeRelease: response => validateGitPublication(context, response) });
    if (result.degraded) {
      rememberGap(store, result.reason, now());
      await emitRuntimeEvent(api, config, context, 'governance_unavailable', null, { decision: result.decision === 'allow' ? 'guard_unavailable' : 'guard_unavailable_blocked' });
      return result.decision === 'allow' ? note('Not governed: the guard is unavailable and this verified posture explicitly allows availability fallback. No authorization or completion is claimed.')
        : deny('Guard unavailable. Verified policy requires blocking this call.');
    }
    await flushGap(api, config, context, store);
    if (result.installCheck) {
      await emitRuntimeEvent(api, config, context, 'install_check_policy_result', null, { decision: result.decision, approval_state: 'not_requested', install_check: true });
      return deny('Install check: policy would require human approval. No request was sent to reviewers and no tool was executed.');
    }
    if (result.authorized) {
      try {
        store.write(`action:${context.tool_use_id}`, { schema: 'osuite.node_action.v1', action_id: result.actionId,
          runtime_session_id: session, tool_name: data.tool_name, tool_use_id: context.tool_use_id,
          tool_input_digest: context.tool_input_digest, require_signature: config.signatureMode === 'required', install_check: config.installCheck === true });
      } catch { return deny('Cannot persist the exact-action receipt state. The admitted tool was not released; reconcile its action in Studio before retrying.'); }
      updatePending(store, context);
      await emitRuntimeEvent(api, config, context, 'tool_allowed', result.actionId, { decision: result.decision, install_check: config.installCheck === true });
      return note(config.mode === 'observe' && !result.ruleRolloutBinding ? 'Observe mode recorded a policy result; it does not enforce OSuite policy.' : result.decision === 'warn' ? 'OSuite authorized this call with a policy warning.' : '');
    }
    if (result.decision === 'require_approval') {
      if (result.observeOnly !== true) updatePending(store, context, { action_id: result.actionId, agent_id: config.agentId,
        runtime_session_id: session, tool_input_digest: context.tool_input_digest, fingerprint: cavaFingerprint(result.response) });
      await emitRuntimeEvent(api, config, context, 'tool_requires_approval', result.actionId, { decision: result.observeOnly === true ? 'observe_would_require_approval' : result.response?.decision?.decision || 'require_approval' });
      return result.observeOnly === true ? note('Observe mode: this call would require human approval; it is not authorized by a reviewer.')
        : deny(`Human approval is still required for action ${result.actionId}. Do not run or automatically retry it. Review it in OSuite Studio.`);
    }
    await emitRuntimeEvent(api, config, context, 'tool_blocked', result.actionId, { decision: result.observeOnly === true ? 'observe_would_block' : 'block', reason: result.reason });
    return result.observeOnly === true ? note('Observe mode: OSuite policy would block this call. It is not authorized by OSuite.')
      : deny(`OSuite policy did not authorize this exact action (${result.reason}). Do not retry automatically.`);
  } catch {
    return pre ? deny('Hook evidence or state is invalid. Execution is blocked; no successful admission is claimed.')
      : note('Runtime evidence could not be recorded. No completion or authorization is claimed.');
  }
}

export async function readHookInput(input = process.stdin) {
  const chunks = []; let size = 0;
  for await (const chunk of input) {
    size += Buffer.byteLength(chunk);
    if (size > 1048576) throw new Error('Hook input exceeds limit');
    chunks.push(Buffer.from(chunk));
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).replace(/^\uFEFF/, '');
  const value = JSON.parse(text);
  if (!isObject(value)) throw new Error('Invalid hook input');
  return value;
}

export async function runHookCli({ host, installDir, event = 'PreToolUse', runtimeId } = {}) {
  let result;
  try {
    const data = await readHookInput();
    const allowedEvents = event === 'PostToolUse' ? ['PostToolUse', 'PostToolUseFailure'] : [event];
    if (data.hook_event_name && !allowedEvents.includes(data.hook_event_name)) throw new Error('Unexpected hook event');
    data.hook_event_name ||= event;
    result = await runHook(data, loadRuntimeConfig({ host, installDir, runtimeId }));
  } catch {
    result = event === 'PreToolUse' ? deny('Invalid hook input. No execution was authorized.') : note('Runtime event could not be processed; no completion is claimed.');
  }
  process.stdout.write(`${JSON.stringify(result.stdout)}\n`);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  process.exitCode = result.exitCode;
}
