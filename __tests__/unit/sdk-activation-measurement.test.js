import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDoctorWithMeasurement } from '../../sdk/activationMetrics.js';
import { acquireCredentialLock, writeCredentialFile } from '../../sdk/credentials.js';
const directories = [];
const setup = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osuite-diagnostic-')); directories.push(root); return root; };
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const config = { baseUrl: 'https://studio.test', apiKey: 'nd_im_synthetic', agentId: 'agent_test' };
const env = { OSUITE_ONBOARDING_METRICS: '1', OSUITE_INSTALL_STARTED_AT: '2026-10-20T10:00:00.000Z' };
const posts = (fetchImpl) => fetchImpl.mock.calls.filter(([, options]) => options.method === 'POST');
function transport({ acknowledged = true, identity = () => ({ version: 1, org_id: 'org_test', agent_id: config.agentId }) } = {}) {
  return vi.fn(async (url, options) => options.method === 'GET'
    ? { ok: true, json: async () => identity(options.headers['x-api-key']) }
    : { ok: acknowledged });
}
describe('opt-in first doctor result', () => {
  it('does not write or send telemetry by default', async () => {
    const cwd = setup(); const fetchImpl = vi.fn(); const doctor = vi.fn(async () => false);
    expect(await runDoctorWithMeasurement(doctor, { config, cwd, env: {}, fetchImpl })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fs.readdirSync(cwd)).toEqual([]);
  });
  it('persists the first failure and never replaces it with a later successful retry', async () => {
    const cwd = setup(); const fetchImpl = transport({ acknowledged: false });
    await runDoctorWithMeasurement(async () => false, { config, cwd, env, fetchImpl });
    await runDoctorWithMeasurement(async () => true, { config, cwd, env, fetchImpl });
    expect(posts(fetchImpl)).toHaveLength(2);
    const payloads = posts(fetchImpl).map(([, options]) => JSON.parse(options.body));
    expect(payloads.every((payload) => payload.passed === false)).toBe(true);
    expect(Object.keys(payloads[0]).sort()).toEqual(['event', 'install_started_at', 'passed', 'source', 'version']);
    expect(JSON.stringify(payloads)).not.toContain(cwd);
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('error');
  });
  it('stops transmitting after acknowledgement and ignores telemetry failures', async () => {
    const cwd = setup(); const fetchImpl = transport();
    expect(await runDoctorWithMeasurement(async () => true, { config, cwd, env, fetchImpl })).toBe(true);
    expect(await runDoctorWithMeasurement(async () => false, { config, cwd, env, fetchImpl })).toBe(false);
    expect(posts(fetchImpl)).toHaveLength(1);
    const failing = vi.fn(async () => { throw new Error('network'); });
    expect(await runDoctorWithMeasurement(async () => true, { config, cwd: setup(), env, fetchImpl: failing })).toBe(true);
  });
  it('does not report an interrupted first attempt as a later success', async () => {
    const cwd = setup(); const fetchImpl = transport();
    await expect(runDoctorWithMeasurement(async () => { throw new Error('interrupted'); }, { config, cwd, env, fetchImpl })).rejects.toThrow('interrupted');
    await runDoctorWithMeasurement(async () => true, { config, cwd, env, fetchImpl });
    expect(posts(fetchImpl)).toHaveLength(0);
  });

  it('owns an exclusive protected attempt lock until the doctor and report finish', async () => {
    const cwd = setup(); const fetchImpl = transport();
    await runDoctorWithMeasurement(async () => {
      const locks = fs.readdirSync(cwd, { recursive: true }).filter((file) => file.endsWith('.connect.lock'));
      expect(locks).toHaveLength(1);
      const file = locks[0].slice(0, -'.connect.lock'.length);
      expect(() => acquireCredentialLock(cwd, file)).toThrow(/another.*process/i);
      return false;
    }, { config, cwd, env, fetchImpl });
    expect(fs.readdirSync(cwd, { recursive: true }).filter((file) => file.endsWith('.connect.lock'))).toEqual([]);
    expect(JSON.parse(posts(fetchImpl)[0][1].body).passed).toBe(false);
  });

  it('verifies workspace and agent with the exact credential, never a supplied tenant', async () => {
    const cwd = setup(); const fetchImpl = transport(); const emit = vi.fn();
    await runDoctorWithMeasurement(async () => false, { config: { ...config, orgId: 'forged' }, cwd, env, fetchImpl, emit });
    const identity = fetchImpl.mock.calls.find(([, options]) => options.method === 'GET');
    expect(identity?.[0]).toBe('https://studio.test/api/onboarding/measurement');
    expect(identity?.[1]).toMatchObject({ redirect: 'error', headers: { 'x-api-key': config.apiKey } });
    expect(identity?.[1].headers['x-org-id']).toBeUndefined();
    const persisted = fs.readdirSync(cwd, { recursive: true }).filter((file) => file.endsWith('.json'))
      .map((file) => fs.readFileSync(path.join(cwd, file), 'utf8')).join('');
    expect(persisted + JSON.stringify(emit.mock.calls)).not.toContain(config.apiKey);
    expect(JSON.stringify(emit.mock.calls)).not.toContain('nd_im_');
  });

  it('keeps rotations in one cohort without suppressing another workspace with the same agent', async () => {
    const cwd = setup(); let acknowledge = false;
    const fetchImpl = transport({ identity: (key) => ({ version: 1, org_id: key === 'credential_b' ? 'org_b' : 'org_a', agent_id: config.agentId }) });
    const fetch = async (url, options) => {
      const result = await fetchImpl(url, options);
      return options.method === 'POST' ? { ok: acknowledge } : result;
    };
    await runDoctorWithMeasurement(async () => false, { config, cwd, env, fetchImpl: fetch });
    acknowledge = true;
    await runDoctorWithMeasurement(async () => true, { config: { ...config, apiKey: 'rotated_a' }, cwd, env, fetchImpl: fetch });
    await runDoctorWithMeasurement(async () => true, { config: { ...config, apiKey: 'credential_b' }, cwd, env, fetchImpl: fetch });
    expect(posts(fetchImpl).map(([, options]) => [options.headers['x-api-key'], JSON.parse(options.body).passed]))
      .toEqual([[config.apiKey, false], ['rotated_a', false], ['credential_b', true]]);
  });

  it('retains an offline first failure and reports it only after that credential is verified', async () => {
    const cwd = setup(); let available = false;
    const fetchImpl = transport({ identity: () => {
      if (!available) throw new Error('offline');
      return { version: 1, org_id: 'org_test', agent_id: config.agentId };
    } });
    await runDoctorWithMeasurement(async () => false, { config, cwd, env, fetchImpl });
    expect(posts(fetchImpl)).toHaveLength(0);
    available = true;
    await runDoctorWithMeasurement(async () => true, { config, cwd, env, fetchImpl });
    expect(posts(fetchImpl)).toHaveLength(1);
    expect(JSON.parse(posts(fetchImpl)[0][1].body).passed).toBe(false);
  });

  it('does not replace an earlier unresolved credential with a later verified success', async () => {
    const cwd = setup(); let resolveOriginal = false;
    const fetchImpl = transport({ identity: (key) => {
      if (key === config.apiKey && !resolveOriginal) throw new Error('offline');
      return { version: 1, org_id: key === config.apiKey ? 'org_a' : 'org_b', agent_id: config.agentId };
    } });
    await runDoctorWithMeasurement(async () => false, { config, cwd, env, fetchImpl });
    const other = { ...config, apiKey: 'credential_b' };
    await runDoctorWithMeasurement(async () => true, { config: other, cwd, env, fetchImpl });
    expect(posts(fetchImpl)).toHaveLength(0);
    resolveOriginal = true;
    await runDoctorWithMeasurement(async () => true, { config, cwd, env, fetchImpl });
    await runDoctorWithMeasurement(async () => false, { config: other, cwd, env, fetchImpl });
    expect(posts(fetchImpl).map(([, options]) => JSON.parse(options.body).passed)).toEqual([false, true]);
  });

  it.each([
    { version: 1, org_id: 'org_test', agent_id: 'another_agent' },
    { version: 1, org_id: '', agent_id: config.agentId },
    { org_id: 'org_test', agent_id: config.agentId },
  ])('does not trust incomplete or differently bound identity: %j', async (identity) => {
    const cwd = setup(); const fetchImpl = transport({ identity: () => identity });
    expect(await runDoctorWithMeasurement(async () => false, { config, cwd, env, fetchImpl })).toBe(false);
    expect(posts(fetchImpl)).toHaveLength(0);
  });

  it('does not relabel a legacy unscoped result as belonging to the current workspace', async () => {
    const cwd = setup(); const fetchImpl = transport();
    const identity = crypto.createHash('sha256').update(JSON.stringify([config.baseUrl, config.agentId])).digest('hex');
    writeCredentialFile(cwd, `.osuite/diagnostics/${identity}.json`, JSON.stringify({ version: 1, state: 'finished', passed: false, reported: false }));
    await runDoctorWithMeasurement(async () => true, { config, cwd, env, fetchImpl });
    expect(posts(fetchImpl)).toHaveLength(0);
  });
});
