#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { OSuite, buildReviewSurface } from './osuite.js';
import { runTryFlow } from './tryFlow.js';
import { runDoctorWithMeasurement } from './activationMetrics.js';
import {
  credentialDigest, getInstallationIdentity, migrateMcpInstallation, parseInstallationIdentity,
  readInstallationBundle, readInstallationIdentity, readMcpMigration,
  MCP_ENV_PATH, MCP_MIGRATION_PATH, SDK_ENV_PATH,
} from './installationIdentity.js';
import {
  CREDENTIAL_PATHS, acquireCredentialLock, inspectCredentialFile,
  readCredentialFile, removeCredentialFile, writeCredentialFile,
} from './credentials.js';
import {
  buildNodeRuntimeBootstrap,
  describeInstallResult,
  findHookInstallations,
  installBlockers,
  installProjectFile,
  resolveProjectPath,
  runHookCheck,
} from './projectHooks.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

const PROTECTED_REFS = new Set(['main', 'master', 'prod', 'production', 'stable']);
const OBSERVE_OPS = new Set(['get', 'describe', 'logs', 'top', 'version', 'diff']);
const PLAN_OPS = new Set(['plan', 'show', 'validate', 'output', 'fmt', 'providers', 'graph']);
const MUTATION_OPS = new Set(['apply', 'destroy', 'delete', 'create', 'replace', 'taint', 'untaint', 'import', 'upgrade', 'rollback', 'install', 'uninstall']);
const GIT_OBSERVATION_RISKS = {
  status: 10,
  log: 10,
  branch: 10,
  show: 12,
  remote: 14,
  diff: 18,
};
const PUBLIC_FILE_HOST_HINTS = ['transfer.sh', 'file.io', 'tmpfiles.org', '0x0.st', 'ufile.io', 'gofile.io', 'wetransfer.com'];
const SECURITY_CONTROL_WEAKENING_RE = /(\bspctl\b[\s\S]*(--master-disable|--global-disable|--disable)|\bcsrutil\b[\s\S]*\bdisable\b|Set-MpPreference[\s\S]*Disable(?:RealtimeMonitoring|BehaviorMonitoring|IOAVProtection)[\s\S]*(true|\$true|1)|netsh\s+advfirewall\s+set\s+allprofiles\s+state\s+off|\bsystemctl\b[\s\S]*\b(stop|disable|mask)\b[\s\S]*(auditd|falcon|crowdstrike|osquery|defender|mdatp|sentinel|carbonblack|firewalld|ufw)|\bufw\b[\s\S]*\bdisable\b)/i;
const DEFAULT_BASE_URL = 'https://studio.osuite.ai';
const CLI_CREDENTIAL_PATHS = [...CREDENTIAL_PATHS, MCP_ENV_PATH];
const PROJECT_BOOTSTRAPS = {
  codex: {
    label: 'Codex hook runtime',
    endpoint: '/api/runtimes/codex/bootstrap',
    envPath: '.codex/.env.example',
    readmePath: '.codex/README.osuite.md',
    runLine: 'Run Codex from this project root so .codex/hooks.json can govern Bash/Edit/Write actions.',
    smokeLine: 'Try: osuite explain "git push origin main", then ask Codex to run a low-risk command such as git status.',
  },
  claude: {
    label: 'Claude Code hook runtime',
    endpoint: '/api/runtimes/claude-code/bootstrap',
    envPath: '.claude/.env.example',
    readmePath: '.claude/README.osuite.md',
    runLine: 'Run Claude Code from this project root so .claude/settings.json can govern tool calls.',
    smokeLine: 'Try: osuite explain "git push origin main", then ask Claude Code to run a low-risk command such as git status.',
  },
  cursor: {
    label: 'Cursor hook runtime',
    endpoint: '/api/runtimes/cursor/bootstrap',
    envPath: '.cursor/.env.example',
    readmePath: '.cursor/README.osuite.md',
    runLine: 'Open this project in Cursor and review its .cursor/hooks.json; host invocation must be verified separately.',
    smokeLine: 'Try: osuite doctor, then ask Cursor to run a low-risk command such as git status.',
  },
};

const RUNTIME_COVERAGE_TIERS = [
  {
    id: 'reference',
    label: 'Reference adapters',
    summary: 'Open CAVA schemas, parser-pack contracts, and reproducible local examples.',
    cli: 'cava scan ./repo --adapter github-actions --adapter package-json',
    studio: 'Shown as reference coverage only; production lanes should upgrade to managed coverage.',
  },
  {
    id: 'managed',
    label: 'Managed OSuite adapters',
    summary: 'OSuite-maintained adapters for Codex, Claude, ChatGPT Apps, MCP, SDK, hooks, and workflow runtimes.',
    cli: 'osuite connect auto && osuite adapters status',
    studio: 'Shown in Runtime Coverage with parser posture, evidence gaps, and remediation paths.',
  },
  {
    id: 'enterprise_custom',
    label: 'Enterprise custom adapters',
    summary: 'Customer-specific mapping for ERP, CRM, ticketing, payments, manufacturing, warehouses, and private workflows.',
    cli: 'osuite adapter init acme-erp && osuite adapter test .osuite/adapters/acme-erp.json',
    studio: 'Shown as customer runtime coverage with versioning, field mapping, approval routing, and proof export.',
  },
];

function useColor() {
  return !process.env.NO_COLOR && process.stdout.isTTY !== false;
}

function c(value, color) {
  return useColor() ? `${color}${value}${ANSI.reset}` : value;
}

function write(value = '') {
  process.stdout.write(`${value}\n`);
}

function parseEnvBody(body = '') {
  const env = Object.create(null);
  body.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) return;
    const [rawKey, ...rawValue] = trimmed.split('=');
    const key = rawKey.trim();
    let value = rawValue.join('=').trim().replace(/^['"]|['"]$/g, '');
    if (value.includes(' #')) value = value.slice(0, value.indexOf(' #')).trim();
    if (key && !env[key]) env[key] = value;
  });
  return env;
}

function loadDotenvFile(relativePath) {
  const absolute = path.join(process.cwd(), relativePath);
  if (!fs.existsSync(absolute)) return;
  for (const [key, value] of Object.entries(parseEnvBody(fs.readFileSync(absolute, 'utf8')))) {
    if (!process.env[key]) process.env[key] = value;
  }
}

function loadProjectEnvironment() {
  // Enrollment selects one whole runtime bundle, never a merged global env.
  if (process.argv[2] === 'connect') return;
  [...CLI_CREDENTIAL_PATHS, '.env'].forEach((relativePath) => {
    if (process.argv[2] === 'doctor' && !inspectCredentialFile(process.cwd(), relativePath).safe) return;
    loadDotenvFile(relativePath);
  });
}

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const args = { _: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[index + 1];
      if (!next || next.startsWith('--')) args[key] = true;
      else {
        args[key] = next;
        index += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return { command, args };
}

// Hooks run with the agent's environment, not the values this CLI loads from project .env files.
const SHELL_ENV = { ...process.env };
loadProjectEnvironment();

function envValue(name, fallback) {
  return process.env[name] || process.env[fallback] || '';
}

function readConfig(env = process.env) {
  const value = (name, fallback) => env[name] || env[fallback] || '';
  return {
    baseUrl: value('OSUITE_BASE_URL', 'DASHCLAW_BASE_URL'),
    apiKey: value('OSUITE_API_KEY', 'DASHCLAW_API_KEY'),
    agentId: value('OSUITE_AGENT_ID', 'DASHCLAW_AGENT_ID') || 'osuite-cli',
    agentKeyId: value('OSUITE_AGENT_KEY_ID', 'DASHCLAW_AGENT_KEY_ID') || null,
    runtimeAdapterId: env.OSUITE_RUNTIME_ADAPTER_ID || '',
    signatureMode: env.OSUITE_SIGNATURE_MODE || '',
  };
}

function requireClient() {
  const config = readConfig();
  if (!config.baseUrl || !config.apiKey) {
    write(c('OSuite is not connected yet.', ANSI.yellow));
    write('Set OSUITE_BASE_URL and OSUITE_API_KEY, or run:');
    write('  osuite init');
    process.exit(1);
  }
  return new OSuite(config);
}

function normalizedBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/$/, '');
}

function sanitizeRuntimeTarget(value, fallback = 'auto') {
  const normalized = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
  if (!normalized) return fallback;
  if (normalized === 'claude-code' || normalized === 'claudecode') return 'claude';
  if (normalized === 'generic') return 'auto';
  return normalized;
}

function detectRuntimeTarget(preferred = 'auto') {
  const target = sanitizeRuntimeTarget(preferred);
  if (target !== 'auto') return target;

  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, '.codex'))) return 'codex';
  if (fs.existsSync(path.join(cwd, '.claude'))) return 'claude';
  if (fs.existsSync(path.join(cwd, '.cursor'))) return 'cursor';
  if (fs.existsSync(path.join(cwd, 'mcp.json')) || fs.existsSync(path.join(cwd, '.mcp.json'))) return 'mcp';
  if (fs.existsSync(path.join(cwd, 'package.json'))) return 'sdk';
  return 'sdk';
}

