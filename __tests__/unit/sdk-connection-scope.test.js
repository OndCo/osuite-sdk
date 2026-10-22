import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getInstallationIdentity, migrateMcpInstallation, readMcpMigration } from '../../sdk/installationIdentity.js';
import { acquireCredentialLock } from '../../sdk/credentials.js';

const cli = path.resolve('sdk/cli.js');
// These cases run several real CLI processes and fsync credential files.
const integrationOptions = { timeout: 30_000 };
const processTimeout = 10_000;
const roots = [];
const children = new Map();
const servers = new Set();
let testSignal;
const paths = { sdk: '.osuite/.env', mcp: '.osuite/mcp/.env' };
const suffixes = ['', '.identity.json', '.connect.json'];
function project() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'osuite-connection-scope-'));
  roots.push(root);
  return root;
}
function write(root, file, body) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, file), body, { mode: 0o600 });
}
function read(root, file) {
  return fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file), 'utf8') : null;
}
function bundle(root, runtime) {
  return suffixes.map(suffix => read(root, `${paths[runtime]}${suffix}`));
}
function connect(root, runtime, url, { args = [], env = {}, processTimeoutMs = processTimeout } = {}) {
  return new Promise((resolve, reject) => {
    const signal = testSignal;
    signal.throwIfAborted();
    if (!roots.includes(root)) throw new Error('CLI test project has already been cleaned up');
    const child = spawn(process.execPath, [cli, 'connect', runtime, ...(url ? ['--base-url', url] : []),
      '--poll-timeout-ms', '60', '--poll-interval-ms', '10', ...args], {
      cwd: root, env: { PATH: process.env.PATH, HOME: root, OSUITE_NO_BROWSER: '1', NO_COLOR: '1',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...env },
    });
    children.set(child, new Promise(done => child.once('close', done)));
    let timedOut = false;
    let processError;
    const stop = () => child.kill('SIGKILL');
    const timer = setTimeout(() => { timedOut = true; stop(); }, processTimeoutMs);
    signal.addEventListener('abort', stop, { once: true });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.once('error', error => { processError = error; });
    child.once('close', code => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      children.delete(child);
      if (signal.aborted) reject(signal.reason);
      else if (timedOut) reject(Object.assign(new Error(`CLI test subprocess exceeded ${processTimeoutMs}ms (${runtime})`), { code: 'CLI_TEST_TIMEOUT' }));
      else if (processError) reject(processError);
      else resolve({ code, output });
    });
  });
}
async function studio(run) {
  const state = { starts: [], polls: [], acks: [], bootstraps: [], sessions: new Map(), active: new Map(), pending: false, failAck: false };
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    const url = `http://127.0.0.1:${server.address().port}`;
    const reply = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url.endsWith('/bootstrap')) {
      state.bootstraps.push(req.url);
      reply(200, { files: {} });
    } else if (req.url.endsWith('/start')) {
      state.starts.push(body);
      const scope = `${body.runtime}:${body.agent_id}`;
      const previous = state.active.get(scope);
      if ((previous && body.previous_key !== previous) || (!previous && body.previous_key)) {
        reply(409, { error: 'PREDECESSOR_REQUIRED_OR_WRONG' });
        return;
      }
      const id = state.starts.length;
      const session = { protocol_version: 2, device_code: `device-${id}`, poll_token: `poll-${id}`,
        user_code: `OS-${id}`, expires_in: 600, interval_seconds: 0 };
      state.sessions.set(session.device_code, { session, scope, credential: {
        protocol_version: 2, runtime: body.runtime, agent_id: body.agent_id, key_id: `key-${id}`, ack_token: `ack-${id}`,
        env: { OSUITE_BASE_URL: url, OSUITE_API_KEY: `synthetic-key-${id}`, OSUITE_AGENT_ID: body.agent_id,
          OSUITE_RUNTIME_ADAPTER_ID: body.runtime, OSUITE_PRIVATE_KEY_BASE64: `synthetic-private-${id}` },
      } });
      reply(201, session);
    } else if (req.url.endsWith('/poll')) {
      state.polls.push(body);
      if (state.pending) { reply(202, { status: 'pending' }); return; }
      const session = state.sessions.get(body.device_code);
      reply(200, { status: 'approved', protocol_version: 2, credential: session.credential });
    } else if (req.url.endsWith('/ack')) {
      state.acks.push(body);
      if (state.failAck) { reply(503, { error: 'synthetic transient failure' }); return; }
      const session = state.sessions.get(body.device_code);
      state.active.set(session.scope, session.credential.env.OSUITE_API_KEY);
      reply(200, { status: 'finalized', key_id: session.credential.key_id, active: true });
    } else { reply(404, {}); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let closing;
  const close = () => closing ??= new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  servers.add(close);
  try { await run(`http://127.0.0.1:${server.address().port}`, state); }
  finally { await close(); servers.delete(close); }
}
beforeEach(({ signal }) => { testSignal = signal; });
afterEach(async () => {
  const directories = roots.splice(0);
  const pending = [...children];
  for (const [child] of pending) child.kill('SIGKILL');
  for (const [, closed] of pending) await closed;
  for (const close of servers) await close();
  directories.forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});

