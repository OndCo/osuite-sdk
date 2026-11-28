import test from 'node:test';
import assert from 'node:assert/strict';
import { createGovernedTools } from '../../governed-tools.mjs';
import { studioFixture, bindings, params } from './studio.fixture.mjs';

function streamReceipt({ head = 0, end = 0, truncate = false, bytes = 300_000 }) {
  return (res, status, receipt) => {
    const data = JSON.stringify({ ...receipt, evidence: 'x'.repeat(bytes) });
    let last;
    const first = setTimeout(() => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.write(data.slice(0, 512));
      last = setTimeout(() => res.end(truncate ? data.slice(512, -1) : data.slice(512)), end);
    }, head);
    res.once('close', () => { clearTimeout(first); clearTimeout(last); });
  };
}

const cases = [
  ['prompt, valid', {}, true],
  ['slow complete body', { end: 3200 }, true],
  ['late headers', { head: 3200 }, false],
  ['body beyond total deadline', { end: 5500 }, false],
  ['truncated receipt', { truncate: true }, false],
  ['oversized complete receipt', { bytes: 1_100_000 }, false],
];
for (const [name, timing, dispatch] of cases) {
  test('governed receipt: ' + name, async t => {
    const f = await studioFixture();
    t.after(() => f.close());
    const api = createGovernedTools({ ...f, bindings, namespace: 'receipt-deadline', initializeJournal: true });
    t.after(() => api.close());
    f.control.sendReceipt = streamReceipt(timing);
    const operation = api.run('op-1', params(), f.write);
    if (dispatch) assert.equal((await operation).write, 1);
    else await assert.rejects(operation, { code: 'OUTCOME_UNKNOWN' });
    assert.equal(f.counts.actionPosts, 1);
    assert.equal(f.counts.writes, Number(dispatch));
    assert.equal(f.counts.reports, Number(dispatch));
    assert.equal(f.counts.invalidSignatures, 0);
  });
}

test('a redeemed grant expiring while its body is in transit cannot release the tool', async t => {
  const f = await studioFixture();
  t.after(() => f.close());
  const api = createGovernedTools({ ...f, bindings, namespace: 'receipt-expiry', initializeJournal: true });
  t.after(() => api.close());
  f.control.decision = 'hold';
  await assert.rejects(api.run('op-2', params(), f.write), { code: 'AWAITING_APPROVAL' });
  f.approve();
  f.control.sendReceipt = (res, status, receipt) => {
    receipt.action.approval_expires_at = new Date(Date.now() + 600).toISOString();
    streamReceipt({ end: 3100 })(res, status, receipt);
  };
  await assert.rejects(api.run('op-2', params(), f.write), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.counts.actionPosts, 2);
  assert.equal(f.counts.creates, 1);
  assert.equal(f.counts.writes, 0);
});
