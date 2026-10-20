# Security

Report vulnerabilities privately to <security@osuite.ai>. Do not put credentials,
customer payloads, private keys or exploit details in a public issue. Include the
affected version, minimal synthetic reproduction and expected boundary.

The authoritative contact and expiry are at
<https://studio.osuite.ai/.well-known/security.txt>.

SDK releases do not enable existing disabled Hooks or grant an agent the right
to approve its own effects. A source checksum verifies byte consistency, not the
honesty of a compromised publishing origin. npm provenance, when actually issued
and verified, identifies the build source; it does not certify policy correctness.

If credentials were committed before a permissions repair, rotate them and
review history. Setting file mode 0600 does not undo previous disclosure.
