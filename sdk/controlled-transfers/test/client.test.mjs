import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalJson, createApiClient } from '../../runtime/protocol.mjs';

const PROFILE = 'matoi.controlled-transfer.v1';
const RECEIPT_PROFILE = 'matoi.controlled-transfer.receipt.v1';
const MAX_ENVELOPE_BYTES = 1024 * 1024;
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const issuer = generateKeyPairSync('ed25519');
const stranger = generateKeyPairSync('ed25519');
const hash = value => createHash('sha256').update(value).digest('hex');
const fingerprint = key => hash(key.export({ type: 'spki', format: 'der' }));
const effectDigest = effect => hash(canonicalJson([PROFILE, 'effect', effect]));
const signEnvelope = (payload, key = issuer.privateKey) => ({
  payload, signature: sign(null, Buffer.from(canonicalJson(payload)), key).toString('base64url'),
});
const transfer = (paymentId = 'payment-1') => ({ operation: 'transfer', paymentId,
  sourceAccount: 'treasury', destination: 'vendor', asset: 'USD', network: 'internal-ledger',
  amountMinor: '10000000000000000001', decimals: 2 });

function preparation(operationId = 'operation-1', grantId = 'grant-1', options = {}) {
  const effects = options.effects || [transfer()];
  const now = Date.now();
  const payload = { profile: PROFILE, id: 'lease-1', orgId: 'org-1', actorId: 'agent-1',
    keyId: 'key-1', grantId, operationId, grantEpoch: '1', authorityEpoch: '2',
    issuedAt: now - 100, expiresAt: now + 60000, issuer: fingerprint(issuer.publicKey),
    workflowDigest: hash('workflow'), evidenceDigest: hash('evidence'),
    effectDigests: effects.map(effectDigest), context: { artifact_sha256: hash('workflow'),
      config_sha256: hash('config'), dependencies_sha256: hash('evidence') }, ...options.payload };
  return { profile: PROFILE, operationId, grantId, preparationDigest: hash(canonicalJson(payload)),
    actionId: `act_${hash(operationId).slice(0, 24)}`, fingerprint: hash(`action:${operationId}`),
    lease: signEnvelope(payload, options.key), effects, state: 'awaiting_approval', ...options.response };
}

function receipt(prepared, ordinal = 0, changes = {}, key = issuer.privateKey) {
  const lease = prepared.lease.payload;
  return signEnvelope({ profile: RECEIPT_PROFILE, issuer: fingerprint(issuer.publicKey),
    receiptId: `receipt-${ordinal}`, orgId: lease.orgId, actorId: lease.actorId,
    grantId: lease.grantId, operationId: lease.operationId, ordinal, actionId: prepared.actionId,
    actionFingerprint: prepared.fingerprint, preparationDigest: prepared.preparationDigest,
    authorityEpoch: lease.authorityEpoch, grantEpoch: lease.grantEpoch,
    effect: prepared.effects[ordinal], effectDigest: lease.effectDigests[ordinal],
    committedAt: Date.now(), state: 'committed', evidenceDigest: lease.evidenceDigest, ...changes }, key);
}

