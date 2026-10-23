import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildNodeRuntimeBootstrap, findHookInstallations, installProjectFile, RUNTIME_HOOKS, runHookCheck } from '../../sdk/projectHooks.js';

const roots = [];
const servers = [];
const sdkRoot = fileURLToPath(new URL('../../sdk/', import.meta.url));

function temporaryProject() {
  const root = fs.mkdtempSync(path.join(tmpdir(), "osuite freshness ' fixture "));
  roots.push(root);
  return root;
}

function write(root, name, body) {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), body);
}

function installed(runtime = 'claude') {
  const root = temporaryProject();
  const bundle = buildNodeRuntimeBootstrap(runtime, {}, { projectRoot: root });
  for (const [name, body] of Object.entries(bundle.files)) installProjectFile(root, name, body);
  return { root, runtime, bundle, spec: RUNTIME_HOOKS[runtime] };
}

function diagnose({ root, runtime }) {
  return findHookInstallations(root, [runtime], { diagnose: true })[0];
}

function changeSettings(fixture, change, name = fixture.spec.settings[0]) {
  const settings = JSON.parse(fs.readFileSync(path.join(fixture.root, name), 'utf8'));
  change(settings);
  write(fixture.root, name, JSON.stringify(settings));
}

function snapshot(root) {
  return Object.fromEntries(fs.readdirSync(root, { recursive: true }).sort().flatMap(name => {
    const absolute = path.join(root, name);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) return [[name, `symlink:${fs.readlinkSync(absolute)}`]];
    return stat.isFile() ? [[name, fs.readFileSync(absolute).toString('base64')]] : [];
  }));
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (servers.length) await new Promise(resolve => servers.pop().close(resolve));
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

