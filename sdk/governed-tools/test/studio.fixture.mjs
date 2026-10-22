import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, verify } from 'node:crypto';
import { canonicalJson, sha256 } from '../../runtime/protocol.mjs';

// A wire-contract fixture, not the Studio policy evaluator. The PostgreSQL
// qualification suite separately exercises the actual application routes.
export async function studioFixture() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'osuite-native-'));
  const control = { decision: 'allow', postureMode: 'enforce', signatureRequired: true, revoked: false,
    drop: null, mutate: null, postureUnavailable: false, assumptionCaptureRequired: false };
  const actions = new Map();
  const counts = { guard: 0, actionPosts: 0, creates: 0, reviews: 0, reads: 0, reports: 0, writes: 0, invalidSignatures: 0 };
  const config = { orgId: 'org-native', agentId: 'agent-native', runtimeId: 'sdk', provider: 'sdk',
    apiKey: 'test-only-native-key', privateKeyBase64: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64'),
    mode: 'enforce', signatureMode: 'required', guardFailureMode: 'block' };
  const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/resource') {
      let text = ''; for await (const part of req) text += part;
      counts.writes++;
      return send(res, 200, { received: JSON.parse(text), write: counts.writes });
    }
    if (control.revoked || req.headers['x-api-key'] !== config.apiKey) return send(res, 401, { error: 'unauthorized' });
    let body;
    if (req.method !== 'GET') {
      let text = ''; for await (const part of req) text += part;
      body = JSON.parse(text || '{}');
      const signature = body._signature; delete body._signature;
      if (!signature || !verify('sha256', Buffer.from(canonicalJson(body)), publicKey, Buffer.from(signature, 'base64'))) {
        counts.invalidSignatures++; return send(res, 403, { error: 'signature' });
      }
    }
    if (url.pathname.endsWith('/posture') && req.method === 'GET') {
      control.postureRequests = (control.postureRequests || 0) + 1;
      if (control.beforePosture) await control.beforePosture();
      if (control.postureUnavailable) return send(res, 503, { error: 'unavailable' });
      return send(res, 200, { schema_version: 'osuite.runtime_posture.v1', runtime_id: config.runtimeId,
        org_id: config.orgId, credential_id: 'key-native', credential_fingerprint: sha256(config.apiKey),
        targeting: { agent_id: config.agentId, provider: config.provider }, revision: sha256('posture-1'),
        posture: { runtime_id: config.runtimeId, mode: control.postureMode, on_guard_unavailable: 'block',
          require_signature: control.signatureRequired, require_assumption_capture: control.assumptionCaptureRequired, approval_timeout_seconds: 600 },
        issued_at: new Date().toISOString(), valid_until: new Date(Date.now() + 60000).toISOString() });
    }
    if (url.pathname === '/api/runtime-sessions' && req.method === 'POST') {
      return send(res, 200, { ok: true, session: { ...body, org_id: config.orgId } });
    }
    if (url.pathname === '/api/guard') {
      counts.guard++;
      return send(res, 200, { decision: control.decision === 'hold' ? 'require_approval' : control.decision });
    }
    if (url.pathname === '/api/actions' && req.method === 'POST') {
      counts.actionPosts++;
      let action = actions.get(body.action_id), reused = false;
      if (action?.status === 'running' && action.approved_by && !action.approval_redeemed_at) {
        action.approval_redeemed_at = new Date().toISOString(); reused = true;
      } else if (!action) {
        counts.creates++;
        if (control.decision === 'hold') counts.reviews++;
        action = { ...body, org_id: config.orgId, verified: true,
          status: control.decision === 'hold' ? 'pending_approval' : 'running',
          action_envelope: { runtime_session_id: body.runtime_session_id, cava: { fingerprint: sha256(body.tool_input_digest) } },
          timestamp_end: null, approval_redeemed_at: null };
        actions.set(body.action_id, action);
      } else if (action.status !== 'pending_approval') return send(res, 409, { error: 'duplicate' });
      const response = { action_id: action.action_id, action: structuredClone(action),
        decision: { decision: control.decision === 'hold' ? 'require_approval' : control.decision },
        approval: { state: action.approved_by ? 'approved' : action.status === 'pending_approval' ? 'pending' : 'not_required', reused } };
      if (control.mutate) control.mutate(response);
      if (control.drop === (reused ? 'redemption' : 'create')) { res.destroy(); return; }
      return send(res, reused ? 200 : 201, response);
    }
    if (url.pathname.startsWith('/api/actions/')) {
      const action = actions.get(decodeURIComponent(url.pathname.split('/').at(-1)));
      if (!action) return send(res, 404, { error: 'missing' });
      if (req.method === 'GET') {
        counts.reads++;
        const response = { action_id: action.action_id, action: structuredClone(action),
          approval: { state: action.approved_by ? 'approved' : 'pending' } };
        if (control.mutate) control.mutate(response);
        return send(res, 200, response);
      }
      if (req.method === 'PATCH') {
        counts.reports++;
        Object.assign(action, body);
        if (control.beforeReport) await control.beforeReport();
        if (control.drop === 'report') { res.destroy(); return; }
        return send(res, 200, { action: structuredClone(action) });
      }
    }
    return send(res, 404, { error: 'unsupported' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { config, root, journalPath: path.join(root, 'operations.sqlite'), actions, control, counts,
    approve() {
      for (const action of actions.values()) if (action.status === 'pending_approval') {
        Object.assign(action, { status: 'running', approval_decision: 'allow', approved_by: 'synthetic-reviewer',
          approved_at: new Date(Date.now() - 1).toISOString(), approval_expires_at: new Date(Date.now() + 60000).toISOString() });
      }
    },
    async write(params) {
      const res = await fetch(config.baseUrl + '/resource', { method: 'POST', body: JSON.stringify(params) });
      return res.json();
    },
    async close() {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    } };
}

export const bindings = { 'ledger.append': { revision: 'mapping-1', describe: args => ({
  action_type: 'api', declared_goal: 'Append a ledger record', systems_touched: ['ledger-A'],
  reversible: false, input_summary: { target: args.target, amount: args.amount },
}) } };
export const params = () => ({ name: 'ledger.append', arguments: { target: 'ledger-A', amount: 3 } });
