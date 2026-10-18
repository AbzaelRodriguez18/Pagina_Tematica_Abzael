---
name: sigil-debugger
description: Debug JVM code at runtime through the sigil_xdebug_* bridge tools - set breakpoints, logpoints, and conditional breakpoints, run a debugger session from an IDE run configuration, step and inspect stacks/frames/values, evaluate expressions, and confirm fixes by mutating variables. Use when runtime evidence is needed (actual values, branch taken, reachability), for long call chains static reading cannot resolve, or when the user explicitly asks for the debugger.
---

# JVM Debugging with the sigil_xdebug_* Tools

This skill teaches you how to get runtime evidence through the Sigil bridge's debugger tools:
launch a debug session from an IDE run configuration, install probes, suspend the session, and
read the actual stacks, frames, and values that static reading can only guess at.

## When to Use This Skill

- **Runtime values** — you need what a variable, field, or expression ACTUALLY holds at the
  failing moment, not what the code suggests it should hold.
- **Branch evidence** — which branch was taken, which condition was true, which overload ran.
- **Reachability** — whether a code path executes at all (a "dead" listener, an unhit guard).
- **Long call chains** — control flow through many frames that static reading cannot resolve.
- **Explicit user request** — the user asks for the debugger; use it even when static analysis
  might suffice.

When the question is answerable statically, prefer static analysis first (`sigil_search_symbol`,
`sigil_analyze_calls`) plus `sigil_get_file_problems` — a debug session costs more than a read.

## Tool Surface Warning (read first)

A global `ij-debugger` skill exists in some environments. It is written for a DIFFERENT router
surface (`execute_tool(command="--param value ...")`, `--suspendPolicy`, `--owner`,
`DRAIN_EVENTS`, `sessionId`). NONE of that exists in Sigil sessions:

- Never use that syntax. Call the `sigil_xdebug_*` tools directly with their native parameters —
  the tool reference table below is the complete surface.
- Sessions are addressed by `sessionIndex` (default `0` = the most recent session). There is no
  `sessionId`, no owner concept, no suspend policy.
- The bridge has NO event-drain API. Logpoint output goes to the IDE's debugger console —
  user-visible, but NOT returned to you through the bridge. For agent-collected evidence,
  prefer conditional suspending breakpoints + frame inspection, or evaluate expressions
  directly in a suspended frame.

## Logpoint-First Probing

A logpoint (`logExpression` on `sigil_xdebug_set_breakpoint`) LOGS instead of suspending — the
run keeps its natural timing. Prefer logpoints as your first probes:

- Keep the expression side-effect-free: field reads, getters, `toString()`. No mutation, no IO.
- Placement: the expression evaluates when the line is reached, BEFORE the line executes — every
  referenced symbol must already be initialized there. Put the probe on the line AFTER the
  assignment completes, not on the declaration line.
- Be honest about the output: it lands in the IDE's debugger console (the user sees it; you do
  not). If YOU need the value, use a conditional suspending breakpoint (`condition` — breaks
  only when true) and read the value with the frame tools, or evaluate the expression directly.

## Session Lifecycle

1. `sigil_get_run_configurations` — list run/debug configurations by exact name; an optional
   `filePath` adds best-effort executable entry points for that file. START HERE: launching a
   session takes a configuration NAME, not a file.
2. Resolve the exact `configurationName`. When nothing fits, `sigil_create_run_configuration` /
   `sigil_update_run_configuration` (both ask-gated) create or adjust one.
3. `sigil_xdebug_start_debugger_session` with `configurationName` — launches with the Debug
   executor and waits until the session registers (~30s).
4. `sigil_xdebug_get_debugger_status` — confirms the session is active. The most recent session
   is `sessionIndex` 0, the default for every session-scoped tool; with a single session you
   never pass it.
5. Work: install breakpoints, drive execution, inspect (below).
6. Cleanup: remove every agent-installed breakpoint (`sigil_xdebug_list_breakpoints` →
   `sigil_xdebug_remove_breakpoint` per `filePath` + `line`) and end the session with
   `sigil_xdebug_control_session` `STOP`.

## Inspecting a Suspended Session

The stack/frame/value tools REQUIRE a suspended session. If it is running, `PAUSE` — or after a
`RESUME`, `WAIT_FOR_PAUSE` (blocks until the session suspends again, ~20s cap). Then:

1. `sigil_xdebug_get_stack` — frame index, source position (`file:line`), presentation text.
   The top frame is frame 0.
2. `sigil_xdebug_get_threads` — every thread's execution stack with its top-frame position; use
   it to find where execution actually is (and what else is alive).
3. `sigil_xdebug_get_frame_values` — name/type/value per variable in a frame (`frameIndex`,
   default 0 = top).
4. `sigil_xdebug_get_value_by_path` — follow dotted/bracketed paths like `list[3].name` into
   nested graphs; returns the leaf value, its type, and whether it has children.
5. `sigil_xdebug_evaluate_expression` — evaluate an expression in the suspended top frame; the
   cheapest hypothesis test (`flag == null`, `map.containsKey(k)`, `list.size()`).
6. `sigil_xdebug_run_to_line` — resume and run until a known 1-based line in a file; advances
   without repeated stepping and doubles as a reachability test.

Multi-line fluent/builder chains have no intermediate variables — the value exists only after
the statement completes. Probe or evaluate after the full statement, or step onto it.

## Confirming a Fix Cheaply

