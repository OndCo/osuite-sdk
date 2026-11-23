# Evidence-bound native recovery

Version 2.14.0 adds the opt-in
`tools.recover(operationId, unchangedParams, options)` API to
`createGovernedTools` on Node 24/POSIX. Confirm registry availability with
`npm view osuite@2.14.0 version` before installing that version. The published
2.13.0 package does not include this API.

Ordinary `run()` and `status()` never invoke a recovery adapter or retry an
uncertain native call. Recovery is an explicit host application decision, not an
agent-supplied permission flag. All errors retain `retryAutomatically: false`.

When a known uncertain call has no adapter, `recover()` returns
`RECOVERY_UNSUPPORTED` with the matching parent's local state, action ID,
replay URL and no-resend guidance. It does not contact Studio, inspect the
resource, or create a child. A different input or binding conflicts without
returning the original record. An unused ID creates no record. An authoritative
empty status is only a point-in-time observation, not a guarantee that another
writer cannot commit after the read.

## Trust boundary

The developer installs a trusted, versioned adapter on a tool binding **before
the original run**. It owns resource observation and conditional execution. Its
revision, resource ID and contract are part of the original binding digest.
Changing them, the description, mapping revision or input conflicts with the
stored operation. Existing operations created without an adapter cannot acquire
one retroactively. Functions are snapshotted, but developer code and its closures
remain trusted; this is not code attestation or protection from a malicious host.

Two resource contracts are supported:

- `settled-absence`: authoritative evidence proves the original attempt has
  settled without an effect, no deferred effect can arrive, and an enforced
  exclusive writer/exclusion mechanism prevents another writer for this business
  operation through recovery. A plain timeout, a connection failure, an eventually
  consistent negative read, or an actor's assertion is not this evidence.
- `same-id-idempotent`: the native resource guarantees same-business-ID,
  same-payload replay for original and recovery calls, with stable receipts and
  no duplicate effects. The adapter validates this actual resource contract.
  Replay may create a first effect if none exists, so it needs fresh authority
  even when the goal is only to recover a receipt.

Append-only ambiguity is not recoverable. An append-only resource can opt in to
`settled-absence` only with the stated authoritative absence and enforced
exclusion guarantees. The SDK cannot derive these guarantees from JSON fields,
authenticate arbitrary resources, prevent direct unwrapped calls, or make an
arbitrary distributed resource exactly-once. The adapter must enforce the native
contract and revalidate its resource conditions before any possible effect.

## API and adapter

```js
import { createGovernedTools } from 'osuite/governed-tools';

const tools = createGovernedTools({
  config, namespace: 'native-commits', journalPath,
  // initializeJournal: true only for deliberate first-time provisioning.
  bindings: {
    'benchmark.invoke': {
      revision: 'mapping-1',
      describe,
      recovery: {
        revision: 'native-recovery-1',
        resourceId: 'ledger-A',
        contract: 'settled-absence', // or 'same-id-idempotent'
        async observe({ params, binding }) {
          if (params.arguments.tool_name !== 'commit') return null;
          // Application-owned authenticated public reads, not model/scorer data.
          const observation = await readPublicNativeEvidence(params);
          validateOriginalIdsPayloadContractAndExclusion(observation, params);
          if (!observation.definitivelySettled) return null;
          const now = Date.now();
          return {
            ...binding,
            schemaVersion: 'osuite.native_recovery_evidence.v1',
            observedAt: now,
            expiresAt: now + 5000,
            settled: true,
            outcome: observation.outcome,
            proof: boundedPublicProof(observation),
          };
        },
        async execute(unchangedParams, { binding, evidence }) {
          // These are application adapter functions, not additional SDK APIs.
          // Enforce evidence/exclusion or resource idempotence through the write.
          await revalidateNativeConditions(unchangedParams, evidence);
          return commitOriginalRequestAndProposal(unchangedParams);
        },
      },
    },
  },
});

// Call only after a settled uncertain run, with the exact original input.
const receipt = await tools.recover(originalOperationId, unchangedParams, {
  waitMs: 0,
  // signal: abortController.signal,
});
```

