import test from 'node:test';
import assert from 'node:assert/strict';
import { GovernedToolError, publicStatus } from '../contract.mjs';
import { createGovernedTools } from '../executor.mjs';
import { studioFixture, bindings, params } from './studio.fixture.mjs';

const nextSteps = {
  prepared: 'check_current_authority', held: 'review_same_operation',
  requesting: 'reconcile_without_resend', redeeming: 'reconcile_without_resend',
  uncertain_request: 'reconcile_without_resend', uncertain_redemption: 'reconcile_without_resend',
  dispatching: 'reconcile_without_resend', uncertain: 'reconcile_without_resend',
  completed: 'read_business_result', denied: 'stop', expired: 'stop', cancelled: 'stop',
};
for (const [state, nextStep] of Object.entries(nextSteps)) {
  test(`status ${state} gives bounded guidance without execution authority`, () => {
    const record = { operationId: 'same-id', actionId: 'act-test', state, reportState: 'not_reported',
      arguments: 'private-input', result: 'private-output' };
    const status = publicStatus(record, 'https://studio.example.test');
    assert.equal(status.recovery.nextStep, nextStep);
    assert.equal(status.recovery.preserveOperationId, true);
    assert.equal(status.retryAutomatically, false);
    assert.equal(Object.isFrozen(status.recovery), true);
    assert.ok(status.recovery.message.length < 800);
    assert.doesNotMatch(JSON.stringify(status), /private-input|private-output/);
    assert.equal(Object.hasOwn(status.recovery, 'authorized'), false);
  });
}

for (const [code, nextStep] of [
  ['AWAITING_APPROVAL', 'review_same_operation'], ['ALREADY_COMPLETED', 'read_business_result'],
  ['POLICY_DENIED', 'stop'], ['CURRENT_AUTHORITY_UNAVAILABLE', 'restore_connection'],
  ['BINDING_MISMATCH', 'reconcile_without_resend'], ['OUTCOME_UNKNOWN', 'reconcile_without_resend'],
  ['JOURNAL_MISSING', 'repair_journal'], ['JOURNAL_FULL', 'repair_journal'],
]) {
  test(`structured ${code} error explains recovery without changing its code`, () => {
    const error = new GovernedToolError(code);
    assert.equal(error.code, code);
    assert.equal(error.retryAutomatically, false);
    assert.equal(error.recovery.nextStep, nextStep);
    assert.ok(error.message.includes(error.recovery.message));
    assert.doesNotMatch(error.message, /new operation ID|delete (?:the )?journal/i);
  });
}

test('held, restored and completed guidance remains tied to one action and one real HTTP write', async t => {
  const f = await studioFixture();
  const options = { config: f.config, namespace: 'guidance', journalPath: f.journalPath, bindings };
  let tools = createGovernedTools({ ...options, initializeJournal: true });
  t.after(async () => { tools.close(); await f.close(); });
  f.control.decision = 'hold';
  let held;
  await assert.rejects(tools.run('same-id', params(), f.write), error => {
    held = error.status;
    assert.equal(error.recovery.nextStep, 'review_same_operation');
    return error.code === 'AWAITING_APPROVAL';
  });
  tools.close(); tools = createGovernedTools(options);
  f.approve();
  const snapshot = await tools.status('same-id');
  assert.equal(snapshot.actionId, held.actionId);
  assert.equal(snapshot.recovery.nextStep, 'review_same_operation');
  assert.equal(f.counts.actionPosts, 1); assert.equal(f.counts.writes, 0);
  await tools.run('same-id', params(), f.write);
  await assert.rejects(tools.run('same-id', params(), f.write), error => {
    assert.equal(error.recovery.nextStep, 'read_business_result');
    assert.equal(error.status.actionId, held.actionId);
    return error.code === 'ALREADY_COMPLETED';
  });
  assert.equal(f.counts.creates, 1); assert.equal(f.counts.reviews, 1); assert.equal(f.counts.writes, 1);
});

test('status cannot suggest resuming a held operation when remote binding or access is invalid', async t => {
  const f = await studioFixture();
  const tools = createGovernedTools({ config: f.config, namespace: 'guidance', journalPath: f.journalPath, bindings, initializeJournal: true });
  t.after(async () => { tools.close(); await f.close(); });
  f.control.decision = 'hold';
  await assert.rejects(tools.run('same-id', params(), f.write), { code: 'AWAITING_APPROVAL' });
  f.control.mutate = response => { response.action.agent_id = 'different-actor'; };
  assert.equal((await tools.status('same-id')).recovery.nextStep, 'reconcile_without_resend');
  f.control.mutate = null; f.control.revoked = true;
  assert.equal((await tools.status('same-id')).recovery.nextStep, 'restore_connection');
  assert.equal(f.counts.actionPosts, 1); assert.equal(f.counts.writes, 0);
});