async function localStudio() {
  const requests = [], events = [];
  const digest = value => createHash('sha256').update(value).digest('hex');
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push({ method: request.method, path: url.pathname, body });
    const send = payload => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(payload)); };
    if (url.pathname === '/api/health') return send({ status: 'healthy' });
    const posture = url.pathname.match(/^\/api\/runtimes\/([^/]+)\/posture$/);
    if (posture) {
      const runtimeId = posture[1];
      return send({
        schema_version: 'osuite.runtime_posture.v1', runtime_id: runtimeId, org_id: 'fixture-org', credential_id: 'fixture-key',
        credential_fingerprint: digest('freshness-fixture-key'), targeting: { agent_id: 'freshness-fixture-agent', provider: null },
        revision: digest('fixture-enforce'), issued_at: new Date().toISOString(), valid_until: new Date(Date.now() + 60000).toISOString(),
        posture: { runtime_id: runtimeId, mode: 'enforce', on_guard_unavailable: 'block', require_signature: false,
          require_assumption_capture: false, approval_timeout_seconds: 60 },
      });
    }
    if (url.pathname === '/api/runtime-sessions') return send({ runtime_session: { runtime_session_id: body.runtime_session_id } });
    if (url.pathname.endsWith('/events')) {
      if (request.method === 'GET') return send({ items: events });
      events.push(body);
      return send({ ok: true, event: body });
    }
    if (url.pathname === '/api/guard') return send({ decision: 'allow' });
    if (url.pathname === '/api/actions') return send({ action_id: 'act-freshness', decision: { decision: 'allow' },
      action: { action_id: 'act-freshness', status: 'running', tool_input_digest: body.tool_input_digest } });
    if (url.pathname === '/api/actions/act-freshness') return send({ action: { action_id: 'act-freshness', ...body } });
    response.writeHead(404); response.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${server.address().port}`, requests, events };
}

function doctorEnvironment(studio) {
  const home = temporaryProject();
  write(home, '.claude/settings.json', '{"disableAllHooks":true}\n');
  write(home, '.codex/config.toml', '[features]\nhooks = false\n');
  return {
    PATH: process.env.PATH, HOME: home, TMPDIR: home,
    XDG_CONFIG_HOME: path.join(home, '.config'), CODEX_HOME: path.join(home, '.codex'),
    OSUITE_STATE_DIR: path.join(home, 'state'), NO_COLOR: '1',
    OSUITE_BASE_URL: studio.url, OSUITE_API_KEY: 'freshness-fixture-key', OSUITE_AGENT_ID: 'freshness-fixture-agent',
    OSUITE_HOOK_MODE: 'enforce', OSUITE_SIGNATURE_MODE: 'workspace_key_optional',
  };
}

function doctor(fixture, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(sdkRoot, 'cli.js'), 'doctor'], { cwd: fixture.root, env });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Doctor fixture timed out')); }, 15000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

describe('read-only project Node hook installation freshness', () => {
  it.each(['claude', 'codex', 'cursor'])('compares the installed %s Node runtime with this CLI, not a registry version', runtime => {
    const fixture = installed(runtime);
    const before = snapshot(fixture.root);
    const found = diagnose(fixture);

    expect(found.problems).toEqual([]);
    expect(found.diagnostics).toMatchObject({ status: 'current', canProbe: true, warnings: [] });
    expect(found.diagnostics.files).toContainEqual({ relativePath: `${fixture.spec.dir}/runtime/admission.mjs`, status: 'current' });
    expect(found.diagnostics.files.every(file => file.status === 'current')).toBe(true);
    expect(found.diagnostics.registrations.every(registration => registration.status === 'current')).toBe(true);
    expect(snapshot(fixture.root)).toEqual(before);
  });

  it.each(['claude', 'codex'])('recognizes %s commands installed through another name for the same project root', runtime => {
    const fixture = installed(runtime);
    const parent = temporaryProject();
    const alias = path.join(parent, 'project-alias');
    fs.symlinkSync(fixture.root, alias);

    const found = diagnose({ ...fixture, root: alias });

    expect(found.diagnostics).toMatchObject({ status: 'current', canProbe: true, warnings: [] });
  });

  it.each(['claude', 'codex', 'cursor'])('reports a preserved, differing %s core without calling it a fatal configuration problem', runtime => {
    const fixture = installed(runtime);
    const relativePath = `${fixture.spec.dir}/runtime/admission.mjs`;
    fs.appendFileSync(path.join(fixture.root, relativePath), '\n// Previous or customized installation.\n');
    expect(installProjectFile(fixture.root, relativePath, fixture.bundle.files[relativePath]).status).toBe('kept');
    const before = snapshot(fixture.root);

    const found = diagnose(fixture);

    expect(found.problems).toEqual([]);
    expect(found.diagnostics).toMatchObject({ status: 'not_verified', canProbe: false });
    expect(found.diagnostics.files).toContainEqual({ relativePath, status: 'different' });
    expect(found.diagnostics.warnings.join(' ')).toMatch(/admission\.mjs.*differs/i);
    expect(snapshot(fixture.root)).toEqual(before);
  });

  it.each(['pretool', 'posttool', 'session', 'stop'])('detects a differing %s launcher, not just a current runtime directory', script => {
    const fixture = installed();
    const relativePath = `.claude/hooks/osuite_${script}.mjs`;
    fs.appendFileSync(path.join(fixture.root, relativePath), '\n// Preserved local launcher.\n');

    const found = diagnose(fixture);

    expect(found.problems).toEqual([]);
    expect(found.diagnostics).toMatchObject({ status: 'not_verified', canProbe: false });
    expect(found.diagnostics.files).toContainEqual({ relativePath, status: 'different' });
  });

  it('reports a missing packaged module without creating it', () => {
    const fixture = installed();
    const relativePath = '.claude/runtime/config.mjs';
    fs.unlinkSync(path.join(fixture.root, relativePath));

    const found = diagnose(fixture);

    expect(found.problems).toEqual([]);
    expect(found.diagnostics).toMatchObject({ status: 'not_verified', canProbe: false });
    expect(found.diagnostics.files).toContainEqual({ relativePath, status: 'missing' });
    expect(fs.existsSync(path.join(fixture.root, relativePath))).toBe(false);
  });

  it('identifies a registered legacy Python hook in local settings without hard-blocking its probe', () => {
    const root = temporaryProject();
    const command = 'python3 .claude/hooks/osuite_pretool.py';
    write(root, '.claude/settings.local.json', JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command }] }] } }));
    write(root, '.claude/hooks/osuite_pretool.py', '# Legacy fixture, not executed by inventory.\n');
    const before = snapshot(root);

    const found = diagnose({ root, runtime: 'claude' });

    expect(found.problems).toEqual([]);
    expect(found.diagnostics).toMatchObject({ status: 'not_verified', canProbe: true });
    expect(found.diagnostics.registrations).toContainEqual(expect.objectContaining({
      event: 'PreToolUse', settingsPath: '.claude/settings.local.json', command, status: 'legacy',
    }));
    expect(found.diagnostics.warnings.join(' ')).toMatch(/legacy Python.*not verified/i);
    expect(snapshot(root)).toEqual(before);
  });

  it('warns about a missing legacy Stop hook without preventing the separate pretool probe', () => {
    const root = temporaryProject();
    write(root, '.claude/settings.json', JSON.stringify({ hooks: {
      PreToolUse: [{ hooks: [{ type: 'command', command: 'python3 .claude/hooks/osuite_pretool.py' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'python3 .claude/hooks/osuite_stop.py' }] }],
    } }));
    write(root, '.claude/hooks/osuite_pretool.py', '# Legacy fixture.\n');

    const found = diagnose({ root, runtime: 'claude' });

    expect(found.diagnostics).toMatchObject({ status: 'not_verified', canProbe: true });
    expect(found.diagnostics.warnings.join(' ')).toMatch(/osuite_stop\.py.*missing/i);
    expect(found.problems).toEqual([]);
  });

  it('does not mistake unregistered leftover Python files for the active runtime', () => {
    const fixture = installed();
    write(fixture.root, '.claude/hooks/osuite_pretool.py', '# Preserved but no longer registered.\n');
    expect(diagnose(fixture).diagnostics).toMatchObject({ status: 'current', warnings: [] });
  });

  it('finds a legacy session registration even when pretool and posttool use current Node files', () => {
    const fixture = installed();
    changeSettings(fixture, settings => { settings.hooks.SessionStart[0].hooks[0].command = 'python3 .claude/hooks/osuite_session.py'; });
    write(fixture.root, '.claude/hooks/osuite_session.py', '# Legacy fixture.\n');

    const found = diagnose(fixture);

    expect(found.diagnostics).toMatchObject({ status: 'not_verified' });
    expect(found.diagnostics.registrations).toContainEqual(expect.objectContaining({ event: 'SessionStart', status: 'legacy' }));
    expect(found.diagnostics.warnings.join(' ')).toContain('SessionStart');
  });

  it.each([false, true])('reports preserved project/local duplicates with disableAllHooks=%s', disabled => {
    const fixture = installed();
    const settings = JSON.parse(fixture.bundle.files['.claude/settings.json']);
    write(fixture.root, '.claude/settings.local.json', JSON.stringify({ disableAllHooks: disabled, hooks: { PreToolUse: settings.hooks.PreToolUse } }));
    const before = snapshot(fixture.root);

    const found = diagnose(fixture);

    expect(found.hostEnabled).toBe(!disabled);
    expect(found.diagnostics).toMatchObject({ status: 'not_verified', canProbe: false });
    expect(found.diagnostics.registrations.filter(item => item.event === 'PreToolUse')).toHaveLength(2);
    expect(found.diagnostics.warnings.join(' ')).toMatch(/duplicate.*PreToolUse/i);
    expect(found.diagnostics.warnings.join(' ')).toContain('.claude/settings.local.json');
    expect(snapshot(fixture.root)).toEqual(before);
  });

  it.each(['external', 'project-custom'])('does not read or certify a %s command even if its bytes match the packaged launcher', location => {
    const fixture = installed();
    const outside = location === 'external' ? temporaryProject() : fixture.root;
    const customPath = path.join(outside, 'custom/osuite_pretool.mjs');
    write(outside, 'custom/osuite_pretool.mjs', fixture.bundle.files['.claude/hooks/osuite_pretool.mjs']);
    changeSettings(fixture, settings => { settings.hooks.PreToolUse[0].hooks[0].command = `node ${JSON.stringify(customPath)}`; });
    const read = vi.spyOn(fs, 'readFileSync');
    const open = vi.spyOn(fs, 'openSync');

    const found = diagnose(fixture);

    expect(found.problems).toEqual([]);
    expect(found.diagnostics).toMatchObject({ status: 'not_verified', canProbe: false });
    expect(found.diagnostics.registrations).toContainEqual(expect.objectContaining({ event: 'PreToolUse', status: 'unverified' }));
    expect(found.diagnostics.warnings.join(' ')).toMatch(/custom|unrecognized/i);
    expect(read.mock.calls.some(([file]) => String(file) === customPath)).toBe(false);
    expect(open.mock.calls.some(([file]) => String(file) === customPath)).toBe(false);
  });

  it('does not execute a shell suffix merely to inventory a named hook', () => {
    const fixture = installed();
    changeSettings(fixture, settings => { settings.hooks.PreToolUse[0].hooks[0].command += ' && touch inventory-must-not-run'; });

    const found = diagnose(fixture);

    expect(found.diagnostics).toMatchObject({ status: 'not_verified', canProbe: false });
    expect(found.diagnostics.warnings.join(' ')).toMatch(/unrecognized|custom/i);
    expect(fs.existsSync(path.join(fixture.root, 'inventory-must-not-run'))).toBe(false);
  });

  it('reports a non-string platform command as unverified instead of crashing inventory', () => {
    const fixture = installed('codex');
    changeSettings(fixture, settings => { settings.hooks.PreToolUse[0].hooks[0].commandWindows = 123; });

    expect(() => diagnose(fixture)).not.toThrow();
    expect(diagnose(fixture).diagnostics).toMatchObject({ status: 'not_verified', canProbe: false });
  });

  it('reports a non-object JSON settings file as a configuration problem instead of crashing inventory', () => {
    const fixture = installed();
    write(fixture.root, '.claude/settings.json', 'null');

    expect(() => diagnose(fixture)).not.toThrow();
    expect(diagnose(fixture).problems.join(' ')).toMatch(/JSON object/i);
  });

  it.each(['runtime/admission.mjs', 'hooks/osuite_pretool.mjs'])('does not follow a %s symlink for byte verification', name => {
    const fixture = installed();
    const outside = temporaryProject();
    const relativePath = `.claude/${name}`;
    const link = path.join(fixture.root, relativePath);
    const target = path.join(outside, 'outside.mjs');
    write(outside, 'outside.mjs', fixture.bundle.files[relativePath]);
    fs.unlinkSync(link);
    fs.symlinkSync(target, link);
    const read = vi.spyOn(fs, 'readFileSync');

    const found = diagnose(fixture);

    expect(found.diagnostics).toMatchObject({ status: 'not_verified', canProbe: false });
    expect(found.diagnostics.files).toContainEqual({ relativePath, status: 'unverified' });
    expect(read.mock.calls.some(([file]) => [link, target].includes(String(file)))).toBe(false);
    expect(found.diagnostics.warnings.join(' ')).toMatch(/symlink|not.*regular/i);
  });

  it('rereads the packaged runtime on every diagnosis instead of caching a version or hardcoded digest', async () => {
    const copy = temporaryProject();
    fs.copyFileSync(path.join(sdkRoot, 'projectHooks.js'), path.join(copy, 'projectHooks.mjs'));
    fs.cpSync(path.join(sdkRoot, 'runtime'), path.join(copy, 'runtime'), { recursive: true });
    const hooks = await import(pathToFileURL(path.join(copy, 'projectHooks.mjs')).href);
    const root = temporaryProject();
    const bundle = hooks.buildNodeRuntimeBootstrap('claude', {}, { projectRoot: root });
    for (const [name, body] of Object.entries(bundle.files)) hooks.installProjectFile(root, name, body);
    expect(hooks.findHookInstallations(root, ['claude'], { diagnose: true })[0].diagnostics).toMatchObject({ status: 'current' });

    fs.appendFileSync(path.join(copy, 'runtime/admission.mjs'), '\n// The packaged CLI changed after installation.\n');

    const found = hooks.findHookInstallations(root, ['claude'], { diagnose: true })[0];
    expect(found.diagnostics).toMatchObject({ status: 'not_verified', canProbe: false });
    expect(found.diagnostics.files).toContainEqual({ relativePath: '.claude/runtime/admission.mjs', status: 'different' });
  });
});

describe('doctor installation diagnosis with a simulated local Studio', () => {
  it('distinguishes current packaged bytes from native-host and registry verification', async () => {
    const fixture = installed();
    const studio = await localStudio();
    const env = doctorEnvironment(studio);

    const result = await doctor(fixture, env);

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/OK\s+Hook freshness.*this CLI/i);
    expect(result.stdout).toContain('direct hook probe was governed and reached OSuite');
    expect(result.stdout).toMatch(/does not enumerate.*system-managed.*plugin.*global/i);
    expect(result.stdout).toMatch(/not.*registry.*latest/i);
    expect(studio.events.some(event => event.event_type === 'tool_allowed')).toBe(true);
  });

  it('does not certify a differing core even when its direct probe can emit successful governance telemetry', async () => {
    const fixture = installed();
    const relativePath = '.claude/runtime/admission.mjs';
    fs.appendFileSync(path.join(fixture.root, relativePath), '\n// Previous installation with identical successful-path behavior.\n');
    const studio = await localStudio();
    const env = doctorEnvironment(studio);
    const check = await runHookCheck({ projectRoot: fixture.root,
      installation: findHookInstallations(fixture.root, ['claude'])[0], shellEnv: env });
    expect(check, JSON.stringify(check.steps)).toMatchObject({ ok: true, telemetry: true, governed: true });
    const before = snapshot(fixture.root);
    const requestsBefore = studio.requests.length;

    const result = await doctor(fixture, env);

    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).toMatch(/WARN\s+Hook freshness.*not verified/i);
    expect(result.stdout).toContain(relativePath);
    expect(result.stdout).not.toMatch(/FAIL\s+Hook installed/);
    expect(result.stdout).not.toContain('Your OSuite CLI is ready');
    expect(result.stdout).not.toContain('direct hook probe was governed');
    expect(result.stdout).toMatch(/upgrade.*CLI.*osuite connect claude/i);
    expect(result.stdout).toMatch(/review.*custom differences/i);
    expect(studio.requests.slice(requestsBefore).map(request => request.path)).toEqual(['/api/health']);
    expect(snapshot(fixture.root)).toEqual(before);
  });

  it.each(['custom path', 'shell suffix'])('skips a %s instead of executing arbitrary code during doctor', async scenario => {
    const fixture = installed();
    const outside = temporaryProject();
    const marker = path.join(outside, 'must-not-run');
    const customScript = path.join(outside, 'osuite_pretool.mjs');
    write(outside, 'osuite_pretool.mjs', `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
    changeSettings(fixture, settings => {
      const hook = settings.hooks.PreToolUse[0].hooks[0];
      hook.command = scenario === 'custom path' ? `node ${JSON.stringify(customScript)}` : `${hook.command} && node ${JSON.stringify(customScript)}`;
    });
    const studio = await localStudio();
    const env = doctorEnvironment(studio);
    const before = snapshot(fixture.root);
    const homeBefore = snapshot(env.HOME);

    const result = await doctor(fixture, env);

    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).toMatch(/WARN\s+Hook freshness.*not verified/i);
    expect(result.stdout).toMatch(/unrecognized|custom path/i);
    expect(result.stdout).toMatch(/probe.*skipped/i);
    expect(result.stdout).not.toMatch(/FAIL\s+Hook installed/);
    expect(fs.existsSync(marker)).toBe(false);
    expect(studio.requests.map(request => request.path)).toEqual(['/api/health']);
    expect(snapshot(fixture.root)).toEqual(before);
    expect(snapshot(env.HOME)).toEqual(homeBefore);
  });

  it.each(['claude', 'codex', 'cursor'])('retains disabled %s intent while reporting a differing launcher', async runtime => {
    const fixture = installed(runtime);
    fs.appendFileSync(path.join(fixture.root, fixture.spec.dir, 'hooks/osuite_pretool.mjs'), '\n// Older launcher.\n');
    if (runtime === 'codex') write(fixture.root, '.codex/config.toml', '[features]\nhooks = false\n');
    else changeSettings(fixture, settings => { settings.disableAllHooks = true; });
    const studio = await localStudio();
    const env = doctorEnvironment(studio);
    const before = snapshot(fixture.root);
    const homeBefore = snapshot(env.HOME);

    const result = await doctor(fixture, env);

    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).toMatch(/FAIL\s+Host hooks enabled/);
    expect(result.stdout).toMatch(/WARN\s+Hook freshness.*not verified/i);
    expect(result.stdout).toMatch(/disabled.*remain.*disabled/i);
    expect(result.stdout).toContain(`osuite connect ${runtime}`);
    expect(result.stdout).not.toMatch(/--force|set .*true|to reinstall/i);
    expect(studio.requests.map(request => request.path)).toEqual(['/api/health']);
    expect(snapshot(fixture.root)).toEqual(before);
    expect(snapshot(env.HOME)).toEqual(homeBefore);
  });

  it('surfaces disabled legacy registrations without pretending they are the current Node runtime', async () => {
    const fixture = installed();
    changeSettings(fixture, settings => {
      settings.disableAllHooks = true;
      settings.hooks.PreToolUse[0].hooks[0].command = 'python3 .claude/hooks/osuite_pretool.py';
    });
    write(fixture.root, '.claude/hooks/osuite_pretool.py', '# Not executed.\n');
    const studio = await localStudio();

    const result = await doctor(fixture, doctorEnvironment(studio));

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/legacy Python.*not verified/i);
    expect(result.stdout).toContain('osuite connect claude');
    expect(result.stdout).not.toMatch(/OK\s+Hook freshness/);
    expect(studio.requests.map(request => request.path)).toEqual(['/api/health']);
  });

  it('still distinguishes malformed settings as a fatal configuration problem', async () => {
    const fixture = installed();
    write(fixture.root, '.claude/settings.json', '{invalid JSON');
    const studio = await localStudio();

    const result = await doctor(fixture, doctorEnvironment(studio));

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/FAIL\s+Hook installed.*not valid JSON/);
    expect(result.stdout).not.toMatch(/OK\s+Hook freshness/);
    expect(fs.readFileSync(path.join(fixture.root, '.claude/settings.json'), 'utf8')).toBe('{invalid JSON');
    expect(studio.requests.map(request => request.path)).toEqual(['/api/health']);
  });
});

