import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkDispatch, checkReviews, authorizeRelease } from '../scripts/release-authorization.mjs';

const base = {
  GITHUB_REPOSITORY: 'OndCo/osuite-sdk', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_RUN_ID: '908', GITHUB_RUN_ATTEMPT: '1', GITHUB_REF: 'refs/tags/v2.14.1',
  GITHUB_ACTOR: 'release-owner', GITHUB_TRIGGERING_ACTOR: 'release-owner', GITHUB_ACTOR_ID: '105',
};
const policy = { OSUITE_NPM_RELEASE_ACTOR_ID: '105', GITHUB_REF_PROTECTED: 'true' };
const target = { id: 61, name: 'npm-production' };
const reviewer = { login: 'peer', id: 204, type: 'User' };
const review = (changes = {}) => ({ environments: [target], state: 'approved', user: reviewer, ...changes });
const manual = (history, pending = [], env = target) => checkReviews(checkDispatch(base), env, history, pending);

test('only a first dispatch, same actor, exact repository and stable version tag can enter either lane', () => {
  for (const [key, values] of Object.entries({
    GITHUB_REPOSITORY: [undefined, 'OndCo/osuite', 'fork/osuite-sdk'], GITHUB_EVENT_NAME: ['push', 'workflow_call'],
    GITHUB_RUN_ID: ['', '0', '908?x'], GITHUB_RUN_ATTEMPT: [undefined, '01', '2'],
    GITHUB_ACTOR: [''], GITHUB_TRIGGERING_ACTOR: [undefined, 'another-user'],
    GITHUB_ACTOR_ID: [undefined, '0', '-1', '0105', '1e2', ' 105', '105\n', '9007199254740993'],
    GITHUB_REF: ['refs/heads/main', 'v2.14.1', 'refs/tags/v02.14.1', 'refs/tags/v2.14.1-rc.1',
      'refs/tags/v2.14.1+build', 'refs/tags/v2.14', 'refs/tags/v2.14.1\n'],
  })) for (const value of values) for (const p of [{}, policy]) {
    assert.throws(() => checkDispatch({ ...base, ...p, [key]: value }), undefined, key);
  }
  assert.equal(checkDispatch({ ...base, GITHUB_REF: 'refs/tags/v0.0.0' }).lane, 'manual');
});

test('delegation requires both repo policy factors and never reads a token or makes a request', async () => {
  const env = { ...base, ...policy, get GH_TOKEN() { assert.fail('token read'); } };
  assert.equal(await authorizeRelease(env, () => assert.fail('network')), 'delegated');
  for (const override of [{ OSUITE_NPM_RELEASE_ACTOR_ID: '' }, { OSUITE_NPM_RELEASE_ACTOR_ID: '0105' },
    { OSUITE_NPM_RELEASE_ACTOR_ID: '106' }, { GITHUB_REF_PROTECTED: 'false' }, { GITHUB_REF_PROTECTED: 'TRUE' },
    { OSUITE_NPM_RELEASE_ACTOR_ID: undefined, INPUT_OSUITE_NPM_RELEASE_ACTOR_ID: '105' }]) {
    assert.equal(checkDispatch({ ...base, ...policy, ...override }).lane, 'manual');
  }
});

test('a registered GitHub App may dispatch only on the delegated lane and cannot approve', async () => {
  const actor = 'release-app[bot]';
  const env = { ...base, ...policy, GITHUB_ACTOR: actor, GITHUB_TRIGGERING_ACTOR: actor };
  assert.equal(await authorizeRelease(env, () => assert.fail('unexpected API call')), 'delegated');
  for (const override of [{ OSUITE_NPM_RELEASE_ACTOR_ID: undefined }, { OSUITE_NPM_RELEASE_ACTOR_ID: '106' },
    { GITHUB_REF_PROTECTED: 'false' }, { GITHUB_TRIGGERING_ACTOR: 'peer' }, { GITHUB_RUN_ATTEMPT: '2' },
    { GITHUB_REF: 'refs/heads/main' }, { GITHUB_ACTOR: '[bot]', GITHUB_TRIGGERING_ACTOR: '[bot]' }]) {
    assert.throws(() => checkDispatch({ ...env, ...override }));
  }
  for (const type of ['Bot', 'User']) {
    assert.throws(() => manual([review({ user: { login: actor, id: 204, type } })]));
  }
});

