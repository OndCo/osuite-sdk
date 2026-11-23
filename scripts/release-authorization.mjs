import { pathToFileURL } from 'node:url';

const repository = 'OndCo/osuite-sdk';
const environmentName = 'npm-production';
const login = value => typeof value === 'string' && /^[a-z\d][a-z\d_-]{0,99}$/i.test(value);
const id = value => Number.isSafeInteger(value) && value > 0;
const decimalId = value => typeof value === 'string' && id(Number(value)) && String(Number(value)) === value;
class ReleaseDenied extends Error {}
function requirePolicy(ok, reason) {
  if (!ok) throw new ReleaseDenied(reason);
}

export function checkDispatch(env) {
  requirePolicy(env.GITHUB_REPOSITORY === repository && env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    && env.GITHUB_RUN_ATTEMPT === '1' && decimalId(env.GITHUB_RUN_ID), 'Expected a first owner-repository dispatch');
  const actor = env.GITHUB_ACTOR, actorId = env.GITHUB_ACTOR_ID;
  requirePolicy(env.GITHUB_TRIGGERING_ACTOR === actor && decimalId(actorId), 'Invalid or changed dispatch identity');
  const tag = /^refs\/tags\/v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(env.GITHUB_REF);
  requirePolicy(tag && tag.slice(1).every(part => Number.isSafeInteger(Number(part))), 'Expected a stable numeric version tag');
  const delegated = env.GITHUB_REF_PROTECTED === 'true' && env.OSUITE_NPM_RELEASE_ACTOR_ID === actorId;
  const appLogin = typeof actor === 'string' && actor.endsWith('[bot]') && login(actor.slice(0, -5));
  requirePolicy(login(actor) || (delegated && appLogin), 'Invalid dispatch login for release lane');
  return { lane: delegated ? 'delegated' : 'manual', actor, actorId, runId: env.GITHUB_RUN_ID };
}

export function checkReviews(dispatch, environment, history, pending) {
  requirePolicy(environment?.name === environmentName && id(environment.id), 'Missing release environment');
  requirePolicy(Array.isArray(history) && Array.isArray(pending), 'Incomplete review evidence');
  function isTarget(ref) {
    requirePolicy(id(ref?.id) && typeof ref.name === 'string' && ref.name.length > 0, 'Invalid review environment');
    const sameId = ref.id === environment.id;
    requirePolicy(sameId === (ref.name === environmentName), 'Conflicting environment identity');
    return sameId;
  }
  requirePolicy(!pending.some(entry => isTarget(entry?.environment)), 'Release environment is pending');
  const matches = history.filter(record => {
    requirePolicy(Array.isArray(record?.environments) && record.environments.length, 'Incomplete review history');
    // Validate every reference, even after the first match.
    return record.environments.map(isTarget).includes(true);
  });
  // This single-environment publication job expects one decision. Never pick
  // a favorable row or infer an ordering for duplicate/reversed decisions.
  requirePolicy(matches.length === 1 && matches[0].state === 'approved', 'No unambiguous approved release review');
  const user = matches[0].user;
  requirePolicy(user?.type === 'User' && login(user.login) && id(user.id)
    && String(user.id) !== dispatch.actorId && user.login.toLowerCase() !== dispatch.actor.toLowerCase(),
  'Release review must be from a different GitHub user');
  return 'manual';
}

// GH_TOKEN is the job token (actions: read); never accept an API origin, run
// ID, review, actor policy or credential from workflow_dispatch inputs.
export async function authorizeRelease(env = process.env, fetchImpl = globalThis.fetch) {
  const dispatch = checkDispatch(env);
  if (dispatch.lane === 'delegated') return 'delegated';
  const token = env.GH_TOKEN;
  requirePolicy(typeof token === 'string' && token.trim().length > 0, 'Manual release review needs GH_TOKEN (actions: read)');
  const read = async path => {
    let response;
    try {
      response = await fetchImpl(`https://api.github.com/repos/${repository}/${path}`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token, 'X-GitHub-Api-Version': '2022-11-28' },
      });
    } catch { throw new ReleaseDenied('GitHub review API unavailable'); }
    requirePolicy(response.status === 200, `GitHub review API returned HTTP ${response.status}`);
    requirePolicy(!response.headers.get('link'), 'Incomplete GitHub review response');
    try { return await response.json(); } catch { throw new ReleaseDenied('Invalid GitHub review response'); }
  };
  const run = `actions/runs/${dispatch.runId}`;
  const environment = await read('environments/' + environmentName);
  const history = await read(run + '/approvals');
  const pending = await read(run + '/pending_deployments');
  return checkReviews(dispatch, environment, history, pending);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    requirePolicy(process.argv.length === 2, 'This guard accepts no arguments');
    console.log('Release authorization: ' + await authorizeRelease());
  } catch (error) {
    console.error('Release authorization denied: ' + (error instanceof ReleaseDenied ? error.message : 'unexpected failure'));
    process.exitCode = 1;
  }
}
