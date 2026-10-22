import { createPrivateKey, randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalJson, safeId, sha256, validatedBaseUrl } from '../runtime/protocol.mjs';
import { cavaFingerprint } from '../runtime/admission.mjs';
import { OperationJournal } from './journal.mjs';
import { createStudioAuthority } from './authority.mjs';
import { GovernedToolError, jsonSnapshot, makeInvocation, publicStatus, reject, scopeFor } from './contract.mjs';

const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
function runOptions(options) {
  if (!options || typeof options !== 'object' || types.isProxy(options)) reject('INVALID_OPTIONS');
  const descriptors = Object.getOwnPropertyDescriptors(options);
  if (Reflect.ownKeys(descriptors).some(key => !['waitMs', 'signal'].includes(key)
      || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)) reject('INVALID_OPTIONS');
  const waitMs = descriptors.waitMs?.value ?? 0, signal = descriptors.signal?.value;
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 600000) reject('INVALID_OPTIONS');
  const aborted = () => {
    if (signal === undefined) return false;
    try { return Reflect.apply(signalAborted, signal, []); } catch { reject('INVALID_OPTIONS'); }
  };
  aborted();
  return { waitMs, signal, aborted };
}

function checkedConfig(input) {
  let config;
  try { config = jsonSnapshot(input, 32768); } catch { reject('INVALID_CONFIGURATION'); }
  if (!['enforce', 'strict'].includes(config?.mode) || config.signatureMode !== 'required'
      || config.guardFailureMode !== 'block' || typeof config.apiKey !== 'string' || !config.apiKey
      || typeof config.privateKeyBase64 !== 'string' || !config.privateKeyBase64
      || config.allowInsecureHttp || !validatedBaseUrl(config.baseUrl)) reject('INVALID_CONFIGURATION');
  try { if (createPrivateKey(Buffer.from(config.privateKeyBase64, 'base64')).asymmetricKeyType !== 'rsa') throw new Error(); }
  catch { reject('INVALID_CONFIGURATION'); }
  return Object.freeze({ ...config, baseUrl: validatedBaseUrl(config.baseUrl), approvalWaitMs: 0 });
}

function registrySnapshot(bindings) {
  if (!bindings || types.isProxy(bindings) || typeof bindings !== 'object') reject('INVALID_MAPPING');
  const result = {};
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(bindings))) {
    if (!Object.hasOwn(descriptor, 'value') || !safeId(name) || name.length > 128) reject('INVALID_MAPPING');
    const binding = descriptor.value;
    if (!binding || types.isProxy(binding) || typeof binding !== 'object') reject('INVALID_MAPPING');
    const fields = Object.getOwnPropertyDescriptors(binding);
    if (!Object.hasOwn(fields.revision || {}, 'value') || !Object.hasOwn(fields.describe || {}, 'value')
        || !safeId(fields.revision.value) || fields.revision.value.length > 128
        || typeof fields.describe.value !== 'function' || types.isProxy(fields.describe.value)) reject('INVALID_MAPPING');
    Object.defineProperty(result, name, { value: Object.freeze({ revision: fields.revision.value, describe: fields.describe.value }), enumerable: true });
  }
  return Object.freeze(result);
}

function publicError(error) {
  if (error instanceof GovernedToolError) throw error;
  if (error?.name === 'OperationJournalError' && /^(CONFLICT|JOURNAL_[A-Z_]+)$/.test(error.code)) reject(error.code);
  reject('OUTCOME_UNKNOWN');
}

