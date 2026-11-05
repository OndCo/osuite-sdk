import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { createControlledTransfers } from '../../controlled-transfers.mjs';
import { canonicalJson, sha256 } from '../../runtime/protocol.mjs';

const PROFILE = 'matoi.controlled-transfer.v1';
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const issuer = generateKeyPairSync('ed25519');
const issuerId = sha256(issuer.publicKey.export({ type: 'spki', format: 'der' }));
export const signed = payload => ({ payload,
  signature: sign(null, Buffer.from(canonicalJson(payload)), issuer.privateKey).toString('base64url') });

export function makePreparation(operationId, grantId = `grant-${operationId}`, count = 2) {
  const now = Date.now();
  const effects = Array.from({ length: count }, (_, ordinal) => ({ operation: 'transfer',
    paymentId: `payment-${operationId}-${ordinal}`, sourceAccount: 'treasury', destination: 'vendor',
    asset: 'USD', network: 'synthetic-ledger', amountMinor: '100', decimals: 2 }));
  const payload = { profile: PROFILE, id: `lease-${operationId}`, orgId: 'org-retention', actorId: 'actor-retention',
    keyId: 'key-retention', grantId, operationId, grantEpoch: '1', authorityEpoch: '1', issuedAt: now - 100,
    expiresAt: now + 300000, issuer: issuerId, workflowDigest: sha256('workflow'), evidenceDigest: sha256('evidence'),
    effectDigests: effects.map(effect => sha256(canonicalJson([PROFILE, 'effect', effect]))),
    context: { artifact_sha256: sha256('workflow'), config_sha256: sha256('config'), dependencies_sha256: sha256('evidence') } };
  return { profile: PROFILE, operationId, grantId, preparationDigest: sha256(canonicalJson(payload)),
    actionId: `act_${sha256(operationId).slice(0, 24)}`, fingerprint: sha256(`action:${operationId}`),
    effects, lease: signed(payload), state: 'awaiting_approval' };
}

export function makeReceipt(prepared, ordinal, changes = {}) {
  const lease = prepared.lease.payload;
  return signed({ profile: 'matoi.controlled-transfer.receipt.v1', issuer: issuerId,
    receiptId: `receipt-${prepared.operationId}-${ordinal}`, orgId: lease.orgId, actorId: lease.actorId,
    grantId: prepared.grantId, operationId: prepared.operationId, ordinal, actionId: prepared.actionId,
    actionFingerprint: prepared.fingerprint, preparationDigest: prepared.preparationDigest,
    authorityEpoch: lease.authorityEpoch, grantEpoch: lease.grantEpoch, effect: prepared.effects[ordinal],
    effectDigest: lease.effectDigests[ordinal], committedAt: Date.now(), state: 'committed',
    evidenceDigest: lease.evidenceDigest, ...changes });
}

// Only the owner transport is synthetic; the public SDK signs, parses and verifies normally.
export function createFixture({ count = 2 } = {}) {
  const batches = new Map(), requests = [], control = {};
  const config = { baseUrl: 'https://retention.invalid', apiKey: 'synthetic-retention-test', orgId: 'org-retention',
    agentId: 'actor-retention', keyId: 'key-retention', signatureMode: 'required', guardFailureMode: 'block',
    timeoutMs: 5000, issuerPublicKey: issuer.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyBase64: Buffer.from(rsa.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64') };
  function status(operationId) {
    const batch = batches.get(operationId);
    if (!batch) return { profile: PROFILE, operationId, actionId: null, state: 'unknown', lastDenial: null, effects: [] };
    const { prepared, receipts } = batch;
    return { profile: PROFILE, operationId, actionId: prepared.actionId, prepared, lastDenial: null,
      state: receipts.size === count ? 'committed' : receipts.size ? 'partially_committed' : 'ready',
      effects: prepared.effects.map((effect, ordinal) => ({ ordinal, paymentId: effect.paymentId,
        state: receipts.has(ordinal) ? 'committed' : 'not_committed', receipt: receipts.get(ordinal) ?? null })) };
  }
  async function fetchImpl(input, init) {
    const url = new URL(input);
    assert.equal(url.origin, config.baseUrl);
    assert.equal(url.pathname, '/api/matoi/transfers');
    assert.equal(init.headers['x-api-key'], config.apiKey);
    let result;
    if (init.method === 'GET') {
      const operationId = url.searchParams.get('operationId');
      requests.push({ method: 'GET', operationId });
      if (operationId) {
        result = status(operationId);
        if (control.status) result = await control.status(result, operationId);
      } else {
        if (control.capabilities) await control.capabilities();
        result = { profile: PROFILE, installed: true, configured: true, resourceEnforced: true,
          scope: 'controlled-ledger', issuerPublicKey: config.issuerPublicKey, executionTransport: 'bound-reference-v1',
          qualification: { status: 'not-qualified', remaining: ['synthetic retention test'] } };
      }
    } else {
      assert.equal(init.method, 'POST');
      const { _signature, ...body } = JSON.parse(init.body);
      assert.ok(verify('sha256', Buffer.from(canonicalJson(body)), rsa.publicKey, Buffer.from(_signature, 'base64')));
      requests.push({ method: 'POST', kind: body.kind, operationId: body.operationId, ordinal: body.ordinal });
      if (body.kind === 'prepare') {
        assert.equal(batches.has(body.operationId), false, 'an old ID must never be prepared again');
        result = makePreparation(body.operationId, body.grantId, count);
        batches.set(body.operationId, { prepared: result, receipts: new Map() });
      } else {
        assert.equal(body.kind, 'execute');
        const batch = batches.get(body.operationId);
        assert.equal(body.preparationDigest, batch.prepared.preparationDigest);
        assert.equal(batch.receipts.has(body.ordinal), false, 'a completed ordinal must never be posted again');
        const receipt = makeReceipt(batch.prepared, body.ordinal);
        batch.receipts.set(body.ordinal, receipt);
        result = { profile: PROFILE, operationId: body.operationId, state: 'committed', receipt };
        if (control.execute) result = await control.execute(result, body);
      }
    }
    return result instanceof Response ? result : new Response(JSON.stringify(result), {
      headers: { 'content-type': 'application/json' }, status: 200 });
  }
  const previous = globalThis.fetch;
  let client;
  try { globalThis.fetch = fetchImpl; client = createControlledTransfers({ config }); }
  finally { globalThis.fetch = previous; }
  async function complete(operationId) {
    const prepared = await client.prepare(operationId, `grant-${operationId}`);
    const results = [];
    for (let ordinal = 0; ordinal < count; ordinal++) results.push(await client.execute(prepared, ordinal));
    return { prepared, results };
  }
  async function fill(prefix, number = 17) {
    for (let i = 0; i < number; i++) await complete(`${prefix}-${i}`);
  }
  return { client, batches, control, requests, complete, fill, status, config,
    posts: () => requests.filter(request => request.method === 'POST').length,
    reads: operationId => requests.filter(request => request.method === 'GET' && request.operationId === operationId).length };
}
