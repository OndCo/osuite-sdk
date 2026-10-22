import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const cli = path.resolve('sdk/cli.js');
const directories = [];
const key = 'nd_im_synthetic_credential_do_not_print';
const privateKey = 'synthetic_private_key_do_not_print';

function project() {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'osuite-credential-test-'));
  directories.push(directory);
  return directory;
}

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
}

function run(cwd, args) {
  const script = `process.umask(0); process.argv = ${JSON.stringify([process.execPath, cli, ...args])}; await import(${JSON.stringify(pathToFileURL(cli).href)});`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd,
      env: { PATH: process.env.PATH, HOME: cwd, NO_COLOR: '1', OSUITE_NO_BROWSER: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function connect(cwd) {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (request.url.endsWith('/start')) {
      response.statusCode = 201;
      response.end(JSON.stringify({ device_code: 'test-device', poll_token: 'test-poll', user_code: 'OS-TEST', expires_in: 600 }));
    } else if (request.url.endsWith('/poll')) {
      response.end(JSON.stringify({ status: 'approved', credential: { env: {
        OSUITE_BASE_URL: origin, OSUITE_API_KEY: key, OSUITE_PRIVATE_KEY_BASE64: privateKey,
        OSUITE_AGENT_ID: 'sdk-runtime', OSUITE_RUNTIME_ADAPTER_ID: 'sdk',
      } } }));
    } else {
      response.end(JSON.stringify({ status: 'healthy' }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(cwd, ['connect', 'sdk', '--base-url', `http://127.0.0.1:${server.address().port}`, '--poll-timeout-ms', '1000']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

afterEach(() => directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));

describe('CLI credential storage', () => {
  it('writes owner-only credentials even under umask 000 and does not print them', async () => {
    const cwd = project();
    const result = await connect(cwd);
    expect(result.status, result.stderr).toBe(0);
    expect(fs.statSync(path.join(cwd, '.osuite/.env')).mode & 0o777).toBe(0o600);
    expect(result.stdout + result.stderr).not.toContain(key);
    expect(result.stdout + result.stderr).not.toContain(privateKey);
  });

  it('protects exactly the credential and recovery paths, not project configuration', async () => {
    const cwd = project();
    git(cwd, 'init', '-q');
    const result = await connect(cwd);
    expect(result.status, result.stderr).toBe(0);
    expect(git(cwd, 'check-ignore', '.osuite/.env').trim()).toBe('.osuite/.env');
    expect(() => git(cwd, 'check-ignore', '.osuite/.env.example', '.osuite/config.json')).toThrow();
  });

  it('refuses a tracked credential path without changing its contents', async () => {
    const cwd = project();
    git(cwd, 'init', '-q');
    fs.mkdirSync(path.join(cwd, '.osuite'));
    const file = path.join(cwd, '.osuite/.env');
    fs.writeFileSync(file, '# tracked placeholder\n');
    git(cwd, 'add', '.osuite/.env');
    const result = await connect(cwd);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/tracked/i);
    expect(fs.readFileSync(file, 'utf8')).toBe('# tracked placeholder\n');
  });

  it('detects tracked files inside a nested repository', async () => {
    const cwd = project();
    git(cwd, 'init', '-q');
    fs.mkdirSync(path.join(cwd, '.osuite'));
    git(path.join(cwd, '.osuite'), 'init', '-q');
    fs.writeFileSync(path.join(cwd, '.osuite/.env'), '# nested tracked\n');
    git(path.join(cwd, '.osuite'), 'add', '.env');
    const result = await connect(cwd);
    expect(result.status).toBe(1);
    expect(fs.readFileSync(path.join(cwd, '.osuite/.env'), 'utf8')).toBe('# nested tracked\n');
  });

  it.each(['file', 'directory'])('refuses a symlinked credential %s', async (kind) => {
    const cwd = project();
    const outside = project();
    const target = path.join(outside, '.env');
    fs.writeFileSync(target, '# must stay unchanged\n');
    if (kind === 'directory') fs.symlinkSync(outside, path.join(cwd, '.osuite'));
    else {
      fs.mkdirSync(path.join(cwd, '.osuite'));
      fs.symlinkSync(target, path.join(cwd, '.osuite/.env'));
    }
    const result = await connect(cwd);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/symlink/i);
    expect(fs.readFileSync(target, 'utf8')).toBe('# must stay unchanged\n');
  });

  it('doctor reports unsafe metadata without loading or printing credential contents', async () => {
    const cwd = project();
    fs.mkdirSync(path.join(cwd, '.osuite'));
    const file = path.join(cwd, '.osuite/.env');
    fs.writeFileSync(file, `OSUITE_API_KEY=${key}\nOSUITE_AGENT_ID=${privateKey}\n`);
    fs.chmodSync(file, 0o644);
    const result = await run(cwd, ['doctor']);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/unsafe.*0644|0644.*unsafe/i);
    expect(result.stdout + result.stderr).not.toContain(key);
    expect(result.stdout + result.stderr).not.toContain(privateKey);
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
  });

  it('keeps credential and installation fixes in the new SDK candidate, without rewriting 2.10.1', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve('sdk/package.json'), 'utf8'));
    expect(pkg.version).toBe('2.10.2');
  });

  it('doctor checks unsafe recovery credentials as well as the live env', async () => {
    const cwd = project();
    fs.mkdirSync(path.join(cwd, '.osuite'));
    const journal = path.join(cwd, '.osuite/.env.connect.json');
    fs.writeFileSync(journal, JSON.stringify({ credential: { api_key: key, private_key: privateKey } }));
    fs.chmodSync(journal, 0o644);
    const result = await run(cwd, ['doctor']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('.osuite/.env.connect.json');
    expect(result.stdout).toContain('0644');
    expect(result.stdout + result.stderr).not.toContain(key);
    expect(result.stdout + result.stderr).not.toContain(privateKey);
  });

  it('does not downgrade an existing connection to a legacy unacknowledged server flow', async () => {
    const cwd = project();
    fs.mkdirSync(path.join(cwd, '.osuite'));
    const file = path.join(cwd, '.osuite/.env');
    const previous = 'OSUITE_API_KEY=synthetic-existing-key\nOSUITE_RUNTIME_ADAPTER_ID=sdk\n';
    fs.writeFileSync(file, previous, { mode: 0o600 });
    const result = await connect(cwd);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/upgrade.*Studio|Studio.*upgrade/i);
    expect(fs.readFileSync(file, 'utf8')).toBe(previous);
  });

  it('doctor asks to resume a protected pending journal rather than claiming the connection is ready', async () => {
    const cwd = project();
    fs.mkdirSync(path.join(cwd, '.osuite'));
    fs.writeFileSync(path.join(cwd, '.osuite/.env.connect.json'), '{}', { mode: 0o600 });
    const result = await run(cwd, ['doctor']);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/recovery.*resume|resume.*connect/i);
    expect(result.stdout).not.toContain('Your OSuite CLI is ready');
  });
});
