import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStateStore } from '../../sdk/runtime/state.mjs';

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
const now = Date.parse('2026-10-20T00:00:00Z');
const hash = value => createHash('sha256').update(value).digest('hex');
const config = {
  baseUrl: 'https://studio.example', apiKey: 'key-a', agentId: 'agent-a', runtimeId: 'claude_code_hooks',
  mode: 'enforce', guardFailureMode: 'allow', signatureMode: 'workspace_key_optional',
};
const posture = {
  runtime_id: 'claude_code_hooks', mode: 'strict', on_guard_unavailable: 'block',
  require_signature: true, require_assumption_capture: true, approval_timeout_seconds: 300,
};
function document(overrides = {}) {
  return {
    schema_version: 'osuite.runtime_posture.v1', runtime_id: config.runtimeId,
    org_id: 'org-a', credential_id: 'key-id-a', credential_fingerprint: hash(config.apiKey),
    targeting: { agent_id: config.agentId, provider: null }, posture,
    revision: 'a'.repeat(64), issued_at: new Date(now).toISOString(), valid_until: new Date(now + 60000).toISOString(),
    ...overrides,
  };
}
async function fixture() {
  expect(existsSync(path.resolve('sdk/runtime/posture.mjs')), 'remote posture client exists').toBe(true);
  const { resolveRemotePosture } = await import('../../sdk/runtime/posture.mjs');
  const root = mkdtempSync(path.join(tmpdir(), 'osuite-node-posture-'));
  roots.push(root);
  const store = createStateStore({ ...config, stateDir: root });
  const calls = [];
  const respond = body => ({ request: async (...args) => { calls.push(args); return { ok: true, status: 200, body }; } });
  const offline = { request: async () => ({ ok: false, status: 0, error: 'timeout' }) };
  return { resolveRemotePosture, store, calls, respond, offline };
}

describe('scoped remote posture configuration', () => {
  it('fetches every run, applies a verified scoped document, and caches configuration only', async () => {
    const f = await fixture();
    for (let i = 0; i < 2; i++) {
      const result = await f.resolveRemotePosture(config, { ...f, api: f.respond(document()), now });
      expect(result).toMatchObject({ available: true, blocked: false, source: 'remote', posture });
    }
    expect(f.calls.map(call => call[1])).toEqual([
      '/api/runtimes/claude_code_hooks/posture?agent_id=agent-a',
      '/api/runtimes/claude_code_hooks/posture?agent_id=agent-a',
    ]);
    expect(f.store.read('posture').document).toEqual(document());
    expect(JSON.stringify(f.store.read('posture'))).not.toContain('key-a');
    expect(f.store.read('posture').document).not.toHaveProperty('decision');
  });

  it.each([
    { org_id: '' }, { runtime_id: 'codex_hooks' }, { credential_fingerprint: hash('key-b') },
    { targeting: { agent_id: 'agent-b', provider: null } }, { revision: '' },
    { schema_version: 'unknown' }, { posture: { ...posture, mode: 'garbage' } },
    { posture: { ...posture, require_signature: 'false' } },
    { valid_until: new Date(now + 301000).toISOString() },
    { issued_at: new Date(now + 60000).toISOString() },
    { valid_until: new Date(now - 1).toISOString() },
  ])('refuses invalid or differently bound remote configuration: %j', async overrides => {
    const f = await fixture();
    const result = await f.resolveRemotePosture(config, { ...f, api: f.respond(document(overrides)), now });
    expect(result).toMatchObject({ available: false, blocked: true });
    expect(f.store.read('posture')).toBeNull();
  });

  it('uses a bounded fresh cache offline, then blocks without downgrading strict mode', async () => {
    const f = await fixture();
    await f.resolveRemotePosture(config, { ...f, api: f.respond(document()), now });
    expect(await f.resolveRemotePosture(config, { ...f, api: f.offline, now: now + 1000 }))
      .toMatchObject({ available: true, blocked: false, source: 'cache', posture });
    expect(await f.resolveRemotePosture(config, { ...f, api: f.offline, now: now + 61000 }))
      .toMatchObject({ available: false, blocked: true, posture: { mode: 'strict', on_guard_unavailable: 'block' } });
  });

  it('does not let an offline observe cache weaken an explicit enforcing configuration', async () => {
    const f = await fixture();
    await f.resolveRemotePosture(config, { ...f, api: f.respond(document({ posture: { ...posture, mode: 'observe' } })), now });
    expect(await f.resolveRemotePosture(config, { ...f, api: f.offline, now: now + 1000 }))
      .toMatchObject({ posture: { mode: 'enforce' } });
  });

  it('does not trust modified cache bytes or cached configuration after key rejection', async () => {
    const f = await fixture();
    await f.resolveRemotePosture(config, { ...f, api: f.respond(document()), now });
    expect(await f.resolveRemotePosture(config, { ...f, api: { request: async () => ({ ok: false, status: 401 }) }, now }))
      .toMatchObject({ available: false, blocked: true, source: 'unavailable' });
    const cached = f.store.read('posture');
    cached.document.posture.mode = 'observe';
    f.store.write('posture', cached);
    expect(await f.resolveRemotePosture(config, { ...f, api: f.offline, now }))
      .toMatchObject({ available: false, blocked: true, posture: { mode: 'enforce' } });
  });

  it('permits a fresh administrator downgrade but not an older response racing it', async () => {
    const f = await fixture();
    const updated = document({ issued_at: new Date(now + 1000).toISOString(), posture: { ...posture, mode: 'observe' } });
    expect(await f.resolveRemotePosture(config, { ...f, api: f.respond(updated), now: now + 1000 }))
      .toMatchObject({ posture: { mode: 'observe' }, source: 'remote' });
    expect(await f.resolveRemotePosture(config, { ...f, api: f.respond(document()), now: now + 1000 }))
      .toMatchObject({ source: 'cache', posture: { mode: 'enforce' } });
    expect(f.store.read('posture').document).toEqual(updated);
  });

  it('compares a racing response with the latest cache while holding the state lock', async () => {
    const f = await fixture();
    const newer = document({ issued_at: new Date(now + 1000).toISOString() });
    await f.resolveRemotePosture(config, { ...f, api: f.respond(newer), now: now + 1000 });
    const newerCache = f.store.read('posture');
    f.store.remove('posture');
    const store = { ...f.store, update: (key, update) => {
      f.store.write(key, newerCache);
      return f.store.update(key, update);
    } };
    const older = document({ posture: { ...posture, mode: 'observe', require_signature: false } });
    expect(await f.resolveRemotePosture(config, { ...f, store, api: f.respond(older), now: now + 1000 }))
      .toMatchObject({ source: 'cache', posture: { mode: 'strict', require_signature: true } });
    expect(f.store.read('posture').document).toEqual(newer);
  });

  it('never applies an unpersisted downgrade when the cache is busy or unavailable', async () => {
    const f = await fixture();
    await f.resolveRemotePosture(config, { ...f, api: f.respond(document()), now });
    const updated = document({ issued_at: new Date(now + 1000).toISOString(), posture: { ...posture, mode: 'observe' } });
    const store = { ...f.store, update: () => { throw new Error('Runtime state is busy'); }, write: () => { throw new Error('Runtime state is busy'); } };
    expect(await f.resolveRemotePosture(config, { ...f, store, api: f.respond(updated), now: now + 1000 }))
      .toMatchObject({ source: 'unavailable', blocked: true, posture: { mode: 'strict' } });
    expect(f.store.read('posture').document).toEqual(document());
  });
});
