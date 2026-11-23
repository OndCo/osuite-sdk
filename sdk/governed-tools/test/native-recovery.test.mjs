import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createGovernedTools } from '../executor.mjs';
import { OperationJournal } from '../journal.mjs';
import { checkRecoveryAuthority } from '../recovery.mjs';
import { setup, params, operationId } from './native-recovery.fixture.mjs';

async function uncertain(f, native = params()) {
  await assert.rejects(f.tools.run(operationId, native, f.original), { code: 'OUTCOME_UNKNOWN' });
}

for (const [label, contract, initialEffects] of [
  ['C1 authoritative settled absence', 'settled-absence', 0],
  ['C3 same-business-ID receipt replay', 'same-id-idempotent', 1],
]) test(`${label} recovers only explicitly with fresh linked admission`, async t => {
  const f = await setup(t, contract);
  await assert.rejects(f.tools.run(operationId, params(), f.original), { code: 'OUTCOME_UNKNOWN' });
  const parent = await f.tools.status(operationId);
  assert.equal(parent.state, 'uncertain');
  assert.equal(f.resource.effects.length, initialEffects);
  await assert.rejects(f.tools.run(operationId, params(), f.original), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.resource.calls, 1);
  assert.equal(f.resource.observations, 0, 'run/status never invoke a recovery adapter');
  assert.equal(typeof f.tools.recover, 'function', 'explicit evidence-bound recovery API is missing');
  const result = await f.tools.recover(operationId, params());
  assert.deepEqual(result, { received: params(), receipt: 'receipt-1' });
  assert.equal(f.resource.effects.length, 1);
  assert.equal(f.resource.calls, 2);
  assert.equal(f.counts.creates, 2);
  assert.equal(f.counts.guard, 2);
  assert.equal(f.counts.invalidSignatures, 0);
  const child = [...f.actions.values()].find(action => action.action_id !== parent.actionId);
  const linkage = JSON.parse(child.input_summary).osuite_native_recovery;
  assert.equal(linkage.parent_action_id, parent.actionId);
  const digest = JSON.parse(child.input_summary).osuite_native_call.input_digest;
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(digest, JSON.parse(f.actions.get(parent.actionId).input_summary).osuite_native_call.input_digest);
  for (const action of f.actions.values()) {
    assert.equal(Object.hasOwn(action, 'tool_input_digest'), false);
    assert.equal(Object.hasOwn(action.action_envelope, 'tool_input_digest'), false);
    assert.equal(JSON.parse(action.action_envelope.input_summary).osuite_native_call.input_digest, digest);
  }
  assert.equal(f.actions.get(parent.actionId).status, 'failed', 'original evidence is not overwritten');
  const status = await f.tools.status(operationId);
  assert.equal(status.state, 'uncertain', 'parent remains an old-client fence');
  assert.equal(status.recoveryAttempt.state, 'completed');
  assert.equal(status.recoveryAttempt.operationId, operationId);
  assert.equal(status.recoveryAttempt.actionId, child.action_id);
  f.tools.close(); const reopened = f.open();
  await assert.rejects(reopened.recover(operationId, params()), { code: 'ALREADY_COMPLETED' });
  await assert.rejects(reopened.run(operationId, params(), f.original), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.resource.calls, 2);
});

for (const [name, change] of [
  ['missing', () => null], ['unsettled', e => ({ ...e, settled: false })],
  ['stale', e => ({ ...e, observedAt: Date.now() - 10000, expiresAt: Date.now() + 1000 })],
  ['expired', e => ({ ...e, expiresAt: Date.now() - 1 })],
  ['future', e => ({ ...e, observedAt: Date.now() + 10000 })],
  ['unbounded lifetime', e => ({ ...e, expiresAt: Date.now() + 100000 })],
  ['wrong operation', e => ({ ...e, operationId: 'other' })],
  ['wrong scope', e => ({ ...e, scope: 'a'.repeat(64) })],
  ['wrong input', e => ({ ...e, inputDigest: 'a'.repeat(64) })],
  ['wrong binding', e => ({ ...e, bindingDigest: 'a'.repeat(64) })],
  ['wrong parent', e => ({ ...e, actionId: 'other' })],
  ['wrong resource', e => ({ ...e, resourceId: 'other' })],
  ['wrong revision', e => ({ ...e, adapterRevision: 'other' })],
  ['wrong contract', e => ({ ...e, contract: 'same-id-idempotent' })],
  ['append-only ambiguity', e => ({ ...e, outcome: 'unknown' })],
  ['append-only applied', e => ({ ...e, outcome: 'applied' })],
  ['oversized proof', e => ({ ...e, proof: { data: 'x'.repeat(9000) } })],
  ['extra field', e => ({ ...e, authorized: true })],
]) test(`${name} evidence cannot authorize recovery`, async t => {
  const f = await setup(t, 'settled-absence', { observe: change });
  await uncertain(f);
  await assert.rejects(f.tools.recover(operationId, params()), { code: 'RECOVERY_EVIDENCE_INVALID' });
  assert.equal(f.resource.calls, 1); assert.equal(f.counts.actionPosts, 1);
});

