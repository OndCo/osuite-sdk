import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, sha256 } from '../../runtime/protocol.mjs';
import { verifyPreparation, verifyReceipt } from '../verification.mjs';
import { FULL, COMPACT, BUILDER, makeEffect, makePreparation, makeReceipt, resignPreparation,
  rehashGate, signed, publicPem, publicIssuer, verificationContext, effectDigest } from './compact-fixture.mjs';

const checkPreparation = (value, overrides = {}) => verifyPreparation(value, verificationContext(value, overrides));
const checkReceipt = (receipt, prepared, overrides = {}) => verifyReceipt(receipt,
  { ...verificationContext(prepared), prepared, ordinal: 0, ...overrides });
const invalidPreparation = value => assert.throws(() => checkPreparation(value), { code: 'INVALID_PREPARATION' });

for (const format of [FULL, COMPACT]) {
  test(`historical ${format} receipt must use its original source issuer, not another trusted key`, () => {
    const source = makePreparation('original-issuer', { format, signer: 'old', count: 1 });
    const context = verificationContext(source, { historical: true });
    context.config.trustedIssuerPublicKeys = [publicPem('old')];
    const prepared = verifyPreparation(source, { ...context, checkExpiry: false });
    const original = makeReceipt(source, 0, { signer: 'old' });
    assert.deepEqual(verifyReceipt(original, { ...context, prepared, sourcePrepared: prepared, ordinal: 0 }), original);
    const substituted = makeReceipt(source, 0, { signer: 'current' });
    for (const includeSource of [false, true]) {
      assert.throws(() => verifyReceipt(substituted, { ...context, prepared, ordinal: 0,
        ...(includeSource ? { sourcePrepared: prepared } : {}) }), { code: 'INVALID_RECEIPT' });
    }
  });

  test(`earlier ${format} source issuer binds history independently of the new target issuer`, () => {
    const source = makePreparation('prior-issuer', { format, signer: 'old', count: 2 });
    const target = makePreparation('new-issuer', { format, effects: [source.effects[1]] });
    const context = verificationContext(target, { historical: true });
    context.config.trustedIssuerPublicKeys = [publicPem('old')];
    const prepared = verifyPreparation(target, context);
    const options = { ...context, prepared, sourcePrepared: source, ordinal: 0 };
    const original = makeReceipt(source, 1, { signer: 'old' });
    assert.deepEqual(verifyReceipt(original, options), original);
    assert.throws(() => verifyReceipt(makeReceipt(source, 1, { signer: 'current' }), options), { code: 'INVALID_RECEIPT' });
  });
}

for (const count of [1, 64]) test(`compact preparation verifies ${count} exact ordered effects and returns an alias-free frozen snapshot`, () => {
  const original = makePreparation(`vector-${count}`, { count });
  const verified = checkPreparation(original);
  assert.deepEqual(verified, original);
  assert.equal(verified.profile, FULL);
  assert.equal(verified.lease.payload.profile, COMPACT);
  assert.equal(verified.lease.payload.transferProfile, FULL);
  assert.equal(verified.lease.payload.passBuilder, BUILDER);
  assert.equal(Object.hasOwn(verified.lease.payload, 'passes'), false);
  assert.equal(verified.preparationDigest, sha256(canonicalJson(verified.lease.payload)));
  assert.notEqual(verified.effects[0], original.effects[0]);
  assert.notEqual(verified.lease.payload.passCommitments[0], original.lease.payload.passCommitments[0]);
  assert.ok(Object.isFrozen(verified.lease.payload.context));
  assert.ok(Object.isFrozen(verified.lease.payload.passCommitments));
  assert.ok(Object.isFrozen(verified.lease.payload.passCommitments[0]));
  original.lease.payload.passCommitments[0].passHash = sha256('changed');
  original.effects[0].amountMinor = '1';
  assert.notEqual(verified.lease.payload.passCommitments[0].passHash, original.lease.payload.passCommitments[0].passHash);
  assert.equal(verified.effects[0].amountMinor, '10000000000000000001');
  const receipt = makeReceipt(verified, count - 1);
  assert.deepEqual(checkReceipt(receipt, verified, { ordinal: count - 1 }), receipt);
});

const fields = ['profile', 'transferProfile', 'passBuilder', 'id', 'orgId', 'actorId', 'keyId', 'grantId',
  'operationId', 'grantEpoch', 'authorityEpoch', 'issuedAt', 'expiresAt', 'issuer', 'workflowDigest',
  'evidenceDigest', 'effectDigests', 'context', 'passCommitments'];
