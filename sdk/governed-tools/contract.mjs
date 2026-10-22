import { types } from 'node:util';
import { canonicalJson, safeId, sha256, validatedBaseUrl } from '../runtime/protocol.mjs';

export const CALL_SCHEMA = 'osuite.native_tool_call.v1';
export const COVERAGE = 'wrapped-call-only';
export const ADMISSION_PATH = 'studio-current-action';
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const id = value => safeId(value) && value.length <= 128;

export class GovernedToolError extends Error {
  constructor(code, status = null) {
    super(`OSuite ${code}: no automatic repeat of this operation.`);
    this.name = 'GovernedToolError';
    this.code = code;
    this.status = status;
    this.retryAutomatically = false;
  }
}
export function reject(code, status) { throw new GovernedToolError(code, status); }

// Validate descriptors before reading values: JSON.stringify alone can invoke
// accessors/toJSON or quietly change undefined, non-finite numbers and arrays.
export function jsonSnapshot(input, maxBytes = 65536) {
  const ancestors = new Set();
  let nodes = 0;
  function copy(value, depth) {
    if (++nodes > 8192 || depth > 16) reject('INVALID_INPUT');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if (value.length > maxBytes || !value.isWellFormed()) reject('INVALID_INPUT');
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Object.is(value, -0)) reject('INVALID_INPUT');
      return value;
    }
    if (typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) reject('INVALID_INPUT');
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) reject('INVALID_INPUT');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== 'string' || unsafeKeys.has(key)
      || !Object.hasOwn(descriptors[key], 'value') || (!descriptors[key].enumerable && !(array && key === 'length')))) reject('INVALID_INPUT');
    if (array && (value.length > 8192 || keys.length !== value.length + 1
      || keys.some(key => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)))) reject('INVALID_INPUT');
    ancestors.add(value);
    const result = array ? [] : {};
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (!key.isWellFormed()) reject('INVALID_INPUT');
      result[key] = copy(descriptors[key].value, depth + 1);
    }
    ancestors.delete(value);
    return Object.freeze(result);
  }
  const snapshot = copy(input, 0);
  if (Buffer.byteLength(canonicalJson(snapshot)) > maxBytes) reject('INVALID_INPUT');
  return snapshot;
}

export function scopeFor(config, namespace) {
  const base = validatedBaseUrl(config?.baseUrl);
  if (!base || !id(config.orgId) || !id(config.agentId) || !id(config.runtimeId) || !id(namespace)
      || (config.provider != null && !id(config.provider))) reject('INVALID_CONFIGURATION');
  return sha256(canonicalJson({ origin: base, org: config.orgId, agent: config.agentId,
    runtime: config.runtimeId, provider: config.provider || null, namespace }));
}

const strings = { action_type: 128, declared_goal: 2000, authorization_scope: 1000,
  data_classification: 64, data_residency_region: 128 };
const booleans = new Set(['reversible', 'privacy_review_required', 'data_minimization_declared', 'cross_border_transfer']);
const numbers = new Set(['risk_score', 'personal_data_likelihood']);
const arrays = new Set(['systems_touched', 'sensitive_data_categories', 'external_data_processors']);
const allowed = new Set([...Object.keys(strings), ...booleans, ...numbers, ...arrays, 'input_summary']);

function describe(binding, args) {
  let value;
  try { value = jsonSnapshot(binding.describe(args), 6000); } catch { reject('INVALID_MAPPING'); }
  if (!value || Array.isArray(value) || typeof value !== 'object'
      || Object.keys(value).some(key => !allowed.has(key)) || !value.action_type || !value.declared_goal) reject('INVALID_MAPPING');
  for (const [key, item] of Object.entries(value)) {
    if (strings[key] && (typeof item !== 'string' || !item.trim() || item.length > strings[key])) reject('INVALID_MAPPING');
    if (booleans.has(key) && typeof item !== 'boolean') reject('INVALID_MAPPING');
    if (numbers.has(key) && (!Number.isSafeInteger(item) || item < 0 || item > 100)) reject('INVALID_MAPPING');
    if (arrays.has(key) && (!Array.isArray(item) || item.length > 20
      || item.some(entry => typeof entry !== 'string' || entry.length > 500))) reject('INVALID_MAPPING');
  }
  if (value.input_summary !== undefined && (!value.input_summary || Array.isArray(value.input_summary)
    || typeof value.input_summary !== 'object' || Object.hasOwn(value.input_summary, 'osuite_native_call'))) reject('INVALID_MAPPING');
  return value;
}

