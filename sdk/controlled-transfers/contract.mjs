import { createPrivateKey, createPublicKey } from 'node:crypto';
import { types } from 'node:util';
import { canonicalJson, sha256, validatedBaseUrl } from '../runtime/protocol.mjs';

export const CONTROLLED_TRANSFER_PROFILE = 'matoi.controlled-transfer.v1';
export const COMPACT_TRANSFER_LEASE_PROFILE = 'matoi.controlled-transfer.lease.v2';
export const TRANSFER_PASS_BUILDER_PROFILE = 'matoi.controlled-transfer.pass.v1';
export const CONTROLLED_TRANSFER_MAX_ENVELOPE_BYTES = 1024 * 1024;
export const RECEIPT_PROFILE = 'matoi.controlled-transfer.receipt.v1';
export const ENDPOINT = '/api/matoi/transfers';
export const QUALIFICATIONS = Object.freeze(['not-qualified', 'integrated-tested', 'deployment-qualified']);
const MAX_SNAPSHOT_NODES = 65536;
const reserved = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype', 'toJSON']);
const wellFormed = value => !/[\uD800-\uDFFF]/u.test(value);
export const identifier = value => typeof value === 'string'
  && /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(value) && !reserved.has(value);
export const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const record = value => value !== null && typeof value === 'object' && !types.isProxy(value)
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export class ControlledTransferError extends Error {
  constructor(code, details = {}) {
    const unknown = code === 'OUTCOME_UNKNOWN';
    super(`Matoi ${code}${unknown ? ': execution is not disproved; read status for the same operation, do not resend.' : ''}`);
    this.name = 'ControlledTransferError';
    this.code = code;
    this.operationId = details.operationId ?? null;
    this.reason = details.reason ?? null;
    this.httpStatus = details.httpStatus ?? null;
    this.retryAutomatically = false;
    this.recovery = Object.freeze({ method: unknown ? 'status' : null,
      operationId: this.operationId, preserveOperationId: true,
      message: unknown ? 'Read status only. A missing result is not proof of non-execution. Do not resend or replace the operation ID.'
        : 'Inspect configuration or current authority. No automatic retry is permitted.' });
  }
}
export function fail(code, details) { throw new ControlledTransferError(code, details); }

// Snapshot descriptors, rather than invoke caller accessors or toJSON methods.
export function snapshot(input, code = 'INVALID_RESPONSE') {
  const ancestors = new Set();
  let nodes = 0;
  function copy(value, depth) {
    if (++nodes > MAX_SNAPSHOT_NODES || depth > 24) fail(code);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string' && value.length <= CONTROLLED_TRANSFER_MAX_ENVELOPE_BYTES && wellFormed(value)) return value;
    if (Number.isSafeInteger(value) && !Object.is(value, -0)) return value;
    if (!value || typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) fail(code);
    const array = Array.isArray(value);
    if (array ? Object.getPrototypeOf(value) !== Array.prototype : !record(value)) fail(code);
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== 'string' || reserved.has(key)
      || !wellFormed(key) || !Object.hasOwn(descriptors[key], 'value')
      || (!descriptors[key].enumerable && !(array && key === 'length')))) fail(code);
    if (array && (value.length > MAX_SNAPSHOT_NODES || keys.length !== value.length + 1
      || keys.some(key => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)))) fail(code);
    ancestors.add(value);
    const result = array ? [] : {};
    for (const key of keys) if (!(array && key === 'length')) result[key] = copy(descriptors[key].value, depth + 1);
    ancestors.delete(value);
    return Object.freeze(result);
  }
  const result = copy(input, 0);
  if (Buffer.byteLength(canonicalJson(result)) > CONTROLLED_TRANSFER_MAX_ENVELOPE_BYTES) fail(code);
  return result;
}

export function issuerIdentity(pem, code = 'INVALID_CONFIGURATION') {
  try {
    if (typeof pem !== 'string' || pem.length > 2048) throw new Error();
    const match = /^-----BEGIN PUBLIC KEY-----\n([A-Za-z0-9+/=\n]+)\n-----END PUBLIC KEY-----$/.exec(pem.replace(/\r\n/g, '\n').trim());
    if (!match) throw new Error();
    const encoded = match[1].replace(/\n/g, ''), der = Buffer.from(encoded, 'base64');
    if (der.toString('base64') !== encoded) throw new Error();
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519' || !key.export({ type: 'spki', format: 'der' }).equals(der)) throw new Error();
    return Object.freeze({ key, fingerprint: sha256(key.export({ type: 'spki', format: 'der' })) });
  } catch { fail(code); }
}

