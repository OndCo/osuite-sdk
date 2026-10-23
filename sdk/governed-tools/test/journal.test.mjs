import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const moduleUrl = new URL('../journal.mjs', import.meta.url);
let OperationJournal;
let importError;
try { ({ OperationJournal } = await import(moduleUrl.href)); }
catch (error) { importError = error; }

test('OperationJournal module exists and exports its public class', () => {
  assert.equal(importError?.code, undefined, `Missing journal module: ${importError?.code}`);
  assert.ifError(importError);
  assert.equal(typeof OperationJournal, 'function');
});

const journalTest = (name, fn) => test(name, { skip: !OperationJournal, timeout: 20000 }, fn);
const scope = 'a'.repeat(64);
const otherScope = 'b'.repeat(64);
const record = Object.freeze({
  scope, operationId: 'operation-1', inputDigest: '1'.repeat(64),
  contextDigest: '2'.repeat(64), bindingDigest: '3'.repeat(64),
  actionId: 'action-1', sessionId: 'session-1', toolUseId: 'tool-1',
});
const states = [
  'prepared', 'requesting', 'held', 'redeeming', 'dispatching', 'completed',
  'denied', 'expired', 'cancelled', 'uncertain_request', 'uncertain_redemption', 'uncertain',
];
const transitions = {
  requesting: ['held', 'denied', 'expired', 'uncertain_request', 'dispatching'],
  redeeming: ['held', 'denied', 'expired', 'cancelled', 'uncertain_redemption', 'dispatching'],
  dispatching: ['completed', 'uncertain'],
};

function storage(t) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'osuite-operation-journal-'));
  const path = join(dir, 'operations.sqlite');
  const handles = [];
  t.after(() => {
    for (const handle of handles.reverse()) handle.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir, path,
    open(options, filename = path) {
      const journal = new OperationJournal(filename, options);
      handles.push(journal);
      return journal;
    },
    raw(filename = path) {
      const db = new DatabaseSync(filename);
      handles.push({ close() { if (db.isOpen) db.close(); } });
      return db;
    },
  };
}

function rejectsCode(fn, code) {
  assert.throws(fn, error => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  });
}

function enter(journal, state, input = record, owner = 'owner-1') {
  journal.prepare(input);
  if (state === 'prepared') return;
  assert.equal(journal.claim(input.scope, input.operationId, ['prepared'], 'requesting', owner), true);
  if (state === 'requesting') return;
  if (['held', 'redeeming', 'uncertain_redemption', 'cancelled'].includes(state)) {
    assert.equal(journal.settle(input.scope, input.operationId, owner, 'requesting', 'held'), true);
    if (state === 'held') return;
    assert.equal(journal.claim(input.scope, input.operationId, ['held'], 'redeeming', owner), true);
    if (state === 'redeeming') return;
    assert.equal(journal.settle(input.scope, input.operationId, owner, 'redeeming', state), true);
    return;
  }
  if (['denied', 'expired', 'uncertain_request'].includes(state)) {
    assert.equal(journal.settle(input.scope, input.operationId, owner, 'requesting', state), true);
    return;
  }
  assert.equal(journal.settle(input.scope, input.operationId, owner, 'requesting', 'dispatching'), true);
  if (state !== 'dispatching') {
    assert.equal(journal.settle(input.scope, input.operationId, owner, 'dispatching', state), true);
  }
}

function worker(t, body, data) {
  const source = `
    import { OperationJournal } from ${JSON.stringify(moduleUrl.href)};
    import { DatabaseSync } from 'node:sqlite';
    const data = JSON.parse(process.argv[1]);
    process.once('message', async () => {
      try {
        const result = await (async () => { ${body} })();
        process.send({ result });
      } catch (error) {
        process.send({ error: { code: error.code, message: error.message } });
        process.exitCode = 1;
      } finally { process.disconnect(); }
    });
    process.send({ ready: true });
  `;
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', source, JSON.stringify(data)], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  let response;
  let readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  child.stdout.resume();
  child.on('message', message => {
    if (message.ready) readyResolve();
    else response = message;
  });
  const finished = new Promise(resolve => {
    child.on('error', error => resolve({ error: error.message }));
    child.on('close', (code, signal) => {
      readyResolve();
      resolve({ code, signal, stderr, ...response });
    });
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await finished;
  });
  return { child, ready, finished, start: () => child.send('start') };
}

journalTest('create false refuses a missing journal without creating files or directories', t => {
  const f = storage(t);
  const nested = join(f.dir, 'missing', 'nested', 'operations.sqlite');
  for (const path of [f.path, nested]) {
    rejectsCode(() => f.open({ create: false }, path), 'JOURNAL_MISSING');
    for (const suffix of ['', '-wal', '-shm', '-journal']) assert.equal(existsSync(path + suffix), false);
  }
  assert.equal(existsSync(join(f.dir, 'missing')), false);
});

journalTest('create false never recreates a deleted journal containing completed work', t => {
  const f = storage(t);
  const journal = f.open();
  enter(journal, 'completed');
  journal.close();
  rmSync(f.path);
  rejectsCode(() => f.open({ create: false }), 'JOURNAL_MISSING');
  for (const suffix of ['', '-wal', '-shm', '-journal']) assert.equal(existsSync(f.path + suffix), false);
});

journalTest('create false rejects empty, zero-version and truncated databases without initializing them', t => {
  for (const kind of ['empty', 'zero-version', 'truncated']) {
    const f = storage(t);
    if (kind === 'truncated') {
      const journal = f.open();
      enter(journal, 'uncertain');
      journal.close();
    }
    writeFileSync(f.path, '', { mode: 0o600 });
    if (kind === 'zero-version') {
      const raw = f.raw();
      raw.exec('VACUUM');
      assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 0);
      raw.close();
      assert.ok(lstatSync(f.path).size > 0);
    }
    const before = readFileSync(f.path);
    rejectsCode(() => f.open({ create: false }), 'JOURNAL_SCHEMA');
    assert.deepEqual(readFileSync(f.path), before);
    for (const suffix of ['-wal', '-shm', '-journal']) assert.equal(existsSync(f.path + suffix), false);
  }
});

