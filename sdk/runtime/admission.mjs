import { setTimeout as delay } from 'node:timers/promises';
import { canonicalJson, isObject, isTransientFailure, safeId, RULE_ROLLOUT_CAPABILITY } from './protocol.mjs';

export const REVIEW_DECISIONS = new Set(['require_approval', 'require_dual_approval']);
const DECISIONS = new Set(['allow', 'warn', 'block', ...REVIEW_DECISIONS]);
const closed = (reason, extra = {}) => ({ authorized: false, decision: 'block', reason, retryAutomatically: false, ...extra });

function rolloutSnapshots(payload) {
  const current = isObject(payload?.decision) ? payload.decision : payload;
  return [current?.policy_snapshot, payload?.contracts?.policy_snapshot, payload?.action?.policy_snapshot,
    payload?.action?.proof_bundle?.policy_snapshot, payload?.contracts?.proof_bundle?.policy_snapshot].filter(isObject);
}

function rolloutAuthority(payload, context, config, expected) {
  const current = isObject(payload?.decision) ? payload.decision : payload;
  const snapshots = rolloutSnapshots(payload);
  const present = [current, ...snapshots].filter(isObject)
    .some(value => Object.hasOwn(value, 'rule_rollout') || Object.hasOwn(value, 'rule_rollout_binding'));
  const negotiated = config.ruleRollout;
  if (!present && !expected && !negotiated?.enabled) return { valid: true, binding: null };
  const binding = current?.rule_rollout_binding, report = current?.rule_rollout;
  const scopeKeys = ['org_id', 'runtime_id', 'agent_id', 'provider', 'connection_id'];
  const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  // These fields arrive from the authenticated API, never the tool request.
  // Their only authority is to forbid observe bypass, not to grant execution.
  if (expected === null || !isObject(binding) || !isObject(report) || (negotiated && !negotiated.enabled)
      || binding.schema_version !== 'osuite.rule_rollout_binding.v1' || binding.enforcement_required !== true
      || !isObject(binding.scope) || Object.keys(binding.scope).length !== scopeKeys.length
      || scopeKeys.some(key => !safeId(binding.scope[key]) || binding.scope[key].length > 128)
      || binding.scope.agent_id !== config.agentId || binding.scope.agent_id !== context.agent_id
      || binding.scope.runtime_id !== config.runtimeId
      || (negotiated?.enabled && (binding.version !== negotiated.version || canonicalJson(binding.scope) !== canonicalJson(negotiated.scope)
        || binding.credential_id !== negotiated.credential_id || binding.connection_generation !== negotiated.connection_generation
        || binding.expires_at !== negotiated.expires_at))
      || (config.orgId && binding.scope.org_id !== config.orgId) || (config.provider && binding.scope.provider !== config.provider)
      || !Number.isSafeInteger(binding.version) || binding.version < 1
      || !Number.isFinite(approvalTime(binding.expires_at)) || approvalTime(binding.expires_at) <= Date.now()
      || !safeId(binding.runtime_session_id) || binding.runtime_session_id !== context.runtime_session_id
      || !digest(binding.tool_input_digest) || binding.tool_input_digest !== context.tool_input_digest
      || !binding.action_type || binding.action_type !== context.action_type
      || !digest(binding.policy_context_fingerprint) || binding.policy_context_fingerprint !== current.policy_context_fingerprint
      || report.schema_version !== 'osuite.rule_rollout_evaluation.v1' || report.status !== 'evaluated'
      || report.version !== binding.version || report.expires_at !== binding.expires_at
      || canonicalJson(report.scope) !== canonicalJson(binding.scope)
      || !isObject(current.policy_snapshot) || !snapshots.length
      || current.policy_snapshot.effective_decision !== ({ block: 'deny', warn: 'allow_with_evidence' }[current.decision] || current.decision)
      || snapshots.some(snapshot => canonicalJson(snapshot.rule_rollout_binding) !== canonicalJson(binding)
        || canonicalJson(snapshot.rule_rollout) !== canonicalJson(report))
      || (expected && canonicalJson(binding) !== canonicalJson(expected))) return { valid: false, binding: null };
  return { valid: true, binding };
}

function approvalReceipts(payload) {
  const action = payload?.action || payload || {};
  return [action.approval_receipts, action.proof_bundle?.approval_receipts,
    payload?.approval_receipts, payload?.contracts?.proof_bundle?.approval_receipts]
    .flatMap(value => Array.isArray(value) ? value.filter(isObject) : []);
}

export function cavaFingerprint(payload) {
  return [payload?.contracts?.action_envelope?.cava?.fingerprint,
    payload?.contracts?.proof_bundle?.action_envelope?.cava?.fingerprint,
    payload?.action?.action_envelope?.cava?.fingerprint,
    payload?.action?.proof_bundle?.action_envelope?.cava?.fingerprint,
    payload?.action_envelope?.cava?.fingerprint, payload?.proof_bundle?.action_envelope?.cava?.fingerprint]
    .find(value => typeof value === 'string' && value.trim()) || null;
}