for (const remoteState of ['blocked', 'denied', 'expired', 'cancelled']) {
  for (const source of ['action', 'approval']) {
    if (source === 'approval' && remoteState === 'blocked') continue;
    test(`held status stops on remote ${source} ${remoteState} without changing local state or sending`, async t => {
      const f = await studioFixture();
      const tools = createGovernedTools({ config: f.config, namespace: 'guidance', journalPath: f.journalPath, bindings, initializeJournal: true });
      t.after(async () => { tools.close(); await f.close(); });
      f.control.decision = 'hold';
      await assert.rejects(tools.run('same-id', params(), f.write), { code: 'AWAITING_APPROVAL' });
      const before = await tools.status('same-id');
      f.control.mutate = response => {
        if (source === 'action') response.action.status = remoteState;
        else response.approval.state = remoteState;
      };
      const status = await tools.status('same-id');
      assert.equal(status.recovery.nextStep, 'stop');
      assert.equal(status.state, 'held');
      assert.equal(status.operationId, before.operationId);
      assert.equal(status.actionId, before.actionId);
      assert.equal(status.retryAutomatically, false);
      assert.equal(status.recovery.preserveOperationId, true);
      assert.equal(Object.isFrozen(status.recovery), true);
      assert.equal(Object.hasOwn(status, 'authorized'), false);
      assert.equal(Object.hasOwn(status.recovery, 'authorized'), false);
      f.control.mutate = null;
      assert.deepEqual(await tools.status('same-id'), before);
      assert.equal(f.counts.actionPosts, 1); assert.equal(f.counts.writes, 0);
    });
  }
}

for (const [code, state, nextStep] of [
  ['BINDING_MISMATCH', 'held', 'reconcile_without_resend'],
  ['BINDING_MISMATCH', 'completed', 'reconcile_without_resend'],
  ['CURRENT_AUTHORITY_UNAVAILABLE', 'held', 'restore_connection'],
  ['ALREADY_COMPLETED', 'completed', 'read_business_result'],
  ['OUTCOME_UNKNOWN', 'uncertain', 'reconcile_without_resend'],
]) {
  test(`${code} keeps top-level and nested ${state} guidance consistent without mutating status`, () => {
    const status = Object.freeze({ ...publicStatus({ operationId: 'same-id', actionId: 'act-test', state,
      reportState: 'uncertain', resultDigest: 'a'.repeat(64) }, 'https://studio.example.test'), elapsedMs: 17 });
    const before = structuredClone(status);
    const error = new GovernedToolError(code, status);
    assert.equal(error.recovery.nextStep, nextStep);
    assert.equal(error.status.recovery, error.recovery);
    assert.equal(Object.isFrozen(error.status), true);
    assert.equal(Object.isFrozen(error.recovery), true);
    assert.deepEqual(error.status, { ...before, recovery: error.recovery });
    assert.deepEqual(status, before);
    assert.equal(error.retryAutomatically, false);
    assert.equal(Object.hasOwn(error.recovery, 'authorized'), false);
  });
}

test('a held binding-mismatch error never leaves resume guidance in nested status', async t => {
  const f = await studioFixture();
  const tools = createGovernedTools({ config: f.config, namespace: 'guidance', journalPath: f.journalPath, bindings, initializeJournal: true });
  t.after(async () => { tools.close(); await f.close(); });
  f.control.decision = 'hold';
  await assert.rejects(tools.run('same-id', params(), f.write), { code: 'AWAITING_APPROVAL' });
  f.control.mutate = response => { response.action.agent_id = 'different-actor'; };
  await assert.rejects(tools.run('same-id', params(), f.write), error => {
    assert.equal(error.code, 'BINDING_MISMATCH');
    assert.equal(error.status.state, 'held');
    assert.equal(error.status.operationId, 'same-id');
    assert.equal(error.recovery.nextStep, 'reconcile_without_resend');
    assert.equal(error.status.recovery, error.recovery);
    assert.equal(error.retryAutomatically, false);
    assert.equal(Object.hasOwn(error.status.recovery, 'authorized'), false);
    return true;
  });
  assert.equal(f.counts.actionPosts, 1); assert.equal(f.counts.writes, 0);
});

for (const [state, nextStep] of [['completed', 'read_business_result'], ['uncertain', 'reconcile_without_resend']]) {
  test(`remote rejection preserves ${state} guidance, result and send count`, async t => {
    const f = await studioFixture();
    const tools = createGovernedTools({ config: f.config, namespace: 'guidance', journalPath: f.journalPath, bindings, initializeJournal: true });
    t.after(async () => { tools.close(); await f.close(); });
    let nativeResult;
    const result = await tools.run('same-id', params(), async native => {
      const output = await f.write(native);
      nativeResult = state === 'uncertain' ? { ...output, isError: true } : output;
      return nativeResult;
    });
    assert.equal(result, nativeResult);
    const before = await tools.status('same-id');
    assert.equal(before.state, state);
    f.control.mutate = response => { response.action.status = 'cancelled'; };
    const status = await tools.status('same-id');
    assert.deepEqual(status, { ...before, remote: { ...before.remote, status: 'cancelled' } });
    assert.equal(status.recovery.nextStep, nextStep);
    assert.equal(Object.hasOwn(status.recovery, 'authorized'), false);
    assert.equal(f.counts.actionPosts, 1); assert.equal(f.counts.writes, 1);
  });
}