journalTest('create false reopens a valid journal without changing identity, evidence or execution fences', t => {
  const f = storage(t);
  const journal = f.open();
  const saved = states.map(state => {
    const input = { ...record, operationId: state };
    enter(journal, state, input);
    return journal.get(scope, state);
  });
  journal.close();
  const reader = f.raw();
  const evidence = reader.prepare('SELECT * FROM evidence ORDER BY id').all();
  reader.close();
  const reopened = f.open({ create: false });
  for (const before of saved) {
    assert.deepEqual(reopened.get(scope, before.operationId), before);
    assert.equal(reopened.prepare({ ...record, operationId: before.operationId }).state, before.state);
  }
  assert.deepEqual(f.raw().prepare('SELECT * FROM evidence ORDER BY id').all(), evidence);
  assert.equal(reopened.prepare({ ...record, operationId: 'new-business-operation' }).state, 'prepared');
});

journalTest('create true explicitly provisions missing or empty journals and the internal default stays true', t => {
  for (const kind of ['missing', 'empty', 'default', 'undefined']) {
    const f = storage(t);
    const path = kind === 'missing' ? join(f.dir, 'new', 'operations.sqlite') : f.path;
    if (kind === 'empty') writeFileSync(path, '', { mode: 0o600 });
    const options = kind === 'default' ? undefined : { create: kind === 'undefined' ? undefined : true };
    const journal = f.open(options, path);
    enter(journal, 'completed');
    journal.close();
    assert.equal(f.open({ create: false }, path).get(scope, record.operationId).state, 'completed');
  }
});

journalTest('create rejects nonboolean values and accessors before touching the filesystem', t => {
  const f = storage(t);
  for (const create of [null, 0, 1, 'false', 'true', {}, [], () => {}, Symbol('create')]) {
    rejectsCode(() => f.open({ create }), 'JOURNAL_CONFIG');
  }
  let executed = 0;
  rejectsCode(() => f.open({ get create() { executed++; return true; } }), 'JOURNAL_CONFIG');
  assert.equal(executed, 0);
  assert.equal(existsSync(f.path), false);
});

journalTest('prepare persists immutable identity, private SQLite files and scoped absence', t => {
  const f = storage(t);
  const journal = f.open();
  assert.equal(journal.get(scope, record.operationId), null);
  const before = Date.now();
  const row = journal.prepare(record);
  assert.deepEqual(row, {
    ...record, state: 'prepared', owner: null, fingerprint: null, resultDigest: null,
    reportState: 'not_reported', errorCode: null, createdAt: row.createdAt, updatedAt: row.createdAt,
  });
  assert.ok(Number.isSafeInteger(row.createdAt) && row.createdAt >= before && row.createdAt <= Date.now());
  assert.ok(Object.isFrozen(row));
  assert.equal(journal.get(otherScope, record.operationId), null);
  assert.equal(journal.get(scope, 'absent'), null);
  const other = f.open();
  assert.deepEqual(other.get(scope, record.operationId), row);
  for (const path of [f.dir, f.path, `${f.path}-wal`, `${f.path}-shm`]) {
    const stat = lstatSync(path);
    assert.equal(stat.mode & 0o777, path === f.dir ? 0o700 : 0o600);
    assert.equal(stat.uid, process.getuid());
    if (path !== f.dir) assert.equal(stat.nlink, 1);
  }
  journal.close();
  other.close();
  assert.equal(readFileSync(f.path).subarray(0, 16).toString(), 'SQLite format 3\0');
  assert.deepEqual(f.open().get(scope, record.operationId), row);
});

journalTest('prepare converges only when every immutable field matches without resetting state', t => {
  const f = storage(t);
  const journal = f.open();
  enter(journal, 'uncertain');
  const prior = journal.get(scope, record.operationId);
  assert.deepEqual(journal.prepare({ ...record }), prior);
  for (const field of ['inputDigest', 'contextDigest', 'bindingDigest', 'actionId', 'sessionId', 'toolUseId']) {
    const value = field.endsWith('Digest') ? 'f'.repeat(64) : 'changed-id';
    rejectsCode(() => journal.prepare({ ...record, [field]: value }), 'CONFLICT');
  }
  assert.deepEqual(journal.get(scope, record.operationId), prior);
  assert.equal(journal.prepare({ ...record, scope: otherScope }).state, 'prepared');
  assert.equal(journal.prepare({ ...record, operationId: 'distinct-operation' }).state, 'prepared');
  const raw = f.raw();
  assert.equal(raw.prepare('SELECT count(*) AS n FROM operations').get().n, 3);
});

journalTest('records, lookup keys and owners reject malformed or unbounded identity values', t => {
  const journal = storage(t).open();
  for (const field of ['scope', 'inputDigest', 'contextDigest', 'bindingDigest']) {
    for (const value of ['', 'A'.repeat(64), 'f'.repeat(63), 'g'.repeat(64), 'a'.repeat(64) + '\n', null, 1]) {
      rejectsCode(() => journal.prepare({ ...record, [field]: value }), 'JOURNAL_RECORD');
    }
  }
  for (const field of ['operationId', 'actionId', 'sessionId', 'toolUseId']) {
    for (const value of ['', '../x', 'a..b', 'a/b', 'a b', 'a\0b', 'a\n', 'a\r', 'a\u2028', 'a'.repeat(129), null, {}]) {
      rejectsCode(() => journal.prepare({ ...record, [field]: value }), 'JOURNAL_RECORD');
    }
  }
  for (const value of [null, [], 'secret', { ...record, rawInput: 'secret' }]) {
    rejectsCode(() => journal.prepare(value), 'JOURNAL_RECORD');
  }
  let getterCalls = 0;
  const accessor = { ...record, get actionId() { getterCalls++; return 'action'; } };
  rejectsCode(() => journal.prepare(accessor), 'JOURNAL_RECORD');
  rejectsCode(() => journal.prepare(Object.assign(Object.create({ rawInput: 'secret' }), record)), 'JOURNAL_RECORD');
  rejectsCode(() => journal.prepare(new Proxy(record, {
    getPrototypeOf() { throw new Error('must-not-read-proxy-secret'); },
  })), 'JOURNAL_RECORD');
  assert.equal(getterCalls, 0);
  journal.prepare({ ...record, operationId: 'a'.repeat(128), actionId: 'A-z_0.1' });
  journal.prepare(record);
  rejectsCode(() => journal.get('bad', record.operationId), 'JOURNAL_RECORD');
  rejectsCode(() => journal.get(scope, 'bad/id'), 'JOURNAL_RECORD');
  for (const owner of ['', 'x..y', 'a'.repeat(129), null, undefined]) {
    rejectsCode(() => journal.claim(scope, record.operationId, ['prepared'], 'requesting', owner), 'JOURNAL_RECORD');
  }
  assert.equal(journal.get(scope, record.operationId).state, 'prepared');
});