test('second observation is required and invalidation burns the admitted recovery attempt', async t => {
  let observations = 0;
  const f = await setup(t, 'settled-absence', { observe(e) {
    return ++observations === 2 ? { ...e, settled: false } : e;
  } });
  await uncertain(f);
  await assert.rejects(f.tools.recover(operationId, params()), { code: 'RECOVERY_EVIDENCE_INVALID' });
  assert.equal(observations, 2);
  assert.equal(f.counts.actionPosts, 2); assert.equal(f.resource.calls, 1);
  await assert.rejects(f.open().recover(operationId, params()), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(observations, 2); assert.equal(f.counts.actionPosts, 2);
});

test('native transport errors and absence of an adapter are not recovery evidence', async t => {
  const f = await setup(t);
  const noAdapter = { 'benchmark.invoke': { ...f.bindings['benchmark.invoke'] } };
  delete noAdapter['benchmark.invoke'].recovery;
  const tools = f.open({ bindings: noAdapter });
  await assert.rejects(tools.run('no-adapter', params(), f.original), { code: 'OUTCOME_UNKNOWN' });
  await assert.rejects(tools.recover('no-adapter', params()), { code: 'RECOVERY_UNSUPPORTED' });
  assert.equal(f.resource.calls, 1);
});

test('unsupported recovery gives the exact uncertain parent and no-resend guidance even after restart', async t => {
  const f = await setup(t);
  const { revision, describe } = f.bindings['benchmark.invoke'];
  const bindings = { 'benchmark.invoke': { revision, describe } };
  const first = f.open({ bindings });
  await assert.rejects(first.run(operationId, params(), f.original), { code: 'OUTCOME_UNKNOWN' });
  const parent = await first.status(operationId);
  first.close();
  const reopened = f.open({ bindings }), before = { ...f.counts };
  await assert.rejects(reopened.recover(operationId, params()), error => {
    assert.equal(error.code, 'RECOVERY_UNSUPPORTED');
    assert.equal(error.status?.state, 'uncertain');
    assert.equal(error.status.actionId, parent.actionId);
    assert.equal(error.status.replayUrl, parent.replayUrl);
    assert.equal(error.status.operationId, operationId);
    assert.equal(error.recovery.nextStep, 'reconcile_without_resend');
    assert.match(error.message, /empty lookup/i);
    assert.equal(error.retryAutomatically, false);
    return true;
  });
  assert.deepEqual(f.counts, before);
  assert.equal(f.resource.calls, 1);
  assert.equal(f.resource.observations, 0);
  assert.equal(Object.hasOwn(await reopened.status(operationId), 'recoveryAttempt'), false);
  const db = new DatabaseSync(f.journalPath, { readOnly: true });
  try { assert.equal(db.prepare('SELECT count(*) AS n FROM operations').get().n, 1); }
  finally { db.close(); }
});

test('unsupported recovery never creates a journal record or returns status for a different binding', async t => {
  const f = await setup(t);
  const { revision, describe } = f.bindings['benchmark.invoke'];
  const bindings = { 'benchmark.invoke': { revision, describe } };
  const client = f.open({ bindings });
  await assert.rejects(client.recover(operationId, params()), { code: 'RECOVERY_UNSUPPORTED', status: null });
  assert.equal(await client.status(operationId), null);
  await assert.rejects(client.run(operationId, params(), f.original), { code: 'OUTCOME_UNKNOWN' });
  const before = { ...f.counts };
  const altered = params();
  altered.arguments.arguments.amount++;
  await assert.rejects(client.recover(operationId, altered), { code: 'CONFLICT', status: null });
  const changed = f.open({ bindings: { 'benchmark.invoke': { revision: 'changed', describe } } });
  await assert.rejects(changed.recover(operationId, params()), { code: 'CONFLICT', status: null });
  assert.deepEqual(f.counts, before);
  assert.equal(f.resource.calls, 1);
});

test('changed arguments, mapping, adapter contract or identity cannot borrow an uncertain operation', async t => {
  const f = await setup(t); await uncertain(f);
  const changed = params(); changed.arguments.arguments.amount++;
  await assert.rejects(f.tools.recover(operationId, changed), { code: 'CONFLICT' });
  await assert.rejects(f.tools.recover('new-business-id', params()), { code: 'RECOVERY_UNAVAILABLE' });
  for (const key of ['revision', 'resourceId', 'contract']) {
    const binding = f.bindings['benchmark.invoke'];
    const recovery = { ...binding.recovery, [key]: key === 'contract' ? 'same-id-idempotent' : 'changed' };
    await assert.rejects(f.open({ bindings: { 'benchmark.invoke': { ...binding, recovery } } })
      .recover(operationId, params()), { code: 'CONFLICT' });
  }
  const binding = f.bindings['benchmark.invoke'];
  await assert.rejects(f.open({ bindings: { 'benchmark.invoke': { ...binding, revision: 'mapping-2' } } })
    .recover(operationId, params()), { code: 'CONFLICT' });
  await assert.rejects(f.open({ namespace: 'other-scope' }).recover(operationId, params()), { code: 'RECOVERY_UNAVAILABLE' });
  assert.equal(f.resource.observations, 0); assert.equal(f.counts.actionPosts, 1);
});

for (const options of [{ evidence: {} }, { execute() {} }, { operationId: 'bypass' }, { retry: true }]) {
  test(`caller option ${Object.keys(options)[0]} is never recovery authority`, async t => {
    const f = await setup(t); await uncertain(f);
    await assert.rejects(f.tools.recover(operationId, params(), options), { code: 'INVALID_OPTIONS' });
    assert.equal(f.resource.observations, 0); assert.equal(f.counts.actionPosts, 1);
  });
}

for (const state of ['denied', 'cancelled', 'expired', 'blocked']) {
  for (const source of ['action', 'approval']) test(`current parent ${source} ${state} blocks recovery`, async t => {
    const f = await setup(t); await uncertain(f);
    f.control.mutate = response => { response[source].status = state; if (source === 'approval') response.approval.state = state; };
    await assert.rejects(f.tools.recover(operationId, params()), error => ['POLICY_DENIED', 'CANCELLED', 'APPROVAL_EXPIRED'].includes(error.code));
    assert.equal(f.counts.actionPosts, 1); assert.equal(f.resource.calls, 1);
  });
}

for (const mode of ['block', 'revoked', 'postureUnavailable', 'mismatch']) test(`fresh ${mode} authority prevents recovery`, async t => {
  const f = await setup(t); await uncertain(f);
  if (mode === 'block') f.control.decision = 'block';
  else if (mode === 'mismatch') f.control.mutate = response => { response.action.agent_id = 'other'; };
  else f.control[mode] = true;
  await assert.rejects(f.tools.recover(operationId, params()), error => ['POLICY_DENIED', 'CURRENT_AUTHORITY_UNAVAILABLE', 'BINDING_MISMATCH'].includes(error.code));
  assert.equal(f.resource.calls, 1);
});

test('fresh recovery review survives reopen and never redeems the consumed parent approval', async t => {
  const f = await setup(t); f.control.decision = 'hold';
  await assert.rejects(f.tools.run(operationId, params(), f.original), { code: 'AWAITING_APPROVAL' });
  f.approve(); await uncertain(f);
  const parent = [...f.actions.values()][0], redeemedAt = parent.approval_redeemed_at;
  assert.ok(redeemedAt);
  await assert.rejects(f.tools.recover(operationId, params()), error => {
    assert.equal(error.code, 'AWAITING_APPROVAL');
    assert.equal(error.status.operationId, operationId);
    assert.equal(error.status.actionId, error.status.recoveryAttempt.actionId);
    assert.equal(error.status.parent.actionId, parent.action_id);
    assert.equal(error.status.reviewUrl, error.status.recoveryAttempt.reviewUrl);
    assert.equal(error.status.recoveryAttempt.state, 'held');
    return true;
  });
  assert.equal(f.counts.reviews, 2); assert.equal(f.counts.creates, 2);
  f.tools.close(); const reopened = f.open();
  await assert.rejects(reopened.recover(operationId, params()), { code: 'AWAITING_APPROVAL' });
  f.approve(); assert.equal((await reopened.recover(operationId, params())).receipt, 'receipt-1');
  assert.equal(parent.approval_redeemed_at, redeemedAt);
  assert.equal(f.counts.actionPosts, 4); assert.equal(f.resource.calls, 2);
});

test('cancellation during the last observation prevents recovery dispatch', async t => {
  let count = 0, f;
  f = await setup(t, 'settled-absence', { observe(e) {
    if (++count === 2) [...f.actions.values()][0].status = 'cancelled';
    return e;
  } });
  await uncertain(f);
  await assert.rejects(f.tools.recover(operationId, params()), { code: 'CANCELLED' });
  assert.equal(f.resource.calls, 1); assert.equal(f.counts.creates, 2);
});

test('concurrent instances can dispatch one recovery only', async t => {
  let entered, finish;
  const entering = new Promise(resolve => { entered = resolve; });
  const release = new Promise(resolve => { finish = resolve; });
  const f = await setup(t, 'settled-absence', { async beforeExecute() { entered(); await release; } });
  await uncertain(f);
  const first = f.tools.recover(operationId, params());
  await entering;
  await assert.rejects(f.open().recover(operationId, params()), { code: 'OUTCOME_UNKNOWN' });
  finish(); await first;
  assert.equal(f.resource.effects.length, 1); assert.equal(f.counts.creates, 2);
});

test('uncertain recovery is durable and never retries even with later authoritative absence', async t => {
  const f = await setup(t, 'settled-absence', { beforeExecute() { throw new Error('PRIVATE-FAILURE'); } });
  await uncertain(f);
  await assert.rejects(f.tools.recover(operationId, params()), { code: 'OUTCOME_UNKNOWN' });
  const observations = f.resource.observations;
  await assert.rejects(f.open().recover(operationId, params()), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.resource.observations, observations);
  assert.equal(f.counts.actionPosts, 2); assert.equal(f.resource.calls, 1);
});

test('registry, arguments, evidence and adapter context are immutable snapshots; durable state retains only digests', async t => {
  let evidence, seen;
  const f = await setup(t, 'settled-absence', {
    observe(e) { evidence = e; e.proof.privateValue = 'PRIVATE-PROOF'; return e; },
    beforeExecute(native, context) {
      seen = context;
      assert.ok(Object.isFrozen(native.arguments.arguments));
      assert.ok(Object.isFrozen(context.binding)); assert.ok(Object.isFrozen(context.evidence.proof));
      evidence.proof.privateValue = 'changed';
      assert.equal(context.evidence.proof.privateValue, 'PRIVATE-PROOF');
    },
  });
  await uncertain(f);
  f.bindings['benchmark.invoke'].recovery.execute = () => { throw new Error('mutable replacement'); };
  f.bindings['benchmark.invoke'].recovery.revision = 'replaced';
  assert.equal((await f.tools.recover(operationId, params())).receipt, 'receipt-1');
  assert.equal(seen.binding.adapterRevision, 'recovery-1');
  f.tools.close();
  const db = new DatabaseSync(f.journalPath);
  const rows = db.prepare('SELECT * FROM operations').all();
  assert.equal(rows.length, 2);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  const child = rows.find(row => row.state === 'completed');
  assert.match(child.error_code, /^recovery_[0-9a-f]{64}$/);
  db.close();
  for (const file of fs.readdirSync(f.root).filter(name => name.startsWith('operations.sqlite'))) {
    const bytes = fs.readFileSync(`${f.root}/${file}`);
    assert.equal(bytes.includes('PRIVATE-PROOF'), false); assert.equal(bytes.includes('receipt-1'), false);
    assert.equal(bytes.includes('proposal-1'), false);
  }
});

test('adapter descriptors reject accessors and proxies without running them', async t => {
  const f = await setup(t);
  let calls = 0;
  const binding = f.bindings['benchmark.invoke'];
  for (const recovery of [
    new Proxy({}, { ownKeys() { calls++; return []; } }),
    { ...binding.recovery, get execute() { calls++; return () => {}; } },
  ]) assert.throws(() => createGovernedTools({ ...f.options, bindings: { 'benchmark.invoke': { ...binding, recovery } } }), { code: 'INVALID_MAPPING' });
  assert.equal(calls, 0);
});

for (const fault of ['create', 'redemption']) test(`lost recovery ${fault} reply is never replayed`, async t => {
  const f = await setup(t); await uncertain(f);
  if (fault === 'redemption') {
    f.control.decision = 'hold';
    await assert.rejects(f.tools.recover(operationId, params()), { code: 'AWAITING_APPROVAL' });
    f.approve();
  }
  f.control.drop = fault;
  await assert.rejects(f.tools.recover(operationId, params()), { code: 'OUTCOME_UNKNOWN' });
  const posts = f.counts.actionPosts, observations = f.resource.observations;
  f.control.drop = null;
  await assert.rejects(f.open().recover(operationId, params()), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.counts.actionPosts, posts); assert.equal(f.resource.observations, observations);
  assert.equal(f.resource.calls, 1);
});

for (const state of ['held', 'uncertain_request', 'uncertain_redemption', 'completed', 'denied', 'cancelled', 'expired']) {
  test(`parent ${state} is not a settled uncertain execution`, async t => {
    const f = await setup(t);
    if (state === 'completed') { f.resource.fault = null; await f.tools.run(operationId, params(), f.original); }
    else if (state === 'denied') {
      f.control.decision = 'block';
      await assert.rejects(f.tools.run(operationId, params(), f.original), { code: 'POLICY_DENIED' });
    } else if (state === 'uncertain_request') {
      f.control.drop = 'create';
      await assert.rejects(f.tools.run(operationId, params(), f.original), { code: 'OUTCOME_UNKNOWN' });
    } else {
      f.control.decision = 'hold';
      await assert.rejects(f.tools.run(operationId, params(), f.original), { code: 'AWAITING_APPROVAL' });
      if (state === 'uncertain_redemption') {
        f.approve(); f.control.drop = 'redemption';
        await assert.rejects(f.tools.run(operationId, params(), f.original), { code: 'OUTCOME_UNKNOWN' });
      } else if (state !== 'held') {
        [...f.actions.values()][0].status = state;
        await assert.rejects(f.tools.run(operationId, params(), f.original));
      }
    }
    f.control.drop = null;
    const calls = f.resource.calls, posts = f.counts.actionPosts;
    await assert.rejects(f.tools.recover(operationId, params()), error => {
      assert.equal(error.retryAutomatically, false);
      return ['RECOVERY_UNAVAILABLE', 'OUTCOME_UNKNOWN', 'ALREADY_COMPLETED', 'POLICY_DENIED', 'CANCELLED', 'APPROVAL_EXPIRED'].includes(error.code);
    });
    assert.equal(f.resource.calls, calls); assert.equal(f.counts.actionPosts, posts);
    assert.equal(f.resource.observations, 0);
  });
}

test('in-flight original dispatch cannot recover, including while the callback has not yet returned', async t => {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const f = await setup(t);
  const run = f.tools.run(operationId, params(), async native => { enter(); await pending; return f.original(native); });
  const rejected = assert.rejects(run, { code: 'OUTCOME_UNKNOWN' });
  await entered;
  await assert.rejects(f.tools.recover(operationId, params()), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.resource.observations, 0);
  release(); await rejected;
});

for (const fault of ['cancelled', 'expired', 'fingerprint', 'expired-grant', 'parent-link']) test(`changed current recovery ${fault} stops dispatch`, async t => {
  let count = 0, f;
  f = await setup(t, 'settled-absence', { observe(e) {
    if (++count === 3) {
      const child = [...f.actions.values()][1];
      if (fault === 'parent-link') {
        const summary = JSON.parse(child.input_summary); summary.osuite_native_recovery.parent_action_id = 'other';
        child.input_summary = JSON.stringify(summary);
      } else if (fault === 'expired-grant') child.approval_expires_at = new Date(Date.now() - 1).toISOString();
      else if (fault === 'fingerprint') child.action_envelope.cava.fingerprint = 'changed';
      else child.status = fault;
    }
    return e;
  } });
  await uncertain(f); f.control.decision = 'hold';
  await assert.rejects(f.tools.recover(operationId, params()), { code: 'AWAITING_APPROVAL' });
  f.approve();
  await assert.rejects(f.tools.recover(operationId, params()), error =>
    ['CANCELLED', 'APPROVAL_EXPIRED', 'BINDING_MISMATCH', 'OUTCOME_UNKNOWN'].includes(error.code));
  assert.equal(f.resource.calls, 1);
});

for (const abortAt of ['initial', 'revalidate']) test(`abort during ${abortAt} observation never reaches recovery callback`, async t => {
  const controller = new AbortController(); let count = 0;
  const f = await setup(t, 'settled-absence', { observe(e) {
    if (++count === (abortAt === 'initial' ? 1 : 2)) controller.abort();
    return e;
  } });
  await uncertain(f);
  await assert.rejects(f.tools.recover(operationId, params(), { signal: controller.signal }), { code: 'ABORTED' });
  assert.equal(f.resource.calls, 1);
});

for (const expired of ['admission', 'evidence']) test(`${expired} aging during durable recovery fence blocks dispatch`, async t => {
  const f = await setup(t); await uncertain(f);
  const settle = OperationJournal.prototype.settle;
  const wallNow = Date.now, monotonic = performance.now.bind(performance); let elapsed = 0;
  t.mock.method(Date, 'now', () => wallNow() + (expired === 'evidence' ? elapsed : 0));
  t.mock.method(performance, 'now', () => monotonic() + (expired === 'admission' ? elapsed : 0));
  t.mock.method(OperationJournal.prototype, 'settle', function (...args) {
    const result = Reflect.apply(settle, this, args);
    if (args[4] === 'dispatching' && result) elapsed = 6000;
    return result;
  });
  await assert.rejects(f.tools.recover(operationId, params()), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.resource.calls, 1);
  await assert.rejects(f.open().recover(operationId, params()), { code: 'OUTCOME_UNKNOWN' });
});

for (const result of [{ isError: true }, new Date(), { payload: 'x'.repeat(70000) }]) {
  test(`non-success or opaque recovery result (${Object.prototype.toString.call(result)}) remains uncertain`, async t => {
    const f = await setup(t, 'settled-absence', { afterExecute() { return result; } });
    await uncertain(f);
    await assert.rejects(f.tools.recover(operationId, params()), { code: 'OUTCOME_UNKNOWN' });
    assert.equal((await f.tools.status(operationId)).recoveryAttempt.state, 'uncertain');
    await assert.rejects(f.open().recover(operationId, params()), { code: 'OUTCOME_UNKNOWN' });
    assert.equal(f.resource.calls, 2); assert.equal(f.resource.effects.length, 1);
  });
}

test('idempotent evidence may remain unknown while exact replay recovers the actual receipt', async t => {
  const f = await setup(t, 'same-id-idempotent', { observe(e) { return { ...e, outcome: 'unknown' }; } });
  await uncertain(f);
  assert.equal((await f.tools.recover(operationId, params())).receipt, 'receipt-1');
  assert.equal(f.resource.effects.length, 1);
});

test('generic API-fetch calls cannot use a commit-only adapter', async t => {
  const f = await setup(t), native = params(); native.arguments.tool_name = 'api_fetch';
  await uncertain(f, native);
  await assert.rejects(f.tools.recover(operationId, native), { code: 'RECOVERY_EVIDENCE_INVALID' });
  assert.equal(f.resource.calls, 1); assert.equal(f.counts.actionPosts, 1);
});

test('resource read failure is not absence and a missing journal is never rebuilt for recovery', async t => {
  const f = await setup(t); await uncertain(f); f.resource.unavailable = true;
  await assert.rejects(f.tools.recover(operationId, params()), { code: 'RECOVERY_EVIDENCE_INVALID' });
  f.tools.close(); fs.unlinkSync(f.journalPath);
  assert.throws(() => f.open(), { code: 'JOURNAL_MISSING' });
  assert.equal(fs.existsSync(f.journalPath), false); assert.equal(f.resource.calls, 1);
});

test('lost recovery report acknowledgement preserves the actual receipt without replay', async t => {
  const f = await setup(t); await uncertain(f); f.control.drop = 'report';
  assert.equal((await f.tools.recover(operationId, params())).receipt, 'receipt-1');
  assert.equal((await f.tools.status(operationId)).recoveryAttempt.reportState, 'uncertain');
  await assert.rejects(f.open().recover(operationId, params()), { code: 'ALREADY_COMPLETED' });
  assert.equal(f.resource.calls, 2);
});

test('a remotely pending parent cannot be bypassed by a recovery admission', async t => {
  const f = await setup(t); await uncertain(f);
  [...f.actions.values()][0].status = 'pending_approval';
  await assert.rejects(f.tools.recover(operationId, params()), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.counts.actionPosts, 1); assert.equal(f.resource.calls, 1);
});

test('a recovery grant expiring during the durable fence cannot dispatch even with fresh resource evidence', async t => {
  const f = await setup(t); await uncertain(f); f.control.decision = 'hold';
  await assert.rejects(f.tools.recover(operationId, params()), { code: 'AWAITING_APPROVAL' });
  f.approve();
  const child = [...f.actions.values()][1];
  const settle = OperationJournal.prototype.settle, now = Date.now; let expired = false;
  t.mock.method(Date, 'now', () => now() + (expired ? 1000 : 0));
  t.mock.method(OperationJournal.prototype, 'settle', function (...args) {
    const result = Reflect.apply(settle, this, args);
    if (args[4] === 'dispatching' && result) expired = true;
    return result;
  });
  child.approval_expires_at = new Date(now() + 500).toISOString();
  await assert.rejects(f.tools.recover(operationId, params()), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.resource.calls, 1);
});

test('close during status preserves the in-progress recovery status read', async t => {
  const f = await setup(t); await uncertain(f);
  await f.tools.recover(operationId, params());
  f.control.mutate = () => { f.tools.close(); };
  assert.equal((await f.tools.status(operationId)).recoveryAttempt.state, 'completed');
  await assert.rejects(f.tools.status(operationId), { code: 'CLOSED' });
});

for (const type of ['accessor', 'proxy']) test(`${type} evidence never runs untrusted descriptors`, async t => {
  let reads = 0;
  const f = await setup(t, 'settled-absence', { observe(e) {
    if (type === 'proxy') return new Proxy(e, { ownKeys() { reads++; return []; } });
    return Object.defineProperty(e, 'proof', { enumerable: true, get() { reads++; return {}; } });
  } });
  await uncertain(f);
  await assert.rejects(f.tools.recover(operationId, params()), { code: 'RECOVERY_EVIDENCE_INVALID' });
  assert.equal(reads, 0); assert.equal(f.resource.calls, 1);
});

test('ordinary clients without the installed recovery binding cannot replay either journal row', async t => {
  const f = await setup(t); await uncertain(f);
  await f.tools.recover(operationId, params());
  const legacy = { ...f.bindings['benchmark.invoke'] }; delete legacy.recovery;
  const oldBinding = f.open({ bindings: { 'benchmark.invoke': legacy } });
  await assert.rejects(oldBinding.run(operationId, params(), f.original), { code: 'CONFLICT' });
  assert.equal((await oldBinding.status(operationId)).state, 'uncertain');
  assert.equal(f.resource.calls, 2);
});

test('changed input summary cannot hide the signed parent link', async t => {
  const f = await setup(t); await uncertain(f);
  f.control.mutate = response => {
    const summary = JSON.parse(response.action.input_summary);
    if (summary.osuite_native_recovery) {
      summary.osuite_native_recovery.parent_action_id = 'different-parent';
      response.action.input_summary = JSON.stringify(summary);
    }
  };
  await assert.rejects(f.tools.recover(operationId, params()), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.resource.calls, 1);
  await assert.rejects(f.open().recover(operationId, params()), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.counts.actionPosts, 2);
});

test('validated scoped-rule authority expiry also bounds recovery dispatch', async t => {
  const deadline = Date.now() + 1000;
  const body = { action: { status: 'running', timestamp_end: null,
    action_envelope: { cava: { fingerprint: 'expected' } } } };
  const authority = { async read() { return { available: true, body, action: body.action }; } };
  const admission = { phase: 'requesting', response: body, ruleExpiresAt: new Date(deadline).toISOString() };
  assert.equal(await checkRecoveryAuthority(authority, {}, admission), deadline);
  t.mock.method(Date, 'now', () => deadline);
  await assert.rejects(checkRecoveryAuthority(authority, {}, admission), { code: 'OUTCOME_UNKNOWN' });
});

for (const target of ['parent', 'child']) for (const location of ['action', 'envelope']) {
  for (const change of ['changed', 'null']) test(`${target} current ${location} input digest duplicate ${change} cannot borrow a valid embedded marker`, async t => {
    let observations = 0, f;
    const mutate = action => {
      const value = location === 'action' ? action : action.action_envelope;
      value.tool_input_digest = change === 'null' ? null : 'a'.repeat(64);
    };
    f = await setup(t, 'settled-absence', { observe(e) {
      if (++observations === 2 && target === 'child') mutate([...f.actions.values()][1]);
      return e;
    } });
    await uncertain(f);
    const original = [...f.actions.values()][0];
    const marker = JSON.parse(original.input_summary).osuite_native_call;
    if (target === 'parent') mutate(original);
    await assert.rejects(f.tools.recover(operationId, params()), { code: 'BINDING_MISMATCH' });
    assert.deepEqual(JSON.parse(original.input_summary).osuite_native_call, marker);
    assert.equal(f.resource.calls, 1);
    assert.equal(f.resource.effects.length, 0);
    if (target === 'child') {
      const child = [...f.actions.values()][1];
      assert.equal(JSON.parse(child.input_summary).osuite_native_call.input_digest, marker.input_digest);
      await assert.rejects(f.open().recover(operationId, params()), { code: 'OUTCOME_UNKNOWN' });
      assert.equal(f.counts.actionPosts, 2);
    } else {
      assert.equal((await f.tools.status(operationId)).remote.bindingMismatch, true);
      assert.equal(observations, 0); assert.equal(f.counts.actionPosts, 1);
    }
  });
}

for (const target of ['parent', 'child']) for (const location of ['action', 'envelope']) {
  for (const change of ['changed', 'missing', 'null']) test(`${target} current ${location} persisted input marker ${change} cannot dispatch recovery`, async t => {
    let observations = 0, f;
    const mutate = action => {
      const value = location === 'action' ? action : action.action_envelope;
      const summary = JSON.parse(value.input_summary);
      if (change === 'missing') delete summary.osuite_native_call.input_digest;
      else summary.osuite_native_call.input_digest = change === 'null' ? null : 'a'.repeat(64);
      value.input_summary = JSON.stringify(summary);
    };
    f = await setup(t, 'settled-absence', { observe(e) {
      if (++observations === 2 && target === 'child') mutate([...f.actions.values()][1]);
      return e;
    } });
    await uncertain(f);
    if (target === 'parent') mutate([...f.actions.values()][0]);
    await assert.rejects(f.tools.recover(operationId, params()), { code: 'BINDING_MISMATCH' });
    assert.equal(f.resource.calls, 1); assert.equal(f.resource.effects.length, 0);
    if (target === 'child') {
      assert.equal(observations, 2);
      await assert.rejects(f.open().recover(operationId, params()), { code: 'OUTCOME_UNKNOWN' });
      assert.equal(f.counts.actionPosts, 2);
    } else {
      assert.equal((await f.tools.status(operationId)).remote.bindingMismatch, true);
      assert.equal(observations, 0); assert.equal(f.counts.actionPosts, 1);
    }
  });
}

test('recovery approval error exposes the actionable child at top level with immutable parent linkage', async t => {
  const f = await setup(t); await uncertain(f);
  const parent = await f.tools.status(operationId);
  f.control.decision = 'hold';
  const check = error => {
    assert.equal(error.code, 'AWAITING_APPROVAL');
    const child = error.status.recoveryAttempt;
    assert.equal(error.status.operationId, operationId);
    assert.equal(error.status.actionId, child.actionId);
    assert.equal(error.status.state, 'held');
    assert.equal(error.status.reviewUrl, child.reviewUrl);
    assert.equal(error.status.replayUrl, child.replayUrl);
    assert.notEqual(error.status.reviewUrl, parent.reviewUrl);
    assert.equal(error.status.parent.actionId, parent.actionId);
    assert.equal(error.status.parent.reviewUrl, parent.reviewUrl);
    assert.equal(error.status.parent.state, 'uncertain');
    assert.equal(Object.isFrozen(error.status.parent), true);
    assert.equal(error.status.recovery.nextStep, 'review_same_operation');
    return true;
  };
  await assert.rejects(f.tools.recover(operationId, params()), check);
  f.tools.close(); const reopened = f.open();
  await assert.rejects(reopened.recover(operationId, params()), check);
  const status = await reopened.status(operationId);
  assert.equal(status.actionId, parent.actionId);
  assert.equal(status.reviewUrl, parent.reviewUrl);
  assert.equal(status.recoveryAttempt.state, 'held');
  assert.equal(f.counts.creates, 2); assert.equal(f.resource.calls, 1);
});
