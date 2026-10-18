
// Sigil IDE Tools - plugin-managed Pi extension (overwritten on each Sigil connect).
//
// The Pi half of the Sigil direct IDE tool bridge (ADR 001). Registers the
// sigil_* IDE tools (manifest-driven) and proxies each call to the Sigil
// RestService endpoint on the IDE's built-in server:
//   GET  <SIGIL_BRIDGE_URL>/tools       -> manifest (schemaVersion + tool defs)
//   POST <SIGIL_BRIDGE_URL>/tool/<name> -> { ok, result } | { ok:false, error }
// Auth: X-Sigil-Bridge-Token header (per-connect UUID via spawn env).
//
// NOTE: no template literals (Kotlin raw-string embedding) and no non-ASCII
// source characters (2.x encoding normalization).

import { Type } from "typebox";

const BRIDGE_URL = readEnv("SIGIL_BRIDGE_URL");
const BRIDGE_TOKEN = readEnv("SIGIL_BRIDGE_TOKEN");
const SCHEMA_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 60000;
const MANIFEST_RETRIES = 6;
const MANIFEST_RETRY_DELAY_MS = 2000;
const EMBEDDED_FALLBACK = {"schemaVersion":1,"tools":[{"name":"sigil_get_file_problems","label":"Get File Problems","description":"Analyze a project file for errors and warnings with the IDE inspection engine. Returns problems with 1-based line, column, severity (ERROR, WARNING, WEAK_WARNING, INFO), and message. severityFloor filters by minimum severity; default WARNING. Run after edits to validate them. Returns a structured timedOut=true result if analysis exceeds the configured budget.","readOnly":true,"timeoutMs":120000},{"name":"sigil_build_project","label":"Build Project","description":"Build the project (or compile specific files) and wait for completion, returning build errors collected from the build view. Use after edits to verify they compile. rebuild=true performs a full rebuild; filesToBuild builds the modules CONTAINING the given project-relative paths (the public build API has no file-scoped build task).","readOnly":false,"timeoutMs":120000},{"name":"sigil_get_project_modules","label":"Get Project Modules","description":"List all modules in the open project with their names and module type names.","readOnly":true,"timeoutMs":10000},{"name":"sigil_get_project_dependencies","label":"Get Project Dependencies","description":"List the class-path roots (libraries and SDK locations) of one module as VFS URLs, deduplicated. moduleName must match a module reported by sigil_get_project_modules.","readOnly":true,"timeoutMs":30000},{"name":"sigil_lint_files","label":"Lint Files","description":"Batch analysis of several project files for errors and warnings; same engine as sigil_get_file_problems. Returns one entry per file with its problems; an entry carries timedOut=true or an error message when the file could not be analyzed in time. At most 20 files per call.","readOnly":true,"timeoutMs":60000},{"name":"sigil_search_text","label":"Search Text","description":"Literal text search across project files backed by the IDE find-in-files engine. Returns matches with file path, 1-based line, and the matching line preview. filePathGlob narrows results to a project-relative glob pattern (for example src/**/*.kt).","readOnly":true,"timeoutMs":60000},{"name":"sigil_search_regex","label":"Search Regex","description":"Regular-expression search across project files backed by the IDE find-in-files engine; same result shape as sigil_search_text. Invalid regex patterns are rejected with a clear error.","readOnly":true,"timeoutMs":60000},{"name":"sigil_search_file","label":"Search File","description":"Find project files by glob pattern relative to the project root (for example **/*.kt). Literal file names use the file-name index fast path. Set includeExcluded=true to also scan excluded/ignored folders.","readOnly":true,"timeoutMs":30000},{"name":"sigil_get_symbol_info","label":"Get Symbol Info","description":"Resolve the reference at a position (1-based line and column) in a project file and return the target symbol name, kind, qualified name, type, and a declaration snippet. Use to understand what an identifier refers to.","readOnly":true,"timeoutMs":30000},{"name":"sigil_list_directory_tree","label":"List Directory Tree","description":"Render an ASCII directory tree for a project directory with bounded depth. Skips .git, node_modules, and build directories plus the .pi/npm cache. Use to explore project structure quickly.","readOnly":true,"timeoutMs":30000},{"name":"sigil_open_file_in_editor","label":"Open File In Editor","description":"Open a project file in the IDE editor, optionally moving the caret to a 1-based line and column. Presents the editor UI; it does not modify project data.","readOnly":true,"timeoutMs":10000},{"name":"sigil_get_all_open_file_paths","label":"Get Open File Paths","description":"List the currently open editor files and the active editor file path in the IDE.","readOnly":true,"timeoutMs":10000},{"name":"sigil_reformat_file","label":"Reformat File","description":"Reformat a project file with the IDE code-style formatter (equivalent to the Reformat Code action on that single file). Mutating: rewrites the file in place.","readOnly":false,"timeoutMs":60000},{"name":"sigil_rename_refactoring","label":"Rename Refactoring","description":"Rename a symbol in a project file with the full IDE rename refactoring: updates all references project-wide including comments and text occurrences. Fails with a conflicts error instead of showing dialogs. Always prefer this over text search-and-replace for identifiers.","readOnly":false,"timeoutMs":60000},{"name":"sigil_file_structure","label":"File Structure","description":"Outline of classes, members, and nested classes for a project file via in-process PSI; works on every host with in-process PSI. filePath is the project-relative or absolute path of the file to outline.","readOnly":true,"timeoutMs":30000},{"name":"sigil_get_run_configurations","label":"Get run configurations","description":"List the IDE's run/debug configurations for this project (name, typeId, factoryName, isTemporary). Optionally pass filePath to also get best-effort executable entry points for that file (run/test gutter actions: executorId + label) under runPoints; entry-point detection is best-effort and empty when the language support exposes no gutter actions. Use sigil_execute_run_configuration to launch a returned configuration.","readOnly":true,"timeoutMs":30000},{"name":"sigil_execute_run_configuration","label":"Execute run configuration","description":"Launch an existing IDE run configuration by name (as returned by sigil_get_run_configurations) and wait for its process up to 45 seconds, returning exitCode and the captured outputTail. If the process outlives the wait it keeps running in the IDE Run tool window (this tool never kills it and never opens the Run dashboard itself). Mutating: starts a real process. executorId defaults to Run; pass another registered executor id (e.g. Debug) to launch with it.","readOnly":false,"timeoutMs":60000},{"name":"sigil_get_review_findings","label":"Get review findings","description":"Read the Sigil review findings recorded in the project's .review/ store (adversarial-review comments attached to source files): file paths, 1-based line numbers, severities, statuses, and messages. Includes open, resolved, and deleted findings; check status per finding.","readOnly":true,"timeoutMs":10000},{"name":"sigil_get_task_tree","label":"Get task tree","description":"Read the CURRENT Sigil session's task tree (first-party sigil-tasks store): id, subject, status (pending/in_progress/completed), priority (low/medium/high), parentId (subtask depth 1) and agent per task. Returns revision 0 with an empty list when the session has no tasks yet. Fails when no active pi session exists.","readOnly":true,"timeoutMs":10000},{"name":"sigil_get_session_registry_stats","label":"Get session registry stats","description":"Read-only statistics from the Sigil session registry (the project's .sigil/sessions.db SQLite index): visible session count, pi-harness session count, archived count, and the most recent activity timestamp (epoch millis). Fails when the registry is disabled or uninitialized (silent shadow mode).","readOnly":true,"timeoutMs":10000},{"name":"sigil_get_indexing_status","label":"Get indexing status","description":"Report whether the IDE is still indexing (dumb mode). dumb=true means symbol/search and code-intelligence tools are unreliable - wait and retry until dumb=false / isIndexed=true.","readOnly":true,"timeoutMs":10000},{"name":"sigil_notify_user","label":"Notify user","description":"Show an IDE notification balloon to the user (e.g. a long-running task finished, or something needs attention outside the chat). Use sparingly and only for genuinely important messages; isError=true renders it as an error notification.","readOnly":true,"timeoutMs":10000},{"name":"sigil_get_repositories","label":"Get repositories","description":"List the VCS roots detected in the project (VCS-agnostic: git, svn, perforce, ...) with their absolute paths and VCS display names. Use sigil_git_status for the current change set.","readOnly":true,"timeoutMs":10000},{"name":"sigil_git_status","label":"Git status (VCS changes)","description":"Read the IDE's VCS change tracking state: files changed in the default changelist, unversioned (untracked) files, and whether the change tracker is mid-update (isBusy - retry shortly when true). VCS-agnostic; paths are project-relative when inside the project root, absolute otherwise. Plugin-managed .review/ files are excluded.","readOnly":true,"timeoutMs":30000},{"name":"sigil_xdebug_get_debugger_status","label":"Debugger status","description":"Show the current debugger state: whether a debug session is active, per-session suspension state and current source position, and the total breakpoint count. Start a session with sigil_xdebug_start_debugger_session.","readOnly":true,"timeoutMs":10000},{"name":"sigil_xdebug_start_debugger_session","label":"Start debug session","description":"Start a debugger session for an existing run configuration (by exact name). Launches the configuration with the Debug executor and waits until the debugger session is registered (up to ~30s).","readOnly":false,"timeoutMs":60000},{"name":"sigil_xdebug_control_session","label":"Control debug session","description":"Control execution of an active debug session. action is one of STEP_OVER, STEP_INTO, STEP_OUT, FORCE_STEP_INTO, RESUME, PAUSE, STOP, or WAIT_FOR_PAUSE (blocks until the session suspends again, up to ~20s). sessionIndex selects among concurrent sessions (default 0 = most recent).","readOnly":false,"timeoutMs":30000},{"name":"sigil_xdebug_get_stack","label":"Debugger stack","description":"Show the call stack of the active (suspended) debug session: frame index, source position (file:line), and the frame's presentation text. Requires a suspended session.","readOnly":true,"timeoutMs":15000},{"name":"sigil_xdebug_get_threads","label":"Debugger threads","description":"List the execution stacks (threads) of the active debug session with their top-frame source positions. Requires a suspended session.","readOnly":true,"timeoutMs":15000},{"name":"sigil_xdebug_get_frame_values","label":"Debugger frame values","description":"List the variables visible in a stack frame (name, type, value) of the active debug session. Requires a suspended session. Renders through the platform's async variable callbacks (bounded); a debugger that never renders returns an explicit timeout error.","readOnly":true,"timeoutMs":20000},{"name":"sigil_xdebug_get_value_by_path","label":"Debugger value by path","description":"Follow a dotted/bracketed variable path (e.g. list[3].name) in the active debug session's frame and return the leaf value, type, and whether it has children. Requires a suspended session.","readOnly":true,"timeoutMs":20000},{"name":"sigil_xdebug_evaluate_expression","label":"Debugger evaluate","description":"Evaluate an expression in the active debug session's top frame using the debugger's own evaluator and return the rendered result. Requires a suspended session.","readOnly":true,"timeoutMs":20000},{"name":"sigil_xdebug_set_variable","label":"Debugger set variable","description":"Mutate a variable in the active debug session's frame (top frame by default). Uses the debugger's value modifier; debuggers that expose no modifier for the variable return an explicit unavailable error rather than failing silently.","readOnly":false,"timeoutMs":20000},{"name":"sigil_xdebug_list_breakpoints","label":"Debugger breakpoints","description":"List all breakpoints in the project: type, file, 1-based line, enabled state, and condition/log-expression when set.","readOnly":true,"timeoutMs":10000},{"name":"sigil_xdebug_set_breakpoint","label":"Set breakpoint","description":"Create or replace a line breakpoint: filePath (project-relative or absolute), 1-based line, optional condition (only breaks when true), optional logExpression (logpoint - logs instead of suspending), optional enabled flag.","readOnly":false,"timeoutMs":15000},{"name":"sigil_xdebug_remove_breakpoint","label":"Remove breakpoint","description":"Remove the line breakpoint at filePath + 1-based line (all breakpoints at that position when several exist).","readOnly":false,"timeoutMs":10000},{"name":"sigil_xdebug_run_to_line","label":"Run to line","description":"Resume the active debug session and run until the given line of the given file is reached (1-based). Requires a suspended session.","readOnly":false,"timeoutMs":15000},{"name":"sigil_git_log","label":"Git log","description":"Show the git commit history of the repository (newest first). Returns commits with hash, author, date, and subject. Optionally limit the count (default 20, max 200) and scope to a single file's history with filePath.","readOnly":true,"timeoutMs":30000},{"name":"sigil_git_diff","label":"Git diff","description":"Show a unified diff. By default the unstaged working-tree diff; set staged=true for the staged (cached) diff; set fromRev (and optionally toRev, default HEAD) for a revision-range diff. Optionally scope to one file with filePath. Returns the raw unified diff text (capped).","readOnly":true,"timeoutMs":30000},{"name":"sigil_git_blame","label":"Git blame","description":"Annotate a file line-by-line with the last commit that touched each line (hash, author, date, summary). Optionally restrict to a line range with startLine and endLine (1-based, inclusive).","readOnly":true,"timeoutMs":30000},{"name":"sigil_git_commit","label":"Git commit","description":"Stage files (when filePaths is given) and commit them with the given message in one step. With no filePaths, commits whatever is currently staged. Set amend=true to amend the previous commit. This NEVER pushes - use sigil_git_push for that.","readOnly":false,"timeoutMs":60000},{"name":"sigil_git_branch","label":"Git branch","description":"Branch operations: list branches (LIST), create a branch (CREATE), check out an existing branch (CHECKOUT), or delete a branch with -d (DELETE). name is required for CREATE/CHECKOUT/DELETE. This never pushes or force-deletes.","readOnly":false,"timeoutMs":30000},{"name":"sigil_git_push","label":"Git push","description":"Push the current branch (or a named branch) to a remote (default origin). Set setUpstream=true for a first push of a new branch. Returns the push output tail. This performs a real push to the remote.","readOnly":false,"timeoutMs":120000},{"name":"sigil_show_diff","label":"Show diff","description":"Open a two-pane diff in the IDE's diff viewer. Pass leftContent+rightContent (raw texts) or leftPath+rightPath (files on disk to compare). Presents UI in the IDE; changes no project data.","readOnly":true,"timeoutMs":15000},{"name":"sigil_list_quick_fixes","label":"List quick fixes","description":"List quick fixes and intentions available at a caret position in a project file. Opens the file in the IDE editor, places the caret at line/column (1-based; column defaults to 1), computes the file's current inspection highlights plus the registered intentions, and returns every fix available at that caret as {index, familyName, text}. Order: fixes attached to current highlights first, then registered intentions. Use the returned index with sigil_apply_quick_fix at the SAME caret position; indices are only stable for an unchanged file state. Read-only: opens an editor but never edits.","readOnly":true,"timeoutMs":60000},{"name":"sigil_apply_quick_fix","label":"Apply quick fix","description":"Apply one quick fix or intention from sigil_list_quick_fixes. Opens the file, places the caret at line/column, re-resolves the same ordered fix list, then invokes the fix chosen by fixIndex under an IDE write action (honoring whether the fix wants to start in a write action itself). fixIndex refers to the listing produced at the SAME line/column; if the file changed since listing, re-run sigil_list_quick_fixes first. Mutating: edits the file.","readOnly":false,"timeoutMs":60000},{"name":"sigil_create_run_configuration","label":"Create run configuration","description":"Create a new IDE run/debug configuration and register it in the project. configurationTypeId is a configuration type id such as Application, Gradle, Maven, JUnit, or any other id the IDE registers (unknown ids are rejected with the available list). factoryName optionally picks a concrete factory of that type, defaulting to the first. programParameters, workingDirectory and environmentVariables are applied only when the created configuration supports program parameters; otherwise they are listed under 'skipped'. environmentVariables entries use NAME=value format. Mutating: writes to the project workspace.","readOnly":false,"timeoutMs":30000},{"name":"sigil_update_run_configuration","label":"Update run configuration","description":"Update an existing IDE run configuration by exact name: rename it via newName and/or set programParameters, workingDirectory (relative paths resolve against the project root) and environmentVariables (NAME=value entries; replaces the whole env map). programParameters and friends are applied only when the configuration supports them; unsupported ones are listed under 'skipped'. Unknown names are rejected with the available list. Mutating.","readOnly":false,"timeoutMs":30000},{"name":"sigil_delete_run_configuration","label":"Delete run configuration","description":"Delete an IDE run configuration by exact name (as returned by sigil_get_run_configurations). Unknown names are rejected with the available list. Mutating.","readOnly":false,"timeoutMs":15000},{"name":"sigil_refresh_build_project","label":"Refresh build project","description":"Trigger a build-system sync for the project: a Gradle import/sync when the Gradle plugin is installed and enabled, otherwise a Maven project reload when the Maven plugin is available (Gradle wins when both exist; projects using neither report UNAVAILABLE). Returns right after the sync is started - completion is asynchronous and shows up in the IDE's build tooling. Mutating: rewrites the IDE's imported project model.","readOnly":false,"timeoutMs":120000},{"name":"sigil_list_inspections","label":"List inspections","description":"List the inspection tools of the IDE's current project inspection profile: shortName (the stable inspection id), displayName, and whether the tool is enabled in this project. Up to 300 entries; truncated=true means the cap hid more. Useful to interpret which inspections sigil_get_file_problems runs under.","readOnly":true,"timeoutMs":30000},{"name":"sigil_list_todos","label":"List TODO items","description":"List TODO-style comment items (TODO, FIXME and the other IDE todo patterns) found by the IDE's todo search. Without filePath the whole project is scanned (capped at 200, truncated=true when capped); pass filePath to list only that file. Each item is {file, line (1-based), text}. While indexing, the call reports UNAVAILABLE - retry later.","readOnly":true,"timeoutMs":30000},{"name":"sigil_execute_ide_action","label":"Execute IDE action","description":"Execute one allowlisted IDE action by id. Allowed: SaveAll (save all modified files), Synchronize (reload all files from disk), ExpandAll, CollapseAll (tree views), EditorDuplicate (duplicate line/selection), EditorDeleteLine, EditorSelectWord (extend selection), CommentByLineComment (toggle line comment), OptimizeImports. Editor actions act on the currently open editor; they report performed=false when no editor fits. The allowlist is deliberately small and stable - other ids (dialogs, VCS UI) are rejected with the allowed list. Mutating: the action may modify files or editor state.","readOnly":false,"timeoutMs":30000},{"name":"sigil_safe_delete","label":"Safe delete symbol","description":"Safe-deletes the first symbol named 'symbolName' in 'filePath' and updates all references to it (IDE Safe Delete semantics). 'deleteRelated' (optional, default false) would additionally remove related files. On this IDE build the underlying SafeDeleteProcessor cannot run without modal UI: it is a final class whose conflict dialog and the language delegates' questions (overriding methods, callees, related files) cannot be suppressed, so this tool validates the arguments, locates the symbol, then refuses with UNAVAILABLE instead of risking a hidden modal dialog. To delete: ask the user to select the symbol in the editor and run Safe Delete (Shift+Delete), or edit the file manually. Verify the symbol first with sigil_get_symbol_info.","readOnly":false,"timeoutMs":30000},{"name":"sigil_move_element","label":"Move element","description":"Moves the first symbol named 'symbolName' in 'filePath' to 'targetPackage' or 'targetDirectory' with the IDE Move refactoring. On this IDE build the Move machinery cannot run headlessly: MoveClassesOrPackagesProcessor is Java-plugin-scoped and the MoveHandler path opens modal dialogs, so this tool validates the arguments, locates the symbol, then refuses with UNAVAILABLE instead of risking a hidden modal dialog. To move: ask the user to run Refactor | Move (F6) manually, or rewrite the file with edit tools.","readOnly":false,"timeoutMs":30000},{"name":"sigil_extract_method","label":"Extract method","description":"Extracts the statements between 'startLine' and 'endLine' in 'filePath' into a new method named 'newName' (IDE Extract Method). On this IDE build the ExtractMethodHandler invoke path opens modal settings and preview dialogs that cannot be suppressed, so this tool validates the arguments, resolves the file, then refuses with UNAVAILABLE instead of risking a hidden modal dialog. Perform the extraction by editing the file directly, or ask the user to run Refactor | Extract | Method.","readOnly":false,"timeoutMs":30000},{"name":"sigil_extract_variable","label":"Extract variable","description":"Extracts the expression between 'startLine' and 'endLine' in 'filePath' into a new variable named 'newName' (IDE Introduce Variable). On this IDE build IntroduceVariableHandler opens modal settings dialogs that cannot be suppressed, so this tool validates the arguments, resolves the file, then refuses with UNAVAILABLE instead of risking a hidden modal dialog. Perform the extraction by editing the file directly, or ask the user to run Refactor | Extract | Variable.","readOnly":false,"timeoutMs":30000},{"name":"sigil_extract_field","label":"Extract field","description":"Extracts the expression between 'startLine' and 'endLine' in 'filePath' into a new field named 'newName' (IDE Introduce Field). On this IDE build IntroduceFieldHandler opens modal settings dialogs that cannot be suppressed, so this tool validates the arguments, resolves the file, then refuses with UNAVAILABLE instead of risking a hidden modal dialog. Perform the extraction by editing the file directly, or ask the user to run Refactor | Extract | Field.","readOnly":false,"timeoutMs":30000},{"name":"sigil_extract_constant","label":"Extract constant","description":"Extracts the expression between 'startLine' and 'endLine' in 'filePath' into a new constant named 'newName' (IDE Introduce Constant). On this IDE build IntroduceConstantHandler opens modal settings dialogs that cannot be suppressed, so this tool validates the arguments, resolves the file, then refuses with UNAVAILABLE instead of risking a hidden modal dialog. Perform the extraction by editing the file directly, or ask the user to run Refactor | Extract | Constant.","readOnly":false,"timeoutMs":30000},{"name":"sigil_inline_element","label":"Inline element","description":"Inlines the first symbol named 'symbolName' in 'filePath' at all of its usages (IDE Inline refactoring). On this IDE build the inline handler path opens modal option dialogs that cannot be suppressed, so this tool validates the arguments, locates the symbol, then refuses with UNAVAILABLE instead of risking a hidden modal dialog. Inline manually by editing the file, or ask the user to run Refactor | Inline.","readOnly":false,"timeoutMs":30000},{"name":"sigil_local_history_list","label":"List local history","description":"Lists Local History entries for 'filePath' (or the whole project when omitted), up to 'limit' entries (default 20). On this IDE build the public LocalHistory facade exposes label creation and byte-content reads but NO listing API (listing lives in internal implementation classes that must not be called), so this tool always refuses with UNAVAILABLE. Use the IDE Local History view instead (file context menu, Local History | Show History). Restoring file content to an earlier point is still available via sigil_local_history_revert.","readOnly":true,"timeoutMs":30000},{"name":"sigil_local_history_revert","label":"Revert local history","description":"Restores the content of 'filePath' from Local History. 'labelOrMinutes' accepts an integer string for minutes-ago semantics (for example '30' restores the file content as of 30 minutes ago); label names cannot be looked up through the public API on this IDE build and are refused with UNAVAILABLE. The revert restores FILE CONTENT only (it does not re-create deleted files or undo renames) and is written as an undoable IDE command. Refuses if the file is not under Local History control, is read-only, or has no revision at or before the requested time.","readOnly":false,"timeoutMs":30000},{"name":"sigil_unity_guid_resolve","label":"Resolve Unity GUID","description":"Resolves between Unity asset paths and their 32-hex GUIDs. With 'path', reads the sibling .meta and returns its guid; with 'guid', scans the project's *.meta files and returns the asset paths carrying that GUID. Requires a Unity project at the project root.","readOnly":true,"timeoutMs":30000},{"name":"sigil_unity_asset_references","label":"Find Unity asset references","description":"Lists the Unity YAML documents (.unity scenes, .prefab, .asset) referencing a script or asset GUID, with 1-based line hits and the trimmed source line (m_Script fileID included when present). Resolves the GUID from the sibling .meta when 'path' is given. Requires a Unity project at the project root.","readOnly":true,"timeoutMs":60000},{"name":"sigil_unreal_project_summary","label":"Summarize Unreal project","description":"Summarizes an Unreal project tree from its .uproject descriptor: EngineAssociation, game modules with their matched *.Build.cs rule files, plugin modules discovered from Plugins/**/*.uplugin, plugin names, and the *.Target.cs files. 'path' defaults to the project root.","readOnly":true,"timeoutMs":30000},{"name":"sigil_unreal_asset_summary","label":"Summarize Unreal .uasset","description":"Best-effort header summary of an Unreal .uasset package: magic check, engine version fields, package folder, and import package names read from the name map and import table. Layout variance degrades to parsed=false (only fileName/sizeBytes trustworthy) — never throws.","readOnly":true,"timeoutMs":30000}]};

