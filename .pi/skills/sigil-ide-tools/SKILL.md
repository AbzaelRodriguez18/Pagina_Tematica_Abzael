---
name: sigil-ide-tools
description: Use the first-party sigil_* IntelliJ bridge tools well - the research-before-edit and verification ladders, tool selection, retry-same-tool protocol, indexing gotchas, and delegation boundaries.
---

# Sigil IDE Tools — Usage Discipline

The `sigil_*` tools are the plugin's first-party bridge into the IDE: live PSI data, the
inspection engine, the build system, the debugger, git, and run configurations. They are
type-resolved and always fresh — prefer them over guessing at code structure. Users manage them
per-tool (enabled + allow/ask/deny) in Settings → Tools → Sigil → IDE Tools; per-parameter
details live in each tool's description and in the always-loaded
`.sigil/context/intellij-mcp-tools.md` reference. This skill teaches the workflow discipline
around the tools.

## Host IDE compatibility (read this first)

Language intelligence is IDE-dependent. The PSI-backed semantic tools
(`sigil_search_symbol`, `sigil_get_symbol_info`, `sigil_analyze_calls`, `sigil_rename_refactoring`,
the extract/safe-delete family) and the inspection/build tools are strongest in
**IntelliJ IDEA** (full Java/Kotlin PSI). Other IDEs differ:

- **Rider** — C# intelligence runs in the out-of-process ReSharper backend, NOT PSI. Semantic
  tools may return empty results or refuse for C# code.
- **PyCharm / WebStorm / CLion / GoLand** — each indexes its own languages; there is no Java PSI.

When a semantic tool comes back empty on a non-IDEA host, do not retry blindly — fall back to
`sigil_search_text` / `sigil_search_regex` and plain file reads. Host-agnostic families:
file/search/browse, Git, run configurations, and the debugger tools (session support varies by
language).

## Ladder 1 — research before edit (never guess)

1. **Orient**: `sigil_list_directory_tree` / `sigil_search_file` for the project layout.
2. **Locate**: `sigil_search_symbol` (exact short name) — never grep for declarations.
3. **Resolve**: `sigil_get_symbol_info` at a 1-based line:column resolves what an identifier
   refers to (name, qualified name, type, declaration snippet).
4. **Call graph**: `sigil_analyze_calls` (callers/callees, depth ≤ 4) — who calls it, what it
   calls. Caller breadth ≈ blast radius; plan edits over the affected set before touching
   anything.
5. **Study existing patterns** before writing new code — mirror the codebase's conventions and
   check whether the logic already exists somewhere.

## Ladder 2 — verify after edit (never assume)

1. `sigil_reformat_file` — project code style.
2. `sigil_get_file_problems` on the edited file — fix errors before moving to the next file.
3. `sigil_lint_files` over the whole changed set in ONE call (batch, ≤ 20 files).
4. `sigil_build_project` — the final gate. Never claim a task is done without a passing build;
   pass `filesToBuild` for a targeted compile of specific files.
5. Build failed? Read the errors, fix, rebuild. IDE diagnostics beat reading.

## Parameter discipline (prevents most failures)

- File paths are project-relative or absolute; lines and columns are **1-based**.
- Never guess a symbol's qualified name — resolve it with `sigil_search_symbol` first.
- On a parameter error, the message tells you exactly what is wrong: fix the parameters and
  retry the SAME tool. Switching tools to dodge an error is a workaround.
- A tool reported as disabled or denied is never used and never worked around (no shell, no
  scripts). Per-tool enablement lives in Settings → Tools → Sigil → IDE Tools.

## Parallelism

- Independent calls go in ONE block (e.g., listing modules + reading two unrelated files).
  Dependent calls wait for their inputs.
- After edits: lint the entire changed set in one `sigil_lint_files` call rather than
  file-by-file.

## Indexing