function generateConnectCode() {
  return `OS-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function buildConnectHandoffUrl({ baseUrl, runtime, code }) {
  const url = new URL('/connect', normalizedBaseUrl(baseUrl));
  url.searchParams.set('runtime', runtime);
  url.searchParams.set('source', 'cli');
  url.searchParams.set('code', code);
  return url.toString();
}

function sanitizeConfiguredAgentId(runtime, agentId) {
  const value = String(agentId || '').trim();
  if (!value) return '';
  const knownDefaults = {
    codex: 'codex-runtime',
    claude: 'claude-code-runtime',
    cursor: 'cursor-runtime',
    mcp: 'mcp-runtime',
    sdk: 'sdk-runtime',
  };
  const foreignDefault = Object.entries(knownDefaults).some(([otherRuntime, defaultId]) => (
    otherRuntime !== runtime && value === defaultId
  ));
  return foreignDefault ? '' : value;
}

function runtimeMatchesConfiguredAdapter(runtime, adapterId) {
  const adapter = String(adapterId || '').trim().toLowerCase();
  if (!adapter) return false;
  if (runtime === 'codex') return adapter === 'codex_hooks';
  if (runtime === 'claude') return adapter === 'claude_code_hooks' || adapter === 'claude_hooks';
  if (runtime === 'cursor') return adapter === 'cursor_hooks';
  if (runtime === 'mcp') return adapter.includes('mcp');
  if (runtime === 'sdk') return ['sdk', 'framework_sdk', 'inline_sdk'].includes(adapter);
  return false;
}

function envPathForRuntime(runtime) {
  if (runtime === 'codex') return '.codex/.env';
  if (runtime === 'claude') return '.claude/.env';
  if (runtime === 'cursor') return '.cursor/.env';
  return runtime === 'mcp' ? MCP_ENV_PATH : SDK_ENV_PATH;
}

function connectionConfig(runtime, liveEnv, { dryRun = false } = {}) {
  if (liveEnv !== null) return readConfig(parseEnvBody(liveEnv));
  const shell = readConfig(SHELL_ENV);
  if (runtimeMatchesConfiguredAdapter(runtime, shell.runtimeAdapterId)) return shell;
  const legacy = dryRun ? null : readCredentialFile(process.cwd(), '.env');
  if (legacy !== null) {
    const config = readConfig(parseEnvBody(legacy));
    if (runtimeMatchesConfiguredAdapter(runtime, config.runtimeAdapterId)) return config;
  }
  return readConfig(!shell.apiKey && !shell.runtimeAdapterId ? { OSUITE_BASE_URL: shell.baseUrl } : {});
}

function parseConnectionJournal(raw) {
  if (raw === null) return null;
  try {
    const journal = JSON.parse(raw);
    if (journal && typeof journal === 'object' && !Array.isArray(journal)) return journal;
  } catch { /* Report only metadata, never journal contents. */ }
  throw new Error('The saved connection recovery journal is invalid; it was left unchanged.');
}

function assertRecoveryState(journal, { runtime, baseUrl, agentId, liveEnv, config, installation }) {
  if (journal.protocol_version !== 2 || journal.runtime !== runtime || journal.base_url !== baseUrl
    || typeof journal.agent_id !== 'string' || !journal.agent_id || (agentId && journal.agent_id !== agentId)
    || !journal.session?.device_code || !journal.session?.poll_token) {
    throw new Error('A recovery journal exists for a different connection. Resume its original runtime, agent and Studio URL before reconnecting.');
  }
  if (journal.credential) assertConnectionCredentialScope(journal.credential, { baseUrl, runtime, agentId: journal.agent_id });
  if (Object.hasOwn(journal, 'live_env_sha256')) {
    const digest = journal.live_env_sha256;
    const promoted = journal.credential && liveEnv === formatEnvBody(journal.credential.env);
    if ((digest !== null && (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)))
      || (credentialDigest(liveEnv) !== digest && !promoted)) {
      throw new Error('Connection recovery conflicts with a changed live credential bundle. Stopped without replacing it; inspect the saved handoff in Studio before retrying.');
    }
  } else if (liveEnv !== null && (config.agentId !== journal.agent_id
    || !runtimeMatchesConfiguredAdapter(runtime, config.runtimeAdapterId) || normalizedBaseUrl(config.baseUrl) !== baseUrl)) {
    // Pre-candidate journals lack the local snapshot. Never let their agent ID
    // override a different live scope; the server still validates the predecessor.
    throw new Error('Legacy connection recovery conflicts with the live runtime, agent or Studio URL; files were left unchanged.');
  }
  // A fresh explicit choice may differ from inherited config. Retain that
  // original context for retries, rather than letting a new flag waive conflicts.
  const explicitSelection = journal.live_env_sha256 === null
    && journal.explicit_agent_selection?.agent_id === journal.agent_id
    && journal.explicit_agent_selection?.configured_agent_id === config.agentId;
  if (liveEnv === null && config.agentId !== 'osuite-cli' && config.agentId !== journal.agent_id && !explicitSelection) {
    throw new Error('Connection recovery conflicts with the configured agent; files were left unchanged.');
  }
  if (journal.installation_id && journal.installation_id !== installation?.installation_id) {
    throw new Error('Connection recovery installation identity changed or is missing; files were left unchanged.');
  }
}

function orderedEnvEntries(env = {}) {
  const preferred = [
    'OSUITE_BASE_URL',
    'OSUITE_API_KEY',
    'OSUITE_AGENT_ID',
    'OSUITE_RUNTIME_ADAPTER_ID',
    'OSUITE_SIGNATURE_MODE',
  ];
  const seen = new Set();
  const entries = [];
  preferred.forEach((key) => {
    if (env[key] !== undefined && env[key] !== null && env[key] !== '') {
      seen.add(key);
      entries.push([key, env[key]]);
    }
  });
  Object.keys(env)
    .sort()
    .forEach((key) => {
      if (!seen.has(key) && env[key] !== undefined && env[key] !== null && env[key] !== '') {
        entries.push([key, env[key]]);
      }
    });
  return entries;
}

function formatEnvBody(env = {}) {
  return `${orderedEnvEntries(env)
    .map(([key, value]) => `${key}=${String(value).replace(/\n/g, '')}`)
    .join('\n')}\n`;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  return { response, payload };
}

async function startDeviceConnect({ baseUrl, runtime, agentId, previousKey, installationId }) {
  const { response, payload } = await postJson(`${normalizedBaseUrl(baseUrl)}/api/onboarding/device-connect/start`, {
    runtime,
    agent_id: agentId,
    ...(installationId ? { installation_id: installationId } : {}),
    project_root: process.cwd(),
    protocol_version: 2,
    client_version: pkg.version,
    ...(previousKey ? { previous_key: previousKey } : {}),
  });
  if (!response.ok) {
    throw new Error(payload.error || `Unable to start browser handoff: HTTP ${response.status}`);
  }
  if (!payload.device_code || !payload.poll_token || !payload.user_code) {
    throw new Error('Studio did not return a complete device-connect payload.');
  }
  return payload;
}

// Opens the handoff in the browser, as `gh auth login` does. Not with
// --no-browser or OSUITE_NO_BROWSER=1, in CI, over SSH, without a terminal or
// a Linux display: there the printed link is opened by hand.
function shouldOpenBrowser(args = {}, env = process.env) {
  if (args['no-browser']) return false;
  if (['1', 'true', 'yes'].includes(String(env.OSUITE_NO_BROWSER || '').trim().toLowerCase())) return false;
  if (env.CI || env.SSH_CONNECTION || env.SSH_TTY) return false;
  if (process.platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  return Boolean(process.stdout.isTTY);
}

function openInBrowser(url) {
  const [command, commandArgs] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(command, commandArgs, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function pollDeviceConnect({ baseUrl, deviceCode, pollToken, timeoutMs, intervalMs, protocolVersion = 1 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    let result;
    try {
      result = await postJson(`${normalizedBaseUrl(baseUrl)}/api/onboarding/device-connect/poll`, {
        device_code: deviceCode,
        poll_token: pollToken,
      });
    } catch (error) {
      if (protocolVersion !== 2) throw error;
      await sleep(Math.max(10, intervalMs));
      continue;
    }
    const { response, payload } = result;

    if (response.status === 200 && payload.status === 'approved' && payload.credential?.env) {
      if (protocolVersion === 2 && (payload.credential.protocol_version !== 2 || !payload.credential.key_id || !payload.credential.ack_token || !payload.credential.env.OSUITE_API_KEY || !payload.credential.env.OSUITE_PRIVATE_KEY_BASE64)) {
        throw new Error('Studio did not deliver an acknowledged credential. Existing credentials were not changed.');
      }
      return payload.credential;
    }
    if (protocolVersion === 2 && response.status >= 500) {
      await sleep(Math.max(10, intervalMs));
      continue;
    }
    if (response.status === 202 || payload.status === 'pending') {
      const serverInterval = Number(payload.interval_seconds || 0) * 1000;
      await sleep(serverInterval > 0 ? Math.max(intervalMs, serverInterval) : intervalMs);
      continue;
    }
    if (response.status === 410 || payload.status === 'expired') {
      const error = new Error('The connect code expired before it was approved. Run osuite connect again for a new code.');
      error.code = 'DEVICE_CONNECT_EXPIRED';
      throw error;
    }
    if (response.status === 409 || payload.status === 'consumed') {
      throw new Error(payload.error || 'Browser handoff was already consumed.');
    }
    if (response.status === 404) {
      throw new Error('Browser handoff was not found. Run osuite connect again.');
    }
    throw new Error(payload.error || `Unable to finish browser handoff: HTTP ${response.status}`);
  }
  return null;
}

async function finalizeDeviceConnect(journal, journalPath, validateLive) {
  const { credential, session, base_url: baseUrl } = journal;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    validateLive();
    let result;
    try {
      result = await postJson(`${normalizedBaseUrl(baseUrl)}/api/onboarding/device-connect/ack`, {
        protocol_version: 2, device_code: session.device_code, poll_token: session.poll_token,
        key_id: credential.key_id, ack_token: credential.ack_token,
      });
    } catch {
      // A lost response may mean the transaction committed. Retry the same receipt.
    }
    validateLive();
    if (result?.response.ok) {
      if (result.payload.status !== 'finalized' || result.payload.key_id !== credential.key_id || typeof result.payload.active !== 'boolean') {
        throw new Error('Studio did not confirm this saved connection. The recovery journal was left unchanged; retry the same osuite connect command.');
      }
      if (!result.payload.active) {
        removeCredentialFile(process.cwd(), journalPath);
        throw new Error('Saved connection was superseded or revoked. It was not installed over the current credentials. Run osuite connect again for a fresh connection.');
      }
      return;
    }
    if (result && result.response.status < 500) {
      if (result.response.status === 410) {
        removeCredentialFile(process.cwd(), journalPath);
        throw new Error('Saved connection expired before finalization. Existing credentials were not changed; run osuite connect again.');
      }
      throw new Error(`Connection was not finalized (HTTP ${result.response.status}). The recovery journal is saved; rerun the same osuite connect command to resume.`);
    }
    await sleep(100 * (attempt + 1));
  }
  throw new Error('Could not confirm finalization. The recovery journal is saved; rerun the same osuite connect command to resume safely.');
}

function assertConnectionCredentialScope(credential, { baseUrl, runtime, agentId }) {
  const adapter = { codex: 'codex_hooks', claude: 'claude_code_hooks', cursor: 'cursor_hooks' }[runtime] || runtime;
  const env = credential?.env;
  if (credential?.protocol_version !== 2 || !env || !credential.key_id || !credential.ack_token
    || !env.OSUITE_API_KEY || !env.OSUITE_PRIVATE_KEY_BASE64
    || typeof env.OSUITE_BASE_URL !== 'string' || normalizedBaseUrl(env.OSUITE_BASE_URL) !== baseUrl
    || env.OSUITE_AGENT_ID !== agentId || env.OSUITE_RUNTIME_ADAPTER_ID !== adapter
    || (credential.runtime !== undefined && credential.runtime !== runtime)
    || (credential.agent_id !== undefined && credential.agent_id !== agentId)) {
    throw new Error('Delivered credentials do not match this connection. No acknowledgement or local replacement was attempted; inspect this enrollment in Studio.');
  }
}

function projectFilePath(relativePath) {
  return resolveProjectPath(process.cwd(), relativePath);
}

function writeProjectFile(relativePath, body, { force = false } = {}) {
  const absolute = projectFilePath(relativePath);
  if (fs.existsSync(absolute) && !force) return { relativePath, status: 'skipped' };
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, String(body || ''));
  return { relativePath, status: 'written' };
}

function readProjectJsonFile(filePath) {
  const absolute = path.isAbsolute(filePath) ? filePath : projectFilePath(filePath);
  return JSON.parse(fs.readFileSync(absolute, 'utf8'));
}

function slugifyAdapterName(value) {
  const slug = String(value || 'enterprise-runtime')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'enterprise-runtime';
}

function enterpriseAdapterTemplate(adapterId) {
  return {
    schema_version: 'osuite.runtime_adapter_mapping.v1',
    adapter_id: adapterId,
    display_name: adapterId
      .split(/[-_.]+/)
      .filter(Boolean)
      .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
      .join(' '),
    coverage_tier: 'enterprise_custom',
    parser_posture: 'enterprise_custom',
    support_model: 'customer_owned_osuite_reviewed',
    description: 'Map a private enterprise runtime event into the CAVA canonical action object.',
    source: {
      kind: 'sample_event',
      runtime_family: 'enterprise_workflow',
      evidence_boundary: 'customer_private_runtime',
    },
    field_map: {
      actor: 'actor.id',
      operation: 'action.operation',
      target: 'action.target',
      systems_touched: 'runtime.system',
      data_boundary: 'data.boundary',
      authority_boundary: 'approval.group',
      reversible: 'action.reversible',
      declared_goal: 'action.goal',
    },
    sample_event: {
      actor: { id: 'agent-or-operator-id' },
      action: {
        operation: 'refund_review',
        target: 'case-123',
        reversible: false,
        goal: 'Review a high-value customer support case before any external side effect.',
      },
      runtime: { system: 'acme-erp' },
      data: { boundary: 'customer_support_context' },
      approval: { group: 'risk-ops' },
    },
    validation: {
      required_fields: [
        'actor',
        'operation',
        'target',
        'systems_touched',
        'data_boundary',
        'authority_boundary',
        'reversible',
      ],
      expected_output: 'CAVA canonical action object with stable semantic key and approval binding.',
    },
  };
}

function remapBootstrapPath(spec, relativePath) {
  if (relativePath === 'README.md') return spec.readmePath;
  return relativePath;
}

async function loadRuntimeBootstrap(spec, args, config) {
  if (args.from) {
    const fixturePath = path.resolve(process.cwd(), String(args.from));
    return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  }

  const baseUrl = normalizedBaseUrl(args['base-url'] || config.baseUrl || DEFAULT_BASE_URL);
  const response = await fetch(`${baseUrl}${spec.endpoint}`, {
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  });
  if (!response.ok) {
    throw new Error(`Unable to download ${spec.label} bootstrap: HTTP ${response.status}`);
  }
  return response.json();
}

async function installRuntimeProjectBootstrap(target, args = {}, { nextSteps = true } = {}) {
  const spec = PROJECT_BOOTSTRAPS[target];
  const config = readConfig();
  const bootstrap = buildNodeRuntimeBootstrap(target, await loadRuntimeBootstrap(spec, args, config));
  const force = Boolean(args.force);
  const results = [];

  Object.entries(bootstrap.files || {}).forEach(([relativePath, body]) => {
    results.push(installProjectFile(process.cwd(), remapBootstrapPath(spec, relativePath), body, { force }));
  });

  if (bootstrap.recommended_env) {
    results.push(installProjectFile(process.cwd(), spec.envPath, `${bootstrap.recommended_env.trim()}\n`, { force }));
  }

  const blockers = installBlockers(results);
  const colors = { created: ANSI.green, merged: ANSI.green, replaced: ANSI.green, failed: ANSI.red, kept: ANSI.yellow };

  write(c(spec.label, ANSI.bold));
  write(`Installing project files into ${process.cwd()}`);
  write('');
  results.forEach((result) => {
    describeInstallResult(result).forEach((line) => {
      const status = line.split(/\s+/)[0];
      write(`  ${colors[status] ? `${c(status, colors[status])}${line.slice(status.length)}` : line}`);
    });
  });
  if (blockers.length) {
    write('');
    write(c('OSuite hook setup is not ready, so this agent is not governed:', ANSI.red));
    blockers.forEach((blocker) => write(`  ${blocker}`));
  }
  if (nextSteps) {
    write('');
    write(c('Next steps', ANSI.bold));
    write(`  1. Run osuite connect ${target} to save protected credentials through the browser handoff.`);
    write('  2. Run osuite doctor. It checks project enablement, connection, telemetry, and governance with a direct hook probe.');
    write(`  3. ${spec.runLine}`);
    write(`  4. ${spec.smokeLine}`);
    write('');
    write(c('OSuite CLI is the control surface; the project hook files are what intercept agent actions.', ANSI.dim));
  }
  return { ok: blockers.length === 0, results, blockers };
}

function writeCheckLine(status, label, detail) {
  const tags = {
    ok: c('OK ', ANSI.green),
    miss: c('MISS', ANSI.yellow),
    warn: c('WARN', ANSI.yellow),
    fail: c('FAIL', ANSI.red),
  };
  write(`${tags[status]}  ${label.padEnd(18)} ${detail}`);
}

// A telemetry-only result must never count as successful governance.
async function verifyProjectHooks(runtimes) {
  const installations = findHookInstallations(process.cwd(), runtimes);
  const checks = [];
  for (const installation of installations) {
    const check = await runHookCheck({ projectRoot: process.cwd(), installation, shellEnv: SHELL_ENV });
    check.steps.forEach((step) => writeCheckLine(step.ok ? 'ok' : 'fail', step.label, `${installation.label}: ${step.detail}`));
    (check.warnings || []).forEach((warning) => writeCheckLine('warn', 'Hook warning', `${installation.label}: ${warning}`));
    checks.push({ installation, ...check });
  }
  return checks;
}

function banner() {
  return [
    c('OSUITE', `${ANSI.bold}${ANSI.cyan}`),
    c('Governed action layer for AI agents', ANSI.bold),
    c('PCAA authority  |  CAVA action understanding  |  Decision V2 review', ANSI.dim),
  ].join('\n');
}

function printHelp() {
  write(banner());
  write('');
  write(c(`OSuite CLI v${pkg.version}`, ANSI.dim));
  write('');
  write(c('Useful commands', ANSI.bold));
  write('  osuite doctor                         Check connection, then run the project hook with a sample call');
  write('  osuite try                            Review one fixed, harmless terminal acknowledgement');
  write('  osuite status                         Ping Studio and show current workspace connection');
  write('  osuite explain "git push origin main" Explain how CAVA/Decision V2 will read a command');
  write('  osuite approvals --limit 20           Show pending approval inbox');
  write('  osuite review <actionId>              Render the decision review card');
  write('  osuite approve <actionId>             Approve from the CLI where the workspace allows it;');
  write('                                        otherwise prints the Studio link to approve it');
  write('  osuite deny <actionId> --reason "Outside change window"');
  write('  osuite adapters [status|coverage]       Explain Runtime Coverage tiers and next steps');
  write('  osuite adapter init <name>             Scaffold an enterprise custom adapter mapping');
  write('  osuite adapter test <file>             Validate an enterprise custom adapter mapping');
  write('  osuite external status                Show external verifier network setup and usage');
  write('  osuite external configure --provider babyblue_invinoveritas --mode shadow --api-key <key> --expected-source-class independent_mediator');
  write('  osuite connect [auto|codex|claude|cursor|sdk|mcp]  Detect runtime and start browser handoff');
  write('                                        --no-browser prints the link instead of opening it');
  write('  osuite connect mcp --migrate-legacy       Move legacy MCP state locally; no enrollment or ACK');
  write('  osuite init [sdk|codex|claude|cursor|mcp]    Prepare a runtime lane');
  write('');
  write(c('Environment', ANSI.bold));
  write('  OSUITE_BASE_URL     Studio URL, for example https://studio.osuite.ai');
  write('  OSUITE_API_KEY      Workspace or admin API key');
  write('  OSUITE_AGENT_ID     Optional actor label for CLI actions');
  write('');
  write(c('Old DASHCLAW_* environment names are still accepted for compatibility.', ANSI.dim));
}

function printRuntimeCoverage(args = {}) {
  const config = readConfig();
  const subcommand = args._[0] || 'status';
  write(c('OSuite Runtime Coverage', `${ANSI.bold}${ANSI.cyan}`));
  write(c('CAVA adapter coverage is split into reference, managed, and enterprise custom layers.', ANSI.dim));
  write('');

  for (const tier of RUNTIME_COVERAGE_TIERS) {
    write(c(tier.label, ANSI.bold));
    write(`  id       ${tier.id}`);
    write(`  purpose  ${tier.summary}`);
    write(`  cli      ${tier.cli}`);
    write(`  studio   ${tier.studio}`);
    write(`  fields   coverage_tier=${tier.id}; parser_posture=${tier.id === 'reference' ? 'reference' : tier.id}`);
    write('');
  }

  if (subcommand === 'coverage') {
    write(c('Workspace coverage', ANSI.bold));
    if (config.baseUrl && config.apiKey) {
      write(`  Studio report  ${normalizedBaseUrl(config.baseUrl)}/runtime-security`);
      write('  Export         /api/runtime-security/report?format=md&download=1');
      write('  Note           The Studio report is the source of truth for connected lanes and parser posture.');
    } else {
      write('  Not connected. Run `osuite connect auto` or set OSUITE_BASE_URL and OSUITE_API_KEY.');
    }
    write('');
  }

  write(c('Rule of thumb', ANSI.bold));
  write('  Reference teaches the action language. Managed makes common runtimes easy. Enterprise custom maps private systems without changing CAVA core.');
}

function validateEnterpriseAdapterMapping(mapping = {}) {
  const problems = [];
  if (mapping.schema_version !== 'osuite.runtime_adapter_mapping.v1') problems.push('schema_version must be osuite.runtime_adapter_mapping.v1');
  if (!mapping.adapter_id) problems.push('adapter_id is required');
  if (mapping.coverage_tier !== 'enterprise_custom') problems.push('coverage_tier must be enterprise_custom');
  if (!mapping.field_map || typeof mapping.field_map !== 'object') problems.push('field_map is required');

  const required = mapping.validation?.required_fields || [
    'actor',
    'operation',
    'target',
    'systems_touched',
    'data_boundary',
    'authority_boundary',
    'reversible',
  ];

  required.forEach((field) => {
    if (!mapping.field_map?.[field]) problems.push(`field_map.${field} is required`);
  });

  if (!mapping.sample_event || typeof mapping.sample_event !== 'object') problems.push('sample_event is required');
  return { ok: problems.length === 0, problems, required };
}

function printEnterpriseAdapterValidation(mapping, filePath) {
  const validation = validateEnterpriseAdapterMapping(mapping);
  write(c('Enterprise custom adapter', `${ANSI.bold}${ANSI.cyan}`));
  write(c('Local CAVA mapping check. No server call was made.', ANSI.dim));
  write('');
  write(`File             ${filePath}`);
  write(`Adapter          ${mapping.adapter_id || 'missing'}`);
  write(`coverage_tier    ${mapping.coverage_tier || 'missing'}`);
  write(`parser_posture   ${mapping.parser_posture || 'missing'}`);
  write(`support_model    ${mapping.support_model || 'missing'}`);
  write('');

  if (!validation.ok) {
    write(c('Mapping problems', ANSI.red));
    validation.problems.forEach((problem) => write(`  - ${problem}`));
    return validation;
  }

  write(c('adapter mapping looks usable', ANSI.green));
  write('Required CAVA fields are mapped:');
  validation.required.forEach((field) => write(`  - ${field} <- ${mapping.field_map[field]}`));
  write('');
  write(c('Next step', ANSI.bold));
  write('  Review the mapping with the runtime owner, then open Studio > Runtime Security > Runtime Coverage to register it.');
  return validation;
}

function enterpriseAdapter(args = {}) {
  const subcommand = args._[0] || 'help';

  if (subcommand === 'init') {
    const adapterId = slugifyAdapterName(args._[1] || args.name || 'enterprise-runtime');
    const relativePath = `.osuite/adapters/${adapterId}.json`;
    const template = enterpriseAdapterTemplate(adapterId);
    const result = writeProjectFile(relativePath, `${JSON.stringify(template, null, 2)}\n`, { force: Boolean(args.force) });

    write(c('Enterprise custom adapter', `${ANSI.bold}${ANSI.cyan}`));
    write(c('Scaffolded a private-runtime mapping for CAVA Runtime Coverage.', ANSI.dim));
    write('');
    write(`${result.status === 'written' ? c('created', ANSI.green) : c('kept   ', ANSI.yellow)} ${relativePath}`);
    write('');
    write(c('Next steps', ANSI.bold));
    write(`  1. Edit ${relativePath} so field_map points at your real runtime event fields.`);
    write(`  2. Run osuite adapter test ${relativePath}.`);
    write('  3. Register the validated mapping in Studio > Runtime Security > Runtime Coverage.');
    return;
  }

  if (subcommand === 'test') {
    const filePath = args._[1] || '.osuite/adapters/enterprise-runtime.json';
    const mapping = readProjectJsonFile(filePath);
    const validation = printEnterpriseAdapterValidation(mapping, filePath);
    if (!validation.ok) process.exit(1);
    return;
  }

  if (subcommand === 'deploy') {
    const filePath = args._[1] || '.osuite/adapters/enterprise-runtime.json';
    const mapping = readProjectJsonFile(filePath);
    const validation = printEnterpriseAdapterValidation(mapping, filePath);
    if (!validation.ok) process.exit(1);

    const config = readConfig();
    write(c('Deploy status', ANSI.bold));
    if (!config.baseUrl || !config.apiKey) {
      write('  validated locally; no Studio credentials were found.');
      write('  Connect OSuite before deploy: osuite connect auto');
      return;
    }

    write(`  validated locally; open ${normalizedBaseUrl(config.baseUrl)}/runtime-security to finish registration.`);
    write('  Studio stores enterprise mappings with workspace policy, versioning, and review ownership.');
    return;
  }

  write(c('Enterprise custom adapter', `${ANSI.bold}${ANSI.cyan}`));
  write('Usage:');
  write('  osuite adapter init <name>');
  write('  osuite adapter test <file>');
  write('  osuite adapter deploy <file>');
}

function tokenize(command) {
  return String(command || '').match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^['"]|['"]$/g, '')) || [];
}

function protectedGitTarget(tokens) {
  if (tokens[0] !== 'git' || tokens[1] !== 'push') return null;
  const refs = tokens.slice(2).filter((token) => !token.startsWith('-') && token !== 'origin' && !token.includes(':'));
  const target = refs[0] || 'unknown';
  const normalized = target.replace(/^refs\/heads\//, '');
  if (PROTECTED_REFS.has(normalized) || normalized.startsWith('release/') || normalized.includes('prod')) return normalized;
  return null;
}

function hostFromCommand(command) {
  const match = String(command || '').match(/https?:\/\/([^/\s"'<>]+)/i);
  return match ? match[1].toLowerCase() : null;
}

function hasPublicFileHost(command) {
  const normalized = String(command || '').toLowerCase();
  return PUBLIC_FILE_HOST_HINTS.some((hint) => normalized.includes(hint));
}

function semanticPattern(id, label, severity, detail) {
  return { id, label, severity, detail };
}

function scoreBreakdown(components, formula = 'local CAVA preview rubric') {
  return {
    model_version: 'osuite.decision_score.v2.1',
    formula,
    components,
  };
}

function classifyCommand(command) {
  const tokens = tokenize(command);
  const executable = tokens[0] || '';
  const operation = tokens[1] || '';

  if (!tokens.length) {
    return { category: 'unknown', operation: 'unknown', risk: 20, reversible: true, summary: 'No command provided.' };
  }

  if (SECURITY_CONTROL_WEAKENING_RE.test(command)) {
    return {
      category: 'policy_degradation',
      operation: executable === 'sudo' ? (tokens[1] || 'security_control_change') : executable,
      risk: 95,
      reversible: false,
      systems: ['security_posture'],
      summary: 'Security-control weakening command. CAVA treats this as a posture degradation pattern, not a generic shell action.',
      notes: ['block by default', 'requires security-owner review before retry'],
      patterns: [
        semanticPattern('security_control_weakening', 'Security-control weakening', 'critical', 'Disables or weakens endpoint, firewall, audit, EDR, or OS runtime protection.'),
      ],
      breakdown: scoreBreakdown([
        { id: 'base_action', label: 'Base action', value: 65, detail: 'Security posture change baseline.', direction: 'base' },
        { id: 'cava_pattern_security_control_weakening', label: 'CAVA pattern', value: 30, detail: 'Security-control weakening raises the local preview to block-level risk.', direction: 'increase' },
      ]),
    };
  }

  if (['curl', 'wget'].includes(executable) || (executable === 'sudo' && ['curl', 'wget'].includes(tokens[1]))) {
    const host = hostFromCommand(command);
    const publicHost = hasPublicFileHost(command);
    const uploadLike = /\s(-F|--form|-T|--upload-file|--post-file)\b|upload|share/i.test(command);
    const risk = publicHost && uploadLike ? 86 : 62;
    const patterns = [
      ...(publicHost && uploadLike ? [
        semanticPattern('hidden_externality', 'Hidden externality', 'high', 'The command creates an external side effect that is stronger than a normal local task.'),
        semanticPattern('public_persistent_egress', 'Public persistent egress', 'critical', 'Data is being uploaded to a public or link-accessible file host.'),
      ] : []),
    ];
    return {
      category: 'network_egress',
      operation: executable === 'sudo' ? tokens[1] : executable,
      risk,
      reversible: false,
      systems: ['network', host || 'external_endpoint'],
      summary: publicHost
        ? `Network egress to public file host ${host || 'unknown host'}.`
        : `Network egress to ${host || 'external endpoint'}.`,
      notes: publicHost ? ['public link or file host', 'approval or block depends on policy profile'] : ['external network boundary'],
      patterns,
      breakdown: scoreBreakdown([
        { id: 'base_action', label: 'Base action', value: 45, detail: 'Network egress baseline.', direction: 'base' },
        ...(publicHost ? [{ id: 'public_destination', label: 'Public destination', value: 23, detail: 'Public file/link destination detected.', direction: 'increase' }] : []),
        ...(uploadLike ? [{ id: 'external_write', label: 'External write', value: 18, detail: 'Upload or form-post semantics detected.', direction: 'increase' }] : []),
      ]),
    };
  }

  if (executable === 'git' && Object.hasOwn(GIT_OBSERVATION_RISKS, operation)) {
    const risk = GIT_OBSERVATION_RISKS[operation];
    return {
      category: 'observation',
      operation,
      risk,
      reversible: true,
      systems: ['git'],
      summary: `Git ${operation} read-only workspace observation.`,
      notes: ['read-only CAVA operation', 'usually does not require approval'],
      breakdown: scoreBreakdown([
        { id: 'base_action', label: 'Base action', value: risk, detail: `git ${operation} read-only observation baseline.`, direction: 'base' },
        { id: 'cava_operation', label: 'CAVA operation', value: 0, detail: 'Parsed as read-only/reversible git observation.', direction: 'evidence' },
      ]),
    };
  }

  if (executable === 'git' && operation === 'push') {
    const protectedTarget = protectedGitTarget(tokens);
    const target = protectedTarget || tokens.filter((token) => !token.startsWith('-')).at(-1) || 'remote';
    return {
      category: 'deployment',
      operation: 'push',
      risk: protectedTarget ? 82 : 58,
      reversible: false,
      systems: ['git', 'remote_repository'],
      summary: protectedTarget
        ? `Git push to protected target ${protectedTarget}.`
        : `Git push to ${target}.`,
      notes: protectedTarget ? ['protected target', 'approval recommended before side effects'] : ['feature branch target'],
      breakdown: scoreBreakdown([
        { id: 'base_action', label: 'Base action', value: protectedTarget ? 80 : 62, detail: protectedTarget ? 'Protected git push baseline.' : 'Remote git push baseline.', direction: 'base' },
        ...(protectedTarget ? [{ id: 'protected_target', label: 'Protected target', value: 2, detail: `Target ${protectedTarget} raises review posture.`, direction: 'increase' }] : []),
        { id: 'cava_operation', label: 'CAVA operation', value: 0, detail: 'Parsed as state-changing deployment.', direction: 'evidence' },
      ]),
    };
  }

  if (executable === 'npm' && operation === 'run' && tokens[2] === 'build') {
    return {
      category: 'build',
      operation: 'build',
      risk: 30,
      reversible: true,
      systems: ['local_workspace'],
      summary: 'Local build or compilation step.',
      notes: ['usually does not require approval unless chained with deployment'],
      breakdown: scoreBreakdown([
        { id: 'base_action', label: 'Base action', value: 30, detail: 'Local build baseline.', direction: 'base' },
        { id: 'cava_operation', label: 'CAVA operation', value: 0, detail: 'Parsed as reversible local build.', direction: 'evidence' },
      ]),
    };
  }

  if (['kubectl', 'helm', 'terraform', 'pulumi', 'ansible'].includes(executable)) {
    const op = operation || 'unknown';
    if (OBSERVE_OPS.has(op)) {
      return {
        category: 'observation',
        operation: op,
        risk: 28,
        reversible: true,
        systems: [executable],
        summary: `${executable} observation command.`,
        notes: ['read-oriented runtime action'],
        breakdown: scoreBreakdown([
          { id: 'base_action', label: 'Base action', value: 28, detail: `${executable} read-oriented operation baseline.`, direction: 'base' },
          { id: 'cava_operation', label: 'CAVA operation', value: 0, detail: 'Parsed as observation.', direction: 'evidence' },
        ]),
      };
    }
    if (PLAN_OPS.has(op)) {
      return {
        category: 'infrastructure_plan',
        operation: op,
        risk: 38,
        reversible: true,
        systems: [executable],
        summary: `${executable} planning command.`,
        notes: ['plan evidence can improve approval confidence'],
        breakdown: scoreBreakdown([
          { id: 'base_action', label: 'Base action', value: 38, detail: `${executable} planning baseline.`, direction: 'base' },
          { id: 'cava_operation', label: 'CAVA operation', value: 0, detail: 'Parsed as reversible plan/preflight evidence.', direction: 'evidence' },
        ]),
      };
    }
    if (MUTATION_OPS.has(op)) {
      return {
        category: 'infrastructure_change',
        operation: op,
        risk: op === 'apply' || op === 'destroy' ? 90 : 78,
        reversible: false,
        systems: [executable],
        summary: `${executable} infrastructure mutation.`,
        notes: ['approval recommended', 'capture plan/output as evidence'],
        breakdown: scoreBreakdown([
          { id: 'base_action', label: 'Base action', value: op === 'apply' || op === 'destroy' ? 90 : 78, detail: `${executable} mutation baseline.`, direction: 'base' },
          { id: 'cava_operation', label: 'CAVA operation', value: 0, detail: 'Parsed as state-changing infrastructure action.', direction: 'evidence' },
        ]),
      };
    }
  }

  if (executable === 'az' && tokens[1] === 'keyvault' && tokens[2] === 'secret') {
    return {
      category: 'secret_access',
      operation: tokens[3] || 'secret',
      risk: 74,
      reversible: true,
      systems: ['azure_key_vault'],
      summary: 'Azure Key Vault secret access.',
      notes: ['sensitive read', 'approval may be required by policy'],
      breakdown: scoreBreakdown([
        { id: 'base_action', label: 'Base action', value: 74, detail: 'Secret access baseline.', direction: 'base' },
        { id: 'secret_data', label: 'Secret/data signal', value: 0, detail: 'Key Vault secret operation detected.', direction: 'evidence' },
      ]),
    };
  }

  if (['rm', 'drop', 'truncate'].some((prefix) => String(command).toLowerCase().includes(prefix))) {
    return {
      category: 'destructive_operation',
      operation: executable,
      risk: 92,
      reversible: false,
      systems: ['workspace'],
      summary: 'Potentially destructive operation.',
      notes: ['approval strongly recommended'],
      breakdown: scoreBreakdown([
        { id: 'base_action', label: 'Base action', value: 72, detail: 'Unknown destructive shell baseline.', direction: 'base' },
        { id: 'destructive_text', label: 'Destructive intent', value: 20, detail: 'Command text matched destructive patterns.', direction: 'increase' },
      ]),
    };
  }

  return {
    category: 'shell_command',
    operation: executable,
    risk: 45,
    reversible: null,
    systems: ['shell'],
    summary: 'General shell command. OSuite will use runtime context and policy to decide.',
    notes: ['provide declared_goal and evidence for better scoring'],
    breakdown: scoreBreakdown([
      { id: 'base_action', label: 'Base action', value: 20, detail: 'Generic shell baseline.', direction: 'base' },
      { id: 'moderate_system', label: 'System boundary', value: 25, detail: 'Unknown shell command lacks CAVA-specific parser evidence.', direction: 'increase' },
    ]),
  };
}

function riskBand(score) {
  if (score >= 75) return 'High';
  if (score >= 45) return 'Moderate';
  return 'Low';
}

function printExplanation(command) {
  const result = classifyCommand(command);
  const band = riskBand(result.risk);
  const bandColor = band === 'High' ? ANSI.red : band === 'Moderate' ? ANSI.yellow : ANSI.green;

  write(c('OSuite CAVA explanation', `${ANSI.bold}${ANSI.cyan}`));
  write(c('Local preview. No server call was made.', ANSI.dim));
  write('');
  write(`Command              ${command}`);
  write(`Category             ${result.category}`);
  write(`Operation            ${result.operation}`);
  write(`Risk                 ${c(`${band} (${result.risk}/100)`, bandColor)}`);
  write(`Reversible           ${result.reversible === null ? 'unknown' : String(result.reversible)}`);
  write(`Systems touched      ${(result.systems || []).join(', ') || 'unknown'}`);
  write(`OSuite understood    ${result.summary}`);
  if (result.notes?.length) {
    write('');
    write(c('Decision hints', ANSI.bold));
    result.notes.forEach((note) => write(`  - ${note}`));
  }
  if (result.breakdown?.components?.length) {
    write('');
    write(c('Score breakdown', ANSI.bold));
    write(`  Model ${result.breakdown.model_version}`);
    result.breakdown.components.forEach((component) => {
      const value = component.value ?? component.score ?? '-';
      const sign = typeof value === 'number' && value > 0 && component.direction !== 'base' ? `+${value}` : String(value);
      write(`  ${(component.label || component.id).padEnd(18)} ${String(sign).padStart(4)}  ${component.detail || ''}`);
    });
  }
  if (result.patterns?.length) {
    write('');
    write(c('CAVA patterns', ANSI.bold));
    result.patterns.forEach((pattern) => {
      write(`  - ${pattern.label} (${pattern.severity}): ${pattern.detail}`);
    });
  }
}

async function doctor() {
  const config = readConfig();
  let ok = true;

  write(c('OSuite Doctor', `${ANSI.bold}${ANSI.cyan}`));
  write(c('Checking the local developer entry point.', ANSI.dim));
  write('');

  const credentialChecks = [...CLI_CREDENTIAL_PATHS.flatMap((file) => [file, `${file}.identity.json`, `${file}.connect.json`, `${file}.connect.lock`]), MCP_MIGRATION_PATH, '.env']
    .map((relativePath) => inspectCredentialFile(process.cwd(), relativePath));
  const unsafeCredentials = credentialChecks.filter((check) => check.exists && !check.safe);
  for (const check of credentialChecks.filter((item) => item.exists)) {
    writeCheckLine(check.safe ? 'ok' : 'fail', 'Credential file', `${check.relativePath}: ${check.safe ? check.mode ? `${check.mode}; owner-only` : 'review platform ACLs; POSIX mode unavailable' : `unsafe; ${check.problems.join('; ')}`}`);
  }
  if (unsafeCredentials.length) {
    write('Repair credential protection before running hooks. Reconnect to rotate any possibly exposed key; chmod alone cannot undo disclosure.');
    process.exitCode = 1;
    return false;
  }
  if (credentialChecks.some((check) => check.exists && check.relativePath === MCP_MIGRATION_PATH)) {
    writeCheckLine('warn', 'MCP migration', 'resume osuite connect mcp --migrate-legacy before using either SDK or MCP.');
    process.exitCode = 1;
    return false;
  }
  if (credentialChecks.some((check) => check.exists && check.relativePath.endsWith('.connect.json'))) {
    writeCheckLine('warn', 'Connection recovery', 'resume the original osuite connect command before running this runtime.');
    process.exitCode = 1;
    return false;
  }

  const checks = [
    ['OSUITE_BASE_URL', Boolean(config.baseUrl), config.baseUrl || 'missing'],
    ['OSUITE_API_KEY', Boolean(config.apiKey), config.apiKey ? 'present' : 'missing'],
    ['OSUITE_AGENT_ID', Boolean(config.agentId), config.agentId || 'osuite-cli'],
    ['Runtime adapter', Boolean(config.runtimeAdapterId), config.runtimeAdapterId || 'not declared'],
    ['Signature mode', Boolean(config.signatureMode), config.signatureMode || 'not declared'],
  ];

  checks.forEach(([label, passed, detail]) => {
    if (!passed && (label === 'OSUITE_BASE_URL' || label === 'OSUITE_API_KEY')) ok = false;
    write(`${passed ? c('OK ', ANSI.green) : c('MISS', ANSI.yellow)}  ${label.padEnd(18)} ${detail}`);
  });

  if (config.baseUrl) {
    try {
      const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/api/health`, {
        redirect: 'error', signal: AbortSignal.timeout(10000),
      });
      const body = await response.json();
      const healthy = response.ok && body.status === 'healthy';
      ok = ok && healthy;
      write(`${healthy ? c('OK ', ANSI.green) : c('WARN', ANSI.yellow)}  ${'Studio health'.padEnd(18)} HTTP ${response.status}`);
    } catch (error) {
      ok = false;
      write(`${c('FAIL', ANSI.red)}  ${'Studio health'.padEnd(18)} ${error.message}`);
    }
  }

  const hookChecks = await verifyProjectHooks();
  if (!hookChecks.length) writeCheckLine('miss', 'Agent hooks', 'none in this project (fine for SDK and MCP runtimes)');
  const hooksOk = hookChecks.every((check) => check.ok);

  write('');
  if (!ok || !hooksOk) {
    write(c('Next step', ANSI.bold));
    if (!ok) {
      write('  osuite init');
      write('  export OSUITE_BASE_URL=https://studio.osuite.ai');
      write('  export OSUITE_API_KEY=<workspace-api-key>');
    }
    hookChecks.filter((check) => !check.ok).forEach((check) => {
      write(`  ${check.installation.label} is not governed yet. Fix the FAIL line above, or run osuite connect ${check.installation.runtime} to reinstall, then run osuite doctor again.`);
    });
    process.exitCode = 1;
    return false;
  }

  write(c('Your OSuite CLI is ready.', ANSI.green));
  hookChecks.forEach((check) => {
    write(`  ${check.installation.label} direct hook probe was governed and reached OSuite; verify host invocation after starting the runtime.`);
  });
  return true;
}