describe('CLI test process lifecycle', () => {
  it('reaps a subprocess before reporting its test-only deadline', async () => {
    await studio(async (url, state) => {
      state.pending = true;
      await expect(connect(project(), 'sdk', url, { processTimeoutMs: 1 }))
        .rejects.toMatchObject({ code: 'CLI_TEST_TIMEOUT' });
      expect(children.size).toBe(0);
    });
  });
});

describe('requested runtime credential bundle', integrationOptions, () => {
  it.each([false, true])('rotates the SDK bundle with foreign runtime files present=%s', async foreign => {
    await studio(async (url, state) => {
      const root = project();
      expect((await connect(root, 'sdk', url)).code).toBe(0);
      const identity = read(root, `${paths.sdk}.identity.json`);
      const foreignBody = 'OSUITE_BASE_URL=https://foreign.example.invalid\nOSUITE_API_KEY=foreign-key\nOSUITE_AGENT_ID=foreign-agent\nOSUITE_RUNTIME_ADAPTER_ID=codex_hooks\n';
      if (foreign) write(root, '.codex/.env', foreignBody);
      const result = await connect(root, 'sdk', null);
      expect(result.code, result.output).toBe(0);
      expect(state.starts).toHaveLength(2);
      expect(state.starts[1]).toMatchObject({ runtime: 'sdk', agent_id: state.starts[0].agent_id, previous_key: 'synthetic-key-1' });
      expect(read(root, `${paths.sdk}.identity.json`)).toBe(identity);
      if (foreign) expect(read(root, '.codex/.env')).toBe(foreignBody);
      expect(result.output).not.toMatch(/synthetic-key|foreign-key/);
    });
  });

  it('uses the complete requested project bundle instead of inherited shell credentials', async () => {
    await studio(async (url, state) => {
      const root = project();
      expect((await connect(root, 'sdk', url)).code).toBe(0);
      const result = await connect(root, 'sdk', null, { env: {
        OSUITE_BASE_URL: 'https://foreign.example.invalid', OSUITE_API_KEY: 'foreign-shell-key',
        OSUITE_AGENT_ID: 'foreign-shell-agent', OSUITE_RUNTIME_ADAPTER_ID: 'codex_hooks',
      } });
      expect(result.code, result.output).toBe(0);
      expect(state.starts[1]).toMatchObject({ agent_id: state.starts[0].agent_id, previous_key: 'synthetic-key-1' });
    });
  });

  it.each([
    ['codex', 'codex_hooks', '/api/runtimes/codex/bootstrap'],
    ['claude', 'claude_code_hooks', '/api/runtimes/claude-code/bootstrap'],
    ['cursor', 'cursor_hooks', '/api/runtimes/cursor/bootstrap'],
  ])('uses the requested %s project origin for bootstrap as well as enrollment', async (runtime, adapter, endpoint) => {
    await studio(async (url, state) => {
      await studio(async (foreignUrl, foreign) => {
        const root = project();
        const file = `.${runtime}/.env`;
        const original = `OSUITE_BASE_URL=${url}\nOSUITE_API_KEY=bootstrap-key\nOSUITE_AGENT_ID=bootstrap-agent\nOSUITE_RUNTIME_ADAPTER_ID=${adapter}\n`;
        write(root, file, original);
        state.active.set(`${runtime}:bootstrap-agent`, 'bootstrap-key');
        state.pending = true;
        const result = await connect(root, runtime, null, { env: { OSUITE_BASE_URL: foreignUrl } });
        expect(result.code).toBe(1);
        expect(result.output).toContain('resume this same pending connection');
        expect(state.starts[0]).toMatchObject({ runtime, agent_id: 'bootstrap-agent', previous_key: 'bootstrap-key' });
        expect(state.bootstraps).toEqual([endpoint]);
        expect(foreign.bootstraps).toEqual([]);
        expect(foreign.starts).toEqual([]);
        expect(state.acks).toEqual([]);
        expect(read(root, file)).toBe(original);
      });
    });
  });

  it('does not fill a missing SDK predecessor from another runtime', async () => {
    await studio(async (url, state) => {
      const root = project();
      write(root, paths.sdk, `OSUITE_BASE_URL=${url}\nOSUITE_AGENT_ID=sdk-existing\nOSUITE_RUNTIME_ADAPTER_ID=sdk\n`);
      write(root, '.codex/.env', 'OSUITE_API_KEY=foreign-key\n');
      state.pending = true;
      await connect(root, 'sdk', url);
      expect(state.starts).toHaveLength(1);
      expect(state.starts[0].agent_id).toBe('sdk-existing');
      expect(state.starts[0].previous_key).toBeUndefined();
    });
  });

  it('preserves legacy first-nonempty dotenv values within the chosen bundle', async () => {
    await studio(async (url, state) => {
      const root = project();
      expect((await connect(root, 'sdk', url)).code).toBe(0);
      const original = read(root, paths.sdk);
      write(root, paths.sdk, `OSUITE_BASE_URL=\nOSUITE_API_KEY=\n${original}OSUITE_API_KEY=ignored-later-key\n`);
      const result = await connect(root, 'sdk', url);
      expect(result.code, result.output).toBe(0);
      expect(state.starts).toHaveLength(2);
      expect(state.starts[1].previous_key).toBe('synthetic-key-1');
    });
  });

  it.each(['project', 'shell', 'root env'])('retains an explicitly SDK-scoped legacy alias bundle from %s', async source => {
    await studio(async (url, state) => {
      const root = project();
      const legacy = { DASHCLAW_BASE_URL: url, DASHCLAW_API_KEY: 'legacy-sdk-key', DASHCLAW_AGENT_ID: 'legacy-sdk-agent', OSUITE_RUNTIME_ADAPTER_ID: 'sdk' };
      state.active.set('sdk:legacy-sdk-agent', 'legacy-sdk-key');
      if (source !== 'shell') write(root, source === 'project' ? paths.sdk : '.env', Object.entries(legacy).map(([key, value]) => `${key}=${value}`).join('\n'));
      const result = await connect(root, 'sdk', null, { env: source === 'shell' ? legacy : {} });
      expect(result.code, result.output).toBe(0);
      expect(state.starts[0]).toMatchObject({ runtime: 'sdk', agent_id: 'legacy-sdk-agent', previous_key: 'legacy-sdk-key' });
      expect(read(root, paths.sdk)).toContain('OSUITE_AGENT_ID=legacy-sdk-agent');
      expect(result.output).not.toContain('legacy-sdk-key');
    });
  });

  it('does not send a valid SDK predecessor to a different requested origin', async () => {
    await studio(async (originalUrl, original) => {
      const root = project();
      expect((await connect(root, 'sdk', originalUrl)).code).toBe(0);
      await studio(async (otherUrl, other) => {
        other.pending = true;
        const result = await connect(root, 'sdk', otherUrl);
        expect(result.code).toBe(1);
        expect(other.starts[0].previous_key).toBeUndefined();
        expect(read(root, paths.sdk)).toContain(`OSUITE_BASE_URL=${originalUrl}`);
        expect(original.acks).toHaveLength(1);
      });
    });
  });
});

