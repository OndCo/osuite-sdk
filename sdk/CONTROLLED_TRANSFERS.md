# Matoi Controlled Transfers

**Unreleased candidate.** This entry is in the working SDK source, not the
already published `osuite@2.11.2`. Installing that registry version does not
provide these APIs. A versioned SDK release and matching server deployment must
be qualified together before customer rollout.

The additive ESM entry `osuite/controlled-transfers` speaks the
`matoi.controlled-transfer.v1` semantic profile to the resource-owned **controlled ledger**.
Its default full lease remains v1; this candidate also reads explicitly requested
compact `matoi.controlled-transfer.lease.v2` leases, as described below.
It requires **Node 24**. The ordinary SDK exports, Hook, runtime requirements,
installation settings and signing transport are unchanged.

Installing this package does **not** establish full-stack deployment protection.
The profile must be enabled and configured on the server, with actual native
Studio review and a resource-enforcing owner. This entry is not an external bank,
blockchain, arbitrary tool wrapper or local transfer callback. Deployment
qualification requires separate acceptance evidence; `not-qualified` and
`integrated-tested` are not `deployment-qualified`.

## Resource Operator Setup

This is explicit operator configuration, not an automatic SDK installation
step. Use a test deployment and synthetic balances until deployment qualification
is complete. Initial ledger balances do not represent an actual bank deposit.

1. Install the matching Studio server with its normal schema, authentication,
   workspace membership, SDK/MCP enrollment and approval configuration. Use
   `DASHCLAW_DB_DRIVER=postgres` and a writable interactive PostgreSQL connection.
   The mock driver and Neon HTTP-only query adapter cannot provide this profile's
   transaction boundary.
2. Provision `OSUITE_MATOI_TRANSFER_ENABLED=true`, an explicit JSON array of
   activated workspace IDs in `OSUITE_MATOI_TRANSFER_WORKSPACES`, and
   `OSUITE_MATOI_ISSUER_PRIVATE_KEY_B64` (base64-encoded Ed25519 PKCS8 PEM) through
   the server's secret management. Keep both the issuer private key and database
   credentials away from agent hosts. Distribute the corresponding public key
   through a trusted channel for client pinning. Missing, malformed, empty or
   nonmatching workspace scope never enables new execution. Removing a workspace
   from the scope leaves authenticated historical reads and administrator
   revocation available; it does not erase receipts or grant a safe retry.
3. From a current workspace owner/admin session, POST configuration to
   `/api/matoi/transfers/configuration`. This endpoint does not accept an agent
   API key as administrative approval. It validates membership and records the
   mutation with its audit event. Browser requests must be same-origin.
4. Initialize storage, provision source/destination accounts, then register a
   finite grant for the actual enrolled agent/key. Initialization creates six
   profile tables and authority-serialization triggers on existing Studio tables;
   rehearse this migration and required database privileges before production.
   Missing/disabled triggers or incomplete setup leave capability unavailable.
5. Run the explicit doctor probe, prepare one allowed operation, complete its
   real Studio review, execute and verify its receipt, then test rejection and
   recovery. Doctor success reports configuration, not deployment certification.

Configuration requests have the following exact fields. Tenant and administrator
identity come from the authenticated session, never these JSON bodies.

| `kind` | Additional body fields | Purpose |
| --- | --- | --- |
| `initialize` | None | Create the profile's schema and workspace authority |
| `account` | `accountId`, `asset`, `network`, `decimals`, `balanceMinor`, `debitLimitMinor` | Provision a controlled account with exact integer-string amounts |
| `grant` | `agent_id`, `keyId`, `grantId`, `workflow`, `state`, `allowedEffects`, `budgetMinor`, `expiresAt` | Bind the enrolled principal, finite workflow, exact coupled effects, total budget and expiry |
| `authority` | `grantId`, `active`, and optionally `allowedEffects`, `budgetMinor` | Revoke/reactivate or update current authority without widening the original boundary |
| `state` | `grantId`, `state` | Update owner-controlled workflow state; relevant changes require reassessment |

