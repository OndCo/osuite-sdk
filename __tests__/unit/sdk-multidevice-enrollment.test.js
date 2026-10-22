import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const cli = path.resolve('sdk/cli.js');
const roots = [];
function project() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'osuite-multidevice-'));
  roots.push(root);
  return root;
}
function connect(cwd, url, extra = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'connect', 'sdk', '--base-url', url,
      '--poll-timeout-ms', '40', '--poll-interval-ms', '10', ...extra], {
      cwd, env: { PATH: process.env.PATH, HOME: cwd, OSUITE_NO_BROWSER: '1', NO_COLOR: '1',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
}
async function withPendingServer(run) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/start')) {
      requests.push(body);
      const id = requests.length;
      res.statusCode = 201;
      res.end(JSON.stringify({ protocol_version: 2, device_code: `device-${id}`, poll_token: `poll-${id}`,
        user_code: `OS-${id}`, expires_in: 600, interval_seconds: 0 }));
    } else {
      res.statusCode = 202;
      res.end(JSON.stringify({ status: 'pending' }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`, requests); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

describe('real CLI process enrollment isolation', () => {
  it('gives twenty fresh installations different agent and installation identifiers', async () => {
    await withPendingServer(async (url, requests) => {
      for (let index = 0; index < 20; index += 1) await connect(project(), url);
      expect(requests).toHaveLength(20);
      expect(new Set(requests.map(request => request.agent_id)).size).toBe(20);
      expect(new Set(requests.map(request => request.installation_id)).size).toBe(20);
      for (const request of requests) {
        expect(request.agent_id).toMatch(/^sdk-runtime-[a-f0-9-]{36}$/);
        expect(request.installation_id).toMatch(/^[a-f0-9-]{36}$/);
        expect(request.previous_key).toBeUndefined();
      }
    });
  }, 30000);

  it('resumes a first-install pending journal without minting a different identity', async () => {
    await withPendingServer(async (url, requests) => {
      const root = project();
      await connect(root, url);
      const first = JSON.parse(fs.readFileSync(path.join(root, '.osuite/.env.connect.json'), 'utf8'));
      const next = await connect(root, url);
      expect(next.output).not.toContain('different connection');
      expect(next.output).toContain('resume this same pending connection');
      expect(next.output).not.toContain('again for a new code');
      expect(requests).toHaveLength(1);
      const second = JSON.parse(fs.readFileSync(path.join(root, '.osuite/.env.connect.json'), 'utf8'));
      expect(second.agent_id).toBe(first.agent_id);
    });
  });

  it('keeps installation identity across separate enrollment requests after an unapproved journal expires', async () => {
    await withPendingServer(async (url, requests) => {
      const root = project();
      await connect(root, url);
      fs.rmSync(path.join(root, '.osuite/.env.connect.json'));
      await connect(root, url);
      expect(requests).toHaveLength(2);
      expect(requests[1].installation_id).toBeTruthy();
      expect(requests[1].installation_id).toBe(requests[0].installation_id);
      expect(requests[1].agent_id).toBe(requests[0].agent_id);
    });
  });
});