// Codemode tool-discovery namespace (TDD docs/tdd/codemode-tool-discovery.md,
// 4.7.1 item 3): EVERY non-rider sigil_* tool registers under this single
// OBJECT namespace (name + description + instructions) so the codemode
// description groups the direct family under a "sigil" section and
// describeNamespace("sigil") serves the instructions. Namespace is METADATA
// ONLY - the registered name and permission keys are unchanged. Rider tools
// keep the bare-string "rider" namespace: deferred tools are filtered out of
// the codemode description, so the string form is all they need.
// ASCII-only, no template literals (raw-string embedding rules).
const SIGIL_TOOL_NAMESPACE = {
  name: "sigil",
  description: "First-party Sigil IntelliJ bridge tools: symbol/text search, call analysis, file structure, inspections, build, git, debugger, refactoring - IDE-verified first choice over shell.",
  instructions:
    "Research before edit: resolve symbols with sigil_search_symbol and sigil_search_text before changing code; " +
    "sigil_analyze_calls for blast radius. One edit per call via replace/insert; verify with sigil_get_file_problems; " +
    "batch lint with sigil_lint_files; compile gate sigil_build_project (orchestrator only). Git via sigil_git_* tools. " +
    "bash is LAST resort. Parameters: project-relative paths, 1-based lines/columns. " +
    "First use in an unfamiliar area: searchTools(topic, { namespace: sigil }) then describeTool(name) - " +
    "describeTool resolves to a STRING."
};

