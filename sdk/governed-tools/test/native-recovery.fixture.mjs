import http from 'node:http';
import { createGovernedTools } from '../executor.mjs';
import { studioFixture } from './studio.fixture.mjs';

export const namespace = 'native-recovery';
export const operationId = 'business-1';
export const params = () => ({ name: 'benchmark.invoke', arguments: {
  tool_name: 'commit', arguments: { requestId: 'request-1', proposalId: 'proposal-1', amount: 3 },
} });

export function recoveryBindings(resourceUrl, contract, hooks = {}) {
  return { 'benchmark.invoke': {
    revision: 'mapping-1',
    describe: () => ({ action_type: 'api', declared_goal: 'Commit the original proposal', systems_touched: ['ledger-A'] }),
    recovery: {
      revision: 'recovery-1', resourceId: 'ledger-A', contract,
      async observe({ params: native, binding }) {
        if (native.arguments.tool_name !== 'commit') return null;
        const response = await fetch(`${resourceUrl}/status`);
        if (!response.ok) throw new Error('resource status unavailable');
        const proof = await response.json();
        const now = Date.now();
        const evidence = { ...binding, schemaVersion: 'osuite.native_recovery_evidence.v1',
          observedAt: now, expiresAt: now + 5000, settled: proof.settled,
          outcome: proof.outcome, proof };
        return hooks.observe ? hooks.observe(evidence, { params: native, binding }) : evidence;
      },
      async execute(native, context) {
        if (hooks.beforeExecute) await hooks.beforeExecute(native, context);
        // The fixture's exclusive actor is the only writer. Recheck its resource
        // epoch, then preserve the original request/proposal and all payload bytes.
        const proof = await (await fetch(`${resourceUrl}/status`)).json();
        if (!proof.settled || proof.epoch !== context.evidence.proof.epoch
            || (contract === 'settled-absence' && proof.outcome !== 'absent')) throw new Error('resource changed');
        const response = await fetch(`${resourceUrl}/commit`, { method: 'POST', body: JSON.stringify(native) });
        if (!response.ok) throw new Error('commit failed');
        const result = await response.json();
        if (hooks.afterExecute) return hooks.afterExecute(result);
        return result;
      },
    },
  } };
}

export async function setup(t, contract = 'settled-absence', hooks = {}) {
  const studio = await studioFixture();
  const resource = { calls: 0, observations: 0, effects: [], settled: true, epoch: 0,
    fault: contract === 'settled-absence' ? 'before' : 'after', unavailable: false };
  const send = (res, code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  const server = http.createServer(async (req, res) => {
    if (req.url === '/status') {
      resource.observations++;
      return send(res, resource.unavailable ? 503 : 200, { settled: resource.settled,
        outcome: resource.effects.length ? 'applied' : 'absent', epoch: resource.epoch,
        exclusiveWriter: true, noDeferredEffects: true });
    }
    if (req.url !== '/commit' || req.method !== 'POST') return send(res, 404, {});
    let text = ''; for await (const part of req) text += part;
    const native = JSON.parse(text);
    resource.calls++;
    const fault = resource.fault; resource.fault = null;
    if (fault === 'before') { res.destroy(); return; }
    let result = resource.effects.find(item => item.received.arguments.arguments.requestId === native.arguments.arguments.requestId);
    if (result && contract === 'same-id-idempotent') {
      if (JSON.stringify(result.received) !== JSON.stringify(native)) return send(res, 409, {});
    } else {
      result = { received: native, receipt: `receipt-${resource.effects.length + 1}` };
      resource.effects.push(result); resource.epoch++;
    }
    if (fault === 'after') { res.destroy(); return; }
    return send(res, 200, result);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const resourceUrl = `http://127.0.0.1:${server.address().port}`;
  const bindings = recoveryBindings(resourceUrl, contract, hooks);
  const options = { config: studio.config, journalPath: studio.journalPath, namespace, bindings };
  const instances = [];
  const open = (overrides = {}) => {
    const tools = createGovernedTools({ ...options, initializeJournal: instances.length === 0, ...overrides });
    instances.push(tools); return tools;
  };
  t.after(async () => {
    for (const tools of instances) tools.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await studio.close();
  });
  const original = async native => {
    const response = await fetch(`${resourceUrl}/commit`, { method: 'POST', body: JSON.stringify(native) });
    if (!response.ok) throw new Error('commit failed');
    return response.json();
  };
  return { ...studio, options, bindings, resource, resourceUrl, open, tools: open(), original };
}