function configuredSdk(root, source, url, agentId = 'old-agent') {
  const env = { OSUITE_BASE_URL: url, OSUITE_API_KEY: 'synthetic-configured-key',
    OSUITE_AGENT_ID: agentId, OSUITE_RUNTIME_ADAPTER_ID: 'sdk' };
  if (source !== 'shell') write(root, source === 'project' ? paths.sdk : '.env',
    Object.entries(env).map(([key, value]) => `${key}=${value}\n`).join(''));
  return { env: source === 'shell' ? env : {} };
}

describe('fresh explicit agent selection and scoped recovery', integrationOptions, () => {
  it.each(['shell', 'root env', 'project'])('enrolls an explicitly selected agent instead of the configured %s agent', async source => {
    await studio(async (url, state) => {
      const root = project();
      const options = configuredSdk(root, source, url);
      state.active.set('sdk:old-agent', 'synthetic-configured-key');
      const result = await connect(root, 'sdk', null, { ...options, args: ['--agent-id', 'new-agent'] });
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain('Browser handoff');
      expect(state.starts).toHaveLength(1);
      expect(state.starts[0]).toMatchObject({ runtime: 'sdk', agent_id: 'new-agent' });
      expect(state.starts[0].previous_key).toBeUndefined();
      expect(state.polls.length).toBeGreaterThan(0);
      expect(state.acks).toHaveLength(1);
      expect(state.active.get('sdk:old-agent')).toBe('synthetic-configured-key');
      expect(read(root, paths.sdk)).toContain('OSUITE_AGENT_ID=new-agent');
      expect(read(root, `${paths.sdk}.connect.json`)).toBeNull();
    });
  });

  it.each(['shell', 'root env'])('reuses one explicit handoff across repeated %s retries and eventual approval', async source => {
    await studio(async (url, state) => {
      const root = project();
      const options = configuredSdk(root, source, url);
      const originalRootEnv = read(root, '.env');
      state.active.set('sdk:old-agent', 'synthetic-configured-key');
      state.pending = true;
      const explicit = { ...options, args: ['--agent-id', 'new-agent'] };
      const first = await connect(root, 'sdk', null, explicit);
      const second = await connect(root, 'sdk', null, explicit);
      expect(state.starts).toHaveLength(1);
      for (const result of [first, second]) {
        expect(result.code).toBe(1);
        expect(result.output).toContain('Browser handoff');
        expect(result.output).toContain('resume this same pending connection');
        expect(result.output).not.toMatch(/conflict|synthetic-configured-key/);
      }
      const pending = bundle(root, 'sdk');
      const receipt = JSON.parse(pending[2]);
      expect(receipt.agent_id).toBe('new-agent');
      expect(receipt.live_env_sha256).toBeNull();
      expect(pending[2]).not.toContain('synthetic-configured-key');
      const polls = state.polls.length;
      const implicitRetry = await connect(root, 'sdk', null, options);
      expect(implicitRetry.code, implicitRetry.output).toBe(1);
      expect(implicitRetry.output).toContain('resume this same pending connection');
      expect(state.starts).toHaveLength(1);
      expect(state.polls.length).toBeGreaterThan(polls);
      expect(bundle(root, 'sdk')).toEqual(pending);
      expect(state.acks).toHaveLength(0);
      state.pending = false;
      const approved = await connect(root, 'sdk', null, options);
      expect(approved.code, approved.output).toBe(0);
      expect(state.starts).toHaveLength(1);
      expect(state.starts[0].previous_key).toBeUndefined();
      expect(state.acks).toHaveLength(1);
      expect(state.acks[0].device_code).toBe(receipt.session.device_code);
      expect(state.active.get('sdk:old-agent')).toBe('synthetic-configured-key');
      expect(read(root, paths.sdk)).toContain('OSUITE_AGENT_ID=new-agent');
      expect(read(root, `${paths.sdk}.identity.json`)).toBe(pending[1]);
      expect(read(root, `${paths.sdk}.connect.json`)).toBeNull();
      expect(read(root, '.env')).toBe(originalRootEnv);
    });
  });

  it.each(['shell', 'root env'])('resumes an ACK-interrupted explicit %s selection without another enrollment', async source => {
    await studio(async (url, state) => {
      const root = project();
      const options = configuredSdk(root, source, url);
      state.active.set('sdk:old-agent', 'synthetic-configured-key');
      state.failAck = true;
      const explicit = { ...options, args: ['--agent-id', 'new-agent'] };
      const first = await connect(root, 'sdk', null, explicit);
      expect(first.code).toBe(1);
      expect(first.output).toContain('Could not confirm finalization');
      const saved = bundle(root, 'sdk');
      const receipt = JSON.parse(saved[2]);
      expect(saved[0]).toBeNull();
      expect(receipt.credential.agent_id).toBe('new-agent');
      expect(state.starts).toHaveLength(1);
      expect(state.acks).toHaveLength(3);
      const polls = state.polls.length;
      state.failAck = false;
      const resumed = await connect(root, 'sdk', null, explicit);
      expect(resumed.code, resumed.output).toBe(0);
      expect(state.starts).toHaveLength(1);
      expect(state.polls).toHaveLength(polls);
      expect(state.acks).toHaveLength(4);
      expect(state.acks.every(ack => ack.device_code === receipt.session.device_code)).toBe(true);
      expect(state.active.get('sdk:old-agent')).toBe('synthetic-configured-key');
      expect(read(root, `${paths.sdk}.identity.json`)).toBe(saved[1]);
      expect(read(root, `${paths.sdk}.connect.json`)).toBeNull();
    });
  });

  it.each(['shell', 'root env'])('does not let an explicit flag bypass a conflicting older %s journal', async source => {
    await studio(async (url, state) => {
      const root = project();
      state.pending = true;
      const first = await connect(root, 'sdk', url, { env: {
        OSUITE_AGENT_ID: 'journal-agent', OSUITE_RUNTIME_ADAPTER_ID: 'sdk',
      } });
      expect(first.output).toContain('resume this same pending connection');
      const saved = bundle(root, 'sdk');
      const options = configuredSdk(root, source, url);
      const polls = state.polls.length;
      const result = await connect(root, 'sdk', null, { ...options, args: ['--agent-id', 'journal-agent'] });
      expect(result.code).toBe(1);
      expect(result.output).toContain('conflicts with the configured agent');
      expect(state.starts).toHaveLength(1);
      expect(state.polls).toHaveLength(polls);
      expect(state.acks).toHaveLength(0);
      expect(bundle(root, 'sdk')).toEqual(saved);
    });
  });

  it.each([
    ['shell', 'configured agent'], ['root env', 'configured agent'],
    ['shell', 'explicit target'], ['root env', 'explicit target'],
  ])('rejects a resumed explicit selection when its %s %s changes', async (source, change) => {
    await studio(async (url, state) => {
      const root = project();
      let options = configuredSdk(root, source, url);
      state.pending = true;
      const first = await connect(root, 'sdk', null, { ...options, args: ['--agent-id', 'new-agent'] });
      expect(first.output).toContain('resume this same pending connection');
      const saved = bundle(root, 'sdk');
      const polls = state.polls.length;
      if (change === 'configured agent') options = configuredSdk(root, source, url, 'another-agent');
      const result = await connect(root, 'sdk', null, { ...options,
        args: ['--agent-id', change === 'explicit target' ? 'another-agent' : 'new-agent'] });
      expect(result.code).toBe(1);
      expect(result.output).toMatch(/conflict|different connection/);
      expect(state.starts).toHaveLength(1);
      expect(state.polls).toHaveLength(polls);
      expect(state.acks).toHaveLength(0);
      expect(bundle(root, 'sdk')).toEqual(saved);
    });
  });
});

