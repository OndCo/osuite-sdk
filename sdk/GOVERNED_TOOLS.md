# Native Tool Compatibility And Recovery

This opt-in API is introduced in 2.11.0; it is not part of 2.10.2. Confirm the
chosen version with `npm view osuite@2.12.0 version` before installing. A source
checkout alone does not establish npm availability or server compatibility;
consult the verified release record before enabling it for a workspace.

`osuite/governed-tools` is ESM and requires **Node 24 on POSIX**. It uses built-in
SQLite; it adds no production dependency. Existing `osuite` imports, CommonJS,
CLI, advisory MCP tools and Hook support are unchanged. Nothing is installed or
activated in a host by importing it.

## What Changes In An Application

Keep your native tool name, JSON arguments, callback and successful result.
Configure a trusted mapping and a private journal once; give each business
operation a stable ID. The wrapper calls the original callback only after
current Studio admission. It does not ask the model to use a different tool.

Provision a new journal deliberately: construct once with
`initializeJournal: true`, then close it without running a tool. Normal
application starts use `false` (the default). A missing or uninitialized journal
then fails rather than quietly recreating operation history. Never leave the
initialization flag enabled as a restart/recovery shortcut.

```js
import { createGovernedTools } from 'osuite/governed-tools';

const tools = createGovernedTools({
  config: {
    baseUrl: process.env.OSUITE_BASE_URL,
    orgId: process.env.OSUITE_ORG_ID,
    agentId: process.env.OSUITE_AGENT_ID,
    runtimeId: 'sdk',
    provider: 'sdk',
    apiKey: process.env.OSUITE_API_KEY,
    privateKeyBase64: process.env.OSUITE_PRIVATE_KEY_BASE64,
    mode: 'enforce',
    signatureMode: 'required',
    guardFailureMode: 'block',
  },
  namespace: 'billing-service',
  journalPath: '/absolute/private-directory/billing.sqlite',
  initializeJournal: false,
  bindings: {
    'ledger.append': {
      revision: 'ledger-mapping-1',
      describe: args => ({
        action_type: 'api',
        declared_goal: 'Append the specified billing ledger record',
        systems_touched: ['billing-ledger'],
        reversible: false,
        input_summary: { target: args.target, amount: args.amount },
      }),
    },
  },
});

try {
  const result = await tools.run(
    job.operationId,
    { name: 'ledger.append', arguments: job.arguments },
    ({ arguments: args }) => ledger.append(args),
    { waitMs: 30000, signal: abortController.signal },
  );
  // The actual ledger result, not an OSuite-generated substitute.
  consumeNativeResult(result);
} catch (error) {
  if (error.code === 'AWAITING_APPROVAL') {
    showExistingReview(error.status.actionId, error.status.reviewUrl);
    // Resume this same operation later; do not create a replacement ID.
  } else {
    showExplicitFailure(error.code, error.status);
  }
} finally {
  tools.close();
}
```

The description is an application-maintained semantic mapping, **not authority**.
Validate it against the real tool implementation. Include the consequential
target, operation, destination, amount/data boundary and relevant constraints;
the sample is not a universal banking policy. A signature proves who supplied
the mapping, not that the mapping is semantically complete. Studio still owns
the allow/hold/deny decision. Do not put secrets in `input_summary`: that bounded
description is sent to Studio even though full native arguments stay local.

Use a separately enrolled SDK/MCP identity with a current signing key. A Hook
credential is not interchangeable with an SDK credential. The new `sdk`/`mcp`
posture endpoint must be deployed server-side. Older servers fail explicitly;
there is no unsigned, offline, observe-mode or raw-client fallback. A configured
mandatory scoped policy is never ignored to make this wrapper work.
This profile does not implement assumption-capture workflows; a posture that
requires them is refused rather than silently reported as satisfied. Posture
is current client configuration, not a resource capability or proof that every
unsigned request to the server is prohibited. Actual signed action responses
and fresh admission are checked separately.

### Choose The Intended Configuration Scope

Device enrollment and a tool/provider connection are different records. An
enrolled SDK identity does not by itself create an `agent_connections` entry.
Administrative posture writes to `/api/runtimes/sdk/posture` use these targets:

| POST target fields | Intended scope |
| --- | --- |
| Neither `agent_id` nor `provider` | Workspace SDK defaults. |
| `agent_id`, without `provider` | That agent's SDK posture. |
| Both `agent_id` and `provider: sdk` | An existing provider connection's SDK override. |

Only an authorized administrator may write posture. A device credential's
ability to read effective posture is not permission to manage it. Read the
current complete posture before an intended update, retain its other fields,
and re-read the effective configuration afterward. Do not silently broaden a
connection-targeted update to agent or workspace scope after a 404.