journalTest('claims are exclusive across two connections and dispatch needs the original owner', t => {
  const f = storage(t);
  const first = f.open();
  const second = f.open();
  first.prepare(record);
  assert.equal(first.claim(scope, record.operationId, ['prepared'], 'requesting', 'owner-1'), true);
  assert.equal(second.claim(scope, record.operationId, ['prepared'], 'requesting', 'owner-2'), false);
  assert.equal(second.settle(scope, record.operationId, 'owner-2', 'requesting', 'dispatching'), false);
  assert.equal(first.settle(scope, record.operationId, 'owner-1', 'requesting', 'dispatching'), true);
  assert.equal(first.settle(scope, record.operationId, 'owner-1', 'requesting', 'dispatching'), false);
  assert.equal(second.settle(scope, record.operationId, 'owner-2', 'dispatching', 'completed'), false);
  assert.equal(first.settle(scope, record.operationId, 'owner-1', 'dispatching', 'completed'), true);
  assert.equal(second.get(scope, record.operationId).owner, 'owner-1');
  assert.equal(second.claim(scope, 'absent', ['prepared'], 'requesting', 'owner-2'), false);
  assert.equal(second.settle(scope, 'absent', 'owner-2', 'requesting', 'held'), false);
  assert.equal(second.recoverHeld(scope, 'absent'), false);
});

journalTest('claim phase allowlist forbids owner takeover and arbitrary state transitions', t => {
  const journal = storage(t).open();
  journal.prepare(record);
  for (const from of states) {
    for (const next of states) {
      if ((from === 'prepared' && next === 'requesting') || (from === 'held' && next === 'redeeming')) continue;
      rejectsCode(() => journal.claim(scope, record.operationId, [from], next, 'attacker'), 'JOURNAL_TRANSITION');
    }
  }
  for (const from of [[], ['prepared', 'held'], ['prepared', 'prepared'], 'prepared', null, ['unknown']]) {
    rejectsCode(() => journal.claim(scope, record.operationId, from, 'requesting', 'attacker'), 'JOURNAL_TRANSITION');
  }
  assert.equal(journal.get(scope, record.operationId).state, 'prepared');
});

journalTest('accessor or proxy fromStates cannot change a validated claim phase', t => {
  const journal = storage(t).open();
  enter(journal, 'held');
  let reads = 0;
  const changing = [];
  Object.defineProperty(changing, '0', { get() { return ++reads === 1 ? 'prepared' : 'held'; } });
  rejectsCode(() => journal.claim(scope, record.operationId, changing, 'requesting', 'new-owner'), 'JOURNAL_TRANSITION');
  assert.equal(reads, 0);
  rejectsCode(() => journal.claim(scope, record.operationId, new Proxy(['held'], {}), 'redeeming', 'new-owner'), 'JOURNAL_TRANSITION');
  assert.equal(journal.get(scope, record.operationId).state, 'held');
});

journalTest('settle enforces the complete phase allowlist and preserves owners outside held', t => {
  const journal = storage(t).open();
  for (const [from, nextStates] of Object.entries(transitions)) {
    for (const next of nextStates) {
      const input = { ...record, operationId: `${from}-${next}` };
      enter(journal, from, input);
      assert.equal(journal.settle(scope, input.operationId, 'wrong-owner', from, next), false);
      assert.equal(journal.settle(scope, input.operationId, 'owner-1', from, next), true);
      const row = journal.get(scope, input.operationId);
      assert.equal(row.state, next);
      assert.equal(row.owner, next === 'held' ? null : 'owner-1');
      assert.ok(row.updatedAt >= row.createdAt);
    }
  }
  for (const from of states) {
    for (const next of states) {
      if (transitions[from]?.includes(next) || (from === next && ['completed', 'uncertain'].includes(from))) continue;
      rejectsCode(() => journal.settle(scope, record.operationId, 'owner-1', from, next), 'JOURNAL_TRANSITION');
    }
  }
});

journalTest('held releases the request owner, while late responses cannot settle a new redemption', t => {
  const journal = storage(t).open();
  enter(journal, 'requesting');
  const fingerprint = 'cava:v1:sha256/' + 'f'.repeat(64);
  assert.equal(journal.settle(scope, record.operationId, 'owner-1', 'requesting', 'held', { fingerprint }), true);
  assert.equal(journal.get(scope, record.operationId).owner, null);
  assert.equal(journal.claim(scope, record.operationId, ['held'], 'redeeming', 'owner-2'), true);
  assert.equal(journal.settle(scope, record.operationId, 'owner-1', 'requesting', 'dispatching'), false);
  assert.equal(journal.settle(scope, record.operationId, 'owner-1', 'redeeming', 'dispatching'), false);
  assert.equal(journal.settle(scope, record.operationId, 'owner-2', 'redeeming', 'dispatching'), true);
  assert.equal(journal.get(scope, record.operationId).fingerprint, fingerprint);
});

journalTest('recovery changes only requesting or uncertain_request into held and fences stale replies', t => {
  const f = storage(t);
  const journal = f.open();
  for (const state of states) {
    const input = { ...record, operationId: state };
    enter(journal, state, input);
    const before = journal.get(scope, state);
    const eligible = ['requesting', 'uncertain_request'].includes(state);
    assert.equal(journal.recoverHeld(scope, state), eligible);
    const after = journal.get(scope, state);
    if (eligible) {
      assert.equal(after.state, 'held');
      assert.equal(after.owner, null);
      assert.equal(journal.settle(scope, state, 'owner-1', 'requesting', 'dispatching'), false);
      assert.equal(journal.claim(scope, state, ['held'], 'redeeming', 'new-owner'), true);
    } else assert.deepEqual(after, before);
    assert.equal(journal.recoverHeld(scope, state), false);
  }
});

