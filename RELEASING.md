# Owner-Authorized SDK Publication

A source candidate has not been published to npm merely because a commit, tag
or GitHub release exists. This procedure does not activate delegation or
authorize any version. Never move, delete or reuse an old release tag.

## Qualify One Release

1. Record the owner's authorization for one explicitly named stable SDK version,
   its exact `vX.Y.Z` tag matching `sdk/package.json`, and the full reviewed
   **public SDK commit**. Require an approved live dedicated-workspace canary for
   that candidate: deployed Studio must accept V2 enrollment and finish
   acknowledged recovery.
2. On Node 24/POSIX run `npm ci`, `npm run verify:source`, `npm test`,
   `npm run test:compat`, `npm run test:governed-tools` and `npm run pack:sdk`.
   Review the actual tarball in `output/` for private Studio source, credentials,
   customer files or unrelated research. Record its SHA-256 with the authorization
   and canary evidence. A changed commit or digest requires a new review.
3. In **OndCo/osuite-sdk**, use an active tag ruleset under **Settings > Rules >
   Rulesets** targeting the release version tags. Restrict creation to authorized
   releasers and restrict updates and deletions. Confirm the named tag resolves
   to the reviewed commit. Branch rules alone do not protect a tag.

## Choose the Release Lane

**Delegated.** The owner may enroll a delegate once in the public repository:
under **Settings > Secrets and variables > Actions > Variables**, set the
repository variable `OSUITE_NPM_RELEASE_ACTOR_ID` to the account's immutable
numeric GitHub actor ID, not its login. This is an identity check, not a secret
or standing approval for every version. Only that actor, matched against
`github.actor_id`, may use the recorded grant for the named release. The owner
can revoke the grant before publication or remove the variable to end enrollment;
cancel any queued or in-progress release run when revoking. If `npm-production` has no
required reviewers configured, this lane needs no additional per-release approval
click. Never disable or bypass an existing environment protection.

**Owner/manual fallback.** Configure required reviewers and enable **Prevent
self-review** on `npm-production` for this lane. The owner dispatches; a
different human must then approve that run's environment deployment before
publication. The deployment review is the approval record. If it cannot be
obtained, stop. An ordinary GitHub login or a support chat alone is not approval.

## Dispatch and Verify

Use only the public repository's `.github/workflows/publish.yml` via
`workflow_dispatch` on the named stable tag. Branch and tag pushes never publish.
The tagged workflow must accept the required **string** inputs `expected_commit`
(full commit SHA) and `expected_sha256` (reviewed tarball SHA-256), verify both
against the checked-out commit and the exact tarball it will publish, and enforce
the chosen lane. Do not dispatch an older workflow that lacks these checks.

Keep npm ownership, public repository metadata and account 2FA verified. Use
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for
`OndCo/osuite-sdk`, `publish.yml`, environment `npm-production`: GitHub-hosted
runner, Node 24, npm 11.5.1+ and OIDC for direct publication with
`--provenance --access public`. Do not add an npm token or publish locally.

After publication, check `npm view "osuite@$VERSION" dist.attestations repository --json`
for the named version, verify provenance and compare the **registry tarball's**
SHA-256 to the reviewed digest. Verify a clean temporary, version-pinned `npx`
installation. Only then announce availability.

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
