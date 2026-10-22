import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { GovernedToolError, jsonSnapshot } from '../contract.mjs';

const moduleUrl = new URL('../mcp.mjs', import.meta.url);
async function adapter() {
  assert.ok(existsSync(moduleUrl), 'bounded MCP adapter module must be implemented');
  return import(moduleUrl);
}

const secret = 'PRIVATE-MCP-ARGUMENT-FIXTURE';
const paramsFor = () => ({ name: 'ledger.append', arguments: { target: 'ledger-A', amount: 3 } });
const resultFor = () => ({ content: [{ type: 'text', text: 'recorded' }], structuredContent: { receipt: 'entry-1' } });
const toolsListFor = () => ({
  tools: [{
    name: 'ledger.append',
    description: 'Append one entry to the test-only ledger',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string' }, amount: { type: 'number' } },
      required: ['target', 'amount'],
      additionalProperties: false,
    },
  }],
});

function safeError(code) {
  return error => {
    assert.ok(error instanceof GovernedToolError);
    if (code) assert.equal(error.code, code);
    assert.equal(error.retryAutomatically, false);
    assert.equal(String(error).includes(secret), false);
    assert.equal(JSON.stringify(error).includes(secret), false);
    assert.equal(error.stack.includes(secret), false);
    return true;
  };
}

function fixture(result = resultFor()) {
  const calls = [], runs = [], statuses = [];
  const client = {
    callTool(...args) {
      assert.equal(this, client);
      calls.push(args);
      return result;
    },
  };
  const tools = {
    async run(operationId, params, execute, options = {}) {
      assert.equal(this, tools);
      const native = jsonSnapshot(params, 32768);
      runs.push({ operationId, params, native, options });
      return execute(native);
    },
    async status(operationId) {
      assert.equal(this, tools);
      statuses.push(operationId);
      return null;
    },
  };
  return { client, tools, calls, runs, statuses, result };
}

function assertIdle(state) {
  assert.equal(state.runs.length, 0);
  assert.equal(state.calls.length, 0);
  assert.equal(state.statuses.length, 0);
}

test('bounded MCP adapter module exists and exports wrapMcpClient', async () => {
  assert.equal(typeof (await adapter()).wrapMcpClient, 'function');
});

test('frozen facades expose only operation, status and operation-scoped callTool', async () => {
  const { wrapMcpClient } = await adapter();
  const state = fixture();
  let unwrappedAccess = 0;
  for (const key of ['connect', 'close', 'listTools', 'request', 'transport', 'experimental']) {
    Object.defineProperty(state.client, key, { get() { unwrappedAccess++; throw new Error(secret); } });
  }
  Object.freeze(state.client);
  const before = Object.getOwnPropertyDescriptors(state.client);
  const wrapped = wrapMcpClient(state.client, state.tools);
  const operation = wrapped.operation('operation-1');
  assert.ok(Object.isFrozen(wrapped));
  assert.ok(Object.isFrozen(operation));
  assert.deepEqual(Reflect.ownKeys(wrapped).sort(), ['operation', 'status']);
  assert.deepEqual(Reflect.ownKeys(operation), ['callTool']);
  for (const key of ['client', 'tools', 'callTool', 'connect', 'listTools', 'request', 'experimental']) {
    assert.equal(key in wrapped, false);
  }
  assert.throws(() => { operation.callTool = state.client.callTool; }, TypeError);
  assert.equal(await operation.callTool(paramsFor()), state.result);
  assert.deepEqual(Object.getOwnPropertyDescriptors(state.client), before);
  assert.equal(unwrappedAccess, 0);
});

