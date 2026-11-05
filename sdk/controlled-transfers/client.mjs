import { canonicalJson, createApiClient, sha256 } from '../runtime/protocol.mjs';
import { CONTROLLED_TRANSFER_PROFILE as PROFILE, COMPACT_TRANSFER_LEASE_PROFILE as COMPACT,
  CONTROLLED_TRANSFER_MAX_ENVELOPE_BYTES, ENDPOINT, ControlledTransferError,
  configuration, fail, identifier, inspectCapabilities, issuerIdentity, prepareLeaseFormat, record, reviewFields, snapshot } from './contract.mjs';
import { verifyPreparation, verifyReceipt } from './verification.mjs';
import { normalizeProjection, snapshotWithProjection } from './projection.mjs';

const MAX_HOT_OPERATIONS = 16;
const MAX_OPERATION_RECORDS = 65536;
const bit = ordinal => 1n << BigInt(ordinal);
const preparationBinding = prepared => sha256(canonicalJson([
  prepared.grantId, prepared.preparationDigest, prepared.lease, prepared.effects,
]));

export function createControlledTransfers(options) {
  const config = configuration(options);
  const api = createApiClient(config, { timeoutMs: config.timeoutMs, maxResponseBytes: CONTROLLED_TRANSFER_MAX_ENVELOPE_BYTES });
  let issuer = config.issuerPublicKey ? issuerIdentity(config.issuerPublicKey) : null;
  const operations = new Map();
  const hot = new Map();

  function operationFor(operationId) {
    let operation = operations.get(operationId);
    if (!operation) {
      if (operations.size >= MAX_OPERATION_RECORDS) fail('CLIENT_CAPACITY_EXCEEDED', { operationId, reason: 'operation-record-limit' });
      operation = { operationId, acknowledged: 0n, receiptMask: 0n };
      operations.set(operationId, operation);
    }
    return operation;
  }

  const active = operation => operation.preparing || operation.recoveringPreparation || operation.executing || operation.reading;
  function keepHot(operation) {
    if (!hot.has(operation.operationId) && hot.size >= MAX_HOT_OPERATIONS) {
      const entry = [...hot].find(([, candidate]) => !active(candidate));
      if (!entry) fail('CLIENT_CAPACITY_EXCEEDED', { operationId: operation.operationId, reason: 'active-operation-limit' });
      const [id, previous] = entry;
      previous.prepared = null;
      previous.completed = null;
      hot.delete(id);
    }
    hot.delete(operation.operationId);
    hot.set(operation.operationId, operation);
  }

  function releaseIdle(operation) {
    if (active(operation)) return;
    if (!operation.prepared && !operation.completed?.size) hot.delete(operation.operationId);
    // Only a preflight that never observed or sent an operation may be forgotten.
    if (!operation.seen && !operation.unknown) {
      hot.delete(operation.operationId);
      operations.delete(operation.operationId);
    }
  }

  function checkBinding(operation, prepared, statusRead = false) {
    const code = statusRead ? 'INVALID_STATUS' : 'OPERATION_CONFLICT';
    if ((operation.grantId !== undefined && operation.grantId !== prepared.grantId)
      || (operation.effectCount !== undefined && operation.effectCount !== prepared.effects.length)) fail(code);
    if (!operation.binding) return;
    if (operation.binding !== preparationBinding(prepared)
      || ((!statusRead || operation.actionId) && (operation.actionId !== prepared.actionId || operation.fingerprint !== prepared.fingerprint))
      || (!statusRead && operation.preparationState !== prepared.state)) fail(code);
  }

  function rememberPreparation(operation, prepared, statusRead = false) {
    checkBinding(operation, prepared, statusRead);
    keepHot(operation);
    operation.grantId = prepared.grantId;
    operation.leaseFormat = prepared.lease.payload.profile;
    operation.binding = preparationBinding(prepared);
    operation.effectCount = prepared.effects.length;
    operation.actionId = prepared.actionId;
    operation.fingerprint = prepared.fingerprint;
    operation.preparationState = prepared.state;
    operation.prepared = prepared;
    operation.seen = true;
  }

  function receiptDigest(operation, ordinal) {
    return operation.receiptMask & bit(ordinal)
      ? operation.receiptDigests.toString('hex', ordinal * 32, (ordinal + 1) * 32) : null;
  }

  function checkReceipt(operation, ordinal, receipt, code) {
    const digest = sha256(canonicalJson(receipt)), previous = receiptDigest(operation, ordinal);
    if (previous && previous !== digest) fail(code);
    return digest;
  }

  function rememberReceipt(operation, ordinal, receipt, acknowledged = false) {
    const digest = checkReceipt(operation, ordinal, receipt, 'INVALID_RECEIPT');
    operation.receiptDigests ??= Buffer.alloc(operation.effectCount * 32);
    Buffer.from(digest, 'hex').copy(operation.receiptDigests, ordinal * 32);
    operation.receiptMask |= bit(ordinal);
    if (acknowledged) operation.acknowledged |= bit(ordinal);
  }

  function replayResult(operationId, prepared, receipt, projection) {
    return snapshotWithProjection({ profile: PROFILE, operationId, state: 'already_committed', receipt,
      projection, ...reviewFields(prepared, config.baseUrl), newlyCommitted: false });
  }

  async function recover(operation) {
    const observed = await status(operation.operationId);
    if (operation.unknown) throw operation.unknown;
    const prepared = observed.prepared ?? operation.prepared;
    if (!prepared) throw unknown(operation.operationId, 'MISSING_HISTORICAL_PREPARATION');
    return { observed, prepared };
  }

  async function capabilities() {
    const response = await api.request('GET', ENDPOINT);
    if (!response.ok) fail('CAPABILITY_UNAVAILABLE', { reason: response.error, httpStatus: response.status });
    const value = inspectCapabilities(response.body);
    if (value.issuerPublicKey) {
      const advertised = issuerIdentity(value.issuerPublicKey, 'INVALID_CAPABILITY');
      if (issuer && issuer.fingerprint !== advertised.fingerprint) fail('CAPABILITY_MISMATCH');
      issuer = advertised;
    }
    return value;
  }

  async function requireCapability() {
    const value = await capabilities();
    if (!value.configured || !value.resourceEnforced || !issuer) fail('PROFILE_UNAVAILABLE');
    return value;
  }

  function unknown(operationId, reason, httpStatus = null) {
    const error = new ControlledTransferError('OUTCOME_UNKNOWN', { operationId, reason, httpStatus });
    const operation = operationFor(operationId);
    operation.unknown = error;
    return error;
  }

  async function post(kind, operationId, fields) {
    if (operations.get(operationId)?.unknown) throw operations.get(operationId).unknown;
    const response = await api.request('POST', ENDPOINT, { profile: PROFILE, agent_id: config.agentId,
      kind, operationId, timestamp: Date.now(), ...fields });
    if (!response.ok) throw unknown(operationId, response.error, response.status);
    let body;
    try {
      body = kind === 'execute' ? snapshotWithProjection(response.body) : snapshot(response.body);
    } catch { throw unknown(operationId, 'INVALID_RESPONSE'); }
    if (body.profile !== PROFILE || body.operationId !== operationId) {
      throw unknown(operationId, 'RESPONSE_BINDING_MISMATCH');
    }
    return body;
  }

  function checkPrepareChoice(operation, grantId, leaseFormat) {
    if ((operation.grantId !== undefined && operation.grantId !== grantId)
      || (operation.preparingGrantId !== undefined && operation.preparingGrantId !== grantId)) fail('OPERATION_CONFLICT');
    if ((operation.leaseFormat !== undefined && operation.leaseFormat !== leaseFormat)
      || (operation.preparingFormat !== undefined && operation.preparingFormat !== leaseFormat)) fail('LEASE_FORMAT_CONFLICT');
  }

  function prepareOnce(operation, grantId, leaseFormat, work, recovery = false) {
    const slot = recovery ? 'recoveringPreparation' : 'preparing';
    operation.preparingGrantId = grantId;
    operation.preparingFormat = leaseFormat;
    operation[slot] = Promise.resolve().then(work).finally(() => {
      operation[slot] = null;
      operation.preparingGrantId = undefined;
      operation.preparingFormat = undefined;
      releaseIdle(operation);
    });
    return operation[slot];
  }

  async function prepare(operationId, grantId, options) {
    if (!identifier(operationId)) fail('INVALID_OPERATION_ID');
    if (!identifier(grantId)) fail('INVALID_GRANT_ID');
    const existing = operations.get(operationId);
    if (existing?.unknown) throw existing.unknown;
    const leaseFormat = prepareLeaseFormat(options);
    if (existing) {
      checkPrepareChoice(existing, grantId, leaseFormat);
      if (existing.prepared) { keepHot(existing); return existing.prepared; }
      if (existing.preparing || existing.recoveringPreparation) return existing.preparing ?? existing.recoveringPreparation;
      if (existing.executing) fail('EXECUTION_IN_PROGRESS');
      return prepareOnce(existing, grantId, leaseFormat, async () => {
        const { prepared } = await recover(existing);
        checkPrepareChoice(existing, grantId, leaseFormat);
        return prepared;
      }, true);
    }
    const operation = operationFor(operationId);
    operation.grantId = grantId;
    try { keepHot(operation); } catch (error) { releaseIdle(operation); throw error; }
    return prepareOnce(operation, grantId, leaseFormat, async () => {
      let capability;
      try { capability = await requireCapability(); } catch (error) {
        if (operation.unknown) throw operation.unknown;
        throw error;
      }
      if (operation.reading) await operation.reading;
      if (operation.unknown) throw operation.unknown;
      checkPrepareChoice(operation, grantId, leaseFormat);
      if (operation.prepared) return operation.prepared;
      if (operation.seen) throw unknown(operationId, 'MISSING_HISTORICAL_PREPARATION');
      if (leaseFormat === COMPACT) {
        if (!capability.leaseFormats.supported.includes(COMPACT)) fail('LEASE_FORMAT_UNSUPPORTED');
        if (!capability.leaseFormats.compactIssuanceEnabled) fail('COMPACT_LEASE_ISSUANCE_DISABLED');
      }
      operation.seen = true;
      const body = await post('prepare', operationId, { grantId, ...(leaseFormat === COMPACT ? { leaseFormat } : {}) });
      try {
        const verified = verifyPreparation(body, { config, issuer, operationId, grantId });
        if (verified.lease.payload.profile !== leaseFormat) fail('LEASE_FORMAT_CONFLICT');
        rememberPreparation(operation, snapshot({ ...verified, ...reviewFields(verified, config.baseUrl) }));
      }
      catch { throw unknown(operationId, 'INVALID_PREPARATION'); }
      return operation.prepared;
    });
  }

  async function execute(prepared, ordinal = 0) {
    prepared = snapshot(prepared, 'INVALID_PREPARATION');
    if (!record(prepared) || !identifier(prepared.operationId) || !identifier(prepared.grantId) || !record(prepared.lease)) fail('INVALID_PREPARATION');
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= prepared.effects?.length) fail('INVALID_ORDINAL');
    const operationId = prepared.operationId;
    let operation = operations.get(operationId);
    if (operation?.unknown) throw operation.unknown;
    if (operation && operation.grantId !== undefined && operation.grantId !== prepared.grantId) fail('OPERATION_CONFLICT');
    if (operation?.preparing && !operation.prepared) fail('PREPARATION_IN_PROGRESS');
    if (operation) checkBinding(operation, prepared);
    const previous = operation?.prepared ?? operation?.executing?.prepared;
    if (previous && ['grantId', 'preparationDigest', 'actionId', 'fingerprint', 'lease', 'effects', 'state']
      .some(field => canonicalJson(prepared[field]) !== canonicalJson(previous[field]))) fail('OPERATION_CONFLICT');
    if (!operation) {
      operation = operationFor(operationId);
      operation.grantId = prepared.grantId;
    }
    if (operation.completed?.has(ordinal)) {
      keepHot(operation);
      const completed = operation.completed.get(ordinal);
      return snapshotWithProjection({ ...completed, state: 'already_committed', newlyCommitted: false,
        projection: normalizeProjection(completed.projection, { cached: true }) });
    }
    if (operation.acknowledged & bit(ordinal)) {
      const recovered = await recover(operation);
      const effect = recovered.observed.effects[ordinal];
      if (!effect?.receiptVerified || receiptDigest(operation, ordinal) !== sha256(canonicalJson(effect.receipt))) {
        throw unknown(operationId, 'INVALID_HISTORICAL_RECEIPT');
      }
      return replayResult(operationId, recovered.prepared, effect.receipt, recovered.observed.projection);
    }
    if (operation.executing) {
      if (operation.executing.ordinal !== ordinal) fail('EXECUTION_IN_PROGRESS');
      return operation.executing.promise;
    }
    try { keepHot(operation); } catch (error) { releaseIdle(operation); throw error; }
    const pending = { ordinal, prepared };
    operation.executing = pending;
    pending.promise = (async () => {
      if (operation.reading) await operation.reading;
      if (operation.unknown) throw operation.unknown;
      const capability = await requireCapability();
      if (operation.unknown) throw operation.unknown;
      prepared = verifyPreparation(prepared, { config, issuer, operationId, grantId: prepared.grantId });
      checkBinding(operation, prepared);
      if (prepared.state === 'denied') fail('PREPARATION_DENIED');
      if (!prepared.actionId) fail('APPROVAL_NOT_BOUND');
      if (prepared.lease.payload.profile === COMPACT && !capability.leaseFormats.supported.includes(COMPACT)) {
        fail('LEASE_FORMAT_UNSUPPORTED');
      }
      // Reuse the immutable snapshot, rather than retaining another full copy per execution.
      prepared = operation.prepared ?? prepared;
      rememberPreparation(operation, prepared);
      pending.dispatched = true;
      const binding = capability.executionTransport === 'bound-reference-v1'
        ? { preparationDigest: prepared.preparationDigest } : { lease: prepared.lease };
      const body = await post('execute', operationId, { ...binding, ordinal });
      let result;
      if (body.state === 'denied' && identifier(body.code) && body.receipt == null) {
        result = snapshotWithProjection({ ...body, ...reviewFields(prepared, config.baseUrl), newlyCommitted: false });
      } else if (['committed', 'already_committed'].includes(body.state)) {
        let receipt;
        try { receipt = verifyReceipt(body.receipt, { issuer, config, prepared, ordinal, historical: body.state === 'already_committed',
          sourcePrepared: body.receipt?.payload?.operationId !== operationId
            ? operations.get(body.receipt?.payload?.operationId)?.prepared : undefined }); }
        catch { throw unknown(operationId, 'INVALID_RECEIPT'); }
        result = snapshotWithProjection({ ...body, receipt, ...reviewFields(prepared, config.baseUrl), newlyCommitted: body.state === 'committed' });
        rememberReceipt(operation, ordinal, receipt, true);
        operation.completed ??= new Map();
        operation.completed.set(ordinal, result);
      } else { throw unknown(operationId, 'INVALID_EXECUTION_RESPONSE'); }
      return result;
    })().catch(error => {
      if (operation.unknown) throw operation.unknown;
      if (pending.dispatched) throw unknown(operationId, 'INVALID_EXECUTION_RESPONSE');
      throw error;
    });
    try { return await pending.promise; }
    catch (error) { throw operation.unknown ?? error; }
    finally {
      operation.executing = null;
      releaseIdle(operation);
    }
  }

  function unknownStatus(operationId, reason, httpStatus = null, prepared, projection) {
    const error = unknown(operationId, reason, httpStatus);
    return snapshotWithProjection({ profile: PROFILE, operationId, state: 'unknown', code: error.code,
      reason, httpStatus, lastDenial: null, effects: [], newlyCommitted: false, projection,
      ...reviewFields(operations.get(operationId), config.baseUrl), recovery: error.recovery,
      ...(prepared ? { prepared } : {}) });
  }

  async function status(operationId) {
    if (!identifier(operationId)) fail('INVALID_OPERATION_ID');
    const operation = operationFor(operationId);
    if (operation.reading) return operation.reading;
    try { keepHot(operation); } catch (error) { releaseIdle(operation); throw error; }
    operation.reading = readStatus(operationId, operation);
    try { return await operation.reading; }
    finally { operation.reading = null; releaseIdle(operation); }
  }

  async function readStatus(operationId, operation) {
    const response = await api.request('GET', `${ENDPOINT}?operationId=${encodeURIComponent(operationId)}&agent_id=${encodeURIComponent(config.agentId)}`);
    if (!response.ok) return unknownStatus(operationId, response.error, response.status);
    try {
      const body = snapshotWithProjection(response.body, 'INVALID_STATUS');
      if (!record(body) || body.profile !== PROFILE || body.operationId !== operationId
        || !['committed', 'partially_committed', 'denied', 'awaiting_approval', 'ready', 'unknown'].includes(body.state)
        || !(body.actionId === null || identifier(body.actionId))
        || !(body.lastDenial === null || identifier(body.lastDenial))
        || !Array.isArray(body.effects) || body.effects.length > 64
        || (body.state === 'ready' && !body.actionId)) fail('INVALID_STATUS');
      const hasPrepared = Object.hasOwn(body, 'prepared');
      if (!issuer && (hasPrepared || body.effects.some(effect => effect?.state === 'committed'))) await capabilities();
      let prepared = operation?.prepared;
      if (!prepared && operation.binding && !hasPrepared) fail('INVALID_STATUS');
      if (hasPrepared) {
        const verified = verifyPreparation(body.prepared, { config, issuer, operationId,
          grantId: operation?.grantId ?? body.prepared?.grantId, checkExpiry: false, historical: true });
        checkBinding(operation, verified, true);
        const previous = prepared ?? operation?.executing?.prepared;
        if (previous && (['grantId', 'preparationDigest', 'lease', 'effects']
          .some(field => canonicalJson(verified[field]) !== canonicalJson(previous[field]))
          || (previous.actionId && (verified.actionId !== previous.actionId || verified.fingerprint !== previous.fingerprint)))) {
          fail('INVALID_STATUS');
        }
        prepared = snapshot({ ...verified, ...reviewFields(verified, config.baseUrl) });
      }
      if (prepared && body.actionId !== prepared.actionId) fail('INVALID_STATUS');
      if (body.state === 'unknown') return unknownStatus(operationId, 'OWNER_OUTCOME_UNKNOWN', null,
        hasPrepared ? prepared : undefined, body.projection);
      if (!body.effects.length || (prepared && body.effects.length !== prepared.effects.length)
        || (operation.effectCount !== undefined && body.effects.length !== operation.effectCount)) fail('INVALID_STATUS');
      let committed = 0;
      const payments = new Set();
      const effects = body.effects.map((effect, ordinal) => {
        if (!record(effect) || effect.ordinal !== ordinal || !identifier(effect.paymentId)
          || payments.has(effect.paymentId) || !['committed', 'not_committed'].includes(effect.state)
          || (prepared && effect.paymentId !== prepared.effects[ordinal].paymentId)) fail('INVALID_STATUS');
        payments.add(effect.paymentId);
        if (effect.state !== 'committed') {
          if (effect.receipt != null || receiptDigest(operation, ordinal)) fail('INVALID_STATUS');
          return { ...effect, receiptVerified: false };
        }
        const receipt = verifyReceipt(effect.receipt, { issuer, config, prepared, ordinal, historical: true,
          sourcePrepared: effect.receipt?.payload?.operationId !== operationId
            ? operations.get(effect.receipt?.payload?.operationId)?.prepared : undefined,
          operationId, actionId: body.actionId, paymentId: effect.paymentId });
        checkReceipt(operation, ordinal, receipt, 'INVALID_STATUS');
        committed++;
        return { ...effect, receipt, receiptVerified: true };
      });
      if ((body.state === 'committed' && committed !== effects.length)
        || (body.state === 'partially_committed' && (committed === 0 || committed === effects.length))
        || (['denied', 'awaiting_approval', 'ready'].includes(body.state) && committed !== 0)) fail('INVALID_STATUS');
      if (hasPrepared) {
        // Recover the original lease without replacing any physical-outcome uncertainty fence.
        rememberPreparation(operation, prepared, true);
      }
      operation.seen = true;
      operation.effectCount = effects.length;
      for (const effect of effects) if (effect.receiptVerified) {
        rememberReceipt(operation, effect.ordinal, effect.receipt);
        if (operation.acknowledged & bit(effect.ordinal)) {
          operation.completed ??= new Map();
          operation.completed.set(effect.ordinal, replayResult(operationId, prepared, effect.receipt, body.projection));
        }
      }
      return snapshotWithProjection({ ...body, effects, ...reviewFields(body, config.baseUrl), newlyCommitted: false,
        ...(hasPrepared ? { prepared } : {}) });
    } catch (error) { return unknownStatus(operationId, error.code ?? 'INVALID_STATUS'); }
  }

  return Object.freeze({ capabilities, prepare, execute, status });
}
