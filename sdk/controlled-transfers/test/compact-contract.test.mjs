import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectCapabilities, snapshot } from '../contract.mjs';
import { FULL, COMPACT, makeCapabilities } from './compact-fixture.mjs';

test('compact capabilities distinguish full-only legacy support from dual-reader issuance', () => {
  const legacy = makeCapabilities();
  delete legacy.leaseFormats;
  assert.deepEqual(inspectCapabilities(legacy).leaseFormats,
    { supported: [FULL], default: FULL, compactIssuanceEnabled: false });
  for (const [supported, enabled] of [[[FULL], false], [[FULL, COMPACT], false], [[FULL, COMPACT], true]]) {
    const value = makeCapabilities();
    value.leaseFormats = { supported, default: FULL, compactIssuanceEnabled: enabled };
    const parsed = inspectCapabilities(value);
    assert.deepEqual(parsed.leaseFormats, value.leaseFormats);
    assert.equal(parsed.configured, true);
    assert.equal(parsed.resourceEnforced, true);
    assert.ok(Object.isFrozen(parsed.leaseFormats.supported));
    assert.notEqual(parsed.leaseFormats, value.leaseFormats);
    supported.push('caller-mutation');
    assert.ok(!parsed.leaseFormats.supported.includes('caller-mutation'));
  }
});

const invalidFormats = [
  ['null', null], ['string', COMPACT], ['array', []], ['explicit undefined', undefined],
  ['missing supported', { default: FULL, compactIssuanceEnabled: false }],
  ['missing default', { supported: [FULL, COMPACT], compactIssuanceEnabled: true }],
  ['missing issuance flag', { supported: [FULL, COMPACT], default: FULL }],
  ['extra option', { supported: [FULL, COMPACT], default: FULL, compactIssuanceEnabled: false, enabled: true }],
  ['flag string', { supported: [FULL, COMPACT], default: FULL, compactIssuanceEnabled: 'false' }],
  ['flag integer', { supported: [FULL, COMPACT], default: FULL, compactIssuanceEnabled: 1 }],
  ['enabled without support', { supported: [FULL], default: FULL, compactIssuanceEnabled: true }],
  ['compact default', { supported: [FULL, COMPACT], default: COMPACT, compactIssuanceEnabled: true }],
  ...[[], [COMPACT], [COMPACT, FULL], [FULL, FULL], [FULL, COMPACT, COMPACT],
    [FULL, 'matoi.controlled-transfer.lease.v3'], [FULL.toUpperCase(), COMPACT]]
    .map(supported => [`unsupported sequence ${JSON.stringify(supported)}`, { supported, default: FULL, compactIssuanceEnabled: false }]),
];
for (const [label, leaseFormats] of invalidFormats) test(`compact capabilities reject ${label}`, () => {
  assert.throws(() => inspectCapabilities({ ...makeCapabilities(), leaseFormats }), { code: 'INVALID_CAPABILITY' });
});

test('compact capability inspection refuses getters, proxies, hidden fields, symbols and decorated arrays without executing traps', () => {
  let calls = 0;
  const traps = { get() { calls++; throw new Error('get'); }, ownKeys() { calls++; throw new Error('ownKeys'); },
    getPrototypeOf() { calls++; throw new Error('getPrototypeOf'); } };
  const hostile = [
    value => Object.defineProperty(value, 'leaseFormats', { enumerable: true, get() { calls++; return {}; } }),
    value => { value.leaseFormats = new Proxy({}, traps); },
    value => { value.leaseFormats.supported = new Proxy([], traps); },
    value => Object.defineProperty(value.leaseFormats, 'extra', { value: true }),
    value => { value.leaseFormats[Symbol('extra')] = true; },
    value => { value.leaseFormats.supported.extra = true; },
    value => { delete value.leaseFormats.supported[0]; },
  ];
  for (const mutate of hostile) {
    const value = makeCapabilities();
    mutate(value);
    assert.throws(() => inspectCapabilities(value), { code: 'INVALID_CAPABILITY' });
  }
  assert.equal(calls, 0);
});

test('compact parsing preserves SDK snapshot byte, depth and node acceptance boundaries', () => {
  const max = 1024 * 1024;
  assert.equal(snapshot('x'.repeat(max - 2)).length, max - 2);
  assert.throws(() => snapshot('x'.repeat(max - 1)), { code: 'INVALID_RESPONSE' });
  assert.equal(snapshot(Array(65535).fill(null)).length, 65535);
  assert.throws(() => snapshot(Array(65536).fill(null)), { code: 'INVALID_RESPONSE' });
  const nested = depth => { let value = null; for (let i = 0; i < depth; i++) value = { value }; return value; };
  assert.doesNotThrow(() => snapshot(nested(24)));
  assert.throws(() => snapshot(nested(25)), { code: 'INVALID_RESPONSE' });
  const shared = { value: 1 }, original = { a: shared, b: shared }, copied = snapshot(original);
  assert.notEqual(copied.a, shared);
  assert.notEqual(copied.a, copied.b);
  shared.value = 2;
  assert.equal(copied.a.value, 1);
  assert.ok(Object.isFrozen(copied.b));
});