test('preserves class receiver, trusted resultSchema, native options and original successful result', async () => {
  const { wrapMcpClient } = await adapter();
  const state = fixture();
  const result = { ...resultFor(), isError: false, _meta: { vendor: 'fixture' }, extension: ['native', 1] };
  const resultSchema = new Proxy({}, { get() { throw new Error('adapter must not inspect a trusted schema'); } });
  class NativeClient {
    #result = result;
    callTool(...args) { state.calls.push(args); return this.#result; }
  }
  const controller = new AbortController();
  const options = { signal: controller.signal, timeout: 1234 };
  const params = paramsFor();
  const returned = await wrapMcpClient(new NativeClient(), state.tools).operation('operation-1').callTool(params, resultSchema, options);
  assert.equal(returned, result);
  assert.equal(state.calls.length, 1);
  const [native, schema, safeOptions] = state.calls[0];
  assert.equal(state.calls[0].length, 3);
  assert.equal(native, state.runs[0].native, 'dispatch uses the native params supplied by the coordinator');
  assert.notEqual(native, params);
  assert.deepEqual(native, params);
  assert.deepEqual(Reflect.ownKeys(native).sort(), ['arguments', 'name']);
  assert.ok(Object.isFrozen(native));
  assert.ok(Object.isFrozen(native.arguments));
  assert.equal(schema, resultSchema);
  assert.notEqual(safeOptions, options);
  assert.ok(Object.isFrozen(safeOptions));
  assert.deepEqual(safeOptions, options);
  assert.equal(safeOptions.signal, controller.signal);
  assert.deepEqual(state.runs[0].options, { signal: controller.signal });
  assert.equal(Object.isFrozen(params), false);
  assert.equal(Object.isFrozen(options), false);
});

test('optional native options keep omissions and timeout boundaries without injecting defaults', async () => {
  const { wrapMcpClient } = await adapter();
  const signal = new AbortController().signal;
  for (const options of [undefined, {}, { signal }, { timeout: 1 }, { timeout: 30000 }]) {
    const state = fixture();
    await wrapMcpClient(state.client, state.tools).operation('operation-1').callTool(paramsFor(), undefined, options);
    assert.equal(state.calls[0][1], undefined);
    assert.deepEqual(state.calls[0][2], options);
    assert.deepEqual(state.runs[0].options, options?.signal ? { signal } : {});
  }
});

test('snapshots params and options before an asynchronous admission wait', async () => {
  const { wrapMcpClient } = await adapter();
  const state = fixture();
  const { promise, resolve } = Promise.withResolvers();
  let seenParams;
  state.tools.run = async function (operationId, params, execute) {
    assert.equal(this, state.tools);
    seenParams = params;
    await promise;
    return execute(jsonSnapshot(params));
  };
  const firstSignal = new AbortController().signal;
  const options = { signal: firstSignal, timeout: 2000 };
  const params = { ...paramsFor(), arguments: { amount: 3, rows: [{ value: 'original' }] } };
  const expected = jsonSnapshot(params);
  const wrapped = wrapMcpClient(state.client, state.tools);
  const pending = wrapped.operation('operation-1').callTool(params, undefined, options);
  params.name = 'other.tool';
  params.arguments.amount = 900;
  params.arguments.rows[0].value = secret;
  params.arguments.rows.push({ value: secret });
  params._meta = { authority: 'bypass' };
  options.timeout = 1;
  options.signal = new AbortController().signal;
  options.onprogress = () => assert.fail('late option must not be forwarded');
  state.client.callTool = () => assert.fail('must use the original native method');
  assert.ok(Object.isFrozen(seenParams));
  assert.ok(Object.isFrozen(seenParams.arguments.rows[0]));
  resolve();
  assert.equal(await pending, state.result);
  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.calls[0][0], expected);
  assert.deepEqual(state.calls[0][2], { signal: firstSignal, timeout: 2000 });
});

test('status delegates with the original receiver and preserves the coordinator status object', async () => {
  const { wrapMcpClient } = await adapter();
  const state = fixture();
  const status = Object.freeze({ operationId: 'operation-1', state: 'uncertain', resultRetained: false });
  state.tools.status = async function (operationId) {
    assert.equal(this, state.tools);
    state.statuses.push(operationId);
    return status;
  };
  const wrapped = wrapMcpClient(state.client, state.tools);
  state.tools.status = () => assert.fail('status must retain the validated method');
  const pending = wrapped.status('operation-1');
  assert.ok(pending instanceof Promise);
  assert.equal(await pending, status);
  assert.deepEqual(state.statuses, ['operation-1']);
  assert.equal(state.runs.length, 0);
  assert.equal(state.calls.length, 0);
  assert.equal(await wrapMcpClient(fixture().client, fixture().tools).status('missing'), null);
});

