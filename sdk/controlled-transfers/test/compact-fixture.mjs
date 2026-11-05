import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { createControlledTransfers } from '../../controlled-transfers.mjs';
import { canonicalJson, sha256 } from '../../runtime/protocol.mjs';

export const FULL = 'matoi.controlled-transfer.v1';
export const COMPACT = 'matoi.controlled-transfer.lease.v2';
export const BUILDER = 'matoi.controlled-transfer.pass.v1';
export const compactOptions = Object.freeze({ leaseFormat: COMPACT });
export const fullOptions = Object.freeze({ leaseFormat: FULL });
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keys = Object.fromEntries(['current', 'old', 'foreign'].map(name => {
  const pair = generateKeyPairSync('ed25519');
  return [name, { ...pair, fingerprint: sha256(pair.publicKey.export({ type: 'spki', format: 'der' })),
    pem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }];
}));

export const publicIssuer = (name = 'current') => ({ key: keys[name].publicKey, fingerprint: keys[name].fingerprint });
export const publicPem = (name = 'current') => keys[name].pem;
export const signed = (payload, name = 'current') => ({ payload,
  signature: sign(null, Buffer.from(canonicalJson(payload)), keys[name].privateKey).toString('base64url') });
export const effectDigest = effect => sha256(canonicalJson([FULL, 'effect', effect]));
export const settled = promise => promise.then(value => ({ value }), error => ({ error }));

export function makeEffect(paymentId = 'payment-compact') {
  return { operation: 'transfer', paymentId, sourceAccount: 'treasury', destination: 'vendor',
    asset: 'USD', network: 'synthetic-ledger', amountMinor: '10000000000000000001', decimals: 2 };
}

export function makePreparation(operationId = 'operation-compact', { grantId = 'grant-compact',
  format = COMPACT, count = 2, effects = Array.from({ length: count }, (_, i) => makeEffect(`payment-${operationId}-${i}`)),
  signer = 'current', payload: changes = {} } = {}) {
  const now = Date.now();
  const payload = { profile: format, id: `lease-${operationId}`, orgId: 'org-compact', actorId: 'actor-compact',
    keyId: 'key-compact', grantId, operationId, grantEpoch: '1', authorityEpoch: '2', issuedAt: now - 1000,
    expiresAt: now + 60000, issuer: keys[signer].fingerprint, workflowDigest: sha256('synthetic-workflow'),
    evidenceDigest: sha256('synthetic-evidence'), effectDigests: effects.map(effectDigest),
    context: { artifact_sha256: sha256('synthetic-workflow'), config_sha256: sha256('synthetic-config'),
      dependencies_sha256: sha256('synthetic-evidence') } };
  if (format === COMPACT) Object.assign(payload, { transferProfile: FULL, passBuilder: BUILDER,
    passCommitments: effects.map((effect, ordinal) => ({ passHash: sha256(`synthetic-pass:${operationId}:${ordinal}`),
      passId: `ap_${sha256(`synthetic-id:${operationId}:${ordinal}`).slice(0, 24)}`,
      actionFingerprint: sha256(`synthetic-action:${effectDigest(effect)}:${ordinal}`) })) });
  Object.assign(payload, changes);
  return { profile: FULL, operationId, grantId, preparationDigest: sha256(canonicalJson(payload)),
    actionId: `act_${sha256(operationId).slice(0, 24)}`, fingerprint: `apfp_${sha256(`approval:${operationId}`)}`,
    lease: signed(payload, signer), effects, state: 'awaiting_approval' };
}

export function resignPreparation(prepared, signer = 'current') {
  prepared.lease = signed(prepared.lease.payload, signer);
  prepared.preparationDigest = sha256(canonicalJson(prepared.lease.payload));
  return prepared;
}

export function makeGate(prepared, ordinal) {
  const payload = prepared.lease.payload;
  const pass = payload.passes?.[ordinal], entry = payload.passCommitments?.[ordinal];
  const core = { schema_version: 'osuite.action_pass.receipt.v1',
    pass_id: entry?.passId ?? pass?.pass_id ?? `ap_${sha256('legacy-pass').slice(0, 24)}`,
    pass_hash: entry?.passHash ?? pass?.pass_hash ?? sha256('legacy-pass'),
    action_fingerprint: entry?.actionFingerprint ?? pass?.action_binding.allowed_fingerprint ?? sha256('legacy-action'),
    lane: 'slow', decision: 'review', reason: 'risk_exceeds_fast_lane',
    observed_at: new Date(payload.issuedAt + 100).toISOString(), sequence_number: ordinal };
  return { lane: 'slow-approved', admissionSequence: String(ordinal + 1),
    coreReceipt: { ...core, receipt_hash: sha256(canonicalJson(core)) } };
}

export function rehashGate(gate) {
  const { receipt_hash: _hash, ...core } = gate.coreReceipt;
  gate.coreReceipt.receipt_hash = sha256(canonicalJson(core));
  return gate;
}

export function makeReceipt(prepared, ordinal = 0, { gate = prepared.lease.payload.profile === COMPACT,
  signer = 'current', changes = {} } = {}) {
  const lease = prepared.lease.payload;
  return signed({ profile: 'matoi.controlled-transfer.receipt.v1', issuer: keys[signer].fingerprint,
    receiptId: `receipt-${prepared.operationId}-${ordinal}`, orgId: lease.orgId, actorId: lease.actorId,
    grantId: prepared.grantId, operationId: prepared.operationId, ordinal, actionId: prepared.actionId,
    actionFingerprint: prepared.fingerprint, preparationDigest: prepared.preparationDigest,
    authorityEpoch: lease.authorityEpoch, grantEpoch: lease.grantEpoch, effect: prepared.effects[ordinal],
    effectDigest: lease.effectDigests[ordinal], committedAt: lease.issuedAt + 200, state: 'committed',
    evidenceDigest: lease.evidenceDigest, ...(gate ? { gate: makeGate(prepared, ordinal) } : {}), ...changes }, signer);
}