An SDK read with `agent_id` and `provider=sdk` inherits the agent posture when no
connection override exists. Check `scope`, `source` and `targeting`, rather than
inferring writable scope from a successful GET. `Connection not found for posture
override` means the selected connection write target was absent, not that the
agent-scoped route is necessarily unavailable.

POST and GET revision hashes do not currently share an identical input shape:
GET also includes rollout-negotiation metadata. Different target tuples also
change the revision. Check each response against its own declared scope and
content; do not treat POST/GET hash inequality alone as a failed write. A required
capability that this wrapper cannot satisfy must still stop execution; reducing
that requirement is an administrator's policy decision, not an SDK recovery step.

## Connected MCP Client

```js
import { wrapMcpClient } from 'osuite/governed-tools';
const governed = wrapMcpClient(alreadyConnectedMcpClient, tools);
const result = await governed.operation(job.operationId).callTool(
  { name: 'ledger.append', arguments: job.arguments },
  nativeResultSchema,
  { signal: abortController.signal, timeout: 10000 },
);
```

The supplied client's receiver, schema, allowed options and original returned
result are preserved. Its timeout is the native call timeout, not a new approval
wait budget. The adapter defaults to returning a held status promptly; invoke
the same operation after review. `governed.status(id)` reads existing status and
never executes or redeems an approval.

This bounded profile supports ordinary `callTool` with explicit `name` and
object `arguments`, and only `signal` / `timeout` options. Names and operation
IDs are 1-128 ASCII identifier characters (`A-Z`, `a-z`, digits, `_`, `.`, `-`),
must start with an alphanumeric character or `_`, and cannot contain `..`.
Inputs must be lossless JSON, at most 32 KiB, depth 16 and 8,192 nodes. Unsupported
accessors, proxy objects and prototype-sensitive keys (`__proto__`, `prototype`,
`constructor`) are rejected even when a native client might accept them.
Unsupported
metadata, tasks, streams, progress callbacks and arbitrary MCP requests are
rejected, not silently stripped. OAuth, discovery and connection setup remain
with your existing MCP client. This is not a universal MCP gateway certification.

## Recovery Contract

An operation ID means one business intention, not equality of arguments or a
JSON-RPC request number. Persist it in your existing job record. Different IDs
with identical arguments remain different legitimate operations. Reusing an ID
with changed input or mapping is a conflict. Changing the namespace or identity
creates a different scope: never use that as a recovery shortcut.

| State / error | Required application behavior |
| --- | --- |
| `AWAITING_APPROVAL` | Show the existing review; resume the same ID and exact input. |
| `ALREADY_COMPLETED` | Do not execute again. Load business output from your own store. |
| `OPERATION_BUSY` | Another caller owns the transition; read status, do not invent an ID. |
| `OUTCOME_UNKNOWN` | Inspect the resource separately; do not automatically resend. |
| `POLICY_DENIED` / expiry / cancellation | Respect the terminal refusal. A new intention needs explicit operator action. |
| `CURRENT_AUTHORITY_UNAVAILABLE` | Restore current server/identity configuration; never fall back to ungoverned execution. |
| `JOURNAL_BUSY` | Preserve the same ID and journal; inspect contention and existing status. No automatic resend or state reset. |
| `JOURNAL_MISSING` / invalid journal | Restore the correct durable journal; do not initialize an empty replacement to replay old IDs. |
| `ABORTED` | The local waiter stopped. This does not revoke approval or undo a dispatched effect. |

Since 2.11.1, `error.recovery` and `status.recovery` expose a bounded `nextStep`,
`preserveOperationId: true`, and an explanatory `message` for the UI. They contain
no native arguments or result payloads. Show them alongside the stable error
code; do not treat them as a grant, a promise of resumability, or an automatic
retry instruction. `retryAutomatically` remains false on errors. After an
unknown dispatch, `reconcile_without_resend` means inspect the resource, not
call the wrapper with a new ID.

Restart can resume a held review. It cannot infer that a request was not sent
from a timeout, missing response, crashed process, or lost completion report.
Only an exact server record that is still pending can repair an uncertain
initial creation into a held state. Redemption/dispatch fences are not reset.
A successful GET showing approval is not a grant to send: a fresh signed POST
must validate and redeem the original request.

There is no distributed transaction with an arbitrary SaaS. The journal commits
the dispatch fence before invoking the callback. This prevents automatic local
resend but can leave a request uncertain if the process dies between those two
steps. Third-party resource reconciliation and business idempotency remain
application responsibilities. A new machine must retain the same journal and
scope; deleting or restoring an old journal is not supported recovery.

## Results And Storage