test('repeat operations delegate the same stable ID without adapter output caching', async () => {
  const { wrapMcpClient } = await adapter();
  const state = fixture();
  state.client.callTool = function (...args) {
    state.calls.push(args);
    return resultFor();
  };
  const wrapped = wrapMcpClient(state.client, state.tools);
  const first = await wrapped.operation('stable-operation').callTool(paramsFor());
  const second = await wrapped.operation('stable-operation').callTool(paramsFor());
  assert.notEqual(first, second);
  assert.deepEqual(first, second);
  assert.deepEqual(state.runs.map(run => run.operationId), ['stable-operation', 'stable-operation']);
  assert.equal(state.calls.length, 2, 'only the coordinator owns repeat/durability decisions');
});

test('coordinator rejection of a repeat never falls back to the native client', async () => {
  const { wrapMcpClient } = await adapter();
  const state = fixture();
  const seen = new Set();
  const blocked = new GovernedToolError('ALREADY_ATTEMPTED', { state: 'succeeded' });
  state.tools.run = async (operationId, params, execute) => {
    state.runs.push(operationId);
    if (seen.has(operationId)) throw blocked;
    seen.add(operationId);
    return execute(jsonSnapshot(params));
  };
  const wrapped = wrapMcpClient(state.client, state.tools);
  assert.equal(await wrapped.operation('stable-operation').callTool(paramsFor()), state.result);
  await assert.rejects(wrapped.operation('stable-operation').callTool(paramsFor()), error => error === blocked);
  assert.deepEqual(state.runs, ['stable-operation', 'stable-operation']);
  assert.equal(state.calls.length, 1);
});

test('no native request occurs when the coordinator returns without executing', async () => {
  const { wrapMcpClient } = await adapter();
  const state = fixture();
  const result = { content: [{ type: 'text', text: 'held by coordinator' }], isError: true };
  state.tools.run = async () => result;
  assert.equal(await wrapMcpClient(state.client, state.tools).operation('operation-1').callTool(paramsFor()), result);
  assert.equal(state.calls.length, 0);
});

test('native MCP error results remain untouched and do not trigger retries', async () => {
  const { wrapMcpClient } = await adapter();
  const result = { ...resultFor(), isError: true, _meta: { vendor: 'fixture' }, structuredContent: { diagnostic: secret } };
  const state = fixture(result);
  assert.equal(await wrapMcpClient(state.client, state.tools).operation('operation-1').callTool(paramsFor()), result);
  assert.equal(state.runs.length, 1);
  assert.equal(state.calls.length, 1);
});

test('uncertain throw and malformed-result classifications remain coordinator-owned with no retry', async () => {
  const { wrapMcpClient } = await adapter();
  for (const behavior of [() => { throw new Error(secret); }, () => null, () => ({ content: 'malformed' })]) {
    const state = fixture();
    const uncertain = new GovernedToolError('UNCERTAIN', { operationId: 'operation-1', state: 'uncertain' });
    state.client.callTool = (...args) => { state.calls.push(args); return behavior(); };
    state.tools.run = async (operationId, params, execute) => {
      state.runs.push(operationId);
      try { await execute(jsonSnapshot(params)); } catch { /* The coordinator classifies native exceptions. */ }
      throw uncertain;
    };
    await assert.rejects(wrapMcpClient(state.client, state.tools).operation('operation-1').callTool(paramsFor()), error => {
      assert.equal(error, uncertain);
      return safeError('UNCERTAIN')(error);
    });
    assert.equal(state.runs.length, 1);
    assert.equal(state.calls.length, 1);
  }
});

test('unexpected coordinator errors are redacted without a native fallback', async () => {
  const { wrapMcpClient } = await adapter();
  const state = fixture();
  state.tools.run = async () => { throw new Error(secret); };
  state.tools.status = async () => { throw new Error(secret); };
  const wrapped = wrapMcpClient(state.client, state.tools);
  await assert.rejects(wrapped.operation('operation-1').callTool({ name: 'ledger.append', arguments: { secret } }), safeError());
  await assert.rejects(wrapped.status('operation-1'), safeError());
  assert.equal(state.calls.length, 0);
});