journalTest('recovery persists the observed fingerprint with held state and transition evidence', t => {
  const f = storage(t);
  const journal = f.open();
  const fingerprint = 'cava:v1:sha256/' + 'f'.repeat(64);
  for (const state of ['requesting', 'uncertain_request']) {
    const input = { ...record, operationId: state };
    enter(journal, state, input);
    assert.equal(journal.recoverHeld(scope, state, fingerprint), true);
    const after = journal.get(scope, state);
    assert.equal(after.state, 'held');
    assert.equal(after.owner, null);
    assert.equal(after.fingerprint, fingerprint);
    assert.equal(journal.settle(scope, state, 'owner-1', 'requesting', 'dispatching'), false);
  }
  journal.close();
  const reopened = f.open();
  const raw = f.raw();
  const events = raw.prepare("SELECT * FROM evidence WHERE kind='recover_held' ORDER BY id").all();
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.equal(event.from_state, event.operation_id);
    assert.equal(event.previous_owner, 'owner-1');
    assert.equal(event.state, 'held');
    assert.equal(event.owner, null);
    assert.equal(event.fingerprint, fingerprint);
    assert.equal(reopened.get(scope, event.operation_id).fingerprint, fingerprint);
  }
  assert.equal(reopened.recoverHeld(scope, 'requesting', 'different'), false);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM evidence WHERE kind='recover_held'").get().n, 2);
  assert.equal(reopened.get(scope, 'requesting').fingerprint, fingerprint);
});

journalTest('recovery preserves an existing fingerprint and rejects a changed or cleared binding', t => {
  const f = storage(t);
  const journal = f.open();
  const fingerprint = 'cava:' + 'f'.repeat(64);
  for (const [index, supplied] of [undefined, fingerprint, 'different', null].entries()) {
    const input = { ...record, operationId: `fingerprint-${index}` };
    enter(journal, 'requesting', input);
    journal.settle(scope, input.operationId, 'owner-1', 'requesting', 'uncertain_request', { fingerprint });
    const before = journal.get(scope, input.operationId);
    if (supplied === undefined || supplied === fingerprint) {
      assert.equal(journal.recoverHeld(scope, input.operationId, supplied), true);
      assert.equal(journal.get(scope, input.operationId).fingerprint, fingerprint);
    } else {
      rejectsCode(() => journal.recoverHeld(scope, input.operationId, supplied), 'CONFLICT');
      assert.deepEqual(journal.get(scope, input.operationId), before);
    }
  }
  assert.equal(f.raw().prepare("SELECT count(*) AS n FROM evidence WHERE kind='recover_held'").get().n, 2);
});

journalTest('recovery validates its optional bounded fingerprint without invoking caller code', t => {
  const f = storage(t);
  const journal = f.open();
  enter(journal, 'requesting');
  const before = journal.get(scope, record.operationId);
  let executed = 0;
  const trap = () => { executed++; throw new Error('private-fingerprint'); };
  const invalid = ['x'.repeat(201), '\ud800', 42, false, [], {}, new String('fingerprint'),
    Symbol('fingerprint'), trap, { get fingerprint() { return trap(); } },
    new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap })];
  for (const fingerprint of invalid) {
    rejectsCode(() => journal.recoverHeld(scope, record.operationId, fingerprint), 'JOURNAL_PATCH');
    assert.deepEqual(journal.get(scope, record.operationId), before);
  }
  assert.equal(executed, 0);
  const fingerprint = 'cava:' + 'x'.repeat(195);
  assert.equal(journal.recoverHeld(scope, record.operationId, fingerprint), true);
  assert.equal(journal.get(scope, record.operationId).fingerprint, fingerprint);
  assert.equal(f.raw().prepare("SELECT count(*) AS n FROM evidence WHERE kind='recover_held'").get().n, 1);
});

journalTest('failed recovery evidence rolls back the fingerprint, state and owner together', t => {
  const f = storage(t);
  const journal = f.open();
  enter(journal, 'requesting');
  const before = journal.get(scope, record.operationId);
  const fingerprint = 'cava:' + 'f'.repeat(64);
  const raw = f.raw();
  raw.exec("CREATE TRIGGER reject_recovery BEFORE INSERT ON evidence WHEN NEW.kind='recover_held' BEGIN SELECT RAISE(ABORT, 'private-storage-error'); END");
  rejectsCode(() => journal.recoverHeld(scope, record.operationId, fingerprint), 'JOURNAL_UNAVAILABLE');
  assert.deepEqual(journal.get(scope, record.operationId), before);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM evidence WHERE kind='recover_held'").get().n, 0);
  raw.exec('DROP TRIGGER reject_recovery');
  assert.equal(journal.recoverHeld(scope, record.operationId, fingerprint), true);
  assert.equal(journal.get(scope, record.operationId).fingerprint, fingerprint);
  assert.equal(raw.prepare("SELECT fingerprint FROM evidence WHERE kind='recover_held'").get().fingerprint, fingerprint);
});

journalTest('reporting is owner-fenced and can only patch reportState on terminal self-transitions', t => {
  const journal = storage(t).open();
  for (const state of ['completed', 'uncertain']) {
    const input = { ...record, operationId: state };
    enter(journal, 'dispatching', input);
    assert.equal(journal.settle(scope, state, 'owner-1', 'dispatching', state, {
      resultDigest: 'e'.repeat(64), errorCode: state === 'uncertain' ? 'RESOURCE_LOST' : null,
    }), true);
    assert.equal(journal.get(scope, state).reportState, 'not_reported');
    assert.equal(journal.settle(scope, state, 'other', state, state, { reportState: 'confirmed' }), false);
    for (const reportState of ['uncertain', 'confirmed']) {
      assert.equal(journal.settle(scope, state, 'owner-1', state, state, { reportState }), true);
      assert.equal(journal.get(scope, state).reportState, reportState);
    }
    for (const patch of [{}, { resultDigest: 'd'.repeat(64) }, { fingerprint: 'new' }, { errorCode: 'NEW' },
      { reportState: 'confirmed', owner: 'other' }]) {
      rejectsCode(() => journal.settle(scope, state, 'owner-1', state, state, patch), 'JOURNAL_PATCH');
    }
    assert.equal(journal.get(scope, state).owner, 'owner-1');
    assert.equal(journal.get(scope, state).resultDigest, 'e'.repeat(64));
  }
});

