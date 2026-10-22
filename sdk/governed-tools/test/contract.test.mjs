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
