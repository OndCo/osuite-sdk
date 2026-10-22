import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { RULE_ROLLOUT_CAPABILITY } from './protocol.mjs';

function readDotenv(installDir, filename = '.env') {
  let fd;
  try {
    fd = openSync(path.join(installDir, filename), constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) return {};
    const values = {};
    for (const line of readFileSync(fd, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?((?:OSUITE|DASHCLAW)_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!match) continue;
      let value = match[2];
      if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/, '');
      values[match[1]] = value;
    }
    return values;
  } catch { return {}; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function loadRuntimeConfig({ installDir, env = process.env, host = 'claude', runtimeId } = {}) {
  const plugin = runtimeId === 'codex_plugin';
  const hardened = plugin || host === 'cursor';
  const source = { ...(installDir ? readDotenv(installDir) : {}), ...(plugin && installDir ? readDotenv(installDir, '.env.osuite') : {}), ...env };
  const get = (name, fallback = '') => source[`OSUITE_${name}`] ?? source[`DASHCLAW_${name}`] ?? fallback;
  const number = (name, fallback, min, max) => {
    const value = Number(get(name, fallback));
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  };
  const requestedMode = get('HOOK_MODE', host === 'cursor' ? 'observe' : 'enforce');
  const mode = ['observe', 'enforce', 'strict'].includes(requestedMode) ? requestedMode : 'strict';
  return {
    host,
    ruleRolloutCapability: get('SCOPED_RULE_ROLLOUT') === '1' ? RULE_ROLLOUT_CAPABILITY : undefined,
    runtimeId: get('RUNTIME_ADAPTER_ID', runtimeId || (host === 'cursor' ? 'cursor_hooks' : host === 'codex' ? 'codex_hooks' : 'claude_code_hooks')),
    agentId: get('AGENT_ID', plugin ? 'codex-plugin-runtime' : host === 'cursor' ? 'cursor' : host === 'codex' ? 'codex' : 'claude-code'),
    orgId: get('ORG_ID'), provider: get('RUNTIME_PROVIDER') || null,
    baseUrl: get('BASE_URL').replace(/\/+$/, ''), apiKey: get('API_KEY'),
    privateKeyBase64: get('PRIVATE_KEY_BASE64').trim(),
    signatureMode: get('SIGNATURE_MODE', hardened ? 'required' : 'workspace_key_optional'),
    mode, guardFailureMode: mode === 'strict' ? 'block' : (get('GUARD_FAILURE_MODE', hardened ? 'block' : 'allow') === 'allow' ? 'allow' : 'block'),
    requireAssumptionCapture: get('REQUIRE_ASSUMPTION_CAPTURE') === 'true',
    approvalTimeoutSeconds: number('APPROVAL_TIMEOUT_SECONDS', 300, 1, 3600),
    approvalWaitMs: number('APPROVAL_WAIT_SECONDS', 30, 0, 40) * 1000,
    stopWaitMs: number('STOP_WAIT_SECONDS', 0, 0, 40) * 1000,
    installCheck: get('HOOK_CHECK') === '1',
    installChannel: get('INSTALL_CHANNEL', plugin ? 'plugin' : 'project_settings'), settingsScope: get('SETTINGS_SCOPE', plugin ? 'managed' : 'project'),
    trustedProjectRequired: get('TRUSTED_PROJECT_REQUIRED', hardened ? 'true' : 'false') === 'true',
    runtimeSessionId: get('RUNTIME_SESSION_ID'), runtimePermissionMode: get('RUNTIME_PERMISSION_MODE'),
    stateDir: get('STATE_DIR') || undefined,
    captureToolInput: get('CAPTURE_TOOL_INPUT', 'summary'),
    allowInsecureHttp: get('ALLOW_INSECURE_HTTP') === '1',
  };
}
