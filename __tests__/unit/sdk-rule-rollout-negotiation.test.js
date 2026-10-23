import { describe, expect, it, vi } from 'vitest';
import { loadRuntimeConfig } from '../../sdk/runtime/config.mjs';
import { createApiClient, sha256 } from '../../sdk/runtime/protocol.mjs';
import { resolveRemotePosture } from '../../sdk/runtime/posture.mjs';
import { admitAction } from '../../sdk/runtime/admission.mjs';

const capability = 'osuite.scoped_rule_rollout.v1';
const config = { runtimeId: 'codex_hooks', agentId: 'agent-negotiation', apiKey: 'synthetic-key',
  baseUrl: 'https://fixture.invalid', mode: 'observe', guardFailureMode: 'allow',
  signatureMode: 'workspace_key_optional', ruleRolloutCapability: capability };
const context = { agent_id: config.agentId, runtime_session_id: 'session-negotiation', action_type: 'read', tool_input_digest: 'a'.repeat(64) };
const scope = { org_id: 'org-negotiation', runtime_id: config.runtimeId, agent_id: config.agentId,
  provider: config.runtimeId, connection_id: 'connection-negotiation' };
function negotiationFixture(now = Date.now()) {
  const state = new Map();
  const store = { read: key => state.get(key), write: (key, value) => state.set(key, structuredClone(value)),
    update: (key, update) => { const value = update(state.get(key)); state.set(key, value); return value; } };
  const acknowledgement = { schema_version: 'osuite.rule_rollout_client.v1', capability, scope,
    device_binding: { credential_id: 'key-negotiation', connection_generation: 1, capability,
      enrollment_runtime: 'codex', public_key_fingerprint: 'a'.repeat(64) },
    acknowledged_at: new Date(now).toISOString(), expires_at: new Date(now + 900000).toISOString() };
  const document = { schema_version: 'osuite.runtime_posture.v1', runtime_id: config.runtimeId,
    org_id: scope.org_id, credential_id: 'key-negotiation', credential_fingerprint: sha256(config.apiKey),
    targeting: { agent_id: config.agentId, provider: null }, revision: sha256('scoped'),
    issued_at: new Date(now).toISOString(), valid_until: new Date(now + 60000).toISOString(),
    posture: { runtime_id: config.runtimeId, mode: 'strict', on_guard_unavailable: 'block', require_signature: true,
      require_assumption_capture: false, approval_timeout_seconds: 600 },
    rule_rollout: { schema_version: 'osuite.rule_rollout_negotiation.v1', capability, enabled: true,
      scope, credential_id: 'key-negotiation', connection_generation: 1, version: 2, strict_floor: true,
      expires_at: new Date(now + 3600000).toISOString() } };
  const api = { request: async method => ({ ok: true, status: 200, body: method === 'PUT' ? acknowledgement : document }) };
  return { now, state, store, acknowledgement, document, api };
}