journalTest('patches accept bounded fingerprints but reject raw data, SQL keys and malformed metadata', t => {
  const f = storage(t);
  const journal = f.open();
  enter(journal, 'requesting');
  const secret = 'credentials-or-raw-result-should-never-persist';
  const badPatches = [
    { rawInput: secret }, { output: secret }, { credentials: secret }, { owner: 'other' },
    { state: 'prepared' }, { operationId: 'other' }, { createdAt: 0 }, { updatedAt: 0 },
    { 'state = ?; DROP TABLE operations; --': secret },
    { fingerprint: 'x'.repeat(201) }, { fingerprint: 42 },
    { fingerprint: '\ud800' },
    { resultDigest: 'A'.repeat(64) }, { resultDigest: 'short' },
    { reportState: 'made_up' }, { errorCode: 'bad code' }, { errorCode: 'x'.repeat(129) },
    { errorCode: 'a..b' }, null, [], { [Symbol('secret')]: secret },
    { errorCode: 'CODE\n' },
  ];
  let getterCalls = 0;
  badPatches.push({ get fingerprint() { getterCalls++; return secret; } });
  badPatches.push(Object.create({ fingerprint: secret }));
  badPatches.push(new Proxy({ fingerprint: 'safe' }, {}));
  const before = journal.get(scope, record.operationId);
  for (const patch of badPatches) {
    rejectsCode(() => journal.settle(scope, record.operationId, 'owner-1', 'requesting', 'held', patch), 'JOURNAL_PATCH');
  }
  assert.equal(getterCalls, 0);
  assert.deepEqual(journal.get(scope, record.operationId), before);
  assert.equal(journal.settle(scope, record.operationId, 'owner-1', 'requesting', 'held', {
    fingerprint: 'cava:' + 'x'.repeat(195), resultDigest: null, errorCode: null,
  }), true);
  assert.equal(journal.get(scope, record.operationId).fingerprint.length, 200);
  for (const path of [f.path, `${f.path}-wal`]) {
    assert.equal(readFileSync(path).includes(secret), false);
  }
});

journalTest('capacity refuses only new records and never evicts completed or uncertain tombstones', t => {
  const f = storage(t);
  const journal = f.open({ maxOperations: 2 });
  enter(journal, 'completed');
  const second = { ...record, operationId: 'second' };
  enter(journal, 'uncertain', second);
  rejectsCode(() => journal.prepare({ ...record, operationId: 'third' }), 'JOURNAL_CAPACITY');
  assert.equal(journal.prepare(record).state, 'completed');
  const smaller = f.open({ maxOperations: 1 });
  assert.equal(smaller.prepare(second).state, 'uncertain');
  rejectsCode(() => smaller.prepare({ ...record, scope: otherScope }), 'JOURNAL_CAPACITY');
  rejectsCode(() => smaller.prepare({ ...record, actionId: 'different' }), 'CONFLICT');
  assert.equal(smaller.settle(scope, record.operationId, 'owner-1', 'completed', 'completed', { reportState: 'confirmed' }), true);
  assert.equal(smaller.get(scope, 'second').state, 'uncertain');
  assert.equal(f.raw().prepare('SELECT count(*) AS n FROM operations').get().n, 2);
});

journalTest('each successful CAS and prepare writes evidence in the same transaction', t => {
  const f = storage(t);
  const journal = f.open();
  const raw = f.raw();
  const count = () => raw.prepare('SELECT count(*) AS n FROM evidence').get().n;
  journal.prepare(record);
  assert.equal(count(), 1);
  journal.prepare(record);
  assert.equal(count(), 1);
  journal.claim(scope, record.operationId, ['prepared'], 'requesting', 'owner-1');
  assert.equal(count(), 2);
  journal.claim(scope, record.operationId, ['prepared'], 'requesting', 'owner-2');
  journal.settle(scope, record.operationId, 'wrong', 'requesting', 'held');
  assert.equal(count(), 2);
  raw.exec("CREATE TRIGGER reject_evidence BEFORE INSERT ON evidence BEGIN SELECT RAISE(ABORT, 'secret-database-error'); END");
  rejectsCode(() => journal.settle(scope, record.operationId, 'owner-1', 'requesting', 'held'), 'JOURNAL_UNAVAILABLE');
  assert.equal(journal.get(scope, record.operationId).state, 'requesting');
  rejectsCode(() => journal.recoverHeld(scope, record.operationId), 'JOURNAL_UNAVAILABLE');
  rejectsCode(() => journal.prepare({ ...record, operationId: 'rolled-back' }), 'JOURNAL_UNAVAILABLE');
  assert.equal(journal.get(scope, 'rolled-back'), null);
  assert.equal(count(), 2);
  raw.exec('DROP TRIGGER reject_evidence');
  assert.equal(journal.recoverHeld(scope, record.operationId), true);
  raw.exec("CREATE TRIGGER reject_evidence BEFORE INSERT ON evidence BEGIN SELECT RAISE(ABORT, 'secret-database-error'); END");
  rejectsCode(() => journal.claim(scope, record.operationId, ['held'], 'redeeming', 'owner-2'), 'JOURNAL_UNAVAILABLE');
  assert.equal(journal.get(scope, record.operationId).state, 'held');
  raw.exec('DROP TRIGGER reject_evidence');
  assert.equal(journal.claim(scope, record.operationId, ['held'], 'redeeming', 'owner-2'), true);
  assert.equal(count(), 4);
  const events = raw.prepare('SELECT * FROM evidence ORDER BY id').all();
  assert.deepEqual(events.map(event => event.state), ['prepared', 'requesting', 'held', 'redeeming']);
  assert.deepEqual(events.map(event => event.owner), [null, 'owner-1', null, 'owner-2']);
  assert.ok(events.every(event => event.scope === scope && event.operation_id === record.operationId));
});

