import { createPrivateKey } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import { inspectCredentialFile, readCredentialFile } from './credentials.js';
import { MCP_ENV_PATH, MCP_MIGRATION_PATH, SDK_ENV_PATH, parseInstallationIdentity } from './installationIdentity.js';
import { loadRuntimeConfig } from './runtime/config.mjs';
import { createApiClient, safeId, validatedBaseUrl } from './runtime/protocol.mjs';
import { resolveRemotePosture } from './runtime/posture.mjs';

function fail(code) { throw Object.assign(new Error(code), { code }); }
function parse(raw) {
  if (Buffer.byteLength(raw) > 65536) fail('INVALID_CREDENTIAL_FILE');
  const env = Object.create(null);
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = line.match(/^\s*(?:export\s+)?((?:OSUITE|DASHCLAW)_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match || Object.hasOwn(env, match[1])) fail('INVALID_CREDENTIAL_FILE');
    let value = match[2];
    if (/^['"]/.test(value)) {
      const quoted = value.match(/^(['"])(.*?)\1(?:\s+#.*)?$/);
      if (!quoted) fail('INVALID_CREDENTIAL_FILE');
      value = quoted[2];
    } else value = value.replace(/\s+#.*$/, '');
    env[match[1]] = value;
  }
  return env;
}

export function loadNativeDoctorConfig({ projectRoot = process.cwd(), runtime, shellEnv = process.env }) {
  if (!['sdk', 'mcp'].includes(runtime)) fail('INVALID_RUNTIME_OPTIONS');
  const envPath = runtime === 'mcp' ? MCP_ENV_PATH : SDK_ENV_PATH;
  try {
    const files = [envPath, `${envPath}.identity.json`, `${envPath}.connect.json`, `${envPath}.connect.lock`, MCP_MIGRATION_PATH];
    const checks = files.map(file => inspectCredentialFile(projectRoot, file));
    if (checks.some(check => !check.safe)) fail('UNSAFE_CREDENTIALS');
    if (checks.some(check => check.exists && /\.connect\.(json|lock)$/.test(check.relativePath))) fail('CONNECTION_RECOVERY_PENDING');
    if (checks.at(-1).exists) fail('MCP_MIGRATION_PENDING');
    if (checks[0].exists && statSync(path.join(projectRoot, envPath)).size > 65536) fail('INVALID_CREDENTIAL_FILE');
    parseInstallationIdentity(readCredentialFile(projectRoot, `${envPath}.identity.json`), runtime);
    const raw = readCredentialFile(projectRoot, envPath);
    // Choose one complete bundle. Never borrow a missing field from another lane.
    const source = raw === null ? shellEnv : parse(raw);
    for (const [name, value] of Object.entries(source)) {
      if (name.startsWith('OSUITE_') && source[name.replace(/^OSUITE_/, 'DASHCLAW_')] !== undefined
        && value !== source[name.replace(/^OSUITE_/, 'DASHCLAW_')]) fail('CREDENTIAL_SOURCE_CONFLICT');
    }
    for (const field of ['AGENT_ID', 'RUNTIME_ADAPTER_ID']) {
      const value = source[`OSUITE_${field}`] ?? source[`DASHCLAW_${field}`];
      if (typeof value !== 'string' || !value.trim()) fail('INVALID_CONFIGURATION');
    }
    if (Object.hasOwn(source, 'OSUITE_ORG_ID') || Object.hasOwn(source, 'DASHCLAW_ORG_ID')) {
      if (!safeId(source.OSUITE_ORG_ID ?? source.DASHCLAW_ORG_ID)) fail('INVALID_CONFIGURATION');
    }
    const config = loadRuntimeConfig({ env: source, host: runtime, runtimeId: runtime });
    if (config.runtimeId !== runtime || !safeId(config.agentId) || !config.apiKey || !validatedBaseUrl(config.baseUrl)
      || config.allowInsecureHttp || config.signatureMode !== 'required' || config.ruleRolloutCapability
      || (config.provider && config.provider !== runtime)) fail('INVALID_CONFIGURATION');
    if (createPrivateKey(Buffer.from(config.privateKeyBase64, 'base64')).asymmetricKeyType !== 'rsa') fail('INVALID_CONFIGURATION');
    return { ...config, provider: runtime };
  } catch (error) {
    if (/^[A-Z][A-Z0-9_]+$/.test(error?.code || '')) throw error;
    fail('INVALID_CONFIGURATION');
  }
}

export async function diagnoseNativeRuntime(options) {
  const config = loadNativeDoctorConfig(options);
  // Diagnostic-only scratch state: no reusable grant/cache is persisted or exposed.
  const values = new Map();
  const store = {
    read: key => values.get(key),
    write: (key, value) => { values.set(key, value); return value; },
    update: (key, fn) => { const value = fn(values.get(key)); values.set(key, value); return value; },
  };
  const remote = await resolveRemotePosture(config, { store, api: createApiClient(config, { maxResponseBytes: 1048576 }) });
  if (!remote.available || remote.blocked || remote.source !== 'remote') fail('CURRENT_POSTURE_UNAVAILABLE');
  if (!['enforce', 'strict'].includes(remote.posture.mode) || !remote.posture.require_signature
    || remote.posture.on_guard_unavailable !== 'block' || remote.posture.require_assumption_capture
    || !['enforce', 'strict'].includes(config.mode) || config.guardFailureMode !== 'block') fail('NATIVE_POSTURE_INCOMPATIBLE');
  const orgId = store.read('posture')?.document?.org_id;
  if (!safeId(orgId)) fail('CURRENT_POSTURE_UNAVAILABLE');
  return { runtime: options.runtime, orgId, ready: true };
}