test('requires callable native client and coordinator methods at construction', async () => {
  const { wrapMcpClient } = await adapter();
  const state = fixture();
  for (const client of [undefined, null, 1, 'client', {}, { callTool: true }]) {
    assert.throws(() => wrapMcpClient(client, state.tools), safeError('INVALID_CONFIGURATION'));
  }
  for (const tools of [undefined, null, 1, {}, { run() {} }, { status() {} }, { run: true, status() {} }, { run() {}, status: 1 }]) {
    assert.throws(() => wrapMcpClient(state.client, tools), safeError('INVALID_CONFIGURATION'));
  }
  assertIdle(state);
});

test('method accessors and proxy capabilities are rejected without executing traps', async () => {
  const { wrapMcpClient } = await adapter();
  const state = fixture();
  let executed = 0;
  const getter = () => { executed++; throw new Error(secret); };
  const accessorClient = Object.defineProperty({}, 'callTool', { get: getter });
  const accessorTools = Object.defineProperty({ status() {} }, 'run', { get: getter });
  const proxyClient = new Proxy(state.client, { get: getter, getPrototypeOf: getter, getOwnPropertyDescriptor: getter });
  const proxyTools = new Proxy(state.tools, { get: getter, getPrototypeOf: getter, getOwnPropertyDescriptor: getter });
  for (const [client, tools] of [[accessorClient, state.tools], [state.client, accessorTools], [proxyClient, state.tools], [state.client, proxyTools]]) {
    assert.throws(() => wrapMcpClient(client, tools), safeError('INVALID_CONFIGURATION'));
  }
  assert.equal(executed, 0);
  assertIdle(state);
});

test('rejects malformed operation IDs for operation and status before any delegation', async () => {
  const { wrapMcpClient } = await adapter();
  const state = fixture();
  const wrapped = wrapMcpClient(state.client, state.tools);
  let coercions = 0;
  const hostile = { toString() { coercions++; throw new Error(secret); } };
  const invalid = [undefined, null, 1, Symbol('id'), hostile, new String('valid'), '', 'a'.repeat(129), '..', 'a..b', '../other',
    '.leading', '-leading', 'has space', 'a/b', 'a\\b', 'a\n', 'a\r', 'a\0', '\u00e9', secret + '/bad'];
  for (const operationId of invalid) {
    assert.throws(() => wrapped.operation(operationId), safeError('INVALID_OPERATION_ID'));
    await assert.rejects(wrapped.status(operationId), safeError('INVALID_OPERATION_ID'));
  }
  assert.equal(coercions, 0);
  assertIdle(state);
});

test('accepts bounded safe operation IDs unchanged', async () => {
  const { wrapMcpClient } = await adapter();
  const state = fixture();
  const wrapped = wrapMcpClient(state.client, state.tools);
  const ids = ['a', '_', 'A_1.name-2', 'a'.repeat(128)];
  for (const operationId of ids) {
    await wrapped.operation(operationId).callTool(paramsFor());
    await wrapped.status(operationId);
  }
  assert.deepEqual(state.runs.map(run => run.operationId), ids);
  assert.deepEqual(state.statuses, ids);
});

test('rejects top-level MCP metadata, task plumbing and unknown params instead of dropping them', async () => {
  const { wrapMcpClient } = await adapter();
  const state = fixture();
  const operation = wrapMcpClient(state.client, state.tools).operation('operation-1');
  for (const extra of [{ _meta: { progressToken: secret } }, { task: { ttl: 1000 } }, { timeout: 1 }, { signal: null },
    { resultSchema: {} }, { unknown: secret }, { [Symbol('extension')]: secret }]) {
    await assert.rejects(operation.callTool({ ...paramsFor(), ...extra }), safeError('INVALID_INPUT'));
  }
  assertIdle(state);
});

test('preserves arbitrary JSON argument fields, including nested metadata and task names', async () => {
  const { wrapMcpClient } = await adapter();
  const state = fixture();
  const params = { name: 'ledger.append', arguments: { _meta: { callerField: 'data' }, task: [null, false, 1], other: {} } };
  await wrapMcpClient(state.client, state.tools).operation('operation-1').callTool(params);
  assert.deepEqual(state.calls[0][0], params);
});