journalTest('schema is versioned, STRICT, WAL and integrity-checked with a finite storage bound', t => {
  const f = storage(t);
  let connection;
  const execute = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
    if (sql.startsWith('PRAGMA busy_timeout=')) connection = this;
    return execute.call(this, sql);
  });
  f.open();
  assert.equal(connection.prepare('PRAGMA synchronous').get().synchronous, 2);
  assert.equal(connection.prepare('PRAGMA busy_timeout').get().timeout, 1000);
  assert.equal(connection.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(connection.prepare('PRAGMA trusted_schema').get().trusted_schema, 0);
  const pages = connection.prepare('PRAGMA max_page_count').get().max_page_count;
  const pageSize = connection.prepare('PRAGMA page_size').get().page_size;
  assert.ok(pages * pageSize <= 256 * 1024 * 1024);
  assert.ok(connection.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint > 0);
  assert.ok(connection.prepare('PRAGMA journal_size_limit').get().journal_size_limit > 0);
  const raw = f.raw();
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(raw.prepare('PRAGMA application_id').get().application_id, 0x4f53544a);
  assert.equal(raw.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.deepEqual(raw.prepare('PRAGMA quick_check').all().map(row => row.quick_check), ['ok']);
  for (const table of ['operations', 'evidence']) {
    const schema = raw.prepare('PRAGMA table_list').all().find(row => row.name === table);
    assert.equal(schema.strict, 1);
  }
  assert.throws(() => raw.exec("INSERT INTO operations(scope, operation_id) VALUES (x'00', x'00')"));
});

journalTest('unknown versions, unrelated SQLite files and corrupt files fail with sanitized codes', t => {
  for (const kind of ['version', 'unversioned', 'wrong-application', 'missing-table', 'corrupt']) {
    const f = storage(t);
    if (kind === 'corrupt') writeFileSync(f.path, 'secret-corrupt-database', { mode: 0o600 });
    else if (kind === 'unversioned') {
      writeFileSync(f.path, '', { mode: 0o600 });
      const raw = f.raw();
      raw.exec('CREATE TABLE unrelated(secret TEXT)');
      raw.close();
    } else {
      f.open().close();
      const raw = f.raw();
      if (kind === 'version') raw.exec('PRAGMA user_version=99');
      if (kind === 'wrong-application') raw.exec('PRAGMA application_id=7');
      if (kind === 'missing-table') raw.exec('DROP TABLE evidence');
      raw.close();
    }
    rejectsCode(() => f.open(), kind === 'corrupt' ? 'JOURNAL_CORRUPT' : 'JOURNAL_SCHEMA');
  }
});

journalTest('busy operation transactions time out without replay and remain usable afterwards', t => {
  const f = storage(t);
  const journal = f.open({ busyTimeoutMs: 20 });
  journal.prepare(record);
  const raw = f.raw();
  raw.exec('BEGIN IMMEDIATE');
  const before = performance.now();
  rejectsCode(() => journal.claim(scope, record.operationId, ['prepared'], 'requesting', 'owner-1'), 'JOURNAL_BUSY');
  assert.ok(performance.now() - before < 2000);
  assert.equal(journal.get(scope, record.operationId).state, 'prepared');
  raw.exec('ROLLBACK');
  assert.equal(journal.claim(scope, record.operationId, ['prepared'], 'requesting', 'owner-2'), true);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM evidence').get().n, 2);
});

journalTest('the default lock budget admits a short independent writer without replaying the claim or evidence', async t => {
  const f = storage(t), journal = f.open();
  journal.prepare(record);
  const child = worker(t, `
    const db = new DatabaseSync(data.path);
    try {
      db.exec('BEGIN IMMEDIATE');
      process.send({ locked: true });
      await new Promise(resolve => setTimeout(resolve, 300));
      db.exec('ROLLBACK');
      return 'released';
    } finally { db.close(); }
  `, { path: f.path });
  const locked = new Promise(resolve => child.child.on('message', message => { if (message.locked) resolve(); }));
  await child.ready;
  child.start();
  await locked;
  assert.equal(journal.claim(scope, record.operationId, ['prepared'], 'requesting', 'owner-1'), true);
  assert.equal((await child.finished).result, 'released');
  const raw = f.raw();
  assert.equal(raw.prepare('SELECT count(*) AS n FROM evidence').get().n, 2);
  assert.equal(journal.get(scope, record.operationId).owner, 'owner-1');
  assert.equal(journal.claim(scope, record.operationId, ['prepared'], 'requesting', 'owner-2'), false);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM evidence').get().n, 2);
});

journalTest('startup WAL retries consume one shrinking busy-timeout budget', t => {
  const f = storage(t);
  writeFileSync(f.path, '', { mode: 0o600 });
  const reader = f.raw();
  reader.exec('CREATE TABLE blocker(value TEXT); BEGIN IMMEDIATE;');
  const prepare = DatabaseSync.prototype.prepare;
  const budgets = [];
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
    if (sql === 'PRAGMA journal_mode=WAL') budgets.push(prepare.call(this, 'PRAGMA busy_timeout').get().timeout);
    return prepare.call(this, sql);
  });
  const before = performance.now();
  rejectsCode(() => f.open({ busyTimeoutMs: 40 }), 'JOURNAL_BUSY');
  assert.ok(performance.now() - before < 1000);
  assert.ok(budgets.length > 1, `Expected immediate WAL contention, observed budgets: ${budgets}`);
  assert.ok(budgets.some(budget => budget < 40), `Startup did not shrink its wait budget: ${budgets}`);
  reader.exec('ROLLBACK');
});

journalTest('failed second open cannot release another same-process connection lock', async t => {
  const f = storage(t);
  writeFileSync(f.path, '', { mode: 0o600 });
  const reader = f.raw();
  reader.exec('CREATE TABLE blocker(value TEXT); BEGIN; SELECT * FROM blocker;');
  rejectsCode(() => f.open({ busyTimeoutMs: 10 }), 'JOURNAL_BUSY');
  const child = worker(t, `
    const db = new DatabaseSync(data.path);
    db.exec('PRAGMA busy_timeout=0');
    try {
      try { db.exec('BEGIN EXCLUSIVE; ROLLBACK;'); return 'lock-was-lost'; }
      catch (error) { return error.errcode === 5 ? 'still-locked' : error.code; }
    } finally { db.close(); }
  `, { path: f.path });
  await child.ready;
  child.start();
  const result = await child.finished;
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.result, 'still-locked');
  reader.exec('ROLLBACK');
});

