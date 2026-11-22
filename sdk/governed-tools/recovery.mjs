import { types } from 'node:util';
import { canonicalJson, safeId, sha256 } from '../runtime/protocol.mjs';
import { cavaFingerprint } from '../runtime/admission.mjs';
import { jsonSnapshot, reject } from './contract.mjs';

const SCHEMA = 'osuite.native_recovery.v1';
const EVIDENCE_SCHEMA = 'osuite.native_recovery_evidence.v1';
const CONTRACTS = ['settled-absence', 'same-id-idempotent'];
const MAX_AGE_MS = 5000;

export function recoveryAdapter(descriptor) {
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) reject('INVALID_MAPPING');
  const input = descriptor.value;
  if (!input || typeof input !== 'object' || types.isProxy(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) reject('INVALID_MAPPING');
  const fields = Object.getOwnPropertyDescriptors(input);
  const keys = ['revision', 'resourceId', 'contract', 'observe', 'execute'];
  if (Reflect.ownKeys(fields).length !== keys.length || Reflect.ownKeys(fields).some(key => !keys.includes(key)
      || !Object.hasOwn(fields[key], 'value') || !fields[key].enumerable)) reject('INVALID_MAPPING');
  const value = Object.fromEntries(keys.map(key => [key, fields[key]?.value]));
  if (![value.revision, value.resourceId].every(id => safeId(id) && id.length <= 128)
      || !CONTRACTS.includes(value.contract)
      || ![value.observe, value.execute].every(fn => typeof fn === 'function' && !types.isProxy(fn))) reject('INVALID_MAPPING');
  return Object.freeze(value);
}

// A separate, deterministic scope keeps the parent permanently fenced, even in
// old SDKs. No caller can select another attempt or replace this child's grant.
export const recoveryScope = scope => sha256(canonicalJson([SCHEMA, scope]));

export function makeRecoveryInvocation(parent, adapter) {
  const original = parent.record, scope = recoveryScope(original.scope);
  const identity = sha256(canonicalJson([scope, original.operationId]));
  const actionId = `act_${identity}`, sessionId = `sess_${identity}`, toolUseId = `tool_${identity}`;
  const binding = jsonSnapshot({ operationId: original.operationId, scope: original.scope,
    inputDigest: original.inputDigest, bindingDigest: original.bindingDigest, actionId: original.actionId,
    resourceId: adapter.resourceId, adapterRevision: adapter.revision, contract: adapter.contract });
  const linkage = jsonSnapshot({ schema_version: SCHEMA, parent_action_id: original.actionId,
    parent_scope: original.scope, operation_digest: sha256(original.operationId), input_digest: original.inputDigest,
    binding_digest: original.bindingDigest, adapter_revision: adapter.revision,
    resource_id: adapter.resourceId, contract: adapter.contract });
  const bindingDigest = sha256(canonicalJson(linkage));
  const marker = { ...parent.marker, binding_digest: bindingDigest };
  const summary = { ...JSON.parse(parent.context.input_summary), osuite_native_call: marker, osuite_native_recovery: linkage };
  const inputSummary = JSON.stringify(summary);
  if (inputSummary.length > 4000) reject('INVALID_MAPPING');
  const context = jsonSnapshot({ ...parent.context, input_summary: inputSummary,
    action_id: actionId, runtime_session_id: sessionId, tool_use_id: toolUseId });
  const invocation = Object.freeze({ params: parent.params, context, marker, recovery: linkage,
    record: Object.freeze({ ...original, scope, actionId, sessionId, toolUseId, bindingDigest,
      contextDigest: sha256(canonicalJson(context)) }) });
  return { invocation, request: Object.freeze({ params: parent.params, binding }) };
}

export function validateEvidence(input, binding) {
  let value;
  try { value = jsonSnapshot(input, 8192); } catch { reject('RECOVERY_EVIDENCE_INVALID'); }
  const fields = [...Object.keys(binding), 'schemaVersion', 'observedAt', 'expiresAt', 'settled', 'outcome', 'proof'];
  const now = Date.now();
  if (!value || Array.isArray(value) || typeof value !== 'object'
      || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))
      || Object.entries(binding).some(([key, expected]) => value[key] !== expected)
      || value.schemaVersion !== EVIDENCE_SCHEMA || value.settled !== true
      || !Number.isSafeInteger(value.observedAt) || !Number.isSafeInteger(value.expiresAt)
      || value.observedAt < now - MAX_AGE_MS || value.observedAt > now
      || value.expiresAt <= now || value.expiresAt <= value.observedAt || value.expiresAt > value.observedAt + MAX_AGE_MS
      || !['absent', 'applied', 'unknown'].includes(value.outcome)
      || (binding.contract === 'settled-absence' && value.outcome !== 'absent')
      || !value.proof || Array.isArray(value.proof) || typeof value.proof !== 'object'
      || Object.keys(value.proof).length === 0) reject('RECOVERY_EVIDENCE_INVALID');
  return value;
}

export async function observeEvidence(adapter, request) {
  let result;
  try { result = await adapter.observe(request); } catch { reject('RECOVERY_EVIDENCE_INVALID'); }
  return validateEvidence(result, request.binding);
}

export async function checkRecoveryAuthority(authority, record, admission = null) {
  const observed = await authority.read(record);
  if (!observed.available) reject(observed.mismatch ? 'BINDING_MISMATCH' : 'CURRENT_AUTHORITY_UNAVAILABLE');
  const states = [observed.action.status, observed.body.approval?.state];
  if (states.includes('cancelled')) reject('CANCELLED');
  if (states.includes('expired')) reject('APPROVAL_EXPIRED');
  if (states.some(state => ['denied', 'blocked'].includes(state))) reject('POLICY_DENIED');
  const fingerprint = admission ? cavaFingerprint(admission.response) : record.fingerprint;
  if (fingerprint && fingerprint !== cavaFingerprint(observed.body)) reject('BINDING_MISMATCH');
  let expiresAt = Infinity;
  if (admission) {
    if (observed.action.status !== 'running' || observed.action.timestamp_end != null) reject('OUTCOME_UNKNOWN');
    if (admission.ruleExpiresAt != null) {
      expiresAt = Date.parse(admission.ruleExpiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) reject('OUTCOME_UNKNOWN');
    }
    // A consumed child grant is not reusable authority: it must still match the
    // fresh redemption we just observed, and must not expire before dispatch.
    if (admission.phase === 'redeeming') {
      const original = admission.response.action;
      for (const key of ['approved_by', 'approved_at', 'approval_redeemed_at', 'approval_expires_at', 'approval_decision']) {
        if (observed.action[key] !== original[key]) reject('OUTCOME_UNKNOWN');
      }
      expiresAt = Math.min(expiresAt, Date.parse(observed.action.approval_expires_at));
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) reject('APPROVAL_EXPIRED');
    }
  } else if (!['running', 'failed'].includes(observed.action.status)) reject('OUTCOME_UNKNOWN');
  return expiresAt;
}
