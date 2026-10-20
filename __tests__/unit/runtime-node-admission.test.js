import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { toolInputDigest } from '../../sdk/runtime/protocol.mjs';

const context = {
  agent_id: 'agent-test', runtime_session_id: 'sess-test', tool_use_id: 'tool-test',
  declared_goal: 'Bash: printf harmless', action_type: 'other',
  tool_input_digest: toolInputDigest('Bash', { command: 'printf harmless' }),
};
const action = (status = 'running', decision = 'allow', extra = {}) => ({
  action_id: 'act-test', action: {
    action_id: 'act-test', status, tool_input_digest: context.tool_input_digest,
    action_envelope: { cava: { fingerprint: 'fp-test' } }, ...extra,
  }, decision: { decision },
});
const pending = { ...action('pending_approval', 'require_approval'), approval: { state: 'pending' } };
const fixtureTime = Date.now();
const polled = {
  ...action('running', 'require_approval', {
    approved_by: 'reviewer', approved_at: new Date(fixtureTime - 2000).toISOString(), approval_decision: 'allow',
    approval_expires_at: new Date(fixtureTime + 3600000).toISOString(), approval_redeemed_at: null, timestamp_end: null,
  }),
  approval: { state: 'approved', reused: false },
};
const redeemed = {
  ...polled, action: { ...polled.action, approval_redeemed_at: new Date(fixtureTime - 1000).toISOString() },
  approval: { ...polled.approval, reused: true },
};

async function run({ guard = { decision: 'allow' }, created = [action()], polls = [], config = {}, healthCheck = false } = {}) {
  expect(existsSync(path.resolve('sdk/runtime/admission.mjs')), 'Node admission protocol exists').toBe(true);
  const { admitAction } = await import('../../sdk/runtime/admission.mjs');
  const requests = [];
  let postIndex = 0;
  let getIndex = 0;
  let time = 0;
  const api = { request: async (method, endpoint, body) => {
    requests.push({ method, endpoint, body });
    const value = endpoint === '/api/guard' ? guard
      : method === 'POST' ? created[Math.min(postIndex++, created.length - 1)]
        : polls[Math.min(getIndex++, polls.length - 1)];
    return value == null ? { ok: false, status: 0, error: 'transport_failure' }
      : value.transport ? value.transport : { ok: true, status: 200, body: value };
  } };
  const result = await admitAction({ ...context, ...(healthCheck ? { health_check: true } : {}) }, {
    api, config: { mode: 'enforce', guardFailureMode: 'block', approvalWaitMs: 3000, ...config },
    sleep: async ms => { time += ms; }, now: () => time,
  });
  return { result, requests, posts: requests.filter(x => x.endpoint === '/api/actions'), gets: requests.filter(x => x.method === 'GET') };
}

