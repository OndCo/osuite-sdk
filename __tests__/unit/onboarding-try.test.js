import { describe, expect, it, vi } from 'vitest';
import { createTryAction, isTryAction, narrowTryDecision, TRY_OUTPUT } from '../../sdk/tryContract.js';
import { runTryFlow } from '../../sdk/tryFlow.js';

const action = () => createTryAction({ agentId: 'agent_test', runId: '8ce2b1ca-2aaf-4f44-ae8f-c465a69f149c' });
describe('fixed onboarding review boundary', () => {
  it('accepts only the fixed harmless operation', () => {
    const fixed = action();
    expect(isTryAction(fixed)).toBe(true);
    for (const changed of [
      { ...fixed, declared_goal: 'Run something else' }, { ...fixed, systems_touched: ['bank'] },
      { ...fixed, input_summary: '{"command":"evil"}' }, { ...fixed, reversible: false },
    ]) expect(isTryAction(changed)).toBe(false);
  });
  it.each(['allow', 'warn'])('narrows %s to an explicit review without inventing a risk score', (decision) => {
    const old = { decision, risk_result: { risk_score: 2 }, policy_snapshot: { effective_decision: decision } };
    const next = narrowTryDecision(old, action());
    expect(next.decision).toBe('require_approval');
    expect(next.risk_result).toEqual(old.risk_result);
    expect(next.policy_snapshot.effective_decision).toBe('require_approval');
    expect(next.policy_snapshot.effective_rule_metadata.at(-1).rule_id).toBe('onboarding:explicit_review');
    expect(old.decision).toBe(decision);
  });
  it.each(['block', 'simulate_first', 'require_dual_approval', 'require_approval', 'unknown'])
  ('preserves the stricter/unknown %s result', (decision) => {
    const previous = { decision, policy_snapshot: { effective_decision: decision } };
    expect(narrowTryDecision(previous, action())).toBe(previous);
  });
  it('does not change ordinary actions', () => {
    const previous = { decision: 'allow' };
    expect(narrowTryDecision(previous, { ...action(), action_type: 'ordinary' })).toBe(previous);
  });
});

