# OSuite SDK And Hooks

Dependency-free runtime clients for governing consequential agent actions.
This repository contains the public MIT-licensed SDK, Node Hook sources, Codex
plugin assets and standalone tests. It does not contain OSuite Studio's commercial
application, customer records, credentials or unrelated research source.

## Start

The candidate source version is 2.10.2. npm publication is a separate owner release;
`npm view osuite version` shows what is actually available from the registry.
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

After npm 2.10.2 is published, use `npx osuite@2.10.2 connect`. A version-pinned
Homebrew formula is documented in [release instructions](RELEASING.md). A formula
in this repository is an Ond-maintained tap, not Homebrew core endorsement.

## Inspect And Test

```sh
npm ci
npm run verify:source
npm test
npm run test:compat
```

Contributor tests use Node 20.19+ because of Vitest. The shipped SDK has no npm
runtime dependencies and targets Node 18+. A separate built-in test runner checks
Node 18 compatibility, independent of Vitest. CI records the actual tested Node
and operating-system combinations; it does not certify untested vendor hosts.

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