describe('separate SDK and MCP connection namespaces', integrationOptions, () => {
  it.each([['sdk', 'mcp'], ['mcp', 'sdk']])('enrolls and rotates %s then %s without replacing the other bundle', async (first, second) => {
    await studio(async (url, state) => {
      const root = project();
      const one = await connect(root, first, url);
      expect(one.code, one.output).toBe(0);
      const initial = bundle(root, first);
      const two = await connect(root, second, url);
      expect(two.code, two.output).toBe(0);
      expect(bundle(root, first)).toEqual(initial);
      const other = bundle(root, second);
      expect(JSON.parse(initial[1]).installation_id).not.toBe(JSON.parse(other[1]).installation_id);
      expect(JSON.parse(initial[1]).agent_id).not.toBe(JSON.parse(other[1]).agent_id);
      expect(initial[0]).not.toBe(other[0]);
      const again = await connect(root, first, null);
      expect(again.code, again.output).toBe(0);
      expect(bundle(root, second)).toEqual(other);
      expect(state.starts[2].previous_key).toBe('synthetic-key-1');
      for (const runtime of ['sdk', 'mcp']) {
        expect(fs.statSync(path.join(root, paths[runtime])).mode & 0o777).toBe(0o600);
        expect(read(root, `${paths[runtime]}.connect.json`)).toBeNull();
      }
    });
  });

  it('keeps two pending journals distinct and resumes only the requested runtime', async () => {
    await studio(async (url, state) => {
      const root = project();
      state.pending = true;
      await connect(root, 'sdk', url);
      const sdk = bundle(root, 'sdk');
      await connect(root, 'mcp', url);
      const mcp = bundle(root, 'mcp');
      expect(state.starts).toHaveLength(2);
      expect(sdk[2]).toBeTruthy();
      expect(mcp[2]).toBeTruthy();
      expect(sdk[2]).not.toBe(mcp[2]);
      expect(bundle(root, 'sdk')).toEqual(sdk);
      state.pending = false;
      const result = await connect(root, 'mcp', url);
      expect(result.code, result.output).toBe(0);
      expect(state.starts).toHaveLength(2);
      expect(bundle(root, 'sdk')).toEqual(sdk);
      expect(state.acks[0].device_code).toBe(JSON.parse(mcp[2]).session.device_code);
    });
  });
});

