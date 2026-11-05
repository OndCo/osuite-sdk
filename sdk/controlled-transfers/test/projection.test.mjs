import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlledTransferMcpServer } from '../../controlled-transfers.mjs';
import { normalizeProjection } from '../projection.mjs';
import { createFixture, FULL, COMPACT, settled } from './compact-fixture.mjs';

const PROFILE = 'matoi.controlled-transfer.projection.v1';
const OBSERVED = '2026-11-02T00:00:01.000Z';
const GENERATED = '2026-11-02T00:00:00.000Z';
const INCARNATION = '00112233-4455-4677-8899-aabbccddeeff';
const STATES = ['current', 'pending_reconciliation', 'stale', 'failed', 'unavailable'];
const RESOURCE_BYTES = 1024 * 1024 - 16; // Leave room for the longer already_committed resource state.
const unavailable = {
  profile: PROFILE, state: 'unavailable', scope: 'derived-view', incarnation: null,
  requestedGeneration: null, projectedGeneration: null, artifactIncarnation: null,
  artifactGeneration: null, generatedAt: null, observedAt: null, lastError: null,
  authorizesExecution: false,
};
function observation(state = 'current', changes = {}) {
  return { profile: PROFILE, state, scope: 'derived-view', incarnation: INCARNATION,
    requestedGeneration: '9223372036854775807', projectedGeneration: '9223372036854775807',
    artifactIncarnation: INCARNATION, artifactGeneration: '9223372036854775807',
    generatedAt: GENERATED, observedAt: OBSERVED,
    lastError: state === 'failed' ? 'PROJECTION_VERIFICATION_FAILED' : null,
    authorizesExecution: false, ...changes };
}
const attach = projection => value => ({ ...value, projection });
const mcpFixture = () => createFixture({ count: 1,
  factory: ({ config }) => createControlledTransferMcpServer(config) });

for (const format of [FULL, COMPACT]) for (const state of STATES) {
  test(`projection ${state} stays separate from verified ${format} execute and status`, async () => {
    const f = createFixture({ count: 1 }), projection = observation(state);
    f.control.onExecute = attach(projection);
    f.control.onStatus = attach(projection);
    const prepared = await f.client.prepare('projection', 'grant', { leaseFormat: format });
    const committed = await f.client.execute(prepared);
    const receipt = f.batches.get('projection').receipts.get(0);
    assert.equal(committed.state, 'committed');
    assert.equal(committed.newlyCommitted, true);
    assert.equal(committed.retryAutomatically, false);
    assert.equal(JSON.stringify(committed.receipt), JSON.stringify(receipt));
    assert.deepEqual(committed.projection, projection);
    assert.ok(Object.isFrozen(committed.projection));

    const observed = await f.client.status('projection');
    assert.equal(observed.state, 'committed');
    assert.equal(observed.newlyCommitted, false);
    assert.equal(observed.retryAutomatically, false);
    assert.equal(observed.effects[0].receiptVerified, true);
    assert.equal(JSON.stringify(observed.effects[0].receipt), JSON.stringify(receipt));
    assert.deepEqual(observed.projection, projection);
    assert.equal(f.posts('projection').filter(request => request.kind === 'execute').length, 1);
  });
}

const inconsistentCurrent = [
  ...['incarnation', 'artifactIncarnation', 'requestedGeneration', 'projectedGeneration',
    'artifactGeneration', 'generatedAt', 'observedAt'].flatMap(field => {
    const missing = observation();
    delete missing[field];
    return [[`current null ${field}`, observation('current', { [field]: null })],
      [`current absent ${field}`, missing]];
  }),
  ['current mismatched incarnation', observation('current', { artifactIncarnation: '11223344-5566-4788-99aa-bbccddeeff00' })],
  ['current null incarnation pair', observation('current', { incarnation: null, artifactIncarnation: null })],
  ...['requestedGeneration', 'projectedGeneration', 'artifactGeneration'].map(field => [
    `current mismatched ${field}`, observation('current', { requestedGeneration: '9007199254740992',
      projectedGeneration: '9007199254740992', artifactGeneration: '9007199254740992', [field]: '9007199254740993' }),
  ]),
  ['current null generation tuple', observation('current', { requestedGeneration: null, projectedGeneration: null, artifactGeneration: null })],
  ['current zero generation tuple', observation('current', { requestedGeneration: '0', projectedGeneration: '0', artifactGeneration: '0' })],
  ['current generation after observation', observation('current', { generatedAt: '2026-11-02T00:00:01.001Z' })],
];