`sigil_xdebug_set_variable` (`nameOrPath`, `value` as a debugger expression string; ask-gated)
mutates a variable in the suspended frame. Correct the suspect value at runtime, let execution
continue, and observe the outcome — BEFORE editing source. If the mutated value fixes the
behavior, the hypothesis is confirmed; then apply the real fix in the source.

## Workflow

1. **Scope the failure** — exact wrong behavior, input, expected vs actual.
2. **Form 2-5 hypotheses** — concrete and falsifiable ("the flag is false here", "this branch is
   never reached", "the map already contains the key").
3. **Install probes** — logpoints to observe, conditional breakpoints to stop.
4. **Start the session** from a run configuration (lifecycle above).
5. **Let it reach the probes** — `RESUME` or `sigil_xdebug_run_to_line`; a hit suspends.
6. **Inspect** — stack, threads, frame values, paths, expressions.
7. **Refine or confirm** — refine the hypotheses, move or add probes, repeat until one survives.
8. **Confirm the fix** — mutate the suspect value with `sigil_xdebug_set_variable`, observe.
9. **Edit the source** to apply the real fix.
10. **Remove agent-set breakpoints** — `sigil_xdebug_list_breakpoints`, then
    `sigil_xdebug_remove_breakpoint` per file:line (re-list after edits; line numbers shift).
11. **Rebuild** with `sigil_build_project` and verify.

## Delegation Boundary

Debugger sessions are orchestrator-owned. Subagents do not start, control, or inspect debug
sessions — the orchestrator gathers runtime evidence itself and hands findings to subagents.

## Error Handling

- **"Requires a suspended session"**: check `sigil_xdebug_get_debugger_status` first, then
  `PAUSE` (or `WAIT_FOR_PAUSE` after `RESUME`) before retrying the inspection tool.
- **Parameter errors**: fix the parameters and retry the SAME tool — lines are 1-based, file
  paths are project-relative, `configurationName` matches exactly, `action` is one of the eight
  literal values. Switching tools to dodge an error is a workaround.
- **Breakpoint didn't hit**: verify it is `enabled` and the code path actually executes —
  `sigil_xdebug_run_to_line` is the reachability test (it suspends only if the line is reached).
- **Removed-then-changed line**: source edits shift line numbers, so breakpoint positions go
  stale — re-list with `sigil_xdebug_list_breakpoints` before removing or trusting them.

## Tool Reference

Gate: `allow` runs without prompting; `ask` prompts the user for approval (per-tool
allow/ask/deny lives in Settings → Tools → Sigil → IDE Tools).

| Tool | Gate | Parameters | Use |
| --- | --- | --- | --- |
| `sigil_get_run_configurations` | allow | `filePath?` | List run/debug configurations by name (+ best-effort entry points). |
| `sigil_xdebug_start_debugger_session` | ask | `configurationName` | Launch a configuration with the Debug executor (~30s to register). |
| `sigil_xdebug_get_debugger_status` | allow | — | Active session? Suspension state, source position, breakpoint count. |
| `sigil_xdebug_set_breakpoint` | ask | `filePath`, `line`, `condition?`, `logExpression?`, `enabled?` | Create-or-replace breakpoint / conditional / logpoint at a line. |
| `sigil_xdebug_remove_breakpoint` | ask | `filePath`, `line` | Remove ALL breakpoints at that position. |
| `sigil_xdebug_list_breakpoints` | allow | — | All breakpoints: file, line, enabled, condition/logExpression. |
| `sigil_xdebug_control_session` | ask | `action`, `sessionIndex?` | STEP_OVER / STEP_INTO / STEP_OUT / FORCE_STEP_INTO / RESUME / PAUSE / STOP / WAIT_FOR_PAUSE. |
| `sigil_xdebug_get_stack` | allow | `sessionIndex?` | Suspended call stack: frame index, file:line, presentation. |
| `sigil_xdebug_get_threads` | allow | `sessionIndex?` | Thread execution stacks with top-frame positions. |
| `sigil_xdebug_get_frame_values` | allow | `frameIndex?`, `sessionIndex?` | name/type/value per variable in a frame (0 = top). |
| `sigil_xdebug_get_value_by_path` | allow | `path`, `frameIndex?`, `sessionIndex?` | Follow `list[3].name`-style paths; leaf value, type, hasChildren. |
| `sigil_xdebug_evaluate_expression` | allow | `expression`, `sessionIndex?` | Evaluate an expression in the suspended top frame. |
| `sigil_xdebug_set_variable` | ask | `nameOrPath`, `value`, `frameIndex?`, `sessionIndex?` | Mutate a frame variable to test a fix hypothesis at runtime. |
| `sigil_xdebug_run_to_line` | ask | `filePath`, `line`, `sessionIndex?` | Resume and run until a 1-based line; needs a suspended session. |

When no run configuration fits, `sigil_create_run_configuration` /
`sigil_update_run_configuration` (ask-gated) create or adjust one.

## Tips

- Escalate gently: logpoint → conditional breakpoint → unconditional breakpoint. Only the last
  one stops every time.
- `sessionIndex` defaults to 0 (the most recent session); with a single session you never pass it.
- Prefer `sigil_xdebug_run_to_line` over repeated STEP_OVER when the target line is known.
- Once suspended, `sigil_xdebug_evaluate_expression` in the top frame beats re-placing probes
  for most questions.
- The always-loaded `.sigil/context/intellij-mcp-tools.md` reference lists every bridge tool's
  parameters; the bundled `sigil-ide-tools` skill covers the surrounding workflow discipline.