export function createGovernedTools({ config: rawConfig, namespace, journalPath, bindings: rawBindings,
  journalOptions = {}, initializeJournal = false } = {}) {
  if (Number(process.versions.node.split('.')[0]) !== 24) reject('NODE_24_REQUIRED');
  const config = checkedConfig(rawConfig), scope = scopeFor(config, namespace), bindings = registrySnapshot(rawBindings);
  const storage = jsonSnapshot(journalOptions);
  if (typeof initializeJournal !== 'boolean' || !storage || Array.isArray(storage) || typeof storage !== 'object'
      || Object.keys(storage).some(key => !['maxOperations', 'busyTimeoutMs'].includes(key))) reject('INVALID_CONFIGURATION');
  let journal;
  try { journal = new OperationJournal(journalPath, { ...storage, create: initializeJournal }); } catch (error) { publicError(error); }
  let authority;
  try { authority = createStudioAuthority(config, journalPath); } catch { journal.close(); reject('JOURNAL_UNAVAILABLE'); }
  let closed = false, inFlight = 0;
  const local = operationId => journal.get(scope, operationId);
  const status = record => publicStatus(record, config.baseUrl);
  function stopForState(record) {
    const codes = { completed: 'ALREADY_COMPLETED', denied: 'POLICY_DENIED', expired: 'APPROVAL_EXPIRED', cancelled: 'CANCELLED' };
    if (codes[record.state]) reject(codes[record.state], status(record));
    if (!['prepared', 'held', 'requesting', 'uncertain_request'].includes(record.state)) reject('OUTCOME_UNKNOWN', status(record));
  }
  function transitionHeld(record, next, owner) {
    if (!journal.claim(scope, record.operationId, ['held'], 'redeeming', owner)
        || !journal.settle(scope, record.operationId, owner, 'redeeming', next)) reject('OPERATION_BUSY', status(local(record.operationId)));
  }

  return Object.freeze({
    async run(operationId, params, execute, options = {}) {
      if (closed) reject('CLOSED');
      inFlight++;
      try {
      const invocation = makeInvocation({ config, namespace, bindings, operationId, params });
      if (typeof execute !== 'function' || types.isProxy(execute)) reject('INVALID_EXECUTOR');
      const { waitMs, signal, aborted } = runOptions(options);
      if (aborted()) reject('ABORTED');
      const started = performance.now(), deadline = started + waitMs, owner = randomUUID();
      let record = journal.prepare(invocation.record);
      const waiting = () => reject('AWAITING_APPROVAL', { ...status(local(operationId)), elapsedMs: Math.round(performance.now() - started) });
      while (true) {
        record = local(operationId); stopForState(record);
        if (closed) reject('CLOSED');
        if (aborted()) reject('ABORTED', status(record));
        if (record.state !== 'prepared') {
          const observed = await authority.read(record);
          if (!observed.available) reject(record.state !== 'held' ? 'OUTCOME_UNKNOWN'
            : observed.mismatch ? 'BINDING_MISMATCH' : 'CURRENT_AUTHORITY_UNAVAILABLE', status(record));
          const action = observed.action;
          if (['requesting', 'uncertain_request'].includes(record.state)) {
            if (action.status !== 'pending_approval' || action.approval_redeemed_at != null || action.timestamp_end != null) reject('OUTCOME_UNKNOWN', status(record));
            const fingerprint = cavaFingerprint(observed.body);
            if (!fingerprint) reject('OUTCOME_UNKNOWN', status(record));
            if (!journal.recoverHeld(scope, operationId, fingerprint)) reject('OPERATION_BUSY', status(local(operationId)));
            record = local(operationId);
          }
          if (!record.fingerprint || record.fingerprint !== cavaFingerprint(observed.body)) reject('BINDING_MISMATCH', status(record));
          if (action.status === 'pending_approval') {
            if (performance.now() >= deadline) waiting();
            try { await delay(Math.min(200, deadline - performance.now()), undefined, { signal }); }
            catch { reject('ABORTED', status(record)); }
            continue;
          }
          if (['blocked', 'denied', 'expired', 'cancelled'].includes(action.status)
              || ['denied', 'expired', 'cancelled'].includes(observed.body.approval?.state)) {
            const state = action.status === 'expired' || observed.body.approval?.state === 'expired' ? 'expired'
              : action.status === 'cancelled' ? 'cancelled' : 'denied';
            transitionHeld(record, state, owner); stopForState(local(operationId));
          }
          if (action.status !== 'running' || action.timestamp_end != null || action.approval_redeemed_at != null
              || !action.approved_by || !action.approved_at) reject('OUTCOME_UNKNOWN', status(record));
        }
        let admitted;
        try { admitted = await authority.admit(invocation, journal, owner, aborted); }
        catch (error) {
          if (error instanceof GovernedToolError) throw new GovernedToolError(error.code, status(local(operationId)));
          reject('OUTCOME_UNKNOWN', status(local(operationId)));
        }
        if (!admitted) { if (performance.now() >= deadline) waiting(); continue; }
        // No await or user observer between this last check, the durable fence,
        // and invoking the original tool. This is not resource-side atomicity.
        if (aborted() || closed || performance.now() - admitted.receivedAt > 5000) {
          journal.settle(scope, operationId, owner, admitted.phase,
            admitted.phase === 'redeeming' ? 'uncertain_redemption' : 'uncertain_request');
          reject(aborted() ? 'ABORTED' : 'OUTCOME_UNKNOWN', status(local(operationId)));
        }
        if (!journal.settle(scope, operationId, owner, admitted.phase, 'dispatching')) reject('OPERATION_BUSY', status(local(operationId)));
        let result, resultDigest = null, state = 'completed', thrown = false;
        try { result = await execute(invocation.params); }
        catch { thrown = true; state = 'uncertain'; }
        if (!thrown) {
          if (result !== null && typeof result === 'object') {
            if (types.isProxy(result)) state = 'uncertain';
            else {
              const errorFlag = Object.getOwnPropertyDescriptor(result, 'isError');
              if (errorFlag && (!Object.hasOwn(errorFlag, 'value') || errorFlag.value !== false)) state = 'uncertain';
            }
          }
          try {
            const value = jsonSnapshot(result);
            resultDigest = sha256(canonicalJson(value));
            if (value?.isError === true) state = 'uncertain';
          } catch { /* Opaque native returns are not serialized or independently verified. */ }
        }
        if (!journal.settle(scope, operationId, owner, 'dispatching', state, { resultDigest, reportState: 'uncertain' })) reject('OUTCOME_UNKNOWN', status(local(operationId)));
        let confirmed = false;
        try { confirmed = await authority.report(local(operationId), state, resultDigest); } catch { /* Keep the observed native outcome. */ }
        try { if (confirmed) journal.settle(scope, operationId, owner, state, state, { reportState: 'confirmed' }); }
        catch { /* Reporting bookkeeping cannot hide a durably observed native return. */ }
        if (thrown) reject('OUTCOME_UNKNOWN', status(local(operationId)));
        return result;
      }
      } catch (error) { publicError(error); }
      finally {
        inFlight--;
        if (closed && inFlight === 0) journal.close();
      }
    },
    async status(operationId) {
      if (closed) reject('CLOSED');
      if (!safeId(operationId) || operationId.length > 128) reject('INVALID_OPERATION_ID');
      const record = local(operationId);
      if (!record) return null;
      const observed = await authority.read(record);
      return Object.freeze({ ...status(record), remote: Object.freeze({ available: observed.available,
        status: observed.available ? observed.action.status : null, bindingMismatch: observed.mismatch === true }) });
    },
    close() { if (!closed) { closed = true; if (inFlight === 0) journal.close(); } },
  });
}
