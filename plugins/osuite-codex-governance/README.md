# OSuite Codex Plugin

Version 1.1.1 is the unpublished Node maintenance candidate for manually
installed hook-capable hosts, aligned with the SDK 2.10.2 source candidate.
Installing the files does not establish hook trust or invocation in a particular
Codex app, CLI, or IDE release. Hook-bearing plugins are not public-directory
qualified by the detached Node fixtures in this repository.

## What ships in the plugin

- Codex `hooks.json`
- dependency-free Node hook scripts and their generated runtime bundle
- a packaged Node OSuite MCP bridge (advisory; it does not execute upstream tools)
- a bundled skill layer for approval-safe behavior
- stricter install defaults than the advanced engineering hook guide
- plugin-local hook resolution through `PLUGIN_ROOT` so the package stays self-contained after install

## Default posture

- `OSUITE_HOOK_MODE=enforce`
- `OSUITE_GUARD_FAILURE_MODE=block`
- `OSUITE_SIGNATURE_MODE=required`
- trusted project required
- Bash governance enabled by default in the first release

## Install

1. Add the plugin to your local Codex marketplace or repo plugin directory.
2. Review `config.toml.partial` and the host's hook/trust controls. Preserve
   existing settings and intentional disablement; only enable a dedicated
   approved test or deployment project.
3. Bind `OSUITE_BASE_URL`, `OSUITE_API_KEY`, `OSUITE_AGENT_ID`, and the existing
   agent's `OSUITE_PRIVATE_KEY_BASE64` from its Studio signing bundle. Store the
   private key outside version control and never paste it into logs or issues.
4. Trust the project so repo-local `.codex` configuration can load.

`config.toml.partial` is a non-secret, opt-in reference, not an installer. Merge
root approval/sandbox keys at TOML root and feature keys into `[features]`; do not
append the fragment inside another table or weaken existing controls. It is not
applied automatically. Its presence alone does not prove that a host loaded the
plugin or executed a hook. The inspected Codex CLI 0.144.1 accepts this template
and reports `hooks` as stable; it reports `plugin_hooks` as removed, so that
obsolete flag is not set. Validate the actual target host's configuration rather
than assuming this CLI check establishes app or IDE support.

The selected hook and MCP entrypoints require Node.js 18+ on `PATH`, not Python
or an npm dependency install. Legacy Python files remain in the Studio source
for compatibility, but are not selected by `hooks.json` or `.mcp.json` and are
not part of the public Node-only SDK export. Required-signature mode
fails closed when the key or signer is unavailable. A configured invalid key is
never silently replaced by an unsigned request.

The approval wait defaults to 30 seconds, configurable with
`OSUITE_APPROVAL_WAIT_SECONDS` (0-40 seconds); the host hook timeout must be longer
than the selected wait plus HTTP overhead. Timing out blocks the current call.
An approval for that call cannot be reused for a new action or fingerprint.
Session start and every preflight fetch verified, key-scoped remote posture.
An expired offline cache cannot relax enforcement. Session-start output itself
is not a blocking guarantee; the preflight repeats the check.

An approved polling GET is only observation. The hook re-submits the same signed
tool action through `POST /api/actions` once for current-policy, one-use admission.
It releases the tool only on an explicit current approval grant, or explicit
`allow`/`warn` with `running` status after policy relaxation. A changed policy
can keep it pending or deny it; a lost or ambiguous admission response
requires reconciliation, not an automatic resend.

For advisory MCP use, a review observation must be followed by a fresh
`osuite_preflight_action` with the identical `tool_name`, `tool_input`, and
`tool_use_id`. Only its `authorized: true` response in an enforcing posture can
admit that call. `effect_executed: false` remains true: the caller, not the MCP
bridge, executes the tool, and completion is recorded as `mcp_caller_report`.

For Git-backed rollout, publish a marketplace root that contains `.agents/plugins/marketplace.json`, then ask users to run `codex plugin marketplace add <owner/repo> --sparse .agents/plugins` or the equivalent Git URL form.

After changing `sdk/runtime/`, regenerate the shipped bundle from the source
checkout with `node plugins/osuite-codex-governance/hooks/build-node-runtime.mjs`.
The existing development esbuild is a build-time tool only. The bootstrap API
ships the generated bundle and all selected launchers together; detached tests
run these downloaded assets with no SDK checkout, npm packages, or Python.

## Why this package exists

The advanced hook guide is still available for engineers. This plugin is the packaged distribution lane for broader rollout, safer defaults, and a better non-technical installation experience.
