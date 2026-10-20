---
name: osuite-governed-runtime
description: Use when performing consequential operations in a project using the OSuite Codex governance plugin.
---

# OSuite Governed Runtime

The bundled MCP bridge is advisory, not an execution gateway. Its replies have
`effect_executed: false`: it never executes the upstream tool. Native hook trust
and configuration remain separate, and direct resource access or alternative
tools are outside the bridge's coverage. Never bypass a hook hold with another
tool, a changed command, or relaxed caller-supplied policy data.

## Required behavior

1. Open an `osuite_begin_session` and call `osuite_preflight_action` before a
   consequential operation. Supply the actual `tool_name`, complete `tool_input`,
   and an explicit, stable `tool_use_id`. Retain these exact values for review;
   do not substitute a summary or omit arguments from the binding.
2. A blocked or held result means do not execute. Use
   `osuite_wait_for_approval` to observe review status if needed. A GET is not
   execution authority: `approval_observed: true` does not release the action.
3. After approval observation, make a fresh `osuite_preflight_action` with the
   exact same `tool_name`, `tool_input`, and `tool_use_id`. This performs current
   policy evaluation and one-use POST redemption. Execute only after this fresh
   response has `authorized: true` and an action ID. The Node bridge only returns
   that authority in current `enforce` or `strict` posture; an earlier session
   mode, observe result, allowed guard result, or successful GET is insufficient.
4. Record at least one assumption for releases, infrastructure, authentication,
   and destructive mutations with `osuite_record_assumption` for the held or
   admitted action. An assumption record is not validated evidence or authority.
5. Execute only that exact admitted operation once, subject to the native host's
   remaining checks. For unknown outcomes, do not retry the side effect or
   automatically resend admission. This includes a lost POST response, timeout,
   or ambiguous tool result. Stop and reconcile the action/replay with the user.
6. Call `osuite_complete_action` only after observing an explicit terminal result,
   with the real completed, failed, or cancelled status. This records
   `mcp_caller_report`, not independently verified host evidence. If its report
   acknowledgement is lost, retry only the identical report or reconcile;
   never repeat the operation to make the ledger look complete.

## Consequential Codex work

- release branches and publish steps
- deploys or infrastructure changes
- auth, secret, or credential changes
- destructive filesystem or database commands
- customer-visible configuration or workflow changes

## Low-risk work

Simple reads and harmless inspection can stay lightweight within the installed
policy. Do not describe advisory checks or observation-only sessions as complete
tool coverage. Once work becomes consequential, use the admission sequence above.