test('MCP arguments reject JSON primitives, arrays and null before any delegation', async () => {
  const { wrapMcpClient } = await adapter();
  const state = fixture();
  const operation = wrapMcpClient(state.client, state.tools).operation('operation-1');
  for (const args of [null, [], [1, { value: secret }], false, true, 0, 1, '', secret]) {
    await assert.rejects(operation.callTool({ name: 'ledger.append', arguments: args }), safeError('INVALID_INPUT'));
  }
  assertIdle(state);
});

test('MCP arguments accept empty and null-prototype records without changing nested JSON values', async () => {
  const { wrapMcpClient } = await adapter();
  const state = fixture();
  const operation = wrapMcpClient(state.client, state.tools).operation('operation-1');
  const records = [{}, Object.create(null), Object.assign(Object.create(null), { nested: [null, false, 0, '', {}] })];
  for (const args of records) {
    await operation.callTool({ name: 'ledger.append', arguments: args });
  }
  assert.deepEqual(state.calls.map(([native]) => native.arguments), [{}, {}, { nested: [null, false, 0, '', {}] }]);
});

test('the bounded MCP profile uses safeId tool names of 1..128 characters without double dots', async () => {
  const { wrapMcpClient } = await adapter();
  const state = fixture();
  const operation = wrapMcpClient(state.client, state.tools).operation('operation-1');
  for (const name of ['', 'ledger..append', 'a'.repeat(129), 'tool:append', 'tool/append', '-leading', '.leading']) {
    await assert.rejects(operation.callTool({ name, arguments: {} }), safeError('INVALID_INPUT'));
  }
  assertIdle(state);
  const names = ['a', '_', 'ledger.append-1', 'a'.repeat(128)];
  for (const name of names) await operation.callTool({ name, arguments: {} });
  assert.deepEqual(state.calls.map(([native]) => native.name), names);
});

test('rejects missing or malformed native params without filling or coercing them', async () => {
  const { wrapMcpClient } = await adapter();
  const state = fixture();
  const operation = wrapMcpClient(state.client, state.tools).operation('operation-1');
  for (const params of [undefined, null, [], 'params', 1, {}, { name: 'ledger.append' }, { arguments: {} },
    { name: '', arguments: {} }, { name: 1, arguments: {} }, { name: 'ledger.append', arguments: undefined }]) {
    await assert.rejects(operation.callTool(params), safeError('INVALID_INPUT'));
  }
  assertIdle(state);
});

test('JSON snapshot rejects accessors, proxies and lossy arguments without running user code', async () => {
  const { wrapMcpClient } = await adapter();
  const state = fixture();
  const operation = wrapMcpClient(state.client, state.tools).operation('operation-1');
  let executed = 0;
  const trap = () => { executed++; throw new Error(secret); };
  const accessor = Object.defineProperty({}, 'secret', { enumerable: true, get: trap });
  const proxy = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const cycle = {}; cycle.self = cycle;
  for (const args of [accessor, proxy, revoked.proxy, cycle, { toJSON: trap }, { value: undefined }, { value: NaN },
    { value: -0 }, new Date(), new Uint8Array([1]), [undefined], new Array(1), { [Symbol('key')]: secret },
    JSON.parse('{"__proto__":{}}'), Object.create({ inherited: secret })]) {
    await assert.rejects(operation.callTool({ name: 'ledger.append', arguments: args }), safeError('INVALID_INPUT'));
  }
  const getterParams = Object.defineProperty({ arguments: {} }, 'name', { enumerable: true, get: trap });
  for (const params of [getterParams, new Proxy(paramsFor(), { get: trap, ownKeys: trap })]) {
    await assert.rejects(operation.callTool(params), safeError('INVALID_INPUT'));
  }
  assert.equal(executed, 0);
  assertIdle(state);
});

test('rejects oversized or overdeep inputs before delegating', async () => {
  const { wrapMcpClient } = await adapter();
  const state = fixture();
  const operation = wrapMcpClient(state.client, state.tools).operation('operation-1');
  let nested = {};
  for (let i = 0; i < 18; i++) nested = { nested };
  for (const args of [{ value: 'x'.repeat(32768) }, nested]) {
    await assert.rejects(operation.callTool({ name: 'ledger.append', arguments: args }), safeError('INVALID_INPUT'));
  }
  assertIdle(state);
});

