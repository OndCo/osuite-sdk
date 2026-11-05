import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { canonicalJson, sha256 } from '../../runtime/protocol.mjs';
import { createFixture, makePreparation, makeReceipt, signed } from './retention-fixture.mjs';

test('retention keeps sixteen hot operations and recovers an older prepare by GET only', async () => {
  const f = createFixture(), original = await f.complete('old');
  await f.fill('hot', 16);
  const before = f.requests.length, posts = f.posts();
  await f.client.prepare('hot-0', 'grant-hot-0');
  assert.equal(f.requests.length, before, 'the most recent sixteen preparations remain hot');
  const recovered = await f.client.prepare('old', 'grant-old');
  assert.equal(f.reads('old'), 1, 'the seventeenth preparation must be read back, not retained forever');
  assert.deepEqual(recovered.lease, original.prepared.lease);
  assert.ok(Object.isFrozen(recovered));
  assert.equal(f.posts(), posts);
});

test('retention replays an old evicted ordinal with its original receipt and no mutation', async () => {
  const f = createFixture(), original = await f.complete('old');
  await f.fill('hot', 16);
  const posts = f.posts();
  const replay = await f.client.execute(original.prepared, 1);
  assert.equal(f.reads('old'), 1);
  assert.equal(replay.state, 'already_committed');
  assert.equal(replay.newlyCommitted, false);
  assert.deepEqual(replay.receipt, original.results[1].receipt);
  assert.equal(f.posts(), posts);
  const before = f.requests.length;
  assert.deepEqual((await f.client.execute(original.prepared, 0)).receipt, original.results[0].receipt);
  assert.equal(f.requests.length, before, 'recovered receipts share the bounded hot slot');
});

test('retention preserves completion and receipt bindings through ordinal 63', async () => {
  const f = createFixture({ count: 64 }), original = await f.complete('sixty-four');
  for (let i = 0; i < 16; i++) await f.client.prepare(`held-${i}`, `grant-held-${i}`);
  const posts = f.posts();
  for (const ordinal of [63, 32, 0]) {
    const replay = await f.client.execute(original.prepared, ordinal);
    assert.equal(replay.state, 'already_committed');
    assert.deepEqual(replay.receipt, original.results[ordinal].receipt);
  }
  assert.equal(f.reads('sixty-four'), 1);
  assert.equal(f.posts(), posts);
});

test('retention never sends a new prepare when recorded history is unavailable', async () => {
  const f = createFixture();
  await f.complete('old'); await f.fill('hot', 16);
  const posts = f.posts();
  f.control.status = () => new Response('', { status: 404 });
  await assert.rejects(f.client.prepare('old', 'grant-old'), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.reads('old'), 1);
  await assert.rejects(f.client.prepare('old', 'grant-old'), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.reads('old'), 1);
  assert.equal(f.posts(), posts);
});

test('retention rejects conflicting old grant and preparation bindings before I/O', async () => {
  const f = createFixture(), original = await f.complete('old');
  await f.fill('hot', 16);
  const before = f.requests.length;
  await assert.rejects(f.client.prepare('old', 'different-grant'), { code: 'OPERATION_CONFLICT' });
  const changed = structuredClone(original.prepared);
  changed.effects[0].destination = 'different-vendor';
  await assert.rejects(f.client.execute(changed, 0), { code: 'OPERATION_CONFLICT' });
  assert.equal(f.requests.length, before);
});

