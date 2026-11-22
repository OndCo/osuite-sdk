import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const moduleUrl = new URL('../contract.mjs', import.meta.url);
async function contract() {
  assert.ok(existsSync(moduleUrl), 'native invocation contract must be implemented');
  return import(moduleUrl);
}
const config = { baseUrl: 'https://studio.example', orgId: 'org-a', agentId: 'agent-a', runtimeId: 'sdk', provider: null };
const bindings = { 'ledger.append': { revision: 'mapping-1', describe: args => ({
  action_type: 'api', declared_goal: 'Append a ledger record', systems_touched: ['ledger-A'],
  reversible: false, input_summary: { target: args.target, amount: args.amount },
}) } };

test('snapshots exact JSON input without mutating caller data', async () => {
  const { jsonSnapshot } = await contract();
  const original = { a: [1, 'text', null, false], target: 'ledger-A' };
  const copy = jsonSnapshot(original);
  assert.deepEqual(copy, original); assert.notEqual(copy, original);
  original.a.push('later'); assert.equal(copy.a.length, 4);
  assert.ok(Object.isFrozen(copy)); assert.ok(Object.isFrozen(copy.a));
});

for (const value of [undefined, NaN, Infinity, -0, 2n, () => {}, new Date(), Buffer.from('x'), new Map(), { a: undefined }, [undefined], Symbol('x')]) {
  test(`rejects lossy/non-JSON value ${typeof value} ${Object.prototype.toString.call(value)}`, async () => {
    const { jsonSnapshot } = await contract();
    assert.throws(() => jsonSnapshot(value), { code: 'INVALID_INPUT' });
  });
}

test('does not execute accessors, toJSON or proxy traps while validating data', async () => {
  const { jsonSnapshot } = await contract();
  let executed = 0;
  const accessor = Object.defineProperty({}, 'value', { enumerable: true, get() { executed++; return 1; } });
  const proxy = new Proxy({}, { ownKeys() { executed++; return []; } });
  for (const value of [accessor, proxy, { toJSON() { executed++; return {}; } }]) {
    assert.throws(() => jsonSnapshot(value), { code: 'INVALID_INPUT' });
  }
  assert.equal(executed, 0);
});

test('rejects cycles, sparse arrays, symbols, prototype keys and bounded overflow', async () => {
  const { jsonSnapshot } = await contract();
  const cycle = {}; cycle.self = cycle;
  for (const input of [cycle, new Array(3), { [Symbol('x')]: 1 }, JSON.parse('{"__proto__":{}}'), '\ud800', 'x'.repeat(65537)]) {
    assert.throws(() => jsonSnapshot(input), { code: 'INVALID_INPUT' });
  }
});

test('same operation is stable while identical input under a different ID has a distinct session', async () => {
  const { makeInvocation } = await contract();
  const params = { name: 'ledger.append', arguments: { target: 'ledger-A', amount: 3 } };
  const a = makeInvocation({ config, namespace: 'billing', bindings, operationId: 'payment-1', params });
  const b = makeInvocation({ config, namespace: 'billing', bindings, operationId: 'payment-1', params });
  const c = makeInvocation({ config, namespace: 'billing', bindings, operationId: 'payment-2', params });
  assert.deepEqual(a.record, b.record);
  assert.notEqual(a.record.sessionId, c.record.sessionId);
  assert.notEqual(a.record.actionId, c.record.actionId);
  assert.equal(a.record.inputDigest, c.record.inputDigest);
  assert.deepEqual(a.params, params);
  assert.equal(a.context.adapter_mode, 'sdk_wrapper');
  assert.equal(a.context.tool_input_digest, a.record.inputDigest);
});

test('binding, origin, tenant, runtime and namespace changes cannot borrow local state', async () => {
  const { makeInvocation } = await contract();
  const options = { config, namespace: 'billing', bindings, operationId: 'payment-1', params: { name: 'ledger.append', arguments: { target: 'ledger-A', amount: 3 } } };
  const a = makeInvocation(options);
  for (const change of [{ orgId: 'org-b' }, { agentId: 'agent-b' }, { baseUrl: 'https://other.example' }, { runtimeId: 'mcp' }]) {
    assert.notEqual(makeInvocation({ ...options, config: { ...config, ...change } }).record.scope, a.record.scope);
  }
  assert.notEqual(makeInvocation({ ...options, namespace: 'another-app' }).record.scope, a.record.scope);
  const changed = { 'ledger.append': { ...bindings['ledger.append'], revision: 'mapping-2' } };
  assert.notEqual(makeInvocation({ ...options, bindings: changed }).record.bindingDigest, a.record.bindingDigest);
});

test('refuses unknown tools, extra params, untrusted identity overrides and missing namespace', async () => {
  const { makeInvocation } = await contract();
  const options = { config, namespace: 'billing', bindings, operationId: 'payment-1', params: { name: 'ledger.append', arguments: { target: 'ledger-A', amount: 3 } } };
  for (const extra of [
    { params: { ...options.params, name: 'unknown' } },
    { params: { ...options.params, _meta: { authority: 'allow' } } },
    { bindings: { 'ledger.append': { revision: 'v1', describe: () => ({ action_type: 'api', declared_goal: 'x', agent_id: 'other' }) } } },
    { namespace: '' }, { operationId: '../other' },
  ]) assert.throws(() => makeInvocation({ ...options, ...extra }));
});

