---
name: ue-mcp-dialogs
description: Use when a ue-mcp call is refused because a modal dialog blocks the Unreal editor - the refusal mentions a dialog, dialog buttons, dialogPhase, respond_to_dialog, or "blocking dialog". Covers the interactive/auto/defer handling modes, reading the dialog with list_dialogs, and which mode lets the agent press a button.
---

# ue-mcp blocking dialogs

A modal dialog blocks Unreal's game thread: EVERY action is refused until the
dialog is answered - including each step of a running flow. One guard per
editor enforces this on every route to the editor. A refusal naming a dialog is
not a failure to retry; it is an instruction to handle the dialog.

## Read the dialog first - always allowed

`editor(action="list_dialogs")` works in every mode. It reports the blocking
dialog, its title, and its buttons. Read it before doing anything else; never
guess which button means what.

## The three modes

| Mode | What happens to the dialog |
|---|---|
| `interactive` | The refusal hands back an elicitation form with the dialog's buttons as choices plus "leave it open". The PERSON picks a button; `editor(action="respond_to_dialog")` is REFUSED in this mode - the answer belongs to the person. |
| `auto` | The refusal includes an `editor(action="respond_to_dialog")` call for each button. Pick one and make that call - nothing is pressed until you do. |
| `defer` | The refusal names the dialog and its buttons but NOT the calls that press them. `respond_to_dialog` is refused; the person answers at the editor's own window. |

`auto` is NEVER the fallback default: with no elicitation capability the default
is `defer` (suspend for a human, don't let the agent decide). It only applies
when explicitly named.

## Mechanics worth knowing

- `dialogPhase` on the refusal says which call you are on: `relay` (the dialog
  was handed over as text) or `asking`.
- A multi-checkbox dialog (e.g. "Save Content" with one checkbox per unsaved
  package) carries the rows in the SAME form as one checkbox group titled
  "Assets" - what is ticked travels with the button in one press.
- The form outlives the call that raised it: the blocked call waits about a
  minute for an answer and then refuses, but the form stays up and the picked
  button still presses when answered. Re-read happens first, so an answer
  arriving after the dialog was closed at the editor presses nothing.
- `editor(action="set_dialog_policy")` arms patterns that are answered
  immediately under every mode. Nothing else presses a button on its own, and
  there are no built-in policies.

## Where the mode lives and how to change it

Read order (highest wins): the `UE_MCP_DIALOG_MODE` env var, then per-project
`dialog.mode` in `~/.ue-mcp/state.json`, then per-user, then the default. Set
it with `npx ue-mcp dialog mode <interactive|auto|defer>` (add `--editor
[name]` to scope to one project, `default` to clear). This is machine-local
state, deliberately not project config - see the ue-mcp-cli skill.