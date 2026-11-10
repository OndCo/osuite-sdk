import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const cli = path.resolve('sdk/cli.js');
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;
async function scenario(runtime, { status = 200, recovery = null, noBundle = false, unsafe = false,
  tamper = false, mode = 'enforce', malformed = false, omit = null, extra = '' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'osuite-native-doctor-'));
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, key: req.headers['x-api-key'] });
    const now = Date.now();
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ schema_version: 'osuite.runtime_posture.v1', runtime_id: runtime,
      org_id: 'org-test', credential_id: 'key-test',
      credential_fingerprint: createHash('sha256').update(tamper ? 'wrong' : 'test-key').digest('hex'),
      targeting: { agent_id: 'test-agent', provider: runtime }, revision: 'a'.repeat(64),
      issued_at: new Date(now).toISOString(), valid_until: new Date(now + 30000).toISOString(),
      posture: { runtime_id: runtime, mode, require_signature: true, require_assumption_capture: false,
        on_guard_unavailable: 'block', approval_timeout_seconds: 600 },
      rule_rollout: { enabled: false, eligible: false },
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const directory = path.join(root, runtime === 'mcp' ? '.osuite/mcp' : '.osuite');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const body = `OSUITE_BASE_URL=${base}\nOSUITE_API_KEY=test-key\nOSUITE_AGENT_ID=test-agent\nOSUITE_ORG_ID=org-test\nOSUITE_RUNTIME_ADAPTER_ID=${runtime}\nOSUITE_SIGNATURE_MODE=required\nOSUITE_PRIVATE_KEY_BASE64=${Buffer.from(privateKey).toString('base64')}\n`;
  const selectedBody = omit ? body.split('\n').filter(line => !line.startsWith(`${omit}=`)).join('\n') : body;
  const envPath = path.join(directory, '.env');
  const envBody = selectedBody + '\n' + extra + (malformed ? 'OSUITE_API_KEY=other\n' : '');
  if (!noBundle) writeFileSync(envPath, envBody, { mode: unsafe ? 0o644 : 0o600 });
  const recoveryPath = recovery === 'migration' ? path.join(root, '.osuite/.env.migrate-mcp.json')
    : recovery === 'lock' ? `${envPath}.connect.lock` : recovery === 'journal' ? `${envPath}.connect.json` : null;
  const recoveryBody = JSON.stringify({ base_url: base, runtime, pid: process.pid, poll_token: 'synthetic-recovery-token' });
  if (recoveryPath) writeFileSync(recoveryPath, recoveryBody, { mode: 0o600 });
  const hook = path.join(root, '.claude'); mkdirSync(hook, { mode: 0o700 });
  const hookBody = 'OSUITE_BASE_URL=http://127.0.0.1:1\nOSUITE_API_KEY=foreign-hook-key\nOSUITE_AGENT_ID=foreign-agent\n';
  writeFileSync(path.join(hook, '.env'), hookBody, { mode: 0o600 });
  writeFileSync(path.join(hook, 'settings.json'), '{"disableAllHooks":true}');
  let child;
  try {
    const result = await new Promise(resolve => {
      child = spawn(process.execPath, [cli, 'doctor', '--runtime', runtime], { cwd: root,
        env: { PATH: process.env.PATH, HOME: root, NO_COLOR: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
      let output = '', timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 10000);
      child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
      child.on('close', code => { clearTimeout(timer); resolve({ code, output, timedOut }); });
    });
    expect(result.timedOut).toBe(false);
    expect(readFileSync(path.join(hook, '.env'), 'utf8')).toBe(hookBody);
    expect(readFileSync(path.join(hook, 'settings.json'), 'utf8')).toBe('{"disableAllHooks":true}');
    expect(result.output).not.toMatch(/foreign-hook-key|test-key|PRIVATE KEY|synthetic-recovery-token/);
    expect(result.output).not.toContain(base);
    if (noBundle) expect(existsSync(envPath)).toBe(false);
    else expect(readFileSync(envPath, 'utf8')).toBe(envBody);
    if (recoveryPath) expect(readFileSync(recoveryPath, 'utf8')).toBe(recoveryBody);
    return { ...result, requests };
  } finally {
    child?.kill(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
}

describe('runtime-scoped native connection diagnostics', () => {
  it.each(['sdk', 'mcp'])('checks only the %s bundle and current posture, without running a Hook', async runtime => {
    const result = await scenario(runtime);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('No tool was executed');
    expect(result.output).toContain('not business-workflow qualification');
    expect(result.requests).toEqual([{ method: 'GET',
      url: `/api/runtimes/${runtime}/posture?agent_id=test-agent&provider=${runtime}`, key: 'test-key' }]);
  });
  it.each([
    ['sdk', 'journal'], ['mcp', 'journal'], ['sdk', 'lock'], ['mcp', 'lock'],
  ])('preserves the original %s command and URL for a pending %s without an installed bundle', async (runtime, recovery) => {
    const result = await scenario(runtime, { recovery, noBundle: true });
    expect(result.code).toBe(1); expect(result.requests).toEqual([]);
    expect(result.output).toContain('CONNECTION_RECOVERY_PENDING');
    expect(result.output).toContain('Preserve credentials and recovery files.');
    expect(result.output).toContain('If another connect process is running, wait for it to finish.');
    expect(result.output).toContain('resume your original connect command');
    expect(result.output).toContain('same runtime, agent and explicit --base-url');
    expect(result.output).not.toContain('Resume osuite connect');
  });
  it.each(['sdk', 'mcp'])('directs %s diagnostics to the explicit MCP migration recovery', async runtime => {
    const result = await scenario(runtime, { recovery: 'migration' });
    expect(result.code).toBe(1); expect(result.requests).toEqual([]);
    expect(result.output).toContain('MCP_MIGRATION_PENDING');
    expect(result.output).toContain('osuite connect mcp --migrate-legacy');
    expect(result.output).toContain('original --base-url');
    expect(result.output).not.toMatch(/Resume osuite connect (?:sdk|mcp) for/);
  });
  it.each([
    ['unsafe credential files', { unsafe: true }, 'UNSAFE_CREDENTIALS'],
    ['missing signing key', { omit: 'OSUITE_PRIVATE_KEY_BASE64' }, null],
    ['conflicting credential aliases', { extra: 'DASHCLAW_API_KEY=other\n' }, 'CREDENTIAL_SOURCE_CONFLICT'],
  ])('does not recommend reconnecting for %s', async (_name, options, code) => {
    const result = await scenario('sdk', options);
    expect(result.code).toBe(1); expect(result.requests).toEqual([]);
    if (code) expect(result.output).toContain(code);
    expect(result.output).toContain('Preserve credentials and recovery files.');
    expect(result.output).toContain('workspace administrator');
    expect(result.output).toContain('Do not reconnect or reissue credentials automatically');
    expect(result.output).not.toContain('osuite connect');
  });
  it.each([401, 403, 503])('does not declare readiness on HTTP %i', async status => {
    const result = await scenario('sdk', { status });
    expect(result.code).toBe(1); expect(result.output).toContain('CURRENT_POSTURE_UNAVAILABLE');
    expect(result.requests).toHaveLength(1);
    expect(result.output).toContain('Do not reconnect or reissue credentials automatically');
    expect(result.output).toContain('revoked access requires an explicit authorized decision');
    expect(result.output).not.toContain('osuite connect');
  });
  it('rejects a posture bound to a different credential', async () => {
    expect((await scenario('mcp', { tamper: true })).code).toBe(1);
  });
  it('does not call observe mode ready for the native wrapper', async () => {
    const result = await scenario('sdk', { mode: 'observe' });
    expect(result.code).toBe(1); expect(result.output).toContain('NATIVE_POSTURE_INCOMPATIBLE');
  });
  it('rejects duplicate environment fields without contacting either server', async () => {
    const result = await scenario('sdk', { malformed: true });
    expect(result.code).toBe(1); expect(result.requests).toEqual([]);
    expect(result.output).toContain('INVALID_CREDENTIAL_FILE');
  });
  it.each(['OSUITE_AGENT_ID', 'OSUITE_RUNTIME_ADAPTER_ID'])('does not infer missing %s from defaults', async omit => {
    const result = await scenario('sdk', { omit });
    expect(result.code).toBe(1); expect(result.requests).toEqual([]);
    expect(result.output).toContain('INVALID_CONFIGURATION');
  });
  it('resolves the current workspace from the credential-bound posture when the delivered bundle has no org field', async () => {
    const result = await scenario('sdk', { omit: 'OSUITE_ORG_ID' });
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('Workspace: org-test');
  });
  it.each(['OSUITE_ORG_ID', 'DASHCLAW_ORG_ID'])('rejects an explicitly empty %s instead of silently discovering a workspace', async alias => {
    const result = await scenario('sdk', { omit: 'OSUITE_ORG_ID', extra: `${alias}=\n` });
    expect(result.code).toBe(1); expect(result.requests).toEqual([]);
    expect(result.output).toContain('INVALID_CONFIGURATION');
  });
});
