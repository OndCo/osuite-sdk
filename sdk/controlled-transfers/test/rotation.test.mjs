import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { createControlledTransfers } from '../../controlled-transfers.mjs';
import { canonicalJson } from '../../runtime/protocol.mjs';

const PROFILE = 'matoi.controlled-transfer.v1';
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
const key = () => {
  const pair = generateKeyPairSync('ed25519');
  return { ...pair, pem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    fingerprint: createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex') };
};
const old = key(), current = key(), foreign = key();
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const packet = (payload, issuer = old) => ({ payload, signature: sign(null, Buffer.from(canonicalJson(payload)), issuer.privateKey).toString('base64url') });
const effect = { operation: 'transfer', paymentId: 'invoice-one', sourceAccount: 'treasury', destination: 'vendor',
  asset: 'USD', network: 'internal-ledger', amountMinor: '101', decimals: 2 };

function history(issuer = old) {
  const now = Date.now(), effectDigest = hash([PROFILE, 'effect', effect]);
  const lease = packet({ profile: PROFILE, id: 'lease-one', orgId: 'org-one', actorId: 'agent-one', keyId: 'key-one',
    grantId: 'grant-one', operationId: 'operation-one', grantEpoch: '1', authorityEpoch: '1',
    issuedAt: now - 1000, expiresAt: now + 200000, issuer: issuer.fingerprint,
    workflowDigest: '1'.repeat(64), evidenceDigest: '2'.repeat(64), effectDigests: [effectDigest],
    context: { artifact_sha256: '3'.repeat(64), config_sha256: '4'.repeat(64), dependencies_sha256: '5'.repeat(64) } }, issuer);
  const prepared = { profile: PROFILE, operationId: 'operation-one', grantId: 'grant-one',
    state: 'awaiting_approval', actionId: 'act-one', fingerprint: 'apfp_' + '6'.repeat(64),
    preparationDigest: hash(lease.payload), effects: [effect], lease };
  const receipt = packet({ profile: 'matoi.controlled-transfer.receipt.v1', issuer: issuer.fingerprint,
    receiptId: 'receipt-one', orgId: 'org-one', actorId: 'agent-one', grantId: 'grant-one',
    operationId: 'operation-one', ordinal: 0, actionId: 'act-one', actionFingerprint: prepared.fingerprint,
    preparationDigest: prepared.preparationDigest, authorityEpoch: '1', grantEpoch: '1', effect,
    effectDigest, committedAt: now, state: 'committed', evidenceDigest: lease.payload.evidenceDigest }, issuer);
  return { prepared, receipt, status: { profile: PROFILE, operationId: 'operation-one', state: 'committed',
    actionId: 'act-one', lastDenial: null, prepared, effects: [{ ordinal: 0, paymentId: effect.paymentId, state: 'committed', receipt }] } };
}

async function fixture(t, { trustedIssuerPublicKeys = [old.pem], observed = history(), injected = false } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST') return res.end(JSON.stringify(observed.prepared));
    if (req.url.includes('operationId=')) return res.end(JSON.stringify(observed.status));
    res.end(JSON.stringify({ profile: PROFILE, scope: 'controlled-ledger', installed: true, configured: true,
      resourceEnforced: true, issuerPublicKey: current.pem, qualification: { status: 'not-qualified' },
      ...(injected ? { trustedIssuerPublicKeys: [foreign.pem] } : {}) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const config = { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'synthetic-key', orgId: 'org-one',
    agentId: 'agent-one', keyId: 'key-one', signatureMode: 'required', guardFailureMode: 'block', timeoutMs: 2000,
    issuerPublicKey: current.pem, trustedIssuerPublicKeys,
    privateKeyBase64: Buffer.from(rsa.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64') };
  return { client: createControlledTransfers({ config }), config, requests, observed };
}

test('explicit historical roots recover original signed receipts after current-key rotation', async t => {
  const f = await fixture(t);
  const result = await f.client.status('operation-one');
  assert.equal(result.state, 'committed');
  assert.equal(result.effects[0].receiptVerified, true);
  assert.deepEqual(result.effects[0].receipt, f.observed.receipt);
  assert.equal(f.requests.some(request => request.method === 'POST'), false);
});
test('missing historical trust retains unknown and never causes execution', async t => {
  const f = await fixture(t, { trustedIssuerPublicKeys: [] });
  assert.equal((await f.client.status('operation-one')).state, 'unknown');
  assert.equal(f.requests.some(request => request.method === 'POST'), false);
});
test('historical preparation verification is read-only, not renewed execution authority', async t => {
  const observed = history();
  observed.status.state = 'ready';
  observed.status.effects = [{ ordinal: 0, paymentId: effect.paymentId, state: 'not_committed' }];
  const f = await fixture(t, { observed });
  const status = await f.client.status('operation-one');
  assert.equal(status.state, 'ready');
  await assert.rejects(f.client.execute(status.prepared, 0), error => error.code === 'INVALID_PREPARATION');
  assert.equal(f.requests.some(request => request.method === 'POST'), false);
});
test('an authenticated capability response cannot add unconfigured historical trust roots', async t => {
  const f = await fixture(t, { observed: history(foreign), injected: true });
  assert.equal((await f.client.status('operation-one')).state, 'unknown');
});
test('a historical signer cannot issue a fresh preparation even when explicitly trusted for history', async t => {
  const f = await fixture(t);
  await assert.rejects(f.client.prepare('operation-one', 'grant-one'), error => error.code === 'OUTCOME_UNKNOWN');
});
test('the caller cannot mutate the historical trust set after client construction', async t => {
  const roots = [old.pem], f = await fixture(t, { trustedIssuerPublicKeys: roots });
  roots[0] = foreign.pem;
  assert.equal((await f.client.status('operation-one')).state, 'committed');
});
test('malformed, non-public, duplicate and unbounded historical roots reject before networking', async t => {
  const f = await fixture(t);
  for (const roots of ['key', [old.privateKey.export({ type: 'pkcs8', format: 'pem' })], [rsa.publicKey.export({ type: 'spki', format: 'pem' })], [old.pem, old.pem], Array(9).fill(old.pem), ['not a key']]) {
    assert.throws(() => createControlledTransfers({ config: { ...f.config, trustedIssuerPublicKeys: roots } }), error => error.code === 'INVALID_CONFIGURATION');
  }
  assert.equal(f.requests.length, 0);
});