const malformed = [
  ['absent legacy metadata', undefined], ['null', null], ['array', []], ['scalar', 'current'],
  ['legacy graph', { state: 'current', causal_graph: { nodes: [] } }],
  ['wrong profile', observation('current', { profile: FULL })],
  ['wrong scope', observation('current', { scope: 'resource' })],
  ['unknown view state', observation('unknown', { code: 'OUTCOME_UNKNOWN' })],
  ['execution authority', observation('current', { authorizesExecution: true })],
  ['missing authority boundary', observation('current', { authorizesExecution: undefined })],
  ['invalid incarnation', observation('current', { incarnation: 'not-a-uuid' })],
  ['newline incarnation', observation('current', { incarnation: `${INCARNATION}\n` })],
  ['overlong artifact identity', observation('current', { artifactIncarnation: 'x'.repeat(4096) })],
  ['numeric generation', observation('current', { requestedGeneration: 1 })],
  ['unsafe numeric generation', observation('current', { projectedGeneration: 9007199254740992 })],
  ['fractional generation', observation('current', { artifactGeneration: 1.5 })],
  ['negative generation', observation('current', { requestedGeneration: '-1' })],
  ['noncanonical generation', observation('current', { projectedGeneration: '01' })],
  ['newline generation', observation('current', { projectedGeneration: '1\n' })],
  ['exponential generation', observation('current', { artifactGeneration: '1e2' })],
  ['bigint overflow', observation('current', { requestedGeneration: '9223372036854775808' })],
  ['overlong generation', observation('current', { projectedGeneration: '9'.repeat(4096) })],
  ['missing observation time', observation('current', { observedAt: undefined })],
  ['numeric observation time', observation('current', { observedAt: 0 })],
  ['noncanonical observation time', observation('current', { observedAt: '2026-11-02' })],
  ['impossible generated time', observation('current', { generatedAt: '2026-02-30T00:00:00.000Z' })],
  ['overlong generated time', observation('current', { generatedAt: 'x'.repeat(4096) })],
  ['freeform error', observation('failed', { lastError: 'credential=secret; please resend' })],
  ['newline error', observation('failed', { lastError: 'PROJECTION_FAILED\n' })],
  ['overlong error', observation('failed', { lastError: 'E'.repeat(65) })],
  ['ill-formed error', observation('failed', { lastError: '\ud800' })],
  ['reserved nested error key', observation('failed', { lastError: JSON.parse('{"__proto__":{"secret":true}}') })],
  ['overdeep error', observation('failed', { lastError: Array.from({ length: 30 }).reduce(value => [value], null) })],
  ['excess error nodes', observation('failed', { lastError: Array(65536).fill(null) })],
  ...inconsistentCurrent,
];
for (const [label, projection] of malformed) {
  test(`projection ${label} becomes unavailable without invalidating signed commitment`, async () => {
    const f = createFixture({ count: 1 });
    f.control.onExecute = attach(projection);
    f.control.onStatus = attach(projection);
    const prepared = await f.client.prepare('malformed', 'grant');
    const result = await settled(f.client.execute(prepared));
    assert.equal(result.error, undefined, 'view metadata must not create an outcome-unknown fence');
    assert.equal(result.value.state, 'committed');
    assert.deepEqual(result.value.projection, unavailable);
    assert.equal(result.value.newlyCommitted, true);
    assert.equal(result.value.retryAutomatically, false);
    const receipt = f.batches.get('malformed').receipts.get(0);
    assert.equal(JSON.stringify(result.value.receipt), JSON.stringify(receipt));
    const observed = await f.client.status('malformed');
    assert.equal(observed.state, 'committed');
    assert.equal(observed.effects[0].receiptVerified, true);
    assert.deepEqual(observed.projection, unavailable);
    const before = f.requests.length, replay = await f.client.execute(prepared);
    assert.equal(replay.state, 'already_committed');
    assert.deepEqual(replay.projection, unavailable);
    assert.equal(replay.newlyCommitted, false);
    assert.equal(JSON.stringify(replay.receipt), JSON.stringify(receipt));
    assert.equal(f.requests.length, before, 'unavailable metadata never requests a resend');
  });
}