The workflow grammar and exact effect example are in the
[implementation contract](../docs/superpowers/plans/2026-10-31-matoi-controlled-transfer-implementation.md).
Expiry is an integer Unix time in milliseconds, at most 24 hours ahead; prepared
leases last at most five minutes and cannot outlive the grant. An operator must
source each allowed `paymentId` from its business records, not let the agent mint
new authorized payments. A deployment must also prevent direct access to the
underlying ledger; this configuration API alone does not prove route coverage.

## Configuration

```js
import { createControlledTransfers } from 'osuite/controlled-transfers';

const transfers = createControlledTransfers({
  config: {
    baseUrl: process.env.OSUITE_BASE_URL,
    apiKey: process.env.OSUITE_API_KEY,
    privateKeyBase64: process.env.OSUITE_PRIVATE_KEY_BASE64,
    orgId: process.env.OSUITE_ORG_ID,
    agentId: process.env.OSUITE_AGENT_ID,
    signatureMode: 'required',
    guardFailureMode: 'block',
    // Optional: pin the server's Ed25519 public key as SPKI PEM.
    // issuerPublicKey: trustedIssuerPublicKey,
    // Optional: explicit historical Ed25519 public roots, never private keys.
    // trustedIssuerPublicKeys: [previousIssuerPublicKey],
    // Optional: assert the authenticated credential's exact key ID.
    // keyId: credentialKeyId,
    timeoutMs: 2500,
  },
});
```

`baseUrl` uses the existing runtime configuration spelling. HTTPS or HTTP on
`localhost`, `127.0.0.1` or `[::1]` is required. Credentials in URLs, queries,
fragments, non-loopback HTTP, missing tenant/agent identity, missing or non-RSA
private keys, optional signing and fail-open modes are rejected before network
I/O. `allowInsecureHttp` cannot weaken this profile. `timeoutMs` is an integer
from 1 to 30000. There is no fetch override, raw execute callback, automatic
approval, timer-driven polling or mutation retry option.

The RSA PEM is base64 encoded for `privateKeyBase64`, as in the existing SDK.
All requests authenticate with `x-api-key`. POST requests use the unchanged
`runtime/protocol.mjs` client to attach an RSA `_signature` over canonical JSON.

For key rotation, provision up to eight previous Ed25519 SPKI public keys as the
server's `OSUITE_MATOI_TRUSTED_ISSUER_PUBLIC_KEYS_B64` (base64 of a JSON array of
PEM strings) and the client's `trustedIssuerPublicKeys`. The strict CLI accepts
the same environment field in its one selected credential bundle. Historical
keys verify original preparations and receipts during status recovery; fresh
prepare/execute authority still requires the current issuer. No key embedded in
a response is automatically accepted as a historical root. An existing client
pinned to the retired key must be reconfigured explicitly. Unknown or conflicting
history stays unknown and does not authorize a resend.

Historical signature verification alone does not fence an old writer or detect a
database rewind. Rotation/restore activation must also follow the tested resource
owner fencing and recovery procedure, preserving authoritative payment history.

`CONTROLLED_TRANSFER_MAX_ENVELOPE_BYTES`, exported by `osuite/controlled-transfers`,
is 1,048,576 (1 MiB). Only this profile's HTTP client, including the doctor probe,
overrides the existing transport's response limit. Ordinary SDK/Hook limits are
unchanged. Defensive snapshots allow at most 65,536 nodes, depth 24, and 1 MiB of
canonical JSON, covering a 64-effect status with its signed original preparation,
per-effect native passes and receipts. Over-limit responses remain unavailable or
`OUTCOME_UNKNOWN`, never proof of non-execution or permission to resend.

## Workflow

```js
const capability = await transfers.capabilities();
console.log(capability.qualification.status); // A server report, not an SDK guarantee.

// Retain the operation ID and preparation in your application's durable store.
const prepared = await transfers.prepare('invoice-batch-42', 'owner-grant-42');
console.log(prepared.state, prepared.actionId, prepared.reviewUrl);
```

