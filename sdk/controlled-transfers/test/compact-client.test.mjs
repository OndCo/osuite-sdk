import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { FULL, COMPACT, compactOptions, fullOptions, createFixture, makePreparation, makeReceipt,
  makeEffect, signed, rehashGate, settled, publicPem } from './compact-fixture.mjs';

test('compact prepare signs the explicit selector while all full calls retain the original wire shape', async () => {
  const f = createFixture({ config: { leaseFormat: COMPACT } });
  const prepared = await f.client.prepare('compact', 'grant', compactOptions);
  assert.equal(prepared.lease.payload.profile, COMPACT);
  assert.equal(prepared.profile, FULL);
  const [request] = f.posts('compact');
  assert.equal(request.body.leaseFormat, COMPACT);
  assert.equal(request.body.profile, FULL);
  assert.deepEqual(Object.keys(request.body).sort(), ['agent_id', 'grantId', 'kind', 'leaseFormat', 'operationId', 'profile', 'timestamp'].sort());
  assert.equal(Object.keys(request.headers).some(key => /lease|compact/i.test(key)), false);
  for (const [i, options] of [undefined, {}, fullOptions, Object.create(null)].entries()) {
    const full = await f.client.prepare(`full-${i}`, 'grant', options);
    assert.equal(full.lease.payload.profile, FULL);
    assert.deepEqual(Object.keys(f.posts(`full-${i}`)[0].body).sort(),
      ['agent_id', 'grantId', 'kind', 'operationId', 'profile', 'timestamp'].sort());
  }
});

test('compact prepare refuses legacy or write-disabled capabilities locally without downgrade', async () => {
  for (const [formats, code] of [
    [undefined, 'LEASE_FORMAT_UNSUPPORTED'],
    [{ supported: [FULL], default: FULL, compactIssuanceEnabled: false }, 'LEASE_FORMAT_UNSUPPORTED'],
    [{ supported: [FULL, COMPACT], default: FULL, compactIssuanceEnabled: false }, 'COMPACT_LEASE_ISSUANCE_DISABLED'],
  ]) {
    const f = createFixture();
    if (formats) f.control.capabilities.leaseFormats = formats;
    else delete f.control.capabilities.leaseFormats;
    await assert.rejects(f.client.prepare('new-compact', 'grant', compactOptions), { code });
    assert.equal(f.posts().length, 0);
    assert.equal((await f.client.prepare('new-full', 'grant')).lease.payload.profile, FULL);
  }
});