test('rejects all unknown request option fields even when otherwise valid', async () => {
  const { wrapMcpClient } = await adapter();
  const state = fixture();
  const operation = wrapMcpClient(state.client, state.tools).operation('operation-1');
  for (const key of ['_meta', 'task', 'onprogress', 'timeoutMs', 'waitMs', 'maxTotalTimeout', 'resetTimeoutOnProgress',
    'requestInit', 'headers', 'retry', 'stream', 'unknown']) {
    await assert.rejects(operation.callTool(paramsFor(), undefined, { timeout: 1000, [key]: secret }), safeError('INVALID_OPTIONS'));
  }
  assertIdle(state);
});

test('rejects non-record request options', async () => {
  const { wrapMcpClient } = await adapter();
  const state = fixture();
  const operation = wrapMcpClient(state.client, state.tools).operation('operation-1');
  for (const options of [null, false, 1, 'options', [], () => {}, new Date(), new Number(1), Object.create({ timeout: 1 })]) {
    await assert.rejects(operation.callTool(paramsFor(), undefined, options), safeError('INVALID_OPTIONS'));
  }
  assertIdle(state);
});

test('rejects invalid timeout types, nonintegers and values outside 1..30000', async () => {
  const { wrapMcpClient } = await adapter();
  const state = fixture();
  const operation = wrapMcpClient(state.client, state.tools).operation('operation-1');
  for (const timeout of [undefined, null, false, 0, -0, -1, 30001, 1.5, NaN, Infinity, -Infinity, '1', 1n, new Number(1)]) {
    await assert.rejects(operation.callTool(paramsFor(), undefined, { timeout }), safeError('INVALID_OPTIONS'));
  }
  assertIdle(state);
});

test('requires a real non-proxy AbortSignal without invoking spoofed accessors', async () => {
  const { wrapMcpClient } = await adapter();
  const state = fixture();
  const operation = wrapMcpClient(state.client, state.tools).operation('operation-1');
  let executed = 0;
  const trap = () => { executed++; throw new Error(secret); };
  const spoof = Object.defineProperty({}, 'aborted', { get: trap });
  const signalProxy = new Proxy(new AbortController().signal, { get: trap, getPrototypeOf: trap });
  const revoked = Proxy.revocable(new AbortController().signal, {}); revoked.revoke();
  for (const signal of [undefined, null, false, 1, {}, spoof, new AbortController(), Object.create(AbortSignal.prototype), signalProxy, revoked.proxy]) {
    await assert.rejects(operation.callTool(paramsFor(), undefined, { signal }), safeError('INVALID_OPTIONS'));
  }
  assert.equal(executed, 0);
  assertIdle(state);
});

test('option cloning rejects getters, symbols, hidden fields and proxies without invoking them', async () => {
  const { wrapMcpClient } = await adapter();
  const state = fixture();
  const operation = wrapMcpClient(state.client, state.tools).operation('operation-1');
  let executed = 0;
  const trap = () => { executed++; throw new Error(secret); };
  const options = ['signal', 'timeout', 'unknown'].map(key => Object.defineProperty({}, key, { enumerable: true, get: trap }));
  options.push(Object.defineProperty({}, 'timeout', { value: 1000 }));
  options.push(Object.defineProperty({ timeout: 1000 }, 'hidden', { get: trap }));
  options.push({ timeout: 1000, [Symbol('extra')]: secret });
  options.push(new Proxy({ timeout: 1000 }, { get: trap, ownKeys: trap, getPrototypeOf: trap }));
  const revoked = Proxy.revocable({}, {}); revoked.revoke(); options.push(revoked.proxy);
  for (const value of options) {
    await assert.rejects(operation.callTool(paramsFor(), undefined, value), safeError('INVALID_OPTIONS'));
  }
  assert.equal(executed, 0);
  assertIdle(state);
});