// StringEnum is the pi-recommended string-enum schema (Type.Union/Type.Literal
// breaks Google models). Guarded require so an unexpected pi-ai shape can never
// kill the whole extension at load time.
let StringEnum = null;
try {
  StringEnum = require("@earendil-works/pi-ai").StringEnum;
} catch (e) {
  StringEnum = null;
}

function readEnv(name) {
  try {
    if (typeof process !== "undefined" && process.env && process.env[name]) {
      return process.env[name];
    }
  } catch (e) {
    // best-effort
  }
  return "";
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function authHeaders() {
  return { "X-Sigil-Bridge-Token": BRIDGE_TOKEN, "Content-Type": "application/json" };
}

async function fetchManifest() {
  const res = await fetch(BRIDGE_URL + "/tools", { method: "GET", headers: authHeaders() });
  if (!res.ok) {
    throw new Error("manifest fetch HTTP " + res.status);
  }
  const envelope = await res.json();
  if (!envelope || envelope.ok !== true || !envelope.result) {
    throw new Error("manifest envelope missing ok/result");
  }
  const body = envelope.result;
  if (!body || typeof body.schemaVersion !== "number") {
    throw new Error("manifest missing numeric schemaVersion");
  }
  if (Math.floor(body.schemaVersion) !== SCHEMA_VERSION) {
    throw new Error(
      "manifest schemaVersion " + body.schemaVersion +
        " is incompatible with extension schemaVersion " + SCHEMA_VERSION +
        " - update the Sigil plugin and reconnect"
    );
  }
  if (!body.tools || !Array.isArray(body.tools) || body.tools.length === 0) {
    throw new Error("manifest has no tools[]");
  }
  return body;
}

// JSON-Schema-style property -> TypeBox. Supported shapes: string, enum(string),
// boolean, number/integer, array-of-strings. Everything else degrades to string.
function propToType(name, prop, required) {
  const t = prop && prop.type ? String(prop.type) : "string";
  const desc = prop && prop.description ? String(prop.description) : undefined;
  let base = null;
  if (prop && Array.isArray(prop.enum) && prop.enum.length > 0) {
    const values = prop.enum.map(String);
    base = StringEnum ? StringEnum(values) : Type.String({ description: desc });
  } else if (t === "boolean") {
    base = Type.Boolean({ description: desc });
  } else if (t === "number" || t === "integer") {
    base = Type.Number({ description: desc });
  } else if (t === "array") {
    base = Type.Array(Type.String({ description: desc }), { description: desc });
  } else {
    base = Type.String({ description: desc });
  }
  if (required.indexOf(name) >= 0) {
    return base;
  }
  return Type.Optional(base);
}

function toTypeBox(def) {
  const schema = def && def.parameters ? def.parameters : null;
  const properties = schema && schema.properties ? schema.properties : null;
  if (!properties) {
    return Type.Object({});
  }
  const required = schema.required && Array.isArray(schema.required) ? schema.required.map(String) : [];
  const props = {};
  for (const key of Object.keys(properties)) {
    props[key] = propToType(key, properties[key], required);
  }
  return Type.Object(props);
}

function resultText(result) {
  if (result === null || result === undefined) {
    return "";
  }
  if (typeof result.text === "string") {
    return result.text;
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch (e) {
    return String(result);
  }
}

async function callBridge(def, params, signal) {
  const timeoutMs = def.timeoutMs && def.timeoutMs > 0 ? def.timeoutMs : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(function () {
    timedOut = true;
    try {
      controller.abort(new Error("timeout"));
    } catch (e) {
      // best-effort
    }
  }, timeoutMs);
  const onAbort = function () {
    try {
      controller.abort(signal.reason);
    } catch (e) {
      try {
        controller.abort();
      } catch (e2) {
        // best-effort
      }
    }
  };
  if (signal) {
    if (signal.aborted) {
      return { content: [{ type: "text", text: "sigil bridge call cancelled before it started" }] };
    }
    try {
      signal.addEventListener("abort", onAbort);
    } catch (e) {
      // best-effort
    }
  }
  try {
    const res = await fetch(BRIDGE_URL + "/tool/" + def.name, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ arguments: params === undefined ? {} : params }),
      signal: controller.signal,
    });
    let body = null;
    try {
      body = await res.json();
    } catch (e) {
      body = null;
    }
    if (body && body.ok === true) {
      return { content: [{ type: "text", text: resultText(body.result) }] };
    }
    const code = body && body.error && body.error.code ? String(body.error.code) : "HTTP_" + res.status;
    const message =
      body && body.error && body.error.message ? String(body.error.message) : "no error body (HTTP " + res.status + ")";
    return { content: [{ type: "text", text: "sigil bridge error (" + code + "): " + message }] };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    const kind = timedOut ? "timed out after " + timeoutMs + "ms" : "unavailable";
    return { content: [{ type: "text", text: "sigil bridge " + kind + ": " + msg }] };
  } finally {
    clearTimeout(timer);
    if (signal) {
      try {
        signal.removeEventListener("abort", onAbort);
      } catch (e) {
        // best-effort
      }
    }
  }
}