export function makeCapabilities() {
  return { profile: FULL, installed: true, configured: true, resourceEnforced: true, scope: 'controlled-ledger',
    issuerPublicKey: publicPem(), executionTransport: 'bound-reference-v1',
    qualification: { status: 'not-qualified', remaining: ['synthetic SDK contract tests only'] },
    leaseFormats: { supported: [FULL, COMPACT], default: FULL, compactIssuanceEnabled: true } };
}

export function verificationContext(prepared, overrides = {}) {
  return { config: { orgId: 'org-compact', agentId: 'actor-compact', keyId: 'key-compact', trustedIssuerPublicKeys: [] },
    issuer: publicIssuer(), operationId: prepared.operationId, grantId: prepared.grantId, ...overrides };
}

// Synthetic owner transport only: RSA requests and Ed25519 SDK verification are real.
// These commitments are test values, not evidence of owner pass construction or admission.
export function createFixture({ count = 2, config: overrides = {}, factory = createControlledTransfers } = {}) {
  const batches = new Map(), requests = [];
  const control = { capabilities: makeCapabilities() };
  const config = { baseUrl: 'https://compact-sdk.invalid', apiKey: 'synthetic-compact-sdk-key', orgId: 'org-compact',
    agentId: 'actor-compact', keyId: 'key-compact', signatureMode: 'required', guardFailureMode: 'block',
    timeoutMs: 2000, issuerPublicKey: publicPem(), trustedIssuerPublicKeys: [],
    privateKeyBase64: Buffer.from(rsa.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64'), ...overrides };
  function status(operationId) {
    const batch = batches.get(operationId);
    if (!batch) return { profile: FULL, operationId, actionId: null, state: 'unknown', lastDenial: null, effects: [] };
    const { prepared, receipts } = batch;
    return { profile: FULL, operationId, actionId: prepared.actionId, prepared, lastDenial: null,
      state: receipts.size === prepared.effects.length ? 'committed' : receipts.size ? 'partially_committed' : 'ready',
      effects: prepared.effects.map((effect, ordinal) => ({ ordinal, paymentId: effect.paymentId,
        state: receipts.has(ordinal) ? 'committed' : 'not_committed', receipt: receipts.get(ordinal) ?? null })) };
  }
  async function fetchImpl(input, init) {
    const url = new URL(input);
    assert.equal(url.origin, config.baseUrl);
    assert.equal(url.pathname, '/api/matoi/transfers');
    let result;
    if (init.method === 'GET') {
      const operationId = url.searchParams.get('operationId');
      requests.push({ method: 'GET', operationId });
      result = operationId ? status(operationId) : control.capabilities;
      const hook = operationId ? control.onStatus : control.onCapabilities;
      if (hook) result = await hook(result, operationId, init);
    } else {
      assert.equal(init.method, 'POST');
      const { _signature, ...body } = JSON.parse(init.body);
      assert.ok(verify('sha256', Buffer.from(canonicalJson(body)), rsa.publicKey, Buffer.from(_signature, 'base64')));
      requests.push({ method: 'POST', body, operationId: body.operationId, kind: body.kind, headers: init.headers });
      if (body.kind === 'prepare') {
        assert.equal(batches.has(body.operationId), false, 'the SDK must not send a second prepare POST');
        result = makePreparation(body.operationId, { grantId: body.grantId, count, format: body.leaseFormat ?? FULL });
        batches.set(body.operationId, { prepared: result, receipts: new Map() });
        if (control.onPrepare) result = await control.onPrepare(result, body, init);
      } else {
        assert.equal(body.kind, 'execute');
        const batch = batches.get(body.operationId);
        assert.ok(batch, 'fixture execution needs an original preparation');
        if (body.preparationDigest) assert.equal(body.preparationDigest, batch.prepared.preparationDigest);
        else assert.deepEqual(body.lease, batch.prepared.lease);
        assert.equal(batch.receipts.has(body.ordinal), false, 'the SDK must not send a completed ordinal twice');
        const receipt = makeReceipt(batch.prepared, body.ordinal);
        batch.receipts.set(body.ordinal, receipt);
        result = { profile: FULL, operationId: body.operationId, state: 'committed', receipt };
        if (control.onExecute) result = await control.onExecute(result, body, init);
      }
    }
    return result instanceof Response ? result : new Response(JSON.stringify(result), {
      headers: { 'content-type': 'application/json' }, status: 200 });
  }
  const previous = globalThis.fetch;
  let client;
  try { globalThis.fetch = fetchImpl; client = factory({ config }); }
  finally { globalThis.fetch = previous; }
  async function fill(prefix, number = 17, options = fullOptions) {
    for (let i = 0; i < number; i++) await client.prepare(`${prefix}-${i}`, `grant-${prefix}-${i}`, options);
  }
  return { client, control, batches, requests, config, status, fill,
    posts: operationId => requests.filter(r => r.method === 'POST' && (!operationId || r.operationId === operationId)),
    reads: operationId => requests.filter(r => r.method === 'GET' && r.operationId === operationId) };
}