export function matchesAction(payload, context, { actionId = null, fingerprint = null } = {}) {
  const action = payload?.action || payload;
  if (!isObject(action) || !safeId(action.action_id)) return false;
  if (actionId && action.action_id !== actionId) return false;
  if (payload.action_id && payload.action_id !== action.action_id) return false;
  if (action.tool_input_digest && action.tool_input_digest !== context.tool_input_digest) return false;
  if (action.agent_id && action.agent_id !== context.agent_id) return false;
  if (action.runtime_session_id && action.runtime_session_id !== context.runtime_session_id) return false;
  for (const envelope of [action.action_envelope, payload.contracts?.action_envelope]) {
    if (envelope?.runtime_session_id !== undefined && envelope.runtime_session_id !== context.runtime_session_id) return false;
  }
  if (fingerprint) {
    const receipts = approvalReceipts(payload).filter(receipt => ['allow', 'approved', 'approve'].includes(receipt.decision || receipt.status));
    const fingerprints = receipts.flatMap(receipt => {
      const scope = receipt.approval_scope || {};
      if (scope.reusable === true || (receipt.action_id || scope.action_id) !== action.action_id) return [];
      return [receipt.canonical_fingerprint || scope.canonical_fingerprint].filter(Boolean);
    });
    if (fingerprints.length ? !fingerprints.includes(fingerprint) : cavaFingerprint(payload) !== fingerprint) return false;
  }
  return true;
}

function approvalTime(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    ? Date.parse(value) : NaN;
}

function confirmedRedemption({ action, approval }) {
  if (approval?.state !== 'approved' || approval.reused !== true || action.approval_decision !== 'allow'
      || typeof action.approved_by !== 'string' || !action.approved_by.trim()) return false;
  const approvedAt = approvalTime(action.approved_at);
  const redeemedAt = approvalTime(action.approval_redeemed_at);
  const expiresAt = approvalTime(action.approval_expires_at);
  const now = Date.now();
  // A GET-shaped approval is not a redeemed grant. These are consistency checks,
  // not independent proof of the server's atomic update or exactly-once effects.
  if (![approvedAt, redeemedAt, expiresAt].every(Number.isFinite)
      || approvedAt > redeemedAt || redeemedAt > now || expiresAt <= now) return false;
  if (approval.decided_by !== undefined && approval.decided_by !== action.approved_by) return false;
  if (approval.decided_at !== undefined && approvalTime(approval.decided_at) !== approvedAt) return false;
  if (approval.expires_at !== undefined && approvalTime(approval.expires_at) !== expiresAt) return false;
  return true;
}

export function actionAdmission(payload, requestedDecision, context, expected = {}) {
  if (!isObject(payload) || payload.error || !isObject(payload.action) || !safeId(payload.action_id)
      || payload.action.action_id !== payload.action_id || !matchesAction(payload, context)) return closed('action_creation_not_authorized');
  const actionId = payload.action_id;
  const action = payload.action;
  const decision = payload.decision?.decision;
  const base = { actionId, response: payload };
  if (!DECISIONS.has(decision) || !['running', 'pending_approval'].includes(action.status)
      || (payload.status !== undefined && payload.status !== action.status)
      || action.timestamp_end != null || ['denied', 'expired'].includes(payload.approval?.state)
      || requestedDecision === 'block' || decision === 'block') return closed('action_creation_not_authorized', base);
  if (action.status === 'pending_approval') return { ...base, authorized: false, decision: 'require_approval', reason: 'awaiting_approval' };
  if (REVIEW_DECISIONS.has(decision) || REVIEW_DECISIONS.has(requestedDecision)) {
    if (!confirmedRedemption(payload)
        || !matchesAction(payload, context, expected)) return closed('approval_not_confirmed', base);
    return { ...base, authorized: true, decision: 'approved_by_reviewer' };
  }
  return { ...base, authorized: true, decision: decision === 'warn' || requestedDecision === 'warn' ? 'warn' : 'allow' };
}

function installCheck(payload, context) {
  if (!context.health_check || payload?.approval?.state !== 'not_requested') return null;
  if (payload.error || !safeId(payload.action_id) || payload.action?.action_id !== payload.action_id
      || payload.action?.status !== 'cancelled' || (payload.status !== undefined && payload.status !== 'cancelled')
      || !REVIEW_DECISIONS.has(payload.decision?.decision)) return closed('invalid_install_check');
  return { authorized: false, decision: payload.decision.decision, installCheck: true, reason: 'approval_not_requested', response: payload };
}