describe('explicit SDK scoped rollout client negotiation', () => {
  it('advertises implemented capability only after explicit local opt-in, without changing legacy defaults', () => {
    expect(loadRuntimeConfig({ host: 'codex', env: {} }).ruleRolloutCapability).toBeUndefined();
    expect(loadRuntimeConfig({ host: 'codex', env: { OSUITE_SCOPED_RULE_ROLLOUT: '0' } }).ruleRolloutCapability).toBeUndefined();
    expect(loadRuntimeConfig({ host: 'codex', env: { OSUITE_SCOPED_RULE_ROLLOUT: '1' } }).ruleRolloutCapability).toBe(capability);
  });

  it('uses only the baseline GET for an unscoped manual key against an older server', async () => {
    const f = negotiationFixture();
    delete f.document.rule_rollout;
    f.document.posture = { ...f.document.posture, mode: 'observe', on_guard_unavailable: 'allow', require_signature: false };
    const baseline = loadRuntimeConfig({ host: 'codex', env: { OSUITE_AGENT_ID: config.agentId, OSUITE_API_KEY: config.apiKey,
      OSUITE_BASE_URL: config.baseUrl, OSUITE_HOOK_MODE: 'observe' } });
    const request = vi.fn(async () => ({ ok: true, status: 200, body: f.document }));
    expect(await resolveRemotePosture(baseline, { ...f, api: { request } })).toMatchObject({ available: true, blocked: false, posture: { mode: 'observe' } });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('GET');
  });

  it('does not turn a configured scope rejection into observe allow when opt-in is omitted', async () => {
    const f = negotiationFixture();
    expect(await resolveRemotePosture({ ...config, ruleRolloutCapability: undefined }, { ...f,
      api: { request: async () => ({ ok: false, status: 409, error: 'http_error' }) } })).toMatchObject({ available: false, blocked: true });
  });

  it('sends capability and the last verified epoch as constraints on every API call', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true }));
    const api = createApiClient({ ...config, ruleRollout: { enabled: true, version: 4 } }, { fetchImpl });
    await api.request('POST', '/api/guard', context);
    expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({
      'x-osuite-runtime-capability': capability, 'x-osuite-rule-rollout-version': '4',
    });
  });

  it('accepts the real scoped proof size but still caps capable-client responses at 1 MiB', async () => {
    const make = size => createApiClient(config, { fetchImpl: async () => Response.json({ evidence: 'a'.repeat(size) }) });
    expect(await make(300000).request('GET', '/api/actions/fixture')).toMatchObject({ ok: true });
    expect(await make(1048576).request('GET', '/api/actions/fixture')).toMatchObject({ ok: false, error: 'invalid_response' });
  });

  it('blocks an older server with no negotiation contract even on the first observe invocation', async () => {
    const now = Date.now(), state = new Map();
    const store = { read: key => state.get(key), update: (key, update) => {
      const value = update(state.get(key)); state.set(key, value); return value;
    } };
    const document = { schema_version: 'osuite.runtime_posture.v1', runtime_id: config.runtimeId,
      org_id: 'org-negotiation', credential_id: 'key-negotiation', credential_fingerprint: sha256(config.apiKey),
      targeting: { agent_id: config.agentId, provider: null }, revision: sha256('legacy'),
      issued_at: new Date(now).toISOString(), valid_until: new Date(now + 60000).toISOString(),
      posture: { runtime_id: config.runtimeId, mode: 'observe', on_guard_unavailable: 'allow',
        require_signature: false, require_assumption_capture: false, approval_timeout_seconds: 600 } };
    const result = await resolveRemotePosture(config, { store, now,
      api: { request: async () => ({ ok: true, status: 200, body: document }) } });
    expect(result).toMatchObject({ available: false, blocked: true });
  });

  it('requires scoped binding even when every guard marker has been omitted', async () => {
    const request = vi.fn(async (_method, endpoint) => ({ ok: true, status: 200,
      body: endpoint === '/api/guard' ? { decision: 'allow' } : {
        action_id: 'act-negotiation', action: { action_id: 'act-negotiation', status: 'running' }, decision: { decision: 'allow' },
      } }));
    const result = await admitAction(context, { api: { request }, config: { ...config,
      ruleRollout: { enabled: true, version: 1, scope: { org_id: 'org-negotiation', runtime_id: config.runtimeId,
        agent_id: config.agentId, provider: config.runtimeId, connection_id: 'connection-negotiation' } } } });
    expect(result).toMatchObject({ authorized: false, decision: 'block' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('never uses availability allow while a capable client could have a newly enabled floor', async () => {
    const result = await admitAction(context, { config,
      api: { request: async () => ({ ok: false, status: 503, error: 'http_error' }) } });
    expect(result).toMatchObject({ authorized: false, decision: 'block' });
  });

  it.each(['disabled scope', 'older epoch'])('never replaces a previously verified scoped floor with %s', async kind => {
    const f = negotiationFixture();
    expect(await resolveRemotePosture(config, f)).toMatchObject({ available: true, blocked: false });
    f.document.issued_at = new Date(f.now + 1000).toISOString();
    f.document.rule_rollout = kind === 'disabled scope'
      ? { schema_version: 'osuite.rule_rollout_negotiation.v1', capability, enabled: false }
      : { ...f.document.rule_rollout, version: 1 };
    expect(await resolveRemotePosture(config, f)).toMatchObject({ available: false, blocked: true });
    expect(f.state.get('posture').document.rule_rollout).toMatchObject({ enabled: true, version: 2 });
  });

  it.each(['missing binding', 'unknown expiry', 'wrong current key'])('rejects %s in capability negotiation', async kind => {
    const f = negotiationFixture();
    if (kind === 'missing binding') delete f.acknowledgement.device_binding;
    else if (kind === 'unknown expiry') f.acknowledgement.expires_at = 'unknown';
    else f.acknowledgement.device_binding.credential_id = 'another-key';
    expect(await resolveRemotePosture(config, f)).toMatchObject({ available: false, blocked: true });
    expect(f.state.get('posture')).toMatchObject({ document: null, rejected: true });
    expect(f.state.get('posture-rejection')).toMatchObject({ schema: 'osuite.posture-rejection.v1' });
  });

  it('capability PUT rejection fences a previously cached configuration across subsequent calls', async () => {
    const f = negotiationFixture();
    expect(await resolveRemotePosture(config, f)).toMatchObject({ available: true });
    expect(await resolveRemotePosture(config, { ...f, api: { request: async () => ({ ok: false, status: 401, error: 'http_error' }) } }))
      .toMatchObject({ available: false, blocked: true });
    expect(await resolveRemotePosture({ ...config, ruleRolloutCapability: undefined }, {
      ...f, api: { request: async () => ({ ok: false, status: 0, error: 'timeout' }) },
    })).toMatchObject({ available: false, blocked: true });
    expect(await resolveRemotePosture(config, f)).toMatchObject({ available: true, source: 'remote' });
  });
});
