import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStateStore } from '../../runtime/state.mjs';
import { studioFixture, bindings, params } from './studio.fixture.mjs';

async function setup(t, overrides = {}) {
  const moduleUrl = new URL('../executor.mjs', import.meta.url);
  assert.ok(fs.existsSync(moduleUrl), 'governed native tool executor must be implemented');
  const { createGovernedTools } = await import(moduleUrl);
  const fixture = await studioFixture();
  const options = { config: fixture.config, namespace: 'billing', journalPath: fixture.journalPath, bindings, ...overrides };
  const instances = [];
  let first = true;
  const open = () => { const tools = createGovernedTools({ ...options, initializeJournal: first }); first = false; instances.push(tools); return tools; };
  t.after(async () => { for (const tools of instances) tools.close(); await fixture.close(); });
  return { ...fixture, options, open, tools: open() };
}

test('native name, arguments and returned result survive an admitted HTTP side effect', async t => {
  const f = await setup(t), original = params();
  const result = await f.tools.run('append-1', original, f.write);
  assert.deepEqual(result, { received: original, write: 1 });
  assert.equal(f.counts.writes, 1); assert.equal(f.counts.creates, 1);
  assert.equal(f.counts.invalidSignatures, 0);
  const status = await f.tools.status('append-1');
  assert.equal(status.state, 'completed'); assert.equal(status.reportState, 'confirmed');
  assert.equal(status.coverage, 'wrapped-call-only'); assert.equal(status.admissionPath, 'studio-current-action');
  assert.equal(status.resultRetained, false);
});

test('a completed operation never executes twice and never fabricates a cached native result', async t => {
  const f = await setup(t);
  await f.tools.run('append-1', params(), f.write);
  await assert.rejects(f.tools.run('append-1', params(), f.write), { code: 'ALREADY_COMPLETED' });
  assert.equal(f.counts.writes, 1); assert.equal(f.counts.actionPosts, 1);
});

test('same arguments with different operation IDs are separate intended work', async t => {
  const f = await setup(t);
  await f.tools.run('append-1', params(), f.write);
  await f.tools.run('append-2', params(), f.write);
  assert.equal(f.counts.writes, 2); assert.equal(f.counts.creates, 2);
  assert.equal(new Set([...f.actions.values()].map(a => a.runtime_session_id)).size, 2);
});

test('transient configuration-cache contention rereads authority without repeating any action or native call', async t => {
  const f = await setup(t);
  const store = createStateStore({ ...f.config, stateDir: path.join(f.root, 'posture') });
  const lock = `${store.path('posture')}.lock`;
  fs.mkdirSync(lock, { mode: 0o700 });
  f.control.beforePosture = () => { if (f.control.postureRequests === 2) fs.rmdirSync(lock); };
  assert.equal((await f.tools.run('append-1', params(), f.write)).write, 1);
  assert.equal(f.control.postureRequests, 2);
  assert.equal(f.counts.guard, 1); assert.equal(f.counts.actionPosts, 1); assert.equal(f.counts.writes, 1);
});

test('a stuck configuration-cache lock fails within a bounded read budget and is never cleared automatically', async t => {
  const f = await setup(t);
  const store = createStateStore({ ...f.config, stateDir: path.join(f.root, 'posture') });
  const lock = `${store.path('posture')}.lock`;
  fs.mkdirSync(lock, { mode: 0o700 });
  await assert.rejects(f.tools.run('append-1', params(), f.write), { code: 'CURRENT_AUTHORITY_UNAVAILABLE' });
  assert.ok(f.control.postureRequests >= 1 && f.control.postureRequests <= 6);
  assert.equal(fs.existsSync(lock), true);
  assert.equal(f.counts.guard, 0); assert.equal(f.counts.actionPosts, 0); assert.equal(f.counts.writes, 0);
});

test('changed arguments under one operation ID conflict before another request or effect', async t => {
  const f = await setup(t); f.control.decision = 'hold';
  await assert.rejects(f.tools.run('append-1', params(), f.write), { code: 'AWAITING_APPROVAL' });
  const changed = params(); changed.arguments.amount = 9;
  await assert.rejects(f.tools.run('append-1', changed, f.write), /conflict/i);
  assert.equal(f.counts.writes, 0); assert.equal(f.counts.actionPosts, 1);
});