Successful native output is returned unchanged and is **not persisted**. A later
duplicate cannot reconstruct it. The journal stores bounded IDs, commitments,
states and an optional result digest. Opaque/non-JSON native returns can have a
null digest; neither a return nor a digest is independent resource verification.
MCP `isError: true` is returned unchanged but leaves the operation uncertain,
since native errors can occur after partial effects. Exceptions are sanitized;
arbitrary error strings, credentials and full outputs are not stored.

Outcome reporting is separate. If Studio loses the reporting acknowledgement,
the native result remains the return value and `reportState` is `uncertain`.
Do not replay the tool to repair a report. `close()` prevents new work; an
already-started native call is allowed to record its outcome before SQLite closes.

### Read Status At The Correct Layer

Do not collapse the following fields into one business-success flag:

| Observation | Meaning | Does not establish |
| --- | --- | --- |
| Local `state: completed` | The wrapper observed a native return without its error flag. | Independent resource verification, settlement or retention of the full result. |
| Local `state: uncertain` | The operation is fenced without a confirmed native outcome; the callback may not have run. | Failure, rollback or permission to resend. |
| `reportState: confirmed` | Studio acknowledged the wrapper's outcome report. | Successful business execution. An uncertainty report can itself be confirmed. |
| `remote.status: failed` with local `uncertain` | The SDK reports native uncertainty using this lifecycle label with `observation: outcome_unknown`; neither business failure nor reporting failure follows from the label. | Proof that the external resource did not commit. |
| Authorized resource readback | Evidence about the resource's recorded operation and effect. | A new execution grant or an automatic transition of the SDK journal to completed. |

For example, a resource can commit and then lose its acknowledgement. The native
callback throws, the SDK retains `uncertain`, and Studio may show `failed` with
an `osuite.native_tool_observation.v1` summary whose observation is
`outcome_unknown`. A confirmed report of that uncertainty is consistent with a
real resource commit. `status()` is read-only; restarting the adapter does not
resolve this disagreement or authorize redispatch.
Inspect `output_summary` through an authorized action read; SDK `status()` does
not expose that summary.

An application recovery procedure should preserve the original operation ID,
scope and journal, read SDK status, then use its existing authenticated resource
status interface. Check the tenant/resource identity, business operation ID,
target and relevant arguments or commitments against the original job. Missing,
ambiguous or mismatched evidence remains unknown. Even `not_found` may reflect
an incomplete index or an in-flight request, not proof of non-execution. Display
a verified resource result separately from local execution and reporting state;
do not edit the SDK journal, manufacture a receipt, or rerun the callback to make
the labels agree. This release has no general resource-reconciliation callback
that automatically converts an arbitrary tool's uncertain result to completed.
Version 2.14.0 adds an explicit host-selected `recover()` path for bindings with
a preinstalled trusted resource adapter. It preserves the uncertain parent and
uses a separately authorized recovery child; it does not change ordinary
`run()` or `status()`. See [Evidence-bound native recovery](GOVERNED_RECOVERY.md).

Use an owner-only directory and a durable local filesystem. Unsafe ownership,
permissions, symlinks/hardlinks and invalid database paths are rejected. SQLite
uses transactional CAS and full durability. The default limit is 10,000 retained
operations; exhaustion stops new work. Normal opening never creates a missing
database. Explicit initialization is a provisioning action, not recovery.
Version 2.11.2 changes the default `journalOptions.busyTimeoutMs`
from 100 to 1,000 ms; the supported range remains 0-5,000 ms. This is a bounded
local write-lock budget, not extra approval time or an operation retry policy.
After the dispatch fence commits, the existing five-second admission-receipt
age limit is checked again immediately before the callback. An expired receipt
leaves an uncertain fence; it is never renewed or automatically retried.
Do not delete completed or unknown rows
to make room: they are replay tombstones. Plan scoped lifecycle/retention with
the operator, retain the WAL correctly, and never share this database over an
unqualified network filesystem. Windows ACL qualification is not included.

## Honest Coverage And Cost

Status reports `coverage: wrapped-call-only` and
`admissionPath: studio-current-action`. The raw client, alternative credentials,
direct resource access and a compromised application can bypass this wrapper.
It is not a resource-side enforcement boundary or a ZeroGate Action Pass path.
There is no claim that old Azure gate latency applies here. Current posture,
guard/action requests, durable writes and reporting all have real costs.
Studio responses are bounded to 1 MiB; larger responses refuse admission rather
than silently dropping evidence. Short configuration-cache contention can cause
bounded fresh configuration reads (at most six), never a repeated action POST
or tool invocation. A persistent cache lock is not removed automatically.

Production gateway deployment requires separate resource IAM, credentials,
network fencing, availability and recovery qualification. This release does not
enable Hook, modify the existing ZeroGate/Matoi algorithms or deploy that gateway.