function legacyMcp(root, url, state, { receipt = false } = {}) {
  const identity = getInstallationIdentity(root, paths.sdk, 'mcp');
  write(root, paths.sdk, `OSUITE_BASE_URL=${url}\nOSUITE_API_KEY=legacy-mcp-key\nOSUITE_AGENT_ID=${identity.agent_id}\nOSUITE_RUNTIME_ADAPTER_ID=mcp\n`);
  state.active.set(`mcp:${identity.agent_id}`, 'legacy-mcp-key');
  if (receipt) {
    const session = { protocol_version: 2, device_code: 'legacy-device', poll_token: 'legacy-poll', user_code: 'OS-LEGACY', expires_in: 600 };
    const credential = { protocol_version: 2, runtime: 'mcp', agent_id: identity.agent_id,
      key_id: 'legacy-successor', ack_token: 'legacy-ack', env: {
        OSUITE_BASE_URL: url, OSUITE_API_KEY: 'legacy-successor-key', OSUITE_AGENT_ID: identity.agent_id,
        OSUITE_RUNTIME_ADAPTER_ID: 'mcp', OSUITE_PRIVATE_KEY_BASE64: 'legacy-successor-private',
      } };
    state.sessions.set(session.device_code, { session, credential, scope: `mcp:${identity.agent_id}` });
    write(root, `${paths.sdk}.connect.json`, `${JSON.stringify({ protocol_version: 2, base_url: url, runtime: 'mcp',
      agent_id: identity.agent_id, installation_id: identity.installation_id, session, credential })}\n`);
  }
  return identity;
}

