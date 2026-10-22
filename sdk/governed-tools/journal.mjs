import { DatabaseSync } from 'node:sqlite';
import {
  constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, sep } from 'node:path';
import { isProxy } from 'node:util/types';

const VERSION = 1;
const APPLICATION_ID = 0x4f53544a;
const MAX_DATABASE_BYTES = 256 * 1024 * 1024;
const MAX_WAL_BYTES = 16 * 1024 * 1024;
const WAIT = new Int32Array(new SharedArrayBuffer(4));
const DIGEST = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const FIELDS = {
  scope: 'scope', operationId: 'operation_id', inputDigest: 'input_digest',
  contextDigest: 'context_digest', bindingDigest: 'binding_digest',
  actionId: 'action_id', sessionId: 'session_id', toolUseId: 'tool_use_id',
};
const PATCH_KEYS = ['fingerprint', 'resultDigest', 'reportState', 'errorCode'];
const REPORT_STATES = ['not_reported', 'confirmed', 'uncertain'];
const STATES = [
  'prepared', 'requesting', 'held', 'redeeming', 'dispatching', 'completed',
  'denied', 'expired', 'cancelled', 'uncertain_request', 'uncertain_redemption', 'uncertain',
];
const SETTLEMENTS = new Map([
  ['requesting', ['held', 'denied', 'expired', 'uncertain_request', 'dispatching']],
  ['redeeming', ['held', 'denied', 'expired', 'cancelled', 'uncertain_redemption', 'dispatching']],
  ['dispatching', ['completed', 'uncertain']],
]);

class JournalError extends Error {
  constructor(code) {
    super(code);
    this.name = 'OperationJournalError';
    this.code = code;
  }
}

function fail(code) { throw new JournalError(code); }

function sanitize(error) {
  if (error instanceof JournalError) return error;
  const sqliteCode = typeof error?.errcode === 'number' ? error.errcode & 0xff : null;
  if (sqliteCode === 5 || sqliteCode === 6) return new JournalError('JOURNAL_BUSY');
  if (sqliteCode === 11 || sqliteCode === 26) return new JournalError('JOURNAL_CORRUPT');
  if (sqliteCode === 13) return new JournalError('JOURNAL_CAPACITY');
  return new JournalError('JOURNAL_UNAVAILABLE');
}

function dataObject(value, keys, code, required = []) {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (!keys.includes(key)) fail(code);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(code);
    snapshot[key] = descriptor.value;
  }
  if (required.some(key => !Object.hasOwn(snapshot, key))) fail(code);
  return snapshot;
}

function isId(value) {
  return typeof value === 'string' && SAFE_ID.test(value) && !value.includes('..');
}

function isDigest(value) { return typeof value === 'string' && DIGEST.test(value); }

function identity(scope, operationId) {
  if (!isDigest(scope) || !isId(operationId)) fail('JOURNAL_RECORD');
}

function validateRecord(record) {
  const value = dataObject(record, Object.keys(FIELDS), 'JOURNAL_RECORD', Object.keys(FIELDS));
  for (const key of Object.keys(FIELDS)) {
    if (!(key === 'scope' || key.endsWith('Digest') ? isDigest(value[key]) : isId(value[key]))) {
      fail('JOURNAL_RECORD');
    }
  }
  return value;
}

function validatePatch(patch, reporting) {
  const value = dataObject(patch, PATCH_KEYS, 'JOURNAL_PATCH');
  if (reporting && (Object.keys(value).length !== 1 || !Object.hasOwn(value, 'reportState'))) fail('JOURNAL_PATCH');
  if (Object.hasOwn(value, 'fingerprint') && value.fingerprint !== null
    && (typeof value.fingerprint !== 'string' || value.fingerprint.length > 200 || !value.fingerprint.isWellFormed())) fail('JOURNAL_PATCH');
  if (Object.hasOwn(value, 'resultDigest') && value.resultDigest !== null && !isDigest(value.resultDigest)) fail('JOURNAL_PATCH');
  if (Object.hasOwn(value, 'reportState') && !REPORT_STATES.includes(value.reportState)) fail('JOURNAL_PATCH');
  if (Object.hasOwn(value, 'errorCode') && value.errorCode !== null && !isId(value.errorCode)) fail('JOURNAL_PATCH');
  return value;
}

