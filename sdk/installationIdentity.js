import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { prepareCredentialFile, readCredentialFile, removeCredentialFile, writeCredentialFile } from './credentials.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PREFIX = { codex: 'codex-runtime', claude: 'claude-code-runtime', cursor: 'cursor-runtime', mcp: 'mcp-runtime', sdk: 'sdk-runtime' };
export const SDK_ENV_PATH = '.osuite/.env';
export const MCP_ENV_PATH = '.osuite/mcp/.env';
export const MCP_MIGRATION_PATH = '.osuite/.env.migrate-mcp.json';
const BUNDLE_FILES = { env: '', identity: '.identity.json', journal: '.connect.json' };

export function parseInstallationIdentity(raw, runtime) {
  if (raw === null) return null;
  let identity;
  try { identity = JSON.parse(raw); } catch { throw new Error('Invalid installation identity file; it was left unchanged.'); }
  if (identity?.schema_version !== 'osuite.installation.v1' || identity.runtime !== runtime
    || typeof identity.installation_id !== 'string' || !UUID.test(identity.installation_id)
    || typeof identity.agent_id !== 'string' || !identity.agent_id.startsWith(`${PREFIX[runtime]}-`)
    || !UUID.test(identity.agent_id.slice(PREFIX[runtime].length + 1))) {
    throw new Error('Installation identity does not match this runtime; it was left unchanged.');
  }
  return identity;
}

export function readInstallationIdentity(projectRoot, envPath, runtime) {
  if (!Object.hasOwn(PREFIX, runtime)) throw new Error('Unsupported installation runtime.');
  return parseInstallationIdentity(readCredentialFile(projectRoot, `${envPath}.identity.json`), runtime);
}

// A project/runtime installation identifier is metadata, not a human identity or
// hardware attestation. Rotation still requires the current scoped credential.
export function getInstallationIdentity(projectRoot, envPath, runtime, { dryRun = false } = {}) {
  if (!Object.hasOwn(PREFIX, runtime)) throw new Error('Unsupported installation runtime.');
  const relativePath = `${envPath}.identity.json`;
  // A preview must also work before Git is installed and must not inspect or
  // repair private credential files. Its temporary IDs are never enrolled.
  const existing = dryRun ? null : readInstallationIdentity(projectRoot, envPath, runtime);
  if (existing) return existing;
  const identity = { schema_version: 'osuite.installation.v1', runtime,
    installation_id: crypto.randomUUID(), agent_id: `${PREFIX[runtime]}-${crypto.randomUUID()}` };
  if (!dryRun) writeCredentialFile(projectRoot, relativePath, `${JSON.stringify(identity)}\n`);
  return identity;
}

export function credentialDigest(raw) {
  return raw === null ? null : crypto.createHash('sha256').update(raw).digest('hex');
}

export function readInstallationBundle(projectRoot, envPath) {
  return Object.fromEntries(Object.entries(BUNDLE_FILES).map(([kind, suffix]) => [kind, readCredentialFile(projectRoot, `${envPath}${suffix}`)]));
}

export function readMcpMigration(projectRoot) {
  const raw = readCredentialFile(projectRoot, MCP_MIGRATION_PATH);
  const source = readInstallationBundle(projectRoot, SDK_ENV_PATH);
  const destination = readInstallationBundle(projectRoot, MCP_ENV_PATH);
  if (raw === null) return { manifest: null, source, destination, bundle: source };
  let manifest;
  try { manifest = JSON.parse(raw); } catch { throw new Error('Invalid MCP migration marker; files were left unchanged.'); }
  if (manifest?.schema_version !== 'osuite.mcp-migration.v1' || !manifest.files
    || Object.keys(manifest.files).sort().join(',') !== Object.keys(BUNDLE_FILES).sort().join(',')
    || Object.values(manifest.files).some(value => value !== null && (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)))) {
    throw new Error('Invalid MCP migration marker; files were left unchanged.');
  }
  const bundle = {};
  for (const kind of Object.keys(BUNDLE_FILES)) {
    const expected = manifest.files[kind];
    const bodies = [source[kind], destination[kind]].filter(body => body !== null);
    if (expected === null ? bodies.length !== 0 : bodies.length !== 1 || credentialDigest(bodies[0]) !== expected) {
      throw new Error('MCP migration conflicts with changed, missing or duplicated files; nothing was overwritten.');
    }
    bundle[kind] = bodies[0] ?? null;
  }
  return { manifest, source, destination, bundle };
}

function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// Explicit, local-only migration. The caller must hold BOTH credential locks and
// validate runtime/recovery scope first. A durable, secret-free marker blocks
// either CLI enrollment lane until every original file has moved, never copied
// or overwritten. Existing server identity and keys are not changed by the move.
export function migrateMcpInstallation(projectRoot, inspected) {
  let current = readMcpMigration(projectRoot);
  if (JSON.stringify(current) !== JSON.stringify(inspected)) throw new Error('MCP migration files changed during validation; retry after inspection.');
  if (!current.manifest) {
    if (Object.values(current.destination).some(body => body !== null)) throw new Error('MCP migration destination is already occupied; nothing was overwritten.');
    for (const [kind, suffix] of Object.entries(BUNDLE_FILES)) {
      if (current.source[kind] !== null) prepareCredentialFile(projectRoot, `${MCP_ENV_PATH}${suffix}`);
    }
    writeCredentialFile(projectRoot, MCP_MIGRATION_PATH, `${JSON.stringify({ schema_version: 'osuite.mcp-migration.v1',
      files: Object.fromEntries(Object.entries(current.source).map(([kind, body]) => [kind, credentialDigest(body)])) })}\n`);
  }
  for (const [kind, suffix] of Object.entries(BUNDLE_FILES)) {
    current = readMcpMigration(projectRoot);
    if (current.source[kind] === null) continue;
    const from = prepareCredentialFile(projectRoot, `${SDK_ENV_PATH}${suffix}`);
    const to = prepareCredentialFile(projectRoot, `${MCP_ENV_PATH}${suffix}`);
    if (to.stat || credentialDigest(readCredentialFile(projectRoot, `${SDK_ENV_PATH}${suffix}`)) !== current.manifest.files[kind]) {
      throw new Error('MCP migration destination or source changed; resume only after inspection.');
    }
    fs.renameSync(from.absolute, to.absolute);
    syncDirectory(path.dirname(to.absolute));
    syncDirectory(path.dirname(from.absolute));
  }
  readMcpMigration(projectRoot);
  removeCredentialFile(projectRoot, MCP_MIGRATION_PATH);
}