journalTest('invalid configuration and paths fail without disclosing path or causes', t => {
  const f = storage(t);
  for (const options of [
    { maxOperations: 0 }, { maxOperations: -1 }, { maxOperations: 1.5 },
    { maxOperations: Infinity }, { busyTimeoutMs: -1 }, { busyTimeoutMs: Infinity },
    { busyTimeoutMs: 0.5 }, { busyTimeoutMs: 60000 }, null, [], { arbitrarySql: 'secret' },
  ]) rejectsCode(() => f.open(options), 'JOURNAL_CONFIG');
  for (const path of [':memory:', 'relative.sqlite', '', null, new URL('file:///secret'),
    join(f.dir, 'secret') + '\0db', `${f.dir}/../secret.sqlite`]) {
    rejectsCode(() => new OperationJournal(path), 'JOURNAL_PATH');
  }
  const zeroWait = f.open({ busyTimeoutMs: 0, maxOperations: 1 });
  zeroWait.prepare(record);
  zeroWait.close();
  zeroWait.close();
  for (const invoke of [
    () => zeroWait.get(scope, record.operationId), () => zeroWait.prepare(record),
    () => zeroWait.claim(scope, record.operationId, ['prepared'], 'requesting', 'owner'),
    () => zeroWait.settle(scope, record.operationId, 'owner', 'requesting', 'held'),
    () => zeroWait.recoverHeld(scope, record.operationId),
  ]) rejectsCode(invoke, 'JOURNAL_CLOSED');
});

journalTest('nested private directories are created without changing process umask or ancestor modes', t => {
  const f = storage(t);
  const path = join(f.dir, 'new', 'nested', 'journal.sqlite');
  const mask = process.umask();
  const ancestorMode = lstatSync(dirname(f.dir)).mode;
  const journal = f.open(undefined, path);
  journal.prepare(record);
  assert.equal(process.umask(), mask);
  assert.equal(lstatSync(dirname(f.dir)).mode, ancestorMode);
  for (const dir of [join(f.dir, 'new'), dirname(path)]) assert.equal(lstatSync(dir).mode & 0o777, 0o700);
});

journalTest('trusted system root aliases are checked as ancestors, not private journal directories', t => {
  const f = storage(t);
  const alias = ['/var', '/tmp', '/Users'].find(path => {
    try {
      const stat = lstatSync(path);
      return stat.isSymbolicLink() && stat.uid === 0 && f.path.startsWith(realpathSync(path) + '/');
    } catch { return false; }
  });
  if (!alias) return t.skip('No applicable system-owned root alias on this host');
  const path = alias + f.path.slice(realpathSync(alias).length);
  f.open(undefined, path).prepare(record);
  assert.equal(f.open().get(scope, record.operationId).state, 'prepared');
});

journalTest('public directories, unsafe writable ancestors and nonprivate database files are rejected', t => {
  for (const kind of ['parent', 'ancestor', 'file', 'wal', 'shm']) {
    const f = storage(t);
    let path = f.path;
    if (kind === 'parent') chmodSync(f.dir, 0o755);
    else if (kind === 'ancestor') {
      const unsafe = join(f.dir, 'unsafe');
      mkdirSync(unsafe, { mode: 0o777 });
      chmodSync(unsafe, 0o777);
      path = join(unsafe, 'private', 'journal.sqlite');
    } else {
      const target = kind === 'file' ? path : `${path}-${kind}`;
      writeFileSync(target, '', { mode: 0o644 });
      chmodSync(target, 0o644);
    }
    rejectsCode(() => f.open(undefined, path), 'JOURNAL_PERMISSIONS');
    if (kind === 'ancestor') assert.equal(existsSync(dirname(path)), false);
  }
});

journalTest('database, WAL, SHM and rollback-journal links are rejected even when dangling', t => {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    for (const kind of ['symlink', 'dangling', 'hardlink', 'directory']) {
      const f = storage(t);
      const target = join(f.dir, 'secret-target');
      if (kind !== 'dangling') writeFileSync(target, 'must-not-change', { mode: 0o600 });
      const name = `${f.path}${suffix}`;
      if (kind === 'hardlink') linkSync(target, name);
      else if (kind === 'directory') mkdirSync(name, { mode: 0o700 });
      else symlinkSync(target, name);
      rejectsCode(() => f.open(), 'JOURNAL_PERMISSIONS');
      if (kind === 'dangling') assert.equal(existsSync(target), false);
      else assert.equal(readFileSync(target, 'utf8'), 'must-not-change');
    }
  }
});

journalTest('user-controlled ancestor symlinks are not followed to create journal directories', t => {
  const f = storage(t);
  const target = join(f.dir, 'real');
  mkdirSync(target, { mode: 0o700 });
  const alias = join(f.dir, 'alias');
  symlinkSync(target, alias);
  rejectsCode(() => f.open(undefined, join(alias, 'new', 'journal.sqlite')), 'JOURNAL_PERMISSIONS');
  assert.equal(existsSync(join(target, 'new')), false);
  rmSync(alias);
  symlinkSync(join(f.dir, 'missing'), alias);
  rejectsCode(() => f.open(undefined, join(alias, 'new', 'journal.sqlite')), 'JOURNAL_PERMISSIONS');
});

journalTest('opened journals reject permissions, hardlink and inode changes before further access', t => {
  const f = storage(t);
  const journal = f.open();
  journal.prepare(record);
  chmodSync(f.path, 0o644);
  rejectsCode(() => journal.get(scope, record.operationId), 'JOURNAL_PERMISSIONS');
  chmodSync(f.path, 0o600);
  const hardlink = join(f.dir, 'extra-link');
  linkSync(f.path, hardlink);
  rejectsCode(() => journal.claim(scope, record.operationId, ['prepared'], 'requesting', 'owner'), 'JOURNAL_PERMISSIONS');
  rmSync(hardlink);
  const original = join(f.dir, 'original.sqlite');
  renameSync(f.path, original);
  writeFileSync(f.path, '', { mode: 0o600 });
  try {
    rejectsCode(() => journal.get(scope, record.operationId), 'JOURNAL_PERMISSIONS');
    rejectsCode(() => journal.prepare(record), 'JOURNAL_PERMISSIONS');
  } finally {
    rmSync(f.path);
    renameSync(original, f.path);
  }
  assert.equal(journal.get(scope, record.operationId).state, 'prepared');
});

journalTest('quick_check detects invalid persisted records even with an unchanged versioned schema', t => {
  const f = storage(t);
  const journal = f.open();
  journal.prepare(record);
  journal.close();
  const raw = f.raw();
  raw.exec("PRAGMA ignore_check_constraints=ON; UPDATE operations SET input_digest='secret-corruption'");
  raw.close();
  rejectsCode(() => f.open(), 'JOURNAL_CORRUPT');
});