Right after project open or import the IDE indexes; symbol and search tools are unreliable until
it finishes. Check `sigil_get_indexing_status` (`dumb=true` → wait, then retry).
`sigil_search_file`'s filename index usually still works while indexing.

## Refactoring family — know the degraded tools

On current IDE builds these validate arguments and then REFUSE with UNAVAILABLE (their
machinery opens modal dialogs that cannot be suppressed headlessly): `sigil_safe_delete`,
`sigil_move_element`, `sigil_extract_method`, `sigil_extract_variable`, `sigil_extract_field`,
`sigil_extract_constant`, `sigil_inline_element`, `sigil_local_history_list`. Do not retry them
in a loop — perform the edit manually or ask the user to run the IDE refactoring.
`sigil_rename_refactoring` (full project-wide rename, references included) and
`sigil_local_history_revert` (restore file content to N minutes ago) work normally — prefer them.

## Debugger

Prefer breakpoints and logpoints over print-debugging: `sigil_xdebug_set_breakpoint` with a
`condition` (breaks only when true) or a `logExpression` (logs instead of suspending). Start a
session from an existing run configuration, then read the stack/frames and use
`sigil_xdebug_evaluate_expression` to test hypotheses before editing. Mutating a variable with
`sigil_xdebug_set_variable` confirms a fix cheaply. The bundled `sigil-debugger` skill covers
the full session workflow (logpoint-first probing, inspection, and cleanup).

## Quick fixes and intentions

- `sigil_list_quick_fixes` (allow) opens the file in the editor, places the caret at a 1-based
  line/column, computes current inspection highlights plus registered intentions, and returns
  every available fix as `{index, familyName, text}` — current highlights first, then registered
  intentions. Listing is read-only; applying is a write action.
- `sigil_apply_quick_fix` (ask) applies one fix by `fixIndex` at the SAME caret position.
- **The stability contract:** returned indices are valid ONLY for the file state as it was when
  listed. If the file changed since listing (any edit, including by another tool), RE-LIST
  before applying — applying a stale index applies the wrong fix.
- Tip: list fixes at the exact caret of the highlighted problem (pass `column`, don't default
  to 1) — the available-fix set is caret-sensitive.

## Run configurations

- Discovery first: `sigil_get_run_configurations` (allow) lists existing configurations by exact
  name; passing `filePath` also returns best-effort executable entry points for that file.
  Resolve names from this list — never guess.
- Mutations are ask-gated: `sigil_create_run_configuration` (needs a `configurationTypeId` such
  as Application/Gradle/Maven/JUnit — unknown ids are rejected with the available list),
  `sigil_update_run_configuration` (rename via `newName`; set
  `programParameters`/`workingDirectory`/`environmentVariables`), and
  `sigil_delete_run_configuration`.
- Semantics worth stating: `environmentVariables` entries use NAME=value and REPLACE the whole
  map (not a merge); unsupported parameters for a configuration type come back listed under
  `skipped` instead of failing silently.
- Execution: `sigil_execute_run_configuration` (ask) launches by name and waits up to ~45s,
  returning `exitCode` + `outputTail`; a process that outlives the wait keeps running in the
  IDE Run tool window. `executorId` defaults to Run; pass `Debug` for a debug launch, or start
  a full debugger session with `sigil_xdebug_start_debugger_session` (see the bundled
  `sigil-debugger` skill for the complete debugging workflow).

## Delegation boundaries (when an orchestrator agent runs the session)

- Build + test verification belongs to the orchestrator; subagents verify with
  `sigil_get_file_problems` / `sigil_lint_files` only.
- Debugger sessions are orchestrator-owned.
- Cross-file integration errors are fixed by whoever owns the build gate.

## When NOT to use these tools

- Config values, TODOs, strings in comments → `sigil_search_text`.
- Full implementation reading → the plain file-read tool; use `sigil_get_symbol_info` for
  signatures.
- Anything outside the IDE (websites, databases) → dedicated tools or skills.