test('pending review survives timeout and journal reopen without duplicate action or review', async t => {
  const f = await setup(t); f.control.decision = 'hold';
  const start = performance.now();
  await assert.rejects(f.tools.run('append-1', params(), f.write, { waitMs: 75 }), error => {
    assert.equal(error.code, 'AWAITING_APPROVAL'); assert.ok(error.status.elapsedMs >= 70); return true;
  });
  assert.ok(performance.now() - start >= 70);
  f.tools.close(); const resumed = f.open();
  await assert.rejects(resumed.run('append-1', params(), f.write), { code: 'AWAITING_APPROVAL' });
  assert.equal(f.counts.creates, 1); assert.equal(f.counts.reviews, 1); assert.equal(f.counts.actionPosts, 1);
  f.approve();
  assert.equal((await resumed.run('append-1', params(), f.write)).write, 1);
  assert.equal(f.counts.actionPosts, 2); assert.equal(f.counts.creates, 1); assert.equal(f.counts.writes, 1);
});

test('bounded full Studio evidence responses above 256 KiB preserve held recovery without Hook capability', async t => {
  const f = await setup(t); f.control.decision = 'hold';
  f.control.mutate = response => { response.evidence = 'x'.repeat(320 * 1024); };
  await assert.rejects(f.tools.run('append-1', params(), f.write), { code: 'AWAITING_APPROVAL' });
  f.tools.close(); const resumed = f.open();
  await assert.rejects(resumed.run('append-1', params(), f.write), { code: 'AWAITING_APPROVAL' });
  f.approve();
  assert.equal((await resumed.run('append-1', params(), f.write)).write, 1);
  assert.equal(f.counts.actionPosts, 2); assert.equal(f.counts.creates, 1); assert.equal(f.counts.reviews, 1);
  assert.equal(f.config.ruleRolloutCapability, undefined);
});

test('Studio responses exceeding the explicit 1 MiB bound never authorize or cause an automatic resend', async t => {
  const f = await setup(t);
  f.control.mutate = response => { response.evidence = 'x'.repeat(1024 * 1024); };
  await assert.rejects(f.tools.run('append-1', params(), f.write), { code: 'OUTCOME_UNKNOWN' });
  await assert.rejects(f.tools.run('append-1', params(), f.write), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.counts.writes, 0); assert.equal(f.counts.actionPosts, 1);
});

test('GET observes approval but never executes or consumes the grant', async t => {
  const f = await setup(t); f.control.decision = 'hold';
  await assert.rejects(f.tools.run('append-1', params(), f.write), { code: 'AWAITING_APPROVAL' });
  f.approve(); await f.tools.status('append-1');
  assert.equal(f.counts.writes, 0); assert.equal(f.counts.actionPosts, 1);
  assert.equal([...f.actions.values()][0].approval_redeemed_at, null);
});

test('current policy blocking an earlier human approval prevents dispatch', async t => {
  const f = await setup(t); f.control.decision = 'hold';
  await assert.rejects(f.tools.run('append-1', params(), f.write), { code: 'AWAITING_APPROVAL' });
  f.approve(); f.control.decision = 'block';
  await assert.rejects(f.tools.run('append-1', params(), f.write), { code: 'POLICY_DENIED' });
  assert.equal(f.counts.writes, 0); assert.equal(f.counts.creates, 1);
});

for (const [field, value] of [['org_id', 'other-org'], ['agent_id', 'other-agent'], ['verified', false], ['action_id', 'act-other']]) {
  test(`mismatched ${field} in admission cannot authorize the native call`, async t => {
    const f = await setup(t); f.control.mutate = response => { response.action[field] = value; };
    await assert.rejects(f.tools.run('append-1', params(), f.write));
    assert.equal(f.counts.writes, 0);
    await assert.rejects(f.tools.run('append-1', params(), f.write));
    assert.equal(f.counts.actionPosts, 1);
  });
}

