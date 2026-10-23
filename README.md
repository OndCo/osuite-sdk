# OSuite SDK And Hooks

Dependency-free runtime clients for governing consequential agent actions.
This repository contains the public MIT-licensed SDK, Node Hook sources, Codex
plugin assets and standalone tests. It does not contain OSuite Studio's commercial
application, customer records, credentials or unrelated research source.

## Start

Version 2.11.2 is [published on npm](https://www.npmjs.com/package/osuite/v/2.11.2)
through the trusted publisher. Its [versioned release](https://github.com/OndCo/osuite-sdk/releases/tag/v2.11.2)
includes the same verified archive. `npm view osuite version` reports the current
registry version; publishing source alone is not proof of npm availability.
To test this source without replacing a globally installed CLI:

```sh
node /absolute/path/to/osuite-sdk/sdk/cli.js connect
node /absolute/path/to/osuite-sdk/sdk/cli.js doctor
node /absolute/path/to/osuite-sdk/sdk/cli.js try
```

Run those commands from a project you intend to connect. Connection requires
Studio approval. The harmless `try` walkthrough needs a signed-in human review;
it does not execute an arbitrary shell command. Existing disabled/custom hooks
are preserved. Do not interpret a direct diagnostic as proof of full host coverage.

To connect with the published CLI, use `npx osuite@2.11.2 connect`. A version-pinned
Homebrew formula is documented in [release instructions](RELEASING.md). A formula
in this repository is an Ond-maintained tap, not Homebrew core endorsement.

## Inspect And Test

```sh
npm ci
npm run verify:source
npm test
npm run test:compat
# Node 24/POSIX only:
npm run test:governed-tools
```

Contributor tests use Node 20.19+ because of Vitest. The shipped SDK has no npm
runtime dependencies and targets Node 18+. A separate built-in test runner checks
Node 18 compatibility, independent of Vitest. The opt-in `osuite/governed-tools`
entry requires Node 24/POSIX; it preserves supported native calls and recovers
held operations without automatically repeating possibly sent effects. See the
[native-tool integration guide](sdk/GOVERNED_TOOLS.md). CI records the actual
tested Node and operating-system combinations; it does not certify untested
vendor hosts.

Version 2.11.1 defaults handled Hook guard failures to blocking, separates
service outages from rejected or malformed requests, retains rejection across
posture-cache reuse, and adds same-ID recovery guidance. Explicit optional
non-strict outage allowances are ungoverned, not approvals. See the
[failure-handling boundary](sdk/README.md#failure-handling-in-2111); this does not
change what a vendor host does when its Hook process crashes or times out.

Version 2.11.2 corrects concurrent atomic state replacement,
bounded journal contention and admission aging during local durable I/O. It
does not replay action POSTs, native effects or uncertain operations. The
immutable 2.11.1 package does not include these follow-up changes. Upgrade
explicitly and retain existing business operation IDs and durable journals;
an uncertain operation must not be recreated or automatically resent.

`source-manifest.json` lists the reviewed files and SHA-256 of their exact bytes.
It is an inventory, not a cryptographic publisher signature or authorization.
The Codex bundle can be reproduced with `npm run build:plugin`; tests compare
the generated result with the checked-in bundle.

See [SDK documentation](sdk/README.md), [security reporting](SECURITY.md),
[contribution guidance](CONTRIBUTING.md) and [release controls](RELEASING.md).

## Boundary

OSuite separates proposed action identity, current authorization, admission and
execution evidence. A model's success message, a cached approval, a tool name or
a completed installation is not proof that an effect was authorized. Cooperative
Hooks cannot close direct resource/credential bypasses on their own. Unknown
post-dispatch outcomes must be reconciled, not silently retried.

Project: <https://ond.cc/osuite>. Studio: <https://studio.osuite.ai>.