for (const field of fields) test(`compact preparation refuses signed payload missing ${field}`, () => {
  const value = makePreparation();
  delete value.lease.payload[field];
  invalidPreparation(resignPreparation(value));
});

const payloadMutations = [
  ['unknown lease profile', p => { p.profile = 'matoi.controlled-transfer.lease.v3'; }],
  ['full compact hybrid', p => { p.profile = FULL; }],
  ['compact semantic profile', p => { p.transferProfile = COMPACT; }],
  ['unknown builder', p => { p.passBuilder = 'matoi.controlled-transfer.pass.v2'; }],
  ['extra field', p => { p.extra = true; }],
  ['expanded passes', p => { p.passes = []; }],
  ['invalid lease ID', p => { p.id = 'toJSON'; }],
  ['foreign org', p => { p.orgId = 'foreign-org'; }],
  ['foreign actor', p => { p.actorId = 'foreign-actor'; }],
  ['foreign credential', p => { p.keyId = 'foreign-key'; }],
  ['foreign grant', p => { p.grantId = 'foreign-grant'; }],
  ['foreign operation', p => { p.operationId = 'foreign-operation'; }],
  ['noncanonical epoch', p => { p.grantEpoch = '01'; }],
  ['numeric epoch', p => { p.authorityEpoch = 2; }],
  ['overlong epoch', p => { p.authorityEpoch = '9'.repeat(39); }],
  ['negative issued time', p => { p.issuedAt = -1; }],
  ['negative zero time', p => { p.issuedAt = -0; }],
  ['string time', p => { p.issuedAt = String(p.issuedAt); }],
  ['unsafe time', p => { p.expiresAt = Number.MAX_SAFE_INTEGER + 1; }],
  ['invalid Date range', p => { p.expiresAt = Number.MAX_SAFE_INTEGER; }],
  ['reversed times', p => { p.expiresAt = p.issuedAt; }],
  ['overlong lease lifetime', p => { p.expiresAt = p.issuedAt + 300001; }],
  ['future issuance', p => { p.issuedAt = Date.now() + 60000; p.expiresAt = p.issuedAt + 60000; }],
  ['expired lease', p => { p.issuedAt = Date.now() - 2000; p.expiresAt = Date.now() - 1000; }],
  ['wrong issuer', p => { p.issuer = sha256('other-issuer'); }],
  ['upper-case workflow digest', p => { p.workflowDigest = p.workflowDigest.toUpperCase(); }],
  ['nonhex evidence', p => { p.evidenceDigest = 'g'.repeat(64); }],
  ['effect count mismatch', p => { p.effectDigests.pop(); }],
  ['reordered effect hashes', p => { p.effectDigests.reverse(); }],
  ['unknown effect hash', p => { p.effectDigests[0] = sha256('different-effect'); }],
  ['context missing key', p => { delete p.context.config_sha256; }],
  ['context extra key', p => { p.context.extra = sha256('extra'); }],
  ['context invalid digest', p => { p.context.config_sha256 = 'config'; }],
  ['context workflow mismatch', p => { p.context.artifact_sha256 = sha256('other-workflow'); }],
  ['context evidence mismatch', p => { p.context.dependencies_sha256 = sha256('other-evidence'); }],
  ['no commitments', p => { p.passCommitments = []; }],
  ['non-array commitments', p => { p.passCommitments = {}; }],
  ['commitment count mismatch', p => { p.passCommitments.pop(); }],
  ['duplicate pass hashes', p => { p.passCommitments[1].passHash = p.passCommitments[0].passHash; }],
  ['invalid pass ID', p => { p.passCommitments[0].passId = 'pass-one'; }],
  ['long pass ID', p => { p.passCommitments[0].passId += '0'; }],
  ['uppercase pass hash', p => { p.passCommitments[0].passHash = p.passCommitments[0].passHash.toUpperCase(); }],
  ['invalid action fingerprint', p => { p.passCommitments[0].actionFingerprint = 'apfp_' + sha256('action'); }],
  ...['passHash', 'passId', 'actionFingerprint'].map(key => [`missing commitment ${key}`, p => { delete p.passCommitments[0][key]; }]),
  ['extra commitment key', p => { p.passCommitments[0].ordinal = 0; }],
];
for (const [label, mutate] of payloadMutations) test(`compact preparation refuses ${label} even with an owner signature`, () => {
  const value = makePreparation();
  mutate(value.lease.payload);
  invalidPreparation(resignPreparation(value));
});