for (const corrupt of ['session', 'digest', 'redemption']) {
  test(`held resume rejects corrupted ${corrupt} evidence`, async t => {
    const f = await setup(t); f.control.decision = 'hold';
    await assert.rejects(f.tools.run('append-1', params(), f.write), { code: 'AWAITING_APPROVAL' });
    f.approve();
    f.control.mutate = response => {
      if (corrupt === 'session') response.action.action_envelope.runtime_session_id = 'wrong-session';
      if (corrupt === 'digest') response.action.input_summary = '{}';
      if (corrupt === 'redemption') delete response.action.approval_redeemed_at;
    };
    await assert.rejects(f.tools.run('append-1', params(), f.write)); assert.equal(f.counts.writes, 0);
  });
}

test('hard denial has no resource write or unnecessary review', async t => {
  const f = await setup(t); f.control.decision = 'block';
  await assert.rejects(f.tools.run('append-1', params(), f.write), { code: 'POLICY_DENIED' });
  await assert.rejects(f.tools.run('append-1', params(), f.write), { code: 'POLICY_DENIED' });
  assert.equal(f.counts.writes, 0); assert.equal(f.counts.reviews, 0); assert.equal(f.counts.creates, 0);
});

for (const setting of ['observe', 'missing-server-signature', 'revoked', 'unavailable']) {
  test(`current posture ${setting} is not execution authority`, async t => {
    const f = await setup(t);
    if (setting === 'observe') f.control.postureMode = 'observe';
    if (setting === 'missing-server-signature') f.control.signatureRequired = false;
    if (setting === 'revoked') f.control.revoked = true;
    if (setting === 'unavailable') f.control.postureUnavailable = true;
    await assert.rejects(f.tools.run('append-1', params(), f.write), { code: 'CURRENT_AUTHORITY_UNAVAILABLE' });
    assert.equal(f.counts.writes, 0); assert.equal(f.counts.creates, 0);
  });
}

test('lost creation reply is not resent; only a proven pending record can recover', async t => {
  const f = await setup(t); f.control.decision = 'hold'; f.control.drop = 'create';
  await assert.rejects(f.tools.run('append-1', params(), f.write), { code: 'OUTCOME_UNKNOWN' });
  f.control.drop = null; f.tools.close(); const resumed = f.open();
  await assert.rejects(resumed.run('append-1', params(), f.write), { code: 'AWAITING_APPROVAL' });
  assert.equal(f.counts.actionPosts, 1); f.approve();
  await resumed.run('append-1', params(), f.write);
  assert.equal(f.counts.creates, 1); assert.equal(f.counts.writes, 1);
});

test('lost direct allow reply remains uncertain and is not replayed after restart', async t => {
  const f = await setup(t); f.control.drop = 'create';
  await assert.rejects(f.tools.run('append-1', params(), f.write), { code: 'OUTCOME_UNKNOWN' });
  f.control.drop = null; f.tools.close();
  await assert.rejects(f.open().run('append-1', params(), f.write), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.counts.actionPosts, 1); assert.equal(f.counts.writes, 0);
});

test('lost redemption reply remains fenced even when the server has consumed approval', async t => {
  const f = await setup(t); f.control.decision = 'hold';
  await assert.rejects(f.tools.run('append-1', params(), f.write), { code: 'AWAITING_APPROVAL' });
  f.approve(); f.control.drop = 'redemption';
  await assert.rejects(f.tools.run('append-1', params(), f.write), { code: 'OUTCOME_UNKNOWN' });
  f.tools.close();
  await assert.rejects(f.open().run('append-1', params(), f.write), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.counts.actionPosts, 2); assert.equal(f.counts.writes, 0);
});

test('lost completion acknowledgement does not hide the native result or repeat its effect', async t => {
  const f = await setup(t); f.control.drop = 'report';
  assert.equal((await f.tools.run('append-1', params(), f.write)).write, 1);
  const status = await f.tools.status('append-1');
  assert.equal(status.state, 'completed'); assert.equal(status.reportState, 'uncertain');
  await assert.rejects(f.tools.run('append-1', params(), f.write), { code: 'ALREADY_COMPLETED' });
  assert.equal(f.counts.writes, 1); assert.equal(f.counts.reports, 1);
});

