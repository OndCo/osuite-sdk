import { setTimeout as delay } from 'node:timers/promises';
import { isObject, safeId } from './protocol.mjs';

export const REVIEW_DECISIONS = new Set(['require_approval', 'require_dual_approval']);
const DECISIONS = new Set(['allow', 'warn', 'block', ...REVIEW_DECISIONS]);
const closed = (reason, extra = {}) => ({ authorized: false, decision: 'block', reason, retryAutomatically: false, ...extra });

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
    const failOpen = config.guardFailureMode === 'allow' && ![401, 403].includes(guard.status)
      && !['signing_unavailable', 'invalid_response', 'invalid_request'].includes(guard.error);
    return { ...closed('guard_unavailable'), decision: failOpen ? 'allow' : 'block', degraded: true };
  }
  const requestedDecision = guard.body?.decision;
  if (!DECISIONS.has(requestedDecision)) return closed('unsupported_guard_decision');
  if (requestedDecision === 'block') {
    // Observation still persists the would-block result, but never calls it authority.
    if (config.mode === 'observe') await api.request('POST', '/api/actions', { ...context, status: 'blocked' });
    return { ...closed('policy_block'), observeOnly: config.mode === 'observe', response: guard.body };
  }
  const created = await api.request('POST', '/api/actions', {
    ...context, status: REVIEW_DECISIONS.has(requestedDecision) ? 'pending_approval' : 'running',
  });
  if (!created.ok) return closed('admission_unconfirmed');
  const diagnostic = installCheck(created.body, context);
  if (diagnostic) return diagnostic;
  let result = actionAdmission(created.body, requestedDecision, context);
  if (result.authorized) return await beforeRelease(result.response) ? result : closed('action_evidence_changed');
  if (result.decision !== 'require_approval') return result;
  if (config.mode === 'observe') return { ...result, observeOnly: true };

  const expected = { actionId: result.actionId, fingerprint: cavaFingerprint(created.body) };
  const waitMs = Math.max(0, Math.min(config.approvalWaitMs ?? 30000, 600000));
  const deadline = now() + waitMs;
  while (now() < deadline) {
    await sleep(Math.min(3000, Math.max(0, deadline - now())));
    const polled = await api.request('GET', `/api/actions/${encodeURIComponent(expected.actionId)}`, undefined, {
      timeoutMs: Math.max(1, Math.min(2500, deadline - now())),
    });
    if (!polled.ok) {
      if ([401, 403].includes(polled.status)) return closed('approval_access_rejected', { actionId: expected.actionId });
      continue;
    }
    const action = polled.body?.action || polled.body;
    if (!matchesAction(polled.body, context, expected)) return closed('approval_binding_mismatch', { actionId: expected.actionId });
    if (action.status === 'pending_approval') continue;
    if (action.status !== 'running') return closed('approval_closed', { actionId: expected.actionId });
    if (action.approval_redeemed_at != null || action.timestamp_end != null) return closed('execution_outcome_unknown', { actionId: expected.actionId });
    if (!(action.approved_by || action.approved_at) || polled.body.approval?.state === 'denied') {
      return closed('approval_not_confirmed', { actionId: expected.actionId });
    }
    // GET observes a grant. Only this fresh POST may redeem it. Never retry a lost reply.
    const current = await api.request('POST', '/api/actions', { ...context, status: 'running' });
    if (!current.ok) return closed('admission_unconfirmed', { actionId: expected.actionId });
    result = actionAdmission(current.body, 'allow', context, expected);
    if (result.authorized && !await beforeRelease(result.response)) return closed('action_evidence_changed', { actionId: result.actionId });
    return result;
  }
  return result;
}
