import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256 } from './protocol.mjs';

const MAX_STATE_BYTES = 2 * 1024 * 1024;

function checkedFile(filename) {
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe runtime state file');
    return stat;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function createStateStore(config) {
  const root = path.resolve(config.stateDir || path.join(os.tmpdir(), `osuite-node-${process.getuid?.() ?? 'user'}`));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Unsafe runtime state directory');
  if (process.getuid && (rootStat.uid !== process.getuid() || (rootStat.mode & 0o022))) {
    throw new Error('Runtime state directory is not owner-controlled');
  }
  const scope = sha256(canonicalJson({
    base_url: config.baseUrl || '', credential: sha256(config.apiKey || ''),
    agent_id: config.agentId || '', runtime_id: config.runtimeId || '', provider: config.provider || '',
  }));
  const filename = name => path.join(root, `osuite_${scope.slice(0, 24)}_${sha256(name)}.json`);
  const store = {
    path: filename,
    read(name) {
      const file = filename(name);
      if (!checkedFile(file)) return null;
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | fs.constants.O_NONBLOCK);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_STATE_BYTES) throw new Error('Invalid runtime state file');
        return JSON.parse(fs.readFileSync(fd, 'utf8'));
      } finally { fs.closeSync(fd); }
    },
    write(name, value) {
      const file = filename(name);
      checkedFile(file);
      const bytes = JSON.stringify(value);
      if (Buffer.byteLength(bytes) > MAX_STATE_BYTES) throw new Error('Runtime state too large');
      const pending = path.join(root, `.osuite_pending_${randomUUID()}`);
      let fd;
      try {
        fd = fs.openSync(pending, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        checkedFile(file);
        fs.renameSync(pending, file);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(pending); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    },
    remove(name) {
      const file = filename(name);
      if (checkedFile(file)) fs.unlinkSync(file);
    },
    update(name, transform) {
      const lock = `${filename(name)}.lock`;
      try { fs.mkdirSync(lock, { mode: 0o700 }); } catch (error) {
        if (error.code === 'EEXIST') throw new Error('Runtime state is busy');
        throw error;
      }
      try {
        const next = transform(store.read(name));
        store.write(name, next);
        return next;
      } finally { fs.rmdirSync(lock); }
    },
  };
  return store;
}
