import { verify } from 'node:crypto';
import { canonicalJson, sha256 } from '../runtime/protocol.mjs';
import { CONTROLLED_TRANSFER_PROFILE as PROFILE, COMPACT_TRANSFER_LEASE_PROFILE as COMPACT,
  TRANSFER_PASS_BUILDER_PROFILE, RECEIPT_PROFILE, digest, fail,
  identifier, issuerIdentity, record, snapshot } from './contract.mjs';

const leaseFields = ['profile', 'id', 'orgId', 'actorId', 'keyId', 'grantId', 'operationId',
  'grantEpoch', 'authorityEpoch', 'issuedAt', 'expiresAt', 'issuer', 'workflowDigest',
  'evidenceDigest', 'effectDigests', 'context'];
const compactLeaseFields = [...leaseFields, 'transferProfile', 'passBuilder', 'passCommitments'];
const receiptFields = ['profile', 'issuer', 'receiptId', 'orgId', 'actorId', 'grantId', 'operationId',
  'ordinal', 'actionId', 'actionFingerprint', 'preparationDigest', 'authorityEpoch', 'grantEpoch',
  'effect', 'effectDigest', 'committedAt', 'state', 'evidenceDigest'];
const effectIds = ['paymentId', 'sourceAccount', 'destination', 'asset', 'network'];
const epoch = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,37})$/.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0;
const approvalFingerprint = value => typeof value === 'string' && /^(?:apfp_)?[a-f0-9]{64}$/.test(value);

function exact(value, keys, code, optional = []) {
  if (!record(value) || keys.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !keys.includes(key) && !optional.includes(key))) fail(code);
}

function checkedEffect(effect, code) {
  exact(effect, ['operation', ...effectIds, 'amountMinor', 'decimals'], code);
  if (effect.operation !== 'transfer' || effectIds.some(field => !identifier(effect[field]))
    || typeof effect.amountMinor !== 'string' || !/^[1-9][0-9]{0,37}$/.test(effect.amountMinor)
    || !Number.isInteger(effect.decimals) || effect.decimals < 0 || effect.decimals > 18) fail(code);
  return effect;
}

// Finance's v1 domain separation; money stays a canonical integer string.
function effectDigest(effect, code) {
  return sha256(canonicalJson([PROFILE, 'effect', checkedEffect(effect, code)]));
}

function signedPayload(envelope, issuer, fields, code, optional = []) {
  exact(envelope, ['payload', 'signature'], code);
  exact(envelope.payload, fields, code, optional);
  if (!issuer || envelope.payload.issuer !== issuer.fingerprint
    || typeof envelope.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature)) fail(code);
  const bytes = Buffer.from(envelope.signature, 'base64url');
  if (bytes.length !== 64 || bytes.toString('base64url') !== envelope.signature) fail(code);
  let valid = false;
  try { valid = verify(null, Buffer.from(canonicalJson(envelope.payload)), issuer.key, bytes); } catch { /* Fail closed. */ }
  if (!valid) fail(code);
  return envelope.payload;
}

function verificationIssuer(envelope, issuer, config, historical) {
  if (!historical || envelope?.payload?.issuer === issuer?.fingerprint) return issuer;
  // Explicit caller configuration alone extends historical trust. A response's
  // embedded public key or advertised key list is never a trust root.
  return (config.trustedIssuerPublicKeys ?? []).map(pem => issuerIdentity(pem))
    .find(key => key.fingerprint === envelope?.payload?.issuer) ?? null;
}