`capabilities()` performs one authenticated GET. It validates the profile,
scope and capability schema, but may report `configured: false` and
`issuerPublicKey: null`. Every new prepare or execute send requires a fresh
capability response with `installed`, `configured` and `resourceEnforced` true,
scope `controlled-ledger`, and a usable Ed25519 issuer key. Qualification remains
an independent server report, not a boolean inferred from installation.

`prepare(operationId, grantId)` performs at most one prepare POST per operation
in this client instance. It returns an immutable, verified preparation and the
existing Studio `actionId` and `reviewUrl`, with `retryAutomatically: false`.
`awaiting_approval` is **not** authorization. If the server is still `preparing`
with no action bound, the review URL is null; do not invent a review or resend
to create another one. Repeated/concurrent calls reuse the same preparation.
Changing the grant under an existing operation ID is a conflict. A native-policy
`denied` preparation remains a refusal and cannot be executed by this client.

### Optional Compact Leases

Use only a newly qualified SDK/server pair supporting this option. Older JavaScript
clients can ignore an extra argument, so adding an option to an old installation
does not guarantee compact issuance. Default two-argument calls, MCP and CLI
callers continue requesting full leases; there is no automatic negotiation or
fallback to a different representation.

```js
const prepared = await transfers.prepare('invoice-batch-43', 'owner-grant-43', {
  leaseFormat: 'matoi.controlled-transfer.lease.v2',
});
```

The new format signs an ordered commitment to every original Action Pass. At the
existing final gate, the owner reconstructs only the selected step and verifies
its complete pass hash, ID and action fingerprint. Issuance still builds the real
passes once. Current authority, native approval/quorum, expiry, monetary limits,
predecessors and atomic consumption are unchanged. Financial actions still use
the approved slow lane; compact storage is not permission to bypass review or a
claim of measured end-to-end speed.

An authenticated capability response adds `leaseFormats` with exact
`supported: ['matoi.controlled-transfer.v1', 'matoi.controlled-transfer.lease.v2']`,
`default: 'matoi.controlled-transfer.v1'` and a boolean `compactIssuanceEnabled`.
An absent `leaseFormats` object means legacy full-only support with compact
issuance disabled. A present object with missing or invalid members is rejected
as `INVALID_CAPABILITY`.
Support describes this reader, not current authorization or fleet readiness.

For operators, first qualify **all** owner, projection, status, SDK and evidence
readers with `OSUITE_MATOI_COMPACT_LEASE_ISSUANCE` absent or `0`. Only then enable
new compact issuance with exact `1`; any other value makes the owner unavailable.
The flag is not agent-controlled. Closing it prevents new compact preparations
but does not revoke existing leases, erase history or cancel transactions already
preparing. Verify/drain every writer rather than assuming the switch is atomic
across a fleet. Roll back to a qualified dual-reader build, never a full-only
reader while compact preparations or history remain. Use normal authority
revocation when existing admission must stop.

The format is immutable for an operation ID. Same-format calls return the original
preparation; a different format is `LEASE_FORMAT_CONFLICT`, not a replacement.
Before sending, a new compact request can fail with `LEASE_FORMAT_UNSUPPORTED`
or `COMPACT_LEASE_ISSUANCE_DISABLED`. After a POST, **any** non-2xx response or
invalid response binding retains `OUTCOME_UNKNOWN`, even if the HTTP response is
400 or 409. Recover with `status(operationId)`, not another POST or a new ID.
A cold client seeking an existing compact record while issuance is off also uses
status. An old SDK encountering that record must be upgraded; do not strip fields
or present it as a full lease. Original v1 history remains readable.

### Execute And Recover

Only after the actual Studio review, deliberately invoke:

```js
const result = await transfers.execute(prepared, 0);
console.log(result.state, result.code, result.newlyCommitted);
```