const corruptions = [
  ['missing preparation', value => { delete value.prepared; return value; }],
  ['missing response', () => new Response('', { status: 404 })],
  ['missing known receipt', value => { value.effects[0].receipt = null; return value; }],
  ['invalid receipt signature', value => { value.effects[0].receipt = { ...value.effects[0].receipt, signature: 'A'.repeat(86) }; return value; }],
  ['different correctly signed receipt', value => {
    value.effects[0].receipt = signed({ ...value.effects[0].receipt.payload, receiptId: 'different-receipt' }); return value;
  }],
  ['different correctly signed preparation', value => {
    const prepared = structuredClone(value.prepared), payload = { ...prepared.lease.payload, id: 'different-lease' };
    prepared.lease = signed(payload); prepared.preparationDigest = sha256(canonicalJson(payload));
    value.prepared = prepared;
    value.effects = value.effects.map((effect, ordinal) => ({ ...effect, receipt: makeReceipt(prepared, ordinal) }));
    return value;
  }],
  ['regressed known commitment', value => {
    value.state = 'partially_committed'; value.effects[0] = { ...value.effects[0], state: 'not_committed', receipt: null }; return value;
  }],
];
for (const [label, corrupt] of corruptions) test(`retention fences ${label} during historical recovery`, async () => {
  const f = createFixture(), original = await f.complete('old');
  await f.fill('hot', 16);
  const posts = f.posts();
  f.control.status = value => corrupt(structuredClone(value));
  await assert.rejects(f.client.execute(original.prepared, 0), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.reads('old'), 1);
  assert.equal(f.posts(), posts);
  delete f.control.status;
  const observed = await f.client.status('old');
  assert.equal(observed.state, 'committed');
  await assert.rejects(f.client.execute(observed.prepared, 0), { code: 'OUTCOME_UNKNOWN' });
  await assert.rejects(f.client.prepare('old', 'grant-old'), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.posts(), posts, 'successful status cannot erase the failed historical recovery fence');
});

test('retention coalesces concurrent prepare and ordinal replays while recovery is pinned against eviction', async () => {
  const f = createFixture(), original = await f.complete('old');
  await f.fill('hot', 16);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.control.status = async (value, operationId) => {
    if (operationId === 'old') { entered.resolve(); await release.promise; }
    return value;
  };
  const pending = Promise.all([f.client.prepare('old', 'grant-old'),
    f.client.execute(original.prepared, 0), f.client.execute(original.prepared, 1), f.client.execute(original.prepared, 0)]);
  // An unbounded implementation never starts a recovery GET, so fail without hanging.
  await nextTurn();
  const started = f.reads('old');
  if (!started) { release.resolve(); await pending; assert.equal(started, 1); }
  await entered.promise;
  try { await f.fill('pressure', 20); }
  finally { release.resolve(); }
  const posts = f.posts(), results = await pending;
  assert.equal(f.reads('old'), 1);
  assert.deepEqual(results[0].lease, original.prepared.lease);
  for (const [index, ordinal] of [[1, 0], [2, 1], [3, 0]]) {
    assert.equal(results[index].state, 'already_committed');
    assert.deepEqual(results[index].receipt, original.results[ordinal].receipt);
  }
  assert.equal(f.posts(), posts);
});

test('retention evicts unknown payloads without forgetting their fence, even after verified status', async () => {
  const f = createFixture();
  f.control.execute = (_value, body) => {
    if (body.operationId === 'unknown') throw new Error('synthetic acknowledgement loss');
    return _value;
  };
  const original = await f.client.prepare('unknown', 'grant-unknown');
  await assert.rejects(f.client.execute(original, 0), { code: 'OUTCOME_UNKNOWN' });
  await f.fill('hot', 32);
  const before = f.requests.length, posts = f.posts();
  await assert.rejects(f.client.prepare('unknown', 'grant-unknown'), { code: 'OUTCOME_UNKNOWN' });
  await assert.rejects(f.client.execute(original, 1), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.requests.length, before);
  const observed = await f.client.status('unknown');
  assert.equal(observed.effects[0].receiptVerified, true);
  await assert.rejects(f.client.execute(observed.prepared, 1), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.posts(), posts);
});