test('compact format errors do not hide normal capability, current issuer or resource readiness failures', async () => {
  for (const [patch, code] of [
    [{ configured: false }, 'PROFILE_UNAVAILABLE'], [{ resourceEnforced: false }, 'PROFILE_UNAVAILABLE'],
    [{ issuerPublicKey: publicPem('foreign') }, 'CAPABILITY_MISMATCH'],
    [{ profile: COMPACT }, 'CAPABILITY_MISMATCH'],
  ]) {
    const f = createFixture();
    delete f.control.capabilities.leaseFormats;
    Object.assign(f.control.capabilities, patch);
    await assert.rejects(f.client.prepare('new-compact', 'grant', compactOptions), { code });
    assert.equal(f.posts().length, 0);
  }
  const f = createFixture();
  f.control.onCapabilities = () => new Response(null, { status: 404 });
  await assert.rejects(f.client.prepare('unavailable', 'grant', compactOptions), { code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal(f.posts().length, 0);
});

test('compact prepare options are inspected defensively and rejected before any I/O', async () => {
  const f = createFixture();
  let calls = 0;
  const options = [null, [], COMPACT, 1, () => {}, { leaseFormat: undefined }, { leaseFormat: null },
    { leaseFormat: 'compact' }, { leaseFormat: COMPACT.toUpperCase() }, { extra: true },
    { leaseFormat: COMPACT, extra: true }, Object.create({ leaseFormat: COMPACT }),
    Object.defineProperty({}, 'leaseFormat', { enumerable: true, get() { calls++; return COMPACT; } }),
    Object.defineProperty({}, 'leaseFormat', { value: COMPACT }),
    { [Symbol('leaseFormat')]: COMPACT },
    new Proxy({}, { get() { calls++; throw new Error(); }, ownKeys() { calls++; throw new Error(); },
      getPrototypeOf() { calls++; throw new Error(); } }),
  ];
  for (const value of options) await assert.rejects(f.client.prepare('invalid', 'grant', value), { code: 'INVALID_PREPARE_OPTIONS' });
  assert.equal(calls, 0);
  assert.equal(f.requests.length, 0);
});

test('compact prepare preserves operation ID, grant ID, unknown, options, grant conflict and format conflict precedence', async () => {
  const f = createFixture();
  let calls = 0;
  const hostile = Object.defineProperty({}, 'leaseFormat', { enumerable: true, get() { calls++; return COMPACT; } });
  await assert.rejects(f.client.prepare('', '', hostile), { code: 'INVALID_OPERATION_ID' });
  await assert.rejects(f.client.prepare('valid', '', hostile), { code: 'INVALID_GRANT_ID' });
  assert.equal((await f.client.status('unknown')).state, 'unknown');
  await assert.rejects(f.client.prepare('unknown', '', hostile), { code: 'INVALID_GRANT_ID' });
  await assert.rejects(f.client.prepare('unknown', 'other-grant', hostile), { code: 'OUTCOME_UNKNOWN' });
  await f.client.prepare('known', 'grant');
  await assert.rejects(f.client.prepare('known', 'other-grant', hostile), { code: 'INVALID_PREPARE_OPTIONS' });
  await assert.rejects(f.client.prepare('known', 'other-grant', compactOptions), { code: 'OPERATION_CONFLICT' });
  await assert.rejects(f.client.prepare('known', 'grant', compactOptions), { code: 'LEASE_FORMAT_CONFLICT' });
  assert.equal(calls, 0);
  assert.equal(f.posts().length, 1);
});

for (const initial of [FULL, COMPACT]) test(`compact options snapshot and pending ${initial} identity cannot race a second prepare`, async () => {
  const f = createFixture(), entered = Promise.withResolvers(), released = Promise.withResolvers();
  f.control.onCapabilities = async value => { entered.resolve(); await released.promise; return value; };
  const options = { leaseFormat: initial }, other = initial === FULL ? COMPACT : FULL;
  const first = settled(f.client.prepare('pending', 'grant', options));
  await entered.promise;
  options.leaseFormat = other;
  options.extra = true;
  const same = settled(f.client.prepare('pending', 'grant', { leaseFormat: initial }));
  const conflict = settled(f.client.prepare('pending', 'grant', { leaseFormat: other }));
  const differentGrant = settled(f.client.prepare('pending', 'another-grant', { leaseFormat: other }));
  released.resolve();
  const [a, b, c, d] = await Promise.all([first, same, conflict, differentGrant]);
  assert.equal(c.error?.code, 'LEASE_FORMAT_CONFLICT');
  assert.equal(d.error?.code, 'OPERATION_CONFLICT');
  assert.equal(a.error, undefined);
  assert.equal(a.value.lease.payload.profile, initial);
  assert.deepEqual(a.value, b.value);
  assert.equal(f.posts('pending').length, 1);
  assert.equal(f.posts('pending')[0].body.leaseFormat, initial === COMPACT ? COMPACT : undefined);
});

test('compact opposite-format status during preflight is retained as original history, not a downgrade or another POST', async () => {
  const f = createFixture(), entered = Promise.withResolvers(), released = Promise.withResolvers();
  const original = makePreparation('race', { grantId: 'grant', format: FULL });
  f.batches.set('race', { prepared: original, receipts: new Map() });
  f.control.onCapabilities = async value => { entered.resolve(); await released.promise; return value; };
  const pending = settled(f.client.prepare('race', 'grant', compactOptions));
  await entered.promise;
  const observed = await f.client.status('race');
  released.resolve();
  assert.equal(observed.state, 'ready');
  assert.deepEqual(observed.prepared.lease, original.lease);
  assert.equal((await pending).error?.code, 'LEASE_FORMAT_CONFLICT');
  assert.equal(f.posts().length, 0);
  await assert.rejects(f.client.prepare('race', 'grant', compactOptions), { code: 'LEASE_FORMAT_CONFLICT' });
  assert.deepEqual((await f.client.prepare('race', 'grant')).lease, original.lease);
});

test('compact same-format status during preflight is reusable even when the issuance flag closes', async () => {
  const f = createFixture(), entered = Promise.withResolvers(), released = Promise.withResolvers();
  const original = makePreparation('race', { grantId: 'grant' });
  f.batches.set('race', { prepared: original, receipts: new Map() });
  f.control.onCapabilities = async value => { entered.resolve(); await released.promise; return value; };
  const pending = settled(f.client.prepare('race', 'grant', compactOptions));
  await entered.promise;
  const observed = await f.client.status('race');
  f.control.capabilities.leaseFormats.compactIssuanceEnabled = false;
  released.resolve();
  assert.equal(observed.state, 'ready');
  const result = await pending;
  assert.equal(result.error, undefined);
  assert.deepEqual(result.value.lease, original.lease);
  assert.equal(f.posts().length, 0);
});

for (const requested of [FULL, COMPACT]) test(`compact response format mismatch after requesting ${requested} is sticky unknown`, async () => {
  const f = createFixture();
  f.control.onPrepare = (_result, body) => makePreparation(body.operationId,
    { grantId: body.grantId, format: requested === FULL ? COMPACT : FULL });
  await assert.rejects(f.client.prepare('mismatch', 'grant', { leaseFormat: requested }), { code: 'OUTCOME_UNKNOWN' });
  await assert.rejects(f.client.prepare('mismatch', 'grant', { leaseFormat: requested === FULL ? COMPACT : FULL }), { code: 'OUTCOME_UNKNOWN' });
  await assert.rejects(f.client.prepare('mismatch', 'different-grant', null), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.posts().length, 1);
});

for (const status of [400, 409, 503]) test(`compact HTTP ${status} after POST retains GET-only recovery without another mutation`, async () => {
  const f = createFixture();
  f.control.onPrepare = () => new Response(JSON.stringify({ code: 'LEASE_FORMAT_CONFLICT' }), { status });
  await assert.rejects(f.client.prepare('uncertain', 'grant', compactOptions), { code: 'OUTCOME_UNKNOWN', httpStatus: status });
  const observed = await f.client.status('uncertain');
  assert.equal(observed.state, 'ready');
  assert.equal(observed.prepared.lease.payload.profile, COMPACT);
  await assert.rejects(f.client.prepare('uncertain', 'grant', compactOptions), { code: 'OUTCOME_UNKNOWN' });
  await assert.rejects(f.client.execute(observed.prepared), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.posts().length, 1);
});

test('compact timeout and lost acknowledgements remain unknown across hot eviction and verified status', async () => {
  for (const kind of ['prepare', 'execute']) {
    const f = createFixture({ count: 1, config: { timeoutMs: 50 } });
    if (kind === 'prepare') f.control.onPrepare = async (_result, _body, init) => {
      await new Promise((resolve, reject) => {
        if (init.signal.aborted) reject(new Error('synthetic timeout'));
        else init.signal.addEventListener('abort', () => reject(new Error('synthetic timeout')), { once: true });
      });
    };
    else f.control.onExecute = () => { throw new Error('synthetic lost acknowledgement'); };
    if (kind === 'prepare') await assert.rejects(f.client.prepare('unknown', 'grant', compactOptions), { code: 'OUTCOME_UNKNOWN', reason: 'timeout' });
    else await assert.rejects(f.client.execute(await f.client.prepare('unknown', 'grant', compactOptions)), { code: 'OUTCOME_UNKNOWN' });
    delete f.control.onPrepare;
    await f.fill('evict', 32);
    const before = f.requests.length, posts = f.posts().length;
    await assert.rejects(f.client.prepare('unknown', 'different-grant', null), { code: 'OUTCOME_UNKNOWN' });
    assert.equal(f.requests.length, before);
    const observed = await f.client.status('unknown');
    assert.equal(observed.state, kind === 'prepare' ? 'ready' : 'committed');
    if (kind === 'execute') assert.equal(observed.effects[0].receiptVerified, true);
    await assert.rejects(f.client.prepare('unknown', 'grant', fullOptions), { code: 'OUTCOME_UNKNOWN' });
    await assert.rejects(f.client.execute(observed.prepared), { code: 'OUTCOME_UNKNOWN' });
    assert.equal(f.posts().length, posts);
  }
});

test('compact hot and evicted format conflicts fail locally while same-format recovery uses GET with issuance off', async () => {
  const f = createFixture();
  const original = await f.client.prepare('original', 'grant', compactOptions);
  await assert.rejects(f.client.prepare('original', 'grant'), { code: 'LEASE_FORMAT_CONFLICT' });
  await f.fill('hot', 17);
  f.control.capabilities.leaseFormats.compactIssuanceEnabled = false;
  const before = f.requests.length, posts = f.posts().length;
  await assert.rejects(f.client.prepare('original', 'grant'), { code: 'LEASE_FORMAT_CONFLICT' });
  await assert.rejects(f.client.prepare('original', 'other-grant'), { code: 'OPERATION_CONFLICT' });
  assert.equal(f.requests.length, before);
  const [a, b] = await Promise.all([f.client.prepare('original', 'grant', compactOptions), f.client.prepare('original', 'grant', compactOptions)]);
  assert.deepEqual(a, b);
  assert.deepEqual(a.lease, original.lease);
  assert.equal(f.reads('original').length, 1);
  assert.equal(f.posts().length, posts);
  assert.equal((await f.client.execute(a)).state, 'committed');
});

test('compact pending sends stay pinned during eviction pressure and different choices cannot join them', async () => {
  const f = createFixture(), entered = Promise.withResolvers(), released = Promise.withResolvers();
  f.control.onPrepare = async (result, body) => {
    if (body.operationId === 'pending') { entered.resolve(); await released.promise; }
    return result;
  };
  const pending = settled(f.client.prepare('pending', 'grant', compactOptions));
  await entered.promise;
  const same = settled(f.client.prepare('pending', 'grant', compactOptions));
  const other = settled(f.client.prepare('pending', 'grant', fullOptions));
  try { await f.fill('pressure', 32); } finally { released.resolve(); }
  const [a, b, c] = await Promise.all([pending, same, other]);
  assert.equal(c.error?.code, 'LEASE_FORMAT_CONFLICT');
  assert.equal(a.error, undefined);
  assert.deepEqual(a.value, b.value);
  assert.equal(f.posts('pending').length, 1);
});

test('compact cold status remembers the actual format and cannot turn a format conflict into a prepare resend', async () => {
  const f = createFixture(), original = makePreparation('cold', { grantId: 'grant' });
  f.batches.set('cold', { prepared: original, receipts: new Map() });
  f.control.capabilities.leaseFormats.compactIssuanceEnabled = false;
  const observed = await f.client.status('cold');
  assert.equal(observed.state, 'ready');
  await f.fill('pressure', 17);
  const before = f.requests.length;
  await assert.rejects(f.client.prepare('cold', 'grant'), { code: 'LEASE_FORMAT_CONFLICT' });
  assert.equal(f.requests.length, before);
  assert.deepEqual((await f.client.prepare('cold', 'grant', compactOptions)).lease, original.lease);
  assert.equal(f.posts('cold').length, 0);
});

test('compact evicted missing or corrupt originals retain unknown and never create another lease', async () => {
  for (const corrupt of [
    value => { delete value.prepared; return value; },
    value => { value.prepared = makePreparation('old', { grantId: 'grant', format: FULL }); return value; },
  ]) {
    const f = createFixture();
    await f.client.prepare('old', 'grant', compactOptions);
    await f.fill('hot', 17);
    f.control.onStatus = corrupt;
    await assert.rejects(f.client.prepare('old', 'grant', compactOptions), { code: 'OUTCOME_UNKNOWN' });
    await assert.rejects(f.client.prepare('old', 'grant'), { code: 'OUTCOME_UNKNOWN' });
    assert.equal(f.posts('old').length, 1);
  }
});

test('compact missing or mismatched same-source receipt gates become sticky unknown after execute', async () => {
  for (const corrupt of [
    payload => { delete payload.gate; },
    payload => { payload.gate.coreReceipt.pass_hash = '1'.repeat(64); rehashGate(payload.gate); },
  ]) {
    const f = createFixture();
    f.control.onExecute = result => { corrupt(result.receipt.payload); result.receipt = signed(result.receipt.payload); return result; };
    const prepared = await f.client.prepare('gated', 'grant', compactOptions);
    await assert.rejects(f.client.execute(prepared), { code: 'OUTCOME_UNKNOWN', reason: 'INVALID_RECEIPT' });
    await assert.rejects(f.client.execute(prepared, 1), { code: 'OUTCOME_UNKNOWN' });
    assert.equal(f.posts('gated').length, 2);
  }
});

test('compact source-aware client receipt verification rejects missing gate using known historical source context', async () => {
  const f = createFixture(), shared = makeEffect('same-payment');
  const source = makePreparation('source', { grantId: 'grant', effects: [makeEffect('other-payment'), shared] });
  const current = makePreparation('current', { grantId: 'grant', effects: [shared] });
  for (const prepared of [source, current]) f.batches.set(prepared.operationId, { prepared, receipts: new Map() });
  assert.equal((await f.client.status('source')).state, 'ready');
  assert.equal((await f.client.status('current')).state, 'ready');
  f.control.onExecute = result => ({ ...result, state: 'already_committed', receipt: makeReceipt(source, 1, { gate: false }) });
  await assert.rejects(f.client.execute(current), { code: 'OUTCOME_UNKNOWN', reason: 'INVALID_RECEIPT' });
  assert.equal(f.posts('current').length, 1);
});

test('compact source-aware status validates original ordinals and retains legacy no-gate history', async () => {
  for (const format of [FULL, COMPACT]) {
    const f = createFixture(), shared = makeEffect('same-payment');
    const source = makePreparation('source', { format, grantId: 'grant', effects: [makeEffect('other-payment'), shared] });
    const current = makePreparation('current', { grantId: 'grant', effects: [shared] });
    f.batches.set('source', { prepared: source, receipts: new Map() });
    f.batches.set('current', { prepared: current, receipts: new Map([[0, makeReceipt(source, 1)]]) });
    assert.equal((await f.client.status('source')).state, 'ready');
    const observed = await f.client.status('current');
    assert.equal(observed.state, 'committed');
    assert.equal(observed.effects[0].receipt.payload.ordinal, 1);
    assert.equal(observed.effects[0].receiptVerified, true);
    if (format === COMPACT) {
      f.batches.get('current').receipts.set(0, makeReceipt(source, 1, { gate: false }));
      assert.equal((await f.client.status('current')).state, 'unknown');
    }
    assert.equal(f.posts().length, 0);
    assert.equal(f.reads('source').length, 1, 'historical verification never fetches a source automatically');
  }
});

test('compact in-flight status cannot clear a retained unknown fence while preparation is unsent', async () => {
  const f = createFixture(), entered = Promise.withResolvers(), released = Promise.withResolvers();
  f.control.onCapabilities = async value => { entered.resolve(); await released.promise; return value; };
  const pending = settled(f.client.prepare('not-sent', 'grant', compactOptions));
  await entered.promise;
  assert.equal((await f.client.status('not-sent')).state, 'unknown');
  released.resolve();
  await nextTurn();
  assert.equal((await pending).error?.code, 'OUTCOME_UNKNOWN');
  await assert.rejects(f.client.prepare('not-sent', 'grant', null), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.posts().length, 0);
});

test('compact preflight waits for a status read already in flight before deciding whether it can POST', async () => {
  const f = createFixture(), capabilityEntered = Promise.withResolvers(), statusEntered = Promise.withResolvers();
  const releaseCapability = Promise.withResolvers(), releaseStatus = Promise.withResolvers();
  const original = makePreparation('racing-read', { grantId: 'grant', format: FULL });
  f.batches.set('racing-read', { prepared: original, receipts: new Map() });
  f.control.onCapabilities = async value => { capabilityEntered.resolve(); await releaseCapability.promise; return value; };
  f.control.onStatus = async value => { statusEntered.resolve(); await releaseStatus.promise; return value; };
  const pending = settled(f.client.prepare('racing-read', 'grant', compactOptions));
  await capabilityEntered.promise;
  const observed = settled(f.client.status('racing-read'));
  await statusEntered.promise;
  releaseCapability.resolve();
  await nextTurn();
  const postsBeforeStatus = f.posts().length;
  releaseStatus.resolve();
  const [preparation, status] = await Promise.all([pending, observed]);
  assert.equal(postsBeforeStatus, 0);
  assert.equal(f.posts().length, 0);
  assert.equal(status.value.state, 'ready');
  assert.equal(preparation.error?.code, 'LEASE_FORMAT_CONFLICT');
});

test('compact preflight cannot POST after status has observed an original without its signed preparation', async () => {
  const f = createFixture(), entered = Promise.withResolvers(), released = Promise.withResolvers();
  const original = makePreparation('observed', { grantId: 'grant', format: FULL });
  f.batches.set('observed', { prepared: original, receipts: new Map() });
  f.control.onCapabilities = async value => { entered.resolve(); await released.promise; return value; };
  f.control.onStatus = value => { delete value.prepared; return value; };
  const pending = settled(f.client.prepare('observed', 'grant', compactOptions));
  await entered.promise;
  assert.equal((await f.client.status('observed')).state, 'ready');
  released.resolve();
  assert.equal((await pending).error?.code, 'OUTCOME_UNKNOWN');
  assert.equal(f.posts().length, 0);
  await assert.rejects(f.client.prepare('observed', 'grant'), { code: 'OUTCOME_UNKNOWN' });
});

test('compact prepare joining a cold read retains its pending grant and format before the read finishes', async () => {
  const f = createFixture(), entered = Promise.withResolvers(), released = Promise.withResolvers();
  const original = makePreparation('cold-pending', { grantId: 'grant' });
  f.batches.set('cold-pending', { prepared: original, receipts: new Map() });
  f.control.onStatus = async value => { entered.resolve(); await released.promise; return value; };
  const reading = settled(f.client.status('cold-pending'));
  await entered.promise;
  const first = settled(f.client.prepare('cold-pending', 'grant', compactOptions));
  const same = settled(f.client.prepare('cold-pending', 'grant', compactOptions));
  let formatResult, grantResult;
  const format = settled(f.client.prepare('cold-pending', 'grant')).then(result => { formatResult = result; });
  const grant = settled(f.client.prepare('cold-pending', 'other-grant')).then(result => { grantResult = result; });
  await nextTurn();
  const immediateFormat = formatResult?.error?.code, immediateGrant = grantResult?.error?.code;
  released.resolve();
  const [a, b, c] = await Promise.all([first, same, reading, format, grant]);
  assert.equal(immediateFormat, 'LEASE_FORMAT_CONFLICT');
  assert.equal(immediateGrant, 'OPERATION_CONFLICT');
  assert.equal(a.error, undefined);
  assert.deepEqual(a.value, b.value);
  assert.deepEqual(a.value.lease, c.value.prepared.lease);
  assert.equal(f.reads('cold-pending').length, 1);
  assert.equal(f.posts().length, 0);
});

test('compact GET-only preparation recovery still coalesces an evicted committed receipt replay', async () => {
  const f = createFixture({ count: 1 });
  const original = await f.client.prepare('replay', 'grant', compactOptions);
  const committed = await f.client.execute(original);
  await f.fill('hot', 17);
  const entered = Promise.withResolvers(), released = Promise.withResolvers();
  f.control.onStatus = async value => { entered.resolve(); await released.promise; return value; };
  const preparation = settled(f.client.prepare('replay', 'grant', compactOptions));
  await entered.promise;
  const replay = settled(f.client.execute(original));
  released.resolve();
  const [a, b] = await Promise.all([preparation, replay]);
  assert.equal(a.error, undefined);
  assert.equal(b.error, undefined);
  assert.equal(b.value.state, 'already_committed');
  assert.deepEqual(b.value.receipt, committed.receipt);
  assert.equal(f.reads('replay').length, 1);
  assert.equal(f.posts('replay').length, 2);
});

test('compact execution at ordinal 63 keeps both existing transports and never adds a prepare selector', async () => {
  for (const reference of [false, true]) {
    const f = createFixture({ count: 64 });
    if (!reference) delete f.control.capabilities.executionTransport;
    const prepared = await f.client.prepare('sixty-four', 'grant', compactOptions);
    f.control.capabilities.leaseFormats.compactIssuanceEnabled = false;
    const result = await f.client.execute(prepared, 63);
    assert.equal(result.state, 'committed');
    assert.equal(result.receipt.payload.gate.coreReceipt.sequence_number, 63);
    const request = f.posts('sixty-four').find(item => item.kind === 'execute').body;
    assert.equal(Object.hasOwn(request, 'leaseFormat'), false);
    if (reference) {
      assert.equal(request.preparationDigest, prepared.preparationDigest);
      assert.equal(Object.hasOwn(request, 'lease'), false);
    } else {
      assert.deepEqual(request.lease, prepared.lease);
      assert.equal(Object.hasOwn(request, 'preparationDigest'), false);
    }
  }
});

test('compact serialized execution refuses a full-only reader locally without a fallback POST', async () => {
  for (const legacy of [false, true]) {
    const f = createFixture(), prepared = makePreparation('unsupported-execute', { grantId: 'grant' });
    f.batches.set(prepared.operationId, { prepared, receipts: new Map() });
    if (legacy) delete f.control.capabilities.leaseFormats;
    else f.control.capabilities.leaseFormats = { supported: [FULL], default: FULL, compactIssuanceEnabled: false };
    await assert.rejects(f.client.execute(prepared), { code: 'LEASE_FORMAT_UNSUPPORTED' });
    assert.equal(f.posts().length, 0);
    assert.equal((await f.client.status(prepared.operationId)).state, 'ready', 'read-only original history remains usable');
  }
});

test('compact historical status rejects a missing source gate on its first receipt read', async () => {
  const f = createFixture(), shared = makeEffect('same-payment');
  const source = makePreparation('source', { grantId: 'grant', effects: [makeEffect('other-payment'), shared] });
  const current = makePreparation('current', { grantId: 'grant', effects: [shared] });
  f.batches.set('source', { prepared: source, receipts: new Map() });
  f.batches.set('current', { prepared: current, receipts: new Map([[0, makeReceipt(source, 1, { gate: false })]]) });
  assert.equal((await f.client.status('source')).state, 'ready');
  const observed = await f.client.status('current');
  assert.equal(observed.state, 'unknown');
  assert.equal(observed.reason, 'INVALID_RECEIPT');
  assert.equal(f.posts().length, 0);
});

test('compact mixed-issuer historical receipts require explicit trust without replacing source ordinals or enabling execution', async () => {
  const shared = makeEffect('same-payment');
  const source = makePreparation('old-source', { signer: 'old', grantId: 'grant', effects: [makeEffect('other-payment'), shared] });
  const current = makePreparation('current', { grantId: 'grant', effects: [shared] });
  const receipt = makeReceipt(source, 1, { signer: 'old' });
  for (const trusted of [false, true]) {
    const f = createFixture({ config: { trustedIssuerPublicKeys: trusted ? [publicPem('old')] : [] } });
    f.batches.set('old-source', { prepared: source, receipts: new Map() });
    f.batches.set('current', { prepared: current, receipts: new Map([[0, receipt]]) });
    f.control.capabilities.trustedIssuerPublicKeys = [publicPem('old')];
    const original = await f.client.status('old-source'), observed = await f.client.status('current');
    assert.equal(observed.state, trusted ? 'committed' : 'unknown');
    if (trusted) {
      assert.deepEqual(observed.effects[0].receipt, receipt);
      assert.equal(observed.effects[0].receipt.payload.ordinal, 1);
      assert.equal(observed.effects[0].receiptVerified, true);
      await assert.rejects(f.client.execute(original.prepared), { code: 'INVALID_PREPARATION' });
    } else {
      await assert.rejects(f.client.prepare('current', 'grant', compactOptions), { code: 'OUTCOME_UNKNOWN' });
    }
    assert.equal(f.posts().length, 0);
    assert.equal(f.reads('old-source').length, 1);
  }
});