async function tryWalkthrough(args) {
  if (args._.length || Object.keys(args).some((key) => !['_', 'timeout-ms'].includes(key))) {
    throw new Error('osuite try accepts no command arguments: its output is fixed. Only --timeout-ms may be set.');
  }
  if (inspectCredentialFile(process.cwd(), MCP_MIGRATION_PATH).exists) {
    throw new Error('Resume osuite connect mcp --migrate-legacy before starting the walkthrough.');
  }
  for (const file of [...CLI_CREDENTIAL_PATHS, '.env']) {
    const check = inspectCredentialFile(process.cwd(), file);
    if (check.exists && !check.safe) throw new Error('Credential storage needs attention. Run osuite doctor before starting the walkthrough.');
    if (inspectCredentialFile(process.cwd(), `${file}.connect.json`).exists) {
      throw new Error('Resume the saved osuite connect operation before starting the walkthrough.');
    }
  }
  const config = readConfig();
  const result = await runTryFlow({
    client: requireClient(), emit: write,
    timeoutMs: args['timeout-ms'] === undefined ? 300000 : Number(args['timeout-ms']),
    privateKeyBase64: envValue('OSUITE_PRIVATE_KEY_BASE64', 'DASHCLAW_PRIVATE_KEY_BASE64'),
    signatureRequired: config.signatureMode === 'required',
  });
  write(`Walkthrough completed. Evidence: ${result.replayUrl}`);
}