test('null-prototype records remain supported without prototype-dependent field lookup', async () => {
  const { wrapMcpClient } = await adapter();
  const state = fixture();
  const params = Object.assign(Object.create(null), paramsFor());
  const options = Object.assign(Object.create(null), { timeout: 1000 });
  assert.equal(await wrapMcpClient(state.client, state.tools).operation('operation-1').callTool(params, undefined, options), state.result);
  assert.deepEqual(state.calls[0][0], paramsFor());
  assert.deepEqual(state.calls[0][2], { timeout: 1000 });
});

test('an already aborted signal prevents both coordinator and resource requests and redacts its reason', async () => {
  const { wrapMcpClient } = await adapter();
  const state = fixture();
  const controller = new AbortController();
  controller.abort(new Error(secret));
  await assert.rejects(wrapMcpClient(state.client, state.tools).operation('operation-1')
    .callTool(paramsFor(), undefined, { signal: controller.signal, timeout: 1000 }), safeError('ABORTED'));
  assertIdle(state);
});

// Test-only MCP JSON-RPC over localhost HTTP, not official SDK or vendor certification.
class MinimalHttpMcpClient {
  #url;
  #id = 0;
  connections = 0;
  constructor(url) { this.#url = url; }
  async #send(method, params, options = {}, notification = false) {
    const id = notification ? undefined : ++this.#id;
    const signal = options.timeout === undefined ? options.signal
      : AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeout)]);
    const response = await fetch(this.#url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
      signal,
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }),
    });
    if (notification) { assert.equal(response.status, 202); return; }
    assert.equal(response.status, 200);
    const message = await response.json();
    assert.equal(message.jsonrpc, '2.0');
    assert.equal(message.id, id);
    assert.equal(message.error, undefined);
    return message.result;
  }
  async connect() {
    this.connections++;
    await this.#send('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test-only-minimal-client', version: '1' } });
    await this.#send('notifications/initialized', {}, undefined, true);
  }
  async listTools(params = {}, options) {
    return this.#send('tools/list', params, options);
  }
  async callTool(params, resultSchema, options) {
    const result = await this.#send('tools/call', params, options);
    return resultSchema ? resultSchema.parse(result) : result;
  }
}

async function httpFixture(t, nativeResult) {
  const counts = { httpRequests: 0, listRequests: 0, toolRequests: 0 };
  const entries = [], received = [], failures = [];
  let initialized = false;
  const server = createServer(async (request, response) => {
    counts.httpRequests++;
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/mcp');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(message.jsonrpc, '2.0');
      let result;
      if (message.method === 'initialize') {
        result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'test-ledger', version: '1' } };
      } else if (message.method === 'notifications/initialized') {
        initialized = true;
        response.writeHead(202).end();
        return;
      } else if (message.method === 'tools/list') {
        assert.equal(initialized, true);
        assert.deepEqual(message.params, {});
        counts.listRequests++;
        result = toolsListFor();
      } else {
        assert.equal(message.method, 'tools/call');
        assert.equal(initialized, true);
        counts.toolRequests++;
        received.push(message.params);
        assert.deepEqual(message.params, paramsFor());
        entries.push({ target: message.params.arguments.target, amount: message.params.arguments.amount });
        result = nativeResult;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end();
    }
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = new MinimalHttpMcpClient(`http://127.0.0.1:${server.address().port}/mcp`);
  return { client, counts, entries, received, failures };
}