test('persisted record contains commitments rather than private arguments or description text', async () => {
  const { makeInvocation } = await contract();
  const secret = 'PRIVATE-DATA-FIXTURE';
  const input = makeInvocation({ config, namespace: 'billing', bindings, operationId: 'payment-1',
    params: { name: 'ledger.append', arguments: { target: secret, amount: 3 } } });
  assert.equal(JSON.stringify(input.record).includes(secret), false);
  assert.equal(JSON.stringify(input.record).includes('Append a ledger record'), false);
  assert.equal(JSON.parse(input.context.input_summary).osuite_native_call.input_digest, input.record.inputDigest);
});

async function storedInvocation() {
  const { makeInvocation } = await contract();
  const invocation = makeInvocation({ config, namespace: 'billing', bindings, operationId: 'payment-1',
    params: { name: 'ledger.append', arguments: { target: 'ledger-A', amount: 3 } } });
  const { record, context } = invocation;
  // actions.repository persists input_summary and the v1 envelope, but not the
  // request's top-level tool_input_digest/runtime_session_id/tool_use_id fields.
  const action = { action_id: record.actionId, org_id: config.orgId, agent_id: config.agentId,
    verified: true, input_summary: context.input_summary,
    action_envelope: { schema_version: 'osuite.action_envelope.v1', action_id: record.actionId,
      org_id: config.orgId, agent_id: config.agentId, runtime_session_id: record.sessionId,
      tool_use_id: record.toolUseId, input_summary: context.input_summary } };
  return { record, action };
}

test('stored v1 action binds mandatory persisted markers without request-only digest echoes', async () => {
  const { matchesStoredAction } = await contract();
  const { record, action } = await storedInvocation();
  assert.equal(Object.hasOwn(action, 'tool_input_digest'), false);
  assert.equal(Object.hasOwn(action.action_envelope, 'tool_input_digest'), false);
  assert.equal(matchesStoredAction({ action }, record, config), true);
  action.tool_input_digest = record.inputDigest;
  action.action_envelope.tool_input_digest = record.inputDigest;
  assert.equal(matchesStoredAction({ action }, record, config), true);
});

for (const location of ['action', 'envelope']) {
  for (const change of ['wrong', null, undefined]) test(`stored ${location} contradictory digest duplicate ${change} is rejected`, async () => {
    const { matchesStoredAction } = await contract();
    const { record, action } = await storedInvocation();
    action.tool_input_digest = record.inputDigest;
    const value = location === 'action' ? action : action.action_envelope;
    value.tool_input_digest = change;
    assert.equal(matchesStoredAction({ action }, record, config), false);
  });
  for (const field of ['schema_version', 'operation_digest', 'input_digest', 'binding_digest']) {
    for (const change of ['wrong', 'missing', null]) test(`stored ${location} marker ${field} ${change} cannot use a matching digest echo`, async () => {
      const { matchesStoredAction } = await contract();
      const { record, action } = await storedInvocation();
      action.tool_input_digest = record.inputDigest;
      const value = location === 'action' ? action : action.action_envelope;
      const summary = JSON.parse(value.input_summary);
      if (change === 'missing') delete summary.osuite_native_call[field];
      else summary.osuite_native_call[field] = change;
      value.input_summary = JSON.stringify(summary);
      assert.equal(matchesStoredAction({ action }, record, config), false);
    });
  }
  for (const summary of ['{}', 'null', 'invalid-json', null, undefined]) test(`stored ${location} missing/malformed summary ${summary} is rejected`, async () => {
    const { matchesStoredAction } = await contract();
    const { record, action } = await storedInvocation();
    action.tool_input_digest = record.inputDigest;
    const value = location === 'action' ? action : action.action_envelope;
    value.input_summary = summary;
    assert.equal(matchesStoredAction({ action }, record, config), false);
  });
  test(`stored ${location} recovery linkage cannot borrow the other summary's valid parent`, async () => {
    const { matchesStoredAction } = await contract();
    const { record, action } = await storedInvocation();
    action.tool_input_digest = record.inputDigest;
    const recovery = { schema_version: 'osuite.native_recovery.v1', parent_action_id: 'parent' };
    const recoveryRecord = { ...record, recovery };
    const summary = { ...JSON.parse(action.input_summary), osuite_native_recovery: recovery };
    action.input_summary = action.action_envelope.input_summary = JSON.stringify(summary);
    assert.equal(matchesStoredAction({ action }, recoveryRecord, config), true);
    const value = location === 'action' ? action : action.action_envelope;
    value.input_summary = JSON.stringify({ ...summary, osuite_native_recovery: { ...recovery, parent_action_id: 'other' } });
    assert.equal(matchesStoredAction({ action }, recoveryRecord, config), false);
  });
}

for (const field of ['schema_version', 'action_id', 'org_id', 'agent_id', 'runtime_session_id', 'tool_use_id']) {
  for (const change of ['wrong', 'missing']) test(`stored envelope ${field} ${change} is rejected without another profile fallback`, async () => {
    const { matchesStoredAction } = await contract();
    const { record, action } = await storedInvocation();
    action.tool_input_digest = record.inputDigest;
    if (change === 'missing') delete action.action_envelope[field];
    else action.action_envelope[field] = change;
    assert.equal(matchesStoredAction({ action }, record, config), false);
  });
}