test('projection current without identity becomes unavailable rather than inventing counters', async () => {
  const f = createFixture({ count: 1 });
  f.control.onExecute = attach({ profile: PROFILE, state: 'current', scope: 'derived-view',
    observedAt: OBSERVED, authorizesExecution: false });
  const result = await f.client.execute(await f.client.prepare('no-identity', 'grant'));
  assert.deepEqual(result.projection, unavailable);
});

test('projection cached current input is checked for consistency before becoming stale', () => {
  for (const [label, projection] of inconsistentCurrent) {
    assert.deepEqual(normalizeProjection(projection, { cached: true }), unavailable, label);
    assert.equal(projection.state, 'current', 'validation must not mutate the original observation');
  }
});

test('projection coherent current accepts positive generations and equal dates without asserting server freshness', () => {
  for (const generation of ['1', '9223372036854775807']) for (const date of [GENERATED, '2100-01-01T00:00:00.000Z']) {
    const projection = observation('current', { requestedGeneration: generation, projectedGeneration: generation,
      artifactGeneration: generation, generatedAt: date, observedAt: date });
    assert.deepEqual(normalizeProjection(projection), projection);
    assert.deepEqual(normalizeProjection(projection, { cached: true }), { ...projection, state: 'stale' });
  }
});

for (const state of STATES.filter(state => state !== 'current')) {
  test(`projection ${state} retains incomplete metadata without the current consistency requirements`, () => {
    const projection = { ...unavailable, state, requestedGeneration: '1', projectedGeneration: '0', observedAt: OBSERVED };
    assert.deepEqual(normalizeProjection(projection), projection);
    assert.deepEqual(normalizeProjection(projection, { cached: true }), projection);
  });
}

test('MCP inconsistent current claims do not invalidate a verified commitment or invite a resend', async () => {
  for (const [label, projection] of inconsistentCurrent) {
    const f = mcpFixture();
    f.control.onExecute = attach(projection);
    f.control.onStatus = attach(projection);
    const held = await f.client.callTool('osuite_transfer_prepare', { operationId: 'inconsistent', grantId: 'grant' });
    const args = { prepared: held.structuredContent };
    const committed = await f.client.callTool('osuite_transfer_execute', args);
    assert.equal(committed.isError, undefined, label);
    assert.equal(committed.structuredContent.state, 'committed', label);
    assert.equal(committed.structuredContent.effect_executed, true, label);
    assert.equal(committed.structuredContent.retryAutomatically, false, label);
    assert.deepEqual(committed.structuredContent.projection, unavailable, label);
    const receipt = f.batches.get('inconsistent').receipts.get(0);
    assert.equal(JSON.stringify(committed.structuredContent.receipt), JSON.stringify(receipt), label);
    const status = await f.client.callTool('osuite_transfer_status', { operationId: 'inconsistent' });
    assert.equal(status.structuredContent.state, 'committed', label);
    assert.equal(status.structuredContent.effects[0].receiptVerified, true, label);
    assert.deepEqual(status.structuredContent.projection, unavailable, label);
    const before = f.requests.length, replay = await f.client.callTool('osuite_transfer_execute', args);
    assert.equal(replay.structuredContent.state, 'already_committed', label);
    assert.equal(replay.structuredContent.effect_executed, false, label);
    assert.deepEqual(replay.structuredContent.projection, unavailable, label);
    assert.equal(f.requests.length, before, label);
  }
});

test('projection ignores arbitrary extension payloads before defensive response snapshotting', async () => {
  const f = createFixture({ count: 1 }), expected = observation();
  const projection = { ...expected, debug: { secret: f.config.privateKeyBase64 },
    causal_graph: Array(65536).fill(null), extra: JSON.parse('{"__proto__":1,"toJSON":1.5}') };
  f.control.onExecute = attach(projection);
  f.control.onStatus = attach(projection);
  const result = await settled(f.client.execute(await f.client.prepare('extensions', 'grant')));
  assert.equal(result.error, undefined);
  assert.deepEqual(result.value.projection, expected);
  assert.deepEqual((await f.client.status('extensions')).projection, expected);
  assert.ok(JSON.stringify(result.value.projection).length < 1024);
});

