import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalJson, createApiClient } from '../runtime/protocol.mjs';
import { resolveRemotePosture } from '../runtime/posture.mjs';
import { createStateStore } from '../runtime/state.mjs';
import { admitAction, actionAdmission, cavaFingerprint } from '../runtime/admission.mjs';
import { matchesStoredAction, reject } from './contract.mjs';

export function createStudioAuthority(config, journalPath) {
  const responseLimits = { maxResponseBytes: 1048576 };
  const baseApi = createApiClient(config, responseLimits);
  const store = createStateStore({ ...config, stateDir: path.join(path.dirname(journalPath), 'posture') });

  async function current(aborted) {
    let remote;
    const deadline = performance.now() + 2000;
    for (let attempt = 0; attempt < 6; attempt++) {
      if (aborted()) reject('ABORTED');
      let readStatus = null;
      remote = await resolveRemotePosture(config, { store, api: { async request(method, endpoint, ...args) {
        const response = await baseApi.request(method, endpoint, ...args);
        if (method === 'GET') readStatus = response.status;
        return response;
      } } });
      if (remote.source === 'remote' || readStatus !== 200 || attempt === 5 || performance.now() >= deadline) break;
      // A concurrent cache writer can supersede a valid response or hold its
      // short lock. Reread current configuration, never replay an action POST.
      await delay(10 * (attempt + 1));
    }
    const pinned = config.ruleRollout, actual = remote.ruleRollout;
    const preservesConfiguredFloor = !pinned?.enabled || (actual?.enabled === true
      && canonicalJson(actual.scope) === canonicalJson(pinned.scope)
      && actual.credential_id === pinned.credential_id
      && actual.connection_generation >= pinned.connection_generation && actual.version >= pinned.version
      && (actual.version !== pinned.version || canonicalJson(actual) === canonicalJson(pinned)));
    if (!remote.available || remote.blocked || remote.source !== 'remote'
        || !preservesConfiguredFloor
        || !['enforce', 'strict'].includes(remote.posture.mode)
        || remote.posture.require_assumption_capture !== false
        || remote.posture.require_signature !== true || remote.posture.on_guard_unavailable !== 'block') {
      reject('CURRENT_AUTHORITY_UNAVAILABLE');
    }
    const effective = { ...config, mode: remote.posture.mode, guardFailureMode: 'block', signatureMode: 'required',
      approvalWaitMs: 0, ruleRollout: remote.ruleRollout };
    return { api: createApiClient(effective, responseLimits), effective };
  }

  async function read(record) {
    const response = await baseApi.request('GET', `/api/actions/${encodeURIComponent(record.actionId)}`);
    if (!response.ok) return { available: false, status: response.status };
    if (!matchesStoredAction(response.body, record, config)) return { available: false, status: response.status, mismatch: true };
    return { available: true, body: response.body, action: response.body.action || response.body };
  }

  async function admit(invocation, journal, owner, aborted) {
    const record = journal.get(invocation.record.scope, invocation.record.operationId);
    const phase = record.state === 'held' ? 'redeeming' : 'requesting';
    const { api, effective } = await current(aborted);
    if (aborted()) reject('ABORTED');
    const session = await api.request('POST', '/api/runtime-sessions', {
      runtime_session_id: record.sessionId, agent_id: config.agentId, runtime_adapter_id: config.runtimeId,
      runtime_family: 'sdk_tool_runtime', adapter_mode: 'sdk_wrapper', client_name: 'osuite/governed-tools',
      governance_posture: effective.mode, signature_mode: 'required', status: 'active',
    });
    const actualSession = session.body?.session || session.body?.runtime_session;
    if (!session.ok || actualSession?.runtime_session_id !== record.sessionId
        || actualSession?.org_id !== config.orgId || actualSession?.agent_id !== config.agentId
        || actualSession?.runtime_adapter_id !== config.runtimeId) reject('CURRENT_AUTHORITY_UNAVAILABLE');
    let claimed = false, receivedAt = null;
    const claim = () => {
      if (claimed) reject('OUTCOME_UNKNOWN');
      if (aborted()) reject('ABORTED');
      if (!journal.claim(record.scope, record.operationId, [record.state], phase, owner)) reject('OPERATION_BUSY');
      claimed = true;
    };
    const settle = (state, patch = {}) => journal.settle(record.scope, record.operationId, owner, phase, state, patch);
    try {
      const result = await admitAction(invocation.context, {
        config: effective,
        api: { async request(method, endpoint, body, options) {
          if (aborted()) reject('ABORTED');
          if (method === 'POST' && endpoint === '/api/actions') claim();
          const response = await api.request(method, endpoint, body, options);
          if (method === 'POST' && endpoint === '/api/actions') {
            receivedAt = performance.now();
            if (!response.ok || !matchesStoredAction(response.body, record, config)
                || !cavaFingerprint(response.body)) {
              settle(phase === 'redeeming' ? 'uncertain_redemption' : 'uncertain_request');
              reject('OUTCOME_UNKNOWN');
            }
          }
          return response;
        } },
        beforeRelease: async payload => {
          if (aborted() || !matchesStoredAction(payload, record, config)) return false;
          // A held operation must redeem its original one-use grant, even when
          // a current guard decision has become less restrictive meanwhile.
          return phase !== 'redeeming' || (Boolean(record.fingerprint) && actionAdmission(payload, 'require_approval', invocation.context,
            { actionId: record.actionId, fingerprint: record.fingerprint }).authorized);
        },
      });
      if (result.authorized) return { phase, receivedAt, response: result.response };
      if (result.reason === 'policy_block') {
        if (!claimed) claim();
        settle('denied'); reject('POLICY_DENIED');
      }
      if (result.decision === 'require_approval' && result.response?.action?.status === 'pending_approval') {
        if (!settle('held', { fingerprint: cavaFingerprint(result.response) })) reject('OUTCOME_UNKNOWN');
        return null;
      }
      if (claimed) settle(phase === 'redeeming' ? 'uncertain_redemption' : 'uncertain_request');
      reject(claimed ? 'OUTCOME_UNKNOWN' : 'CURRENT_AUTHORITY_UNAVAILABLE');
    } catch (error) {
      if (claimed) settle(phase === 'redeeming' ? 'uncertain_redemption' : 'uncertain_request');
      if (!claimed && error?.name === 'OperationJournalError' && error.code === 'JOURNAL_BUSY') reject('JOURNAL_BUSY');
      throw error;
    }
  }

  async function report(record, state, resultDigest) {
    const response = await baseApi.request('PATCH', `/api/actions/${encodeURIComponent(record.actionId)}`, {
      status: state === 'completed' ? 'completed' : 'failed',
      timestamp_end: new Date().toISOString(),
      output_summary: JSON.stringify({ schema_version: 'osuite.native_tool_observation.v1',
        observation: state === 'completed' ? 'native_return' : 'outcome_unknown',
        result_digest: resultDigest, result_retained: false, independent_resource_verification: false }),
      ...(state === 'uncertain' ? { error_message: 'Native call outcome is uncertain; no automatic resend.' } : {}),
    });
    return response.ok && matchesStoredAction(response.body, record, config)
      && response.body.action?.status === (state === 'completed' ? 'completed' : 'failed')
      && typeof response.body.action?.timestamp_end === 'string';
  }

  return { admit, read, report };
}
