export const TRY_OUTPUT = 'OSuite walkthrough approved. This acknowledgement is the only local effect.';
const GOAL = 'Print one fixed local acknowledgement after a human review (synthetic walkthrough).';
const SCOPE = 'One terminal acknowledgement. No files, commands, payments or external services.';
const TYPE = 'osuite.onboarding_acknowledgement';
const RUN_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function createTryAction({ agentId, runId }) {
  if (!agentId || !RUN_ID.test(runId)) throw new Error('A connected agent and a unique walkthrough ID are required');
  return {
    action_id: `act_try_${runId}`, agent_id: agentId, action_type: TYPE,
    declared_goal: GOAL, authorization_scope: SCOPE, reversible: true,
    systems_touched: ['local_terminal'], status: 'running',
    runtime_session_id: `try_${runId}`, runtime_family: 'sdk_runtime', adapter_mode: 'inline',
    input_summary: JSON.stringify({ walkthrough: { version: 1, run_id: runId, output: TRY_OUTPUT } }),
    provenance_version: 'osuite-prov-v1',
  };
}

export function isTryAction(action = {}) {
  let trial;
  try { trial = JSON.parse(action.input_summary || '').walkthrough; } catch { return false; }
  let systems = action.systems_touched;
  if (typeof systems === 'string') { try { systems = JSON.parse(systems); } catch { return false; } }
  return action.action_type === TYPE && action.declared_goal === GOAL && action.authorization_scope === SCOPE
    && (action.reversible === true || action.reversible === 1) && JSON.stringify(systems) === '["local_terminal"]'
    && trial?.version === 1 && RUN_ID.test(trial.run_id) && trial.output === TRY_OUTPUT
    && action.action_id === `act_try_${trial.run_id}`
    && (action.runtime_session_id || action.action_envelope?.runtime_session_id) === `try_${trial.run_id}`;
}

// Asking for an extra human review is narrowing, never an exception to policy.
export function narrowTryDecision(previous, action) {
  if (!isTryAction(action) || !['allow', 'warn'].includes(previous?.decision)) return previous;
  const snapshot = previous.policy_snapshot || {};
  return {
    ...previous, decision: 'require_approval',
    reason: 'This synthetic walkthrough explicitly requests a human review before its fixed terminal acknowledgement.',
    policy_snapshot: {
      ...snapshot, effective_decision: 'require_approval',
      effective_rule_metadata: [
        ...(Array.isArray(snapshot.effective_rule_metadata) ? snapshot.effective_rule_metadata : []),
        { rule_id: 'onboarding:explicit_review', rule_name: 'Synthetic walkthrough: explicit human review',
          rule_type: 'onboarding_review', source: 'onboarding', outcome_action: 'require_approval' },
      ],
    },
  };
}
