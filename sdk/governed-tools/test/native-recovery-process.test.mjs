import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { setup, params, operationId } from './native-recovery.fixture.mjs';

async function start(t, f, mode = 'pause') {
  const child = fork(new URL('./native-recovery.child.mjs', import.meta.url), [], {
    execPath: process.execPath, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '', finished = false;
  child.stderr.on('data', bytes => { stderr += bytes; });
  const messages = [], waiters = [];
  child.on('message', message => {
    messages.push(message);
    for (const waiter of [...waiters]) if (waiter.types.includes(message.type)) {
      waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message);
    }
  });
  const closed = new Promise(resolve => child.on('close', (code, signal) => {
    finished = true;
    for (const waiter of waiters.splice(0)) waiter.reject(new Error(`child exited ${code}/${signal}: ${stderr}; ${JSON.stringify(messages)}`));
    resolve({ code, signal });
  }));
  child.on('error', error => { for (const waiter of waiters.splice(0)) waiter.reject(error); });
  const wait = (...types) => {
    const existing = messages.find(message => types.includes(message.type));
    if (existing) return Promise.resolve(existing);
    if (finished) return Promise.reject(new Error(`child already exited: ${stderr}`));
    return new Promise((resolve, reject) => waiters.push({ types, resolve, reject }));
  };
  const send = message => new Promise((resolve, reject) => child.send(message, error => error ? reject(error) : resolve()));
  t.after(async () => { if (!finished) child.kill('SIGKILL'); await closed; });
  await send({ type: 'init', config: f.config, journalPath: f.journalPath, resourceUrl: f.resourceUrl, mode });
  assert.equal((await wait('ready', 'fatal')).type, 'ready');
  return { wait, send, closed, pid: child.pid };
}

test('independent recovery processes race for one durable admission and one HTTP effect', { timeout: 15000 }, async t => {
  const f = await setup(t);
  await assert.rejects(f.tools.run(operationId, params(), f.original), { code: 'OUTCOME_UNKNOWN' });
  const children = await Promise.all([start(t, f), start(t, f)]);
  assert.notEqual(children[0].pid, children[1].pid);
  await Promise.all(children.map(child => child.send({ type: 'recover' })));
  const checkpoints = await Promise.all(children.map(child => child.wait('effect', 'outcome', 'fatal')));
  assert.equal(checkpoints.filter(message => message.type === 'effect').length, 1, JSON.stringify(checkpoints));
  const winner = checkpoints.findIndex(message => message.type === 'effect');
  assert.equal(checkpoints[1 - winner].ok, false);
  assert.ok(['OUTCOME_UNKNOWN', 'OPERATION_BUSY', 'JOURNAL_BUSY'].includes(checkpoints[1 - winner].code));
  assert.equal((await f.tools.status(operationId)).recoveryAttempt.state, 'dispatching');
  assert.equal(f.resource.effects.length, 1);
  await children[winner].send({ type: 'release' });
  assert.equal((await children[winner].wait('outcome')).ok, true);
  for (const child of children) assert.deepEqual(await child.closed, { code: 0, signal: null });
  assert.equal(f.counts.creates, 2); assert.equal(f.resource.calls, 2);
});

test('process crash after recovery HTTP effect stays dispatching across restart without a third attempt', { timeout: 15000 }, async t => {
  const f = await setup(t);
  await assert.rejects(f.tools.run(operationId, params(), f.original), { code: 'OUTCOME_UNKNOWN' });
  const crashed = await start(t, f, 'crash'); await crashed.send({ type: 'recover' });
  await crashed.wait('effect'); assert.deepEqual(await crashed.closed, { code: 73, signal: null });
  const before = await f.tools.status(operationId);
  assert.equal(before.state, 'uncertain'); assert.equal(before.recoveryAttempt.state, 'dispatching');
  const counts = { creates: f.counts.creates, calls: f.resource.calls, observations: f.resource.observations };
  const restarted = await start(t, f, 'normal'); await restarted.send({ type: 'recover' });
  const outcome = await restarted.wait('outcome');
  assert.equal(outcome.code, 'OUTCOME_UNKNOWN'); assert.equal(outcome.retryAutomatically, false);
  assert.deepEqual(outcome.status, before);
  assert.deepEqual(await restarted.closed, { code: 0, signal: null });
  assert.deepEqual({ creates: f.counts.creates, calls: f.resource.calls, observations: f.resource.observations }, counts);
});