`recover` accepts only `waitMs` (integer 0..600000, default 0) and an optional
native `AbortSignal`. It accepts no callback, evidence, retry flag, business ID
override or admission ID. A multiplexed binding must restrict recovery to the
specific native commit; installing it is not permission to recover generic
`api_fetch` calls. Return `null` or throw from `observe` for unsupported calls.

The frozen observer input is `{ params, binding }`. `params` is the original
native `{ name, arguments }` snapshot. `binding` contains exactly:

```js
{
  operationId,       // Original SDK business operation ID.
  scope,            // Original tenant/origin/runtime/namespace digest.
  inputDigest,      // Original tool name and exact arguments digest.
  bindingDigest,    // Original mapping and recovery descriptor digest.
  actionId,         // Original Studio action, NOT the recovery child.
  resourceId,
  adapterRevision,
  contract,
}
```

Adapter revision and resource ID are safe IDs of at most 128 characters (letters,
digits, underscores, dots, hyphens; no `..`). All five adapter properties in the
example are required; accessors, proxies and extra adapter fields are rejected.

Evidence copies every `binding` field unchanged and adds only `schemaVersion`,
`observedAt`, `expiresAt`, `settled`, `outcome`, and `proof`. It is immutable plain
JSON, at most **8192 bytes in total**, with a nonempty plain-object `proof`.
Timestamps are integer Unix milliseconds. Evidence cannot be future-dated, older
than five seconds, expired, or valid for more than five seconds after observation.
`settled` must be `true`. `settled-absence` permits only `outcome: 'absent'`;
`same-id-idempotent` also permits `'applied'` and `'unknown'`.

Store full public observations in the application's audit channel if needed;
put bounded resource metadata/digests in `proof`. The SDK verifies the envelope
and commitments, not the meaning or provenance of arbitrary proof fields. The
trusted adapter must verify authenticated resource facts, contract, current
native grants/status, exact original request/proposal identity and payload. No
hidden case label, expected score or caller assertion is recovery evidence.

The SDK invokes `observe` before admission and again after fresh authorization.
It then rereads parent and child Studio state and checks evidence/authorization
freshness immediately before and after the synchronous durable dispatch fence.
Validated scoped-rule and redeemed-grant expiry also bound that dispatch window.
`execute` receives the frozen original params and `{ binding, evidence }` using
the second observation. It must preserve native business IDs, enforce the native
contract, return the actual resource receipt and throw on an unconfirmed result.
Recovery does not claim completion from opaque/non-JSON or oversized returns;
results must fit the existing 64 KiB JSON result-digest bound and not be MCP
`isError` results. Full business results are never retained in the SDK journal.

Adapters must use bounded, read-only observation I/O and bounded native transport.
An abort is checked at SDK boundaries, not a guarantee to cancel an in-flight
adapter request or undo an effect. There is no SDK resource-poll or effect-retry
loop. Native revalidation and the effect are not atomic with Studio authorization;
enforcement across that gap belongs to the trusted resource/adapter contract.

## Journal and current authority

Only a local parent in `uncertain` is eligible. An in-flight/crashed `dispatching`
parent, uncertain create/redemption, held, completed, denied, cancelled or expired
operation cannot enter recovery. The parent must currently match its original
Studio action and be `running` (e.g. lost report) or `failed`. Current denial,
cancellation, expiry, missing evidence or identity mismatch blocks recovery.

The supported Studio projection is `osuite.action_envelope.v1`. Both the persisted
action's `input_summary.osuite_native_call` and the envelope's copy must match the
journal's operation, input and binding digests and native-call schema. The envelope
must also match the action, organization, agent, session and tool-use identities.
Neither `action.tool_input_digest` nor `action_envelope.tool_input_digest` is a
persisted field in this schema; absence is normal. If either duplicate is present,
it must match, but it never substitutes for a missing or mismatched persisted
marker. Unsupported envelope profiles fail closed. Recovery linkage is checked
in both summaries as well, on admission and on fresh current reads.

