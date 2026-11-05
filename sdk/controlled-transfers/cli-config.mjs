import { statSync } from 'node:fs';
import path from 'node:path';
import { inspectCredentialFile, readCredentialFile } from '../credentials.js';
import { MCP_ENV_PATH, MCP_MIGRATION_PATH, SDK_ENV_PATH, parseInstallationIdentity } from '../installationIdentity.js';
import { loadRuntimeConfig } from '../runtime/config.mjs';
import { configuration, ControlledTransferError, fail } from './contract.mjs';

const fields = ['BASE_URL', 'API_KEY', 'PRIVATE_KEY_BASE64', 'AGENT_ID', 'ORG_ID', 'AGENT_KEY_ID',
  'RUNTIME_ADAPTER_ID', 'SIGNATURE_MODE', 'GUARD_FAILURE_MODE', 'HOOK_MODE', 'ALLOW_INSECURE_HTTP',
  'MATOI_ISSUER_PUBLIC_KEY_BASE64', 'MATOI_TRUSTED_ISSUER_PUBLIC_KEYS_B64', 'MATOI_TIMEOUT_MS'];

function parseEnvironment(raw) {
  if (Buffer.byteLength(raw) > 65536) fail('INVALID_CREDENTIAL_FILE');
  const env = Object.create(null);
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = line.match(/^\s*(?:export\s+)?((?:OSUITE|DASHCLAW)_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) fail('INVALID_CREDENTIAL_FILE');
    if (Object.hasOwn(env, match[1])) fail('INVALID_CREDENTIAL_FILE');
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

function selectedEnvironment(env) {
  const result = Object.create(null);
  for (const field of fields) {
    const primary = env[`OSUITE_${field}`], legacy = env[`DASHCLAW_${field}`];
    if (primary !== undefined && legacy !== undefined && primary !== legacy) fail('CREDENTIAL_SOURCE_CONFLICT');
    if (primary !== undefined || legacy !== undefined) result[`OSUITE_${field}`] = primary ?? legacy;
  }
  return result;
}

export function loadControlledTransferCliConfig({ projectRoot = process.cwd(), shellEnv = process.env, runtime = 'sdk' } = {}) {
  if (Number(process.versions.node.split('.')[0]) !== 24) fail('NODE_24_REQUIRED');
  if (!['sdk', 'mcp'].includes(runtime)) fail('INVALID_CONTROLLED_TRANSFER_OPTIONS');
  const envPath = runtime === 'mcp' ? MCP_ENV_PATH : SDK_ENV_PATH;
  let raw;
  try {
    const checks = [envPath, `${envPath}.identity.json`, `${envPath}.connect.json`, `${envPath}.connect.lock`, MCP_MIGRATION_PATH]
      .map(file => inspectCredentialFile(projectRoot, file));
    if (checks.some(check => !check.safe)) fail('UNSAFE_CREDENTIALS');
    if (checks.find(check => check.relativePath === MCP_MIGRATION_PATH)?.exists) fail('MCP_MIGRATION_PENDING');
    if (checks.some(check => check.exists && /\.connect\.(json|lock)$/.test(check.relativePath))) fail('CONNECTION_RECOVERY_PENDING');
    if (checks[0].exists && statSync(path.join(projectRoot, envPath)).size > 65536) fail('INVALID_CREDENTIAL_FILE');
    raw = readCredentialFile(projectRoot, envPath);
    parseInstallationIdentity(readCredentialFile(projectRoot, `${envPath}.identity.json`), runtime);
  } catch (error) {
    if (error instanceof ControlledTransferError) throw error;
    fail('UNSAFE_CREDENTIALS');
  }
  const shell = selectedEnvironment(shellEnv);
  const source = raw === null ? shell : selectedEnvironment(parseEnvironment(raw));
  if (raw !== null && Object.entries(shell).some(([key, value]) => source[key] !== value)) fail('CREDENTIAL_SOURCE_CONFLICT');
  // Never fill a partial credential/identity bundle from another file or from the shell.
  if (['BASE_URL', 'API_KEY', 'PRIVATE_KEY_BASE64', 'AGENT_ID', 'ORG_ID'].some(key => !source[`OSUITE_${key}`])
    || source.OSUITE_SIGNATURE_MODE !== 'required' || source.OSUITE_GUARD_FAILURE_MODE !== 'block'
    || (source.OSUITE_HOOK_MODE !== undefined && !['enforce', 'strict'].includes(source.OSUITE_HOOK_MODE))
    || (source.OSUITE_ALLOW_INSECURE_HTTP !== undefined && source.OSUITE_ALLOW_INSECURE_HTTP !== '0')
    || !(runtime === 'mcp' ? ['mcp'] : ['sdk', 'framework_sdk', 'inline_sdk']).includes(source.OSUITE_RUNTIME_ADAPTER_ID)) {
    fail('INVALID_CONFIGURATION');
  }
  const configured = loadRuntimeConfig({ env: source, host: runtime, runtimeId: source.OSUITE_RUNTIME_ADAPTER_ID });
  const pin = source.OSUITE_MATOI_ISSUER_PUBLIC_KEY_BASE64;
  if (pin !== undefined && !/^[A-Za-z0-9+/]+={0,2}$/.test(pin)) fail('INVALID_CONFIGURATION');
  const timeout = source.OSUITE_MATOI_TIMEOUT_MS;
  if (timeout !== undefined && !/^[1-9][0-9]{0,4}$/.test(timeout)) fail('INVALID_CONFIGURATION');
  const history = source.OSUITE_MATOI_TRUSTED_ISSUER_PUBLIC_KEYS_B64;
  let trustedIssuerPublicKeys = [];
  if (history !== undefined) {
    try {
      if (history.length > 32768 || !/^[A-Za-z0-9+/]+={0,2}$/.test(history)) throw new Error();
      const bytes = Buffer.from(history, 'base64');
      if (bytes.toString('base64') !== history) throw new Error();
      trustedIssuerPublicKeys = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch { fail('INVALID_CONFIGURATION'); }
  }
  return configuration({ config: { ...configured, keyId: source.OSUITE_AGENT_KEY_ID,
    issuerPublicKey: pin === undefined ? null : Buffer.from(pin, 'base64').toString('utf8'),
    trustedIssuerPublicKeys,
    timeoutMs: timeout === undefined ? 2500 : Number(timeout) } });
}