test('manual evidence must identify the current environment and an independent human review', () => {
  assert.equal(manual([review()]), 'manual');
  for (const env of [null, {}, { ...target, name: 'staging' }, { ...target, id: 62 }])
    assert.throws(() => manual([review()], [], env));
  for (const bad of [[], null, [null], [review({ environments: [] })], [review({ environments: [{}] })],
    [review({ environments: [{ id: 70, name: 'staging' }] })], [review({ user: null })],
    ...[{ type: 'Bot' }, { type: 'Organization' }, { login: 'peer[bot]' }, { login: '' }, { id: '204' },
      { id: 105 }, { login: 'Release-Owner' }].map(v => [review({ user: { ...reviewer, ...v } })])]) {
    assert.throws(() => manual(bad));
  }
});

test('any negative, pending, reversed or ambiguous target review denies, in either order', () => {
  for (const bad of [
    ...['pending', 'rejected', 'bypassed', 'APPROVED', null].map(state => review({ state })),
    review({ user: { ...reviewer, id: 105 } }),
    review({ environments: [target, { id: 78, name: target.name }] }),
    review({ environments: [{ id: target.id, name: 'old-name' }] }),
  ]) for (const order of [[bad, review()], [review(), bad]]) assert.throws(() => manual(order));
  for (const pending of [null, {}, [{}], [{ environment: target }], [{ environment: { ...target, id: 44 } }]])
    assert.throws(() => manual([review()], pending));
  assert.throws(() => manual([review(), review()]));
  const staging = { id: 17, name: 'staging' };
  assert.equal(manual([review({ environments: [staging], state: 'rejected' }), review()], [{ environment: staging }]), 'manual');
});

const api = 'https://api.github.com/repos/OndCo/osuite-sdk';
const paths = [api + '/environments/npm-production', api + '/actions/runs/908/approvals', api + '/actions/runs/908/pending_deployments'];
const bodies = [target, [review()], []];
const token = 'test-only-placeholder';
function apiMock(calls, replace = {}) {
  return async (url, options) => {
    calls.push(url);
    const i = paths.indexOf(url);
    assert.notEqual(i, -1);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer ' + token);
    if (Object.hasOwn(replace, i)) return replace[i]();
    return Response.json(bodies[i]);
  };
}
test('manual lane reads only the fixed origin, exact repo, environment and trusted run', async () => {
  const seen = [];
  assert.equal(await authorizeRelease({ ...base, GH_TOKEN: token, GITHUB_API_URL: 'https://unused.invalid',
    INPUT_RUN_ID: '12', INPUT_ENVIRONMENT: 'staging' }, apiMock(seen)), 'manual');
  assert.deepEqual([...seen].sort(), [...paths].sort());
});

test('missing token, read errors, non-200s, incomplete history and malformed bodies deny without leaking details', async () => {
  const seen = [];
  await assert.rejects(authorizeRelease(base, apiMock(seen)));
  assert.deepEqual(seen, []);
  for (let i = 0; i < paths.length; ++i) for (const bad of [
    () => { throw Error(token); }, ...[204, 301, 403, 404, 429, 500].map(status =>
      () => new Response(status === 204 ? null : token, { status })),
    () => new Response(token),
    () => Response.json(bodies[i], { headers: { Link: '<https://unused.invalid>; rel="next"' } }),
  ]) {
    await assert.rejects(authorizeRelease({ ...base, GH_TOKEN: token }, apiMock([], { [i]: bad })),
      error => !String(error).includes(token));
  }
});

test('CLI rejects invalid context/arguments without exposing input; delegated CLI works offline', () => {
  const path = fileURLToPath(new URL('../scripts/release-authorization.mjs', import.meta.url));
  const run = (env, args = []) => spawnSync(process.execPath, [path, ...args], { env, encoding: 'utf8' });
  assert.equal(run({ ...base, ...policy }).status, 0);
  for (const result of [run({ ...base, GH_TOKEN: token, GITHUB_RUN_ATTEMPT: '2' }), run({ ...base, ...policy }, [token])]) {
    assert.equal(result.status, 1);
    assert.ok(!(result.stdout + result.stderr).includes(token));
  }
});