export function makeInvocation({ config, namespace, bindings, operationId, params }) {
  const scope = scopeFor(config, namespace);
  if (!id(operationId)) reject('INVALID_OPERATION_ID');
  const native = jsonSnapshot(params, 32768);
  if (!native || Array.isArray(native) || !id(native.name) || !Object.hasOwn(native, 'arguments')
      || Object.keys(native).some(key => !['name', 'arguments'].includes(key))) reject('INVALID_INPUT');
  if (!bindings || !Object.hasOwn(bindings, native.name)) reject('UNSUPPORTED_TOOL');
  const binding = bindings[native.name];
  if (!binding || !id(binding.revision) || typeof binding.describe !== 'function') reject('INVALID_MAPPING');
  const description = describe(binding, native.arguments);
  // The historical Hook helper normalizes null to {}. Native calls must retain
  // every JSON value exactly, including that distinction.
  const inputDigest = sha256(canonicalJson({ tool_name: native.name, tool_input: native.arguments }));
  const bindingDigest = sha256(canonicalJson({ name: native.name, revision: binding.revision, description }));
  const identity = sha256(canonicalJson([scope, operationId]));
  const actionId = `act_${identity}`, sessionId = `sess_${identity}`, toolUseId = `tool_${identity}`;
  const marker = { schema_version: CALL_SCHEMA, operation_digest: sha256(operationId), input_digest: inputDigest, binding_digest: bindingDigest };
  const inputSummary = JSON.stringify({ ...description.input_summary, osuite_native_call: marker });
  if (inputSummary.length > 4000) reject('INVALID_MAPPING');
  const context = jsonSnapshot({ ...description, input_summary: inputSummary, action_id: actionId,
    agent_id: config.agentId, runtime_session_id: sessionId, tool_use_id: toolUseId,
    tool_input_digest: inputDigest, runtime_family: 'sdk_tool_runtime', adapter_mode: 'sdk_wrapper' });
  return Object.freeze({ params: native, context, marker, record: Object.freeze({ scope, operationId,
    inputDigest, bindingDigest, contextDigest: sha256(canonicalJson(context)), actionId, sessionId, toolUseId }) });
}

export function matchesStoredAction(payload, record, config) {
  try {
    const action = payload?.action || payload;
    const summary = typeof action?.input_summary === 'string' ? JSON.parse(action.input_summary) : action?.input_summary;
    const marker = summary?.osuite_native_call;
    const envelope = action?.action_envelope;
    return action?.action_id === record.actionId && action.agent_id === config.agentId
      && action.org_id === config.orgId && action.verified === true
      && (!payload.action_id || payload.action_id === record.actionId)
      && envelope?.runtime_session_id === record.sessionId
      && marker?.schema_version === CALL_SCHEMA && marker.operation_digest === sha256(record.operationId)
      && marker.input_digest === record.inputDigest && marker.binding_digest === record.bindingDigest;
  } catch { return false; }
}

export function publicStatus(record, baseUrl) {
  if (!record) return null;
  return Object.freeze({ operationId: record.operationId, actionId: record.actionId, state: record.state,
    resultDigest: record.resultDigest || null, reportState: record.reportState,
    reviewUrl: `${baseUrl}/approvals?action=${encodeURIComponent(record.actionId)}`,
    replayUrl: `${baseUrl}/replay/${encodeURIComponent(record.actionId)}`,
    admissionPath: ADMISSION_PATH, coverage: COVERAGE, retryAutomatically: false,
    resultRetained: false });
}