async function status() {
  const config = readConfig();
  write(c('OSuite Status', `${ANSI.bold}${ANSI.cyan}`));
  write(`Base URL             ${config.baseUrl || 'not configured'}`);
  write(`Agent ID             ${config.agentId}`);
  write(`Runtime adapter      ${config.runtimeAdapterId || 'not declared'}`);
  if (!config.baseUrl) return;

  const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/api/health`);
  write(`Studio health        HTTP ${response.status}`);
}

function renderActionRow(action) {
  const id = action.action_id || action.id || '-';
  const score = action.risk_score ?? action.agent_risk_score ?? '-';
  const type = action.action_type || '-';
  const agent = action.agent_name || action.agent_id || '-';
  const goal = action.declared_goal || action.input_summary || '-';
  return `${id.padEnd(18)} ${String(score).padStart(3)}  ${type.padEnd(24)} ${agent.padEnd(18)} ${goal}`;
}

async function approvals(args) {
  const client = requireClient();
  const limit = Number.parseInt(args.limit || '20', 10);
  const offset = Number.parseInt(args.offset || '0', 10);
  const payload = await client.getPendingApprovals(limit, offset);
  const actions = payload.actions || [];

  write(c('OSuite Approval Inbox', `${ANSI.bold}${ANSI.cyan}`));
  write(c('Actions waiting for human authority.', ANSI.dim));
  write('');

  if (!actions.length) {
    write('No pending approvals.');
    return;
  }

  write(`${'Action ID'.padEnd(18)} ${'Risk'.padStart(3)}  ${'Type'.padEnd(24)} ${'Agent'.padEnd(18)} Goal`);
  actions.forEach((action) => write(renderActionRow(action)));
  write('');
  write(c('Review and decide in Studio:', ANSI.dim));
  actions.forEach((action) => write(`  ${client.baseUrl}/approvals?action=${encodeURIComponent(action.action_id)}`));
}

async function review(actionId) {
  if (!actionId) {
    write('Missing actionId. Usage: osuite review <actionId>');
    process.exit(1);
  }
  const client = requireClient();
  const payload = await client.getAction(actionId);
  const action = payload.action || payload;
  write(buildReviewSurface(action, { baseUrl: client.baseUrl }));
}

async function decide(actionId, decision, args) {
  if (!actionId) {
    write(`Missing actionId. Usage: osuite ${decision === 'allow' ? 'approve' : 'deny'} <actionId>`);
    process.exit(1);
  }
  const client = requireClient();
  let result;
  try {
    result = await client.approveAction(actionId, decision, args.reason || args.reasoning);
  } catch (error) {
    // Agents share this machine's API key, so the workspace only accepts
    // decisions from a person signed in to Studio.
    if (error?.response?.code === 'HUMAN_APPROVER_REQUIRED') {
      write(c('Approvals are made by a person signed in to OSuite Studio.', ANSI.yellow));
      write(`Open this request to ${decision === 'allow' ? 'approve' : 'deny'} it: ${error.response.review_url || `${client.baseUrl}/approvals?action=${encodeURIComponent(actionId)}`}`);
      process.exit(1);
    }
    throw error;
  }
  const label = decision === 'allow' ? 'Approved' : 'Denied';
  write(c(`${label} ${actionId}`, decision === 'allow' ? ANSI.green : ANSI.red));
  if (result?.action?.status) write(`New status           ${result.action.status}`);
}

function printExternalVerifierProvider(provider = {}) {
  const status = provider.enabled ? c('enabled', ANSI.green) : c('disabled', ANSI.yellow);
  write(`  ${provider.display_name || provider.provider_id}`);
  write(`    id              ${provider.provider_id}`);
  write(`    status          ${status}`);
  write(`    mode            ${provider.mode || 'off'}`);
  write(`    account model   ${provider.account_model || 'osuite_managed'}`);
  if (provider.account_id) write(`    account id      ${provider.account_id}`);
  if (provider.api_key_preview || provider.has_api_key) {
    write(`    verifier key    ${provider.api_key_preview || 'present'}`);
  }
  if (provider.base_url) write(`    endpoint        ${provider.base_url}`);
}

function printExternalVerifierStatus(payload = {}) {
  const config = payload.config || {};
  const usage = payload.usage || {};
  write(c('External Verifier Network', `${ANSI.bold}${ANSI.cyan}`));
  write(c('Provider-neutral checkpoint configuration for signed, challengeable proof references.', ANSI.dim));
  write('');
  write(`Workspace state     ${config.enabled ? c('enabled', ANSI.green) : c('disabled', ANSI.yellow)}`);
  if (usage.resource) {
    write(`Usage               ${usage.current ?? 0} / ${usage.limit ?? 0} ${usage.resource}`);
  }
  write('');
  const providers = Array.isArray(config.providers) ? config.providers : [];
  if (!providers.length) {
    write('No provider has been configured yet.');
  } else {
    providers.forEach(printExternalVerifierProvider);
  }
  if (payload.commands?.cli) {
    write('');
    write(c('Copy-paste setup', ANSI.bold));
    payload.commands.cli.split('\n').forEach((line) => write(`  ${line}`));
  }
}

function buildExternalVerifierProviderPayload(args = {}) {
  const providerId = String(args.provider || args._?.[1] || 'babyblue_invinoveritas').trim();
  const mode = String(args.mode || 'shadow').trim();
  const accountModel = String(args['account-model'] || args.accountModel || 'customer_managed').trim();
  const provider = {
    provider_id: providerId,
    enabled: args.enabled === undefined ? true : args.enabled !== 'false',
    mode,
    account_model: accountModel,
  };
  if (args['api-key']) provider.api_key = String(args['api-key']);
  if (args['account-id']) provider.account_id = String(args['account-id']);
  if (args['base-url']) provider.base_url = String(args['base-url']);
  if (args['expected-source-class']) provider.expected_source_class = String(args['expected-source-class']);
  return provider;
}

async function external(args = {}) {
  const subcommand = args._[0] || 'status';
  const client = requireClient();

  if (subcommand === 'status' || subcommand === 'providers') {
    const payload = await client.getExternalVerifierConfig();
    if (args.json) return write(JSON.stringify(payload, null, 2));
    printExternalVerifierStatus(payload);
    return;
  }

  if (subcommand === 'configure') {
    const provider = buildExternalVerifierProviderPayload(args);
    const request = {
      enabled: true,
      providers: [provider],
    };
    if (args['dry-run']) {
      write(c('External Verifier Network', `${ANSI.bold}${ANSI.cyan}`));
      write('Dry run: would POST this configuration to Studio.');
      write(JSON.stringify(request, null, 2));
      return;
    }
    const payload = await client.configureExternalVerifier(request);
    write(c('External Verifier Network configured', ANSI.green));
    write(`Provider            ${provider.provider_id}`);
    write(`Mode                ${provider.mode}`);
    write(`Account model       ${provider.account_model}`);
    write('');
    printExternalVerifierStatus(payload);
    return;
  }

  if (subcommand === 'disable') {
    const providerId = String(args.provider || args._[1] || 'babyblue_invinoveritas');
    const payload = await client.disableExternalVerifier(providerId);
    write(c('External Verifier Network provider disabled', ANSI.yellow));
    write(`Provider            ${providerId}`);
    write('');
    printExternalVerifierStatus(payload);
    return;
  }

  write(`Unknown external verifier command: ${subcommand}`);
  write('Usage: osuite external [status|configure|disable]');
  process.exit(1);
}

async function init(target = 'generic', args = {}) {
  write(c('OSuite init', `${ANSI.bold}${ANSI.cyan}`));
  if (PROJECT_BOOTSTRAPS[target]) {
    const install = await installRuntimeProjectBootstrap(target, args);
    if (!install.ok) process.exitCode = 1;
    return;
  }

  write('Paste these into your shell, then run `osuite doctor`:');
  write('');
  write('export OSUITE_BASE_URL=https://studio.osuite.ai');
  write('export OSUITE_API_KEY=<workspace-api-key>');
  write('export OSUITE_AGENT_ID=<agent-or-runtime-id>');
  write('');

  if (target === 'sdk') {
    write(c('Embedded SDK runtime lane', ANSI.bold));
    write('  npm install osuite');
    write('  export OSUITE_RUNTIME_FAMILY=framework_sdk');
    write('  export OSUITE_ADAPTER_MODE=inline_sdk');
    write('  osuite doctor');
  } else if (target === 'mcp') {
    write(c('MCP runtime lane', ANSI.bold));
    write('  Use OSuite preflight, wait-for-approval, and complete-action tools around consequential actions.');
  }
}

async function connectProject(target = 'auto', args = {}) {
  const runtime = detectRuntimeTarget(target);
  const envPath = envPathForRuntime(runtime);
  const journalPath = `${envPath}.connect.json`;
  const liveEnv = args['dry-run'] ? null : readCredentialFile(process.cwd(), envPath);
  const config = connectionConfig(runtime, liveEnv, { dryRun: Boolean(args['dry-run']) });
  const baseUrl = normalizedBaseUrl(args['base-url'] || config.baseUrl || DEFAULT_BASE_URL);
  const saved = args['dry-run'] ? null : readCredentialFile(process.cwd(), journalPath);
  let storedJournal = saved;
  let journal = parseConnectionJournal(saved);
  const existingInstallation = args['dry-run'] ? null : readInstallationIdentity(process.cwd(), envPath, runtime);
  if (journal) {
    assertRecoveryState(journal, { runtime, baseUrl, agentId: args['agent-id'], liveEnv, config, installation: existingInstallation });
  } else if (liveEnv !== null && config.runtimeAdapterId && !runtimeMatchesConfiguredAdapter(runtime, config.runtimeAdapterId)) {
    throw new Error('The live credential bundle belongs to a different runtime; it was left unchanged.');
  }
  // Validation above is read-only: even missing metadata must not be recreated
  // over a conflicting live installation merely because a receipt is resumable.
  const installation = existingInstallation || getInstallationIdentity(process.cwd(), envPath, runtime, { dryRun: Boolean(args['dry-run']) });
  const configuredAgentId = sanitizeConfiguredAgentId(
    runtime,
    runtimeMatchesConfiguredAdapter(runtime, config.runtimeAdapterId) && config.agentId !== 'osuite-cli'
      ? config.agentId
      : '',
  );
  const agentId = String(args['agent-id'] || journal?.agent_id || configuredAgentId || installation.agent_id);
  const validateLive = (receipt = journal) => {
    if (readCredentialFile(process.cwd(), journalPath) !== storedJournal) {
      throw new Error('The connection recovery journal changed during this operation; it was left unchanged. Inspect the handoff in Studio before retrying.');
    }
    const current = readCredentialFile(process.cwd(), envPath);
    assertRecoveryState(receipt, { runtime, baseUrl, agentId, liveEnv: current,
      config: connectionConfig(runtime, current), installation: readInstallationIdentity(process.cwd(), envPath, runtime) });
  };
  const saveJournal = () => {
    validateLive();
    const body = `${JSON.stringify(journal)}\n`;
    writeCredentialFile(process.cwd(), journalPath, body);
    storedJournal = body;
  };
  const dryRunCode = String(args.code || generateConnectCode()).trim() || generateConnectCode();
  let connectPayload = null;
  let code = dryRunCode;
  let handoffUrl = buildConnectHandoffUrl({ baseUrl, runtime, code });
  const hasApiKey = Boolean(config.apiKey);
  if (!args['dry-run']) {
    if (journal) {
      connectPayload = journal.session;
    } else {
      const previousKey = normalizedBaseUrl(config.baseUrl) === baseUrl && runtimeMatchesConfiguredAdapter(runtime, config.runtimeAdapterId) && configuredAgentId === agentId ? config.apiKey : '';
      connectPayload = await startDeviceConnect({ baseUrl, runtime, agentId, previousKey, installationId: installation.installation_id });
      if (connectPayload.protocol_version === 2) {
        journal = { protocol_version: 2, base_url: baseUrl, runtime, agent_id: agentId, installation_id: installation.installation_id,
          live_env_sha256: credentialDigest(liveEnv), session: connectPayload };
        if (liveEnv === null && args['agent-id']) {
          journal.explicit_agent_selection = { agent_id: agentId, configured_agent_id: config.agentId };
        }
        saveJournal();
      } else {
        if (hasApiKey && fs.existsSync(projectFilePath(envPath))) {
          throw new Error('This Studio does not support acknowledged reconnect. Upgrade Studio before replacing existing credentials; they were left unchanged.');
        }
        write(c('Legacy Studio protocol: secure file storage is available, but delivery has no acknowledgement or interruption recovery. Upgrade Studio for safe reconnect.', ANSI.yellow));
      }
    }
    code = connectPayload.user_code;
    handoffUrl = connectPayload.verification_uri_complete || buildConnectHandoffUrl({ baseUrl, runtime, code });
  }

  write(c('OSuite Connect', `${ANSI.bold}${ANSI.cyan}`));
  write(c('Project-root setup for governed agent actions.', ANSI.dim));
  write('');
  write(`Detected runtime     ${runtime}`);
  write(`Project root         ${process.cwd()}`);
  write(`Browser handoff      ${handoffUrl}`);
  write(`One-time code        ${code}`);
  write('');
  const opened = !args['dry-run'] && shouldOpenBrowser(args) && openInBrowser(handoffUrl);
  write(c('What happens next', ANSI.bold));
  write(opened
    ? '  1. Studio opened in your browser. Check the code matches, then approve this terminal.'
    : '  1. Open the browser handoff URL, check the code matches, then approve this terminal in Studio.');
  write('  2. OSuite prepares the runtime identity, project hook lane, and signed env for this project.');
  write('  3. Return here; the CLI will finish automatically and then you can run osuite doctor.');
  write('');

  let install = null;
  if (PROJECT_BOOTSTRAPS[runtime]) {
    if (args['dry-run']) {
      write(`Dry run: would install project hook files for ${runtime}.`);
    } else {
      install = await installRuntimeProjectBootstrap(runtime, { ...args, 'base-url': baseUrl }, { nextSteps: false });
    }
  } else {
    write(c('Runtime setup', ANSI.bold));
    write('  This runtime uses the embedded SDK/MCP lane. Install the SDK in the app code path that dispatches actions.');
    if (runtime === 'sdk') write('  npm install osuite');
    if (runtime === 'mcp') write('  Wrap consequential tool calls with OSuite preflight, wait-for-approval, and complete-action steps.');
  }

  if (!args['dry-run'] && connectPayload) {
    // Wait as long as the code is valid, so approving late still connects.
    const expiresInSeconds = Math.max(30, Number(connectPayload.expires_in || 600));
    const timeoutMs = parsePositiveInt(args['poll-timeout-ms'], expiresInSeconds * 1000);
    const intervalMs = parsePositiveInt(
      args['poll-interval-ms'],
      Math.max(1000, Number(connectPayload.interval_seconds || 2) * 1000),
    );

    write('');
    write(c('Waiting for browser approval', ANSI.bold));
    write(`  Code ${code} expires in about ${Math.round(expiresInSeconds / 60)} minutes. Press Ctrl+C to stop waiting.`);

    let credential = journal?.credential;
    if (!credential) {
      try {
        credential = await pollDeviceConnect({
          baseUrl,
          deviceCode: connectPayload.device_code,
          pollToken: connectPayload.poll_token,
          timeoutMs,
          intervalMs,
          protocolVersion: connectPayload.protocol_version || 1,
        });
      } catch (error) {
        if (journal && error.code === 'DEVICE_CONNECT_EXPIRED') {
          validateLive();
          removeCredentialFile(process.cwd(), journalPath);
        }
        throw error;
      }
    }

    if (credential?.env) {
      if (journal) {
        // Check both a fresh delivery and a journal resumed after process death.
        assertConnectionCredentialScope(credential, { baseUrl, runtime, agentId });
        validateLive();
        journal = { ...journal, credential };
        // fsync both the file and its directory before telling the server to retire
        // the old key. The live env stays unchanged until that transaction commits.
        saveJournal();
        await finalizeDeviceConnect(journal, journalPath, validateLive);
        validateLive();
      }
      const result = writeCredentialFile(process.cwd(), envPath, formatEnvBody(credential.env));
      if (journal) removeCredentialFile(process.cwd(), journalPath);
      write('');
      write(`Saved credentials to ${result.relativePath}`);
      if (!PROJECT_BOOTSTRAPS[runtime]) {
        write(c('Connected to OSuite', ANSI.green));
        write('  Run osuite doctor, then start the agent from this project root.');
      } else if (!install?.ok) {
        write(c('Not connected: OSuite hook setup is not ready, so this agent is not governed.', ANSI.red));
        (install?.blockers || []).forEach((blocker) => write(`  ${blocker}`));
        write(`  Fix the file above, then run osuite connect ${runtime} again.`);
        process.exitCode = 1;
      } else {
        write('');
        write(c('Checking the installed hook', ANSI.bold));
        const checks = await verifyProjectHooks([runtime]);
        write('');
        if (checks.length && checks.every((check) => check.ok)) {
          write(c('Connected to OSuite', ANSI.green));
          write(`  The direct ${PROJECT_BOOTSTRAPS[runtime].label.replace(/ hook runtime$/, '')} hook probe was governed and reached Studio; host invocation still needs runtime verification.`);
          write(`  ${PROJECT_BOOTSTRAPS[runtime].runLine}`);
        } else {
          write(c('Not connected: credentials are saved, but the hook check failed, so this agent is not governed yet.', ANSI.red));
          write('  Fix the FAIL line above, then run osuite doctor.');
          process.exitCode = 1;
        }
      }
    } else {
      write('');
      write(c('Not connected: nobody approved this terminal in the browser in time.', ANSI.yellow));
      write(journal
        ? `  Run osuite connect ${runtime} again to resume this same pending connection; no new request is created while this code remains valid.`
        : `  Run osuite connect ${runtime} again for a new code${install?.ok ? '; the hook files are already installed, only the credentials are missing' : ''}.`);
      write('  If the browser did not open, copy the handoff link above into it.');
      process.exitCode = 1;
    }
  }

  write('');
  write(c('API key fallback', ANSI.bold));
  if (hasApiKey) {
    write('  OSUITE_API_KEY is already present in this shell or project env. Browser handoff can be skipped for this project.');
  } else if (PROJECT_BOOTSTRAPS[runtime]) {
    write('  If browser handoff is unavailable, supply OSUITE_BASE_URL and OSUITE_API_KEY through your secret manager or process environment.');
    write('  Do not copy secrets into an unprotected project file; run osuite doctor before relying on the connection.');
  } else {
    write('  If browser handoff is unavailable, export OSUITE_BASE_URL and OSUITE_API_KEY before running the agent.');
  }
}

async function connect(target = 'auto', args = {}) {
  const runtime = detectRuntimeTarget(target);
  if (args['migrate-legacy'] && runtime !== 'mcp') throw new Error('Legacy migration requires osuite connect mcp --migrate-legacy.');
  if (args['dry-run']) {
    if (args['migrate-legacy']) return write(`Dry run: would move legacy MCP credentials, identity and journal from ${SDK_ENV_PATH} to ${MCP_ENV_PATH}; no network or file changes.`);
    return connectProject(runtime, args);
  }
  const releases = [];
  try {
    if (args['migrate-legacy']) releases.push(acquireCredentialLock(process.cwd(), SDK_ENV_PATH));
    releases.push(acquireCredentialLock(process.cwd(), envPathForRuntime(runtime)));
    if (args['migrate-legacy']) return migrateLegacyMcp(args);
    if (runtime === 'sdk' || runtime === 'mcp') {
      if (readCredentialFile(process.cwd(), MCP_MIGRATION_PATH) !== null) {
        throw new Error('MCP migration is incomplete. Resume osuite connect mcp --migrate-legacy before using either runtime.');
      }
      const legacy = readInstallationBundle(process.cwd(), SDK_ENV_PATH);
      const legacyEnv = parseEnvBody(legacy.env || '');
      const legacyConfig = readConfig(legacyEnv);
      if (!runtimeMatchesConfiguredAdapter('sdk', legacyConfig.runtimeAdapterId)
        && !runtimeMatchesConfiguredAdapter('mcp', legacyConfig.runtimeAdapterId)
        && (legacyConfig.apiKey || legacyConfig.agentId !== 'osuite-cli' || legacyEnv.OSUITE_PRIVATE_KEY_BASE64 || legacyEnv.DASHCLAW_PRIVATE_KEY_BASE64)) {
        throw new Error('Shared legacy credential ownership is ambiguous. Verify and declare its OSUITE_RUNTIME_ADAPTER_ID before connecting; MCP owners must then use osuite connect mcp --migrate-legacy. Files were left unchanged.');
      }
      if (legacyMcpPresent(legacy)) {
        throw new Error('Legacy MCP state conflicts with the shared .osuite/.env namespace. Run osuite connect mcp --migrate-legacy to move it explicitly; no credentials were replaced.');
      }
    }
    return await connectProject(runtime, args);
  } finally { releases.reverse().forEach(release => release()); }
}

function legacyMcpPresent(bundle) {
  const config = readConfig(parseEnvBody(bundle.env || ''));
  const journal = parseConnectionJournal(bundle.journal);
  let identity;
  try { identity = bundle.identity === null ? null : JSON.parse(bundle.identity); }
  catch { throw new Error('Invalid installation identity file; it was left unchanged.'); }
  return runtimeMatchesConfiguredAdapter('mcp', config.runtimeAdapterId) || identity?.runtime === 'mcp' || journal?.runtime === 'mcp';
}

function migrateLegacyMcp(args) {
  const inspected = readMcpMigration(process.cwd());
  if (!inspected.manifest && Object.values(inspected.destination).some(body => body !== null)) {
    throw new Error('MCP migration destination is already occupied; nothing was overwritten.');
  }
  const { bundle } = inspected;
  if (!legacyMcpPresent(bundle)) throw new Error('No unambiguous legacy MCP installation to migrate; files were left unchanged.');
  const config = readConfig(parseEnvBody(bundle.env || ''));
  const installation = parseInstallationIdentity(bundle.identity, 'mcp');
  const journal = parseConnectionJournal(bundle.journal);
  if (bundle.env !== null && (!runtimeMatchesConfiguredAdapter('mcp', config.runtimeAdapterId) || config.agentId === 'osuite-cli')) {
    throw new Error('Legacy MCP migration conflicts with an ambiguous or different live runtime; files were left unchanged.');
  }
  const baseUrl = normalizedBaseUrl(args['base-url'] || config.baseUrl || journal?.base_url);
  if ((args['base-url'] && config.baseUrl && normalizedBaseUrl(config.baseUrl) !== baseUrl)
    || (args['agent-id'] && args['agent-id'] !== config.agentId)) {
    throw new Error('MCP migration cannot change the live agent or Studio URL; files were left unchanged.');
  }
  if (journal) assertRecoveryState(journal, { runtime: 'mcp', baseUrl, agentId: args['agent-id'], liveEnv: bundle.env, config, installation });
  migrateMcpInstallation(process.cwd(), inspected);
  write(`MCP migration complete: moved credentials, identity and recovery state to ${MCP_ENV_PATH}.`);
  write('No enrollment, acknowledgement or server identity change was performed.');
  write('Update the MCP launcher to read this env path before restarting it or connecting SDK in this project.');
  write('Run osuite connect mcp to resume a saved handoff or rotate with the same identity. SDK continues to use .osuite/.env.');
}

async function main() {
  const { command, args } = parseArgs(process.argv.slice(2));

  if (['help', '--help', '-h'].includes(command)) return printHelp();
  if (['version', '--version', '-v'].includes(command)) return write(pkg.version);
  if (command === 'doctor') return runDoctorWithMeasurement(doctor, { config: readConfig(), emit: write });
  if (command === 'try') return tryWalkthrough(args);
  if (command === 'status') return status();
  if (command === 'explain') return printExplanation(args._.join(' '));
  if (command === 'approvals') return approvals(args);
  if (command === 'review') return review(args._[0]);
  if (command === 'approve') return decide(args._[0], 'allow', args);
  if (command === 'deny') return decide(args._[0], 'deny', args);
  if (command === 'adapters' || command === 'coverage') return printRuntimeCoverage(args);
  if (command === 'adapter') return enterpriseAdapter(args);
  if (command === 'external') return external(args);
  if (command === 'connect') return connect(args._[0] || 'auto', args);
  if (command === 'init') return init(args._[0] || 'generic', args);

  write(`Unknown command: ${command}`);
  write('');
  printHelp();
  process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exit(1);
});
