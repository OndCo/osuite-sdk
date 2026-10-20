import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const CREDENTIAL_PATHS = ['.codex/.env', '.claude/.env', '.cursor/.env', '.osuite/.env'];
const POSIX = process.platform !== 'win32';
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

function metadata(file) {
  try { return fs.lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function sameFile(a, b) {
  return !a && !b || Boolean(a && b && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs);
}

function owned(stat) {
  return !POSIX || typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

function safePath(projectRoot, relativePath, { create = false } = {}) {
  const root = fs.realpathSync(projectRoot);
  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('Credential path must stay inside the project.');
  }
  let directory = root;
  const parts = relative.split(path.sep).slice(0, -1);
  for (const part of ['', ...parts]) {
    if (part) directory = path.join(directory, part);
    let stat = metadata(directory);
    if (!stat && create) {
      fs.mkdirSync(directory, { mode: 0o700 });
      if (POSIX) fs.chmodSync(directory, 0o700);
      syncDirectory(path.dirname(directory));
      stat = metadata(directory);
    }
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw new Error('Refusing a symlink in the credential path.');
    if (!stat.isDirectory()) throw new Error('Credential parent must be a directory.');
    if (!owned(stat) || POSIX && (stat.mode & 0o022)) throw new Error('Unsafe credential directory ownership or write permissions.');
  }
  const stat = metadata(absolute);
  if (stat?.isSymbolicLink()) throw new Error('Refusing a symlinked credential file.');
  if (stat && (!stat.isFile() || stat.nlink !== 1 || !owned(stat))) {
    throw new Error('Unsafe credential file type, links, or ownership.');
  }
  return { root, absolute, relativePath: relative.split(path.sep).join('/'), stat };
}

function runGit(cwd, args) {
  // Inherited GIT_DIR/INDEX_FILE must not hide a tracked project credential.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  // Metadata inspection must not execute repository-configured fsmonitor commands.
  return spawnSync('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
    encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function repositoryRoots(root, absolute) {
  const roots = new Set();
  let current = root;
  for (const part of ['', ...path.relative(root, path.dirname(absolute)).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    if (!metadata(current)) continue;
    const result = runGit(current, ['rev-parse', '--show-toplevel']);
    if (result.error) throw new Error('Git is required to check whether the credential path is tracked.');
    if (result.status === 0) roots.add(result.stdout.trim());
    else if (!result.stderr.includes('not a git repository')) throw new Error('Unable to verify Git credential protection.');
  }
  return [...roots];
}

function isTracked(root, absolute) {
  return repositoryRoots(root, absolute).some((repository) => {
    // A tracked .ENV aliases .env on common macOS/Windows filesystems.
    const result = runGit(repository, ['ls-files', '--error-unmatch', '--', `:(icase,literal)${path.relative(repository, absolute)}`]);
    if (result.status !== 0 && result.status !== 1) throw new Error('Unable to inspect the Git index for credentials.');
    return result.status === 0;
  });
}

function assertUntracked(target) {
  if (isTracked(target.root, target.absolute)) throw new Error('Refusing to write credentials to a tracked path. Remove it from Git and rotate any exposed credentials first.');
}

function syncDirectory(directory) {
  if (!POSIX) return;
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function atomicWrite(target, body, mode, { credential = false } = {}) {
  const temporary = `${target.absolute}.osuite-tmp-${crypto.randomBytes(12).toString('hex')}`;
  let fd;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, mode);
    if (POSIX) fs.fchmodSync(fd, mode);
    fs.writeFileSync(fd, body, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    const latest = safePath(target.root, target.relativePath);
    if (!sameFile(target.stat, latest.stat)) throw new Error('Credential destination changed during the write; refusing to replace it.');
    if (credential) assertUntracked(latest);
    fs.renameSync(temporary, target.absolute);
    syncDirectory(path.dirname(target.absolute));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function protectIgnore(target) {
  const directory = path.dirname(target.absolute);
  const ignorePath = path.join(path.dirname(target.relativePath), '.gitignore');
  const ignore = safePath(target.root, ignorePath);
  const body = ignore.stat ? fs.readFileSync(ignore.absolute, 'utf8') : '';
  const name = path.basename(target.absolute);
  // A rule in the credential's own directory works in monorepos and nested repos.
  const rules = [`/${name}`, `/${name}.osuite-tmp-*`];
  const missing = rules.filter((rule) => !body.split(/\r?\n/).includes(rule));
  if (missing.length) {
    atomicWrite(ignore, `${body}${body && !body.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`, ignore.stat ? ignore.stat.mode & 0o777 : 0o644);
  }
  if (repositoryRoots(target.root, target.absolute).length) {
    const result = runGit(directory, ['check-ignore', '--no-index', '--', target.absolute]);
    if (result.status !== 0) throw new Error('Credential path is not ignored by Git; check conflicting ignore rules.');
  }
}

export function inspectCredentialFile(projectRoot, relativePath) {
  const result = { relativePath, exists: false, safe: false, problems: [], mode: null };
  try {
    const target = safePath(projectRoot, relativePath);
    result.exists = Boolean(target.stat);
    if (target.stat) {
      result.mode = POSIX ? `0${(target.stat.mode & 0o777).toString(8).padStart(3, '0')}` : null;
      if (POSIX && (target.stat.mode & 0o777) !== 0o600) result.problems.push(`unsafe mode ${result.mode}; expected 0600`);
    }
    if (isTracked(target.root, target.absolute)) result.problems.push('tracked by Git');
    if (target.stat) {
      const roots = repositoryRoots(target.root, target.absolute);
      if (roots.length && runGit(path.dirname(target.absolute), ['check-ignore', '--no-index', '--', target.absolute]).status !== 0) result.problems.push('not ignored by Git');
    }
    result.safe = result.problems.length === 0;
  } catch (error) {
    result.exists = true;
    result.problems.push(error.message);
  }
  return result;
}

export function prepareCredentialFile(projectRoot, relativePath) {
  let target = safePath(projectRoot, relativePath);
  assertUntracked(target);
  target = safePath(projectRoot, relativePath, { create: true });
  protectIgnore(target);
  return target;
}

export function writeCredentialFile(projectRoot, relativePath, body) {
  const target = prepareCredentialFile(projectRoot, relativePath);
  atomicWrite(target, String(body), 0o600, { credential: true });
  return { relativePath: target.relativePath, status: 'written' };
}

export function readCredentialFile(projectRoot, relativePath) {
  const inspection = inspectCredentialFile(projectRoot, relativePath);
  if (!inspection.exists) return null;
  if (!inspection.safe) throw new Error(`Unsafe credential file: ${relativePath} (${inspection.problems.join('; ')}).`);
  const target = safePath(projectRoot, relativePath);
  const fd = fs.openSync(target.absolute, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    if (!sameFile(target.stat, fs.fstatSync(fd))) throw new Error('Credential changed before reading.');
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}

export function removeCredentialFile(projectRoot, relativePath) {
  const target = safePath(projectRoot, relativePath);
  assertUntracked(target);
  if (!target.stat) return;
  fs.unlinkSync(target.absolute);
  syncDirectory(path.dirname(target.absolute));
}

export function acquireCredentialLock(projectRoot, relativePath) {
  prepareCredentialFile(projectRoot, relativePath);
  const lockPath = `${relativePath}.connect.lock`;
  let target = prepareCredentialFile(projectRoot, lockPath);
  if (target.stat) {
    let lock;
    try { lock = JSON.parse(readCredentialFile(projectRoot, lockPath)); } catch {
      throw new Error('Unsafe or unreadable credential lock; inspect its metadata before reconnecting.');
    }
    if (!Number.isSafeInteger(lock?.pid) || lock.pid < 1) throw new Error('Invalid credential lock.');
    let running = true;
    try { process.kill(lock.pid, 0); } catch (error) { if (error.code === 'ESRCH') running = false; }
    if (running) throw new Error('Another connect process owns this credential file. Wait for it to finish.');
    const latest = safePath(projectRoot, lockPath);
    if (!sameFile(target.stat, latest.stat)) throw new Error('Credential lock changed during recovery.');
    removeCredentialFile(projectRoot, lockPath);
    target = prepareCredentialFile(projectRoot, lockPath);
  }
  let fd;
  let lockStat;
  try {
    fd = fs.openSync(target.absolute, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
    if (POSIX) fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid })}\n`, 'utf8');
    fs.fsyncSync(fd);
    lockStat = fs.fstatSync(fd);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another connect process owns this credential file.');
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  syncDirectory(path.dirname(target.absolute));
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener('exit', release);
    const latest = safePath(projectRoot, lockPath);
    if (sameFile(lockStat, latest.stat)) removeCredentialFile(projectRoot, lockPath);
  };
  process.once('exit', release);
  return release;
}