test('compact envelope and preparation digest are exact and signature tails are canonical', () => {
  for (const mutate of [
    p => { p.lease.extra = true; }, p => { delete p.lease.signature; },
    p => { p.preparationDigest = sha256(canonicalJson(p.lease)); },
    p => { p.preparationDigest = sha256(canonicalJson(p.lease.payload.passCommitments)); },
    p => { p.lease.signature += '='; },
    p => { p.lease.signature = signed(p.lease.payload, 'foreign').signature; },
    p => { p.lease.payload.context.config_sha256 = sha256('unsigned'); },
    p => {
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      const original = p.lease.signature;
      p.lease.signature = original.slice(0, -1) + alphabet[alphabet.indexOf(original.at(-1)) + 1];
      assert.deepEqual(Buffer.from(p.lease.signature, 'base64url'), Buffer.from(original, 'base64url'));
    },
  ]) {
    const prepared = makePreparation();
    mutate(prepared);
    invalidPreparation(prepared);
  }
});

test('compact identifiers retain both SDK and native predicates, with exact maximum identifiers and epochs', () => {
  const maximum = 'a'.repeat(128), p = makePreparation(maximum, { grantId: maximum, count: 64 });
  const lease = p.lease.payload;
  Object.assign(lease, { id: '_' + 'b'.repeat(127), orgId: maximum, actorId: maximum, keyId: maximum,
    grantEpoch: '9'.repeat(38), authorityEpoch: '0', expiresAt: lease.issuedAt + 300000 });
  for (const [i, effect] of p.effects.entries()) {
    for (const name of ['sourceAccount', 'destination', 'asset', 'network']) effect[name] = maximum;
    effect.paymentId = `p${String(i).padStart(127, '0')}`;
    effect.amountMinor = '9'.repeat(38);
    effect.decimals = 18;
  }
  lease.effectDigests = p.effects.map(effectDigest);
  resignPreparation(p);
  const context = { config: { orgId: maximum, agentId: maximum, keyId: maximum, trustedIssuerPublicKeys: [] } };
  assert.equal(checkPreparation(p, context).effects[63].amountMinor, '9'.repeat(38));
  for (const field of ['orgId', 'actorId', 'keyId', 'grantId', 'operationId']) {
    const changed = makePreparation();
    changed.lease.payload[field] = '_native-disallowed';
    if (field === 'grantId' || field === 'operationId') changed[field] = '_native-disallowed';
    resignPreparation(changed);
    const config = { ...verificationContext(changed).config };
    if (field === 'orgId') config.orgId = '_native-disallowed';
    if (field === 'actorId') config.agentId = '_native-disallowed';
    if (field === 'keyId') config.keyId = '_native-disallowed';
    assert.throws(() => checkPreparation(changed, { config }), { code: 'INVALID_PREPARATION' });
  }
});

test('compact effects reject duplicate payment IDs and noncanonical money without increasing the 64-effect limit', () => {
  for (const mutate of [
    p => { p.effects[1].paymentId = p.effects[0].paymentId; },
    ...[0, 123, '0', '-1', '01', '1.5', '9'.repeat(39)].map(value => p => { p.effects[0].amountMinor = value; }),
    ...[-1, 19, '2', 0.5].map(value => p => { p.effects[0].decimals = value; }),
    p => { p.effects[0].memo = 'outside-profile'; },
    p => { p.effects.reverse(); },
  ]) {
    const prepared = makePreparation();
    mutate(prepared);
    if (prepared.effects[0].paymentId === 'payment-operation-compact-0') {
      prepared.lease.payload.effectDigests = prepared.effects.map(effectDigest);
    }
    invalidPreparation(resignPreparation(prepared));
  }
  invalidPreparation(makePreparation('too-many', { count: 65 }));
  invalidPreparation(makePreparation('empty', { count: 0 }));
});