`execute(prepared, ordinal = 0)` sends a signed POST with the selected ordinal
and either the full signed `lease` or, when fresh capabilities advertise
`executionTransport: 'bound-reference-v1'`, the verified `preparationDigest`.
The server resolves that reference against the authenticated workspace, actor,
key and original operation, then verifies the stored signed lease. In either
transport, the SDK verifies the original preparation and any commitment receipt;
the server checks current authority and native Studio approval. The SDK never
runs a local side effect or executes remaining ordinals for you. An HTTP 200
`denied` decision, including `AWAITING_APPROVAL`, is returned unchanged with the
same review link; it is never treated as a commitment or automatically retried.
A deliberate later call after human review performs fresh capability checks.

A `committed` response is accepted only with a verified receipt matching the
current operation, action/fingerprint, preparation, epochs, evidence and exact
effect. `newlyCommitted: true` describes that acknowledged request only.
`already_committed` may return an earlier operation's receipt, including its
original ordinal, but its tenant, actor, grant and exact signed effect must
still match the current authorization. It always has `newlyCommitted: false`.
Re-reading an already verified result in this client never resends execution.

### Derived Evidence Freshness

`execute()` results and every returned `status()` result include a separate,
immutable `projection` observation. MCP tool results expose the same normalized
public shape. Its profile is `matoi.controlled-transfer.projection.v1`, its scope
is always `derived-view`, and `authorizesExecution` is always `false`.

The view state is `current`, `pending_reconciliation`, `stale`, `failed`, or
`unavailable`. This is independent of the resource's `state`, signed receipt and
`newlyCommitted` flag. A pending, failed or unavailable view never invalidates a
verified `committed` or `already_committed` receipt and never permits a resend.
Even `current` is only a server-reported derived-view observation, not a new
authorization decision, independent proof validation or external settlement.

The remaining fields are always present, with missing optional values as null:

- `incarnation` and `artifactIncarnation`: lowercase UUID strings.
- `requestedGeneration`, `projectedGeneration`, and `artifactGeneration`:
  canonical nonnegative decimal strings, at most PostgreSQL's signed bigint
  maximum `9223372036854775807`. They never pass through JavaScript Number.
- `generatedAt` and `observedAt`: canonical 24-character UTC ISO timestamps.
- `lastError`: a machine code of at most 64 uppercase letters, digits or
  underscores, starting with a letter, not arbitrary diagnostic text.

Absent legacy metadata, an unknown profile/scope/state, or malformed fields
produce `state: 'unavailable'` with null identities, generations, timestamps and
error. No observation time is invented. Arbitrary graph/debug extensions are
omitted. A known non-unavailable state requires an `observedAt` timestamp.
Additionally, `current` requires nonnull equal incarnation and artifact
incarnation, three equal positive generation strings, and nonnull canonical
timestamps with `generatedAt <= observedAt`. Inconsistent current claims become
unavailable before any cached downgrade to stale. These checks establish only
internal wire consistency, not cryptographic proof of server freshness.
Only this additive metadata is normalized; receipt signatures and the existing
unknown-outcome fences remain unchanged. The HTTP response limit and resource
snapshot limits remain unchanged, with the separately bounded projection
attached after resource snapshot validation.

A cached execute replay conservatively changes a previous `current` view to
`stale`, preserving its original `observedAt`, `generatedAt` and generations.
Other view states remain as previously observed. This does not trigger a GET or
POST. Explicit status reads, including GET-only recovery of an evicted receipt,
can return a new server observation; subsequent cached replays are stale again.

## Unknown Outcomes And Recovery

A timeout, lost connection, unsuccessful HTTP response or malformed post-send
reply raises `ControlledTransferError` with `code: 'OUTCOME_UNKNOWN'`, the
original `operationId`, `retryAutomatically: false`, and `recovery.method:
'status'`. A missing, invalid or substituted receipt is also unknown, **not**
proof that nothing executed. Even HTTP 400/401/503 after a POST is conservatively
unknown: a proxy or a lost response cannot prove the resource did not commit.

```js
try {
  await transfers.execute(prepared, 0);
} catch (error) {
  if (error.code !== 'OUTCOME_UNKNOWN') throw error;
  const observed = await transfers.status(error.operationId);
  console.log(observed.state, observed.code);
  // Stop here. Do not resend, generate another operation ID, or auto-approve.
}
```