test('exception after a real side effect is uncertain rather than safe to repeat', async t => {
  const f = await setup(t);
  const execute = async p => { await f.write(p); throw new Error('PRIVATE-NATIVE-ERROR'); };
  await assert.rejects(f.tools.run('append-1', params(), execute), error => {
    assert.equal(error.code, 'OUTCOME_UNKNOWN'); assert.equal(error.message.includes('PRIVATE-NATIVE-ERROR'), false); return true;
  });
  f.tools.close(); await assert.rejects(f.open().run('append-1', params(), f.write), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.counts.writes, 1);
});

test('MCP isError is preserved but does not assert that no side effect happened', async t => {
  const f = await setup(t), result = { isError: true, content: [{ type: 'text', text: 'native error' }] };
  assert.equal(await f.tools.run('append-1', params(), async () => result), result);
  assert.equal((await f.tools.status('append-1')).state, 'uncertain');
  await assert.rejects(f.tools.run('append-1', params(), f.write), { code: 'OUTCOME_UNKNOWN' });
});

test('caller mutation during admission cannot change the dispatched arguments', async t => {
  const f = await setup(t), original = params();
  const running = f.tools.run('append-1', original, f.write);
  original.arguments.amount = 999;
  assert.equal((await running).received.arguments.amount, 3);
});