test('projection normalization cannot consume the verified resource snapshot byte budget', async () => {
  for (const projection of [undefined, { state: 'unknown' }]) {
    const f = createFixture({ count: 1 }), prepared = await f.client.prepare('boundary', 'grant');
    f.control.onExecute = value => {
      const resource = { ...value, padding: '' };
      const result = { ...resource, actionId: prepared.actionId,
        reviewUrl: `${f.config.baseUrl}/approvals?action=${encodeURIComponent(prepared.actionId)}`,
        retryAutomatically: false, newlyCommitted: true };
      resource.padding = 'x'.repeat(RESOURCE_BYTES - Buffer.byteLength(JSON.stringify(result)));
      return { ...resource, projection };
    };
    const result = await settled(f.client.execute(prepared));
    assert.equal(result.error, undefined, 'additive freshness must not spend the resource byte budget');
    const { projection: normalized, ...resource } = result.value;
    assert.deepEqual(normalized, unavailable);
    assert.equal(Buffer.byteLength(JSON.stringify(resource)), RESOURCE_BYTES);
    assert.equal(resource.state, 'committed');
    assert.equal(resource.newlyCommitted, true);
    const before = f.requests.length;
    assert.equal((await f.client.execute(prepared)).state, 'already_committed');
    assert.equal(f.requests.length, before);
  }
});

test('projection status normalization cannot consume the verified resource snapshot byte budget', async () => {
  const f = createFixture({ count: 1 }), prepared = await f.client.prepare('status-boundary', 'grant');
  await f.client.execute(prepared);
  f.control.onStatus = value => {
    const resource = { ...value, padding: '' };
    const result = { ...resource, prepared, effects: resource.effects.map(effect => ({ ...effect, receiptVerified: true })),
      reviewUrl: prepared.reviewUrl, retryAutomatically: false, newlyCommitted: false };
    resource.padding = 'x'.repeat(RESOURCE_BYTES - Buffer.byteLength(JSON.stringify(result)));
    return resource;
  };
  const { projection, ...observed } = await f.client.status('status-boundary');
  assert.equal(observed.state, 'committed');
  assert.equal(observed.effects[0].receiptVerified, true);
  assert.deepEqual(projection, unavailable);
  assert.equal(Buffer.byteLength(JSON.stringify(observed)), RESOURCE_BYTES);
});

for (const state of STATES) test(`projection cached ${state} never fabricates a new observation`, async () => {
  const f = createFixture({ count: 1 }), projection = observation(state);
  f.control.onExecute = attach(projection);
  const prepared = await f.client.prepare('cached', 'grant');
  const committed = await f.client.execute(prepared), before = f.requests.length;
  const expected = { ...projection, state: state === 'current' ? 'stale' : state };
  for (let i = 0; i < 2; i++) {
    const replay = await f.client.execute(prepared);
    assert.equal(replay.state, 'already_committed');
    assert.equal(replay.newlyCommitted, false);
    assert.deepEqual(replay.receipt, committed.receipt);
    assert.deepEqual(replay.projection, expected);
    assert.ok(Object.isFrozen(replay.projection));
  }
  assert.deepEqual(committed.projection, projection, 'replay cannot mutate an earlier observation');
  assert.equal(f.requests.length, before);
});

test('projection status refresh replaces cached metadata without re-dating the cached replay', async () => {
  const f = createFixture({ count: 1 });
  f.control.onExecute = attach(observation('pending_reconciliation'));
  const prepared = await f.client.prepare('refreshed', 'grant');
  await f.client.execute(prepared);
  const projection = observation('current', { observedAt: '2026-11-02T00:00:02.000Z' });
  f.control.onStatus = attach(projection);
  const observed = await f.client.status('refreshed'), before = f.requests.length;
  const replay = await f.client.execute(prepared);
  assert.deepEqual(observed.projection, projection);
  assert.deepEqual(replay.projection, { ...projection, state: 'stale' });
  assert.equal(f.requests.length, before);
});