// pi 0.99.0+ supports registration-option "exposure" ("direct"|"model-only"|
// "codemode"|"deferred"|"hidden" - "model-only" is extension-only) and
// "namespace" on registerTool. Codemode tool-discovery namespace mapping (TDD
// docs/tdd/codemode-tool-discovery.md 4.7.1 item 3; the pi-1.0.0-upgrade G8/D4
// rider mapping is preserved verbatim) - ALL filter/namespace decisions live
// in this pure function:
//   - ONLY the RD-gated sigil_rider_* family (the 6 Rider bridge tools:
//     find_usages, solution_summary, unreal_state, unreal_assets, unity_state,
//     inspect) rides exposure "deferred" under namespace "rider" (BARE STRING
//     namespace - deferred tools are filtered out of the codemode
//     description, so the string form is all they need).
//   - EVERY other sigil_* tool rides the SIGIL_TOOL_NAMESPACE OBJECT form
//     (name + description + instructions: the codemode description groups
//     these direct tools under a "sigil" section printing the description,
//     and describeNamespace("sigil") serves the instructions) with NO
//     exposure key - the pi DEFAULT exposure (direct) applies to the
//     registration and no explicit "direct" string is written.
//   - Namespace is METADATA ONLY: the registered name (def.name), the wire
//     calls (/tool/<def.name>) and the permission keys are unchanged.
// Catalog COUNTS are untouched (metadata only; FamilyGatingTest 69/72/66/75
// continue to hold; BridgeToolCatalog is deliberately not touched).
function registrationOptionsFor(toolName) {
  if (typeof toolName === "string" && toolName.indexOf("sigil_rider_") === 0) {
    return { exposure: "deferred", namespace: "rider" };
  }
  return { namespace: SIGIL_TOOL_NAMESPACE };
}