export async function admitAction(context, { api, config, sleep = delay, now = () => performance.now(), beforeRelease = async () => true } = {}) {
  const guard = await api.request('POST', '/api/guard', context);
  if (!guard.ok) {
    // Rejection, bad evidence and unknown errors are not availability failures.
    if (!isTransientFailure(guard)) return closed('guard_rejected', { rejectedStatus: guard.status });
    const failOpen = ['observe', 'enforce'].includes(config.mode)
      && config.ruleRolloutCapability !== RULE_ROLLOUT_CAPABILITY && !config.ruleRollout?.enabled
      && config.guardFailureMode === 'allow';
    return { ...closed('guard_unavailable'), decision: failOpen ? 'allow' : 'block', degraded: true };
  }
  const requestedDecision = guard.body?.decision;
  if (!DECISIONS.has(requestedDecision)) return closed('unsupported_guard_decision');
  const rollout = rolloutAuthority(guard.body, context, config);
  if (!rollout.valid) return closed('rule_rollout_binding_invalid');
  const finish = result => rollout.binding ? { ...result, observeOnly: false, ruleRolloutBinding: rollout.binding } : result;
  if (requestedDecision === 'block') {
    // Observation still persists the would-block result, but never calls it authority.
    const observeOnly = config.mode === 'observe' && !rollout.binding;
    if (observeOnly) {
      const recorded = await api.request('POST', '/api/actions', { ...context, status: 'blocked' });
      if (!recorded.ok && (!isTransientFailure(recorded) || config.guardFailureMode !== 'allow')) {
        return closed('admission_unconfirmed', { rejectedStatus: recorded.status });
      }
    }
    return finish({ ...closed('policy_block'), observeOnly, response: guard.body });
  }
  const created = await api.request('POST', '/api/actions', {
    ...context, status: REVIEW_DECISIONS.has(requestedDecision) ? 'pending_approval' : 'running',
  });
  if (!created.ok) return closed('admission_unconfirmed', { rejectedStatus: created.status });
  if (!rolloutAuthority(created.body, context, config, rollout.binding).valid) return closed('rule_rollout_binding_invalid');
  const diagnostic = installCheck(created.body, context);
  if (diagnostic) return finish(diagnostic);
  let result = finish(actionAdmission(created.body, requestedDecision, context));
  if (result.authorized) return await beforeRelease(result.response) ? result : closed('action_evidence_changed');
  if (result.decision !== 'require_approval') return result;
  if (config.mode === 'observe' && !rollout.binding) return { ...result, observeOnly: true };

  const expected = { actionId: result.actionId, fingerprint: cavaFingerprint(created.body) };
  const waitMs = Math.max(0, Math.min(config.approvalWaitMs ?? 30000, 600000));
  const deadline = now() + waitMs;
  while (now() < deadline) {
    await sleep(Math.min(3000, Math.max(0, deadline - now())));
    if (rollout.binding && approvalTime(rollout.binding.expires_at) <= Date.now()) return closed('rule_rollout_expired', { actionId: expected.actionId });
    const polled = await api.request('GET', `/api/actions/${encodeURIComponent(expected.actionId)}`, undefined, {
      timeoutMs: Math.max(1, Math.min(2500, deadline - now())),
    });
    if (!polled.ok) {
      if ([401, 403, 409].includes(polled.status)) return closed('approval_access_rejected', { actionId: expected.actionId, rejectedStatus: polled.status });
      continue;
    }
    const action = polled.body?.action || polled.body;
    if (!matchesAction(polled.body, context, expected)) return closed('approval_binding_mismatch', { actionId: expected.actionId });
    if (rollout.binding) {
      const snapshots = rolloutSnapshots(polled.body);
      if (!snapshots.length || snapshots.some(snapshot => canonicalJson(snapshot.rule_rollout_binding) !== canonicalJson(rollout.binding))) {
        return closed('rule_rollout_binding_invalid', { actionId: expected.actionId });
      }
    }
    if (action.status === 'pending_approval') continue;
    if (action.status !== 'running') return closed('approval_closed', { actionId: expected.actionId });
    if (action.approval_redeemed_at != null || action.timestamp_end != null) return closed('execution_outcome_unknown', { actionId: expected.actionId });
    if (!(action.approved_by || action.approved_at) || polled.body.approval?.state === 'denied') {
      return closed('approval_not_confirmed', { actionId: expected.actionId });
    }
    // GET observes a grant. Only this fresh POST may redeem it. Never retry a lost reply.
    const current = await api.request('POST', '/api/actions', { ...context, status: 'running' });
    if (!current.ok) return closed('admission_unconfirmed', { actionId: expected.actionId, rejectedStatus: current.status });
    if (!rolloutAuthority(current.body, context, config, rollout.binding).valid) return closed('rule_rollout_binding_invalid', { actionId: expected.actionId });
    result = finish(actionAdmission(current.body, 'allow', context, expected));
    if (result.authorized && !await beforeRelease(result.response)) return closed('action_evidence_changed', { actionId: result.actionId });
    return result;
  }
  return result;
}