function maybeStat(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function checkFile(stat) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.uid !== process.getuid() || (stat.mode & 0o077)) fail('JOURNAL_PERMISSIONS');
}

function checkAncestor(stat) {
  if (!stat.isDirectory() || ![0, process.getuid()].includes(stat.uid)) fail('JOURNAL_PERMISSIONS');
  // A root-owned sticky temporary directory is safe above an owner-only directory.
  if ((stat.mode & 0o022) && !(stat.uid === 0 && (stat.mode & 0o1000))) fail('JOURNAL_PERMISSIONS');
}

function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function walkDirectory(path, create, aliases = true) {
  const root = parse(path).root;
  let current = root;
  checkAncestor(lstatSync(root));
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    const next = join(current, part);
    let stat = maybeStat(next);
    if (!stat) {
      if (!create) fail('JOURNAL_PERMISSIONS');
      try { mkdirSync(next, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      stat = lstatSync(next);
      syncDirectory(current);
    }
    if (stat.isSymbolicLink()) {
      // System-owned root aliases (including macOS /Users) are not user links.
      if (!aliases || current !== root || stat.uid !== 0) fail('JOURNAL_PERMISSIONS');
      current = walkDirectory(realpathSync(next), false, false).path;
    } else {
      checkAncestor(stat);
      current = next;
    }
  }
  return { path: current, stat: lstatSync(current) };
}

function privateDirectory(path, create) {
  const directory = walkDirectory(path, create);
  if (directory.stat.uid !== process.getuid() || (directory.stat.mode & 0o077)) fail('JOURNAL_PERMISSIONS');
  return directory;
}

function sameFile(left, right) { return left.dev === right.dev && left.ino === right.ino; }

const digestColumn = name => `${name} TEXT NOT NULL CHECK(length(${name})=64 AND ${name} NOT GLOB '*[^0-9a-f]*')`;
const idCheck = name => `length(${name}) BETWEEN 1 AND 128 AND ${name} NOT GLOB '*[^A-Za-z0-9_.-]*' AND instr(${name},'..')=0`;
const idColumn = name => `${name} TEXT NOT NULL CHECK(${idCheck(name)})`;
const stateList = STATES.map(state => `'${state}'`).join(',');
const metadataColumns = `
  state TEXT NOT NULL CHECK(state IN (${stateList})),
  owner TEXT CHECK(owner IS NULL OR (${idCheck('owner')})),
  fingerprint TEXT CHECK(fingerprint IS NULL OR length(fingerprint)<=200),
  result_digest TEXT CHECK(result_digest IS NULL OR (length(result_digest)=64 AND result_digest NOT GLOB '*[^0-9a-f]*')),
  report_state TEXT NOT NULL CHECK(report_state IN ('not_reported','confirmed','uncertain')),
  error_code TEXT CHECK(error_code IS NULL OR (${idCheck('error_code')}))`;
const SCHEMA = new Map([
  ['operations', `CREATE TABLE operations (
  ${digestColumn('scope')}, ${idColumn('operation_id')},
  ${digestColumn('input_digest')}, ${digestColumn('context_digest')}, ${digestColumn('binding_digest')},
  ${idColumn('action_id')}, ${idColumn('session_id')}, ${idColumn('tool_use_id')},
  ${metadataColumns},
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
  PRIMARY KEY(scope,operation_id),
  CHECK((state IN ('prepared','held') AND owner IS NULL) OR (state NOT IN ('prepared','held') AND owner IS NOT NULL))
) STRICT`],
  ['evidence', `CREATE TABLE evidence (
  id INTEGER PRIMARY KEY,
  ${digestColumn('scope')}, ${idColumn('operation_id')},
  kind TEXT NOT NULL CHECK(kind IN ('prepare','claim','settle','recover_held')),
  from_state TEXT CHECK(from_state IS NULL OR from_state IN (${stateList})),
  previous_owner TEXT CHECK(previous_owner IS NULL OR (${idCheck('previous_owner')})),
  ${metadataColumns},
  at INTEGER NOT NULL CHECK(at>=0),
  FOREIGN KEY(scope,operation_id) REFERENCES operations(scope,operation_id)
) STRICT`],
  ['evidence_operation', 'CREATE INDEX evidence_operation ON evidence(scope,operation_id,id)'],
]);

export class OperationJournal {
  #db = null;
  #path;
  #file;
  #directory;
  #maxOperations;
  #busyTimeoutMs;

  constructor(path, options = {}) {
    let fd;
    try {
      const config = dataObject(options, ['maxOperations', 'busyTimeoutMs', 'create'], 'JOURNAL_CONFIG');
      const create = config.create === undefined ? true : config.create;
      this.#maxOperations = config.maxOperations === undefined ? 10000 : config.maxOperations;
      this.#busyTimeoutMs = config.busyTimeoutMs === undefined ? 100 : config.busyTimeoutMs;
      if (typeof create !== 'boolean' || !Number.isSafeInteger(this.#maxOperations) || this.#maxOperations < 1
        || !Number.isSafeInteger(this.#busyTimeoutMs) || this.#busyTimeoutMs < 0 || this.#busyTimeoutMs > 5000) fail('JOURNAL_CONFIG');
      if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || path.includes('\0')
        || path.includes('?') || path.endsWith(sep) || path.split(sep).some(part => part === '..' || part === '.')) fail('JOURNAL_PATH');
      if (typeof process.getuid !== 'function') fail('JOURNAL_PERMISSIONS');
      if (!create && !maybeStat(path)) fail('JOURNAL_MISSING');
      this.#directory = privateDirectory(dirname(path), create);
      this.#path = join(this.#directory.path, basename(path));
      this.#checkFiles();
      // Closing a non-SQLite fd for an existing DB releases this process's POSIX locks.
      // Exclusively precreate new files only, and close before SQLite opens them.
      if (!maybeStat(this.#path)) {
        if (!create) fail('JOURNAL_MISSING');
        try {
          fd = openSync(this.#path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
        } catch (error) { if (error.code !== 'EEXIST') throw error; }
        if (fd !== undefined) {
          this.#file = fstatSync(fd);
          checkFile(this.#file);
          this.#checkFiles();
          closeSync(fd);
          fd = undefined;
        }
      }
      this.#file ??= lstatSync(this.#path);
      checkFile(this.#file);
      this.#checkFiles();
      if (!create && this.#file.size === 0) fail('JOURNAL_SCHEMA');
      syncDirectory(this.#directory.path);
      this.#db = new DatabaseSync(this.#path, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false });
      this.#checkFiles();
      this.#db.exec(`PRAGMA busy_timeout=${this.#busyTimeoutMs}; PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;`);
      // Reopening must not turn an uninitialized or truncated file into a journal.
      if (!create && (this.#db.prepare('PRAGMA user_version').get().user_version !== VERSION
        || this.#db.prepare('PRAGMA application_id').get().application_id !== APPLICATION_ID)) fail('JOURNAL_SCHEMA');
      this.#startup(() => {
        if (this.#db.prepare('PRAGMA journal_mode=WAL').get().journal_mode !== 'wal') fail('JOURNAL_UNAVAILABLE');
      });
      this.#db.exec('PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=64; PRAGMA journal_size_limit=1048576;');
      const pageSize = this.#db.prepare('PRAGMA page_size').get().page_size;
      const maxPages = Math.floor(MAX_DATABASE_BYTES / pageSize);
      if (this.#db.prepare(`PRAGMA max_page_count=${maxPages}`).get().max_page_count > maxPages) fail('JOURNAL_CAPACITY');
      this.#transaction(() => this.#schema(create), true);
      this.#checkFiles();
    } catch (error) {
      try { this.#db?.close(); } catch { /* Never expose storage causes or paths. */ }
      this.#db = null;
      throw sanitize(error);
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* Cleanup must not leak an unsanitized error. */ }
      }
    }
  }

  #checkFiles() {
    const current = privateDirectory(this.#directory.path, false);
    if (!sameFile(current.stat, this.#directory.stat)) fail('JOURNAL_PERMISSIONS');
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const stat = maybeStat(`${this.#path}${suffix}`);
      if (stat) {
        checkFile(stat);
        if (!suffix && this.#file && !sameFile(stat, this.#file)) fail('JOURNAL_PERMISSIONS');
      } else if (!suffix && this.#file) fail('JOURNAL_PERMISSIONS');
    }
  }

  #run(fn) {
    try {
      if (!this.#db) fail('JOURNAL_CLOSED');
      this.#checkFiles();
      return fn();
    } catch (error) { throw sanitize(error); }
  }

  #startup(fn) {
    const deadline = performance.now() + this.#busyTimeoutMs;
    try {
      for (;;) {
        this.#db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.ceil(deadline - performance.now()))};`);
        try { return fn(); }
        catch (error) {
          const remaining = deadline - performance.now();
          if (sanitize(error).code !== 'JOURNAL_BUSY' || remaining <= 0) throw error;
          Atomics.wait(WAIT, 0, 0, Math.min(5, remaining));
        }
      }
    } finally {
      this.#db.exec(`PRAGMA busy_timeout=${this.#busyTimeoutMs};`);
    }
  }

  #transaction(fn, startup = false) {
    // Retry only startup lock acquisition. Never replay an operation or its evidence.
    if (startup) this.#startup(() => this.#db.exec('BEGIN IMMEDIATE'));
    else this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#checkFiles();
      if (lstatSync(this.#path).size > MAX_DATABASE_BYTES
        || (maybeStat(`${this.#path}-wal`)?.size ?? 0) > MAX_WAL_BYTES) fail('JOURNAL_CAPACITY');
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* Preserve the original sanitized failure. */ }
      throw error;
    }
  }

  #schema(create) {
    const version = this.#db.prepare('PRAGMA user_version').get().user_version;
    const application = this.#db.prepare('PRAGMA application_id').get().application_id;
    const objects = () => this.#db.prepare("SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
    if (version === 0 && application === 0 && objects().length === 0) {
      if (!create) fail('JOURNAL_SCHEMA');
      for (const sql of SCHEMA.values()) this.#db.exec(sql);
      this.#db.exec(`PRAGMA user_version=${VERSION}; PRAGMA application_id=${APPLICATION_ID};`);
    } else if (version !== VERSION || application !== APPLICATION_ID) fail('JOURNAL_SCHEMA');
    const actual = objects();
    if (actual.length !== SCHEMA.size || actual.some(row => SCHEMA.get(row.name) !== row.sql)) fail('JOURNAL_SCHEMA');
    const check = this.#db.prepare('PRAGMA quick_check').all();
    if (check.length !== 1 || check[0].quick_check !== 'ok') fail('JOURNAL_CORRUPT');
  }

  #read(scope, operationId) {
    return this.#db.prepare('SELECT * FROM operations WHERE scope=? AND operation_id=?').get(scope, operationId);
  }

  #row(row) {
    if (!row) return null;
    return Object.freeze({
      ...Object.fromEntries(Object.entries(FIELDS).map(([field, column]) => [field, row[column]])),
      state: row.state, owner: row.owner, fingerprint: row.fingerprint, resultDigest: row.result_digest,
      reportState: row.report_state, errorCode: row.error_code, createdAt: row.created_at, updatedAt: row.updated_at,
    });
  }

  #event(kind, before, after) {
    this.#db.prepare(`INSERT INTO evidence(scope,operation_id,kind,from_state,previous_owner,
      state,owner,fingerprint,result_digest,report_state,error_code,at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(after.scope, after.operation_id, kind, before?.state ?? null, before?.owner ?? null,
        after.state, after.owner, after.fingerprint, after.result_digest, after.report_state, after.error_code, after.updated_at);
  }

  prepare(record) {
    return this.#run(() => {
      const value = validateRecord(record);
      return this.#transaction(() => {
        const prior = this.#read(value.scope, value.operationId);
        if (prior) {
          if (Object.entries(FIELDS).some(([field, column]) => value[field] !== prior[column])) fail('CONFLICT');
          return this.#row(prior);
        }
        if (this.#db.prepare('SELECT count(*) AS n FROM operations').get().n >= this.#maxOperations) fail('JOURNAL_CAPACITY');
        const now = Date.now();
        this.#db.prepare(`INSERT INTO operations(scope,operation_id,input_digest,context_digest,binding_digest,
          action_id,session_id,tool_use_id,state,owner,fingerprint,result_digest,report_state,error_code,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,'prepared',NULL,NULL,NULL,'not_reported',NULL,?,?)`)
          .run(...Object.keys(FIELDS).map(field => value[field]), now, now);
        const after = this.#read(value.scope, value.operationId);
        this.#event('prepare', null, after);
        return this.#row(after);
      });
    });
  }

  get(scope, operationId) {
    return this.#run(() => {
      identity(scope, operationId);
      return this.#row(this.#read(scope, operationId));
    });
  }

  claim(scope, operationId, fromStates, nextState, owner) {
    return this.#run(() => {
      identity(scope, operationId);
      if (!isId(owner)) fail('JOURNAL_RECORD');
      if (isProxy(fromStates) || !Array.isArray(fromStates) || fromStates.length !== 1) fail('JOURNAL_TRANSITION');
      const descriptor = Object.getOwnPropertyDescriptor(fromStates, '0');
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('JOURNAL_TRANSITION');
      const fromState = descriptor.value;
      if (!((fromState === 'prepared' && nextState === 'requesting')
        || (fromState === 'held' && nextState === 'redeeming'))) fail('JOURNAL_TRANSITION');
      return this.#transaction(() => {
        const before = this.#read(scope, operationId);
        if (!before || before.state !== fromState || before.owner !== null) return false;
        const changed = this.#db.prepare(`UPDATE operations SET state=?,owner=?,updated_at=?
          WHERE scope=? AND operation_id=? AND state=? AND owner IS NULL`)
          .run(nextState, owner, Math.max(Date.now(), before.updated_at), scope, operationId, fromState).changes;
        if (changed !== 1) return false;
        this.#event('claim', before, this.#read(scope, operationId));
        return true;
      });
    });
  }

  settle(scope, operationId, owner, fromState, nextState, patch = {}) {
    return this.#run(() => {
      identity(scope, operationId);
      if (!isId(owner)) fail('JOURNAL_RECORD');
      const reporting = fromState === nextState && ['completed', 'uncertain'].includes(fromState);
      if (!reporting && !SETTLEMENTS.get(fromState)?.includes(nextState)) fail('JOURNAL_TRANSITION');
      const value = validatePatch(patch, reporting);
      return this.#transaction(() => {
        const before = this.#read(scope, operationId);
        if (!before || before.state !== fromState || before.owner !== owner) return false;
        const metadata = { fingerprint: before.fingerprint, resultDigest: before.result_digest,
          reportState: before.report_state, errorCode: before.error_code, ...value };
        const changed = this.#db.prepare(`UPDATE operations SET state=?,owner=?,fingerprint=?,result_digest=?,
          report_state=?,error_code=?,updated_at=? WHERE scope=? AND operation_id=? AND state=? AND owner=?`)
          .run(nextState, nextState === 'held' ? null : owner, metadata.fingerprint, metadata.resultDigest,
            metadata.reportState, metadata.errorCode, Math.max(Date.now(), before.updated_at),
            scope, operationId, fromState, owner).changes;
        if (changed !== 1) return false;
        this.#event('settle', before, this.#read(scope, operationId));
        return true;
      });
    });
  }

  recoverHeld(scope, operationId, fingerprint) {
    // The caller must independently prove that this exact server action is still pending.
    return this.#run(() => {
      identity(scope, operationId);
      const patch = validatePatch(fingerprint === undefined ? {} : { fingerprint });
      return this.#transaction(() => {
        const before = this.#read(scope, operationId);
        if (!before || !['requesting', 'uncertain_request'].includes(before.state)) return false;
        const nextFingerprint = Object.hasOwn(patch, 'fingerprint') ? patch.fingerprint : before.fingerprint;
        if (before.fingerprint !== null && nextFingerprint !== before.fingerprint) fail('CONFLICT');
        const changed = this.#db.prepare(`UPDATE operations SET state='held',owner=NULL,fingerprint=?,updated_at=?
          WHERE scope=? AND operation_id=? AND state IN ('requesting','uncertain_request')`)
          .run(nextFingerprint, Math.max(Date.now(), before.updated_at), scope, operationId).changes;
        if (changed !== 1) return false;
        this.#event('recover_held', before, this.#read(scope, operationId));
        return true;
      });
    });
  }

  close() {
    if (!this.#db) return;
    try { this.#db.close(); }
    catch (error) { throw sanitize(error); }
    finally { this.#db = null; }
  }
}