test('compact preparation inspection does not execute caller code or admit sparse, hidden or decorated data', () => {
  let calls = 0;
  const proxy = () => new Proxy({}, { get() { calls++; throw new Error(); },
    getPrototypeOf() { calls++; throw new Error(); }, ownKeys() { calls++; throw new Error(); } });
  for (const mutate of [
    p => Object.defineProperty(p.lease.payload, 'passCommitments', { enumerable: true, get() { calls++; return []; } }),
    p => { p.lease = proxy(); },
    p => { p.lease.payload.passCommitments[0] = proxy(); },
    p => { delete p.lease.payload.passCommitments[0]; },
    p => { p.lease.payload.passCommitments.extra = true; },
    p => { p.lease.payload.context[Symbol('extra')] = true; },
    p => Object.defineProperty(p.effects[0], 'hidden', { value: true }),
    p => { Object.setPrototypeOf(p.lease.payload.passCommitments, null); },
    p => { p.lease.payload.context.toJSON = () => { calls++; return {}; }; },
  ]) {
    const prepared = makePreparation();
    mutate(prepared);
    invalidPreparation(prepared);
  }
  assert.equal(calls, 0);
});

test('compact historical verification accepts expired original leases but never fresh issuance by a historical root', () => {
  const p = makePreparation('old-operation', { signer: 'old' });
  const lease = p.lease.payload;
  lease.issuedAt = Date.now() - 301000;
  lease.expiresAt = lease.issuedAt + 300000;
  resignPreparation(p, 'old');
  const config = { ...verificationContext(p).config, trustedIssuerPublicKeys: [publicPem('old')] };
  assert.doesNotThrow(() => checkPreparation(p, { config, historical: true, checkExpiry: false }));
  assert.throws(() => checkPreparation(p, { config, historical: false, checkExpiry: false }), { code: 'INVALID_PREPARATION' });
  assert.throws(() => checkPreparation(p, { historical: true, checkExpiry: false }), { code: 'INVALID_PREPARATION' });
  assert.throws(() => checkPreparation(p, { config, issuer: publicIssuer('old') }), { code: 'INVALID_PREPARATION' });
});

test('compact same-source receipts require the signed gate even when historical verification is requested', () => {
  const prepared = makePreparation(), receipt = makeReceipt(prepared, 0, { gate: false });
  for (const historical of [false, true]) {
    assert.throws(() => checkReceipt(receipt, prepared, { historical }), { code: 'INVALID_RECEIPT' });
  }
});

const gateMutations = [
  ['pass ID', gate => { gate.coreReceipt.pass_id = 'ap_' + '1'.repeat(24); }],
  ['pass body hash', gate => { gate.coreReceipt.pass_hash = sha256('not-the-committed-body'); }],
  ['action fingerprint', gate => { gate.coreReceipt.action_fingerprint = sha256('wrong-action'); }],
  ['sequence', gate => { gate.coreReceipt.sequence_number = 1; }],
  ['core decision', gate => { gate.coreReceipt.decision = 'execute'; }],
  ['core lane', gate => { gate.coreReceipt.lane = 'fast'; }],
  ['core reason', gate => { gate.coreReceipt.reason = 'approved'; }],
  ['core extra', gate => { gate.coreReceipt.extra = true; }],
  ['noncanonical ISO', gate => { gate.coreReceipt.observed_at = gate.coreReceipt.observed_at.replace('.000Z', 'Z') + ' '; }],
  ['outer lane', gate => { gate.lane = 'fast'; }],
  ['admission sequence type', gate => { gate.admissionSequence = 1; }],
  ['admission sequence zeros', gate => { gate.admissionSequence = '01'; }],
  ['outer extra', gate => { gate.extra = true; }],
];
for (const [label, mutate] of gateMutations) test(`compact receipt refuses ${label} with a recomputed core hash and valid financial signature`, () => {
  const prepared = makePreparation(), receipt = makeReceipt(prepared);
  mutate(receipt.payload.gate);
  rehashGate(receipt.payload.gate);
  assert.throws(() => checkReceipt(signed(receipt.payload), prepared), { code: 'INVALID_RECEIPT' });
});