async function setup(t, options = {}) {
  const requests = [], signatureResults = [], prepared = new Map();
  const control = { capabilities: { profile: PROFILE, installed: true, configured: true,
    scope: 'controlled-ledger', resourceEnforced: true,
    issuerPublicKey: issuer.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    qualification: { status: 'not-qualified', remaining: ['deployment validation'] } }, ...options };
  const server = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;
      const url = new URL(req.url, 'http://127.0.0.1');
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams),
        headers: req.headers, body });
      assert.equal(req.headers['x-api-key'], 'local-test-api-key');
      assert.equal(url.pathname, '/api/matoi/transfers');
      if (body) {
        const { _signature, ...signed } = body;
        signatureResults.push(typeof _signature === 'string'
          && verify('sha256', Buffer.from(canonicalJson(signed)), rsa.publicKey, Buffer.from(_signature, 'base64')));
      }
      let reply;
      if (req.method === 'GET' && !url.search) {
        reply = control.onCapabilities ? await control.onCapabilities(req, res) : control.capabilities;
      } else if (req.method === 'GET') {
        reply = control.onStatus ? await control.onStatus(url, res) : { profile: PROFILE,
          operationId: url.searchParams.get('operationId'), actionId: null, state: 'unknown', lastDenial: null, effects: [] };
      } else if (body?.kind === 'prepare') {
        reply = control.onPrepare ? await control.onPrepare(body, res) : preparation(body.operationId, body.grantId);
        if (reply?.lease) prepared.set(body.operationId, reply);
      } else if (body?.kind === 'execute') {
        reply = control.onExecute ? await control.onExecute(body, res) : { profile: PROFILE,
          operationId: body.operationId, state: 'denied', code: 'AWAITING_APPROVAL' };
      } else { throw new Error('Unexpected fixture request'); }
      if (reply !== undefined && !res.destroyed) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply));
      }
    } catch (error) {
      res.writeHead(500); res.end(String(error));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const config = { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'local-test-api-key',
    privateKeyBase64: Buffer.from(rsa.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64'),
    orgId: 'org-1', agentId: 'agent-1', keyId: 'key-1', signatureMode: 'required', guardFailureMode: 'block',
    timeoutMs: 500 };
  const entry = new URL('../../controlled-transfers.mjs', import.meta.url);
  assert.ok(existsSync(entry), 'the additive controlled-transfer SDK entry must exist');
  const { createControlledTransfers } = await import(entry);
  return { config, control, requests, signatureResults, prepared,
    create: (overrides = {}) => createControlledTransfers({ config: { ...config, ...overrides } }), createControlledTransfers };
}

test('strict configuration rejects missing identity, insecure transport, unsigned and fail-open modes before I/O', async t => {
  const f = await setup(t);
  const invalid = [
    { baseUrl: 'http://remote.invalid' }, { baseUrl: 'http://remote.invalid', allowInsecureHttp: true },
    { baseUrl: 'https://user:password@remote.invalid' }, { baseUrl: 'https://remote.invalid?token=1' },
    { baseUrl: 'https://remote.invalid#fragment' }, { baseUrl: 'not-a-url' },
    { apiKey: '' }, { apiKey: 'has\nnewline' }, { privateKeyBase64: '' }, { privateKeyBase64: 'broken' },
    { privateKeyBase64: Buffer.from(issuer.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64') },
    { orgId: '' }, { agentId: '' }, { signatureMode: undefined }, { signatureMode: 'workspace_key_optional' },
    { guardFailureMode: undefined }, { guardFailureMode: 'allow' }, { timeoutMs: 0 },
    { issuerPublicKey: 'not-a-key' },
  ];
  for (const overrides of invalid) assert.throws(() => f.create(overrides), { code: 'INVALID_CONFIGURATION' });
  assert.throws(() => f.createControlledTransfers({ config: f.config, execute() {} }), { code: 'INVALID_CONFIGURATION' });
  assert.equal(f.requests.length, 0);
});

test('authenticated capability lookup is honest about non-qualification and performs no mutation', async t => {
  const f = await setup(t), client = f.create();
  const result = await client.capabilities();
  assert.equal(result.profile, PROFILE);
  assert.equal(result.qualification.status, 'not-qualified');
  assert.equal(result.configured, true);
  assert.equal(result.resourceEnforced, true);
  assert.deepEqual(f.requests.map(r => r.method), ['GET']);
  assert.ok(Object.isFrozen(result.qualification));
});

test('advertised bound references keep execution requests small without dropping the signed preparation check', async t => {
  const f = await setup(t);
  f.control.capabilities.executionTransport = 'bound-reference-v1';
  const client = f.create();
  const prepared = await client.prepare('operation-1', 'grant-1');
  await client.execute(prepared);
  const request = f.requests.find(entry => entry.body?.kind === 'execute');
  assert.equal(request.body.preparationDigest, prepared.preparationDigest);
  assert.equal(Object.hasOwn(request.body, 'lease'), false);
  assert.ok(Buffer.byteLength(JSON.stringify(request.body)) < 16384);
});

test('controlled envelopes export a 1 MiB bound and snapshots enforce 65,536 nodes', async () => {
  const entry = await import('../../controlled-transfers.mjs');
  const { snapshot } = await import('../contract.mjs');
  assert.equal(entry.CONTROLLED_TRANSFER_MAX_ENVELOPE_BYTES, MAX_ENVELOPE_BYTES);
  assert.equal(snapshot('x'.repeat(MAX_ENVELOPE_BYTES - 2)).length, MAX_ENVELOPE_BYTES - 2);
  assert.throws(() => snapshot('x'.repeat(MAX_ENVELOPE_BYTES - 1)), { code: 'INVALID_RESPONSE' });
  assert.equal(snapshot(Array(65535).fill(null)).length, 65535);
  assert.throws(() => snapshot(Array(65536).fill(null)), { code: 'INVALID_RESPONSE' });
});

test('only the controlled client overrides the ordinary 256 KiB HTTP response limit', async t => {
  const f = await setup(t);
  f.control.capabilities.evidence = 'x'.repeat(300000);
  const ordinary = await createApiClient(f.config).request('GET', '/api/matoi/transfers');
  assert.equal(ordinary.ok, false);
  assert.equal(ordinary.error, 'invalid_response');
  assert.equal((await f.create().capabilities()).qualification.status, 'not-qualified');
  assert.ok(f.requests.every(request => request.method === 'GET'));
});

test('capability mismatch or missing enforcement blocks preparation without sending a POST', async t => {
  const f = await setup(t);
  for (const patch of [{ profile: 'legacy' }, { configured: false, issuerPublicKey: null },
    { resourceEnforced: false }, { scope: 'wrapped-call-only' }, { installed: false },
    { issuerPublicKey: null }, { qualification: { status: 'fully-protected' } }]) {
    const original = structuredClone(f.control.capabilities);
    Object.assign(f.control.capabilities, patch);
    await assert.rejects(f.create().prepare('operation-1', 'grant-1'), error => {
      assert.ok(['CAPABILITY_MISMATCH', 'PROFILE_UNAVAILABLE', 'INVALID_CAPABILITY'].includes(error.code));
      assert.equal(error.retryAutomatically, false);
      return true;
    });
    f.control.capabilities = original;
  }
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
});

test('a pinned issuer cannot be replaced by an authenticated but different capability key', async t => {
  const f = await setup(t);
  await assert.rejects(f.create({ issuerPublicKey: stranger.publicKey.export({ type: 'spki', format: 'pem' }).toString() })
    .prepare('operation-1', 'grant-1'), { code: 'CAPABILITY_MISMATCH' });
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
});

test('held preparation returns one stable review and signs the exact strict-profile request', async t => {
  const f = await setup(t), client = f.create();
  const first = await client.prepare('operation-1', 'grant-1');
  const second = await client.prepare('operation-1', 'grant-1');
  await delay(30);
  assert.deepEqual(second, first);
  assert.equal(first.state, 'awaiting_approval');
  assert.equal(first.reviewUrl, `${f.config.baseUrl}/approvals?action=${first.actionId}`);
  assert.equal(first.retryAutomatically, false);
  assert.ok(Object.isFrozen(first.lease.payload.effectDigests));
  assert.ok(Object.isFrozen(first.effects[0]));
  const posts = f.requests.filter(r => r.method === 'POST');
  assert.equal(posts.length, 1);
  assert.deepEqual(Object.keys(posts[0].body).sort(), ['_signature', 'agent_id', 'grantId', 'kind', 'operationId', 'profile', 'timestamp'].sort());
  assert.equal(posts[0].body.profile, PROFILE);
  assert.equal(posts[0].body.agent_id, 'agent-1');
  assert.equal(posts[0].body.kind, 'prepare');
  assert.ok(Number.isSafeInteger(posts[0].body.timestamp));
  assert.deepEqual(f.signatureResults, [true]);
  await assert.rejects(client.prepare('operation-1', 'different-grant'), { code: 'OPERATION_CONFLICT' });
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
});

test('HTTP 200 approval refusal stays a refusal and never polls, approves or retries', async t => {
  const f = await setup(t), client = f.create();
  const prepared = await client.prepare('operation-1', 'grant-1');
  const result = await client.execute(prepared);
  await delay(30);
  assert.equal(result.state, 'denied');
  assert.equal(result.code, 'AWAITING_APPROVAL');
  assert.equal(result.actionId, prepared.actionId);
  assert.equal(result.reviewUrl, prepared.reviewUrl);
  assert.equal(result.retryAutomatically, false);
  const calls = f.requests.filter(r => r.body?.kind === 'execute');
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['_signature', 'agent_id', 'kind', 'lease', 'operationId', 'ordinal', 'profile', 'timestamp'].sort());
  assert.equal(calls[0].body.ordinal, 0);
  assert.deepEqual(f.signatureResults, [true, true]);
});

const invalidPreparations = [
  ['foreign lease signature', () => preparation('operation-1', 'grant-1', { key: stranger.privateKey })],
  ['wrong tenant', () => preparation('operation-1', 'grant-1', { payload: { orgId: 'org-other' } })],
  ['wrong actor', () => preparation('operation-1', 'grant-1', { payload: { actorId: 'agent-other' } })],
  ['wrong credential', () => preparation('operation-1', 'grant-1', { payload: { keyId: 'key-other' } })],
  ['wrong signed operation', () => preparation('operation-1', 'grant-1', { payload: { operationId: 'another' } })],
  ['wrong signed grant', () => preparation('operation-1', 'grant-1', { payload: { grantId: 'another' } })],
  ['wrong issuer fingerprint', () => preparation('operation-1', 'grant-1', { payload: { issuer: hash('wrong') } })],
  ['non-string epoch', () => preparation('operation-1', 'grant-1', { payload: { grantEpoch: 1 } })],
  ['expired lease', () => preparation('operation-1', 'grant-1', { payload: { issuedAt: Date.now() - 10000, expiresAt: Date.now() - 5000 } })],
  ['wrong preparation digest', () => preparation('operation-1', 'grant-1', { response: { preparationDigest: hash('wrong') } })],
  ['effect outside signed digests', () => preparation('operation-1', 'grant-1', { payload: { effectDigests: [hash('different-effect')] } })],
  ['extra financial field', () => preparation('operation-1', 'grant-1', { effects: [{ ...transfer(), memo: 'not-in-profile' }] })],
  ['numeric money', () => preparation('operation-1', 'grant-1', { effects: [{ ...transfer(), amountMinor: 123 }] })],
  ['duplicate payment', () => preparation('operation-1', 'grant-1', { effects: [transfer(), transfer()] })],
  ['unsigned context extension', () => preparation('operation-1', 'grant-1', { payload: { context: { artifact_sha256: hash('a') } } })],
];

for (const [label, make] of invalidPreparations) test(`preparation rejects ${label} without an execution request`, async t => {
  const f = await setup(t, { onPrepare: make }), client = f.create();
  await assert.rejects(client.prepare('operation-1', 'grant-1'), { code: 'OUTCOME_UNKNOWN' });
  await assert.rejects(client.prepare('operation-1', 'grant-1'), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
  assert.equal(f.requests.filter(r => r.body?.kind === 'execute').length, 0);
});

test('a verified committed receipt binds the exact preparation and repeated execute does not send again', async t => {
  const f = await setup(t), client = f.create();
  f.control.onExecute = body => ({ profile: PROFILE, operationId: body.operationId,
    state: 'committed', receipt: receipt(f.prepared.get(body.operationId), body.ordinal) });
  const prepared = await client.prepare('operation-1', 'grant-1');
  const result = await client.execute(prepared);
  assert.equal(result.state, 'committed');
  assert.equal(result.newlyCommitted, true);
  assert.equal(result.receipt.payload.effect.amountMinor, '10000000000000000001');
  assert.ok(Object.isFrozen(result.receipt.payload.effect));
  const replay = await client.execute(prepared);
  assert.equal(replay.state, 'already_committed');
  assert.equal(replay.newlyCommitted, false);
  assert.deepEqual(replay.receipt, result.receipt);
  assert.equal(f.requests.filter(r => r.body?.kind === 'execute').length, 1);
});

test('historical already_committed evidence is verified but never attributed as a new current effect', async t => {
  const f = await setup(t), client = f.create();
  const earlier = preparation('operation-old', 'grant-1', { effects: [transfer('other-payment'), transfer()],
    payload: { grantEpoch: '0', authorityEpoch: '0', evidenceDigest: hash('old-evidence') } });
  const historical = receipt(earlier, 1);
  f.control.onExecute = body => ({ profile: PROFILE, operationId: body.operationId,
    state: 'already_committed', receipt: historical });
  const result = await client.execute(await client.prepare('operation-1', 'grant-1'));
  assert.equal(result.state, 'already_committed');
  assert.equal(result.operationId, 'operation-1');
  assert.equal(result.newlyCommitted, false);
  assert.equal(result.receipt.payload.operationId, 'operation-old');
  assert.equal(result.receipt.payload.ordinal, 1);
});

const badReceipts = [
  ['signature', prepared => receipt(prepared, 0, {}, stranger.privateKey)],
  ['issuer', prepared => receipt(prepared, 0, { issuer: hash('another-issuer') })],
  ['profile', prepared => receipt(prepared, 0, { profile: PROFILE })],
  ['tenant', prepared => receipt(prepared, 0, { orgId: 'other-org' })],
  ['actor', prepared => receipt(prepared, 0, { actorId: 'other-agent' })],
  ['grant', prepared => receipt(prepared, 0, { grantId: 'other-grant' })],
  ['operation', prepared => receipt(prepared, 0, { operationId: 'other-operation' })],
  ['ordinal', prepared => receipt(prepared, 0, { ordinal: 1 })],
  ['action', prepared => receipt(prepared, 0, { actionId: 'other-action' })],
  ['action fingerprint', prepared => receipt(prepared, 0, { actionFingerprint: hash('wrong') })],
  ['preparation', prepared => receipt(prepared, 0, { preparationDigest: hash('wrong') })],
  ['authority epoch', prepared => receipt(prepared, 0, { authorityEpoch: '999' })],
  ['grant epoch', prepared => receipt(prepared, 0, { grantEpoch: '999' })],
  ['evidence', prepared => receipt(prepared, 0, { evidenceDigest: hash('wrong') })],
  ['effect digest', prepared => receipt(prepared, 0, { effectDigest: hash('wrong') })],
  ['exact effect', prepared => {
    const effect = { ...prepared.effects[0], destination: 'different-vendor' };
    return receipt(prepared, 0, { effect, effectDigest: effectDigest(effect) });
  }],
  ['state', prepared => receipt(prepared, 0, { state: 'denied' })],
  ['future commitment', prepared => receipt(prepared, 0, { committedAt: Number.MAX_SAFE_INTEGER })],
  ['extra signed field', prepared => receipt(prepared, 0, { unaudited: true })],
];

for (const [label, make] of badReceipts) test(`invalid receipt ${label} makes the outcome unknown and fences mutation`, async t => {
  const f = await setup(t), client = f.create();
  f.control.onExecute = body => ({ profile: PROFILE, operationId: body.operationId,
    state: 'committed', receipt: make(f.prepared.get(body.operationId)) });
  const prepared = await client.prepare('operation-1', 'grant-1');
  await assert.rejects(client.execute(prepared), error => {
    assert.equal(error.code, 'OUTCOME_UNKNOWN');
    assert.equal(error.reason, 'INVALID_RECEIPT');
    assert.equal(error.recovery.method, 'status');
    assert.equal(error.retryAutomatically, false);
    return true;
  });
  await assert.rejects(client.execute(prepared), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.requests.filter(r => r.body?.kind === 'execute').length, 1);
});

test('historical receipts must still match the authorized tenant, actor, grant and effect', async t => {
  const f = await setup(t);
  for (const changes of [{ orgId: 'other-org' }, { actorId: 'other-actor' }, { grantId: 'other-grant' },
    { effect: transfer('other-payment'), effectDigest: effectDigest(transfer('other-payment')) }]) {
    const client = f.create();
    f.control.onExecute = body => ({ profile: PROFILE, operationId: body.operationId,
      state: 'already_committed', receipt: receipt(preparation('operation-old'), 0, changes) });
    await assert.rejects(client.execute(await client.prepare('operation-1', 'grant-1')), error => {
      assert.equal(error.code, 'OUTCOME_UNKNOWN');
      assert.equal(error.reason, 'INVALID_RECEIPT');
      return true;
    });
  }
});

test('a transport-lost acknowledgement is recovered by authenticated status reads only', async t => {
  const f = await setup(t), client = f.create();
  let recorded;
  f.control.onExecute = (body, res) => { recorded = receipt(f.prepared.get(body.operationId)); res.destroy(); };
  f.control.onStatus = url => ({ profile: PROFILE, operationId: url.searchParams.get('operationId'),
    actionId: recorded.payload.actionId, state: 'committed', lastDenial: null,
    effects: [{ ordinal: 0, paymentId: 'payment-1', state: 'committed', receipt: recorded }] });
  const prepared = await client.prepare('operation-1', 'grant-1');
  await assert.rejects(client.execute(prepared), { code: 'OUTCOME_UNKNOWN' });
  const status = await client.status('operation-1');
  assert.equal(status.state, 'committed');
  assert.equal(status.newlyCommitted, false);
  assert.equal(status.effects[0].receiptVerified, true);
  assert.equal(status.effects[0].receipt.payload.operationId, 'operation-1');
  await assert.rejects(client.execute(prepared), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.requests.filter(r => r.body?.kind === 'execute').length, 1);
  assert.deepEqual(f.requests.at(-1).query, { operationId: 'operation-1', agent_id: 'agent-1' });
});

test('prepare timeout preserves the operation ID and never repeats approval creation', async t => {
  const f = await setup(t, { onPrepare: () => undefined }), client = f.create({ timeoutMs: 50 });
  await assert.rejects(client.prepare('operation-1', 'grant-1'), error => {
    assert.equal(error.code, 'OUTCOME_UNKNOWN');
    assert.equal(error.operationId, 'operation-1');
    return true;
  });
  await assert.rejects(client.prepare('operation-1', 'grant-1'), { code: 'OUTCOME_UNKNOWN' });
  const status = await client.status('operation-1');
  assert.equal(status.state, 'unknown');
  assert.equal(status.code, 'OUTCOME_UNKNOWN');
  assert.equal(status.retryAutomatically, false);
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
});

test('not-found, outage and malformed status are never proof of non-execution', async t => {
  const f = await setup(t), client = f.create();
  for (const httpStatus of [400, 401, 404, 503]) {
    f.control.onStatus = (_url, res) => { res.writeHead(httpStatus); res.end(); };
    const result = await client.status('missing-operation');
    assert.equal(result.state, 'unknown');
    assert.equal(result.code, 'OUTCOME_UNKNOWN');
    assert.equal(result.recovery.method, 'status');
  }
  for (const response of [{ profile: 'wrong' }, { profile: PROFILE, operationId: 'wrong' },
    { profile: PROFILE, operationId: 'missing-operation', state: 'committed', actionId: 'act-1', lastDenial: null, effects: [] }]) {
    f.control.onStatus = () => response;
    assert.equal((await client.status('missing-operation')).code, 'OUTCOME_UNKNOWN');
  }
  assert.ok(f.requests.every(r => r.method === 'GET'));
});

test('an invalid status receipt remains unknown, even when the owner labels it committed', async t => {
  const f = await setup(t), client = f.create();
  const prepared = await client.prepare('operation-1', 'grant-1');
  f.control.onStatus = () => ({ profile: PROFILE, operationId: 'operation-1', actionId: prepared.actionId,
    state: 'committed', lastDenial: null, effects: [{ ordinal: 0, paymentId: 'payment-1', state: 'committed',
      receipt: receipt(prepared, 0, { orgId: 'wrong-org' }) }] });
  const result = await client.status('operation-1');
  assert.equal(result.code, 'OUTCOME_UNKNOWN');
  assert.equal(result.state, 'unknown');
  assert.equal(f.requests.filter(r => r.body?.kind === 'execute').length, 0);
});

test('fresh capability enforcement gates execute, even after a valid preparation', async t => {
  const f = await setup(t), client = f.create();
  const prepared = await client.prepare('operation-1', 'grant-1');
  f.control.capabilities.resourceEnforced = false;
  await assert.rejects(client.execute(prepared), { code: 'PROFILE_UNAVAILABLE' });
  assert.equal(f.requests.filter(r => r.body?.kind === 'execute').length, 0);
});

test('concurrent calls coalesce preparation and execution instead of resending mutations', async t => {
  const f = await setup(t), client = f.create();
  f.control.onExecute = async body => { await delay(15); return { profile: PROFILE,
    operationId: body.operationId, state: 'committed', receipt: receipt(f.prepared.get(body.operationId)) }; };
  const [first, second] = await Promise.all([client.prepare('operation-1', 'grant-1'), client.prepare('operation-1', 'grant-1')]);
  await Promise.all([client.execute(first), client.execute(second)]);
  assert.equal(f.requests.filter(r => r.body?.kind === 'prepare').length, 1);
  assert.equal(f.requests.filter(r => r.body?.kind === 'execute').length, 1);
});

test('a cold unknown status also fences later prepare instead of treating absence as non-execution', async t => {
  const f = await setup(t), client = f.create();
  assert.equal((await client.status('operation-1')).code, 'OUTCOME_UNKNOWN');
  await assert.rejects(client.prepare('operation-1', 'grant-1'), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
});

test('any malformed post-send payload becomes OUTCOME_UNKNOWN, including hostile extra fields', async t => {
  const f = await setup(t), client = f.create();
  const prepared = await client.prepare('operation-1', 'grant-1');
  f.control.onExecute = body => ({ profile: PROFILE, operationId: body.operationId, state: 'denied',
    code: 'POLICY_DENIED', extra: { constructor: true } });
  await assert.rejects(client.execute(prepared), { code: 'OUTCOME_UNKNOWN' });
  await assert.rejects(client.execute(prepared), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.requests.filter(r => r.body?.kind === 'execute').length, 1);
});

test('an explicit serialized preparation can be verified without replaying its prepare request', async t => {
  const f = await setup(t), first = f.create(), resumed = f.create();
  const prepared = JSON.parse(JSON.stringify(await first.prepare('operation-1', 'grant-1')));
  f.control.onExecute = body => ({ profile: PROFILE, operationId: body.operationId, state: 'committed',
    receipt: receipt(f.prepared.get(body.operationId)) });
  assert.equal((await resumed.execute(prepared)).state, 'committed');
  assert.deepEqual(await resumed.prepare('operation-1', 'grant-1'), prepared);
  assert.equal(f.requests.filter(r => r.body?.kind === 'prepare').length, 1);
});

test('cold current-operation receipt verification is read-only and historical ambiguity stays unknown', async t => {
  const f = await setup(t), p = preparation();
  const current = receipt(p);
  f.control.onStatus = () => ({ profile: PROFILE, operationId: 'operation-1', actionId: p.actionId,
    state: 'committed', lastDenial: null,
    effects: [{ ordinal: 0, paymentId: 'payment-1', state: 'committed', receipt: current }] });
  assert.equal((await f.create().status('operation-1')).state, 'committed');
  f.control.onStatus = () => ({ profile: PROFILE, operationId: 'operation-1', actionId: p.actionId,
    state: 'committed', lastDenial: null,
    effects: [{ ordinal: 0, paymentId: 'payment-1', state: 'committed', receipt: receipt(preparation('old')) }] });
  assert.equal((await f.create().status('operation-1')).code, 'OUTCOME_UNKNOWN');
  assert.ok(f.requests.every(r => r.method === 'GET'));
});

test('multi-effect status verifies each ordinal and does not execute outstanding effects', async t => {
  const p = preparation('operation-1', 'grant-1', { effects: [transfer(), transfer('payment-2')] });
  const f = await setup(t, { onPrepare: () => p }), client = f.create();
  const prepared = await client.prepare('operation-1', 'grant-1');
  f.control.onStatus = () => ({ profile: PROFILE, operationId: 'operation-1', actionId: prepared.actionId,
    state: 'partially_committed', lastDenial: null, effects: [
      { ordinal: 0, paymentId: 'payment-1', state: 'committed', receipt: receipt(p) },
      { ordinal: 1, paymentId: 'payment-2', state: 'not_committed' },
    ] });
  const status = await client.status('operation-1');
  assert.equal(status.state, 'partially_committed');
  assert.equal(status.effects[0].receiptVerified, true);
  assert.equal(status.effects[1].receiptVerified, false);
  assert.equal(f.requests.filter(r => r.body?.kind === 'execute').length, 0);
});

test('malformed HTTP success, redirects and failures after POST never trigger a resend', async t => {
  const f = await setup(t);
  for (const [status, content] of [[200, 'not-json'], [200, '[]'], [200, '{}'],
    [200, JSON.stringify({ profile: PROFILE, padding: 'x'.repeat(MAX_ENVELOPE_BYTES) })], [307, ''], [400, ''], [401, ''], [503, '']]) {
    const client = f.create();
    f.control.onPrepare = (_body, res) => { res.writeHead(status, { location: `${f.config.baseUrl}/not-followed` }); res.end(content); };
    const before = f.requests.length;
    await assert.rejects(client.prepare('operation-1', 'grant-1'), { code: 'OUTCOME_UNKNOWN' });
    await assert.rejects(client.prepare('operation-1', 'grant-1'), { code: 'OUTCOME_UNKNOWN' });
    assert.equal(f.requests.slice(before).filter(r => r.method === 'POST').length, 1);
  }
  assert.ok(f.requests.every(r => r.path === '/api/matoi/transfers'));
});

test('a capability outage blocks new actions, while a pinned-key recovery read remains available', async t => {
  const f = await setup(t), p = preparation();
  const client = f.create({ issuerPublicKey: f.control.capabilities.issuerPublicKey });
  f.control.onCapabilities = (_req, res) => { res.writeHead(503); res.end(); };
  await assert.rejects(client.prepare('operation-1', 'grant-1'), { code: 'CAPABILITY_UNAVAILABLE' });
  f.control.onStatus = () => ({ profile: PROFILE, operationId: 'operation-1', actionId: p.actionId,
    state: 'committed', lastDenial: null,
    effects: [{ ordinal: 0, paymentId: 'payment-1', state: 'committed', receipt: receipt(p) }] });
  assert.equal((await client.status('operation-1')).state, 'committed');
  assert.ok(f.requests.every(r => r.method === 'GET'));
});

test('a native-policy denied preparation is verified and returned, but cannot be executed', async t => {
  const f = await setup(t, { onPrepare: () => preparation('operation-1', 'grant-1', { response: { state: 'denied' } }) });
  const client = f.create();
  const prepared = await client.prepare('operation-1', 'grant-1');
  assert.equal(prepared.state, 'denied');
  assert.ok(prepared.reviewUrl.includes(prepared.actionId));
  await assert.rejects(client.execute(prepared), { code: 'PREPARATION_DENIED' });
  assert.equal(f.requests.filter(r => r.body?.kind === 'execute').length, 0);
});

for (const kind of ['prepare', 'execute']) test(`uncertainty observed during ${kind} capability loading fences the unsent mutation`, async t => {
  const f = await setup(t), client = f.create();
  const prepared = kind === 'execute' ? await client.prepare('operation-1', 'grant-1') : null;
  const started = Promise.withResolvers(), released = Promise.withResolvers();
  f.control.onCapabilities = async () => { started.resolve(); await released.promise; return f.control.capabilities; };
  const pending = (kind === 'prepare' ? client.prepare('operation-1', 'grant-1') : client.execute(prepared))
    .then(value => ({ value }), error => ({ error }));
  await started.promise;
  const result = await client.status('operation-1');
  assert.equal(result.code, 'OUTCOME_UNKNOWN');
  released.resolve();
  assert.equal((await pending).error?.code, 'OUTCOME_UNKNOWN');
  assert.equal(f.requests.filter(r => r.body?.kind === kind).length, 0);
});

test('concurrent serialized preparations cannot borrow a receipt for different signed inputs', async t => {
  const f = await setup(t), client = f.create();
  const first = preparation(), second = preparation('operation-1', 'grant-2');
  const started = Promise.withResolvers(), released = Promise.withResolvers();
  f.control.onCapabilities = async () => { started.resolve(); await released.promise; return f.control.capabilities; };
  const pending = client.execute(first).then(value => ({ value }), error => ({ error }));
  await started.promise;
  const conflicting = client.execute(second).then(value => ({ value }), error => ({ error }));
  released.resolve();
  assert.equal((await conflicting).error?.code, 'OPERATION_CONFLICT');
  assert.equal((await pending).value.state, 'denied');
  assert.equal(f.requests.filter(r => r.body?.kind === 'execute').length, 1);
});

test('native apfp approval fingerprints bind preparation and committed receipt without normalization', async t => {
  const p = preparation('operation-1', 'grant-1', { response: { fingerprint: `apfp_${hash('native-approval')}` } });
  const f = await setup(t, { onPrepare: () => p }), client = f.create();
  f.control.onExecute = body => ({ profile: PROFILE, operationId: body.operationId,
    state: 'committed', receipt: receipt(p), projection: { state: 'current', causal_graph: { nodes: [] } } });
  const prepared = await client.prepare('operation-1', 'grant-1');
  assert.equal(prepared.fingerprint, p.fingerprint);
  const result = await client.execute(prepared);
  assert.equal(result.receipt.payload.actionFingerprint, p.fingerprint);
  assert.equal(result.state, 'committed');
  assert.equal(result.projection.state, 'unavailable');
  assert.equal(result.projection.scope, 'derived-view');
  assert.equal(result.projection.authorizesExecution, false);
  assert.equal(result.projection.causal_graph, undefined);
});

test('optional real ZeroGate passes stay signed opaque evidence, never automatic execution authority', async t => {
  const { buildActionPass } = await import('../../../packages/cava-core/src/action-pass.js');
  const pass = buildActionPass({ action_fingerprint: effectDigest(transfer()), agent_id: 'agent-1',
    principal_id: 'agent-1', workspace_id: 'org-1', risk: { class: 'high', score: 95 },
    commit_profile: { lane: 'slow', local_only: false, remote_verifier_required: true } });
  const p = preparation('operation-1', 'grant-1', { payload: { passes: [pass] } });
  const f = await setup(t, { onPrepare: () => p }), client = f.create();
  const prepared = await client.prepare('operation-1', 'grant-1');
  assert.deepEqual(prepared.lease.payload.passes, [pass]);
  assert.equal(prepared.state, 'awaiting_approval');
  assert.equal(f.requests.filter(r => r.body?.kind === 'execute').length, 0);
  assert.equal((await client.execute(prepared)).state, 'denied');
  assert.deepEqual(f.requests.find(r => r.body?.kind === 'execute').body.lease.payload.passes, [pass]);
  assert.deepEqual(f.signatureResults, [true, true]);
});

test('modified or malformed optional passes cannot be detached from the signed lease', async t => {
  const f = await setup(t);
  for (const passes of [[], 'unchecked', [null]]) {
    f.control.onPrepare = () => preparation('operation-1', 'grant-1', { payload: { passes } });
    await assert.rejects(f.create().prepare('operation-1', 'grant-1'), { code: 'OUTCOME_UNKNOWN' });
  }
  f.control.onPrepare = () => {
    const p = preparation('operation-1', 'grant-1', { payload: { passes: [{ pass_id: 'pass-1' }] } });
    p.lease.payload.passes[0].pass_id = 'substitution';
    return p;
  };
  await assert.rejects(f.create().prepare('operation-1', 'grant-1'), { code: 'OUTCOME_UNKNOWN' });
});

test('ready status restores a verified signed preparation after restart with no preparation resend', async t => {
  const f = await setup(t), p = preparation();
  f.control.onStatus = () => ({ profile: PROFILE, operationId: 'operation-1', actionId: p.actionId,
    state: 'ready', lastDenial: null, prepared: p,
    effects: [{ ordinal: 0, paymentId: 'payment-1', state: 'not_committed' }] });
  const client = f.create(), result = await client.status('operation-1');
  assert.equal(result.state, 'ready');
  assert.deepEqual(result.prepared.lease, p.lease);
  assert.ok(Object.isFrozen(result.prepared.lease.payload));
  assert.equal(result.prepared.reviewUrl, `${f.config.baseUrl}/approvals?action=${p.actionId}`);
  assert.ok(f.requests.every(r => r.method === 'GET'));
  assert.deepEqual(await client.prepare('operation-1', 'grant-1'), result.prepared);
  assert.ok(f.requests.every(r => r.method === 'GET'));
  assert.equal((await client.execute(result.prepared)).state, 'denied');
  assert.equal(f.requests.filter(r => r.body?.kind === 'prepare').length, 0);
});

test('status-provided preparation enables cold historical verification but cannot erase execute uncertainty', async t => {
  const f = await setup(t), p = preparation(), historical = receipt(preparation('operation-old'));
  f.control.onStatus = () => ({ profile: PROFILE, operationId: 'operation-1', actionId: p.actionId,
    state: 'committed', lastDenial: null, prepared: p,
    effects: [{ ordinal: 0, paymentId: 'payment-1', state: 'committed', receipt: historical }] });
  const cold = await f.create().status('operation-1');
  assert.equal(cold.state, 'committed');
  assert.equal(cold.effects[0].receipt.payload.operationId, 'operation-old');
  const client = f.create();
  f.control.onPrepare = () => p;
  f.control.onExecute = (_body, res) => { res.destroy(); };
  const prepared = await client.prepare('operation-1', 'grant-1');
  await assert.rejects(client.execute(prepared), { code: 'OUTCOME_UNKNOWN' });
  const recovered = await client.status('operation-1');
  assert.equal(recovered.state, 'committed');
  await assert.rejects(client.execute(recovered.prepared), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.requests.filter(r => r.body?.kind === 'execute').length, 1);
});

test('status-provided preparation must match prior tenant, operation, grant and native action bindings', async t => {
  const f = await setup(t), p = preparation();
  f.control.onPrepare = () => p;
  for (const invalid of [preparation('other-operation'), preparation('operation-1', 'other-grant'),
    preparation('operation-1', 'grant-1', { payload: { orgId: 'other-org' } }),
    preparation('operation-1', 'grant-1', { response: { fingerprint: hash('different-action') } })]) {
    const client = f.create();
    await client.prepare('operation-1', 'grant-1');
    f.control.onStatus = () => ({ profile: PROFILE, operationId: 'operation-1', actionId: p.actionId,
      state: 'ready', lastDenial: null, prepared: invalid,
      effects: [{ ordinal: 0, paymentId: 'payment-1', state: 'not_committed' }] });
    const result = await client.status('operation-1');
    assert.equal(result.code, 'OUTCOME_UNKNOWN');
    assert.equal(result.prepared, undefined);
  }
});

async function mcpFor(f) {
  const entry = new URL('../mcp.mjs', import.meta.url);
  assert.ok(existsSync(entry), 'the controlled-transfer-only MCP adapter must exist');
  const { createControlledTransferMcpServer } = await import(entry);
  return createControlledTransferMcpServer(f.config);
}

test('MCP exposes exactly three controlled-transfer tools and no generic execution or approval surface', async t => {
  const f = await setup(t), server = await mcpFor(f);
  const expected = ['osuite_transfer_prepare', 'osuite_transfer_execute', 'osuite_transfer_status'];
  assert.deepEqual(server.tools.map(tool => tool.name), expected);
  assert.deepEqual((await server.listTools()).tools, server.tools);
  const list = await server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map(tool => tool.name), expected);
  const initialized = await server.handleRequest({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  assert.match(initialized.result.instructions, /controlled-ledger/);
  assert.match(initialized.result.instructions, /not.*arbitrary MCP/i);
  assert.equal(f.requests.length, 0);
  for (const tool of server.tools) assert.equal(tool.inputSchema.additionalProperties, false);
});

test('MCP preserves held preparation and refusal without claiming an effect or revealing credentials', async t => {
  const f = await setup(t), server = await mcpFor(f);
  f.control.onPrepare = body => ({ ...preparation(body.operationId, body.grantId), debug: { apiKey: f.config.apiKey } });
  const held = await server.callTool('osuite_transfer_prepare', { operationId: 'operation-1', grantId: 'grant-1' });
  assert.equal(held.structuredContent.state, 'awaiting_approval');
  assert.equal(held.structuredContent.effect_executed, false);
  assert.ok(held.structuredContent.reviewUrl);
  assert.equal(f.requests.filter(r => r.body?.kind === 'execute').length, 0);
  const denied = await server.callTool('osuite_transfer_execute', { prepared: held.structuredContent });
  assert.equal(denied.structuredContent.state, 'denied');
  assert.equal(denied.structuredContent.code, 'AWAITING_APPROVAL');
  assert.equal(denied.structuredContent.effect_executed, false);
  assert.equal(denied.structuredContent.retryAutomatically, false);
  assert.equal(denied.isError, true);
  assert.ok(!JSON.stringify([held, denied]).includes(f.config.apiKey));
  assert.ok(!JSON.stringify([held, denied]).includes(f.config.privateKeyBase64));
  assert.equal(f.requests.filter(r => r.body?.kind === 'execute').length, 1);
});

test('MCP reports effect_executed true only for a newly verified commitment, never already_committed', async t => {
  const f = await setup(t), server = await mcpFor(f);
  f.control.onExecute = body => ({ profile: PROFILE, operationId: body.operationId,
    state: 'committed', receipt: receipt(f.prepared.get(body.operationId)) });
  const held = await server.callTool('osuite_transfer_prepare', { operationId: 'operation-1', grantId: 'grant-1' });
  const args = { prepared: held.structuredContent, ordinal: 0 };
  const result = await server.callTool('osuite_transfer_execute', args);
  assert.equal(result.structuredContent.effect_executed, true);
  assert.equal(result.structuredContent.state, 'committed');
  assert.equal(result.isError, undefined);
  const replay = await server.callTool('osuite_transfer_execute', args);
  assert.equal(replay.structuredContent.state, 'already_committed');
  assert.equal(replay.structuredContent.effect_executed, false);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.equal(f.requests.filter(r => r.body?.kind === 'execute').length, 1);
});

test('MCP unknown execution stays indeterminate and status recovery never resends', async t => {
  const f = await setup(t), server = await mcpFor(f);
  f.control.onExecute = (_body, res) => { res.destroy(); };
  const held = await server.callTool('osuite_transfer_prepare', { operationId: 'operation-1', grantId: 'grant-1' });
  const unknown = await server.callTool('osuite_transfer_execute', { prepared: held.structuredContent });
  assert.equal(unknown.structuredContent.code, 'OUTCOME_UNKNOWN');
  assert.equal(unknown.structuredContent.state, 'unknown');
  assert.equal(unknown.structuredContent.effect_executed, null);
  assert.equal(unknown.structuredContent.recovery.method, 'status');
  assert.equal(unknown.isError, true);
  const status = await server.callTool('osuite_transfer_status', { operationId: 'operation-1' });
  assert.equal(status.structuredContent.code, 'OUTCOME_UNKNOWN');
  assert.equal(status.structuredContent.effect_executed, null);
  await server.callTool('osuite_transfer_execute', { prepared: held.structuredContent });
  assert.equal(f.requests.filter(r => r.body?.kind === 'execute').length, 1);
});

test('MCP rejects unknown tools, extra arguments and callbacks before any network mutation', async t => {
  const f = await setup(t), server = await mcpFor(f);
  let called = false;
  for (const [name, args] of [['arbitrary_transfer', {}], ['osuite_transfer_prepare', { operationId: 'operation-1', grantId: 'grant-1', approve: true }],
    ['osuite_transfer_execute', { prepared: {}, execute() { called = true; } }], ['osuite_transfer_status', { operationId: '' }]]) {
    const result = await server.callTool(name, args);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.effect_executed, false);
  }
  assert.equal(called, false);
  assert.equal(f.requests.length, 0);
});

test('a failed preparation preflight cannot erase uncertainty learned during that request', async t => {
  const f = await setup(t), client = f.create();
  const started = Promise.withResolvers(), released = Promise.withResolvers();
  f.control.onCapabilities = async () => {
    started.resolve(); await released.promise;
    return { ...f.control.capabilities, configured: false };
  };
  const pending = client.prepare('operation-1', 'grant-1').then(value => ({ value }), error => ({ error }));
  await started.promise;
  assert.equal((await client.status('operation-1')).code, 'OUTCOME_UNKNOWN');
  released.resolve();
  assert.equal((await pending).error?.code, 'OUTCOME_UNKNOWN');
  f.control.onCapabilities = null;
  await assert.rejects(client.prepare('operation-1', 'grant-1'), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
});

test('rejected cold serialized input does not poison an unsent operation', async t => {
  const f = await setup(t), client = f.create(), invalid = preparation();
  invalid.lease.signature = 'x'.repeat(86);
  await assert.rejects(client.execute(invalid), { code: 'INVALID_PREPARATION' });
  const held = await client.prepare('operation-1', 'grant-1');
  assert.equal(held?.state, 'awaiting_approval');
  assert.equal(f.requests.filter(r => r.body?.kind === 'execute').length, 0);
  assert.equal(f.requests.filter(r => r.body?.kind === 'prepare').length, 1);
});

test('failed cold execute capability checks leave a clean unsent operation', async t => {
  const f = await setup(t), client = f.create();
  f.control.capabilities.resourceEnforced = false;
  await assert.rejects(client.execute(preparation()), { code: 'PROFILE_UNAVAILABLE' });
  f.control.capabilities.resourceEnforced = true;
  const held = await client.prepare('operation-1', 'grant-1');
  assert.equal(held?.state, 'awaiting_approval');
  assert.equal(f.requests.filter(r => r.body?.kind === 'execute').length, 0);
});

test('prepare cannot resolve undefined while a cold execute is in flight', async t => {
  const f = await setup(t), client = f.create();
  const started = Promise.withResolvers(), released = Promise.withResolvers();
  f.control.onCapabilities = async () => { started.resolve(); await released.promise; return f.control.capabilities; };
  const pending = client.execute(preparation());
  await started.promise;
  const preparing = client.prepare('operation-1', 'grant-1').then(value => ({ value }), error => ({ error }));
  released.resolve();
  const preparationResult = await preparing, executionResult = await pending;
  assert.equal(preparationResult.error?.code, 'EXECUTION_IN_PROGRESS');
  assert.equal(executionResult.state, 'denied');
  assert.equal(f.requests.filter(r => r.body?.kind === 'prepare').length, 0);
});

test('ready status cannot conceal a conflicting physical payment', async t => {
  const f = await setup(t), p = preparation();
  f.control.onStatus = () => ({ profile: PROFILE, operationId: p.operationId, actionId: p.actionId,
    state: 'ready', lastDenial: null, prepared: p,
    effects: [{ ordinal: 0, paymentId: 'payment-1', state: 'conflict' }] });
  const observed = await f.create().status('operation-1');
  assert.equal(observed.code, 'OUTCOME_UNKNOWN');
  assert.equal(observed.prepared, undefined);
});

test('status recovery binds current-operation receipts to the recovered signed preparation', async t => {
  const f = await setup(t), p = preparation();
  for (const changes of [{ preparationDigest: hash('other-preparation') }, { actionFingerprint: hash('other-action') },
    { grantId: 'other-grant' }, { effectDigest: hash('other-effect') }]) {
    f.control.onStatus = () => ({ profile: PROFILE, operationId: p.operationId, actionId: p.actionId,
      state: 'committed', lastDenial: null, prepared: p,
      effects: [{ ordinal: 0, paymentId: 'payment-1', state: 'committed', receipt: receipt(p, 0, changes) }] });
    const observed = await f.create().status('operation-1');
    assert.equal(observed.code, 'OUTCOME_UNKNOWN');
    assert.equal(observed.prepared, undefined);
  }
  assert.ok(f.requests.every(r => r.method === 'GET'));
});

test('read-only status can recover an expired original lease without enabling execution', async t => {
  const p = preparation('operation-1', 'grant-1', { payload: { issuedAt: Date.now() - 3000, expiresAt: Date.now() - 1000 } });
  const f = await setup(t), client = f.create();
  f.control.onStatus = () => ({ profile: PROFILE, operationId: p.operationId, actionId: p.actionId,
    state: 'committed', lastDenial: null, prepared: p,
    effects: [{ ordinal: 0, paymentId: 'payment-1', state: 'committed', receipt: receipt(p, 0, { committedAt: p.lease.payload.issuedAt + 100 }) }] });
  const observed = await client.status('operation-1');
  assert.equal(observed.state, 'committed');
  assert.deepEqual(observed.prepared.lease, p.lease);
  await assert.rejects(client.execute(observed.prepared), { code: 'INVALID_PREPARATION' });
  assert.ok(f.requests.every(r => r.method === 'GET'));
});

test('MCP rejects a null ordinal rather than defaulting it to a financial effect', async t => {
  const f = await setup(t), server = await mcpFor(f);
  const held = await server.callTool('osuite_transfer_prepare', { operationId: 'operation-1', grantId: 'grant-1' });
  const result = await server.callTool('osuite_transfer_execute', { prepared: held.structuredContent, ordinal: null });
  assert.equal(result.structuredContent.code, 'INVALID_ORDINAL');
  assert.equal(result.structuredContent.effect_executed, false);
  assert.equal(f.requests.filter(r => r.body?.kind === 'execute').length, 0);
});

test('MCP notifications and invalid protocol requests never dispatch mutations', async t => {
  const f = await setup(t), server = await mcpFor(f);
  const request = { jsonrpc: '2.0', method: 'tools/call', params: {
    name: 'osuite_transfer_prepare', arguments: { operationId: 'operation-1', grantId: 'grant-1' } } };
  assert.equal(await server.handleRequest(request), null);
  for (const invalid of [null, { ...request, id: {} }, { ...request, id: 1, jsonrpc: '1.0' }]) {
    assert.equal((await server.handleRequest(invalid)).error.code, -32600);
  }
  assert.equal((await server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'payments/execute' })).error.code, -32601);
  assert.equal(f.requests.length, 0);
});

test('status recovery during prepare preflight reuses the original lease without another prepare', async t => {
  const f = await setup(t), client = f.create({ issuerPublicKey: f.control.capabilities.issuerPublicKey }), p = preparation();
  const started = Promise.withResolvers(), released = Promise.withResolvers();
  f.control.onCapabilities = async () => { started.resolve(); await released.promise; return f.control.capabilities; };
  f.control.onStatus = () => ({ profile: PROFILE, operationId: p.operationId, actionId: p.actionId,
    state: 'ready', lastDenial: null, prepared: p, effects: [{ ordinal: 0, paymentId: 'payment-1', state: 'not_committed' }] });
  const pending = client.prepare('operation-1', 'grant-1');
  await started.promise;
  const observed = await client.status('operation-1');
  released.resolve();
  assert.deepEqual(await pending, observed.prepared);
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
});

test('execute cannot race an unresolved prepare for the same operation', async t => {
  const f = await setup(t), client = f.create({ issuerPublicKey: f.control.capabilities.issuerPublicKey });
  const started = Promise.withResolvers(), released = Promise.withResolvers();
  f.control.onCapabilities = async () => { started.resolve(); await released.promise; return f.control.capabilities; };
  const pending = client.prepare('operation-1', 'grant-1');
  await started.promise;
  const execution = client.execute(preparation()).then(value => ({ value }), error => ({ error }));
  released.resolve();
  const observed = await execution;
  await pending;
  assert.equal(observed.error?.code, 'PREPARATION_IN_PROGRESS');
  assert.equal(f.requests.filter(r => r.body?.kind === 'execute').length, 0);
});

async function gatedPreparation(operationId = 'operation-1', count = 1) {
  const { buildTransferPass, evaluateTransferPass } = await import('../../../packages/matoi-runtime/src/transfer/pass.mjs');
  const p = preparation(operationId, 'grant-1', { effects: Array.from({ length: count }, (_, i) => transfer(`payment-${i + 1}`)) });
  const payload = p.lease.payload;
  const binding = { orgId: payload.orgId, actorId: payload.actorId, keyId: payload.keyId,
    operationId, authorityEpoch: payload.authorityEpoch, grantEpoch: payload.grantEpoch,
    context: payload.context, evidenceDigest: payload.evidenceDigest };
  payload.passes = p.effects.map((effect, ordinal) => buildTransferPass({ ...binding, effect, grantId: p.grantId,
    ordinal, issuedAt: payload.issuedAt, expiresAt: payload.expiresAt }));
  p.lease = signEnvelope(payload);
  p.preparationDigest = hash(canonicalJson(payload));
  const gates = payload.passes.map((pass, ordinal) => {
    const admitted = evaluateTransferPass({ ...binding, effect: p.effects[ordinal], pass, now: Date.now(),
      receiptPersisted: true, nativeApprovalVerified: true });
    assert.equal(admitted.decision, 'execute');
    return { lane: admitted.lane, admissionSequence: String(ordinal + 1), coreReceipt: admitted.receipt };
  });
  return { p, gate: gates[0], gates };
}

test('advertised 64-effect native signed status recovers the original preparation above 256 KiB', async t => {
  const { p, gates } = await gatedPreparation('operation-64', 64);
  p.fingerprint = `apfp_${p.fingerprint}`;
  const body = { profile: PROFILE, operationId: p.operationId, actionId: p.actionId,
    state: 'committed', lastDenial: null, prepared: p,
    effects: p.effects.map((effect, ordinal) => ({ ordinal, paymentId: effect.paymentId,
      state: 'committed', receipt: receipt(p, ordinal, { gate: gates[ordinal] }) })) };
  const bytes = Buffer.byteLength(JSON.stringify(body));
  t.diagnostic(`Signed 64-effect status envelope: ${bytes} bytes`);
  assert.ok(bytes > 262144 && bytes < MAX_ENVELOPE_BYTES);
  const f = await setup(t, { onStatus: () => body }), client = f.create();
  const status = await client.status(p.operationId);
  assert.equal(status.state, 'committed', `Recovery failed: ${status.code}/${status.reason}`);
  assert.equal(status.effects.length, 64);
  assert.ok(status.effects.every(effect => effect.receiptVerified));
  assert.deepEqual(status.prepared.lease, p.lease);
  assert.deepEqual((await client.prepare(p.operationId, p.grantId)).lease, p.lease);
  assert.deepEqual(f.requests.map(request => request.method), ['GET', 'GET']);
});

test('a status response above 1 MiB stays unknown and cannot authorize a resend', async t => {
  const f = await setup(t, { onStatus: () => ({ profile: PROFILE, padding: 'x'.repeat(MAX_ENVELOPE_BYTES) }) });
  const client = f.create(), status = await client.status('operation-1');
  assert.equal(status.code, 'OUTCOME_UNKNOWN');
  assert.equal(status.reason, 'invalid_response');
  await assert.rejects(client.prepare('operation-1', 'grant-1'), { code: 'OUTCOME_UNKNOWN' });
  assert.deepEqual(f.requests.map(request => request.method), ['GET']);
});

test('signed receipt gate retains the real ZeroGate slow review and binds the selected signed pass', async t => {
  const { p, gate } = await gatedPreparation(), f = await setup(t, { onPrepare: () => p }), client = f.create();
  f.control.onExecute = () => ({ profile: PROFILE, operationId: p.operationId, state: 'committed', receipt: receipt(p, 0, { gate }) });
  const result = await client.execute(await client.prepare(p.operationId, p.grantId));
  assert.equal(result.state, 'committed');
  assert.deepEqual(result.receipt.payload.gate, gate);
  assert.equal(gate.coreReceipt.decision, 'review');
  assert.equal(gate.coreReceipt.lane, 'slow');
});

test('invalid optional receipt gates stay unknown even when signed by the configured owner', async t => {
  const { p, gate } = await gatedPreparation(), f = await setup(t, { onPrepare: () => p });
  for (const changed of [{ ...gate, lane: 'fast' }, { ...gate, admissionSequence: 1 }, { ...gate, admissionSequence: '01' },
    { ...gate, coreReceipt: null }, { ...gate, unsignedExtension: true },
    ...[{ decision: 'execute' }, { sequence_number: 1 }, { pass_id: 'another-pass' }, { pass_hash: hash('other-pass') },
      { action_fingerprint: hash('other-action') }].map(change => {
      const { receipt_hash: _hash, ...core } = { ...gate.coreReceipt, ...change };
      return { ...gate, coreReceipt: { ...core, receipt_hash: hash(canonicalJson(core)) } };
    }), { ...gate, coreReceipt: { ...gate.coreReceipt, receipt_hash: hash('wrong-hash') } }]) {
    const client = f.create();
    f.control.onExecute = () => ({ profile: PROFILE, operationId: p.operationId,
      state: 'committed', receipt: receipt(p, 0, { gate: changed }) });
    await assert.rejects(client.execute(await client.prepare(p.operationId, p.grantId)), { code: 'OUTCOME_UNKNOWN' });
  }
});

test('historical signed gates bind their original pass without attributing a new current effect', async t => {
  const current = await gatedPreparation(), historical = await gatedPreparation('older-operation');
  const f = await setup(t, { onPrepare: () => current.p }), client = f.create();
  f.control.onExecute = () => ({ profile: PROFILE, operationId: current.p.operationId,
    state: 'already_committed', receipt: receipt(historical.p, 0, { gate: historical.gate }) });
  const result = await client.execute(await client.prepare(current.p.operationId, current.p.grantId));
  assert.equal(result.state, 'already_committed');
  assert.equal(result.newlyCommitted, false);
  assert.deepEqual(result.receipt.payload.gate, historical.gate);
});

test('post-execution response enrichment failure is unknown for all coalesced callers and cannot resend', async t => {
  const f = await setup(t), client = f.create();
  const prepared = await client.prepare('operation-1', 'grant-1');
  f.control.onExecute = body => {
    const result = { profile: PROFILE, operationId: body.operationId, state: 'committed', receipt: receipt(prepared), padding: '' };
    result.padding = 'x'.repeat(MAX_ENVELOPE_BYTES - 24 - Buffer.byteLength(JSON.stringify(result)));
    return result;
  };
  const results = await Promise.allSettled([client.execute(prepared), client.execute(prepared)]);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason.code, 'OUTCOME_UNKNOWN');
  }
  await assert.rejects(client.execute(prepared), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.requests.filter(r => r.body?.kind === 'execute').length, 1);
});
