import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildNodeRuntimeBootstrap, findHookInstallations, installProjectFile, runHookCheck } from '../../sdk/projectHooks.js';

// This fixture deliberately does not import server routes, event mappers,
// transport/signing code, or admission helpers from the implementation.
const canonical = value => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
const hash = value => createHash('sha256').update(value).digest('hex');
async function child(command, root, env, input) {
  return new Promise((resolve, reject) => {
    const process = spawn('/bin/sh', ['-c', command], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { process.kill('SIGKILL'); reject(new Error('Fixture child exceeded 10s')); }, 10000);
    process.stdout.on('data', data => { stdout += data; });
    process.stderr.on('data', data => { stderr += data; });
    process.on('error', error => { clearTimeout(timer); reject(error); });
    process.on('close', code => { clearTimeout(timer); resolve({ code, stdout: JSON.parse(stdout), stderr }); });
    process.stdin.on('error', () => {});
    process.stdin.end(JSON.stringify(input));
  });
}

async function fixture(host = 'cursor', options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'osuite-native-wire-'));
  const runtimeId = host === 'cursor' ? 'cursor_hooks' : 'codex_plugin';
  const apiKey = 'synthetic-native-wire-key', agent = 'native-wire-agent';
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const events = [], requests = [], signed = [];
  let actionPosts = 0, outcomePatches = 0, context;
  const decision = options.decision || 'allow';
  const mode = options.mode || 'enforce';
  const actionResponse = ({ pending = false, approved = false, redeemed = false } = {}) => {
    const action = { action_id: 'act-native-wire', agent_id: agent, status: pending ? 'pending_approval' : 'running', timestamp_end: null,
      action_envelope: { runtime_session_id: context.runtime_session_id, tool_use_id: context.tool_use_id,
        cava: { fingerprint: hash(context.tool_input_digest) } } };
    let approval;
    if (approved) {
      const now = Date.now();
      Object.assign(action, { approval_decision: 'allow', approved_by: 'fixture-reviewer', approved_at: new Date(now - 2000).toISOString(),
        approval_redeemed_at: redeemed ? new Date(now - 1000).toISOString() : null, approval_expires_at: new Date(now + 60000).toISOString() });
      approval = { state: 'approved', reused: redeemed, decided_by: action.approved_by, decided_at: action.approved_at, expires_at: action.approval_expires_at };
    } else if (pending) approval = { state: 'pending', reused: false };
    return { action_id: action.action_id, action, decision: { decision }, ...(approval ? { approval } : {}), contracts: { action_envelope: action.action_envelope } };
  };
  const server = createServer(async (request, response) => {
    const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      const value = body ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== '_signature')) : null;
      requests.push({ method: request.method, path: request.url, body: value });
      if (request.headers['x-api-key'] !== apiKey) return send(401, { error: 'fixture key rejected' });
      if (body) {
        const valid = typeof body._signature === 'string' && verify('sha256', Buffer.from(canonical(value)), keys.publicKey, Buffer.from(body._signature, 'base64'));
        signed.push(valid); if (!valid) return send(401, { error: 'fixture signature rejected' });
      }
      if (request.url.startsWith(`/api/runtimes/${runtimeId}/posture?`)) {
        const now = Date.now();
        return send(200, { schema_version: 'osuite.runtime_posture.v1', org_id: 'org-native-fixture', runtime_id: runtimeId,
          credential_id: 'key-native-fixture', credential_fingerprint: options.badPosture ? 'wrong-key' : hash(apiKey),
          targeting: { agent_id: agent, provider: null }, revision: hash(mode), issued_at: new Date(now).toISOString(), valid_until: new Date(now + 60000).toISOString(),
          posture: { runtime_id: runtimeId, mode, on_guard_unavailable: 'block', require_signature: true,
            require_assumption_capture: false, approval_timeout_seconds: 600 } });
      }
      if (request.url === '/api/runtime-sessions') return send(200, { runtime_session: { runtime_session_id: value.runtime_session_id } });
      if (request.url.includes('/events')) {
        if (request.method === 'GET') return send(200, { items: events });
        events.push(value); return send(200, { ok: true, event: value });
      }
      if (request.url === '/api/guard') return send(200, { decision });
      if (request.url === '/api/actions' && request.method === 'POST') {
        actionPosts++; context = value;
        if (options.lostAdmission || (options.lostRedemption && actionPosts === 2)) { request.socket.destroy(); return; }
        return send(200, actionResponse(decision.startsWith('require_')
          ? { pending: actionPosts === 1, approved: actionPosts > 1, redeemed: actionPosts > 1 } : {}));
      }
      if (request.url === '/api/actions/act-native-wire' && request.method === 'GET') return send(200, actionResponse({ approved: true }));
      if (request.url === '/api/actions/act-native-wire' && request.method === 'PATCH') {
        outcomePatches++;
        return send(200, { action: { ...value, action_id: options.lostOutcomeAck && outcomePatches === 1 ? 'wrong-ack' : 'act-native-wire' } });
      }
      return send(404, { error: 'unexpected fixture endpoint' });
    } catch { send(500, { error: 'invalid fixture request' }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { HOME: root, TMPDIR: root, PATH: path.dirname(process.execPath), OSUITE_STATE_DIR: path.join(root, 'state'),
    OSUITE_API_KEY: apiKey, OSUITE_BASE_URL: `http://127.0.0.1:${server.address().port}`, OSUITE_AGENT_ID: agent,
    OSUITE_APPROVAL_WAIT_SECONDS: options.review ? '4' : '0', OSUITE_SIGNATURE_MODE: 'required', OSUITE_HOOK_MODE: mode,
    ...(options.noSigner ? {} : { OSUITE_PRIVATE_KEY_BASE64: Buffer.from(keys.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64') }) };
  let commands;
  if (host === 'cursor') {
    const bundle = buildNodeRuntimeBootstrap('cursor', {}, { projectRoot: root });
    for (const [name, body] of Object.entries(bundle.files)) installProjectFile(root, name, body);
    commands = JSON.parse(bundle.files['.cursor/hooks.json']).hooks;
    writeFileSync(path.join(root, '.cursor/.env'), `OSUITE_BASE_URL=${env.OSUITE_BASE_URL}\nOSUITE_API_KEY=${apiKey}\n`, { mode: 0o600 });
    writeFileSync(path.join(root, '.cursor/.gitignore'), '.env\n');
  } else {
    const plugin = path.join(root, 'detached plugin'); mkdirSync(plugin);
    const source = path.resolve('plugins/osuite-codex-governance');
    for (const name of ['hooks.json', '.mcp.json', 'hooks/osuite_runtime.mjs', 'hooks/osuite_pretool.mjs', 'hooks/osuite_posttool.mjs', 'hooks/osuite_session.mjs', 'server/osuite_runtime_mcp.mjs']) {
      mkdirSync(path.dirname(path.join(plugin, name)), { recursive: true }); cpSync(path.join(source, name), path.join(plugin, name));
    }
    env.PLUGIN_ROOT = plugin;
    commands = Object.fromEntries(Object.entries(JSON.parse(readFileSync(path.join(plugin, 'hooks.json'))).hooks).map(([event, groups]) => [event, groups[0].hooks]));
  }
  const marker = path.join(root, 'tool-must-not-execute');
  const toolInput = { command: `printf fixture > "${marker}"` };
  const baseInput = { cwd: root, tool_name: host === 'cursor' ? 'Shell' : 'Bash', tool_use_id: 'native-tool', tool_input: toolInput,
    ...(host === 'cursor' ? { conversation_id: 'native-session', generation_id: 'native-generation' } : { session_id: 'native-session' }) };
  const names = host === 'cursor' ? { pre: 'preToolUse', post: 'postToolUse', failure: 'postToolUseFailure' } : { pre: 'PreToolUse', post: 'PostToolUse' };
  return { root, marker, env, requests, signed, events, toolInput,
    run: (phase, extra = {}) => child(commands[names[phase]][0].command, root, env, { ...baseInput, hook_event_name: names[phase], ...extra }),
    doctor: () => runHookCheck({ projectRoot: root, installation: findHookInstallations(root, ['cursor'])[0], shellEnv: env, timeoutMs: 10000 }),
    close: async () => { await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); },
  };
}

describe('Independent native host wire fixtures (not live host/model sessions)', () => {
  it.each(['cursor', 'codex-plugin'])('%s selected commands sign real HTTP and bind the exact input without executing it', async host => {
    const f = await fixture(host);
    try {
      const pre = await f.run('pre');
      expect(pre.code, pre.stderr).toBe(0);
      if (host === 'cursor') expect(pre.stdout).toEqual({ permission: 'allow' });
      expect(f.signed.length).toBeGreaterThan(3); expect(f.signed.every(Boolean)).toBe(true);
      const action = f.requests.find(call => call.path === '/api/actions').body;
      expect(action.tool_input_digest).toBe(hash(canonical({ tool_name: host === 'cursor' ? 'Shell' : 'Bash', tool_input: f.toolInput })));
      expect(f.events.find(event => event.event_type === 'tool_preflight').payload.hook_mode).toBe('enforce');
      expect(existsSync(f.marker)).toBe(false);
    } finally { await f.close(); }
  });

  it.each(['block', 'require_approval', 'require_dual_approval'])('Cursor blocks %s without ask, approval bypass, or sample execution', async decision => {
    const f = await fixture('cursor', { decision });
    try { const result = await f.run('pre'); expect(result.code).toBe(2); expect(result.stdout.permission).toBe('deny'); expect(existsSync(f.marker)).toBe(false); }
    finally { await f.close(); }
  });

  it.each([{ badPosture: true }, { noSigner: true }, { lostAdmission: true }])('Cursor fails closed on %j without auto-retrying admission', async options => {
    const f = await fixture('cursor', options);
    try {
      const result = await f.run('pre'); expect(result.code).toBe(2); expect(result.stdout.permission).toBe('deny');
      expect(f.requests.filter(call => call.path === '/api/actions')).toHaveLength(options.lostAdmission ? 1 : 0);
    } finally { await f.close(); }
  });

  it.each([false, true])('a real GET is observation; one redemption POST is required, lost=%s', async lostRedemption => {
    const f = await fixture('cursor', { decision: 'require_approval', review: true, lostRedemption });
    try {
      const result = await f.run('pre');
      expect(result.stdout.permission).toBe(lostRedemption ? 'deny' : 'allow');
      expect(f.requests.filter(call => call.path === '/api/actions')).toHaveLength(2);
      expect(f.requests.filter(call => call.path === '/api/actions/act-native-wire' && call.method === 'GET')).toHaveLength(1);
      expect(existsSync(f.marker)).toBe(false);
    } finally { await f.close(); }
  }, 10000);

  it('Cursor retains exact receipt binding and opaque output, then retries only the unacknowledged report', async () => {
    const f = await fixture('cursor', { lostOutcomeAck: true });
    try {
      expect((await f.run('pre')).code).toBe(0);
      await f.run('post', { tool_input: { command: 'different' }, tool_output: '{"exitCode":0}' });
      await f.run('post', { tool_output: '{"stdout":"{\\"exitCode\\":0}"}' });
      expect(f.requests.filter(call => call.method === 'PATCH')).toHaveLength(0);
      await f.run('post', { tool_output: '{"exitCode":0,"stdout":"private result"}' });
      expect(f.events.some(event => event.event_type === 'tool_completed')).toBe(false);
      await f.run('post', { tool_output: '{"exitCode":0,"stdout":"different private result"}' });
      const reports = f.requests.filter(call => call.method === 'PATCH');
      expect(reports).toHaveLength(2); expect(reports[0].body).toEqual(reports[1].body);
      expect(JSON.stringify(reports)).not.toContain('private result');
      expect(f.events.filter(event => event.event_type === 'tool_completed')).toHaveLength(1);
      expect(f.requests.filter(call => call.path === '/api/actions')).toHaveLength(1);
    } finally { await f.close(); }
  });

  it('a contradictory Shell result with an explicit error never becomes a completion', async () => {
    const f = await fixture();
    try {
      await f.run('pre'); await f.run('post', { tool_output: '{"exitCode":0,"isError":true}' });
      expect(f.requests.find(call => call.method === 'PATCH').body.status).toBe('failed');
      expect(f.events.some(event => event.event_type === 'tool_completed')).toBe(false);
    } finally { await f.close(); }
  });

  it('the real Cursor doctor probe uses native wire input and is cancelled, not reported executed', async () => {
    const f = await fixture();
    try {
      const report = await f.doctor(); expect(report.ok, JSON.stringify(report.steps)).toBe(true);
      expect(f.requests.find(call => call.method === 'PATCH').body.status).toBe('cancelled');
      expect(f.events.some(event => event.event_type === 'tool_completed')).toBe(false);
    } finally { await f.close(); }
  });

  it('the real Cursor doctor reports native observe notices without claiming governance', async () => {
    const f = await fixture('cursor', { mode: 'observe' });
    try {
      const report = await f.doctor();
      expect(report).toMatchObject({ ok: false, connected: true, telemetry: true, governed: false });
      expect(report.warnings.join(' ')).toMatch(/observe/i);
      expect(report.steps.at(-1).detail).toMatch(/observation-only/);
      expect(f.events.find(event => event.event_type === 'tool_preflight').payload.hook_mode).toBe('observe');
      expect(f.requests.find(call => call.method === 'PATCH').body.status).toBe('cancelled');
      expect(f.events.some(event => event.event_type === 'tool_completed')).toBe(false);
    } finally { await f.close(); }
  });
});