describe('explicit legacy MCP migration', integrationOptions, () => {
  it('refuses implicit migration or SDK takeover of legacy MCP credentials', async () => {
    await studio(async (url, state) => {
      const root = project();
      legacyMcp(root, url, state);
      const original = bundle(root, 'sdk');
      for (const runtime of ['mcp', 'sdk']) {
        const result = await connect(root, runtime, url);
        expect(result.code).toBe(1);
        expect(result.output).toContain('connect mcp --migrate-legacy');
        expect(bundle(root, 'sdk')).toEqual(original);
        expect(bundle(root, 'mcp')).toEqual([null, null, null]);
      }
      expect(state.starts).toHaveLength(0);
      expect(state.acks).toHaveLength(0);
    });
  });

  it.each([false, true])('moves the legacy bundle locally, without ACK or enrollment (saved receipt=%s)', async receipt => {
    await studio(async (url, state) => {
      const root = project();
      const identity = legacyMcp(root, url, state, { receipt });
      const original = bundle(root, 'sdk');
      const result = await connect(root, 'mcp', url, { args: ['--migrate-legacy'] });
      expect(result.code, result.output).toBe(0);
      expect(result.output).toMatch(/migration.*complete/i);
      expect(result.output).not.toMatch(/legacy-mcp-key|legacy-successor-private|Connected to OSuite/);
      expect(state.starts).toHaveLength(0);
      expect(state.acks).toHaveLength(0);
      expect(bundle(root, 'sdk')).toEqual([null, null, null]);
      expect(bundle(root, 'mcp')).toEqual(original);
      expect(read(root, '.osuite/.env.migrate-mcp.json')).toBeNull();
      for (const suffix of suffixes.filter((_, index) => original[index] !== null)) {
        expect(fs.statSync(path.join(root, `${paths.mcp}${suffix}`)).mode & 0o777).toBe(0o600);
      }
      const sdk = await connect(root, 'sdk', url);
      expect(sdk.code, sdk.output).toBe(0);
      const sdkBundle = bundle(root, 'sdk');
      expect(bundle(root, 'mcp')).toEqual(original);
      const mcp = await connect(root, 'mcp', url);
      expect(mcp.code, mcp.output).toBe(0);
      expect(bundle(root, 'sdk')).toEqual(sdkBundle);
      expect(JSON.parse(read(root, `${paths.mcp}.identity.json`))).toEqual(identity);
      expect(state.starts).toHaveLength(receipt ? 1 : 2);
      if (receipt) expect(state.acks[1].device_code).toBe('legacy-device');
      else expect(state.starts[1]).toMatchObject({ agent_id: identity.agent_id, previous_key: 'legacy-mcp-key' });
    });
  });

  it.each(suffixes)('refuses to overwrite an occupied destination %s', async suffix => {
    await studio(async (url, state) => {
      const root = project();
      legacyMcp(root, url, state);
      write(root, `${paths.mcp}${suffix}`, 'occupied destination\n');
      const original = bundle(root, 'sdk');
      const destination = bundle(root, 'mcp');
      const result = await connect(root, 'mcp', url, { args: ['--migrate-legacy'] });
      expect(result.code).toBe(1);
      expect(result.output).toMatch(/destination|occupied|already exists/i);
      expect(bundle(root, 'sdk')).toEqual(original);
      expect(bundle(root, 'mcp')).toEqual(destination);
      expect(state.starts).toHaveLength(0);
      expect(state.acks).toHaveLength(0);
      expect(read(root, '.osuite/.env.migrate-mcp.json')).toBeNull();
    });
  });

  it('rejects a legacy journal/live conflict before moving or acknowledging anything', async () => {
    await studio(async (url, state) => {
      const root = project();
      legacyMcp(root, url, state, { receipt: true });
      const env = read(root, paths.sdk).replace(/OSUITE_AGENT_ID=[^\n]+/, 'OSUITE_AGENT_ID=another-live-agent');
      write(root, paths.sdk, env);
      const original = bundle(root, 'sdk');
      const result = await connect(root, 'mcp', url, { args: ['--migrate-legacy'] });
      expect(result.code).toBe(1);
      expect(result.output).toMatch(/conflict|recovery/i);
      expect(bundle(root, 'sdk')).toEqual(original);
      expect(bundle(root, 'mcp')).toEqual([null, null, null]);
      expect(state.acks).toHaveLength(0);
      expect(state.starts).toHaveLength(0);
      expect(read(root, '.osuite/.env.migrate-mcp.json')).toBeNull();
    });
  });

  it('requires an explicit retry after interruption and resumes the same move without copying secrets', async () => {
    await studio(async (url, state) => {
      const root = project();
      legacyMcp(root, url, state, { receipt: true });
      const original = bundle(root, 'sdk');
      const releases = [acquireCredentialLock(root, paths.sdk), acquireCredentialLock(root, paths.mcp)];
      const rename = fs.renameSync;
      const movedEnv = path.join(fs.realpathSync(root), paths.sdk);
      const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        rename(from, to);
        if (from === movedEnv) throw new Error('simulated process interruption after rename');
      });
      try {
        expect(() => migrateMcpInstallation(root, readMcpMigration(root))).toThrow('simulated process interruption');
      } finally { spy.mockRestore(); releases.reverse().forEach(release => release()); }
      expect(read(root, paths.sdk)).toBeNull();
      expect(read(root, paths.mcp)).toBe(original[0]);
      expect(read(root, `${paths.sdk}.identity.json`)).toBe(original[1]);
      const marker = read(root, '.osuite/.env.migrate-mcp.json');
      expect(marker).toBeTruthy();
      expect(marker).not.toMatch(/legacy-mcp-key|legacy-successor-private|legacy-ack/);
      const partialSource = bundle(root, 'sdk');
      const partialDestination = bundle(root, 'mcp');
      for (const runtime of ['sdk', 'mcp']) {
        const refusal = await connect(root, runtime, url);
        expect(refusal.code).toBe(1);
        expect(refusal.output).toContain('connect mcp --migrate-legacy');
        expect(bundle(root, 'sdk')).toEqual(partialSource);
        expect(bundle(root, 'mcp')).toEqual(partialDestination);
        expect(read(root, '.osuite/.env.migrate-mcp.json')).toBe(marker);
      }
      const retry = await connect(root, 'mcp', url, { args: ['--migrate-legacy'] });
      expect(retry.code, retry.output).toBe(0);
      expect(bundle(root, 'sdk')).toEqual([null, null, null]);
      expect(bundle(root, 'mcp')).toEqual(original);
      expect(read(root, '.osuite/.env.migrate-mcp.json')).toBeNull();
      expect(state.starts).toHaveLength(0);
      expect(state.acks).toHaveLength(0);
    });
  });

  it.each(['unknown', 'sdk'])('refuses ambiguous or non-MCP legacy ownership (%s)', async owner => {
    await studio(async (url, state) => {
      const root = project();
      write(root, paths.sdk, `OSUITE_BASE_URL=${url}\nOSUITE_API_KEY=do-not-copy\nOSUITE_AGENT_ID=legacy-agent\n${owner === 'sdk' ? 'OSUITE_RUNTIME_ADAPTER_ID=sdk\n' : ''}`);
      const original = bundle(root, 'sdk');
      const result = await connect(root, 'mcp', url, { args: ['--migrate-legacy'] });
      expect(result.code).toBe(1);
      expect(result.output).toMatch(/unambiguous|conflict/i);
      expect(bundle(root, 'sdk')).toEqual(original);
      expect(bundle(root, 'mcp')).toEqual([null, null, null]);
      expect(state.starts).toHaveLength(0);
      expect(state.acks).toHaveLength(0);
    });
  });

  it.each(['sdk', 'mcp'])('refuses a normal %s connect while shared legacy live ownership is ambiguous', async runtime => {
    await studio(async (url, state) => {
      const root = project();
      write(root, paths.sdk, `OSUITE_BASE_URL=${url}\nOSUITE_API_KEY=ambiguous-live-key\nOSUITE_AGENT_ID=legacy-live-agent\n`);
      const original = bundle(root, 'sdk');
      const result = await connect(root, runtime, url);
      expect(result.code).toBe(1);
      expect(result.output).toMatch(/ambiguous|declare.*runtime/i);
      expect(state.starts).toHaveLength(0);
      expect(state.acks).toHaveLength(0);
      expect(bundle(root, 'sdk')).toEqual(original);
      expect(bundle(root, 'mcp')).toEqual([null, null, null]);
    });
  });

  it('moves a pre-metadata MCP env without inventing or duplicating its live identity', async () => {
    await studio(async (url, state) => {
      const root = project();
      const original = `OSUITE_BASE_URL=${url}\nOSUITE_API_KEY=legacy-mcp-key\nOSUITE_AGENT_ID=legacy-mcp-agent\nOSUITE_RUNTIME_ADAPTER_ID=mcp\n`;
      write(root, paths.sdk, original);
      state.active.set('mcp:legacy-mcp-agent', 'legacy-mcp-key');
      const migrated = await connect(root, 'mcp', url, { args: ['--migrate-legacy'] });
      expect(migrated.code, migrated.output).toBe(0);
      expect(bundle(root, 'sdk')).toEqual([null, null, null]);
      expect(bundle(root, 'mcp')).toEqual([original, null, null]);
      expect(state.starts).toHaveLength(0);
      const reconnected = await connect(root, 'mcp', url);
      expect(reconnected.code, reconnected.output).toBe(0);
      expect(state.starts[0]).toMatchObject({ agent_id: 'legacy-mcp-agent', previous_key: 'legacy-mcp-key' });
      expect(read(root, paths.mcp)).toContain('OSUITE_AGENT_ID=legacy-mcp-agent');
    });
  });
});