describe('Claude crash and timeout policy defaults', () => {
  it.each(['claude', 'codex', 'cursor'])('sets onFailure only for a newly generated Claude PreToolUse handler, not other %s events', runtime => {
    const fixture = installed(runtime);
    const settings = JSON.parse(fixture.bundle.files[fixture.bundle.node_runtime.settings_path]);
    for (const [event, groups] of Object.entries(settings.hooks)) {
      const handlers = runtime === 'cursor' ? groups : groups.flatMap(group => group.hooks);
      for (const handler of handlers) {
        if (runtime === 'claude' && event === 'PreToolUse') expect(handler.onFailure).toBe('block');
        else expect(handler).not.toHaveProperty('onFailure');
      }
    }
  });

  it.each([
    { disabled: false, custom: false }, { disabled: true, custom: false },
    { disabled: false, custom: true }, { disabled: true, custom: true },
  ])('does not retrofit the default over existing Node settings %j', ({ disabled, custom }) => {
    const fixture = installed();
    changeSettings(fixture, settings => {
      settings.disableAllHooks = disabled;
      settings.hooks.PreToolUse[0].hooks[0].onFailure = 'continue';
      if (custom) settings.hooks.PreToolUse[0].hooks[0].command = 'node /custom/osuite_pretool.mjs';
    });
    const before = snapshot(fixture.root);
    const template = JSON.parse(fixture.bundle.files['.claude/settings.json']);
    template.hooks.PreToolUse[0].hooks[0].onFailure = 'block';

    const report = installProjectFile(fixture.root, '.claude/settings.json', JSON.stringify(template));

    expect(report.status).toBe('unchanged');
    expect(snapshot(fixture.root)).toEqual(before);
  });

  it.each([
    { disabled: false, onFailure: 'continue' }, { disabled: true, onFailure: 'continue' },
    { disabled: false }, { disabled: true },
  ])('preserves existing failure-policy intent during stock legacy command migration %j', ({ disabled, onFailure }) => {
    const fixture = installed();
    changeSettings(fixture, settings => {
      settings.disableAllHooks = disabled;
      const handler = settings.hooks.PreToolUse[0].hooks[0];
      handler.command = 'python3 .claude/hooks/osuite_pretool.py';
      if (onFailure === undefined) delete handler.onFailure;
      else handler.onFailure = onFailure;
    });
    const template = JSON.parse(fixture.bundle.files['.claude/settings.json']);
    template.hooks.PreToolUse[0].hooks[0].onFailure = 'block';

    installProjectFile(fixture.root, '.claude/settings.json', JSON.stringify(template));

    const settings = JSON.parse(fs.readFileSync(path.join(fixture.root, '.claude/settings.json'), 'utf8'));
    expect(settings.disableAllHooks).toBe(disabled);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('osuite_pretool.mjs');
    expect(settings.hooks.PreToolUse[0].hooks[0].onFailure).toBe(onFailure);
  });

  it('warns about missing crash/timeout blocking without modifying settings or certifying host-version support', async () => {
    const fixture = installed();
    changeSettings(fixture, settings => { delete settings.hooks.PreToolUse[0].hooks[0].onFailure; });
    const before = snapshot(fixture.root);
    const studio = await localStudio();

    const result = await doctor(fixture, doctorEnvironment(studio));

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toMatch(/WARN\s+Install warning.*onFailure.*block/i);
    expect(result.stdout).toContain('2.1.295');
    expect(result.stdout).toMatch(/host.*support.*not verified/i);
    expect(result.stdout).not.toMatch(/OK\s+Hook freshness/);
    expect(result.stdout).toContain('direct hook probe was governed and reached OSuite');
    expect(snapshot(fixture.root)).toEqual(before);
  });
});
