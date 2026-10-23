import { describe, expect, it } from 'vitest';
import { admitAction } from '../../sdk/runtime/admission.mjs';
import { RULE_ROLLOUT_CAPABILITY } from '../../sdk/runtime/protocol.mjs';
import { loadRuntimeConfig } from '../../sdk/runtime/config.mjs';

const transient = [
  ...[500, 502, 503, 504].map(status => ({ ok: false, status, error: 'http_error' })),
  ...['timeout', 'transport_failure'].map(error => ({ ok: false, status: 0, error })),
];
const rejected = [
  ...[301, 302, 307, 308, 400, 401, 403, 404, 408, 409, 413, 415, 422, 429, 431, 501, 505]
    .map(status => ({ ok: false, status, error: 'http_error' })),
  ...['signing_unavailable', 'invalid_request', 'invalid_response', 'unknown']
    .map(error => ({ ok: false, status: 0, error })),
  { ok: false, status: 503, error: 'invalid_response' },
  { ok: false, status: 0 },
];

async function probe(failure, config = {}) {
  const requests = [];
  const result = await admitAction({ agent_id: 'agent-test' }, {
    config: { mode: 'enforce', guardFailureMode: 'allow', ...config },
    api: { request: async (method, endpoint) => { requests.push({ method, endpoint }); return failure; } },
  });
  expect(requests).toEqual([{ method: 'POST', endpoint: '/api/guard' }]);
  expect(result.authorized).toBe(false);
  expect(result.retryAutomatically).toBe(false);
  return result;
}

describe('guard fault classification is an allowlist, not a denial bypass', () => {
  it.each(['claude', 'codex', 'cursor'])('defaults %s to blocking transient errors unless availability fallback is explicitly configured', host => {
    expect(loadRuntimeConfig({ host, env: {} }).guardFailureMode).toBe('block');
    expect(loadRuntimeConfig({ host, env: { OSUITE_GUARD_FAILURE_MODE: 'allow' } }).guardFailureMode).toBe('allow');
    expect(loadRuntimeConfig({ host, env: { OSUITE_HOOK_MODE: 'strict', OSUITE_GUARD_FAILURE_MODE: 'allow' } }).guardFailureMode).toBe('block');
  });
  it.each(rejected)('rejects %j even with explicitly permitted availability fallback', async fault => {
    expect(await probe(fault)).toMatchObject({ decision: 'block', reason: 'guard_rejected' });
  });

  it.each(transient)('retains explicit ungoverned availability fallback for %j', async fault => {
    expect(await probe(fault)).toMatchObject({ decision: 'allow', degraded: true, reason: 'guard_unavailable' });
  });

  for (const config of [
    { mode: 'strict', guardFailureMode: 'allow' },
    { guardFailureMode: 'block' },
    { ruleRolloutCapability: RULE_ROLLOUT_CAPABILITY },
    { ruleRollout: { enabled: true } },
  ]) {
    it.each(transient)(`never downgrades ${JSON.stringify(config)} on %j`, async fault => {
      expect(await probe(fault, config)).toMatchObject({ decision: 'block', reason: 'guard_unavailable' });
    });
  }
});