function plainOptions(value) {
  return record(value) && Reflect.ownKeys(value).every(key => typeof key === 'string'
    && !reserved.has(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}

export function configuration(options) {
  if (Number(process.versions.node.split('.')[0]) !== 24) fail('NODE_24_REQUIRED');
  if (!plainOptions(options) || Object.keys(options).some(key => key !== 'config') || !plainOptions(options.config)) {
    fail('INVALID_CONFIGURATION');
  }
  const input = options.config, baseUrl = validatedBaseUrl(input.baseUrl);
  const timeoutMs = input.timeoutMs ?? 2500;
  if (!baseUrl || typeof input.apiKey !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(input.apiKey)
    || !identifier(input.orgId) || !identifier(input.agentId)
    || (input.keyId !== undefined && !identifier(input.keyId))
    || input.signatureMode !== 'required' || input.guardFailureMode !== 'block'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
    || typeof input.privateKeyBase64 !== 'string' || input.privateKeyBase64.length > 32768
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.privateKeyBase64)) fail('INVALID_CONFIGURATION');
  try {
    const key = createPrivateKey(Buffer.from(input.privateKeyBase64, 'base64'));
    if (key.asymmetricKeyType !== 'rsa') throw new Error();
  } catch { fail('INVALID_CONFIGURATION'); }
  if (input.issuerPublicKey != null) issuerIdentity(input.issuerPublicKey);
  const trustedIssuerPublicKeys = snapshot(input.trustedIssuerPublicKeys ?? [], 'INVALID_CONFIGURATION');
  if (!Array.isArray(trustedIssuerPublicKeys) || trustedIssuerPublicKeys.length > 8) fail('INVALID_CONFIGURATION');
  const roots = trustedIssuerPublicKeys.map(pem => issuerIdentity(pem).fingerprint);
  if (new Set(roots).size !== roots.length) fail('INVALID_CONFIGURATION');
  return Object.freeze({ baseUrl, apiKey: input.apiKey, orgId: input.orgId, agentId: input.agentId,
    keyId: input.keyId, privateKeyBase64: input.privateKeyBase64, signatureMode: 'required',
    guardFailureMode: 'block', timeoutMs, issuerPublicKey: input.issuerPublicKey ?? null, trustedIssuerPublicKeys });
}

export function inspectCapabilities(input) {
  const value = snapshot(input, 'INVALID_CAPABILITY');
  if (!record(value) || value.profile !== CONTROLLED_TRANSFER_PROFILE || value.scope !== 'controlled-ledger') {
    fail('CAPABILITY_MISMATCH');
  }
  if (value.installed !== true || typeof value.configured !== 'boolean' || typeof value.resourceEnforced !== 'boolean'
    || !record(value.qualification) || !QUALIFICATIONS.includes(value.qualification.status)
    || !(value.issuerPublicKey === null || typeof value.issuerPublicKey === 'string')
    || (value.configured && !value.issuerPublicKey)) fail('INVALID_CAPABILITY');
  if (value.issuerPublicKey !== null) issuerIdentity(value.issuerPublicKey, 'INVALID_CAPABILITY');
  if (value.executionTransport !== undefined && value.executionTransport !== 'bound-reference-v1') fail('INVALID_CAPABILITY');
  if (!Object.hasOwn(value, 'leaseFormats')) {
    return Object.freeze({ ...value, leaseFormats: Object.freeze({ supported: Object.freeze([CONTROLLED_TRANSFER_PROFILE]),
      default: CONTROLLED_TRANSFER_PROFILE, compactIssuanceEnabled: false }) });
  }
  const formats = value.leaseFormats;
  if (!record(formats) || Object.keys(formats).length !== 3
    || !['supported', 'default', 'compactIssuanceEnabled'].every(key => Object.hasOwn(formats, key))
    || !Array.isArray(formats.supported) || ![1, 2].includes(formats.supported.length)
    || formats.supported[0] !== CONTROLLED_TRANSFER_PROFILE
    || (formats.supported.length === 2 && formats.supported[1] !== COMPACT_TRANSFER_LEASE_PROFILE)
    || formats.default !== CONTROLLED_TRANSFER_PROFILE || typeof formats.compactIssuanceEnabled !== 'boolean'
    || (formats.compactIssuanceEnabled && formats.supported.length !== 2)) fail('INVALID_CAPABILITY');
  return value;
}

export function prepareLeaseFormat(options) {
  if (options === undefined) return CONTROLLED_TRANSFER_PROFILE;
  const code = 'INVALID_PREPARE_OPTIONS', value = snapshot(options, code);
  if (!record(value) || Object.keys(value).some(key => key !== 'leaseFormat')
    || (Object.hasOwn(value, 'leaseFormat')
      && ![CONTROLLED_TRANSFER_PROFILE, COMPACT_TRANSFER_LEASE_PROFILE].includes(value.leaseFormat))) fail(code);
  return Object.hasOwn(value, 'leaseFormat') ? value.leaseFormat : CONTROLLED_TRANSFER_PROFILE;
}

export function reviewFields(prepared, baseUrl) {
  const actionId = prepared?.actionId ?? null;
  return { actionId, reviewUrl: actionId ? `${baseUrl}/approvals?action=${encodeURIComponent(actionId)}` : null,
    retryAutomatically: false };
}