export default async function (pi) {
  if (!BRIDGE_URL) {
    console.log("[sigil-ide-tools] SIGIL_BRIDGE_URL not set (pi not launched by Sigil, or plugin predates the IDE tool bridge) - registering no sigil_* tools");
    return;
  }
  let catalog = null;
  for (let attempt = 0; attempt < MANIFEST_RETRIES && catalog === null; attempt++) {
    try {
      catalog = await fetchManifest();
    } catch (e) {
      if (attempt === 0) {
        console.warn("[sigil-ide-tools] manifest fetch failed (" + (e && e.message ? e.message : String(e)) + "); retrying");
      }
      await sleep(MANIFEST_RETRY_DELAY_MS);
    }
  }
  const usingFallback = catalog === null;
  if (usingFallback) {
    catalog = EMBEDDED_FALLBACK;
    console.warn(
      "[sigil-ide-tools] bridge manifest unavailable after retries - using embedded fallback catalog (compact schemas; calls still proxied live)"
    );
  }
  const tools = Array.isArray(catalog.tools) ? catalog.tools : [];
  let registered = 0;
  for (const def of tools) {
    if (!def || typeof def.name !== "string" || def.name.length === 0) {
      continue;
    }
    const toolOptions = registrationOptionsFor(def.name);
    const toolDef = {
      name: def.name,
      label: typeof def.label === "string" && def.label ? def.label : def.name,
      description: typeof def.description === "string" ? def.description : "Sigil IDE tool.",
      parameters: toTypeBox(def),
      execute: async function (toolCallId, params, signal, onUpdate, ctx) {
        return callBridge(def, params, signal);
      },
    };
    // Real line structure (AGENTS 2026-09-21 rule): the deferred options are
    // assigned as their own statements - a multi-line inserted block with a
    // leading "// comment" must never swallow a brace.
    if (toolOptions !== null) {
      if (toolOptions.exposure) {
        toolDef.exposure = toolOptions.exposure;
      }
      toolDef.namespace = toolOptions.namespace;
    }
    pi.registerTool(toolDef);
    registered++;
  }
  console.log(
    "[sigil-ide-tools] registered " + registered + " tool(s)" +
      (usingFallback ? " (FALLBACK - bridge manifest unavailable)" : " from bridge manifest " + BRIDGE_URL)
  );
}
