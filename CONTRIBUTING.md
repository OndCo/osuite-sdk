# Contributing

Open an issue describing a concrete failure or compatibility gap with synthetic
inputs. Keep protocol changes small, testable and explicit about unsupported
behavior. Never include real command payloads, keys, customer records or private
repository exports. Contributions are under this repository's MIT license.

For a patch, run `npm ci`, `npm test` and `npm run test:compat`. Changes to shared
runtime files also require `npm run build:plugin` and the bundle parity test.
Add regression cases for denial, missing evidence, timeouts and replay, not just
successful requests. Test temporary projects; do not enable your everyday Hook
as part of a test script.

The maintained source is synchronized from an explicitly reviewed product
manifest. Maintainers must bring accepted patches into that manifest before
the next release, so an export cannot silently overwrite a contribution. Public
issues and PRs are welcome; access to the Studio repository is not necessary.
