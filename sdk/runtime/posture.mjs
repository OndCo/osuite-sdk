import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson, isObject, sha256 } from './protocol.mjs';

export const POSTURE_SCHEMA = 'osuite.runtime_posture.v1';
const MAX_FRESHNESS_MS = 300000;
const MODE_STRENGTH = { observe: 0, enforce: 1, strict: 2 };

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
  const query = new URLSearchParams({ agent_id: config.agentId });
  if (config.provider) query.set('provider', config.provider);
  const response = await api.request('GET', `/api/runtimes/${encodeURIComponent(config.runtimeId)}/posture?${query}`, undefined, { timeoutMs: 2000 });
  let cached = readCache(store, config, now);
  if (response.ok && response.status === 200 && validDocument(response.body, config, now)
      && (!cached || Date.parse(response.body.issued_at) >= Date.parse(cached.issued_at))) {
    const document = configurationOnly(response.body);
    try {
      // The comparison and replacement share a cross-process lock. A stale
      // response must not replace a stronger configuration published meanwhile.
      const saved = store.update('posture', value => {
        const latest = cachedDocument(value, config, now);
        return latest && Date.parse(latest.issued_at) > Date.parse(document.issued_at)
          ? value : { document, mac: mac(document, config) };
      });
      cached = cachedDocument(saved, config, now);
      if (cached && canonicalJson(cached) === canonicalJson(document)) {
        return { available: true, blocked: false, source: 'remote', posture: document.posture, revision: document.revision };
      }
    } catch {
      const posture = offlinePosture(offlinePosture(localPosture(config), readCache(store, config, now)?.posture), document.posture);
      return { available: false, blocked: posture.mode !== 'observe', source: 'unavailable', posture, revision: cached?.revision || null };
    }
  }
  const posture = offlinePosture(localPosture(config), cached?.posture);
  // Revocation and explicit scope rejection invalidate cached authority immediately.
  if (response.status !== 401 && response.status !== 403 && cached && Date.parse(cached.valid_until) > now) {
    return { available: true, blocked: false, source: 'cache', posture, revision: cached.revision };
  }
  return { available: false, blocked: posture.mode !== 'observe', source: 'unavailable', posture, revision: cached?.revision || null };
}