function verifyGate(payload, source, code) {
  const lease = source?.lease.payload, compact = lease?.profile === COMPACT;
  if (!Object.hasOwn(payload, 'gate')) {
    if (compact) fail(code);
    return;
  }
  const gate = payload.gate;
  exact(gate, ['lane', 'admissionSequence', 'coreReceipt'], code);
  if (gate.lane !== 'slow-approved' || !epoch(gate.admissionSequence)) fail(code);
  exact(gate.coreReceipt, ['schema_version', 'pass_id', 'pass_hash', 'action_fingerprint',
    'lane', 'decision', 'reason', 'observed_at', 'sequence_number', 'receipt_hash'], code);
  const { receipt_hash: receiptHash, ...core } = gate.coreReceipt;
  const observedAt = Date.parse(core.observed_at);
  if (core.schema_version !== 'osuite.action_pass.receipt.v1' || !identifier(core.pass_id)
    || !digest(core.pass_hash) || !digest(core.action_fingerprint) || !digest(receiptHash)
    || receiptHash !== sha256(canonicalJson(core)) || core.lane !== 'slow' || core.decision !== 'review'
    || core.reason !== 'risk_exceeds_fast_lane' || core.sequence_number !== payload.ordinal
    || typeof core.observed_at !== 'string' || !time(observedAt)
    || new Date(observedAt).toISOString() !== core.observed_at || observedAt > payload.committedAt) fail(code);
  if (lease) {
    if (observedAt < lease.issuedAt) fail(code);
    if (compact) {
      const entry = lease.passCommitments?.[payload.ordinal];
      if (!entry || core.pass_id !== entry.passId || core.pass_hash !== entry.passHash
        || core.action_fingerprint !== entry.actionFingerprint) fail(code);
    } else {
      const pass = lease.passes?.[payload.ordinal];
      if (pass && (core.pass_id !== pass.pass_id || core.pass_hash !== pass.pass_hash
        || core.action_fingerprint !== pass.action_binding?.allowed_fingerprint)) fail(code);
    }
  }
}

function verifyCompactPayload(payload, count, code) {
  if (payload.transferProfile !== PROFILE || payload.passBuilder !== TRANSFER_PASS_BUILDER_PROFILE
    || ['orgId', 'actorId', 'keyId', 'grantId', 'operationId'].some(key =>
      !identifier(payload[key]) || !/^[A-Za-z0-9]/.test(payload[key]))
    || !Number.isFinite(new Date(payload.issuedAt).getTime()) || !Number.isFinite(new Date(payload.expiresAt).getTime())
    || payload.expiresAt - payload.issuedAt > 300000
    || payload.context.artifact_sha256 !== payload.workflowDigest
    || payload.context.dependencies_sha256 !== payload.evidenceDigest
    || !Array.isArray(payload.passCommitments) || payload.passCommitments.length !== count) fail(code);
  const hashes = new Set();
  for (const entry of payload.passCommitments) {
    exact(entry, ['passHash', 'passId', 'actionFingerprint'], code);
    if (!digest(entry.passHash) || !digest(entry.actionFingerprint)
      || typeof entry.passId !== 'string' || !/^ap_[a-f0-9]{24}$/.test(entry.passId)
      || hashes.has(entry.passHash)) fail(code);
    hashes.add(entry.passHash);
  }
}

export function verifyPreparation(input, { config, issuer, operationId, grantId, checkExpiry = true, historical = false }) {
  const code = 'INVALID_PREPARATION', value = snapshot(input, code);
  if (!record(value) || value.profile !== PROFILE || value.operationId !== operationId || value.grantId !== grantId
    || !identifier(operationId) || !identifier(grantId)
    || !['awaiting_approval', 'preparing', 'denied'].includes(value.state)
    || (value.code !== undefined && !identifier(value.code))
    || !digest(value.preparationDigest) || !Array.isArray(value.effects)
    || value.effects.length < 1 || value.effects.length > 64) fail(code);
  if (value.state !== 'preparing' ? !identifier(value.actionId) || !approvalFingerprint(value.fingerprint)
    : !((value.actionId === null && value.fingerprint === null) || (identifier(value.actionId) && approvalFingerprint(value.fingerprint)))) fail(code);
  const compact = value.lease?.payload?.profile === COMPACT;
  const payload = signedPayload(value.lease, verificationIssuer(value.lease, issuer, config, historical),
    compact ? compactLeaseFields : leaseFields, code, compact ? [] : ['passes']);
  if (payload.profile !== (compact ? COMPACT : PROFILE) || payload.orgId !== config.orgId || payload.actorId !== config.agentId
    || !identifier(payload.id) || !identifier(payload.keyId) || (config.keyId && payload.keyId !== config.keyId)
    || payload.operationId !== operationId || payload.grantId !== grantId
    || !epoch(payload.grantEpoch) || !epoch(payload.authorityEpoch)
    || !time(payload.issuedAt) || !time(payload.expiresAt) || payload.expiresAt <= payload.issuedAt
    || payload.issuedAt > Date.now() + 30000 || (checkExpiry && payload.expiresAt <= Date.now())
    || !digest(payload.workflowDigest) || !digest(payload.evidenceDigest)
    || !Array.isArray(payload.effectDigests) || payload.effectDigests.length !== value.effects.length
    || payload.effectDigests.some(item => !digest(item))
    || value.preparationDigest !== sha256(canonicalJson(payload))) fail(code);
  exact(payload.context, ['artifact_sha256', 'config_sha256', 'dependencies_sha256'], code);
  if (Object.values(payload.context).some(item => !digest(item))) fail(code);
  if (compact) verifyCompactPayload(payload, value.effects.length, code);
  // Passes are signed per-effect evidence, not a substitute for native Studio approval.
  if (Object.hasOwn(payload, 'passes') && (!Array.isArray(payload.passes)
    || payload.passes.length !== value.effects.length || payload.passes.some(pass => !record(pass)))) fail(code);
  const payments = new Set();
  for (const [ordinal, effect] of value.effects.entries()) {
    if (effectDigest(effect, code) !== payload.effectDigests[ordinal] || payments.has(effect.paymentId)) fail(code);
    payments.add(effect.paymentId);
  }
  return value;
}

