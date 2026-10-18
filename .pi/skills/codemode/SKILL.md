---
name: codemode
description: Use pi's builtin codemode tool correctly for batching independent read-only tool calls - label batched results (output has no per-call labels), treat resolved error-texts as failures, recover spliced output from the spill file, and discover script-only tools with ALL_TOOLS/describeTool (tool_search "No matching tools found." is NOT absence).
---

# Codemode — batching independent tool calls

`codemode` runs a sandboxed JavaScript script whose `tools.<name>({...})` calls reach the tools a
direct chat tool call would reach (Sigil bridge tools, MCP tools — the same permission path). It
is a BATCHING and output-filtering surface, not a replacement for direct calls. In every
Sigil-managed persona codemode MUTATIONS are forbidden (Agent Tool Discipline): batch read-only
calls only.

# Discovery ladder (run BEFORE first tool use in a new area)

1. **Absence proves nothing.** The inline tool declarations in the codemode tool description are
   a cost-based SUBSET (about 3000 tokens default) — absence from them means NOTHING about
   callable-ness. With codemode.mode `only`, every DECLARED tool is script-call-only, and
   deferred-exposure tools are listed in NEITHER mode.
2. **Ask inside a script, before calling.** `searchTools(topic, { namespace: "sigil" })` (drop the
   namespace for MCP tools), then `describeTool(exactName)` — `describeTool` resolves to a STRING,
   not an object.
3. **`tool_search` answers for DEFERRED (not-yet-loaded) tools only.** A "No matching tools
   found." for already-active script-only tools is NOT evidence of absence — ground truth is
   `ALL_TOOLS` (bounded: `JSON.stringify(ALL_TOOLS.map(t => t.name))` — names, never payloads)
   and `describeTool(name)` inside a codemode script.
4. **On `Validation failed for tool "name"`:** the error lists missing/required properties — fix
   the arguments of the SAME call and retry it. Never re-discover, never switch tools on
   retryable validation errors.
5. **Seed habit.** The first codemode call in a new task area = `searchTools(topic)` +
   `store("tools:<area>", JSON.stringify(names))`; consult `load("tools:<area>")` next turn.

## When to use codemode

- **3+ INDEPENDENT read-only calls** in one turn — worth writing a script: one round trip, the
  results still attributable.
- **Output filtering** — fetch coarse results, narrow them in the script, return only the useful
  slice (leaner context).
- NEVER route a single call through codemode — the direct tool call is cheaper and its status is
  visible in the UI.
- NEVER batch DEPENDENT calls (a later call needs an earlier call's result) — sequential direct
  calls instead.
- Never mutations: no edits, no builds, no git writes through a batch. A denied tool stays denied
  inside a script — never use codemode to dodge Settings' per-tool allow/ask/deny.
- Never nest `task_delegate` or any long-running/mutating call (builds/test runs, `sigil_lint_files`/`sigil_reformat_file` loops) inside a codemode script — delegation fan-out is direct parallel `task_delegate` calls, always awaited, never fire-and-forget.

## Label the output

pi returns the script's printed blocks plus its return value with NO per-call labels — per-call
success/failure is invisible in the returned text (statuses show in the UI tool pills only).

- Return ONE object keyed per call: `return { taskTree: t, problems: p }`.
- Or prefix each printed block: `text('=== sigil_get_task_tree ===\n' + value)` (equivalently
  `console.log`), so the header names the producing call.
- Never append several call results unlabeled — the model must be able to attribute each result
  without guessing by order.

## Reading results

The result text starts with a `Script completed` (or `Script failed`) header, then `Wall time`,
then the output. `text()`/`console.log` blocks come back as separate blocks; the RETURN value is
appended after them — a returned object renders as ONE giant JSON line, another reason to key it
per call.

- `"Total output lines: N"` with an interior `…N tokens truncated…` marker means the joined
  output was SPLICE-TRUNCATED head+tail (over the output budget) — the middle is recoverable:
  the spill temp-file path is shown at the end of the result; read it with the `read` tool
  (use `offset`/`limit` for large files).
- When reading that spill file (or any file whose lines carry a short `<hash>│` prefix), the
  prefixes are pi's own read-line anchors, not file content — never treat them as data.

## Errors

- `Script error: SyntaxError ...` — the script itself failed to run: re-check your own args and
  quoting (the stack is sandbox-internal, not a tool failure).
- `TypeError: ... is not a function` — the tool is not exposed under that name; probe with
  `describeTool(name)` / `ALL_TOOLS` (Discovery ladder above) before retrying.
- A rejected promise inside the script → resolve per call (`try/catch` around each, or
  `Promise.allSettled`) so one failure does not hide the other results.
- RESOLVED error-texts arriving inside successful output are FAILURES, not noise: a nested
  tool-result like `"Access denied: ..."`, or a `bash` call's structured object with
  `exit_code != 0`, means that call failed — handle per call, never as normal output.
- On ANY codemode failure, nested calls reported (cancelled)/unfinished are NOT evidence they never ran — a mutating nested call may ignore the abort signal and complete under an already-failed parent; reconcile via `task_list` / `sigil_get_task_tree` BEFORE re-delegating or concluding nothing happened.


## NEVER edit a file from content assembled in a codemode script (2026-10-06 incident)

The nested `read` tool PAGINATES at ~50KB and appends a trailer line like
`[Showing lines 1-890 of 1651. Use offset=891 to continue.]`. Two failure modes, both real
(753 lines destroyed on InputArea.kt; trailer text spliced into files as content):

1. A script that reads a file and writes the whole file back TRUNCATES it to the first page.
2. Script line-splices that treat the read output as line arrays ingest the trailer (and
   `Offset N is beyond end of file` error lines) as CONTENT, corrupting the file.

- File edits go through the pi builtins `replace`/`insert`/`write` with ONE edit per call, fresh read
  anchors, `sigil_get_file_problems` after each — never through codemode read+write loops.
- If pi-edit array params arrive mangled (literal `["...", "..."]` junk lines in the diff — a
  seen-in-production transport bug this session), fix with MORE pi-edit calls on FRESH anchors;
  after REPEATED mangling in one session, the REPORTED fallback is a minimal scripted line-splice
  with guard checks (find-then-verify neighbors, exact line count) — NEVER whole-file assembly
  from a single read.
- Trust `sigil_build_project` as the corruption gate: lsp_diagnostics can analyze a stale model
  and report clean on corrupted files (it did, three times, during the incident).
- Recovery for a truncated file: `sigil_local_history_revert` (works; minute-based label).
## Limits

- Script options comment: `// @options {"max_output_tokens": N, "timeout_ms": M}` —
  `max_output_tokens` defaults to 10000 (over-budget output spills to a temp file, see Reading
  results); `timeout_ms` bounds the script run — set `timeout_ms` only deliberately: it is unset by default in pi 1.0.2 (the 60000 in the codemode tool description's @options example line is a copied-through template, not a default).
- Sandbox: 256 MB heap, no timers (`setTimeout` etc. unavailable), no nested codemode scripts.
- Output cap (pi 1.0.2): a script FAILS once its printed output passes 16 Mi characters or
  100000 items (upstream #10283 OOM guard) — keep every batch bounded and return
  filtered/derived results from the script, never full raw dumps.