function harness(states = ['pending_approval', 'running']) {
  let proposed;
  let posts = 0;
  const approval = { approved_by: 'human', approved_at: '2026-10-20T10:00:00Z', approval_expires_at: '2026-10-20T10:05:00Z', approval_decision: 'allow' };
  const client = {
    agentId: 'agent_test', baseUrl: 'https://studio.test',
    createAction: vi.fn(async (data) => { proposed = data; posts++;
      return posts === 1 ? { action: { ...data, status: 'pending_approval' } }
        : { action: { ...data, ...approval, status: 'running', approval_redeemed_at: '2026-10-20T10:01:00Z' }, approval: { state: 'approved', reused: true } }; }),
    getAction: vi.fn(async () => {
      const status = states.shift() || 'pending_approval';
      return { action: { ...proposed, status, ...(status === 'running' ? approval : {}) } };
    }),
    updateOutcome: vi.fn(async () => ({ action: { ...proposed, status: 'completed' } })),
  };
  const emit = vi.fn();
  const clock = { now: 0 };
  const options = { client, emit, sleep: async () => { clock.now += 1000; }, now: () => clock.now, timeoutMs: 5000 };
  return { client, emit, options };
}
describe('onboarding try client', () => {
  it('prints once only after the exact action is approved', async () => {
    const { client, emit, options } = harness();
    const result = await runTryFlow(options);
    expect(client.createAction).toHaveBeenCalledTimes(2);
    expect(client.createAction.mock.calls[1][0]).toEqual(client.createAction.mock.calls[0][0]);
    expect(client.getAction).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith(TRY_OUTPUT);
    expect(client.updateOutcome).toHaveBeenCalledTimes(1);
    expect(result.replayUrl).toMatch(/^https:\/\/studio.test\/replay\/act_try_/);
  });
  it.each(['failed', 'expired', 'cancelled', 'blocked', 'completed'])('does not emit success after %s', async (status) => {
    const { client, emit, options } = harness([status]);
    await expect(runTryFlow(options)).rejects.toThrow();
    expect(emit).not.toHaveBeenCalledWith(TRY_OUTPUT);
    expect(client.updateOutcome).not.toHaveBeenCalled();
  });
  it('does not treat unapproved running as permission', async () => {
    const { client, emit, options } = harness();
    client.getAction.mockImplementation(async () => ({ action: { ...client.createAction.mock.calls[0][0], status: 'running' } }));
    await expect(runTryFlow(options)).rejects.toThrow(/approval/i);
    expect(emit).not.toHaveBeenCalledWith(TRY_OUTPUT);
  });
  it('rejects a changed operation under the same action ID', async () => {
    const { client, emit, options } = harness();
    client.getAction.mockImplementation(async () => ({ action: { ...client.createAction.mock.calls[0][0], status: 'running', approved_by: 'human', approved_at: '2026-10-20T10:00:00Z', declared_goal: 'Different' } }));
    await expect(runTryFlow(options)).rejects.toThrow(/bind|match/i);
    expect(emit).not.toHaveBeenCalledWith(TRY_OUTPUT);
  });
  it('times out without resubmitting or recording completion', async () => {
    const { client, emit, options } = harness([]);
    await expect(runTryFlow(options)).rejects.toThrow(/timed out/i);
    expect(client.createAction).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalledWith(TRY_OUTPUT);
    expect(client.updateOutcome).not.toHaveBeenCalled();
  });
  it('reports an unconfirmed completion instead of retrying a lost outcome upload', async () => {
    const { client, options } = harness();
    client.updateOutcome.mockRejectedValue(new Error('network'));
    await expect(runTryFlow(options)).rejects.toThrow(/unconfirmed/i);
    expect(client.updateOutcome).toHaveBeenCalledTimes(1);
  });
  it('rejects an expired approval without printing the acknowledgement', async () => {
    const { client, emit, options } = harness();
    client.getAction.mockImplementation(async () => ({ action: { ...client.createAction.mock.calls[0][0], status: 'running', approved_by: 'human', approved_at: '2026-10-20T10:00:00Z', approval_expires_at: '1970-01-01T00:00:00Z', approval_decision: 'allow' } }));
    await expect(runTryFlow(options)).rejects.toThrow(/expired/i);
    expect(emit).not.toHaveBeenCalledWith(TRY_OUTPUT);
  });
  it('rejects an unrelated successful outcome acknowledgement', async () => {
    const { client, options } = harness();
    client.updateOutcome.mockResolvedValue({ action: { action_id: 'another', status: 'completed' } });
    await expect(runTryFlow(options)).rejects.toThrow(/unconfirmed/i);
  });
  it.each([
    { approval_redeemed_at: '2026-10-20T10:01:00Z' },
    { timestamp_end: '2026-10-20T10:01:00Z' },
    { approved_by: 'api_key' },
    { approval_votes: [{ actor_id: 'api_key', decision: 'allow' }] },
  ])('rejects consumed, ended, or headless approval before admission: %j', async (extra) => {
    const { client, emit, options } = harness(['running']);
    const get = client.getAction.getMockImplementation();
    client.getAction.mockImplementation(async () => {
      const result = await get(); return { action: { ...result.action, ...extra } };
    });
    await expect(runTryFlow(options)).rejects.toThrow();
    expect(client.createAction).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalledWith(TRY_OUTPUT);
    expect(client.updateOutcome).not.toHaveBeenCalled();
  });
  it.each(['lost', 'changed', 'unconsumed', 'new_review'])('does not execute or retry after %s redemption', async (kind) => {
    const { client, emit, options } = harness(['running']);
    const create = client.createAction.getMockImplementation();
    let calls = 0;
    client.createAction.mockImplementation(async (data) => {
      const result = await create(data);
      if (++calls === 1) return result;
      if (kind === 'lost') throw new Error('connection lost after possible redemption');
      if (kind === 'changed') result.action.declared_goal = 'other';
      if (kind === 'unconsumed') result.action.approval_redeemed_at = null;
      if (kind === 'new_review') result.approval.reused = false;
      return result;
    });
    await expect(runTryFlow(options)).rejects.toThrow();
    expect(client.createAction).toHaveBeenCalledTimes(2);
    expect(emit).not.toHaveBeenCalledWith(TRY_OUTPUT);
    expect(client.updateOutcome).not.toHaveBeenCalled();
  });
});
