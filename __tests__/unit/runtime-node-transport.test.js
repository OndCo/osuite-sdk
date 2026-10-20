import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, verify } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const cleanups = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });

async function runtime() {
  expect(existsSync(path.resolve('sdk/runtime/protocol.mjs')), 'Node transport is packaged').toBe(true);
  return import('../../sdk/runtime/protocol.mjs');
}

async function stub(handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = { url: req.url, method: req.method, headers: req.headers, body: raw ? JSON.parse(raw) : null };
    requests.push(request);
    res.setHeader('content-type', 'application/json');
    handler(request, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyBase64 = Buffer.from(pair.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');

describe('dependency-free Node runtime transport', () => {
  it('signs the exact canonical request with Node crypto, without mutating its input', async () => {
    const { canonicalJson, createApiClient } = await runtime();
    const server = await stub((_req, res) => res.end('{"decision":"allow"}'));
    const api = createApiClient({ ...server, apiKey: 'test-not-a-secret', privateKeyBase64, signatureMode: 'required' });
    const body = { z: [{ nested: 'Unicode \u4e2d\u6587', a: 1 }], agent_id: 'agent', reversible: false };
    expect((await api.request('POST', '/api/guard', body)).ok).toBe(true);
    expect(body._signature).toBeUndefined();
    const { _signature, ...signed } = server.requests[0].body;
    expect(verify('sha256', Buffer.from(canonicalJson(signed)), pair.publicKey, Buffer.from(_signature, 'base64'))).toBe(true);
    expect(server.requests[0].headers['x-api-key']).toBe('test-not-a-secret');
  });

  it.each(['', 'invalid-key'])('never sends unsigned data when required signing is unavailable: %s', async key => {
    const { createApiClient } = await runtime();
    const server = await stub((_req, res) => res.end('{}'));
    const api = createApiClient({ ...server, apiKey: 'test-key', privateKeyBase64: key, signatureMode: 'required' });
    const result = await api.request('POST', '/api/guard', { agent_id: 'agent' });
    expect(result).toMatchObject({ ok: false, error: 'signing_unavailable' });
    expect(server.requests).toHaveLength(0);
  });

  it('signs the serialized JSON shape when optional properties are undefined', async () => {
    const { canonicalJson, createApiClient } = await runtime();
    const server = await stub((_req, res) => res.end('{}'));
    const api = createApiClient({ ...server, apiKey: 'test-key', privateKeyBase64, signatureMode: 'required' });
    const body = { agent_id: 'agent', optional: undefined, nested: { a: undefined, b: 1 }, list: [undefined, 1] };
    expect((await api.request('POST', '/api/actions', body)).ok).toBe(true);
    const { _signature, ...signed } = server.requests[0].body;
    expect(signed).toEqual({ agent_id: 'agent', nested: { b: 1 }, list: [null, 1] });
    expect(verify('sha256', Buffer.from(canonicalJson(signed)), pair.publicKey, Buffer.from(_signature, 'base64'))).toBe(true);
    expect(body).toHaveProperty('optional', undefined);
  });

  it('refuses non-JSON request values without signing or sending a different action', async () => {
    const { createApiClient } = await runtime();
    const server = await stub((_req, res) => res.end('{}'));
    const api = createApiClient({ ...server, apiKey: 'test-key', privateKeyBase64, signatureMode: 'required' });
    const cycle = {}; cycle.self = cycle;
    for (const body of [cycle, { input: 1n }]) {
      expect(await api.request('POST', '/api/actions', body)).toMatchObject({ ok: false, error: 'invalid_request' });
    }
    expect(server.requests).toHaveLength(0);
  });

  it('keeps explicitly optional legacy requests unsigned', async () => {
    const { createApiClient } = await runtime();
    const server = await stub((_req, res) => res.end('{}'));
    const api = createApiClient({ ...server, apiKey: 'test-key', signatureMode: 'workspace_key_optional' });
    expect((await api.request('POST', '/api/guard', { agent_id: 'agent' })).ok).toBe(true);
    expect(server.requests[0].body._signature).toBeUndefined();
  });

  it('never forwards credentials or retries requests on a redirect', async () => {
    const { createApiClient } = await runtime();
    const server = await stub((_req, res) => res.writeHead(302, { location: '/redirected' }).end());
    const api = createApiClient({ ...server, apiKey: 'test-key' });
    expect(await api.request('POST', '/api/actions', {})).toMatchObject({ ok: false, status: 302 });
    expect(server.requests.map(x => x.url)).toEqual(['/api/actions']);
  });

  it('bounds stalled requests and oversized JSON without exposing response bodies', async () => {
    const { createApiClient } = await runtime();
    const stalled = await stub(() => {});
    const start = Date.now();
    expect(await createApiClient({ ...stalled, apiKey: 'test-key' }, { timeoutMs: 60 }).request('GET', '/posture'))
      .toMatchObject({ ok: false, error: 'timeout' });
    expect(Date.now() - start).toBeLessThan(1000);
    const large = await stub((_req, res) => res.end(JSON.stringify({ output: 'secret'.repeat(60000) })));
    expect(await createApiClient({ ...large, apiKey: 'test-key' }).request('GET', '/posture'))
      .toMatchObject({ ok: false, error: 'invalid_response' });
  });

  it('rejects remote cleartext and credential-bearing base URLs before networking', async () => {
    const { createApiClient } = await runtime();
    for (const baseUrl of ['http://customer.example', 'https://user:password@example.com', 'https://example.com/?key=x']) {
      const api = createApiClient({ baseUrl, apiKey: 'test-key' });
      expect(await api.request('POST', '/api/guard', {})).toMatchObject({ ok: false, error: 'invalid_base_url' });
    }
  });
});

describe('Node runtime local state', () => {
  async function fixture() {
    expect(existsSync(path.resolve('sdk/runtime/state.mjs')), 'Node state helper is packaged').toBe(true);
    const { createStateStore } = await import('../../sdk/runtime/state.mjs');
    const dir = mkdtempSync(path.join(tmpdir(), 'osuite-node-state-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const config = { stateDir: dir, baseUrl: 'https://studio.example', apiKey: 'key-a', agentId: 'agent-a', runtimeId: 'claude_code_hooks' };
    return { dir, config, createStateStore, store: createStateStore(config) };
  }

  it('persists owner-only state atomically and isolates credential, tenant origin, agent and runtime', async () => {
    const { config, store, createStateStore } = await fixture();
    store.write('action:tool-one', { action_id: 'act-one' });
    expect(store.read('action:tool-one')).toEqual({ action_id: 'act-one' });
    expect(statSync(store.path('action:tool-one')).mode & 0o777).toBe(0o600);
    for (const variant of [{ apiKey: 'key-b' }, { baseUrl: 'https://other.example' }, { agentId: 'agent-b' }, { runtimeId: 'codex_hooks' }, { provider: 'different-connection' }]) {
      expect(createStateStore({ ...config, ...variant }).read('action:tool-one')).toBeNull();
    }
    expect(store.path('../../outside')).toContain(config.stateDir);
  });

  it('refuses symlinked state without reading or changing unrelated files', async () => {
    const { dir, store } = await fixture();
    const target = path.join(dir, 'other');
    writeFileSync(target, '{"private":"not-state"}');
    symlinkSync(target, store.path('action:tool-one'));
    expect(() => store.read('action:tool-one')).toThrow();
    expect(() => store.write('action:tool-one', { action_id: 'act-one' })).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('{"private":"not-state"}');
  });

  it('serializes compare-and-update across independent stores without waiting indefinitely', async () => {
    const { config, store, createStateStore } = await fixture();
    const other = createStateStore(config);
    store.write('posture-counter', 1);
    expect(store.update('posture-counter', value => {
      expect(() => other.update('posture-counter', () => 0)).toThrow(/busy/i);
      return value + 1;
    })).toBe(2);
    expect(other.update('posture-counter', value => value + 1)).toBe(3);
    expect(() => store.update('posture-counter', () => { throw new Error('fixture'); })).toThrow('fixture');
    expect(other.update('posture-counter', value => value + 1)).toBe(4);
  });
});