test('compact receipt checks the original core hash, time bounds, source ordinal and complete commitment tuple', () => {
  const prepared = makePreparation();
  for (const mutate of [
    p => { p.gate.coreReceipt.receipt_hash = sha256('bad-hash'); },
    p => { delete p.gate.coreReceipt.pass_hash; rehashGate(p.gate); },
    p => { p.gate.coreReceipt.observed_at = new Date(prepared.lease.payload.issuedAt - 1).toISOString(); rehashGate(p.gate); },
    p => { p.gate.coreReceipt.observed_at = new Date(p.committedAt + 1).toISOString(); rehashGate(p.gate); },
    p => { p.committedAt = prepared.lease.payload.expiresAt; },
    p => { p.preparationDigest = sha256('other-preparation'); },
    p => { p.gate = makeReceipt(prepared, 1).payload.gate; p.gate.coreReceipt.sequence_number = 0; rehashGate(p.gate); },
  ]) {
    const receipt = makeReceipt(prepared);
    mutate(receipt.payload);
    assert.throws(() => checkReceipt(signed(receipt.payload), prepared), { code: 'INVALID_RECEIPT' });
  }
  const reordered = structuredClone(prepared);
  reordered.lease.payload.passCommitments.reverse();
  resignPreparation(reordered);
  const mismatched = makeReceipt(prepared, 0, { changes: { preparationDigest: reordered.preparationDigest } });
  assert.throws(() => checkReceipt(mismatched, reordered), { code: 'INVALID_RECEIPT' });
});

test('compact historical receipts use their source preparation and ordinal rather than the current operation entry', () => {
  const shared = makeEffect('shared-payment');
  const original = makePreparation('original', { effects: [makeEffect('unrelated-payment'), shared] });
  const current = makePreparation('current', { effects: [shared] }), receipt = makeReceipt(original, 1);
  const options = { historical: true, sourcePrepared: original };
  assert.deepEqual(checkReceipt(receipt, current, options), receipt);
  for (const mutate of [
    p => { delete p.gate; },
    p => { p.gate.coreReceipt.pass_hash = current.lease.payload.passCommitments[0].passHash; rehashGate(p.gate); },
    p => { p.gate.coreReceipt.pass_id = original.lease.payload.passCommitments[0].passId; rehashGate(p.gate); },
    p => { p.preparationDigest = sha256('wrong-source'); },
    p => { p.actionId = current.actionId; },
    p => { p.evidenceDigest = sha256('wrong-evidence'); },
    p => { p.grantEpoch = '9'; },
    p => { p.authorityEpoch = '9'; },
  ]) {
    const changed = structuredClone(receipt.payload);
    mutate(changed);
    assert.throws(() => checkReceipt(signed(changed), current, options), { code: 'INVALID_RECEIPT' });
  }
  assert.throws(() => checkReceipt(receipt, current, { historical: true, sourcePrepared: current }), { code: 'INVALID_RECEIPT' });
  const invalidSource = structuredClone(original);
  invalidSource.lease.signature = signed(invalidSource.lease.payload, 'foreign').signature;
  assert.throws(() => checkReceipt(receipt, current, { historical: true, sourcePrepared: invalidSource }), { code: 'INVALID_RECEIPT' });
});

test('legacy v1 optional passes, gate and context rules are not tightened by compact support', () => {
  const shared = makeEffect('old-payment');
  const old = makePreparation('old-full', { format: FULL, effects: [makeEffect('other-payment'), shared],
    payload: { context: { artifact_sha256: sha256('legacy-workflow-context'), config_sha256: sha256('config'),
      dependencies_sha256: sha256('legacy-evidence-context') } } });
  old.lease.payload.expiresAt = old.lease.payload.issuedAt + 300100;
  resignPreparation(old);
  assert.doesNotThrow(() => checkPreparation(old));
  assert.doesNotThrow(() => checkReceipt(makeReceipt(old, 1), old, { ordinal: 1 }));
  const current = makePreparation('current-compact', { effects: [shared] }), receipt = makeReceipt(old, 1);
  assert.deepEqual(checkReceipt(receipt, current, { historical: true, sourcePrepared: old }), receipt);
  assert.deepEqual(checkReceipt(receipt, current, { historical: true }), receipt);
  old.lease.payload.passes = old.effects.map((_, i) => ({ pass_id: `legacy-pass-${i}`, pass_hash: sha256(`legacy-${i}`),
    action_binding: { allowed_fingerprint: sha256(`legacy-action-${i}`) } }));
  resignPreparation(old);
  assert.doesNotThrow(() => checkPreparation(old));
  assert.doesNotThrow(() => checkReceipt(makeReceipt(old, 1, { gate: true }), old, { ordinal: 1 }));
  const hybrid = structuredClone(old);
  hybrid.lease.payload.passCommitments = makePreparation().lease.payload.passCommitments;
  invalidPreparation(resignPreparation(hybrid));
});
