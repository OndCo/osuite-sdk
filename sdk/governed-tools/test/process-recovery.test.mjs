import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { studioFixture, bindings, params } from './studio.fixture.mjs';

const childUrl = new URL('./process-recovery.child.mjs', import.meta.url);
const executorUrl = new URL('../executor.mjs', import.meta.url);
const namespace = 'process-recovery';
const crashExitCode = 73;

function worker() {
  const child = fork(childUrl, [], {
    execPath: process.execPath,
    execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const messages = [], waiters = [];
  let finished = false, failure = null, stderr = '', stdout = '';
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const diagnostic = message => new Error(`${message}; child=${child.pid}; stderr=${stderr}`);
  const rejectWaiters = error => {
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  };
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
  child.on('message', message => {
    messages.push(message);
    if (message.type === 'fatal') {
      failure = diagnostic(`child fixture failed: ${JSON.stringify(message.error)}`);
      rejectWaiters(failure);
      return;
    }
    for (const waiter of [...waiters]) {
      if (waiter.types.includes(message.type)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  child.on('error', error => {
    failure = error;
    rejectWaiters(error);
  });
  child.on('close', (code, signal) => {
    finished = true;
    rejectWaiters(failure || diagnostic(`child closed before its expected IPC checkpoint (${code}, ${signal})`));
    resolveClosed({ code, signal });
  });
  return {
    pid: child.pid,
    messages,
    closed,
    get stdout() { return stdout; },
    waitFor(types) {
      types = Array.isArray(types) ? types : [types];
      const received = messages.find(message => types.includes(message.type));
      if (received) return Promise.resolve(received);
      if (failure || finished) return Promise.reject(failure || diagnostic(`missing IPC checkpoint: ${types.join(',')}`));
      return new Promise((resolve, reject) => { waiters.push({ types, resolve, reject }); });
    },
    send(message) {
      return new Promise((resolve, reject) => {
        child.send(message, error => error ? reject(error) : resolve());
      });
    },
    async stop() {
      if (!finished) child.kill('SIGKILL');
      await closed;
    },
  };
}

async function setup(t) {
  assert.ok(existsSync(childUrl), 'independent process recovery child fixture must be implemented');
  assert.ok(existsSync(executorUrl), 'process recovery tests require the real governed tools executor');
  assert.equal(Number(process.versions.node.split('.')[0]), 24);
  const { createGovernedTools } = await import(executorUrl);
  const fixture = await studioFixture();
  const children = [];
  t.after(async () => {
    await Promise.all(children.map(child => child.stop()));
    await fixture.close();
  });
  // Provision once deliberately; ordinary process opens must never recreate a lost journal.
  const provisioned = createGovernedTools({ config: fixture.config, journalPath: fixture.journalPath,
    namespace, bindings, initializeJournal: true });
  provisioned.close();
  assert.ok(existsSync(fixture.journalPath), 'parent must provision the shared journal before children open it');
  return {
    ...fixture,
    async start(operationId, mode = 'normal') {
      const child = worker();
      children.push(child);
      const booted = await child.waitFor('booted');
      assert.equal(booted.pid, child.pid);
      assert.notEqual(child.pid, process.pid);
      assert.equal(Number(booted.nodeVersion.split('.')[0]), 24);
      await child.send({ type: 'init', config: fixture.config, journalPath: fixture.journalPath, namespace, operationId, mode });
      const ready = await child.waitFor('ready');
      assert.equal(ready.journalPath, fixture.journalPath);
      assert.equal(ready.operationId, operationId);
      return child;
    },
    async inspect(operationId) {
      const tools = createGovernedTools({ config: fixture.config, journalPath: fixture.journalPath,
        namespace, bindings, initializeJournal: false });
      try { return await tools.status(operationId); }
      finally { tools.close(); }
    },
  };
}

async function finishedOutcome(child) {
  const outcome = await child.waitFor('outcome');
  assert.deepEqual(await child.closed, { code: 0, signal: null });
  assert.equal(child.stdout, '', 'native execution evidence must come from IPC and the server, not stdout');
  return outcome;
}

function assertSameOperation(actual, expected) {
  for (const key of ['operationId', 'actionId', 'reviewUrl', 'replayUrl']) {
    assert.equal(actual[key], expected[key], `${key} must survive process replacement`);
  }
}

function executionCounts(counts) {
  const { guard, actionPosts, creates, reviews, reports, writes, invalidSignatures } = counts;
  return { guard, actionPosts, creates, reviews, reports, writes, invalidSignatures };
}

test('independent concurrent children share a same-ID dispatch fence and produce at most one HTTP effect', { timeout: 20000 }, async t => {
  const f = await setup(t);
  const operationId = 'concurrent-append';
  const children = await Promise.all([
    f.start(operationId, 'pause-after-effect'),
    f.start(operationId, 'pause-after-effect'),
  ]);
  assert.notEqual(children[0].pid, children[1].pid);
  await Promise.all(children.map(child => child.send({ type: 'run' })));

  // A winning callback stays dispatching until its independent peer has attempted the same ID.
  const checkpoints = await Promise.all(children.map(child => child.waitFor(['effect', 'outcome'])));
  assert.ok(f.counts.writes <= 1, 'server observed duplicate native HTTP effects');
  assert.equal(checkpoints.filter(message => message.type === 'effect').length, 1, 'one real dispatch is required, not two failed startups');
  const winnerIndex = checkpoints.findIndex(message => message.type === 'effect');
  const rejected = checkpoints[1 - winnerIndex];
  assert.equal(rejected.type, 'outcome');
  assert.equal(rejected.ok, false);
  assert.ok(['OPERATION_BUSY', 'OUTCOME_UNKNOWN', 'CURRENT_AUTHORITY_UNAVAILABLE', 'JOURNAL_BUSY'].includes(rejected.error.code),
    `unexpected concurrent rejection: ${JSON.stringify(rejected.error)}`);
  assert.equal(rejected.nativeCalls, 0);
  assert.equal(f.counts.writes, 1);
  assert.equal(f.counts.reports, 0, 'the winning callback has not returned or reported yet');
  assert.equal(f.counts.creates, 1);
  assert.equal(f.actions.size, 1);
  const during = await f.inspect(operationId);
  assert.equal(during.state, 'dispatching');
  assert.equal(during.reportState, 'not_reported');

  await children[winnerIndex].send({ type: 'release' });
  const outcomes = await Promise.all(children.map(child => finishedOutcome(child)));
  assert.equal(outcomes.filter(outcome => outcome.ok).length, 1);
  const succeeded = outcomes[winnerIndex];
  assert.deepEqual(succeeded.result, { received: params(), write: 1 });
  assert.equal(succeeded.nativeCalls, 1);
  assert.equal(succeeded.status.state, 'completed');
  assert.equal(succeeded.status.reportState, 'confirmed');
  assertSameOperation(succeeded.status, during);
  assert.equal(f.counts.actionPosts, 1);
  assert.equal(f.counts.creates, 1);
  assert.equal(f.counts.reviews, 0);
  assert.equal(f.counts.reports, 1);
  assert.equal(f.counts.writes, 1);
  assert.equal(f.counts.invalidSignatures, 0);
});

test('four concurrent different-ID children complete identical calls with exactly four HTTP effects and no retries', { timeout: 20000 }, async t => {
  const f = await setup(t);
  const operationIds = Array.from({ length: 4 }, (_, index) => `independent-append-${index + 1}`);
  const children = await Promise.all(operationIds.map(operationId => f.start(operationId, 'pause-after-effect')));
  assert.equal(new Set(children.map(child => child.pid)).size, 4);

  // All four ordinary opens are ready before one fixed burst; no per-child retries or cache isolation.
  await Promise.all(children.map(child => child.send({ type: 'run' })));
  const checkpoints = await Promise.all(children.map(child => child.waitFor(['effect', 'outcome'])));
  assert.equal(f.counts.reports, 0, 'successful callbacks wait for all four first-attempt checkpoints');
  await Promise.all(children.filter((_, index) => checkpoints[index].type === 'effect')
    .map(child => child.send({ type: 'release' })));
  const outcomes = await Promise.all(children.map(child => finishedOutcome(child)));
  const summary = outcomes.map((outcome, index) => ({ operationId: operationIds[index], pid: children[index].pid,
    ok: outcome.ok, nativeCalls: outcome.nativeCalls, error: outcome.error, status: outcome.status }));
  assert.deepEqual(outcomes.map(outcome => outcome.ok), [true, true, true, true],
    `every distinct operation must succeed on its first attempt; counts=${JSON.stringify(f.counts)}; outcomes=${JSON.stringify(summary)}`);

  for (const [index, outcome] of outcomes.entries()) {
    assert.equal(checkpoints[index].type, 'effect');
    assert.equal(outcome.nativeCalls, 1);
    assert.deepEqual(outcome.result.received, params());
    assert.equal(outcome.status.operationId, operationIds[index]);
    assert.equal(outcome.status.state, 'completed');
    assert.equal(outcome.status.reportState, 'confirmed');
    assert.equal(children[index].messages.filter(message => message.type === 'effect').length, 1);
    assert.equal(children[index].messages.filter(message => message.type === 'outcome').length, 1);
  }
  assert.deepEqual(outcomes.map(outcome => outcome.result.write).sort((a, b) => a - b), [1, 2, 3, 4]);
  assert.equal(new Set(outcomes.map(outcome => outcome.status.actionId)).size, 4);
  assert.equal(new Set(outcomes.map(outcome => outcome.status.reviewUrl)).size, 4);
  assert.equal(f.actions.size, 4);
  assert.equal(new Set([...f.actions.values()].map(action => action.runtime_session_id)).size, 4);
  assert.equal(new Set([...f.actions.values()].map(action => action.tool_input_digest)).size, 1);
  assert.deepEqual(executionCounts(f.counts), {
    guard: 4, actionPosts: 4, creates: 4, reviews: 0, reports: 4, writes: 4, invalidSignatures: 0,
  });
});

test('child exit after a real HTTP effect leaves dispatching fenced across process restart without reporting or resending', { timeout: 20000 }, async t => {
  const f = await setup(t);
  const operationId = 'crashed-append';
  const crashed = await f.start(operationId, 'exit-after-effect');
  await crashed.send({ type: 'run' });
  const effect = await crashed.waitFor('effect');
  assert.deepEqual(effect.result, { received: params(), write: 1 });
  assert.equal(effect.nativeCalls, 1);
  assert.deepEqual(await crashed.closed, { code: crashExitCode, signal: null });
  assert.equal(crashed.messages.some(message => message.type === 'outcome'), false);
  assert.equal(f.counts.writes, 1);
  assert.equal(f.counts.reports, 0);
  assert.equal(f.counts.actionPosts, 1);
  assert.equal(f.counts.creates, 1);

  const fenced = await f.inspect(operationId);
  assert.equal(fenced.state, 'dispatching');
  assert.equal(fenced.reportState, 'not_reported');
  assert.equal(fenced.resultDigest, null);
  assert.equal(fenced.retryAutomatically, false);
  assert.equal(fenced.remote.available, true);
  assert.equal(fenced.remote.status, 'running');
  const beforeRestart = executionCounts(f.counts);
  const restarted = await f.start(operationId);
  assert.notEqual(restarted.pid, crashed.pid);
  await restarted.send({ type: 'run' });
  const outcome = await finishedOutcome(restarted);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'OUTCOME_UNKNOWN');
  assert.equal(outcome.error.retryAutomatically, false);
  assert.equal(outcome.nativeCalls, 0);
  assert.equal(outcome.status.state, 'dispatching');
  assert.equal(outcome.status.reportState, 'not_reported');
  assertSameOperation(outcome.status, fenced);
  assertSameOperation(outcome.error.status, fenced);
  assert.equal(restarted.messages.some(message => message.type === 'effect'), false);
  assert.deepEqual(executionCounts(f.counts), beforeRestart);
  assert.equal(f.actions.size, 1);
  assert.equal(f.actions.get(fenced.actionId).timestamp_end, null);
  assert.equal(f.counts.invalidSignatures, 0);
});

test('a held child returns AWAITING_APPROVAL and a different child redeems the same action and review for one HTTP effect', { timeout: 20000 }, async t => {
  const f = await setup(t);
  f.control.decision = 'hold';
  const operationId = 'reviewed-append';
  const heldChild = await f.start(operationId);
  await heldChild.send({ type: 'run' });
  const held = await finishedOutcome(heldChild);
  assert.equal(held.ok, false);
  assert.equal(held.error.code, 'AWAITING_APPROVAL');
  assert.equal(held.status.state, 'held');
  assert.equal(held.status.remote.status, 'pending_approval');
  assert.equal(held.nativeCalls, 0);
  assertSameOperation(held.status, held.error.status);
  assert.equal(f.counts.writes, 0);
  assert.equal(f.counts.reports, 0);
  assert.equal(f.counts.creates, 1);
  assert.equal(f.counts.reviews, 1);
  assert.equal(f.counts.actionPosts, 1);
  assert.equal(f.actions.size, 1);
  const actionBefore = structuredClone(f.actions.get(held.status.actionId));
  assert.equal(actionBefore.status, 'pending_approval');

  f.approve();
  assert.equal(f.actions.get(held.status.actionId).approved_by, 'synthetic-reviewer');
  assert.equal(f.actions.get(held.status.actionId).approval_redeemed_at, null);
  assert.equal(f.counts.writes, 0, 'reviewer approval alone cannot execute the native callback');
  const resumed = await f.start(operationId);
  assert.notEqual(resumed.pid, heldChild.pid);
  await resumed.send({ type: 'run' });
  const completed = await finishedOutcome(resumed);
  assert.equal(completed.ok, true, JSON.stringify(completed.error));
  assert.deepEqual(completed.result, { received: params(), write: 1 });
  assert.equal(completed.nativeCalls, 1);
  assert.equal(completed.status.state, 'completed');
  assert.equal(completed.status.reportState, 'confirmed');
  assertSameOperation(completed.status, held.status);
  const actionAfter = f.actions.get(held.status.actionId);
  for (const key of ['action_id', 'runtime_session_id', 'tool_use_id', 'tool_input_digest', 'input_summary']) {
    assert.equal(actionAfter[key], actionBefore[key], `the original action's ${key} must remain bound`);
  }
  assert.equal(actionAfter.status, 'completed');
  assert.equal(typeof actionAfter.approval_redeemed_at, 'string');
  assert.equal(f.actions.size, 1);
  assert.equal(f.counts.actionPosts, 2, 'one create plus one redemption, not another review');
  assert.equal(f.counts.creates, 1);
  assert.equal(f.counts.reviews, 1);
  assert.equal(f.counts.reports, 1);
  assert.equal(f.counts.writes, 1);
  assert.equal(f.counts.invalidSignatures, 0);
});