journalTest('reopen keeps every lost-owner fence and never makes an end state prepared', t => {
  const f = storage(t);
  const first = f.open();
  const persisted = states.filter(value => !['prepared', 'held'].includes(value));
  for (const state of persisted) enter(first, state, { ...record, operationId: state }, 'lost-owner');
  first.close();
  const reopened = f.open();
  for (const state of persisted) {
    assert.equal(reopened.prepare({ ...record, operationId: state }).state, state);
    assert.equal(reopened.get(scope, state).owner, 'lost-owner');
    assert.equal(reopened.claim(scope, state, ['prepared'], 'requesting', 'replacement'), false);
    assert.equal(reopened.claim(scope, state, ['held'], 'redeeming', 'replacement'), false);
  }
});

journalTest('killed request, redemption and dispatch owners cannot be reclaimed as runnable', t => {
  const f = storage(t);
  for (const state of ['requesting', 'redeeming', 'dispatching', 'completed']) {
    const input = { ...record, operationId: state };
    const source = `
      import { OperationJournal } from ${JSON.stringify(moduleUrl.href)};
      const journal = new OperationJournal(${JSON.stringify(f.path)});
      const input = ${JSON.stringify(input)};
      journal.prepare(input);
      journal.claim(input.scope, input.operationId, ['prepared'], 'requesting', 'killed-owner');
      if (${JSON.stringify(state)} === 'redeeming') {
        journal.settle(input.scope, input.operationId, 'killed-owner', 'requesting', 'held');
        journal.claim(input.scope, input.operationId, ['held'], 'redeeming', 'killed-owner');
      }
      if (['dispatching', 'completed'].includes(${JSON.stringify(state)})) {
        journal.settle(input.scope, input.operationId, 'killed-owner', 'requesting', 'dispatching');
      }
      if (${JSON.stringify(state)} === 'completed') {
        journal.settle(input.scope, input.operationId, 'killed-owner', 'dispatching', 'completed');
      }
      process.kill(process.pid, 'SIGKILL');
    `;
    const child = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', source], { timeout: 5000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr?.toString());
    const journal = f.open();
    assert.equal(journal.get(scope, state).state, state);
    assert.equal(journal.get(scope, state).owner, 'killed-owner');
    assert.equal(journal.claim(scope, state, ['prepared'], 'requesting', 'new-owner'), false);
    assert.equal(journal.claim(scope, state, ['held'], 'redeeming', 'new-owner'), false);
    if (state !== 'requesting') assert.equal(journal.recoverHeld(scope, state), false);
    journal.close();
  }
});

journalTest('simultaneous child-process first opens converge and exactly one owner claims', async t => {
  const f = storage(t);
  const body = `
    const journal = new OperationJournal(data.path, { busyTimeoutMs: 500 });
    try {
      const row = journal.prepare(data.record);
      const claimed = journal.claim(data.record.scope, data.record.operationId, ['prepared'], 'requesting', data.owner);
      return { actionId: row.actionId, claimed };
    } finally { journal.close(); }
  `;
  const workers = Array.from({ length: 6 }, (_, index) => worker(t, body, {
    path: f.path, record, owner: `process-${index}`,
  }));
  await Promise.all(workers.map(child => child.ready));
  workers.forEach(child => child.start());
  const results = await Promise.all(workers.map(child => child.finished));
  for (const result of results) {
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.result.actionId, record.actionId);
  }
  assert.equal(results.filter(result => result.result.claimed).length, 1);
  const journal = f.open();
  assert.equal(journal.get(scope, record.operationId).state, 'requesting');
  const raw = f.raw();
  assert.equal(raw.prepare('SELECT count(*) AS n FROM operations').get().n, 1);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM evidence').get().n, 2);
});

journalTest('cross-process capacity is serialized without deleting the winning operation', async t => {
  const f = storage(t);
  const body = `
    const journal = new OperationJournal(data.path, { maxOperations: 1, busyTimeoutMs: 500 });
    try {
      try { journal.prepare(data.record); return 'prepared'; }
      catch (error) { return error.code; }
    } finally { journal.close(); }
  `;
  const workers = ['first', 'second'].map(operationId => worker(t, body, {
    path: f.path, record: { ...record, operationId },
  }));
  await Promise.all(workers.map(child => child.ready));
  workers.forEach(child => child.start());
  const results = await Promise.all(workers.map(child => child.finished));
  for (const result of results) assert.equal(result.code, 0, JSON.stringify(result));
  assert.deepEqual(results.map(result => result.result).sort(), ['JOURNAL_CAPACITY', 'prepared']);
  assert.equal(f.raw().prepare('SELECT count(*) AS n FROM operations').get().n, 1);
});

journalTest('concurrent reopen-only recoveries persist only the winning fingerprint and evidence', async t => {
  const f = storage(t);
  const journal = f.open();
  enter(journal, 'requesting');
  const body = `
    const journal = new OperationJournal(data.path, { create: false, busyTimeoutMs: 500 });
    try {
      return { recovered: journal.recoverHeld(data.record.scope, data.record.operationId, data.fingerprint),
        fingerprint: data.fingerprint };
    } finally { journal.close(); }
  `;
  const workers = ['first-fingerprint', 'second-fingerprint'].map(fingerprint => worker(t, body, {
    path: f.path, record, fingerprint,
  }));
  await Promise.all(workers.map(child => child.ready));
  workers.forEach(child => child.start());
  const results = await Promise.all(workers.map(child => child.finished));
  for (const result of results) assert.equal(result.code, 0, JSON.stringify(result));
  const winners = results.filter(result => result.result.recovered);
  assert.equal(winners.length, 1);
  const fingerprint = winners[0].result.fingerprint;
  assert.equal(journal.get(scope, record.operationId).fingerprint, fingerprint);
  assert.equal(journal.get(scope, record.operationId).state, 'held');
  assert.equal(journal.settle(scope, record.operationId, 'owner-1', 'requesting', 'dispatching'), false);
  const events = f.raw().prepare("SELECT fingerprint FROM evidence WHERE kind='recover_held'").all();
  assert.deepEqual(events.map(event => event.fingerprint), [fingerprint]);
});