`status(operationId)` uses only authenticated GET requests with `operationId`
and `agent_id`. It never prepares, consumes approval or executes. It returns
`committed`, `partially_committed`, `denied`, `awaiting_approval`, `ready`, or `unknown`.
`ready` reports the owner's current native approval, not a local authorization
or an instruction to execute. Pending and denied native votes remain distinct.
All status results have `newlyCommitted: false`. Committed effects must carry
verified receipts; noncommitted observations are not permission to retry.
Outages, 404s, wrong scope, invalid receipts and malformed replies return
`state: 'unknown', code: 'OUTCOME_UNKNOWN'`, never a fabricated negative result.

An unknown outcome fences further mutations for that operation in this client,
even after a status read succeeds. The fence is **in memory**, not a durable
exactly-once claim. Applications must durably retain operation IDs, preparations
and uncertainty markers. After restart, recover through status, not by creating
a new client or ID to bypass uncertainty. A saved preparation may be supplied
to an intentional first execution; it is fully reverified before sending.

Each long-lived client keeps at most 16 hot operation payloads (preparations and
receipts), with active preparation, execution and recovery calls pinned against
eviction. Compact grant, preparation-binding, effect-count and receipt-digest
records, including every uncertainty fence, remain for up to 65,536 operation
IDs. A new ID at that limit, or a call needing a hot slot when all 16 are active,
fails with `CLIENT_CAPACITY_EXCEEDED` before sending a request; existing fences
are never evicted to admit new work. Preparing an evicted recorded ID recovers
its original preparation through authenticated GET, never another prepare POST.
Replaying an evicted locally acknowledged completion likewise verifies the
original preparation and receipt digests through GET and returns
`already_committed`, `newlyCommitted: false`, without an execution POST. Missing
or inconsistent history becomes `OUTCOME_UNKNOWN`; successful later status
reads do not clear that fence. Settled preparation promises and cold payloads
are released without resetting the client. These limits cover SDK-owned state,
not payloads retained by callers, and do not provide persistence across restart.

An optional `prepared` field in status is verified against the issuer, tenant,
actor/key, operation, grant, effect list and any retained preparation. Current
receipts must bind to that preparation. The verified immutable field exposes
the original lease and review link after restart or a lost preparation response,
without repeating approval creation. It does not clear an uncertainty fence.
Reading an expired original lease is permitted; sending it for execution is not.

With a retained or status-recovered preparation, status can also bind historical
payment receipts to its signed effect list. A cold client can verify receipts
for the requested current operation. A historical receipt without the current
preparation cannot prove the intended current effect and remains unknown. If no
issuer is pinned or previously learned, receipt/preparation-bearing status also
reads capabilities to obtain an authenticated key. A known/pinned key permits
status verification even when fresh action capabilities are unavailable.

## Verification Contract

Lease and receipt signatures use Ed25519 over recursively sorted canonical JSON,
with canonical 86-character base64url signatures. `issuer` is SHA-256 of SPKI DER.
An explicit `issuerPublicKey` pin takes precedence; otherwise the authenticated
capability key is pinned for the lifetime of the client. A later key substitution
is rejected, not silently trusted.

Financial effects have exactly `operation`, `paymentId`, `sourceAccount`,
`destination`, `asset`, `network`, `amountMinor`, and `decimals`. Amounts are
positive canonical decimal integer strings of at most 38 digits; they never
pass through Number. Decimals are integers from 0 to 18. At most 64 effects are
accepted and payment IDs must be unique within the signed preparation.

The finance profile defines the effect digest as
`SHA256(canonicalJson(["matoi.controlled-transfer.v1", "effect", effect]))`.
The SDK uses this solely to verify the expected effect against the signed lease
at its ordinal and against a signed resource receipt. It does not produce
financial workflow evidence or substitute for the resource's independent check.
`preparationDigest` is SHA-256 of the canonical lease payload. The client allows
30 seconds of forward clock skew for issuance/commitment timestamps; current
commitments must fall within their signed lease lifetime. Expired leases cannot
be used for a new send, but historical status remains verifiable.

