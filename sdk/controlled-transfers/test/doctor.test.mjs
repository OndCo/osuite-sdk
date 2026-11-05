import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const PROFILE = 'matoi.controlled-transfer.v1';
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const issuer = generateKeyPairSync('ed25519');

async function doctor() {
  const entry = new URL('../../matoiDoctor.mjs', import.meta.url);
  assert.ok(existsSync(entry), 'the side-effect-free Matoi doctor module must exist');
  return import(entry);
}

async function setup(t) {
  const requests = [];
  const capability = { profile: PROFILE, installed: true, configured: true, resourceEnforced: true,
    scope: 'controlled-ledger', issuerPublicKey: issuer.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    qualification: { status: 'not-qualified', remaining: ['deployment acceptance'] } };
  const control = { capability, status: 200 };
  const server = createServer((req, res) => {
    requests.push({ method: req.method, path: req.url, apiKey: req.headers['x-api-key'] });
    res.writeHead(control.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(control.capability));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const config = { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'doctor-test-key',
    privateKeyBase64: Buffer.from(rsa.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64'),
    orgId: 'org-1', agentId: 'agent-1', signatureMode: 'required', guardFailureMode: 'block', timeoutMs: 500 };
  return { control, config, requests, ...await doctor() };
}

test('doctor distinguishes installed SDK from missing strict configuration without a network probe', async () => {
  const { probeMatoiStatus, formatMatoiStatus } = await doctor();
  const result = await probeMatoiStatus({ config: {} });
  assert.equal(result.installed, true);
  assert.equal(result.localConfigured, false);
  assert.equal(result.configured, false);
  assert.equal(result.capabilityAvailable, false);
  assert.equal(result.qualification, null);
  assert.equal(result.code, 'INVALID_CONFIGURATION');
  const formatted = formatMatoiStatus(result);
  assert.match(formatted, /SDK installed: yes/);
  assert.match(formatted, /Local strict configuration: no/);
  assert.match(formatted, /Qualification: unknown/);
  assert.match(formatted, /does not establish full-stack deployment protection/);
  assert.match(formatted, /Ordinary SDK\/Hook behavior is unchanged/);
});

test('doctor faithfully displays configured but not-qualified and uses exactly one authenticated GET', async t => {
  const f = await setup(t);
  const result = await f.probeMatoiStatus({ config: f.config });
  assert.equal(result.installed, true);
  assert.equal(result.localConfigured, true);
  assert.equal(result.configured, true);
  assert.equal(result.qualification.status, 'not-qualified');
  assert.equal(result.qualificationSource, 'authenticated-capability');
  const text = f.formatMatoiStatus(result);
  assert.match(text, /Profile configured: yes/);
  assert.match(text, /Resource scope: controlled-ledger/);
  assert.match(text, /Qualification: not-qualified \(server-reported\)/);
  assert.deepEqual(f.requests, [{ method: 'GET', path: '/api/matoi/transfers', apiKey: 'doctor-test-key' }]);
  assert.ok(!text.includes(f.config.apiKey));
  assert.ok(!text.includes(f.config.privateKeyBase64));
});

test('doctor does not promote integrated-tested to deployment-qualified', async t => {
  const f = await setup(t);
  f.control.capability.qualification.status = 'integrated-tested';
  const result = await f.probeMatoiStatus({ config: f.config });
  assert.equal(result.qualification.status, 'integrated-tested');
  assert.match(f.formatMatoiStatus(result), /Qualification: integrated-tested \(server-reported\)/);
  assert.ok(!f.formatMatoiStatus(result).includes('Qualification: deployment-qualified'));
});

test('doctor uses the controlled-only 1 MiB capability bound and never upgrades oversized evidence', async t => {
  const f = await setup(t);
  f.control.capability.qualification.evidence = 'x'.repeat(300000);
  const status = await f.probeMatoiStatus({ config: f.config });
  assert.equal(status.capabilityAvailable, true);
  assert.equal(status.qualification.status, 'not-qualified');
  assert.match(f.formatMatoiStatus(status), /Qualification: not-qualified \(server-reported\)/);
  f.control.capability.qualification.evidence = 'x'.repeat(1024 * 1024);
  const oversized = await f.probeMatoiStatus({ config: f.config });
  assert.equal(oversized.capabilityAvailable, false);
  assert.equal(oversized.qualification, null);
  assert.equal(oversized.code, 'CAPABILITY_UNAVAILABLE');
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests.every(request => request.method === 'GET'));
});

test('disabled, unavailable and wrong-profile deployments cannot be described as configured protection', async t => {
  const f = await setup(t);
  Object.assign(f.control.capability, { configured: false, issuerPublicKey: null, resourceEnforced: false });
  const disabled = await f.probeMatoiStatus({ config: f.config });
  assert.equal(disabled.localConfigured, true);
  assert.equal(disabled.configured, false);
  assert.equal(disabled.capabilityAvailable, true);
  assert.match(f.formatMatoiStatus(disabled), /Profile configured: no/);
  f.control.status = 503;
  const unavailable = await f.probeMatoiStatus({ config: f.config });
  assert.equal(unavailable.configured, false);
  assert.equal(unavailable.qualification, null);
  assert.match(f.formatMatoiStatus(unavailable), /Profile configured: unknown/);
  f.control.status = 200;
  f.control.capability.profile = 'ordinary-hook';
  assert.equal((await f.probeMatoiStatus({ config: f.config })).code, 'CAPABILITY_MISMATCH');
  assert.ok(f.requests.every(request => request.method === 'GET'));
});

test('the pure formatter does not infer deployment qualification from caller boolean flags', async () => {
  const { formatMatoiStatus } = await doctor();
  const input = { installed: true, configured: true, qualified: true, deploymentQualified: true,
    qualification: { status: 'deployment-qualified' } };
  const before = JSON.stringify(input);
  const text = formatMatoiStatus(input);
  assert.match(text, /Qualification: unknown/);
  assert.equal(JSON.stringify(input), before);
});

test('doctor can report Node 24 requirements without depending on newer string APIs', async () => {
  const entry = new URL('../../matoiDoctor.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    Object.defineProperty(process.versions, 'node', { value: '18.0.0' });
    String.prototype.isWellFormed = undefined;
    const { probeMatoiStatus, formatMatoiStatus } = await import(${JSON.stringify(entry)});
    console.log(formatMatoiStatus(await probeMatoiStatus({ config: {} })));
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /NODE_24_REQUIRED/);
  assert.match(result.stdout, /SDK installed: yes/);
});
