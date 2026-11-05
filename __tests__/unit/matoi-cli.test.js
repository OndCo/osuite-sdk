import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { canonicalJson } from '../../sdk/runtime/protocol.mjs';

const cli = path.resolve('sdk/cli.js'), roots = [], servers = [], children = new Set();
const profile = 'matoi.controlled-transfer.v1';
const MAX_ENVELOPE_BYTES = 1024 * 1024;
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }), issuer = generateKeyPairSync('ed25519');
const hash = value => createHash('sha256').update(value).digest('hex');
const apiKey = 'local-controlled-transfer-test-key';
const privateKey = Buffer.from(rsa.privateKey.export({ format: 'pem', type: 'pkcs8' })).toString('base64');
const paths = { sdk: '.osuite/.env', mcp: '.osuite/mcp/.env' };
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } };
const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
const line = value => `${JSON.stringify(value)}\n`;

function project() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'matoi-cli-'));
  roots.push(root);
  return root;
}
function write(root, file, body, mode = 0o600) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, body, { mode });
}
function tree(root) {
  const files = {};
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else files[path.relative(root, target)] = { hash: hash(fs.readFileSync(target)), mode: fs.statSync(target).mode };
    }
  }
  walk(root);
  return files;
}
function envFor(baseUrl, runtime = 'sdk', overrides = {}) {
  return { OSUITE_BASE_URL: baseUrl, OSUITE_API_KEY: apiKey, OSUITE_PRIVATE_KEY_BASE64: privateKey,
    OSUITE_AGENT_ID: 'agent-1', OSUITE_AGENT_KEY_ID: 'key-1', OSUITE_ORG_ID: 'org-1',
    OSUITE_SIGNATURE_MODE: 'required', OSUITE_GUARD_FAILURE_MODE: 'block',
    OSUITE_RUNTIME_ADAPTER_ID: runtime, ...overrides };
}
function bundle(root, baseUrl, runtime = 'sdk', overrides = {}) {
  const values = envFor(baseUrl, runtime, overrides);
  write(root, paths[runtime], Object.entries(values).filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
  return values;
}
function run(root, args, { env = {}, input = '', nodeArgs = [] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, cli, ...args], { cwd: root,
      env: { PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`, HOME: root, NO_COLOR: '1',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...env } });
    children.add(child);
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 15000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.once('error', reject);
    child.once('close', code => {
      children.delete(child); clearTimeout(timer);
      if (timedOut) reject(new Error('Matoi CLI subprocess timed out'));
      else resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}
async function studio() {
  const requests = [], signatures = [];
  const capability = { profile, installed: true, configured: true, scope: 'controlled-ledger', resourceEnforced: true,
    issuerPublicKey: issuer.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    qualification: { status: 'not-qualified' } };
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method, url: req.url, key: req.headers['x-api-key'], body });
    if (body) {
      const { _signature, ...payload } = body;
      signatures.push(verify('sha256', Buffer.from(canonicalJson(payload)), rsa.publicKey, Buffer.from(_signature || '', 'base64')));
    }
    let result;
    if (req.url === '/api/health') result = { status: 'healthy' };
    else if (req.method === 'GET' && req.url === '/api/matoi/transfers') result = capability;
    else if (req.method === 'GET' && req.url.startsWith('/api/matoi/transfers?')) result = {
      profile, operationId: new URL(req.url, 'http://127.0.0.1').searchParams.get('operationId'),
      state: 'unknown', actionId: null, lastDenial: null, effects: [] };
    else if (body?.kind === 'prepare') {
      const effects = [{ operation: 'transfer', paymentId: 'payment-1', sourceAccount: 'treasury', destination: 'vendor',
        asset: 'USD', network: 'controlled-ledger', amountMinor: '150', decimals: 2 }];
      const payload = { profile, id: 'lease-1', orgId: 'org-1', actorId: 'agent-1', keyId: 'key-1',
        grantId: body.grantId, operationId: body.operationId, grantEpoch: '1', authorityEpoch: '2',
        issuedAt: Date.now() - 100, expiresAt: Date.now() + 60000,
        issuer: hash(issuer.publicKey.export({ type: 'spki', format: 'der' })), workflowDigest: hash('workflow'), evidenceDigest: hash('evidence'),
        effectDigests: effects.map(effect => hash(canonicalJson([profile, 'effect', effect]))),
        context: { artifact_sha256: hash('artifact'), config_sha256: hash('config'), dependencies_sha256: hash('dependencies') } };
      result = { profile, operationId: body.operationId, grantId: body.grantId, state: 'awaiting_approval', effects,
        preparationDigest: hash(canonicalJson(payload)), actionId: 'act-1', fingerprint: `apfp_${hash('approval')}`,
        lease: { payload, signature: sign(null, Buffer.from(canonicalJson(payload)), issuer.privateKey).toString('base64url') } };
    } else { res.writeHead(404); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests, signatures, capability };
}
function jsonLines(output) { return output.trim().split('\n').filter(Boolean).map(value => JSON.parse(value)); }
function noSecrets(result) {
  expect(result.stdout + result.stderr).not.toContain(apiKey);
  expect(result.stdout + result.stderr).not.toContain(privateKey);
}

afterEach(async () => {
  for (const child of children) { const closed = new Promise(resolve => child.once('close', resolve)); child.kill('SIGKILL'); await closed; }
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('strict doctor diagnoses a cold missing configuration without network or local writes', async () => {
  const root = project();
  const result = await run(root, ['doctor', '--controlled-transfers']);
  expect(result.code).toBe(1);
  expect(result.stdout).toContain('SDK installed: yes');
  expect(result.stdout).toContain('Local strict configuration: no');
  expect(result.stdout).toContain('Qualification: unknown');
  expect(tree(root)).toEqual({});
  noSecrets(result);
});

it('strict CLI validates explicit historical roots from the same credential bundle', async () => {
  const root = project(), f = await studio();
  const historical = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  bundle(root, f.baseUrl, 'sdk', { OSUITE_MATOI_TRUSTED_ISSUER_PUBLIC_KEYS_B64: Buffer.from(JSON.stringify([historical])).toString('base64') });
  expect((await run(root, ['doctor', '--controlled-transfers'])).code).toBe(0);
  expect(f.requests).toHaveLength(1);
  bundle(root, f.baseUrl, 'sdk', { OSUITE_MATOI_TRUSTED_ISSUER_PUBLIC_KEYS_B64: Buffer.from(JSON.stringify(['not a public key'])).toString('base64') });
  const bad = await run(root, ['doctor', '--controlled-transfers']);
  expect(bad.code).toBe(1);
  expect(f.requests).toHaveLength(1);
  noSecrets(bad);
});

it.each(['--controlled-transfers', '--require-controlled-transfers'])('strict doctor %s only probes capabilities and honestly preserves non-qualification', async flag => {
  const root = project(), f = await studio();
  bundle(root, f.baseUrl);
  write(root, '.claude/settings.json', '{"hooks":{"PreToolUse":[]}}');
  write(root, '.claude/hook.js', 'throw new Error("must never run");\n');
  const before = tree(root);
  const result = await run(root, ['doctor', flag], { env: { OSUITE_ONBOARDING_METRICS: '1' } });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('Profile configured: yes');
  expect(result.stdout).toContain('Qualification: not-qualified (server-reported)');
  expect(result.stdout).toContain('does not establish full-stack deployment protection');
  expect(f.requests).toMatchObject([{ method: 'GET', url: '/api/matoi/transfers', key: apiKey }]);
  expect(f.requests).toHaveLength(1);
  expect(tree(root)).toEqual(before);
  noSecrets(result);
});

it('strict commands ignore all Hook and root dotenv values rather than merging credentials', async () => {
  const root = project(), f = await studio();
  bundle(root, f.baseUrl);
  for (const file of ['.codex/.env', '.claude/.env', '.cursor/.env', '.env']) {
    write(root, file, 'OSUITE_BASE_URL=http://remote.invalid\nOSUITE_API_KEY=foreign-secret\nOSUITE_AGENT_ID=foreign-agent\n');
  }
  const result = await run(root, ['doctor', '--controlled-transfers']);
  expect(result.code).toBe(0);
  expect(f.requests).toMatchObject([{ key: apiKey }]);
  expect(result.stdout + result.stderr).not.toContain('foreign-secret');
});

it('doctor can explicitly select the protected MCP bundle without borrowing SDK fields', async () => {
  const root = project(), f = await studio();
  bundle(root, f.baseUrl, 'mcp');
  bundle(root, 'http://remote.invalid', 'sdk');
  const result = await run(root, ['doctor', '--controlled-transfers', '--runtime', 'mcp']);
  expect(result.code).toBe(0);
  expect(f.requests).toHaveLength(1);
});

it('a complete shell-only identity works but conflicting shell credentials are rejected', async () => {
  const root = project(), f = await studio();
  const good = await run(root, ['doctor', '--controlled-transfers'], { env: envFor(f.baseUrl) });
  expect(good.code).toBe(0);
  bundle(root, f.baseUrl);
  const bad = await run(root, ['doctor', '--controlled-transfers'], { env: { OSUITE_API_KEY: 'different-shell-key' } });
  expect(bad.code).toBe(1);
  expect(bad.stdout + bad.stderr).toContain('CREDENTIAL_SOURCE_CONFLICT');
  expect(f.requests).toHaveLength(1);
  noSecrets(bad);
});

it('partial bundles cannot borrow a private key or identity from the shell or another lane', async () => {
  const root = project(), f = await studio();
  bundle(root, f.baseUrl, 'sdk', { OSUITE_PRIVATE_KEY_BASE64: undefined });
  bundle(root, f.baseUrl, 'mcp');
  const result = await run(root, ['doctor', '--controlled-transfers'], { env: { OSUITE_PRIVATE_KEY_BASE64: privateKey } });
  expect(result.code).toBe(1);
  expect(f.requests).toEqual([]);
  noSecrets(result);
});

it.each(['OSUITE_ORG_ID', 'OSUITE_SIGNATURE_MODE', 'OSUITE_GUARD_FAILURE_MODE', 'OSUITE_PRIVATE_KEY_BASE64'])('strict profile refuses missing %s without I/O', async field => {
  const root = project(), f = await studio();
  bundle(root, f.baseUrl, 'sdk', { [field]: undefined });
  const result = await run(root, ['doctor', '--controlled-transfers']);
  expect(result.code).toBe(1);
  expect(f.requests).toEqual([]);
});

it.each(['.osuite/.env.connect.json', '.osuite/.env.connect.lock', '.osuite/.env.migrate-mcp.json'])('strict doctor refuses unfinished credential state %s without repairing it', async file => {
  const root = project(), f = await studio();
  bundle(root, f.baseUrl); write(root, file, '{"private":"must-not-echo"}');
  const before = tree(root), result = await run(root, ['doctor', '--controlled-transfers']);
  expect(result.code).toBe(1);
  expect(result.stdout + result.stderr).not.toContain('must-not-echo');
  expect(f.requests).toEqual([]);
  expect(tree(root)).toEqual(before);
});

it('unsafe credential permissions, symlinks and conflicting aliases are rejected', async () => {
  const f = await studio();
  for (const mode of ['world-readable', 'symlink', 'alias']) {
    const root = project(); bundle(root, f.baseUrl);
    const target = path.join(root, paths.sdk);
    if (mode === 'world-readable') fs.chmodSync(target, 0o644);
    else if (mode === 'symlink') { fs.renameSync(target, `${target}.original`); fs.symlinkSync(`${target}.original`, target); }
    else fs.appendFileSync(target, 'DASHCLAW_AGENT_ID=foreign-agent\n');
    const result = await run(root, ['doctor', '--controlled-transfers']);
    expect(result.code).toBe(1);
    noSecrets(result);
  }
  expect(f.requests).toEqual([]);
});

it('ordinary doctor does not fail an otherwise healthy old SDK for missing strict profile configuration', async () => {
  const root = project(), f = await studio();
  bundle(root, f.baseUrl, 'sdk', { OSUITE_PRIVATE_KEY_BASE64: undefined, OSUITE_ORG_ID: undefined });
  const result = await run(root, ['doctor']);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('Your OSuite CLI is ready.');
  expect(result.stdout).toContain('Matoi Controlled Transfers');
  expect(f.requests).toMatchObject([{ method: 'GET', url: '/api/health' }]);
  expect(f.requests).toHaveLength(1);
});

it('controlled MCP initializes and lists exactly three tools with JSON-only stdout and no network or writes', async () => {
  const root = project(), f = await studio(); bundle(root, f.baseUrl, 'mcp');
  write(root, '.claude/hook.js', 'throw new Error("not called");\n');
  const before = tree(root);
  const result = await run(root, ['mcp', '--controlled-transfers'], { input: line(initialize) + line(list) });
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  const responses = jsonLines(result.stdout);
  expect(responses[0].result.serverInfo.name).toBe('osuite_controlled_transfers');
  expect(responses[1].result.tools.map(tool => tool.name)).toEqual(['osuite_transfer_prepare', 'osuite_transfer_execute', 'osuite_transfer_status']);
  expect(f.requests).toEqual([]);
  expect(tree(root)).toEqual(before);
  noSecrets(result);
});

it('controlled MCP delegates one real signed held preparation, never approves or auto-executes', async () => {
  const root = project(), f = await studio(); bundle(root, f.baseUrl, 'mcp');
  const prepare = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
    name: 'osuite_transfer_prepare', arguments: { operationId: 'operation-1', grantId: 'grant-1' } } };
  const result = await run(root, ['mcp', '--controlled-transfers'], { input: line(initialize) + line(prepare) + line({ ...prepare, id: 4 }) });
  expect(result.code).toBe(0);
  expect(jsonLines(result.stdout).map(value => value.id)).toEqual([1, 3, 4]);
  const held = jsonLines(result.stdout)[1].result.structuredContent;
  expect(held.state).toBe('awaiting_approval');
  expect(held.effect_executed).toBe(false);
  expect(held.reviewUrl).toContain('act-1');
  expect(f.requests.filter(request => request.method === 'POST')).toMatchObject([{ body: { kind: 'prepare' } }]);
  expect(f.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  expect(f.signatures).toEqual([true]);
  noSecrets(result);
});

it.each([262145, MAX_ENVELOPE_BYTES])('controlled MCP accepts a bounded %i-byte frame without side effects', async bytes => {
  const root = project(), f = await studio(); bundle(root, f.baseUrl, 'mcp');
  const request = { ...initialize, params: { ...initialize.params, evidence: '' } };
  request.params.evidence = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(request)));
  const result = await run(root, ['mcp', '--controlled-transfers'], { input: line(request) + line(list) });
  expect(result.code).toBe(0);
  expect(jsonLines(result.stdout).map(value => value.id)).toEqual([1, 2]);
  expect(f.requests).toEqual([]);
  noSecrets(result);
});

it.each(['{bad json}\n', 'x'.repeat(MAX_ENVELOPE_BYTES + 1) + '\n', '{"unterminated":', Buffer.from([0xff, 0x0a])])('controlled MCP rejects malformed or oversized framing without tool execution', async input => {
  const root = project(), f = await studio(); bundle(root, f.baseUrl, 'mcp');
  const result = await run(root, ['mcp', '--controlled-transfers'], { input });
  expect(result.code).toBe(1);
  expect(jsonLines(result.stdout)).toMatchObject([{ jsonrpc: '2.0', id: null, error: { code: expect.any(Number) } }]);
  expect(f.requests).toEqual([]);
  noSecrets(result);
});

it('controlled MCP refuses missing, weak or wrong-lane configuration before accepting frames', async () => {
  const f = await studio();
  for (const change of [null, { OSUITE_SIGNATURE_MODE: 'workspace_key_optional' }, { OSUITE_GUARD_FAILURE_MODE: 'allow', OSUITE_HOOK_MODE: 'strict' },
    { OSUITE_RUNTIME_ADAPTER_ID: 'codex_hooks' }, { OSUITE_BASE_URL: 'http://remote.invalid', OSUITE_ALLOW_INSECURE_HTTP: '1' }]) {
    const root = project();
    if (change) bundle(root, f.baseUrl, 'mcp', change);
    const result = await run(root, ['mcp', '--controlled-transfers'], { input: line(initialize) });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    noSecrets(result);
  }
  expect(f.requests).toEqual([]);
});

it('Node 24 is required for controlled CLI commands without changing ordinary version reporting', async () => {
  const root = project(), f = await studio(); bundle(root, f.baseUrl);
  const nodeArgs = ['--import', 'data:text/javascript,Object.defineProperty(process.versions,"node",{value:"22.0.0"})'];
  const strict = await run(root, ['doctor', '--controlled-transfers'], { nodeArgs });
  expect(strict.code).toBe(1);
  expect(strict.stdout).toContain('NODE_24_REQUIRED');
  const ordinary = await run(root, ['version'], { nodeArgs });
  expect(ordinary.code).toBe(0);
  expect(ordinary.stdout.trim()).toBe(JSON.parse(fs.readFileSync(path.resolve('sdk/package.json'), 'utf8')).version);
  expect(f.requests).toEqual([]);
});

it('controlled stdio dispatches different operations serially and leaves pending approval untouched', async () => {
  const root = project(), f = await studio(); bundle(root, f.baseUrl, 'mcp');
  const request = (id, name, args) => line({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const input = request(1, 'osuite_transfer_prepare', { operationId: 'operation-1', grantId: 'grant-1' })
    + request(2, 'osuite_transfer_status', { operationId: 'operation-1' })
    + request(3, 'osuite_transfer_prepare', { operationId: 'operation-2', grantId: 'grant-1' });
  const result = await run(root, ['mcp', '--controlled-transfers'], { input });
  expect(result.code).toBe(0);
  expect(jsonLines(result.stdout).map(value => value.id)).toEqual([1, 2, 3]);
  expect(f.requests.map(value => value.body?.kind || (value.url.includes('?') ? 'status' : 'capabilities')))
    .toEqual(['capabilities', 'prepare', 'status', 'capabilities', 'prepare']);
  expect(jsonLines(result.stdout)[1].result.structuredContent.effect_executed).toBe(null);
});

it('malformed stdio input stops rather than dispatching a queued valid mutation', async () => {
  const root = project(), f = await studio(); bundle(root, f.baseUrl, 'mcp');
  const prepare = line({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'osuite_transfer_prepare', arguments: { operationId: 'operation-1', grantId: 'grant-1' } } });
  const result = await run(root, ['mcp', '--controlled-transfers'], { input: '{malformed}\n' + prepare });
  expect(result.code).toBe(1);
  expect(jsonLines(result.stdout)).toHaveLength(1);
  expect(f.requests).toEqual([]);
});

it('malformed strict option spellings cannot fall back to ordinary doctor or dotenv loading', async () => {
  const root = project(), f = await studio();
  write(root, '.env', Object.entries(envFor(f.baseUrl)).map(([key, value]) => `${key}=${value}`).join('\n'));
  for (const flags of [['--controlled-transfers=false'], ['--controlled-transfers', 'false'], ['--require-controlled-transfers', '--runtime', 'codex']]) {
    const result = await run(root, ['doctor', ...flags]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    noSecrets(result);
  }
  expect(f.requests).toEqual([]);
});