Native approval fingerprints use `apfp_<64 lowercase hex>`; unprefixed fixture
fingerprints are also accepted. Exact values are compared, never normalized.
Optional per-effect `lease.payload.passes` remain signed CAVA/ZeroGate evidence,
not local execution permission. Financial actions stay high-risk and require
the slow-approved native review route; there is no fast-path latency promise.

For receipts bound to a compact source preparation, the signed `gate` is
mandatory; legacy full-source receipts without it remain accepted. When present,
it must use `lane: 'slow-approved'` and a canonical decimal-string
`admissionSequence`. Its actual ZeroGate receipt must retain the
`slow`/`review`/`risk_exceeds_fast_lane` result, correct hash, source ordinal and
timestamp. It binds to that original source preparation's pass commitment (or
full pass when available), not to a later operation's position for the payment.
The enclosing signed owner receipt, not that review receipt alone, acknowledges
commitment. If an earlier source preparation is unavailable, historical signature
and effect checks alone do not establish its pass commitment. Auxiliary
`projection` metadata is normalized separately by the client and is not financial
commitment evidence.

When its original source preparation is known, a receipt must also use that
source lease's issuer. Trusting both an old and a current public key does not
allow the current key to re-sign the old lease's receipt as if it were the
original. Valid old-key receipts remain verifiable after rotation; unknown
source history retains the narrower signature/effect-only guarantee above.

## Doctor Integration

The doctor module exports these functions, with no import-time I/O:

```js
import { probeMatoiStatus, formatMatoiStatus } from './matoiDoctor.mjs';

const status = await probeMatoiStatus({ config });
const output = formatMatoiStatus(status);
```

The prober performs at most one capability GET and never mutates. It separates
`installed`, `localConfigured`, `configured`, `serverConfigured`,
`capabilityAvailable`, `resourceEnforced`, and the server's `qualification`.
Unavailable qualification is null and displays as unknown; valid qualifications
are explicitly labeled server-reported. Configuration failures are returned as
diagnostic codes without exposing credentials.

```sh
osuite doctor --controlled-transfers
osuite doctor --require-controlled-transfers
osuite doctor --controlled-transfers --runtime mcp
```

Both strict flags run only this diagnostic, not the ordinary health/Hook probes
or opt-in onboarding measurements. Exit zero requires strict local configuration
and authenticated, configured resource enforcement. It does not certify deployment
qualification; `not-qualified` remains visible. Ordinary `osuite doctor` adds a
non-gating Matoi diagnostic: lack of this optional profile does not fail an
otherwise healthy old SDK installation or change ordinary Hook behavior.

Strict commands select exactly one protected credential bundle: `.osuite/.env`
for SDK doctor, or `.osuite/mcp/.env` for MCP and `doctor --runtime mcp`. They never
load `.codex/.env`, `.claude/.env`, `.cursor/.env` or the project's root `.env`.
The bundle must provide `OSUITE_BASE_URL`, `OSUITE_API_KEY`,
`OSUITE_PRIVATE_KEY_BASE64`, `OSUITE_ORG_ID`, `OSUITE_AGENT_ID`,
`OSUITE_SIGNATURE_MODE=required`, `OSUITE_GUARD_FAILURE_MODE=block`, and the matching
`OSUITE_RUNTIME_ADAPTER_ID` (`sdk`, `framework_sdk`, `inline_sdk`, or `mcp` for MCP).
An optional `OSUITE_AGENT_KEY_ID` asserts the credential key identity.

A complete explicit shell configuration is usable when the selected bundle is
absent. With a bundle present, explicit shell configuration must agree with it;
partial bundles cannot borrow missing keys or identities from another source.
Conflicting `OSUITE_*`/`DASHCLAW_*` aliases and duplicate assignments are rejected.
Optional `OSUITE_MATOI_TIMEOUT_MS` sets the bounded request timeout;
`OSUITE_MATOI_ISSUER_PUBLIC_KEY_BASE64` pins base64-encoded Ed25519 SPKI PEM.