test('projection eviction recovery uses the new GET observation and only later replay is stale', async () => {
  const f = createFixture({ count: 1 });
  f.control.onExecute = attach(observation('pending_reconciliation'));
  const prepared = await f.client.prepare('evicted', 'grant'), committed = await f.client.execute(prepared);
  await f.fill('hot', 16);
  const projection = observation('current', { observedAt: '2026-11-02T00:00:03.000Z' });
  f.control.onStatus = attach(projection);
  const posts = f.posts().length, recovered = await f.client.execute(prepared);
  assert.equal(recovered.state, 'already_committed');
  assert.equal(recovered.newlyCommitted, false);
  assert.deepEqual(recovered.receipt, committed.receipt);
  assert.deepEqual(recovered.projection, projection);
  const replay = await f.client.execute(prepared);
  assert.deepEqual(replay.projection, { ...projection, state: 'stale' });
  assert.equal(f.reads('evicted').length, 1);
  assert.equal(f.posts().length, posts);
});

test('projection concurrent execution shares one wire observation without mutating it for replay', async () => {
  const f = createFixture({ count: 1 }), entered = Promise.withResolvers(), released = Promise.withResolvers();
  const projection = observation();
  f.control.onExecute = async value => { entered.resolve(); await released.promise; return { ...value, projection }; };
  const prepared = await f.client.prepare('concurrent', 'grant');
  const first = f.client.execute(prepared);
  await entered.promise;
  const second = f.client.execute(prepared);
  released.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a.projection, projection);
  assert.deepEqual(b.projection, projection);
  assert.deepEqual((await f.client.execute(prepared)).projection, { ...projection, state: 'stale' });
  assert.deepEqual(a.projection, projection);
  assert.equal(f.posts().filter(request => request.kind === 'execute').length, 1);
});

test('projection current never clears a lost-execution fence after verified status recovery', async () => {
  const f = createFixture({ count: 1 });
  f.control.onExecute = () => { throw new Error('synthetic lost response after commitment'); };
  f.control.onStatus = attach(observation());
  const prepared = await f.client.prepare('unknown', 'grant');
  await assert.rejects(f.client.execute(prepared), { code: 'OUTCOME_UNKNOWN', retryAutomatically: false });
  const posts = f.posts().length, observed = await f.client.status('unknown');
  assert.equal(observed.state, 'committed');
  assert.equal(observed.effects[0].receiptVerified, true);
  assert.deepEqual(observed.projection, observation());
  await assert.rejects(f.client.execute(prepared), { code: 'OUTCOME_UNKNOWN' });
  await assert.rejects(f.client.prepare('unknown', 'grant'), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.posts().length, posts);
});

test('projection cannot authenticate an invalid receipt or an unbound status response', async () => {
  for (const corrupt of [
    value => ({ ...value, operationId: 'another-operation' }),
    value => ({ ...value, effects: value.effects.map(effect => ({ ...effect,
      receipt: { ...effect.receipt, signature: 'A'.repeat(86) } })) }),
  ]) {
    const f = createFixture({ count: 1 }), prepared = await f.client.prepare('invalid', 'grant');
    await f.client.execute(prepared);
    f.control.onStatus = value => ({ ...corrupt(value), projection: observation() });
    const observed = await f.client.status('invalid');
    assert.equal(observed.state, 'unknown');
    assert.equal(observed.code, 'OUTCOME_UNKNOWN');
    assert.deepEqual(observed.projection, unavailable);
    await assert.rejects(f.client.execute(prepared), { code: 'OUTCOME_UNKNOWN' });
  }
});

test('projection current stays separate from an explicit denied resource decision', async () => {
  const f = createFixture({ count: 1 });
  f.control.onExecute = value => ({ profile: value.profile, operationId: value.operationId,
    state: 'denied', code: 'AWAITING_APPROVAL', projection: observation() });
  const result = await f.client.execute(await f.client.prepare('denied', 'grant'));
  assert.equal(result.state, 'denied');
  assert.equal(result.code, 'AWAITING_APPROVAL');
  assert.equal(result.newlyCommitted, false);
  assert.equal(result.retryAutomatically, false);
  assert.deepEqual(result.projection, observation());
});