function receiptPreparationBinding(payload, prepared, ordinal, original, code) {
  const lease = prepared.lease.payload;
  if (payload.grantId !== prepared.grantId || payload.effectDigest !== lease.effectDigests[ordinal]
    || canonicalJson(payload.effect) !== canonicalJson(prepared.effects[ordinal])) fail(code);
  if (original && (payload.issuer !== lease.issuer || payload.preparationDigest !== prepared.preparationDigest
    || payload.actionFingerprint !== prepared.fingerprint || payload.evidenceDigest !== lease.evidenceDigest
    || payload.authorityEpoch !== lease.authorityEpoch || payload.grantEpoch !== lease.grantEpoch
    || payload.committedAt < lease.issuedAt || payload.committedAt >= lease.expiresAt)) fail(code);
}

export function verifyReceipt(input, { issuer, config, prepared, sourcePrepared, ordinal, historical = false,
  operationId = prepared?.operationId, actionId = prepared?.actionId, paymentId = prepared?.effects[ordinal]?.paymentId }) {
  const code = 'INVALID_RECEIPT', value = snapshot(input, code);
  const payload = signedPayload(value, verificationIssuer(value, issuer, config, historical), receiptFields, code, ['gate']);
  if (payload.profile !== RECEIPT_PROFILE || payload.state !== 'committed'
    || payload.orgId !== config.orgId || payload.actorId !== config.agentId
    || ['receiptId', 'orgId', 'actorId', 'grantId', 'operationId', 'actionId'].some(key => !identifier(payload[key]))
    || !approvalFingerprint(payload.actionFingerprint)
    || ['preparationDigest', 'effectDigest', 'evidenceDigest'].some(key => !digest(payload[key]))
    || !epoch(payload.authorityEpoch) || !epoch(payload.grantEpoch)
    || !Number.isSafeInteger(payload.ordinal) || payload.ordinal < 0 || payload.ordinal > 63
    || !time(payload.committedAt) || payload.committedAt > Date.now() + 30000
    || payload.effectDigest !== effectDigest(payload.effect, code) || payload.effect.paymentId !== paymentId) fail(code);
  const earlierOperation = historical && payload.operationId !== operationId;
  let source = earlierOperation ? null : prepared;
  if (sourcePrepared != null) {
    try {
      source = verifyPreparation(sourcePrepared, { config, issuer, operationId: payload.operationId,
        grantId: payload.grantId, checkExpiry: false, historical });
    } catch { fail(code); }
    receiptPreparationBinding(payload, source, payload.ordinal, true, code);
    if (payload.actionId !== source.actionId) fail(code);
  }
  // An earlier operation's gate is bound only to its own known source, never to
  // the current operation's ordinal. No source means signature/effect checks only.
  verifyGate(payload, source, code);
  if (prepared) {
    receiptPreparationBinding(payload, prepared, ordinal, !earlierOperation, code);
  } else if (earlierOperation) {
    // A cold status read has no signed current lease to bind a historical payment.
    fail(code);
  }
  if (!earlierOperation && (payload.operationId !== operationId || payload.ordinal !== ordinal || payload.actionId !== actionId)) fail(code);
  return value;
}
