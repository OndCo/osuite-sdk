import { createGovernedTools } from '../../governed-tools.mjs';
import { sha256, canonicalJson, validatedBaseUrl } from '../../runtime/protocol.mjs';

const initializeJournal = process.argv.includes('--initialize-journal');
if (process.argv.includes('--help') || (!process.argv.includes('--execute') && !initializeJournal)) {
  console.log('Native tool example (Node 24). No calls performed.\n'
    + 'To execute one explicitly configured operation, set OSUITE_BASE_URL, OSUITE_ORG_ID, '
    + 'OSUITE_AGENT_ID, OSUITE_API_KEY, OSUITE_PRIVATE_KEY_BASE64, OSUITE_JOURNAL_PATH, '
    + 'NATIVE_TOOL_URL and OPERATION_ID. Provision once with --initialize-journal; '
    + 'later pass --execute to run against the existing journal.\n'
    + 'The target receives one synthetic append; use a dedicated resource you control.');
} else {
  if (initializeJournal && process.argv.includes('--execute')) throw new Error('Provisioning and execution are separate operations.');
  const url = validatedBaseUrl(process.env.NATIVE_TOOL_URL);
  if (!url) throw new Error('NATIVE_TOOL_URL must be an explicit HTTPS or loopback resource.');
  const tools = createGovernedTools({
    config: { baseUrl: process.env.OSUITE_BASE_URL, orgId: process.env.OSUITE_ORG_ID,
      agentId: process.env.OSUITE_AGENT_ID, runtimeId: 'sdk', provider: 'sdk',
      apiKey: process.env.OSUITE_API_KEY, privateKeyBase64: process.env.OSUITE_PRIVATE_KEY_BASE64,
      mode: 'enforce', signatureMode: 'required', guardFailureMode: 'block' },
    namespace: 'native-example', journalPath: process.env.OSUITE_JOURNAL_PATH, initializeJournal,
    bindings: { 'ledger.append': { revision: 'example-1', describe: args => ({
      action_type: 'api', declared_goal: 'Append one synthetic native-tool example record',
      systems_touched: [url], reversible: false,
      input_summary: { url, method: 'POST', tool_name: 'ledger.append', payload_digest: sha256(canonicalJson(args)) },
    }) } },
  });
  if (initializeJournal) {
    tools.close();
    console.log('Journal provisioned. No tool, network call or host installation performed.');
  } else {
  try {
    await tools.run(process.env.OPERATION_ID,
      { name: 'ledger.append', arguments: { example: true, amount: 3 } },
      async ({ arguments: args }) => {
        const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });
        if (!response.ok) throw new Error('Native response was not successful.');
        return response.json();
      });
    console.log(JSON.stringify(await tools.status(process.env.OPERATION_ID)));
  } catch (error) {
    console.error(JSON.stringify({ code: error.code || 'OUTCOME_UNKNOWN', status: error.status || null, retryAutomatically: false }));
    process.exitCode = 1;
  } finally { tools.close(); }
  }
}
