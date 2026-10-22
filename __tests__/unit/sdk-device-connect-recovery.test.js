import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const cli = path.resolve('sdk/cli.js');
const directories = [];
const oldBody = 'OSUITE_API_KEY=synthetic-old-key\nOSUITE_AGENT_ID=sdk-runtime\nOSUITE_RUNTIME_ADAPTER_ID=sdk\n';
const envPath = '.osuite/.env';
const journalPath = `${envPath}.connect.json`;

function fixture() {
  const cwd = fs.mkdtempSync(path.join(tmpdir(), 'osuite-recovery-test-'));
  directories.push(cwd);
  fs.mkdirSync(path.join(cwd, '.osuite'), { mode: 0o700 });
  fs.writeFileSync(path.join(cwd, envPath), oldBody, { mode: 0o600 });
  return cwd;
}

function run(cwd, baseUrl, onChild = () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'connect', 'sdk', '--base-url', baseUrl, '--poll-timeout-ms', '1000', '--poll-interval-ms', '10'], {
      cwd, env: { PATH: process.env.PATH, HOME: cwd, NO_COLOR: '1', OSUITE_NO_BROWSER: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    onChild(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

async function studio(cwd, callback) {
  const state = { starts: 0, polls: 0, acks: 0, active: 'old', failAck: false, pending: false, expired: false, dropPoll: false, killAtAck: null, onPoll: null, ackJournal: null, liveAtAck: null };
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : {};
    if (state.redirectAt && request.url.endsWith(`/${state.redirectAt}`)) {
      response.writeHead(307, { location: state.redirectTarget });
      response.end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const credential = {
      protocol_version: 2, key_id: state.starts > 1 ? `key_new_${state.starts}` : 'key_new', ack_token: 'synthetic-ack-token', runtime: 'sdk', agent_id: 'sdk-runtime',
      env: { OSUITE_BASE_URL: origin, OSUITE_API_KEY: 'synthetic-new-key', OSUITE_AGENT_ID: 'sdk-runtime', OSUITE_RUNTIME_ADAPTER_ID: 'sdk', OSUITE_PRIVATE_KEY_BASE64: 'synthetic-new-private-key' },
    };
    Object.assign(credential.env, state.envOverrides || {});
    if (request.url.endsWith('/start')) {
      state.starts += 1;
      state.startBody = body;
      response.statusCode = 201;
      response.end(JSON.stringify({ protocol_version: 2, acknowledgement_required: true, device_code: 'test-device', poll_token: 'test-poll', user_code: 'OS-TEST', expires_in: 600, interval_seconds: 0 }));
    } else if (request.url.endsWith('/poll')) {
      state.polls += 1;
      state.onPoll?.();
      if (state.pending || state.expired) {
        response.statusCode = state.expired ? 410 : 202;
        response.end(JSON.stringify({ status: state.expired ? 'expired' : 'pending' }));
        return;
      }
      if (state.dropPoll) {
        state.dropPoll = false;
        request.socket.destroy();
        return;
      }
      response.end(JSON.stringify({ status: 'approved', protocol_version: 2, credential }));
    } else if (request.url.endsWith('/ack')) {
      state.acks += 1;
      state.ackBody = body;
      state.liveAtAck = fs.readFileSync(path.join(cwd, envPath), 'utf8');
      state.onAck?.();
      try {
        state.ackJournal = JSON.parse(fs.readFileSync(path.join(cwd, journalPath), 'utf8'));
        state.journalMode = fs.statSync(path.join(cwd, journalPath)).mode & 0o777;
      } catch { state.ackJournal = null; }
      if (state.failAck) {
        response.statusCode = 503;
        response.end(JSON.stringify({ error: 'synthetic temporary failure' }));
        return;
      }
      if (state.revokedKey === body.key_id) {
        response.end(JSON.stringify({ status: 'finalized', key_id: body.key_id, active: false }));
        return;
      }
      state.active = 'new';
      if (state.killAtAck) {
        state.killAtAck();
        state.killAtAck = null;
        request.socket.destroy();
        return;
      }
      response.end(JSON.stringify({ status: 'finalized', key_id: credential.key_id, active: true }));
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await callback(`http://127.0.0.1:${server.address().port}`, state); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

afterEach(() => directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));

describe('CLI acknowledgement and recovery', () => {
  it.each([
    ['agent identity', { OSUITE_AGENT_ID: 'another-installation' }],
    ['Studio origin', { OSUITE_BASE_URL: 'https://unrelated.example.invalid' }],
    ['runtime', { OSUITE_RUNTIME_ADAPTER_ID: 'codex_hooks' }],
    ['missing identity', { OSUITE_AGENT_ID: '' }],
  ])('refuses delivered credentials with a mismatched %s before ACK or local replacement', async (_label, envOverrides) => {
    const cwd = fixture();
    await studio(cwd, async (url, state) => {
      state.envOverrides = envOverrides;
      const result = await run(cwd, url);
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toContain('do not match this connection');
      expect(state.acks).toBe(0);
      expect(state.active).toBe('old');
      expect(fs.readFileSync(path.join(cwd, envPath), 'utf8')).toBe(oldBody);
      expect(JSON.parse(fs.readFileSync(path.join(cwd, journalPath), 'utf8'))).not.toHaveProperty('credential');
    });
  });

  it.each(['start', 'poll', 'ack'])('does not forward %s credentials through a redirect', async phase => {
    const cwd = fixture();
    let forwarded = 0;
    const receiver = createServer((request, response) => {
      forwarded++;
      request.resume();
      response.end('{}');
    });
    await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
    try {
      await studio(cwd, async (url, state) => {
        const prior = `${oldBody}OSUITE_BASE_URL=${url}\n`;
        fs.writeFileSync(path.join(cwd, envPath), prior, { mode: 0o600 });
        state.redirectAt = phase;
        state.redirectTarget = `http://127.0.0.1:${receiver.address().port}/capture`;
        const result = await run(cwd, url);
        expect(result.status).toBe(1);
        expect(forwarded).toBe(0);
        expect(state.active).toBe('old');
        expect(fs.readFileSync(path.join(cwd, envPath), 'utf8')).toBe(prior);
        expect(result.stdout + result.stderr).not.toMatch(/synthetic-(?:old-key|ack-token|new-private-key)/);
      });
    } finally { receiver.closeAllConnections(); await new Promise(resolve => receiver.close(resolve)); }
  });

  it('durably saves a 0600 journal before acknowledgement and promotes the live env afterwards', async () => {
    const cwd = fixture();
    await studio(cwd, async (url, state) => {
      const result = await run(cwd, url);
      expect(result.status, result.stderr).toBe(0);
      expect(state.startBody.protocol_version).toBe(2);
      expect(state.acks).toBe(1);
      expect(state.liveAtAck).toBe(oldBody);
      expect(state.journalMode).toBe(0o600);
      expect(state.ackJournal.credential.env.OSUITE_API_KEY).toBe('synthetic-new-key');
      expect(state.ackBody).toMatchObject({ protocol_version: 2, device_code: 'test-device', poll_token: 'test-poll', key_id: 'key_new', ack_token: 'synthetic-ack-token' });
      expect(fs.readFileSync(path.join(cwd, envPath), 'utf8')).toContain('OSUITE_API_KEY=synthetic-new-key');
      expect(fs.existsSync(path.join(cwd, journalPath))).toBe(false);
      expect(result.stdout + result.stderr).not.toContain('synthetic-new-key');
      expect(result.stdout + result.stderr).not.toContain('synthetic-new-private-key');
      expect(result.stdout + result.stderr).not.toContain('synthetic-ack-token');
    });
  });

  it('keeps the old live env after acknowledgement failure and resumes without creating another key', async () => {
    const cwd = fixture();
    await studio(cwd, async (url, state) => {
      state.failAck = true;
      const first = await run(cwd, url);
      expect(first.status).toBe(1);
      expect(first.stdout + first.stderr).toMatch(/resume|recovery/i);
      expect(fs.readFileSync(path.join(cwd, envPath), 'utf8')).toBe(oldBody);
      expect(fs.existsSync(path.join(cwd, journalPath))).toBe(true);
      expect(state.active).toBe('old');
      state.failAck = false;
      const next = await run(cwd, url);
      expect(next.status, next.stderr).toBe(0);
      expect(state.starts).toBe(1);
      expect(state.active).toBe('new');
      expect(fs.readFileSync(path.join(cwd, envPath), 'utf8')).toContain('synthetic-new-key');
    });
  });

  it.each([
    ['agent', body => body.replace('sdk-runtime', 'different-live-agent')],
    ['key', body => body.replace('synthetic-old-key', 'different-live-key')],
    ['runtime', body => body.replace('ADAPTER_ID=sdk', 'ADAPTER_ID=mcp')],
    ['origin', body => `${body}OSUITE_BASE_URL=https://other.example.invalid\n`],
  ])('refuses a resumed receipt after the live %s changes, before ACK or any identity/journal save', async (_label, change) => {
    const cwd = fixture();
    await studio(cwd, async (url, state) => {
      state.failAck = true;
      expect((await run(cwd, url)).status).toBe(1);
      const receipt = fs.readFileSync(path.join(cwd, journalPath), 'utf8');
      const identityPath = path.join(cwd, `${envPath}.identity.json`);
      fs.rmSync(identityPath);
      const changed = change(oldBody);
      fs.writeFileSync(path.join(cwd, envPath), changed, { mode: 0o600 });
      const acks = state.acks;
      const polls = state.polls;
      state.failAck = false;

      const result = await run(cwd, url);

      expect(result.status, result.stdout).toBe(1);
      expect(result.stdout + result.stderr).toMatch(/recovery|conflict|changed/i);
      expect(state.starts).toBe(1);
      expect(state.acks).toBe(acks);
      expect(state.polls).toBe(polls);
      expect(fs.readFileSync(path.join(cwd, envPath), 'utf8')).toBe(changed);
      expect(fs.readFileSync(path.join(cwd, journalPath), 'utf8')).toBe(receipt);
      expect(fs.existsSync(identityPath)).toBe(false);
      expect(result.stdout + result.stderr).not.toMatch(/synthetic-(?:old-key|new-key|ack-token)|different-live-key/);
    });
  });

  it('rechecks the live bundle after polling, before saving or acknowledging a delivery', async () => {
    const cwd = fixture();
    await studio(cwd, async (url, state) => {
      const changed = oldBody.replace('sdk-runtime', 'different-live-agent');
      state.onPoll = () => fs.writeFileSync(path.join(cwd, envPath), changed, { mode: 0o600 });
      const result = await run(cwd, url);
      expect(result.status).toBe(1);
      expect(state.acks).toBe(0);
      expect(fs.readFileSync(path.join(cwd, envPath), 'utf8')).toBe(changed);
      expect(JSON.parse(fs.readFileSync(path.join(cwd, journalPath), 'utf8'))).not.toHaveProperty('credential');
    });
  });

  it('resumes an already-promoted receipt after interruption before journal removal', async () => {
    const cwd = fixture();
    await studio(cwd, async (url, state) => {
      expect((await run(cwd, url)).status).toBe(0);
      const promoted = fs.readFileSync(path.join(cwd, envPath), 'utf8');
      fs.writeFileSync(path.join(cwd, journalPath), `${JSON.stringify(state.ackJournal)}\n`, { mode: 0o600 });
      const result = await run(cwd, url);
      expect(result.status, result.stderr).toBe(0);
      expect(state.starts).toBe(1);
      expect(state.acks).toBe(2);
      expect(fs.readFileSync(path.join(cwd, envPath), 'utf8')).toBe(promoted);
      expect(fs.existsSync(path.join(cwd, journalPath))).toBe(false);
    });
  });

  it.each([false, true])('preserves a live replacement made during ACK (transient failure=%s)', async failAck => {
    const cwd = fixture();
    await studio(cwd, async (url, state) => {
      const changed = oldBody.replace('sdk-runtime', 'different-live-agent');
      state.failAck = failAck;
      state.onAck = () => fs.writeFileSync(path.join(cwd, envPath), changed, { mode: 0o600 });
      const result = await run(cwd, url);
      expect(result.status).toBe(1);
      expect(state.acks).toBe(1);
      expect(fs.readFileSync(path.join(cwd, envPath), 'utf8')).toBe(changed);
      expect(JSON.parse(fs.readFileSync(path.join(cwd, journalPath), 'utf8'))).toHaveProperty('credential');
      expect(result.stdout).not.toContain('Connected to OSuite');
    });
  });

  it.each(['poll', 'ack'])('preserves a journal replaced during %s instead of saving or clearing over it', async phase => {
    const cwd = fixture();
    await studio(cwd, async (url, state) => {
      const replacement = `${JSON.stringify({ protocol_version: 2, runtime: 'sdk', base_url: url, agent_id: 'different-live-agent',
        session: { device_code: 'other-device', poll_token: 'other-poll' } })}\n`;
      const replace = () => fs.writeFileSync(path.join(cwd, journalPath), replacement, { mode: 0o600 });
      if (phase === 'poll') state.onPoll = replace;
      else state.onAck = replace;
      const result = await run(cwd, url);
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toMatch(/journal.*changed|changed.*journal/i);
      expect(state.acks).toBe(phase === 'ack' ? 1 : 0);
      expect(fs.readFileSync(path.join(cwd, envPath), 'utf8')).toBe(oldBody);
      expect(fs.readFileSync(path.join(cwd, journalPath), 'utf8')).toBe(replacement);
    });
  });

  it.each([false, true])('resumes legacy receipts only with the same live scope (conflict=%s)', async conflict => {
    const cwd = fixture();
    await studio(cwd, async (url, state) => {
      const prior = `${oldBody}OSUITE_BASE_URL=${url}\n`;
      fs.writeFileSync(path.join(cwd, envPath), prior, { mode: 0o600 });
      state.failAck = true;
      expect((await run(cwd, url)).status).toBe(1);
      const journal = JSON.parse(fs.readFileSync(path.join(cwd, journalPath), 'utf8'));
      delete journal.live_env_sha256;
      fs.writeFileSync(path.join(cwd, journalPath), `${JSON.stringify(journal)}\n`, { mode: 0o600 });
      const receipt = fs.readFileSync(path.join(cwd, journalPath), 'utf8');
      const live = conflict ? prior.replace('sdk-runtime', 'different-live-agent') : prior;
      fs.writeFileSync(path.join(cwd, envPath), live, { mode: 0o600 });
      state.failAck = false;
      const before = state.acks;
      const result = await run(cwd, url);
      expect(result.status, result.stderr).toBe(conflict ? 1 : 0);
      expect(state.starts).toBe(1);
      expect(state.acks - before).toBe(conflict ? 0 : 1);
      if (conflict) {
        expect(fs.readFileSync(path.join(cwd, envPath), 'utf8')).toBe(live);
        expect(fs.readFileSync(path.join(cwd, journalPath), 'utf8')).toBe(receipt);
      } else {
        expect(fs.readFileSync(path.join(cwd, envPath), 'utf8')).toContain('synthetic-new-key');
        expect(fs.existsSync(path.join(cwd, journalPath))).toBe(false);
      }
    });
  });

  it('recovers after process death following server finalization but before local promotion', async () => {
    const cwd = fixture();
    await studio(cwd, async (url, state) => {
      const first = await run(cwd, url, (child) => { state.killAtAck = () => child.kill('SIGKILL'); });
      expect(first.signal).toBe('SIGKILL');
      expect(state.active).toBe('new');
      expect(fs.readFileSync(path.join(cwd, envPath), 'utf8')).toBe(oldBody);
      expect(fs.existsSync(path.join(cwd, journalPath))).toBe(true);
      const next = await run(cwd, url);
      expect(next.status, next.stderr).toBe(0);
      expect(state.starts).toBe(1);
      expect(fs.readFileSync(path.join(cwd, envPath), 'utf8')).toContain('synthetic-new-key');
    });
  });

  it('discards a confirmed superseded receipt without installing it and permits a fresh reconnect', async () => {
    const cwd = fixture();
    await studio(cwd, async (url, state) => {
      const first = await run(cwd, url, (child) => { state.killAtAck = () => child.kill('SIGKILL'); });
      expect(first.signal).toBe('SIGKILL');
      state.revokedKey = 'key_new';
      state.active = 'another-connection';
      const superseded = await run(cwd, url);
      expect(superseded.status).toBe(1);
      expect(superseded.stdout + superseded.stderr).toMatch(/superseded|no longer active/i);
      expect(state.active).toBe('another-connection');
      expect(fs.readFileSync(path.join(cwd, envPath), 'utf8')).toBe(oldBody);
      expect(fs.existsSync(path.join(cwd, journalPath))).toBe(false);
      const fresh = await run(cwd, url);
      expect(fresh.status, fresh.stderr).toBe(0);
      expect(state.starts).toBe(2);
      expect(state.ackBody.key_id).toBe('key_new_2');
    });
  });

  it('retries a lost v2 delivery response without retiring the old credential early', async () => {
    const cwd = fixture();
    await studio(cwd, async (url, state) => {
      state.dropPoll = true;
      const result = await run(cwd, url);
      expect(result.status, result.stderr).toBe(0);
      expect(state.polls).toBe(2);
      expect(state.liveAtAck).toBe(oldBody);
      expect(state.acks).toBe(1);
    });
  });

  it('never acknowledges when the recovery journal cannot be saved safely', async () => {
    const cwd = fixture();
    const target = path.join(cwd, 'unchanged.txt');
    fs.writeFileSync(target, 'unchanged');
    await studio(cwd, async (url, state) => {
      state.onPoll = () => {
        fs.rmSync(path.join(cwd, journalPath), { force: true });
        fs.symlinkSync(target, path.join(cwd, journalPath));
      };
      const result = await run(cwd, url);
      expect(result.status).toBe(1);
      expect(state.acks).toBe(0);
      expect(state.active).toBe('old');
      expect(fs.readFileSync(path.join(cwd, envPath), 'utf8')).toBe(oldBody);
      expect(fs.readFileSync(target, 'utf8')).toBe('unchanged');
    });
  });

  it('clears an expired waiting journal so the next connect can request a fresh code', async () => {
    const cwd = fixture();
    await studio(cwd, async (url, state) => {
      state.pending = true;
      expect((await run(cwd, url)).status).toBe(1);
      expect(fs.existsSync(path.join(cwd, journalPath))).toBe(true);
      state.pending = false;
      state.expired = true;
      expect((await run(cwd, url)).status).toBe(1);
      expect(fs.existsSync(path.join(cwd, journalPath))).toBe(false);
      expect(fs.readFileSync(path.join(cwd, envPath), 'utf8')).toBe(oldBody);
      state.expired = false;
      const next = await run(cwd, url);
      expect(next.status, next.stderr).toBe(0);
      expect(state.starts).toBe(2);
    });
  });
});
