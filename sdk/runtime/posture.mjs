import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson, isObject, safeId, sha256, RULE_ROLLOUT_CAPABILITY } from './protocol.mjs';

export const POSTURE_SCHEMA = 'osuite.runtime_posture.v1';
const MAX_FRESHNESS_MS = 300000;
const MODE_STRENGTH = { observe: 0, enforce: 1, strict: 2 };
const scopeKeys = ['org_id', 'runtime_id', 'agent_id', 'provider', 'connection_id'];

function validAcknowledgement(value, config, now) {
  const binding = value?.device_binding, issued = Date.parse(value?.acknowledged_at), expires = Date.parse(value?.expires_at);
  return value?.schema_version === 'osuite.rule_rollout_client.v1' && value.capability === RULE_ROLLOUT_CAPABILITY
    && isObject(value.scope) && Object.keys(value.scope).length === scopeKeys.length && scopeKeys.every(key => safeId(value.scope[key]))
    && value.scope.runtime_id === config.runtimeId && value.scope.agent_id === config.agentId
    && (!config.orgId || value.scope.org_id === config.orgId) && (!config.provider || value.scope.provider === config.provider)
    && isObject(binding) && safeId(binding.credential_id) && binding.capability === RULE_ROLLOUT_CAPABILITY
    && Number.isSafeInteger(binding.connection_generation) && binding.connection_generation >= 1
    && typeof binding.public_key_fingerprint === 'string' && /^[a-f0-9]{64}$/.test(binding.public_key_fingerprint)
    && Number.isFinite(issued) && Number.isFinite(expires) && issued <= now + 30000 && expires > now
    && expires > issued && expires - issued <= 900000;
}

function matchesAcknowledgement(document, acknowledgement) {
  return document.credential_id === acknowledgement.device_binding.credential_id
    && document.org_id === acknowledgement.scope.org_id
    && canonicalJson(document.rule_rollout?.scope) === canonicalJson(acknowledgement.scope)
    && document.rule_rollout?.credential_id === acknowledgement.device_binding.credential_id
    && document.rule_rollout?.connection_generation === acknowledgement.device_binding.connection_generation;
}

function preservesRolloutFloor(previous, current) {
  const before = previous?.rule_rollout, after = current?.rule_rollout;
  if (!before?.enabled) return true;
  return after?.enabled === true && canonicalJson(before.scope) === canonicalJson(after.scope)
    && before.credential_id === after.credential_id && after.connection_generation >= before.connection_generation
    && after.version >= before.version && (after.version !== before.version || canonicalJson(before) === canonicalJson(after));
}

function validNegotiation(document, config, now) {
  if (config.ruleRolloutCapability !== RULE_ROLLOUT_CAPABILITY) return true;
  const rollout = document.rule_rollout;
  if (!isObject(rollout) || rollout.schema_version !== 'osuite.rule_rollout_negotiation.v1'
      || rollout.capability !== RULE_ROLLOUT_CAPABILITY || typeof rollout.enabled !== 'boolean') return false;
  if (!rollout.enabled) return true;
  return isObject(rollout.scope) && Object.keys(rollout.scope).length === scopeKeys.length && scopeKeys.every(key => safeId(rollout.scope[key]))
    && rollout.scope.org_id === document.org_id && rollout.scope.runtime_id === config.runtimeId
    && rollout.scope.agent_id === config.agentId && (!config.provider || rollout.scope.provider === config.provider)
    && rollout.credential_id === document.credential_id && Number.isSafeInteger(rollout.connection_generation) && rollout.connection_generation >= 1
    && Number.isSafeInteger(rollout.version) && rollout.version >= 1 && Date.parse(rollout.expires_at) > now
    && rollout.strict_floor === true && document.posture?.mode === 'strict'
    && document.posture?.on_guard_unavailable === 'block' && document.posture?.require_signature === true;
}

export function localPosture(config) {
  return {
    runtime_id: config.runtimeId,
    mode: Object.hasOwn(MODE_STRENGTH, config.mode) ? config.mode : 'enforce',
    on_guard_unavailable: config.guardFailureMode === 'block' || config.mode === 'strict' ? 'block' : 'allow',
    require_signature: config.signatureMode === 'required',
    require_assumption_capture: config.requireAssumptionCapture === true,
    approval_timeout_seconds: config.approvalTimeoutSeconds || 600,
  };
}

function offlinePosture(local, cached) {
  if (!cached) return local;
  return {
    ...cached,
    mode: MODE_STRENGTH[local.mode] > MODE_STRENGTH[cached.mode] ? local.mode : cached.mode,
    on_guard_unavailable: local.on_guard_unavailable === 'block' || cached.on_guard_unavailable === 'block' ? 'block' : 'allow',
    require_signature: local.require_signature || cached.require_signature,
    require_assumption_capture: local.require_assumption_capture || cached.require_assumption_capture,
    approval_timeout_seconds: Math.min(local.approval_timeout_seconds, cached.approval_timeout_seconds),
  };
}

