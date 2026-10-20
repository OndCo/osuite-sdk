import crypto from 'node:crypto';
import { createTryAction, isTryAction, TRY_OUTPUT } from './tryContract.js';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function assertApprovedAction(current, proposed, now, { redeemed = false } = {}) {
  if (!current || current.action_id !== proposed.action_id || current.agent_id !== proposed.agent_id || !isTryAction(current)) {
    throw new Error('The returned action does not match the fixed walkthrough binding');
  }
  let votes = current.approval_votes || [];
  try { if (typeof votes === 'string') votes = JSON.parse(votes); } catch { votes = null; }
  if (current.status !== 'running' || current.approval_decision !== 'allow'
    || typeof current.approved_by !== 'string' || !current.approved_by.trim() || current.approved_by === 'api_key'
    || !current.approved_at || !Array.isArray(votes)
    || votes.some(vote => vote?.decision === 'allow' && vote?.actor_id === 'api_key')) {
    throw new Error('No explicit human approval for this walkthrough. Nothing was executed.');
  }
  if (current.timestamp_end || (redeemed ? !Number.isFinite(Date.parse(current.approval_redeemed_at || '')) : current.approval_redeemed_at)) {
    throw new Error('The walkthrough grant is ended, already consumed, or not freshly redeemed. Nothing was executed.');
  }
  const expiry = Date.parse(current.approval_expires_at || '');
  if (!Number.isFinite(expiry) || expiry <= now()) throw new Error('The walkthrough approval is expired or has no verifiable expiry');
}

export async function runTryFlow({
  client, emit = (text) => process.stdout.write(`${text}\n`),
  now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 300000, intervalMs = 2000, privateKeyBase64 = '', signatureRequired = false,
} = {}) {
  if (!client) throw new Error('Connect a runtime before starting the walkthrough');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 900000) throw new Error('Walkthrough timeout must be between 1 and 900000 milliseconds');
  const action = createTryAction({ agentId: client.agentId, runId: crypto.randomUUID() });
  const baseUrl = new URL(client.baseUrl);
  const replayUrl = new URL(`/replay/${encodeURIComponent(action.action_id)}`, baseUrl).href;
  if (client.agentKeyId) action.agent_key_id = client.agentKeyId;
  if (signatureRequired && !privateKeyBase64) throw new Error('Required request signing is not configured. Reconnect this runtime.');
  if (privateKeyBase64) {
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(canonical(action));
    action._signature = signer.sign(Buffer.from(privateKeyBase64, 'base64').toString('utf8'), 'base64');
  }

  emit('Synthetic walkthrough: one fixed terminal acknowledgement, only after a human approves. No shell command or external tool will run.');
  emit(`Review and evidence: ${replayUrl}`);
  const created = await client.createAction(action);
  const initial = created?.action;
  if (!initial || initial.action_id !== action.action_id || initial.agent_id !== action.agent_id
      || initial.status !== 'pending_approval') {
    throw new Error('The workspace did not open a review for this walkthrough. Nothing was executed; inspect the decision before starting a new run.');
  }
  const started = now();
  while (now() - started < timeoutMs) {
    const { action: current } = await client.getAction(action.action_id);
    if (!current || current.action_id !== action.action_id || current.agent_id !== action.agent_id || !isTryAction(current)) {
      throw new Error('The returned action does not match the fixed walkthrough binding');
    }
    if (current.status === 'pending_approval') { await sleep(intervalMs); continue; }
    assertApprovedAction(current, action, now);
    // GET observes a decision; only the existing POST admission path can
    // re-evaluate policy and atomically consume this exact grant.
    let admission;
    try { admission = await client.createAction(action); } catch {
      throw new Error(`Walkthrough admission is unconfirmed. Nothing was printed; do not retry this grant. Inspect ${replayUrl}`);
    }
    if (admission?.approval?.reused !== true || admission.approval.state !== 'approved') {
      throw new Error('No freshly redeemed approval for the same walkthrough. Nothing was executed.');
    }
    assertApprovedAction(admission.action, action, now, { redeemed: true });
    emit(TRY_OUTPUT);
    try {
      const updated = await client.updateOutcome(action.action_id, {
        status: 'completed', output_summary: TRY_OUTPUT, side_effects: ['Printed one fixed local acknowledgement'],
        artifacts_created: [],
      });
      if (updated?.action?.action_id !== action.action_id || updated?.action?.status !== 'completed') {
        throw new Error('Outcome acknowledgement did not match');
      }
    } catch {
      throw new Error(`The local acknowledgement was printed, but its outcome is unconfirmed. Do not repeat it; check ${replayUrl}`);
    }
    return { actionId: action.action_id, replayUrl, status: 'completed' };
  }
  throw new Error(`Timed out waiting for approval. No acknowledgement was printed. Inspect or deny the existing request at ${replayUrl}; it will expire without execution.`);
}