test('retention pins concurrent mutations and rejects excess hot admissions before capability I/O', async () => {
  const f = createFixture(), release = Promise.withResolvers();
  f.control.capabilities = () => release.promise;
  const pending = Array.from({ length: 16 }, (_, i) => f.client.prepare(`busy-${i}`, `grant-busy-${i}`));
  const duplicate = f.client.prepare('busy-0', 'grant-busy-0');
  const overflow = f.client.prepare('overflow', 'grant-overflow').then(value => ({ value }), error => ({ error }));
  await nextTurn();
  const beforeRelease = f.requests.length;
  release.resolve();
  const values = await Promise.all([...pending, duplicate]);
  assert.equal((await overflow).error?.code, 'CLIENT_CAPACITY_EXCEEDED');
  assert.equal(beforeRelease, 16);
  assert.deepEqual(values[0], values.at(-1));
  assert.equal(f.requests.filter(request => request.operationId === 'busy-0' && request.kind === 'prepare').length, 1);
});

test('retention keeps a pending execute coalesced while other operations evict idle payloads', async () => {
  const f = createFixture(), prepared = await f.client.prepare('pending', 'grant-pending');
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.control.execute = async (result, body) => {
    if (body.operationId === 'pending') { entered.resolve(); await release.promise; }
    return result;
  };
  const first = f.client.execute(prepared, 0);
  await entered.promise;
  const second = f.client.execute(prepared, 0);
  await assert.rejects(f.client.execute(prepared, 1), { code: 'EXECUTION_IN_PROGRESS' });
  try { await f.fill('pressure', 32); }
  finally { release.resolve(); }
  assert.deepEqual(await first, await second);
  assert.equal(f.requests.filter(request => request.kind === 'execute' && request.operationId === 'pending').length, 1);
});

test('retention bounds all metadata at 65536 IDs, keeps unknown fences, and rejects new IDs without wire activity', async () => {
  const f = createFixture({ count: 1 }), original = await f.complete('old');
  await f.fill('cap-hot', 16);
  for (let i = 0; i < 65536 - 18; i++) assert.equal((await f.client.status(`unknown-${i}`)).code, 'OUTCOME_UNKNOWN');
  const boundary = await Promise.allSettled([f.client.status('last-slot'), f.client.status('over-cap')]);
  assert.equal(boundary[0].value.code, 'OUTCOME_UNKNOWN');
  assert.equal(boundary[1].reason.code, 'CLIENT_CAPACITY_EXCEEDED');
  assert.equal(f.reads('over-cap'), 0, 'concurrent admission cannot overbook the last metadata slot');
  const before = f.requests.length;
  await assert.rejects(f.client.prepare('new', 'grant-new'), { code: 'CLIENT_CAPACITY_EXCEEDED' });
  await assert.rejects(f.client.execute(makePreparation('new-execute', 'grant-new-execute', 1), 0), { code: 'CLIENT_CAPACITY_EXCEEDED' });
  await assert.rejects(f.client.status('new-status'), { code: 'CLIENT_CAPACITY_EXCEEDED' });
  await assert.rejects(f.client.prepare('unknown-0', 'grant-unknown-0'), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.requests.length, before);
  const posts = f.posts();
  assert.equal((await f.client.execute(original.prepared, 0)).state, 'already_committed');
  assert.equal(f.reads('old'), 1, 'existing recorded IDs remain recoverable at capacity');
  assert.equal(f.posts(), posts);
});

test('retention releases settled preparation promises and evicted receipt payloads while the SDK client stays alive', () => {
  const fixture = new URL('./retention-fixture.mjs', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { setImmediate as nextTurn } from 'node:timers/promises';
    import { createFixture } from ${JSON.stringify(fixture)};
    const f = createFixture();
    async function originals() {
      const { prepared, results } = await f.complete('old');
      return [new WeakRef(prepared), new WeakRef(results[0])];
    }
    const refs = await originals();
    await f.fill('hot', 32);
    for (let i = 0; i < 4; i++) { await nextTurn(); global.gc(); }
    assert.ok(refs.every(ref => ref.deref() === undefined), 'settled promises and evicted payloads must not keep full snapshots alive');
    assert.equal((await f.client.prepare('old', 'grant-old')).operationId, 'old');
    assert.equal(f.reads('old'), 1);
  `;
  execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], { timeout: 30000, stdio: 'pipe' });
});