function validDocument(value, config, now, allowExpired = false) {
  if (!isObject(value) || value.schema_version !== POSTURE_SCHEMA || value.runtime_id !== config.runtimeId) return false;
  if (typeof value.org_id !== 'string' || !value.org_id || typeof value.credential_id !== 'string' || !value.credential_id) return false;
  if (config.orgId && config.orgId !== value.org_id) return false;
  if (value.credential_fingerprint !== sha256(config.apiKey || '')) return false;
  if (value.targeting?.agent_id !== config.agentId || (value.targeting?.provider || null) !== (config.provider || null)) return false;
  if (typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision)) return false;
  if (!validNegotiation(value, config, allowExpired ? 0 : now)) return false;
  const posture = value.posture;
  if (!isObject(posture) || posture.runtime_id !== config.runtimeId || !Object.hasOwn(MODE_STRENGTH, posture.mode)) return false;
  if (!['allow', 'block'].includes(posture.on_guard_unavailable)) return false;
  if (typeof posture.require_signature !== 'boolean' || typeof posture.require_assumption_capture !== 'boolean') return false;
  if (!Number.isSafeInteger(posture.approval_timeout_seconds) || posture.approval_timeout_seconds < 1 || posture.approval_timeout_seconds > 3600) return false;
  const issued = Date.parse(value.issued_at);
  const until = Date.parse(value.valid_until);
  return Number.isFinite(issued) && Number.isFinite(until) && issued <= now + 30000
    && until > issued && until - issued <= MAX_FRESHNESS_MS && (allowExpired || until > now);
}

function configurationOnly(document) {
  return Object.fromEntries([
    'schema_version', 'runtime_id', 'org_id', 'credential_id', 'credential_fingerprint',
    'targeting', 'posture', 'revision', 'issued_at', 'valid_until',
    ...(document.rule_rollout ? ['rule_rollout'] : []),
  ].map(key => [key, document[key]]));
}

function mac(document, config) {
  return createHmac('sha256', config.apiKey || '').update('osuite.posture-cache.v1\n').update(canonicalJson(document)).digest('hex');
}

function cachedDocument(value, config, now) {
  try {
    if (!isObject(value) || !validDocument(value.document, config, now, true) || !/^[a-f0-9]{64}$/.test(value.mac)) return null;
    if (!timingSafeEqual(Buffer.from(value.mac, 'hex'), Buffer.from(mac(value.document, config), 'hex'))) return null;
    return value.document;
  } catch { return null; }
}

function readCache(store, config, now) {
  try { return cachedDocument(store.read('posture'), config, now); } catch { return null; }
}

export async function resolveRemotePosture(config, { api, store, now = Date.now() }) {
  const capable = config.ruleRolloutCapability === RULE_ROLLOUT_CAPABILITY;
  let acknowledged = null;
  if (capable) {
    const acknowledgement = await api.request('PUT', `/api/runtimes/${encodeURIComponent(config.runtimeId)}/posture`, {
      capability: RULE_ROLLOUT_CAPABILITY, runtime_id: config.runtimeId, agent_id: config.agentId, issued_at: new Date(now).toISOString(),
    }, { timeoutMs: 2000 });
    const value = acknowledgement.body;
    if (!acknowledgement.ok || !validAcknowledgement(value, config, now)) {
      return { available: false, blocked: true, source: 'unavailable', posture: localPosture(config), revision: null };
    }
    acknowledged = value;
  }
  const query = new URLSearchParams({ agent_id: config.agentId });
  if (config.provider) query.set('provider', config.provider);
  const response = await api.request('GET', `/api/runtimes/${encodeURIComponent(config.runtimeId)}/posture?${query}`, undefined, { timeoutMs: 2000 });
  const rejected = [401, 403, 409].includes(response.status);
  let cached = readCache(store, config, now);
  if (response.ok && response.status === 200 && validDocument(response.body, config, now)
      && (!capable || matchesAcknowledgement(response.body, acknowledged)) && preservesRolloutFloor(cached, response.body)
      && (!cached || Date.parse(response.body.issued_at) >= Date.parse(cached.issued_at))) {
    const document = configurationOnly(response.body);
    try {
      // The comparison and replacement share a cross-process lock. A stale
      // response must not replace a stronger configuration published meanwhile.
      const saved = store.update('posture', value => {
        const latest = cachedDocument(value, config, now);
        return latest && (Date.parse(latest.issued_at) > Date.parse(document.issued_at) || !preservesRolloutFloor(latest, document))
          ? value : { document, mac: mac(document, config) };
      });
      cached = cachedDocument(saved, config, now);
      if (cached && canonicalJson(cached) === canonicalJson(document)) {
        return { available: true, blocked: false, source: 'remote', posture: document.posture, revision: document.revision,
          ruleRollout: document.rule_rollout, orgId: document.org_id };
      }
    } catch {
      const posture = offlinePosture(offlinePosture(localPosture(config), readCache(store, config, now)?.posture), document.posture);
      return { available: false, blocked: capable || posture.mode !== 'observe', source: 'unavailable', posture, revision: cached?.revision || null };
    }
  }
  const posture = offlinePosture(localPosture(config), cached?.posture);
  // Revocation and explicit scope rejection invalidate cached authority immediately.
  if (!rejected && !(capable && response.ok) && cached && Date.parse(cached.valid_until) > now
      && validNegotiation(cached, config, now)) {
    if (capable && !matchesAcknowledgement(cached, acknowledged)) return { available: false, blocked: true, source: 'unavailable', posture, revision: cached.revision };
    return { available: true, blocked: false, source: 'cache', posture, revision: cached.revision,
      ruleRollout: cached.rule_rollout, orgId: cached.org_id };
  }
  return { available: false, blocked: rejected || capable || posture.mode !== 'observe', source: 'unavailable', posture, revision: cached?.revision || null };
}