describe('Node authoritative action admission', () => {
  it.each(['allow', 'warn'])('requires guard and POST admission for %s', async decision => {
    const { result, posts } = await run({ guard: { decision }, created: [action('running', decision)] });
    expect(result).toMatchObject({ authorized: true, decision, actionId: 'act-test' });
    expect(posts.map(x => x.body)).toEqual([{ ...context, status: 'running' }]);
  });

  it.each([null, {}, { action_id: 'act-test' },
    { ...action(), action_id: 'different' }, { ...action(), status: 'pending_approval' },
    action('completed'), action('running', 'future'), action('running', 'block'),
    action('running', 'allow', { timestamp_end: 'already-ended' }),
    action('running', 'allow', { tool_input_digest: 'other-call' }),
  ])('does not release on malformed, mismatched, terminal or stricter POST response %j', async response => {
    const { result, posts } = await run({ created: [response], config: { guardFailureMode: 'allow' } });
    expect(result.authorized).toBe(false);
    expect(result.decision).toBe('block');
    expect(posts).toHaveLength(1);
  });

  it.each([{}, { decision: 'future' }, { decision: 1 }])('blocks unsupported guard response %j even in fail-open availability mode', async guard => {
    const { result, posts } = await run({ guard, config: { guardFailureMode: 'allow' } });
    expect(result).toMatchObject({ authorized: false, decision: 'block' });
    expect(posts).toHaveLength(0);
  });

  it('preserves configured availability behavior without labelling degraded calls authorized', async () => {
    expect((await run({ guard: null, config: { guardFailureMode: 'allow' } })).result)
      .toMatchObject({ authorized: false, decision: 'allow', degraded: true, reason: 'guard_unavailable' });
    expect((await run({ guard: null })).result).toMatchObject({ authorized: false, decision: 'block' });
    expect((await run({ guard: { transport: { ok: false, status: 401 } }, config: { guardFailureMode: 'allow' } })).result)
      .toMatchObject({ authorized: false, decision: 'block' });
  });

  it.each(['require_approval', 'require_dual_approval'])('re-POSTs exactly once for a polled %s grant', async decision => {
    const { result, posts, gets } = await run({ guard: { decision }, created: [pending, redeemed], polls: [polled] });
    expect(result).toMatchObject({ authorized: true, decision: 'approved_by_reviewer', actionId: 'act-test' });
    expect(posts.map(x => x.body)).toEqual([{ ...context, status: 'pending_approval' }, { ...context, status: 'running' }]);
    expect(gets).toHaveLength(1);
  });

  it.each(['allow', 'warn'])('honors fresh current-policy %s without a third POST', async decision => {
    const current = { ...action('running', decision), action_id: 'act-new', action: { ...action().action, action_id: 'act-new' } };
    const { result, posts } = await run({ guard: { decision: 'require_approval' }, created: [pending, current], polls: [polled] });
    expect(result).toMatchObject({ authorized: true, decision, actionId: 'act-new' });
    expect(posts).toHaveLength(2);
  });

  it.each([null, action('running', 'require_approval'), action('running', 'block'), action('completed')])
  ('requires reconciliation instead of automatic retry after uncertain or rejected redemption %j', async current => {
    const { result, posts, gets } = await run({ guard: { decision: 'require_approval' }, created: [pending, current], polls: [polled] });
    expect(result).toMatchObject({ authorized: false, decision: 'block', retryAutomatically: false });
    expect(posts).toHaveLength(2);
    expect(gets).toHaveLength(1);
  });

  it.each([
    { ...polled, action: { ...polled.action, action_id: 'other' } },
    { ...polled, action: { ...polled.action, approval_redeemed_at: 'already-used' } },
    { ...polled, action: { ...polled.action, timestamp_end: 'finished' } },
    { ...polled, action: { ...polled.action, action_envelope: { cava: { fingerprint: 'other' } } } },
    { ...polled, action: { ...polled.action, tool_input_digest: 'other' } },
  ])('does not re-POST mismatched or already executed polled actions', async observed => {
    const { result, posts } = await run({ guard: { decision: 'require_approval' }, created: [pending, redeemed], polls: [observed] });
    expect(result).toMatchObject({ authorized: false, decision: 'block', retryAutomatically: false });
    expect(posts).toHaveLength(1);
  });

  it.each(['failed', 'cancelled', 'blocked', 'completed', 'expired'])('does not redeem terminal %s actions', async status => {
    const { result, posts } = await run({ guard: { decision: 'require_approval' }, created: [pending], polls: [action(status)] });
    expect(result).toMatchObject({ authorized: false, decision: 'block', retryAutomatically: false });
    expect(posts).toHaveLength(1);
  });

  it('keeps a dual request held after only one reviewer, without execution state', async () => {
    const one = { ...pending, approval: { state: 'pending', required_approvals: 2, approvals_granted: 1 } };
    const { result, posts } = await run({ guard: { decision: 'require_dual_approval' }, created: [one], polls: [one] });
    expect(result).toMatchObject({ authorized: false, decision: 'require_approval', actionId: 'act-test' });
    expect(posts).toHaveLength(1);
  });

  it('does not poll or authorize observe-only review calls', async () => {
    const { result, posts, gets } = await run({ guard: { decision: 'require_approval' }, created: [pending], config: { mode: 'observe' } });
    expect(result).toMatchObject({ authorized: false, decision: 'require_approval', observeOnly: true });
    expect(posts).toHaveLength(1);
    expect(gets).toHaveLength(0);
  });

  it('reports diagnostic approval policy without requesting or granting approval', async () => {
    const probe = { ...action('cancelled', 'require_dual_approval'), approval: { state: 'not_requested' } };
    const { result, posts, gets } = await run({ guard: { decision: 'require_dual_approval' }, created: [probe], healthCheck: true });
    expect(result).toMatchObject({ authorized: false, decision: 'require_dual_approval', installCheck: true });
    expect(posts[0].body.health_check).toBe(true);
    expect(gets).toHaveLength(0);
  });
});