for (const isError of [false, true]) {
  test(`localhost HTTP MCP preserves isError=${isError} result with independent request/effect counts (not vendor certification)`, async t => {
    const { wrapMcpClient } = await adapter();
    const nativeResult = { ...resultFor(), isError, _meta: { vendor: 'test-ledger' } };
    const local = await httpFixture(t, nativeResult);
    await local.client.connect();
    assert.equal(local.counts.httpRequests, 2);
    const discovered = await local.client.listTools();
    assert.deepEqual(discovered, toolsListFor());
    const params = { ...paramsFor(), name: discovered.tools[0].name };
    const baselineRequests = local.counts.httpRequests;
    assert.deepEqual(local.counts, { httpRequests: 3, listRequests: 1, toolRequests: 0 });
    assert.deepEqual(local.entries, []);
    const seen = new Set(), runIds = [];
    const state = fixture();
    state.tools.run = async (operationId, params, execute) => {
      runIds.push(operationId);
      if (seen.has(operationId)) throw new GovernedToolError('ALREADY_ATTEMPTED');
      seen.add(operationId);
      return execute(jsonSnapshot(params));
    };
    const wrapped = wrapMcpClient(local.client, state.tools);
    assert.equal('listTools' in wrapped, false, 'discovery belongs to the original client');
    let validatedResult;
    const schema = { parse(result) { validatedResult = result; return result; } };
    const result = await wrapped.operation('http-operation').callTool(params, schema, { timeout: 3000, signal: new AbortController().signal });
    assert.deepEqual(result, nativeResult);
    assert.equal(result, validatedResult);
    assert.equal(local.counts.httpRequests - baselineRequests, 1);
    assert.equal(local.counts.toolRequests, 1);
    assert.deepEqual(local.entries, [{ target: 'ledger-A', amount: 3 }]);
    assert.deepEqual(local.received, [paramsFor()]);
    await assert.rejects(wrapped.operation('http-operation').callTool(paramsFor()), safeError('ALREADY_ATTEMPTED'));
    const aborted = new AbortController(); aborted.abort(new Error(secret));
    await assert.rejects(wrapped.operation('never-started').callTool(paramsFor(), undefined, { signal: aborted.signal }), safeError('ABORTED'));
    await assert.rejects(wrapped.operation('unsupported').callTool({ ...paramsFor(), task: {} }), safeError('INVALID_INPUT'));
    assert.deepEqual(runIds, ['http-operation', 'http-operation']);
    assert.equal(local.counts.httpRequests - baselineRequests, 1);
    assert.equal(local.counts.listRequests, 1);
    assert.equal(local.counts.toolRequests, 1);
    assert.equal(local.entries.length, 1);
    assert.equal(local.client.connections, 1);
    assert.deepEqual(local.failures, []);
  });
}

test('localhost HTTP MCP direct raw call is an outside-coverage negative control for wrapped-call-only (not a gateway)', async t => {
  const { wrapMcpClient } = await adapter();
  const nativeResult = resultFor();
  const local = await httpFixture(t, nativeResult);
  const rawClient = local.client;
  const originalCallTool = rawClient.callTool;
  await rawClient.connect();
  assert.equal(local.counts.httpRequests, 2);
  const discovered = await rawClient.listTools();
  assert.deepEqual(discovered, toolsListFor());
  const params = { ...paramsFor(), name: discovered.tools[0].name };
  const baselineRequests = local.counts.httpRequests;
  assert.deepEqual(local.counts, { httpRequests: 3, listRequests: 1, toolRequests: 0 });
  const runIds = [];
  const state = fixture();
  state.tools.run = async operationId => {
    runIds.push(operationId);
    throw new GovernedToolError('POLICY_DENIED');
  };
  const wrapped = wrapMcpClient(rawClient, state.tools);
  assert.equal('listTools' in wrapped, false);
  await assert.rejects(wrapped.operation('outside-coverage-control')
    .callTool(params, undefined, { timeout: 3000 }), safeError('POLICY_DENIED'));
  assert.deepEqual(runIds, ['outside-coverage-control']);
  assert.equal(local.counts.httpRequests - baselineRequests, 0);
  assert.equal(local.counts.toolRequests, 0);
  assert.deepEqual(local.entries, []);
  assert.deepEqual(local.received, []);
  assert.equal(rawClient.callTool, originalCallTool);

  // Intentional direct raw call on our local fixture: outside coverage, never wrapper fallback or automatic retry.
  const result = await rawClient.callTool(params, undefined, { timeout: 3000 });
  assert.deepEqual(result, nativeResult);
  assert.deepEqual(runIds, ['outside-coverage-control']);
  assert.equal(rawClient.callTool, originalCallTool);
  assert.equal(local.counts.httpRequests - baselineRequests, 1);
  assert.deepEqual(local.counts, { httpRequests: 4, listRequests: 1, toolRequests: 1 });
  assert.deepEqual(local.entries, [{ target: 'ledger-A', amount: 3 }]);
  assert.deepEqual(local.received, [paramsFor()]);
  assert.equal(rawClient.connections, 1);
  assert.deepEqual(local.failures, []);
});