for (const state of STATES) test(`MCP projection ${state} exposes only bounded public fields`, async () => {
  const f = mcpFixture(), projection = observation(state);
  const wire = { ...projection, apiKey: f.config.apiKey, privateKey: f.config.privateKeyBase64,
    code: 'OUTCOME_UNKNOWN', effect_executed: null, retryAutomatically: true, causal_graph: { private: true } };
  f.control.onExecute = attach(wire);
  f.control.onStatus = attach(wire);
  const held = await f.client.callTool('osuite_transfer_prepare', { operationId: 'mcp', grantId: 'grant' });
  const result = await f.client.callTool('osuite_transfer_execute', { prepared: held.structuredContent });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.state, 'committed');
  assert.equal(result.structuredContent.effect_executed, true);
  assert.equal(result.structuredContent.retryAutomatically, false);
  assert.deepEqual(result.structuredContent.projection, projection);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  const observed = await f.client.callTool('osuite_transfer_status', { operationId: 'mcp' });
  assert.equal(observed.structuredContent.effect_executed, false);
  assert.deepEqual(observed.structuredContent.projection, projection);
  assert.equal(observed.structuredContent.effects[0].receiptVerified, true);
  const replay = await f.client.callTool('osuite_transfer_execute', { prepared: held.structuredContent });
  assert.equal(replay.structuredContent.effect_executed, false);
  assert.deepEqual(replay.structuredContent.projection, { ...projection, state: state === 'current' ? 'stale' : state });
  assert.ok(!JSON.stringify([result, observed, replay]).includes(f.config.privateKeyBase64));
  assert.ok(!JSON.stringify([result, observed, replay]).includes(f.config.apiKey));
  assert.equal(f.posts().filter(request => request.kind === 'execute').length, 1);
});

test('MCP unknown projection metadata cannot mask a newly verified action', async () => {
  const f = mcpFixture();
  f.control.onExecute = attach(observation('unknown', { reason: 'OUTCOME_UNKNOWN', retryAutomatically: true }));
  const held = await f.client.callTool('osuite_transfer_prepare', { operationId: 'unknown-view', grantId: 'grant' });
  const result = await f.client.callTool('osuite_transfer_execute', { prepared: held.structuredContent });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.state, 'committed');
  assert.equal(result.structuredContent.effect_executed, true);
  assert.deepEqual(result.structuredContent.projection, unavailable);
});

test('MCP current view metadata cannot turn unknown resource status into success', async () => {
  const f = mcpFixture();
  f.control.onStatus = attach(observation());
  const result = await f.client.callTool('osuite_transfer_status', { operationId: 'missing' });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.state, 'unknown');
  assert.equal(result.structuredContent.effect_executed, null);
  assert.equal(result.structuredContent.retryAutomatically, false);
  assert.equal(result.structuredContent.recovery.method, 'status');
  assert.deepEqual(result.structuredContent.projection, observation());
  const held = await f.client.callTool('osuite_transfer_prepare', { operationId: 'missing', grantId: 'grant' });
  assert.equal(held.structuredContent.code, 'OUTCOME_UNKNOWN');
  assert.equal(f.posts().length, 0);
});

test('MCP lost response and unavailable status keep bounded unavailable metadata and no resend', async () => {
  const f = mcpFixture();
  f.control.onExecute = () => { throw new Error('synthetic response loss'); };
  f.control.onStatus = () => new Response('', { status: 503 });
  const held = await f.client.callTool('osuite_transfer_prepare', { operationId: 'lost', grantId: 'grant' });
  const args = { prepared: held.structuredContent };
  for (const result of [await f.client.callTool('osuite_transfer_execute', args),
    await f.client.callTool('osuite_transfer_status', { operationId: 'lost' }),
    await f.client.callTool('osuite_transfer_execute', args)]) {
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.effect_executed, null);
    assert.equal(result.structuredContent.retryAutomatically, false);
    assert.deepEqual(result.structuredContent.projection, unavailable);
  }
  assert.equal(f.posts().filter(request => request.kind === 'execute').length, 1);
});
