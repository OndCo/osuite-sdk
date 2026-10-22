# Owner Release Procedure

Treat a source candidate as "not been published" until the registry and its
provenance have been verified. Only the package owner initiates registry publication. Publishing the public
repository or a GitHub source release is not npm publication and does not create
an npm provenance attestation by itself.

## Before Publication

1. Confirm the final live dedicated-workspace canary and source commit. Confirm
   deployed Studio accepts V2 enrollment and can finish acknowledged recovery.
2. On Node 24/POSIX, run `npm ci`, `npm run verify:source`, `npm test`,
   `npm run test:compat` and `npm run test:governed-tools`.
   Run `npm run pack:sdk` and review the actual tarball in `output/`. It must contain no
   private Studio source, credentials, customer files or unrelated research.
3. Confirm npm ownership, package version, public repository metadata and active
   account 2FA. Configure npm trusted publishing for **OndCo/osuite-sdk**, workflow
   **publish.yml**, GitHub environment **npm-production**. Require a human reviewer
   on that environment. No long-lived npm token is stored in this repository.
   Use GitHub-hosted runners, Node 22.14+ and npm 11.5.1+; this workflow pins
   Node 24. Grant the trusted publisher permission for direct publication.
4. The owner creates a version tag matching `sdk/package.json` and dispatches
   `publish.yml` on that tag. It runs the same checks, then
   `npm publish --provenance --access public` from `sdk/` using trusted publishing.
   The workflow must not be dispatched by an implementation agent. If trusted
   publishing is not configured, fix that configuration; do not silently fall
   back to an unverified provenance claim or paste a token into a workflow.
5. Verify `npm view osuite@2.11.0 dist.attestations --json`, the published tarball
   digest, `repository` metadata and a clean temporary `npx` installation. Only
   then update the release notice to say the npm version is available.

Local `npm publish --provenance` is not a substitute for a supported CI identity.
The public workflow intentionally has no automatic publication on push.
See npm's [trusted publishing requirements](https://docs.npmjs.com/trusted-publishers/).

## Homebrew

The version-pinned formula uses the GitHub release's reviewed npm-format tarball,
not a mutable branch archive or a `latest` URL. It installs the files directly;
it does not run install scripts, enroll a workspace or enable a Hook.

Once that release asset and formula have been verified:

```sh
brew tap ondco/osuite-sdk https://github.com/OndCo/osuite-sdk.git
brew install ondco/osuite-sdk/osuite
osuite --help
```

This is an independently maintained tap, not a Homebrew core listing. A fetch or
formula syntax check is not proof of a complete installation on every OS.

## Rollback

After a V2 credential has been issued, do not revert Studio to a legacy-only
handler. Pause new enrollment on the compatible version while keeping saved
receipt and acknowledgement recovery working. Roll back a client only to a
qualified release and never automatically restore an expired or revoked key.