Unsafe, tracked, non-ignored, symlinked or non-owner-only credential files are
refused using the existing credential inspector. A selected connect journal or
lock, or any pending SDK/MCP migration marker, blocks strict commands. They do
not repair files, resume enrollment, merge identities, or print secrets.

## Controlled MCP

```js
import { createControlledTransferMcpServer } from 'osuite/controlled-transfers';

const server = createControlledTransferMcpServer(config);
const { tools } = server.listTools();
// The CLI uses server.handleRequest(jsonRpcRequest).
// Embedded callers may explicitly use server.callTool(name, argumentsObject).
```

Only `osuite_transfer_prepare(operationId, grantId)`,
`osuite_transfer_execute(prepared, ordinal = 0)`, and
`osuite_transfer_status(operationId)` are exposed. They delegate to the real
client; there is no local payment function, automatic approval, or generic MCP
execution gateway. Tool arguments reject extra keys. Results preserve pending,
refusal and unknown states. `effect_executed` is true only for a newly verified
commitment, false for `already_committed`, pending, refusals and read-only known
observations, and null for unknown outcomes. Status never claims a new effect.
Results include only the bounded public freshness fields under `projection`,
not configuration, arbitrary server debug data or full projection graphs.

```sh
osuite mcp --controlled-transfers
```

This explicit lane uses `sdk/controlled-transfers-stdio.mjs`, not the ordinary
runtime MCP bridge. It accepts UTF-8 NDJSON, limits an input frame to 1 MiB and
buffered input to 2 MiB, and awaits each request and output before the next. The
frame limit uses `CONTROLLED_TRANSFER_MAX_ENVELOPE_BYTES`. Stdout contains
JSON-RPC only. Invalid JSON/UTF-8 or oversized framing emits a bounded protocol
error and stops rather than dispatching queued mutations. Initialization and
tool listing do not contact the server or change files. No arbitrary-MCP safety
or full-stack deployment protection is implied.

## Local Contract Tests

Run with Node 24:

```sh
node --test sdk/controlled-transfers/test/*.test.mjs
node node_modules/vitest/vitest.mjs run __tests__/unit/matoi-cli.test.js
```

Tests use ephemeral loopback HTTP servers, real local RSA/Ed25519 signatures and
offline package inspection. Fixture receipts test client verification only;
they are not evidence of real financial writes, native Studio review, or
deployment qualification. Owner/PostgreSQL/live route acceptance is a separate
integration gate.

## Transport And Rotation In The 2.12.0 Candidate

The `2.12.0` source candidate is not proof of registry publication or a qualified
server deployment. When fresh capabilities advertise
`executionTransport: 'bound-reference-v1'`, the execute POST sends the verified
`preparationDigest` instead of repeating the complete signed `lease`. The client
still verifies the original preparation, selected ordinal and returned receipt;
the reference is not a new approval or an unsigned local execution shortcut.
Without that advertisement, the existing full-lease request format is retained.
No timeout, transport fallback or oversized response authorizes a resend.

For rotation, explicitly pin the current Ed25519 issuer and retain only reviewed
previous public roots in `trustedIssuerPublicKeys`. Status may verify the
original historical preparation and receipt with those roots, without replacing
their signatures or making a POST. A retired issuer cannot authorize a fresh
preparation or execution, even when trusted for historical reads. Fence old
writers and preserve authoritative payment history before activating a rotated
or restored owner; missing history remains quarantine, not fresh spend capacity.

In the standalone public source export, run `npm run test:controlled-transfers`
on Node 24 for the transport, client contract, rotation, doctor, package and
strict CLI checks. The existing Node 24 `test:governed-tools` CI gate also runs
this command. The exported `source-manifest.json` records the five exact-name
private-owner test exclusions and their reason. The full repository commands
above retain those tests; no private owner implementation is exported. Ordinary
SDK compatibility remains a separate unchanged `npm run test:compat` gate.