One deterministic private-scope child record uses the **same operation ID** but a
distinct SDK-generated Studio action/session identity. It uses the same input
digest and native parameters. The signed child input summary contains
`osuite_native_recovery` with `schema_version`, `parent_action_id`, `parent_scope`,
`operation_digest`, `input_digest`, `binding_digest`, `adapter_revision`,
`resource_id` and `contract`. This link is verified in admission and current reads;
it is not caller-controlled. Both allow and reviewed recovery use fresh posture,
guard and action admission. A consumed parent approval is never reused.

The original record and its evidence remain unchanged, including its `uncertain`
state. The child uses existing journal version 1 states, transaction ownership and
CAS transitions. There is no schema migration, parent reset, owner takeover or
lock-expiry retry. Older executors cannot dispatch the uncertain parent, and a
binding without the installed adapter conflicts with its digest. Keep one shared
durable journal for all workers; copied/deleted journals do not preserve this
serialization guarantee. Each eligible recovery consumes one additional record
from the existing journal capacity, with no eviction.

Before dispatch the existing bounded `error_code` metadata slot records
`recovery_<sha256(canonicalJson({ initial, revalidated }))>`, committing both frozen
observations. This is an evidence commitment, not an error or an execution grant.
The child outcome report includes the parent linkage and this evidence digest.
Journal records retain only identifiers, metadata and digests, not proof bodies,
native arguments or receipts. Keep the exact envelopes in your own audit if you
need to independently recompute the evidence commitment.

## Results and no-retry boundaries

`recover` returns the actual adapter result only after durable completion. Read
`(await tools.status(originalOperationId)).recoveryAttempt` for the child state,
result digest, evidence digest, report state and review/replay URLs. The top-level
state/action/URLs still describe the original parent. Recovery errors also attach
`status.recoveryAttempt`. When a child exists, the error's top-level
`status.actionId`, `status.state`, `status.reviewUrl` and `status.replayUrl`
describe that child, so `AWAITING_APPROVAL` points directly to the actionable
review. The original parent's immutable status remains in `error.status.parent`;
the business `operationId` is unchanged. Child status is local evidence, not permission to execute. Status
reads never observe the resource, redeem approval or execute either callback.

A child durably in `held` can resume its same review using another explicit
`recover` with unchanged params, including after reopening the journal. It still
reobserves resource evidence and gets fresh current authority. An unclaimed
`prepared` child or a failed initial evidence read has not consumed a grant;
manual reinspection is possible, but the SDK never schedules another attempt.

After a child is claimed, uncertain admission/redemption, failed revalidation,
callback failure, or a crash permanently fences this single recovery attempt.
Even later authoritative absence cannot create a third action. A completed child
returns `ALREADY_COMPLETED` on subsequent recovery; read its result from the
application store rather than resending. Lost outcome-report acknowledgement
does not hide a durably successful resource result. `run` continues to return
`OUTCOME_UNKNOWN` for the original parent, including after successful recovery.
Never change business IDs or reinitialize storage to bypass these boundaries.

## Verification

Run with Node 24, without installations or external model calls:

```sh
/Users/jw/.nvm/versions/node/v24.22.0/bin/node --test sdk/governed-tools/test/*.test.mjs
```

The recovery tests use actual localhost HTTP resources and a signed Studio wire
fixture. C1 proves a settled before-effect failure can complete once; C3 proves
lost receipt replay has one physical effect. Coverage includes bad/stale evidence,
append-only ambiguity, identity/mapping changes, fresh denial/cancellation,
approval consumption/expiry, concurrency in separate processes, crash/reopen,
invalid results, journal preservation and default no-retry behavior. This is not
a substitute for qualification against the actual Studio routes and production
resource contract. The experiment owner performs that qualification and the
separate finite benchmark rerun before making product claims.
