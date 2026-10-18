---
name: psi-code-intelligence
description: Use IntelliJ's semantic code intelligence (PSI) sigil_* tools for symbol search, call analysis, and code verification instead of blind text search - and know when the host IDE cannot answer (Rider's C# engine is not PSI).
---

# PSI Code Intelligence Skill

This skill teaches you how to use the Sigil bridge's semantic code-intelligence tools. They
query live PSI (Program Structure Interface) data — always fresh, type-resolved, reflecting the
current editor state including unsaved changes.

## Host IDE compatibility (read this first)

PSI is the host IDE's semantic index, and its language coverage is IDE-dependent:

- **IntelliJ IDEA** — full Java/Kotlin PSI; every tool below works at full strength.
- **Rider** — C# intelligence runs in the out-of-process ReSharper backend, NOT PSI. Semantic
  tools may return empty results or refuse for C# code.
- **PyCharm / WebStorm / CLion / GoLand** — each indexes its own languages with its own PSI
  implementation; Java-PSI-backed machinery (short-name caches, Java call resolution) has
  nothing to query.

When a semantic tool comes back empty on a non-IDEA host, do not retry blindly — switch to
`sigil_search_text` / `sigil_search_regex` and plain file reads. Check `sigil_get_indexing_status`
first after project open: while the IDE is indexing (dumb mode), semantic results are unreliable.

## Available Tools

### `sigil_search_symbol` — Symbol Search
Find classes, methods, functions, and fields by exact short name across the project (or SDK and
library symbols with `includeExternal=true`). Returns fully qualified names, kinds, and declaring
files.

**Use when:** locating a declaration, getting a signature, resolving a name before passing it
elsewhere.

**Parameters:** `query` (required, exact short name), `includeExternal?` (also search SDK and
library symbols).

**Prefer over grep when:** you need the declaration site, not all mentions. Grep finds text
matches; `sigil_search_symbol` finds semantic declarations.

### `sigil_get_symbol_info` — Resolve a Reference at a Position
Resolve the reference at a 1-based line and column in a project file and return the target
symbol's name, kind, qualified name, type, and a declaration snippet.

**Use when:** you need to know what an identifier at a specific position refers to — the
authority on overloads, shadowing, and imports.

**Parameters:** `filePath` (required), `line` (required, 1-based), `column` (required, 1-based).

### `sigil_analyze_calls` — Call Graph
Caller or callee tree for a method or function. Resolves the symbol by name within the given
file, then traverses call references up to depth 4.

**Use when:** tracing "who calls the method that calls this method", understanding the call
graph around a method, or sizing a refactor's blast radius (caller breadth ≈ impact).

**Parameters:** `filePath` (required), `symbolName` (required, exact short name),
`direction?` (`callers` default | `callees`), `maxDepth?` (default 3, max 4).

**Replaces the retired `psi_find_references` / `psi_impact_analysis` shapes:** the callers tree
gives you every call site (references) and its breadth gives you the impact assessment. There is
no 1:1 references-search or blast-radius tool on the bridge — `sigil_analyze_calls` +
`sigil_search_text` are the substitutes.

### `sigil_search_text` / `sigil_search_regex` — Find-in-Files
Literal or regex search across project files, with an optional project-relative glob filter.
Returns file path, 1-based line, and a matching-line preview.

**Use when:** config values, TODOs, strings in comments, log-message needles, anything that is
NOT a symbol declaration.

### `sigil_search_file` — File Search
Find project files by glob pattern relative to the project root. Literal file names use a
fast file-name index.

**Use when:** locating a file (not a symbol). Usually still works while the IDE is indexing.

### `sigil_get_file_problems` / `sigil_lint_files` — Inspection Engine
Compile errors plus IDE inspections for one file (`get_file_problems`) or a batch of up to 20
files (`lint_files`), with 1-based line/column, severity, and message.

**Use when:** verifying your edits — run after every edit and before claiming anything compiles.

### `sigil_build_project` — Build (the final gate)
Build/compile the project (or specific files via `filesToBuild`) and wait for completion,
returning build-view errors. The build is the source of truth: never claim a task is complete
without a passing build.

### `sigil_rename_refactoring` — Safe Rename
Full IDE rename refactoring: updates all references project-wide, including comments and text
occurrences. Always prefer this over manual find-and-replace for identifiers.

## When to Use Semantic Tools vs grep/read

| Task | Use | Not |
| ------ | --- | --- |
| Find a declaration | `sigil_search_symbol` | grep |
| Find all call sites / callers | `sigil_analyze_calls` (callers) | grep |
| See what a method calls | `sigil_analyze_calls` (callees) | read |
| Size a refactor's blast radius | `sigil_analyze_calls` (callers breadth) | guess |
| Know what an identifier refers to | `sigil_get_symbol_info` | assume |
| Verify code compiles / passes inspections | `sigil_get_file_problems`, `sigil_lint_files` | hope |
| Find text in strings/comments/config | `sigil_search_text` | symbol search |
| Read implementation details | plain file read | — |

## Error Handling

- **"Indexing" / `dumb=true`**: the IDE is indexing — wait a few seconds and retry (check
  `sigil_get_indexing_status`).
- **No symbol matching 'X' found**: the symbol does not exist under that name — check spelling
  or try a broader query.
- **Ambiguous symbol**: several symbols match — disambiguate with the file path or pick from
  the returned candidates.
- **Tool reported disabled or denied**: never use it and never work around it (no shell, no
  helper scripts) — per-tool enablement lives in Settings → Tools → Sigil → IDE Tools.

## Tips

- Start with `sigil_search_symbol`, then explore usage with `sigil_analyze_calls`.
- `sigil_analyze_calls` depth 3 is a good default; depth 4 maxes the traversal budget.
- The IDE's own diagnostics (`sigil_get_file_problems`) are cheaper than a full build for
  per-file feedback; use `sigil_build_project` for the final compile gate.
- The always-loaded `.sigil/context/intellij-mcp-tools.md` reference lists every bridge tool
  with its parameters; the bundled `sigil-ide-tools` skill covers the surrounding workflow
  discipline.