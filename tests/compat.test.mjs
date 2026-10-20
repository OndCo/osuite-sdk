import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { generateKeyPairSync, verify } from 'node:crypto';
import { OSuite } from '../sdk/osuite.js';
import { createApiClient, canonicalJson } from '../sdk/runtime/protocol.mjs';
import { writeCredentialFile, readCredentialFile } from '../sdk/credentials.js';
import { buildNodeRuntimeBootstrap, installProjectFile, findHookInstallations } from '../sdk/projectHooks.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const cleanEnv = home => ({ PATH: path.dirname(process.execPath) + path.delimiter + (process.platform === 'win32' ? process.env.PATH : '/usr/bin:/bin'), HOME: home, NO_COLOR: '1', OSUITE_NO_BROWSER: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'empty-git-config') });

test('minimum runtime exposes both ESM and CommonJS SDK entrypoints', () => {
  const require = createRequire(import.meta.url);
  assert.equal(typeof OSuite, 'function');
  assert.equal(typeof require('../sdk/index.cjs').OSuite, 'function');
});

test('CLI help works from a temporary project without npm dependencies or credentials', () => {
  const home = fs.mkdtempSync(path.join(tmpdir(), 'osuite-minimum-'));
  try {
    const result = spawnSync(process.execPath, [path.join(root, 'sdk/cli.js'), 'help'], { cwd: home, env: cleanEnv(home), encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /osuite connect/);
    assert.equal(fs.existsSync(path.join(home, '.claude')), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('protected credentials round-trip without world-readable plaintext', () => {
  const home = fs.mkdtempSync(path.join(tmpdir(), 'osuite-minimum-'));
  try {
    writeCredentialFile(home, '.osuite/.env', 'OSUITE_API_KEY=synthetic-compatibility-only\n');
    assert.equal(readCredentialFile(home, '.osuite/.env'), 'OSUITE_API_KEY=synthetic-compatibility-only\n');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(home, '.osuite/.env')).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(path.join(home, '.osuite/.gitignore'), 'utf8'), /\/\.env/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

for (const runtime of ['claude', 'codex']) {
  test(`${runtime} packaged install and missing-identity refusal use Node only`, () => {
    const home = fs.mkdtempSync(path.join(tmpdir(), 'osuite-minimum-'));
    try {
      const bundle = buildNodeRuntimeBootstrap(runtime, { runtime: { id: runtime }, files: {} }, { projectRoot: home });
      assert.equal(Object.keys(bundle.files).some(name => name.endsWith('.py')), false);
      for (const [name, value] of Object.entries(bundle.files)) installProjectFile(home, name, value);
      const hooks = findHookInstallations(home, [runtime]);
      assert.equal(hooks.length, 1);
      const directory = runtime === 'claude' ? '.claude' : '.codex';
      const child = spawnSync(process.execPath, [path.join(home, directory, 'hooks/osuite_pretool.mjs')], {
        cwd: home, env: cleanEnv(home), input: 'invalid-json', encoding: 'utf8', timeout: 10000,
      });
      assert.equal(child.status, 2, child.stderr);
      assert.equal(JSON.parse(child.stdout).hookSpecificOutput.permissionDecision, 'deny');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
}

test('real HTTP request carries a signature over the exact serialized object', async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyBase64 = Buffer.from(pair.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
  let verified = false;
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const bytes of request) raw += bytes;
    const { _signature, ...body } = JSON.parse(raw);
    verified = verify('sha256', Buffer.from(canonicalJson(body)), pair.publicKey, Buffer.from(_signature, 'base64'));
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"decision":"allow"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = createApiClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'synthetic-only', privateKeyBase64, signatureMode: 'required' });
    assert.equal((await client.request('POST', '/api/guard', { agent_id: 'synthetic', value: 42 })).ok, true);
    assert.equal(verified, true);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('native MCP bridge initializes and lists tools with Node only', () => {
  const home = fs.mkdtempSync(path.join(tmpdir(), 'osuite-minimum-'));
  try {
    const child = spawnSync(process.execPath, [path.join(root, 'plugins/osuite-codex-governance/server/osuite_runtime_mcp.mjs')], {
      cwd: home, env: cleanEnv(home), encoding: 'utf8', timeout: 10000,
      input: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n',
    });
    assert.equal(child.status, 0, child.stderr);
    const responses = child.stdout.trim().split('\n').map(JSON.parse);
    assert.equal(responses.length, 2);
    assert.equal(responses[0].result.protocolVersion, '2025-11-25');
    assert.equal(responses[1].result.tools.length, 7);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