test('two journal owners race for one operation and at most one invokes the resource', async t => {
  const f = await setup(t), second = f.open();
  const outcomes = await Promise.allSettled([f.tools.run('append-1', params(), f.write), second.run('append-1', params(), f.write)]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  assert.equal(f.counts.writes, 1); assert.equal(f.counts.creates, 1);
});

test('already aborted call never starts admission and does not cancel a held approval', async t => {
  const f = await setup(t); const controller = new AbortController(); controller.abort();
  await assert.rejects(f.tools.run('append-1', params(), f.write, { signal: controller.signal }), { code: 'ABORTED' });
  assert.equal(f.counts.guard, 0); assert.equal(f.counts.writes, 0);
});

test('local journal never stores complete native arguments or results', async t => {
  const f = await setup(t);
  const input = params(); input.arguments.privateValue = 'PRIVATE-ARGUMENT-123';
  await f.tools.run('append-1', input, async () => ({ secret: 'PRIVATE-RESULT-123' }));
  f.tools.close();
  for (const file of fs.readdirSync(f.root).filter(name => name.startsWith('operations.sqlite'))) {
    const bytes = fs.readFileSync(new URL(file, `file://${f.root}/`));
    assert.equal(bytes.includes('PRIVATE-ARGUMENT-123'), false); assert.equal(bytes.includes('PRIVATE-RESULT-123'), false);
  }
});

test('close during a native call lets its already-started outcome settle but rejects new work', async t => {
  const f = await setup(t);
  let announce, finish;
  const entered = new Promise(resolve => { announce = resolve; });
  const release = new Promise(resolve => { finish = resolve; });
  const running = f.tools.run('append-1', params(), async p => { announce(); await release; return f.write(p); });
  await entered; f.tools.close(); finish();
  assert.equal((await running).write, 1);
  await assert.rejects(f.tools.run('append-2', params(), f.write), { code: 'CLOSED' });
  assert.equal((await f.open().status('append-1')).state, 'completed');
});

test('journal conflicts retain structured no-retry errors through the public boundary', async t => {
  const f = await setup(t); f.control.decision = 'hold';
  await assert.rejects(f.tools.run('append-1', params(), f.write), { code: 'AWAITING_APPROVAL' });
  const changed = params(); changed.arguments.amount++;
  await assert.rejects(f.tools.run('append-1', changed, f.write), error => {
    assert.equal(error.name, 'GovernedToolError'); assert.equal(error.code, 'CONFLICT');
    assert.equal(error.retryAutomatically, false); return true;
  });
});

test('a lost create reply followed by missing server evidence remains unknown, not safe to recreate', async t => {
  const f = await setup(t); f.control.drop = 'create';
  await assert.rejects(f.tools.run('append-1', params(), f.write), { code: 'OUTCOME_UNKNOWN' });
  f.actions.clear(); f.control.drop = null;
  await assert.rejects(f.tools.run('append-1', params(), f.write), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.counts.actionPosts, 1); assert.equal(f.counts.writes, 0);
});

test('null arguments cannot borrow an approved empty-object invocation', async t => {
  const f = await setup(t, { bindings: { 'ledger.append': { revision: 'constant-1', describe: () => ({
    action_type: 'api', declared_goal: 'Append configured record', input_summary: { target: 'ledger-A' },
  }) } } });
  f.control.decision = 'hold';
  await assert.rejects(f.tools.run('append-1', { name: 'ledger.append', arguments: null }, f.write), { code: 'AWAITING_APPROVAL' });
  f.approve();
  await assert.rejects(f.tools.run('append-1', { name: 'ledger.append', arguments: {} }, f.write), { code: 'CONFLICT' });
  assert.equal(f.counts.writes, 0);
});

test('lost-create pending recovery durably binds the observed approval fingerprint', async t => {
  const f = await setup(t); f.control.decision = 'hold'; f.control.drop = 'create';
  await assert.rejects(f.tools.run('append-1', params(), f.write), { code: 'OUTCOME_UNKNOWN' });
  f.control.drop = null;
  await assert.rejects(f.tools.run('append-1', params(), f.write), { code: 'AWAITING_APPROVAL' });
  f.approve(); f.control.mutate = response => { response.action.action_envelope.cava.fingerprint = 'b'.repeat(64); };
  await assert.rejects(f.tools.run('append-1', params(), f.write));
  assert.equal(f.counts.writes, 0);
});

test('a cold client cannot discard its explicitly configured scoped-rule floor', async t => {
  const f = await setup(t); f.tools.close();
  f.options.config = { ...f.config, ruleRollout: { enabled: true, version: 2, credential_id: 'key-native',
    connection_generation: 1, scope: { org_id: f.config.orgId, agent_id: f.config.agentId,
      runtime_id: f.config.runtimeId, provider: 'sdk', connection_id: 'dc-test' } } };
  await assert.rejects(f.open().run('append-1', params(), f.write), { code: 'CURRENT_AUTHORITY_UNAVAILABLE' });
  assert.equal(f.counts.writes, 0); assert.equal(f.counts.actionPosts, 0);
});

test('ordinary reopen refuses a missing journal instead of reconstructing uncertain work', async t => {
  const f = await setup(t);
  await assert.rejects(f.tools.run('append-1', params(), async p => { await f.write(p); throw new Error(); }), { code: 'OUTCOME_UNKNOWN' });
  f.tools.close(); fs.unlinkSync(f.journalPath);
  assert.throws(() => f.open(), { code: 'JOURNAL_MISSING' });
  assert.equal(f.counts.actionPosts, 1); assert.equal(f.counts.writes, 1); assert.equal(fs.existsSync(f.journalPath), false);
});

test('large MCP error results remain uncertain even when the result digest is unavailable', async t => {
  const f = await setup(t), result = { isError: true, content: [{ type: 'text', text: 'x'.repeat(70000) }] };
  assert.equal(await f.tools.run('append-1', params(), async () => result), result);
  assert.equal((await f.tools.status('append-1')).state, 'uncertain');
  assert.equal([...f.actions.values()][0].status, 'failed');
});

test('report bookkeeping contention cannot hide a durably observed successful native result', async t => {
  const f = await setup(t), writer = new DatabaseSync(f.journalPath);
  f.control.beforeReport = () => { writer.exec('BEGIN IMMEDIATE'); };
  f.control.drop = 'report';
  try {
    assert.equal((await f.tools.run('append-1', params(), f.write)).write, 1);
  } finally { writer.exec('ROLLBACK'); writer.close(); }
  const status = await f.tools.status('append-1');
  assert.equal(status.state, 'completed'); assert.equal(status.reportState, 'uncertain'); assert.equal(f.counts.writes, 1);
});

test('an unsupported mandatory assumption-capture posture is refused rather than ignored', async t => {
  const f = await setup(t); f.control.assumptionCaptureRequired = true;
  await assert.rejects(f.tools.run('append-1', params(), f.write), { code: 'CURRENT_AUTHORITY_UNAVAILABLE' });
  assert.equal(f.counts.writes, 0); assert.equal(f.counts.actionPosts, 0);
});
