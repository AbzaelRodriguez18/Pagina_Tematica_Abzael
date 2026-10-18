// Sigil Tasks - plugin-managed Pi extension (overwritten on each Sigil connect).
//
// Owns two surfaces end-to-end for the Sigil IDE plugin:
//  1. Session task tree (root tasks + one subtask level), persisted as Pi
//     CustomEntry records so fork/resume/restart semantics come free.
//  2. First-party agent delegation: children run IN-PROCESS via the pi SDK
//     (createAgentSession), stream their work live through the delegation
//     tool's onUpdate channel (burst-coalesced, never gated on completion),
//     run with user-denied tools absent (createAgentSession excludeTools +
//     a registration-filter backstop; deny set read from the project
//     permission config the plugin bridges), fire session_start via
//     session.bindExtensions({}) so the permission extension composes the
//     PROJECT config scope (deny backstop + review-log audit), and ask the
//     user for mutation permissions through the parent session's ctx.ui
//     dialogs (deny is the relay-failure fallback).
//
// Wire contract (pinned by plugin fixtures in harness/pi/PiTask*Detector.kt):
//  - Task snapshot  : tool result details
//      { kind: "sigil_tasks", version, revision, boot, error, tasks[] }
//  - Child delta    : onUpdate details
//      { kind: "sigil_task_delta", version, runId, taskId, agent,
//        childSessionId, event, messageId?, text?, toolCallId?, toolName?,
//        argsJson?, resultJson?, isError?, ts }
//  - Durable record : pi.appendEntry("sigil_tasks",
//      { version, revision, boot, tasks[] })  // task objects may carry deleted:true
//  - Task mutations : DEFERRED to pi 0.87.0's actionable turn_end boundary -
//      the task tools mark the snapshot dirty (markTasksDirty) and the
//      boundary commits ONE deduped record per turn (draft appended after
//      the turn's entries, continue:false, gated on the snapshotKey dedup
//      key refreshed on every actual write). Child-session event records
//      keep their immediate writes (persistNow).
//  - Restore        : session_start scans ctx.sessionManager.getEntries()
//    (file order) for the LAST custom entry with customType "sigil_tasks"
//    and restores tree, revision, and the budget counter. Pi re-instantiates
//    extensions per session; without this the revision resets and the
//    plugin's floor rejects all subsequent snapshots.
//
// NOTE: no template literals (Kotlin raw-string embedding) and no non-ASCII
// source characters (2.x encoding normalization).

import {
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
  createCodemodeExtension,
  createToolSearchExtension,
  getAgentDir,
  createReadToolDefinition,
  createBashToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  createGrepToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const TASKS_CUSTOM_TYPE = "sigil_tasks";
const SNAPSHOT_KIND = "sigil_tasks";
const DELTA_KIND = "sigil_task_delta";
const RECORD_VERSION = 1;

const MAX_TASKS = 200;
const DELTA_COALESCE_MS = 150;
const STATUS_LINE_CAP = 120;
const PREVIEW_CAP = 200;
const PERMISSION_TIMEOUT_MS = 180000;

const STATUSES = ["pending", "in_progress", "completed"];
const PRIORITIES = ["low", "medium", "high"];

const TOOL_FACTORIES = {
  read: createReadToolDefinition,
  bash: createBashToolDefinition,
  edit: createEditToolDefinition,
  write: createWriteToolDefinition,
  grep: createGrepToolDefinition,
  find: createFindToolDefinition,
  ls: createLsToolDefinition,
  powershell: createPowerShellToolDefinition,
};
const READONLY_TOOL_NAMES = ["read", "grep", "find", "ls"];
const CODING_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const MUTATION_TOOL_NAMES = { bash: true, edit: true, write: true, powershell: true };
// Single-gate deny/ask contract (TDD builtin-tool-permission-enforcement 4.7.1.B):
// user-denied tools NEVER reach registration - they are dropped upstream via
// createAgentSession({ excludeTools }) (pi drops excluded names from BOTH the
// builtin base registry and custom/extension tools) and filtered out of every
// tool set before the customTools build. wrapMutationTool is therefore ASK-ONLY:
// it relays the agent's mutationPolicy="ask" gate to the parent's dialogs and
// never implements deny (a denied tool is never wrapped), and no tool is ever
// prompted twice.

const TASK_GUIDELINES = [
  "Mark a task in_progress BEFORE starting work on it; keep exactly one task in_progress at a time.",
  "Never batch completions: mark each task completed immediately when its work is done.",
  "Use subtasks (parentId on task_create) for delegable units; assign an agent to any task you intend to delegate.",
  "At most Settings > Tools > Sigil > Agents (Max subtasks) delegated child sessions may run LIVE at the same time; task creation is unlimited - the cap is CONCURRENT runs, not total creations.",
        "When task_delegate returns LIMIT_REACHED (the Max subtasks setting caps CONCURRENT delegated sub-sessions - creation is unlimited), continue hands-on without delegating, or finish/stop a live child first; never work around the cap.",
];

const DELEGATION_GUIDELINES = [
  "Delegate ONE task per task_delegate call; emit parallel delegations in a single response for fan-out.",
  "Children cannot be steered mid-run: include every needed fact, file path, and constraint in instructions.",
  "The user approves each child mutation (write/edit/bash) through a permission dialog; denied actions are reported back by the child.",
  "At most Settings > Tools > Sigil > Agents (Max subtasks) delegated child sessions may run LIVE at the same time; fan out parallel delegations in one response up to the cap - creation is unlimited.",
        "When task_delegate returns LIMIT_REACHED (the Max subtasks setting caps CONCURRENT delegated sub-sessions - creation is unlimited), continue hands-on without delegating, or finish/stop a live child first; never work around the cap.",
];

function newToken(len) {
  let s = Math.random().toString(16).slice(2);
  while (s.length < len) s += Math.random().toString(16).slice(2);
  return s.slice(0, len);
}

function msg(e) {
  if (e && e.message) return String(e.message);
  return String(e);
}

function head(s, n) {
  const t = String(s);
  if (t.length <= n) return t;
  if (n <= 3) return t.slice(0, n);
  return t.slice(0, n - 3) + "...";
}

function compactJson(v, cap) {
  try {
    if (v === undefined || v === null) return "";
    const s = JSON.stringify(v);
    return s ? head(s, cap || PREVIEW_CAP) : "";
  } catch (e) {
    return "";
  }
}

function compactResult(result, cap) {
  try {
    if (!result) return "";
    if (typeof result === "string") return head(result, cap || PREVIEW_CAP);
    const content = result.content;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c && c.type === "text" && c.text) return head(c.text, cap || PREVIEW_CAP);
      }
    }
    return "";
  } catch (e) {
    return "";
  }
}

function parseModelRef(ref) {
  if (typeof ref !== "string") return null;
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash >= ref.length - 1) return null;
  return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

// Resolve the user's GLOBALLY-installed pi packages (from ~/.pi/agent/settings.json
// "packages") as loader extension paths. Children must inherit the global
// environment - provider registrations like pi-ollama-cloud live there - while
// loading ZERO discovered extensions: noExtensions:true keeps every project
// extension (incl. sigil-tasks itself, so children can never recurse) out of
// the child, and additionalExtensionPaths re-adds these global packages PLUS
// the two project paths from childProjectExtensionPaths (the sigil-ide-tools
// bridge extension + the pinned permission package, TDD 4.7.4).
function globalPackageSources() {
  const out = [];
  try {
    const raw = readFileSync(join(getAgentDir(), "settings.json"), "utf8");
    const parsed = JSON.parse(raw);
    const list = parsed && Array.isArray(parsed.packages) ? parsed.packages : [];
    for (const entry of list) {
      const source = typeof entry === "string" ? entry : (entry && entry.source);
      if (typeof source !== "string" || !source) continue;
      if (source.startsWith("npm:")) {
        const spec = source.slice(4);
        const at = spec.lastIndexOf("@");
        const pkgName = at > 0 ? spec.slice(0, at) : spec;
        if (!pkgName) continue;
        const dir = join(getAgentDir(), "npm", "node_modules", pkgName);
        if (existsSync(dir)) out.push(dir);
      } else {
        out.push(source);
      }
    }
  } catch (e) {
    // No/unreadable global settings -> no extra packages; children still run
    // with builtin providers.
  }
  return out;
}

// Child-session PROJECT extension paths (TDD agent-personas-tooling-refresh
// 4.7.4 - delegated children run IDE tools). Exactly TWO additions on top of
// the global packages:
//  - sigil-ide-tools.ts: the first-party bridge extension the MAIN session
//    auto-discovers (same file, written per connect by the plugin). Children
//    share SIGIL_BRIDGE_URL / SIGIL_BRIDGE_TOKEN via the in-process
//    environment, so bridge registration and dispatch work unchanged.
//  - the pinned permission package dir @gotgenes/pi-permission-system under
//    .pi/npm/node_modules - the loadable extension CODE (package.json
//    "pi.extensions" manifest). NOT .pi/extensions/pi-permission-system/:
//    that directory is config-only (config.json written by the plugin).
// Invariants: sigil-tasks.ts and sigil-persona.ts must NEVER appear in child
// extension paths (children cannot delegate - no task_* tools - and never get
// a persona file re-appended); the GLOBAL-packages behavior is unchanged
// (globalPackageSources stays first in the concatenated list); the codemode
// tool extensions ride options.extensionFactories, NOT this path list (see
// childCodemodeFactories above - gated on codemodeIncludeChildren).
const CHILD_IDE_TOOLS_EXTENSION_PATH = ".pi/extensions/sigil-ide-tools.ts";
const CHILD_PERMISSION_PACKAGE_PATH = ".pi/npm/node_modules/@gotgenes/pi-permission-system";

// Codemode child wiring (2026-10-03 FULL FIX replacing the pi-1.0.0-upgrade
// chunks 4+6 "builtin:<name>" resource-id approach): children whose agents
// registry carries codemodeIncludeChildren !== false (absent = the D3
// adoption default true) load pi's codemode + tool_search tool extensions as
// NAMED INLINE extension factories. The old resource-id-only approach was
// WRONG for SDK sessions: the loader resolves "builtin:<name>" paths against
// its OWN builtinExtensions map, which is populated ONLY from
// options.extensionFactories (default []) - unknown ids never throw, they
// land in the load result's error entries and NO tool ever registers (the
// tools sat inert in every child; the catch-around-reload fallback was dead
// code for the same reason). The verified pi SDK recipe is
// examples/sdk/14-codemode-mcp.ts: factories in the loader + explicit
// post-bind activation (setActiveToolsByName AFTER bindExtensions, second
// layer at the delegation site below). The factories are NAMED
// ({ name, factory }) so load-error paths carry "<inline:codemode>"-style
// tags and are attributable in the post-reload check; replaceable mirrors
// the CLI's own builtin registry (dist/extensions/index.js: { name, factory,
// replaceable:true, builtin:true }). Optionless createCodemodeExtension()
// means the child INHERITS the project .pi/settings.json codemode.mode (a
// per-call settings getter; "only" hides the child's declared tools behind
// scripts BY INTENT - that is the project CodemodeSettingsBridge setting,
// not a factory option) - createMcpExtension is NOT loaded in children (the
// mcp client is a main-session surface). The TOOL names stay underscored
// ("codemode"/"tool_search") while the inline extension names keep the CLI's
// registry form ("codemode"/"tool-search").
const CHILD_CODEMODE_EXTENSIONS = [
  { name: "codemode", factory: createCodemodeExtension(), replaceable: true },
  { name: "tool-search", factory: createToolSearchExtension(), replaceable: true },
];

function codemodeIncludeChildrenEnabled(cwd) {
  try {
    const raw = readFileSync(join(cwd, ".pi", "sigil-agents.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed.codemodeIncludeChildren !== false;
  } catch (e) {
    // Absent/unreadable config -> the D3 adoption default (include children).
    return true;
  }
}

function childCodemodeFactories(cwd) {
  if (!codemodeIncludeChildrenEnabled(cwd)) return [];
  return CHILD_CODEMODE_EXTENSIONS;
}

function childProjectExtensionPaths(cwd) {
  const out = [];
  const ideTools = join(cwd, CHILD_IDE_TOOLS_EXTENSION_PATH);
  if (existsSync(ideTools)) out.push(ideTools);
  const permPkg = join(cwd, CHILD_PERMISSION_PACKAGE_PATH);
  if (existsSync(permPkg)) out.push(permPkg);
  return out;
}

// Deny-set source for child sessions (TDD builtin-tool-permission-enforcement
// 4.3 extension-side contract). The rendered extension runs inside pi and
// cannot reach the plugin's Kotlin PiToolPolicy, so the deny set is derived
// from the SAME artifact the permission extension itself consumes: the project
// permission config at .pi/extensions/pi-permission-system/config.json,
// written per connect (and on every settings Apply) by PiSettingsBridge. Any
// permission-map entry with the literal value "deny" is a denied tool name.
// The file is absent or malformed outside Sigil-managed projects -> EMPTY deny
// set (never throw; delegation must keep working). The plugin-side bridge owns
// the enabled=false -> deny mapping; this reader trusts the written file.
function deniedToolNames(cwd) {
  try {
    const raw = readFileSync(
      join(cwd, ".pi", "extensions", "pi-permission-system", "config.json"),
      "utf8"
    );
    const parsed = JSON.parse(raw);
    const permission =
      parsed && typeof parsed.permission === "object" && parsed.permission !== null
        ? parsed.permission
        : null;
    if (!permission) return [];
    const denied = [];
    for (const name of Object.keys(permission)) {
      if (permission[name] === "deny") denied.push(name);
    }
    denied.sort();
    return denied;
  } catch (e) {
    // Absent/unreadable/malformed config -> no registry-level exclusion;
    // the composed permission extension scope remains the backstop.
    return [];
  }
}


export default function (pi) {
  let revision = 0;
  const boot = newToken(6);
  let tasks = new Map(); // taskId -> task record (tombstones kept one revision cycle)
  const runs = new Map(); // runId -> { runId, taskId, agent, session, allowedTools, detached } (in-memory only - never serialized; detached marks the async completion path, docs/tdd/async-subsessions.md)
  let agents = new Map(); // agent name -> { name, model, thinkingVariant, toolPolicy, mutationPolicy, persona }
  // Max concurrent runs (2026-10-04 user-directed redefinition of the
  // 2026-10-03 hard-total budget): subtaskLimit is the MAX number of
  // delegated sub-session runs a session may have LIVE at the same time.
  // Task creation is UNBOUNDED - only task_delegate gates on the live-run
  // count. The product default 5 (AgentSettingsState.DEFAULT_MAX_SUBTASKS -
  // a failed config load must not silently raise the cap), set by
  // loadAgents at session_start and re-read live per gate call by
  // currentSubtaskLimit.
  let subtaskLimit = 5;
  const sessionAllowed = new Set(); // "agent:tool" keys granted via "Allow for this session" (session-scoped)
  let tombstonesPendingPurge = false;
  // pi 0.87.0 actionable turn_end boundary (TDD pi-0.87.1-upgrade A2): task
  // mutations DEFER their durable write to the boundary - the task tools only
  // mark the in-memory snapshot dirty and ONE deduped record is committed per
  // turn. The dedup key is a stable serialization of the exact object appended
  // as the record data and is refreshed on EVERY actual write (boundary-draft
  // commits AND child immediate writes), so a record is only issued when the
  // payload actually differs from the last durable record.
  let taskStateDirty = false; // task mutations awaiting the turn_end boundary
  let lastPersistedKey = null; // key of the last record actually appended (null = nothing persisted yet)

  const liveCount = () => {
    let n = 0;
    for (const t of tasks.values()) if (!t.deleted) n++;
    return n;
  };

  const liveRunCount = () => runs.size;

  const taskWire = (t, keepDeleted) => {
    const w = {
      id: t.id,
      parentId: t.parentId || null,
      subject: t.subject,
      description: t.description || null,
      status: t.status,
      priority: t.priority,
      activeForm: t.activeForm || null,
      agent: t.agent || null,
      run: t.run ? { ...t.run } : null,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
    if (keepDeleted && t.deleted) w.deleted = true;
    return w;
  };

  const liveTasksSorted = () => {
    const roots = [];
    const byParent = new Map();
    for (const t of tasks.values()) {
      if (t.deleted) continue;
      const parentLive = t.parentId && tasks.has(t.parentId) && !tasks.get(t.parentId).deleted;
      if (parentLive) {
        let list = byParent.get(t.parentId);
        if (!list) {
          list = [];
          byParent.set(t.parentId, list);
        }
        list.push(t);
      } else {
        roots.push(t);
      }
    }
    roots.sort((a, b) => a.createdAt - b.createdAt);
    const out = [];
    for (const root of roots) {
      out.push(taskWire(root, false));
      const children = byParent.get(root.id);
      if (children && children.length) {
        children.sort((a, b) => a.createdAt - b.createdAt);
        for (const child of children) out.push(taskWire(child, false));
      }
    }
    return out;
  };

  const snapshotDetails = (error) => ({
    kind: SNAPSHOT_KIND,
    version: RECORD_VERSION,
    revision: revision,
    boot: boot,
    error: error || null,
    tasks: liveTasksSorted(),
  });

  // Tombstone purge: task_delete keeps the deleted:true marker in the map for
  // ONE record cycle (the deletion marker must reach at least one durable
  // record; the reader filters tombstones) and the next record build drops it.
  // Runs before every record build (persistNow and the turn_end boundary).
  const purgeTombstones = () => {
    if (!tombstonesPendingPurge) return;
    for (const id of Array.from(tasks.keys())) {
      if (tasks.get(id).deleted) tasks.delete(id);
    }
    tombstonesPendingPurge = false;
  };

  // Durable record from the current state (PURE - no side effects; callers
  // purge tombstones explicitly before building). Payload: { version,
  // revision, boot, tasks[] } with task objects possibly carrying
  // deleted:true. (The 2026-10-03 durable total-creation counter was
  // removed with the 2026-10-04 concurrency redefinition: only the live-run
  // count is capped, nothing is totalled.)
  const buildRecord = () => {
    const recordTasks = [];
    for (const t of tasks.values()) recordTasks.push(taskWire(t, true));
    let hasTombstone = false;
    for (const t of recordTasks) if (t.deleted) hasTombstone = true;
    return {
      record: {
        version: RECORD_VERSION,
        revision: revision,
        boot: boot,
        tasks: recordTasks,
      },
      hasTombstone: hasTombstone,
    };
  };

  // Stable dedup key for the tree payload: JSON.stringify of the exact object
  // appended as the record data. Deterministic because every object literal is
  // built with a fixed key order (taskWire, run records, the record itself)
  // and the task Map iterates in insertion order (restore rehydrates in file
  // order). PURE - buildRecord has no side effects, so this is safe to call
  // for the dedup gate without committing a write.
  const snapshotKey = () => JSON.stringify(buildRecord().record);

  // IMMEDIATE durable write: child-session event records (spawn-fail,
  // run-start, completion, abort) keep their per-event writes. Refreshes the
  // dedup key so the turn_end boundary does not re-write the same payload.
  const persistNow = () => {
    purgeTombstones();
    const built = buildRecord();
    pi.appendEntry(TASKS_CUSTOM_TYPE, built.record);
    if (built.hasTombstone) tombstonesPendingPurge = true;
    lastPersistedKey = JSON.stringify(built.record);
    taskStateDirty = false;
  };

  // Task-mutation persistence (task_create/task_update/task_delete): only
  // marks the in-memory snapshot dirty - the turn_end boundary below commits
  // ONE deduped snapshot per turn (no per-mutation JSONL records).
  const markTasksDirty = () => {
    taskStateDirty = true;
  };

  const taskError = (code, text) => ({
    content: [{ type: "text", text: "task error (" + code + "): " + text }],
    details: snapshotDetails(code),
  });

  const textResult = (text) => ({
    content: [{ type: "text", text: text }],
    details: snapshotDetails(),
  });

  const canTransition = (from, to) => {
    if (from === to) return true;
    if (from === "pending" && to === "in_progress") return true;
    if (from === "in_progress" && to === "completed") return true;
    if (from === "in_progress" && to === "pending") return true;
    if (from === "completed" && to === "in_progress") return true;
    return false; // completed -> pending is disallowed: delete and recreate
  };

  const newTaskId = () => {
    let id;
    do {
      id = "task_" + newToken(8);
    } while (tasks.has(id));
    return id;
  };

  const newRunId = () => {
    let id;
    do {
      id = "run_" + newToken(8);
    } while (runs.has(id));
    return id;
  };

  const loadAgents = (cwd) => {
    const out = new Map();
    try {
      const raw = readFileSync(join(cwd, ".pi", "sigil-agents.json"), "utf8");
      const parsed = JSON.parse(raw);
      // Max concurrent runs read (2026-10-04 user-directed redefinition of
      // the 2026-10-03 hard-total budget): optional top-level maxTasks
      // INTEGER from the plugin-written agent registry = the MAX number of
      // delegated child sessions running LIVE at the same time. Absent,
      // non-number, non-integer or < 1 -> keep the session default 5;
      // hand-edited sanity cap at MAX_TASKS.
      // currentSubtaskLimit mirrors this exact rule per gate call.
      if (typeof parsed.maxTasks === "number" && Number.isInteger(parsed.maxTasks) && parsed.maxTasks >= 1) {
        subtaskLimit = Math.min(parsed.maxTasks, MAX_TASKS);
      }
      const list = parsed && Array.isArray(parsed.agents) ? parsed.agents : [];
      for (const a of list) {
        if (!a || typeof a.name !== "string" || !a.name) continue;
        out.set(a.name, {
          name: a.name,
          model: typeof a.model === "string" && a.model ? a.model : null,
          // Optional thinking-effort variant (sigil-agents.json v1 additive
          // field, TDD 4.7.5): null when absent -> the child keeps today's
          // thinking-level behavior.
          thinkingVariant:
            typeof a.thinkingVariant === "string" && a.thinkingVariant ? a.thinkingVariant : null,
          toolPolicy: Array.isArray(a.toolPolicy)
            ? a.toolPolicy.filter((n) => typeof n === "string")
            : a.toolPolicy === "coding"
              ? "coding"
              : "readonly",
          mutationPolicy: a.mutationPolicy === "allow" ? "allow" : "ask",
          persona: typeof a.persona === "string" && a.persona ? a.persona : null,
        });
      }
    } catch (e) {
      // Missing or unreadable agent config -> no agents; delegation reports
      // AGENT_NOT_FOUND and every other tool keeps working.
    }
    return out;
  };

  // LIVE subtask cap (2026-10-03 settings-hard-rule): the two budget gates
  // (task_create + task_delegate) resolve the cap per call by re-reading the
  // project .pi/sigil-agents.json, so mid-session settings changes apply at
  // the NEXT gate call without reconnect. statSync mtime cache: stat on
  // every call, re-read and re-parse ONLY when the mtime moved. Validity
  // rules mirror loadAgents exactly (maxTasks must be an integer >= 1 and is
  // clamped to MAX_TASKS); any read/parse failure keeps the last-known value
  // (loadAgents' session_start value or a prior successful read), so the
  // cap can never silently rise while the config is temporarily unreadable.
  let agentsFileMtimeMs = -1;
  const currentSubtaskLimit = (cwd) => {
    const file = join(cwd, ".pi", "sigil-agents.json");
    try {
      const st = statSync(file);
      if (st.mtimeMs !== agentsFileMtimeMs) {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        if (typeof parsed.maxTasks === "number" && Number.isInteger(parsed.maxTasks) && parsed.maxTasks >= 1) {
          subtaskLimit = Math.min(parsed.maxTasks, MAX_TASKS);
        }
        agentsFileMtimeMs = st.mtimeMs;
      }
    } catch (e) {
      // Absent/unreadable/malformed config -> keep the last-known cap.
    }
    return subtaskLimit;
  };

  const statusLine = (delta) => {
    let what = delta.event || "";
    if (delta.event === "text_delta" && delta.text) what = "writing: " + head(delta.text, 60);
    else if (delta.event === "thinking_delta" && delta.text) what = "thinking: " + head(delta.text, 60);
    else if (delta.event === "tool_execution_start") {
      what = "tool: " + (delta.toolName || "?") + (delta.argsJson ? " " + head(delta.argsJson, 50) : "");
    } else if (delta.event === "tool_execution_end") {
      what = "tool done: " + (delta.toolName || "?") + (delta.isError ? " (error)" : "");
    } else if (delta.event === "run_error") {
      what = "error: " + head(delta.text || "", 80);
    }
    return head("[" + delta.agent + "] " + what, STATUS_LINE_CAP);
  };

  // Async detached-delegation settings (docs/tdd/async-subsessions.md
  // 4.7.2-A/G): the two top-level boolean keys the plugin bridges into
  // .pi/sigil-agents.json, re-read with the SAME statSync mtime-cache pattern
  // as currentSubtaskLimit. Defaults are the forward-compatible
  // "enabled"/"force-turn" pair (mirror AgentSettingsState); an absent,
  // unreadable or malformed config keeps the last-known values. The reads run
  // AT the gate/injection sites (per delegation / per completion) so mid-session
  // Settings changes apply without reconnect.
  let allowAsyncDelegation = true;
  let asyncInjectionForcesTurn = true;
  let asyncFlagsFileMtimeMs = -1;
  const readAsyncDelegationFlags = (cwd) => {
    const file = join(cwd, ".pi", "sigil-agents.json");
    try {
      const st = statSync(file);
      if (st.mtimeMs !== asyncFlagsFileMtimeMs) {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        if (typeof parsed.allowAsyncDelegation === "boolean") {
          allowAsyncDelegation = parsed.allowAsyncDelegation;
        }
        if (typeof parsed.asyncInjectionForcesTurn === "boolean") {
          asyncInjectionForcesTurn = parsed.asyncInjectionForcesTurn;
        }
        asyncFlagsFileMtimeMs = st.mtimeMs;
      }
    } catch (e) {
      // Absent/unreadable/malformed config -> keep the last-known flags.
    }
  };
  const asyncDelegationEnabled = (cwd) => {
    readAsyncDelegationFlags(cwd);
    return allowAsyncDelegation;
  };
  const injectionForcesTurn = (cwd) => {
    readAsyncDelegationFlags(cwd);
    return asyncInjectionForcesTurn;
  };

  // Result-injection text (4.7.2-A.4). INJECT_HEADER is the cross-chunk
  // contract with the plugin side (ChatModels.kt pins the matching
  // SUBTASK_RESULT_MARKER Kotlin constant plus the isSubtaskResultCandidate
  // matcher) and is deliberately DISTINCT from the auto-resume prompt text
  // ("continue").
  const INJECT_HEADER = "[SIGIL SUBTASK RESULT]";
  const SUBTASK_RESULT_CLOSING_TEXT =
    "Incorporate the subtask result(s) above and continue the main work where it left off; do not restate the user's request.";
  const SUBTASK_RESULT_LINE_CAP = 800;
  const TASK_RESULT_SUMMARY_CAP = 2000;

  const injectResultLine = (run) => {
    let text = "";
    if (run.state === "failed" && run.error && run.error !== "stopped") {
      text = run.error;
    } else {
      text = run.result || run.error || "";
    }
    if (!text) text = "(no result text)";
    return head(text.replace(/\s+/g, " ").trim(), SUBTASK_RESULT_LINE_CAP);
  };

  const buildSubtaskResultInjection = (t, run) => {
    const subject = String(t.subject || "").replace(/\s+/g, " ").trim() || "(untitled)";
    const statusWord = run.error === "stopped" ? "STOPPED" : run.state === "done" ? "DONE" : "FAILED";
    return (
      INJECT_HEADER +
      " " +
      (run.agent || t.agent || "general-purpose") +
      ": \"" +
      subject +
      "\" (" +
      t.id +
      ") - " +
      statusWord +
      "\n" +
      "Result: " +
      injectResultLine(run) +
      "\n" +
      SUBTASK_RESULT_CLOSING_TEXT
    );
  };

  // Injection delivery (OQ-INJECT / 4.7.2-G, both paths shipped behind the
  // asyncInjectionForcesTurn setting): ON (default) -> pi.sendUserMessage(
  // injectText, { deliverAs: "followUp" }) - a FORCED turn (queued by pi while
  // the parent streams, drained at settle; starts immediately when idle);
  // OFF -> the absorb path pi.sendMessage with deliverAs nextTurn and
  // triggerTurn false - the result lands in context without forcing a turn.
  // sendUserMessage lives on the pi ExtensionAPI (NOT ctx) and returns void -
  // guarded with try/catch (never an await-based wrapper): an injection
  // failure must never lose run state, the task_result tool and the durable
  // records still carry it.
  const injectSubtaskResult = (ctx, t, run) => {
    const injectText = buildSubtaskResultInjection(t, run);
    try {
      if (injectionForcesTurn(ctx.cwd)) {
        pi.sendUserMessage(injectText, { deliverAs: "followUp" });
      } else {
        pi.sendMessage({
          customType: "sigil_subtask_result",
          content: injectText,
          display: true,
          deliverAs: "nextTurn",
          triggerTurn: false,
        });
      }
    } catch (e) {
      console.warn("[sigil-tasks] subtask result injection failed (run state preserved): " + msg(e));
    }
  };

  // Live-run activity (task_result's last-activity read): sendDelta stores
  // every coalesced activity line per runId (works for detached runs too -
  // the child listener is alive until finalize/stop/dispose); in-memory only.
  const runActivity = new Map();

  const findLiveRunByTask = (taskId) => {
    for (const registered of runs.values()) {
      if (registered.taskId === taskId) return registered;
    }
    return null;
  };

  // Shared stop path (4.7.2-B): capture any partial child text, abort +
  // dispose the live child, finalize the record as failed("stopped") (a
  // stopped run FREES its concurrency slot - re-delegating a stopped task
  // stays allowed; NOT_DELEGATABLE applies only while a run is RUNNING),
  // persist immediately (JSONL readers stay honest), then inject the STOPPED
  // result (4.7.2-A.4) so the parent learns of the stop. Teardown is
  // best-effort; the record write must happen even when abort/dispose throw.
  const stopLiveRun = (ctx, liveEntry) => {
    let partial = null;
    try {
      partial = liveEntry.session.getLastAssistantText() || null;
    } catch (e) {
      partial = null;
    }
    try {
      liveEntry.session.abort();
    } catch (e) {
      // best-effort
    }
    try {
      liveEntry.session.dispose();
    } catch (e) {
      // best-effort
    }
    runs.delete(liveEntry.runId);
    runActivity.delete(liveEntry.runId);
    const t = tasks.get(liveEntry.taskId);
    if (!t) {
      return "Stopped run " + liveEntry.runId + " (agent " + liveEntry.agent + "); task record already gone.";
    }
    const endedAt = Date.now();
    t.run = {
      runId: liveEntry.runId,
      agent: liveEntry.agent,
      childSessionId: t.run && t.run.childSessionId ? t.run.childSessionId : null,
      state: "failed",
      startedAt: t.run && t.run.startedAt ? t.run.startedAt : endedAt,
      endedAt: endedAt,
      error: "stopped",
      result: partial,
    };
    t.updatedAt = endedAt;
    revision++;
    persistNow();
    injectSubtaskResult(ctx, t, t.run);
    return "Stopped run " + liveEntry.runId + " (task " + t.id + ", agent " + liveEntry.agent + ").";
  };

  const formatElapsed = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m " + (s % 60) + "s";
    return Math.floor(m / 60) + "h " + (m % 60) + "m";
  };

  // Mutation gate around child mutation tools (TDD §4.3.5, single-gate per
  // builtin-tool-permission-enforcement 4). DENY is handled upstream: denied
  // tools are excluded via createAgentSession({ excludeTools }) and filtered
  // from registration, so a denied definition never reaches this wrapper.
  // The composed permission extension (project scope via bindExtensions) is
  // the authoritative second opinion for its own rules. Remaining behavior is
  // governed by the run's mutationPolicy:
  //  - "allow": execute directly - trusted mutation agents (coder/tester) get
  //    frictionless parallel fan-out with zero prompt friction.
  //  - "ask": relay to the PARENT session's dialog path (extension_ui_request ->
  //    Sigil's dialogs). The dialog offers Allow once / Allow for this session /
  //    Deny; "Allow for this session" scopes the grant to (session x agent x tool)
  //    so a parallel fan-out does not produce one dialog per run. Relay
  //    timeout/failure falls back to deny. Readonly tools never reach this wrapper.
  // No double prompting: the child extension instance has no UI context (the
  // deliberate bindExtensions({}) fallback - passing the parent's uiContext
  // would make its LocalUserAuthorizer prompt IN ADDITION to this gate, and a
  // wrapper decision cannot satisfy the extension's gate which runs before
  // execute), so the extension prompts nowhere in children; it enforces deny
  // rules and hard-blocks unanswerable ask rules (fail-closed).
  const wrapMutationTool = (def, run, parentCtx) => {
    const original = def.execute;
    return Object.assign({}, def, {
      execute: async (toolCallId, params, signal, onUpdate, childCtx) => {
        if (run.mutationPolicy !== "allow" && !run.allowedTools.has(def.name)) {
          const sessionKey = run.agent + ":" + def.name;
          if (!sessionAllowed.has(sessionKey)) {
            let choice = null;
            try {
              choice = await parentCtx.ui.select(
                "Sigil Tasks - " + run.agent,
                ["Allow once", "Allow for this session", "Deny"],
                { signal: parentCtx.signal, timeout: PERMISSION_TIMEOUT_MS }
              );
            } catch (e) {
              choice = null;
            }
            if (choice === "Allow for this session") sessionAllowed.add(sessionKey);
            if (choice !== "Allow once" && choice !== "Allow for this session") {
              throw new Error(
                "Permission denied by the user: " + def.name + " is not allowed for this run. " +
                  "Adapt without this action, or report the blocker in your final answer."
              );
            }
          }
          run.allowedTools.add(def.name);
        }
        return original(toolCallId, params, signal, onUpdate, childCtx);
      },
    });
  };

  // Restore tree AND revision from the last persisted record. Load-bearing:
  // pi re-instantiates extensions per session; without this the revision
  // resets to 0 and the plugin's per-session floor rejects every snapshot.
  pi.on("session_start", async (_event, ctx) => {
    agents = loadAgents(ctx.cwd);
    // Persisted budget counter (budget-durability fix): read from the LAST
    // restored record inside the entry scan below; 0 when no record carries
    // the field (records written before it was introduced), so the re-derived
    // count alone governs for pre-counter records.
    try {
      const entries = ctx.sessionManager.getEntries();
      for (const entry of entries) {
        if (!entry || entry.type !== "custom" || entry.customType !== TASKS_CUSTOM_TYPE) continue;
        const data = entry.data;
        if (!data || typeof data !== "object" || data.version !== RECORD_VERSION) continue;
        const restored = new Map();
        const list = Array.isArray(data.tasks) ? data.tasks : [];
        for (const t of list) {
          if (!t || typeof t.id !== "string" || !t.id) continue;
          if (STATUSES.indexOf(t.status) < 0) continue;
          restored.set(t.id, {
            id: t.id,
            parentId: t.parentId || null,
            subject: typeof t.subject === "string" ? t.subject : "",
            description: t.description || null,
            status: t.status,
            priority: PRIORITIES.indexOf(t.priority) >= 0 ? t.priority : "medium",
            activeForm: t.activeForm || null,
            agent: t.agent || null,
            run: t.run && typeof t.run === "object" ? { ...t.run } : null,
            createdAt: typeof t.createdAt === "number" ? t.createdAt : Date.now(),
            updatedAt: typeof t.updatedAt === "number" ? t.updatedAt : Date.now(),
            deleted: t.deleted === true,
          });
        }
        tasks = restored;
        revision = typeof data.revision === "number" && data.revision >= 0 ? data.revision : 0;
      }
    } catch (e) {
      // Restore failure -> keep empty state; the next mutation re-syncs.
    }
    // Any run still marked "running" belonged to a previous extension
    // instance and died with it: normalize to failed so the panel and the
    // next snapshot agree.
    const now = Date.now();
    for (const t of tasks.values()) {
      if (t.run && t.run.state === "running") {
        t.run = {
          runId: t.run.runId,
          childSessionId: t.run.childSessionId || null,
          state: "failed",
          startedAt: t.run.startedAt || now,
          endedAt: now,
          error: "interrupted (session switch)",
        };
      }
    }
    // pi 0.87.0 turn_end boundary (TDD pi-0.87.1-upgrade A2): anchor the
    // snapshot dedup key from the restored snapshot WITHOUT writing - the
    // restored state IS the last durable record, so the first turn_end must
    // not re-write it (no boot write today; keep it that way). The anchor
    // sits AFTER the running-run normalization so the normalized (memory-only)
    // state stays the baseline until the next real write, matching the
    // pre-boundary behavior exactly.
    lastPersistedKey = snapshotKey();
    taskStateDirty = false;
  });

  // Runs are turn-scoped: on shutdown (session switch/new/quit) abort every
  // live child. Children never outlive the pi process by design.
  pi.on("session_shutdown", async () => {
    for (const run of Array.from(runs.values())) {
      try {
        run.session.abort();
      } catch (e) {
        // best-effort
      }
      try {
        run.session.dispose();
      } catch (e) {
        // best-effort
      }
    }
    runs.clear();
  });

  // pi 0.87.0 actionable turn_end boundary (TDD pi-0.87.1-upgrade A2): task
  // mutations commit ONE deduped snapshot per turn. The draft is appended in
  // list order AFTER the turn's own entries; continue:false only opts this
  // handler out of requesting a next model request - it never suppresses
  // natural work. No draft (undefined) when the snapshot key matches the last
  // persisted record: child immediate writes and the session_start restore
  // anchor already refreshed the key. Never throws into the boundary loop
  // (persistence is not transactional): errors are logged and the turn
  // proceeds; a later turn re-tries the still-differing snapshot.
  pi.on("turn_end", async (event) => {
    try {
      if (!taskStateDirty) return undefined;
      const key = snapshotKey();
      if (lastPersistedKey === key) {
        taskStateDirty = false;
        return undefined;
      }
      purgeTombstones();
      const built = buildRecord();
      lastPersistedKey = JSON.stringify(built.record);
      taskStateDirty = false;
      if (built.hasTombstone) tombstonesPendingPurge = true;
      const draft = { type: "custom", customType: TASKS_CUSTOM_TYPE, data: built.record };
      const priorEntries = Array.isArray(event && event.entries) ? event.entries : [];
      return { entries: priorEntries.concat([draft]), continue: false };
    } catch (e) {
      console.warn("[sigil-tasks] turn_end boundary draft failed: " + msg(e));
      return undefined;
    }
  });

  pi.registerTool({
    name: "task_create",
    label: "Create task",
    description:
      "Create a task (or a subtask of an existing root task) in the session task tree. " +
      "Assign an agent to any task you intend to delegate with task_delegate.",
    promptSnippet: "Create a task or subtask in the session task tree",
    promptGuidelines: TASK_GUIDELINES,
    parameters: Type.Object({
      subject: Type.String({ description: "Short imperative task subject." }),
      description: Type.Optional(
        Type.String({ description: "Long-form details, acceptance criteria, or context for a delegated agent." })
      ),
      parentId: Type.Optional(
        Type.String({ description: "Parent ROOT task id. One subtask level only." })
      ),
      priority: Type.Optional(
        Type.Union([
          Type.Literal("low"),
          Type.Literal("medium"),
          Type.Literal("high"),
        ], { description: "Defaults to medium." })
      ),
      activeForm: Type.Optional(
        Type.String({ description: "Present-continuous label shown while in_progress (e.g. 'implementing mapper')." })
      ),
      agent: Type.Optional(
        Type.String({ description: "Agent name to assign (from .pi/sigil-agents.json)." })
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const subject = typeof params.subject === "string" ? params.subject.trim() : "";
      if (!subject) return taskError("VALIDATION", "subject must not be empty");
      if (params.agent !== undefined && params.agent !== null && !agents.has(params.agent)) {
        return taskError("AGENT_NOT_FOUND", "unknown agent: " + params.agent);
      }
      if (params.parentId !== undefined && params.parentId !== null) {
        const parent = tasks.get(params.parentId);
        if (!parent || parent.deleted) {
          return taskError("NOT_FOUND", "parent task not found: " + params.parentId);
        }
        if (parent.parentId) {
          return taskError("SUBTASK_DEPTH", "parent must be a root task (one subtask level only)");
        }
      }
      if (liveCount() >= MAX_TASKS) {
        return taskError("LIMIT_REACHED", "task limit reached (" + MAX_TASKS + " tasks)");
      }
      const now = Date.now();
      const id = newTaskId();
      tasks.set(id, {
        id: id,
        parentId: params.parentId || null,
        subject: subject,
        description: params.description || null,
        status: "pending",
        priority: params.priority || "medium",
        activeForm: params.activeForm || null,
        agent: params.agent || null,
        run: null,
        createdAt: now,
        updatedAt: now,
        deleted: false,
      });
      revision++;
      markTasksDirty();
      return textResult("Created " + id + ": " + subject);
    },
  });

  pi.registerTool({
    name: "task_update",
    label: "Update task",
    description:
      "Update a task's status, subject, description, priority, or activeForm. " +
      "Transitions: pending -> in_progress -> completed; re-open (completed -> in_progress, in_progress -> pending) allowed.",
    promptSnippet: "Update task status or fields in the session task tree",
    promptGuidelines: TASK_GUIDELINES,
    parameters: Type.Object({
      taskId: Type.String({ description: "Task id to update." }),
      status: Type.Optional(
        Type.Union([
          Type.Literal("pending"),
          Type.Literal("in_progress"),
          Type.Literal("completed"),
        ])
      ),
      subject: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      priority: Type.Optional(
        Type.Union([
          Type.Literal("low"),
          Type.Literal("medium"),
          Type.Literal("high"),
        ])
      ),
      activeForm: Type.Optional(Type.String()),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const t = tasks.get(params.taskId);
      if (!t || t.deleted) return taskError("NOT_FOUND", "task not found: " + params.taskId);
      let changed = false;
      if (params.status !== undefined && params.status !== null && params.status !== t.status) {
        if (!canTransition(t.status, params.status)) {
          return taskError(
            "INVALID_TRANSITION",
            "cannot move " + t.status + " -> " + params.status + " (delete and recreate instead)"
          );
        }
        t.status = params.status;
        changed = true;
      }
      if (typeof params.subject === "string" && params.subject.trim() && params.subject.trim() !== t.subject) {
        t.subject = params.subject.trim();
        changed = true;
      }
      if (params.description !== undefined) {
        const d = params.description || null;
        if (d !== t.description) {
          t.description = d;
          changed = true;
        }
      }
      if (params.priority !== undefined && params.priority !== null && params.priority !== t.priority) {
        t.priority = params.priority;
        changed = true;
      }
      if (params.activeForm !== undefined) {
        const a = params.activeForm || null;
        if (a !== t.activeForm) {
          t.activeForm = a;
          changed = true;
        }
      }
      if (changed) {
        t.updatedAt = Date.now();
        revision++;
        markTasksDirty();
        return textResult("Updated " + t.id + " (" + t.status + ")");
      }
      return textResult("No changes for " + t.id);
    },
  });

  pi.registerTool({
    name: "task_list",
    label: "List tasks",
    description:
      "List the session task tree. Cheap: recovers task ids after compaction " +
      "(custom entries never enter LLM context).",
    promptSnippet: "List the session task tree with ids and statuses",
    promptGuidelines: TASK_GUIDELINES,
    parameters: Type.Object({
      status: Type.Optional(
        Type.Union([
          Type.Literal("pending"),
          Type.Literal("in_progress"),
          Type.Literal("completed"),
        ])
      ),
      parentId: Type.Optional(Type.String({ description: "Only subtasks of this root task id." })),
      includeCompleted: Type.Optional(Type.Boolean({ description: "Include completed tasks. Default true." })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const includeCompleted = params.includeCompleted !== false;
      const lines = [];
      for (const t of liveTasksSorted()) {
        if (params.status && t.status !== params.status) continue;
        if (params.parentId !== undefined && params.parentId !== null && t.parentId !== params.parentId) continue;
        if (!includeCompleted && t.status === "completed") continue;
        let line = "- " + t.id + " [" + t.status + "]";
        if (t.agent) line += " (agent: " + t.agent + ")";
        line += ": " + t.subject;
        if (t.activeForm && t.status === "in_progress") line += " (" + t.activeForm + ")";
        if (t.run) line += " [run " + t.run.state + "]";
        lines.push(line);
      }
      const body = lines.length ? lines.join("\n") : "(no tasks)";
      return textResult(body);
    },
  });

  pi.registerTool({
    name: "task_delete",
    label: "Delete task",
    description: "Delete a task (tombstone) from any state. Prefer delete + recreate over re-opening completed tasks.",
    promptSnippet: "Delete a task from the session task tree",
    promptGuidelines: TASK_GUIDELINES,
    parameters: Type.Object({
      taskId: Type.String({ description: "Task id to delete." }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const t = tasks.get(params.taskId);
      if (!t || t.deleted) return taskError("NOT_FOUND", "task not found: " + params.taskId);
      t.deleted = true;
      t.updatedAt = Date.now();
      revision++;
      markTasksDirty();
      return textResult("Deleted " + t.id + ": " + t.subject);
    },
  });

  pi.registerTool({
    name: "task_delegate",
    label: "Delegate task",
    description:
      "Run an assigned agent on a task to completion, in-process. The child streams its work live " +
      "into the task's session view and asks the user for mutation permissions through Sigil's dialogs. " +
      "Children cannot be steered; include all needed context in instructions. Emit parallel " +
      "task_delegate calls in one response for fan-out. Synchronous by default; pass async: true to " +
      "DETACH the run - the call returns an immediate ack, the child keeps working after the call " +
      "returns, and its result is injected automatically at the next idle boundary (also readable " +
      "via task_result).",
    promptSnippet: "Delegate a task to its assigned agent (runs to completion, streams live, or detaches with async)",
    promptGuidelines: DELEGATION_GUIDELINES,
    executionMode: "parallel",
    parameters: Type.Object({
      taskId: Type.String({
        description: "Task id to delegate; a task with no assigned agent uses the general-purpose fallback agent.",
      }),
      async: Type.Optional(
        Type.Boolean({
          description:
            "Detach: return an immediate ack and keep working; the child continues after this call returns. " +
            "Its result is injected automatically at the next idle boundary and is readable via task_result. " +
            "Default false (synchronous).",
        }),
      ),
      instructions: Type.Optional(
        Type.String({ description: "Refined task text for the child. Defaults to subject + description." })
      ),
      readOnly: Type.Optional(
        Type.Boolean({ description: "Force read-only tools for this run, overriding the agent's policy." })
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const t = tasks.get(params.taskId);
      if (!t || t.deleted) return taskError("NOT_FOUND", "task not found: " + params.taskId);
      if (t.run && t.run.state === "running") {
        return taskError("NOT_DELEGATABLE", "task already has a live run: " + t.run.runId);
      }
      // Max concurrent runs gate (2026-10-04 user-directed redefinition of
      // the 2026-10-03 hard-total budget): the Max subtasks setting caps the
      // number of delegated child sessions LIVE at the same time. The cap
      // re-reads per delegation (mtime-cached), so a raised setting unblocks
      // the next run without any reconnect.
      const runCap = currentSubtaskLimit(ctx.cwd);
      if (liveRunCount() >= runCap) {
        return taskError("LIMIT_REACHED", "concurrent sub-session limit reached (" + liveRunCount() + " of " + runCap + " live) - raise the Max subtasks setting in Settings > Tools > Sigil > Agents");
      }
      // ASYNC_DISABLED gate (docs/tdd/async-subsessions.md 4.7.2-G): the
      // Settings kill-switch, read mtime-cached per delegation (mirrors
      // currentSubtaskLimit). Positioned AFTER LIMIT_REACHED and BEFORE agent
      // resolution; when off, an async: true call is rejected and the LLM
      // falls back to the default synchronous delegation (unchanged by this
      // setting).
      const wantsAsync = params.async === true;
      if (wantsAsync && !asyncDelegationEnabled(ctx.cwd)) {
        return taskError("ASYNC_DISABLED", "async delegation is disabled by Settings - retry without the async flag");
      }
      // General-purpose fallback (docs/tdd/async-subsessions.md G4): a task
      // with no assigned agent resolves the internal "general-purpose"
      // persona entry (always emitted into .pi/sigil-agents.json by the
      // plugin; no model binding - the child inherits the chat's active
      // model). Fail closed: an agent name that is still unknown, or a
      // registry missing the fallback entry, stays AGENT_NOT_FOUND. (The old
      // hint pointing agents to task_update's nonexistent agent field was a
      // doc bug - the fixed message below only routes to task_create.)
      const agentName = t.agent || "general-purpose";
      const agent = agents.get(agentName) || null;
      if (!agent) {
        return taskError(
          "AGENT_NOT_FOUND",
          "no delegable agent" +
            (t.agent ? " (task agent unknown: " + t.agent + ")" : " (no assigned agent; the general-purpose fallback is missing from .pi/sigil-agents.json)") +
            "; assign a known agent via task_create or re-apply agent settings"
        );
      }

      // Resolve the model BEFORE any state change: fail fast on unknown models.
      let model = ctx.model;
      if (agent.model) {
        const ref = parseModelRef(agent.model);
        const resolved = ref && ctx.modelRegistry ? ctx.modelRegistry.find(ref.provider, ref.modelId) : undefined;
        if (!resolved) {
          return taskError("VALIDATION", "model not available for agent " + agent.name + ": " + agent.model);
        }
        model = resolved;
      }

      // thinkingVariant (TDD 4.7.5): apply the agent entry's optional thinking
      // variant exactly the way the main chat applies thinking variants - the
      // variant names pass 1:1 onto Pi's ThinkingLevel union ("off" | "minimal"
      // | "low" | "medium" | "high" | "xhigh" | "max"), except "none"
      // (ThinkingEffort.NONE = "no thinking") which maps to Pi's "off"
      // (PiRpcClient.setThinkingLevelCommand mapping). The in-process SDK
      // equivalent of the main session's set_thinking_level RPC is the
      // createAgentSession thinkingLevel option (session state; the SDK clamps
      // it to the resolved model's supported levels). No variant -> undefined
      // -> unchanged behavior (the child keeps the settings default).
      let thinkingLevel;
      if (agent.thinkingVariant) {
        thinkingLevel = agent.thinkingVariant === "none" ? "off" : agent.thinkingVariant;
      }

      const runId = newRunId();
      const run = {
        runId: runId,
        taskId: t.id,
        agent: agent.name,
        allowedTools: new Set(),
        // Gate policy for this run's mutation tools (TDD §4.3.5): "allow" executes
        // without prompting (trusted mutation agents - frictionless parallel fan-out);
        // "ask" relays to the parent's dialogs with a session-scoped grant option
        // (Allow once / Allow for this session / Deny).
        mutationPolicy: agent.mutationPolicy === "allow" ? "allow" : "ask",
      };
      const startedAt = Date.now();

      // Tool policy: readonly (default) or coding, or an explicit name list.
      // readOnly=true forces the read-only set for this run.
      const policy = params.readOnly === true ? "readonly" : agent.toolPolicy;
      const policyNames = policy === "coding"
        ? CODING_TOOL_NAMES
        : Array.isArray(policy)
          ? policy
          : READONLY_TOOL_NAMES;
      // Deny backstop (primary is createAgentSession excludeTools below):
      // registration happens ONLY for names the user has not denied. The two
      // layers must agree - a name excluded at the registry is never wrapped
      // nor registered here, and a name that survives filtering is absent
      // from excludeTools only if the deny set changed mid-delegation.
      const deniedNames = deniedToolNames(ctx.cwd);
      const deniedSet = new Set(deniedNames);
      const toolNames = policyNames.filter((name) => !deniedSet.has(name));

      // Persona seam: the child's SYSTEM PROMPT carries the persona. The child
      // loads ZERO DISCOVERED extensions (noExtensions) so it can never recurse;
      // additionalExtensionPaths re-adds the user's GLOBAL packages (provider
      // registrations like pi-ollama-cloud) PLUS exactly two PROJECT paths
      // (childProjectExtensionPaths, TDD 4.7.4): the bridge extension
      // sigil-ide-tools.ts - the same file the main session auto-discovers, so
      // child sigil_* IDE tools are real (children share SIGIL_BRIDGE_URL /
      // SIGIL_BRIDGE_TOKEN via the in-process environment) - and the pinned
      // permission package dir @gotgenes/pi-permission-system (the extension
      // CODE lives in the npm package; .pi/extensions/pi-permission-system/ is
      // config-only), so child bridge-tool calls pass through the same user
      // allow/ask settings as the main session. The codemode tool extensions
      // ride options.extensionFactories (childCodemodeFactories, gated on the
      // bridged codemodeIncludeChildren flag) - NOT resource paths.
      // sigil-tasks.ts and sigil-persona.ts are NEVER added: children cannot
      // delegate (no task_*, no recursion) and never get a persona file
      // re-appended. User-denied builtins are absent from the child entirely
      // (excludeTools below + the toolNames filter); allowed mutations are
      // still ask-gated by our wrapped tools below.
      let loader;
      try {
        loader = new DefaultResourceLoader({
          cwd: ctx.cwd,
          agentDir: getAgentDir(),
          noExtensions: true,
          extensionFactories: childCodemodeFactories(ctx.cwd),
          additionalExtensionPaths: globalPackageSources().concat(childProjectExtensionPaths(ctx.cwd)),
          systemPrompt: agent.persona || undefined,
        });
        await loader.reload();
        // Honest post-reload check (replaces the former catch-around-reload
        // "live-gate fallback", which could never fire: pi resolves unknown or
        // failed extension resources into the load result's error entries and
        // resolves NORMALLY - it does not throw). Any load error attributable
        // to the child codemode extensions degrades to the pre-fix loader
        // config (globals + the two project paths, NO factories): children
        // keep delegation, codemode stays the additive surface that drops.
        // The named factories' error paths are "<inline:codemode>" /
        // "<inline:tool-search>"; the Unknown-builtin-id message is matched
        // too in case a future pi build starts rejecting the factory shape.
        // err.error is guard-checked exactly like err.path: shape drift must
        // DEGRADE (a non-child-task treatment) instead of throwing through
        // the task_delegate catch and failing the whole call.
        const codemodeErrors = loader
          .getExtensions()
          .errors.filter(
            (err) =>
              typeof err.path === "string" &&
              (err.path.indexOf("<inline:codemode") === 0 ||
                err.path.indexOf("<inline:tool-search") === 0 ||
                (typeof err.error === "string" &&
                  err.error.indexOf("Unknown built-in extension") !== -1))
          );
        if (codemodeErrors.length > 0) {
          console.warn(
            "[sigil-tasks] child codemode extension load failed - degrading to the no-codemode child loader: " +
              codemodeErrors
                .map((err) => err.path + ": " + err.error)
                .join("; ")
          );
          loader = new DefaultResourceLoader({
            cwd: ctx.cwd,
            agentDir: getAgentDir(),
            noExtensions: true,
            additionalExtensionPaths: globalPackageSources().concat(childProjectExtensionPaths(ctx.cwd)),
            systemPrompt: agent.persona || undefined,
          });
          await loader.reload();
        }
      } catch (e) {
        // Total loader failure (the degrade path throwing is reported the same
        // way) - never silently spin up a child without its resources.
        return taskError("VALIDATION", "agent resource load failed for " + agent.name + ": " + msg(e));
      }

      let session;
      try {
        // sessionDir is MANDATORY here: the default is the GLOBAL
        // ~/.pi/agent/sessions dir, which the Sigil sidebar never scans.
        // Children must land in the project's .pi-sessions, wired to the
        // parent via the parentSession header.
        const childSessionManager = SessionManager.create(
          ctx.cwd,
          ctx.sessionManager.getSessionDir(),
          { parentSession: ctx.sessionManager.getSessionFile() || undefined }
        );
        const created = await createAgentSession({
          cwd: ctx.cwd,
          agentDir: getAgentDir(),
          model: model,
          thinkingLevel: thinkingLevel,
          noTools: "builtin",
          // PRIMARY deny mechanism (TDD builtin-tool-permission-enforcement
          // 4.7.1.B): pi drops these names at the REGISTRY level - from both
          // the builtin base definitions and custom/extension tools
          // (agent-session.js _refreshToolRegistry) - so an excluded tool can
          // never be activated by the child, regardless of any config layer.
          excludeTools: deniedNames,
          customTools: (function () {
            const wrapped = [];
            for (const name of toolNames) {
              const factory = TOOL_FACTORIES[name];
              if (!factory) continue;
              const def = factory(ctx.cwd);
              if (!def) continue;
              wrapped.push(MUTATION_TOOL_NAMES[name] ? wrapMutationTool(def, run, ctx) : def);
            }
            return wrapped;
          })(),
          resourceLoader: loader,
          sessionManager: childSessionManager,
        });
        session = created.session;
        // Subsession title (2026-09-15): name the child session after the
        // delegated task's subject. Children load NO discovered extensions
        // (pi-session-auto-rename never runs in them), so without this the
        // sidebar title falls back to the child's first-prompt text (long,
        // noisy instructions). The subject is already a concise summary -
        // deterministic, zero extra LLM calls. Best-effort: a naming failure
        // must never fail a delegation.
        try {
          if (t.subject && t.subject.trim()) {
            session.setSessionName(t.subject.trim());
          }
        } catch (e) {
          // non-fatal: the sidebar keeps the first-prompt fallback title
        }
        // Compose the PROJECT permission scope in the child (TDD L2, G1 fix):
        // the permission extension composes GLOBAL-only at factory init and
        // session_start - emitted ONLY by bindExtensions (the SDK
        // createAgentSession never fires it) - is the sole path that reloads
        // with the project scope (extension lifecycle.ts handleSessionStart ->
        // session.refreshConfig(ctx, projectTrusted); child sessions default
        // projectTrusted=true). Minimal bindings {} are legal (every
        // ExtensionBindings field is optional) and deliberate: passing the
        // parent's uiContext would flip the child extension to its
        // LocalUserAuthorizer, which would prompt THROUGH THE EXTENSION in
        // addition to our wrapMutationTool gate (double prompt), and a wrapper
        // decision cannot satisfy the extension gate (it runs before execute).
        // With {} the child extension stays promptless: deny rules block,
        // ask rules fail closed via its DenyingAuthorizer (no UI, not a
        // registered subagent), and wrapMutationTool remains the only ask
        // surface. Also emits the review-log audit trail for child calls.
        try {
          await session.bindExtensions({});
        } catch (e) {
          // A failed composition leaves the child without the project scope;
          // fail the delegation (spawn-failed path) rather than run a child
          // whose permission surface does not match the user's settings.
          try {
            session.dispose();
          } catch (e2) {
            // best-effort; the outer handler reports the original error
          }
          throw e;
        }
        // Explicit codemode/tool_search activation (SECOND LAYER of the
        // child-codemode fix). Registering the factories is not enough:
        // noTools:"builtin" sets usesDefaultTools=false, so the project
        // defaultTools setting NEVER drives child activation, and
        // codemode/tool_search register defaultActive:false - inert until
        // named here (includeAllExtensionTools only activates
        // defaultActive:true tools at build time). Children INHERIT the
        // project codemode.mode via the optionless factory (first layer);
        // MCP is deliberately NOT activated (no MCP extension loads in
        // children). Only names the user did NOT deny are activated -
        // excludeTools already dropped denied names at the REGISTRY, so a
        // denied name would be ignored anyway (setActiveToolsByName only
        // enables tools in the registry); the filter keeps the intent
        // explicit. Idempotent: already-active names are skipped and an
        // empty delta skips the call entirely (it rebuilds the system
        // prompt); unknown names are IGNORED by pi, so a degraded loader
        // (no factories) stays safe. Best-effort: an activation failure
        // must never fail the delegation - the child runs without codemode.
        if (codemodeIncludeChildrenEnabled(ctx.cwd)) {
          const toActivate = ["codemode", "tool_search"].filter(
            (name) => !deniedSet.has(name) && session.getActiveToolNames().indexOf(name) === -1
          );
          if (toActivate.length > 0) {
            try {
              // setActiveToolsByName REPLACES the declared tool list (the
              // union with the current actives is the caller's job - the
              // same shape pi's own defaultTools reload path uses), so the
              // child's existing declared tools ride along.
              session.setActiveToolsByName(session.getActiveToolNames().concat(toActivate));
            } catch (e) {
              console.warn(
                "[sigil-tasks] codemode activation failed in child session for agent " + agent.name + ": " + msg(e)
              );
            }
          }
        }
      } catch (e) {
        const runRecord = {
          runId: runId,
          childSessionId: null,
          state: "failed",
          startedAt: startedAt,
          endedAt: Date.now(),
          error: "spawn failed: " + msg(e),
        };
        t.run = runRecord;
        t.updatedAt = Date.now();
        revision++;
        persistNow();
        return {
          content: [{ type: "text", text: "Delegation failed to start (" + agent.name + "): " + msg(e) }],
          details: snapshotDetails(),
        };
      }

      const childSessionId = session.sessionId;
      runs.set(runId, {
        runId: runId,
        taskId: t.id,
        agent: agent.name,
        session: session,
        allowedTools: run.allowedTools,
        // Async completion-path gate (docs/tdd/async-subsessions.md, in-memory
        // only - never serialized): true for detached runs (async: true),
        // false for today's synchronous call. finalizeDetachedRun below
        // finalizes ONLY an entry still registered with detached: true.
        detached: wantsAsync,
      });
      t.run = {
        runId: runId,
        childSessionId: childSessionId,
        state: "running",
        startedAt: startedAt,
        endedAt: null,
        error: null,
      };
      t.updatedAt = Date.now();
      revision++;
      persistNow();
      // Live run-start update: the plugin's snapshot detector picks this up
      // from the update event's details and flips the panel badge to running.
      try {
        onUpdate?.({
          content: [{ type: "text", text: "[" + agent.name + "] started" }],
          details: snapshotDetails(),
        });
      } catch (e) {
        // onUpdate is fire-and-forget; never fail the run on update errors.
      }

      // Parent-turn abort kills the child (SYNCHRONOUS runs only - a detached
      // run must survive a parent Stop, docs/tdd/async-subsessions.md G3: the
      // tool call's signal is dead once the ack returns, so no listener is
      // attached on the async path).
      const onAbort = () => {
        try {
          session.abort();
        } catch (e) {
          // best-effort
        }
      };
      if (signal && !wantsAsync) {
        // PRE-START abort race: an abort landing during the spawn chain has no
        // active run yet, so session.abort() would be a pre-prompt no-op, and
        // session.prompt below would then START the child anyway (an orphan run
        // the caller had already seen fail). Pre-prompt aborts are finalized
        // by the deterministic gate at the prompt site; the attach arms ONLY
        // the post-prompt abort path.
        if (!signal.aborted) {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      // Live child-event channel. Deltas are forwarded AS THEY ARRIVE (the
      // 150ms window is burst-coalescing only: the first delta of a burst is
      // emitted immediately; a pending buffer flushes at most every 150ms).
      // Tool/lifecycle events pass through uncoalesced (pill-critical).
      let currentMessageId = null;
      let messageCounter = 0;
      let buffer = [];
      let flushTimer = null;
      const sendDelta = (delta) => {
        delta.kind = DELTA_KIND;
        delta.version = RECORD_VERSION;
        delta.runId = runId;
        delta.taskId = t.id;
        delta.agent = agent.name;
        delta.childSessionId = childSessionId;
        if (delta.ts === undefined) delta.ts = Date.now();
        // Activity store (task_result's live read) BEFORE the fire-and-forget
        // emit: detached children keep producing deltas after their tool call
        // returned, so a task_result read sees fresh activity.
        const activityLine = statusLine(delta);
        runActivity.set(runId, activityLine);
        try {
          onUpdate?.({
            content: [{ type: "text", text: activityLine }],
            details: delta,
          });
        } catch (e) {
          // fire-and-forget
        }
      };
      const flushNow = () => {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        const pending = buffer;
        buffer = [];
        for (const d of pending) sendDelta(d);
      };
      const sendCoalesced = (delta) => {
        if (flushTimer) {
          buffer.push(delta);
          return;
        }
        sendDelta(delta);
        flushTimer = setTimeout(flushNow, DELTA_COALESCE_MS);
      };
      const sendImmediate = (delta) => {
        flushNow();
        sendDelta(delta);
      };
      // The subscribe call's unsubscribe return is CAPTURED (async-subsessions
      // 4.7.2-A.4 leak note): a detached run stops the listener at
      // finalize/stop instead of pumping dead onUpdate calls (Spike T2:
      // post-return deltas are silent no-ops); the synchronous call keeps
      // today's shape - the listener dies with session.dispose() after prompt.
      const unsubscribeChildListener = session.subscribe((event) => {
        try {
          if (event.type === "message_start") {
            messageCounter++;
            currentMessageId = "sigil-child-" + runId + "-" + messageCounter;
            sendImmediate({ event: "message_start", messageId: currentMessageId });
          } else if (event.type === "message_update") {
            const e = event.assistantMessageEvent;
            if (!e) return;
            if (e.type === "text_delta" && e.delta) {
              sendCoalesced({ event: "text_delta", messageId: currentMessageId, text: e.delta });
            } else if (e.type === "thinking_delta" && e.delta) {
              sendCoalesced({ event: "thinking_delta", messageId: currentMessageId, text: e.delta });
            }
          } else if (event.type === "tool_execution_start") {
            sendImmediate({
              event: "tool_execution_start",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              argsJson: compactJson(event.args, 512),
            });
          } else if (event.type === "tool_execution_end") {
            sendImmediate({
              event: "tool_execution_end",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              resultJson: compactResult(event.result, 512),
              isError: event.isError === true,
            });
          } else if (event.type === "message_end") {
            sendImmediate({ event: "message_end", messageId: currentMessageId });
            currentMessageId = null;
          }
        } catch (e) {
          // never let listener errors escape
        }
      });

      const instructions =
        typeof params.instructions === "string" && params.instructions.trim()
          ? params.instructions.trim()
          : t.subject + (t.description ? "\n\n" + t.description : "");

      // PRE-START ABORT GATE: an abort that landed during the spawn chain
      // (loader reload -> createAgentSession -> bindExtensions) has NO active
      // run yet, so an attach-time session.abort() is a pre-prompt no-op and
      // the prompt below would start the child anyway - orphaning a run the
      // caller had already seen fail. Finalize this delegation as PRE-START
      // aborted: the child never starts, the record is written, and the
      // live-run slot is released.
      if (signal && signal.aborted) {
        runs.delete(runId);
        try {
          signal.removeEventListener("abort", onAbort);
        } catch (e) {
          // best-effort
        }
        t.run = {
          runId: runId,
          childSessionId: childSessionId,
          state: "failed",
          startedAt: startedAt,
          endedAt: Date.now(),
          error: "aborted",
        };
        t.updatedAt = Date.now();
        revision++;
        persistNow();
        try {
          session.dispose();
        } catch (e) {
          // best-effort
        }
        const abortedText =
          "Delegation aborted before start (" +
          agent.name +
          "): the parent turn was interrupted before the child session began.";
        return { content: [{ type: "text", text: abortedText }], details: snapshotDetails() };
      }

      // ASYNC DETACHED PATH (docs/tdd/async-subsessions.md 4.7.2-A): the run is
      // already registered (runs.set above carries detached: true) and its
      // running-state snapshot persisted; return the ack IMMEDIATELY - no
      // parent-turn abort listener is attached (the tool call's signal is dead
      // once this returns, and detached children must survive a parent Stop)
      // and session.prompt is NOT awaited. The completion continuations below
      // are detached from the tool call: they finalize the run record (done/
      // failed), free the concurrency slot, persist immediately, and INJECT
      // the result at the next idle boundary (4.7.2-A.4; NO new idle hook -
      // pi's followUp queue owns boundary timing, OQ-IDLE).
      if (wantsAsync) {
        const finalizeDetachedRun = (state, errorText) => {
          // Gate 1 (entry.detached IS the completion-path gate; in-memory
          // only): finalize only a run still registered as a live DETACHED
          // run - task_stop, the /task-stop command or session_shutdown
          // removed the entry first, so this continuation must never write
          // after them (post-shutdown appendEntry stays out).
          const liveEntry = runs.get(runId) || null;
          if (!liveEntry || liveEntry.detached !== true) {
            try {
              session.dispose();
            } catch (e) {
              // best-effort
            }
            return;
          }
          // Gate 2 (record guard): the stop path re-assigns t.run to the
          // stopped failed record BEFORE the abort's prompt rejection lands
          // here; never overwrite an already-finalized record.
          if (!t.run || t.run.runId !== runId || t.run.state !== "running") {
            try {
              session.dispose();
            } catch (e) {
              // best-effort
            }
            return;
          }
          try {
            unsubscribeChildListener();
          } catch (e) {
            // best-effort: dispose disconnects the session's listeners anyway
          }
          flushNow();
          runs.delete(runId);
          runActivity.delete(runId);
          let summary = null;
          try {
            summary = session.getLastAssistantText() || null;
          } catch (e) {
            summary = null;
          }
          t.run = {
            runId: runId,
            agent: agent.name,
            childSessionId: childSessionId,
            state: state,
            startedAt: startedAt,
            endedAt: Date.now(),
            error: errorText || null,
            result: summary || (state === "done" ? "Child completed without a final message." : null),
          };
          t.updatedAt = Date.now();
          revision++;
          persistNow();
          injectSubtaskResult(ctx, t, t.run);
          try {
            session.dispose();
          } catch (e) {
            // best-effort
          }
        };
        // Unhandled-rejection discipline (4.7.2-A.3): the detached prompt
        // promise ALWAYS gets both continuations, so a throwing prompt records
        // run failure instead of surfacing an unhandled rejection inside pi;
        // AND each continuation body is itself guarded - a throwing finalize
        // (persistNow's appendEntry) must not become an unhandled rejection
        // either.
        const safeFinalize = (state, errorText) => {
          try {
            finalizeDetachedRun(state, errorText);
          } catch (err) {
            console.warn("[sigil-tasks] detached run finalize failed: " + msg(err));
          }
        };
        session.prompt(instructions).then(() => {
          safeFinalize("done", null);
        }, (e) => {
          safeFinalize("failed", msg(e));
        });
        const detachedAck =
          "Started detached run " +
          runId +
          " (task " +
          t.id +
          ", agent " +
          agent.name +
          "). It continues after this call returns; the result is injected automatically at the next idle boundary and is readable via task_result.";
        return textResult(detachedAck);
      }

      try {
        await session.prompt(instructions);
      } catch (e) {
        const aborted = !!(signal && signal.aborted);
        flushNow();
        runs.delete(runId);
        try {
          signal.removeEventListener("abort", onAbort);
        } catch (e2) {
          // best-effort
        }
        t.run = {
          runId: runId,
          childSessionId: childSessionId,
          state: "failed",
          startedAt: startedAt,
          endedAt: Date.now(),
          error: aborted ? "aborted" : msg(e),
        };
        t.updatedAt = Date.now();
        revision++;
        persistNow();
        try {
          session.dispose();
        } catch (e2) {
          // best-effort
        }
        const text = aborted
          ? "Delegation aborted (" + agent.name + "): the parent turn was interrupted."
          : "Delegation failed (" + agent.name + "): " + msg(e);
        return { content: [{ type: "text", text: text }], details: snapshotDetails() };
      }

      flushNow();
      runs.delete(runId);
      try {
        signal.removeEventListener("abort", onAbort);
      } catch (e) {
        // best-effort
      }
      t.run = {
        runId: runId,
        childSessionId: childSessionId,
        state: "done",
        startedAt: startedAt,
        endedAt: Date.now(),
        error: null,
      };
      t.updatedAt = Date.now();
      revision++;
      persistNow();
      const summary = session.getLastAssistantText() || "Child completed without a final message.";
      try {
        session.dispose();
      } catch (e) {
        // best-effort
      }
      return textResult(summary);
    },
  });

  // task_result (docs/tdd/async-subsessions.md 4.7.2-B): non-blocking read of
  // a delegation run's live state/summary/error. NEVER waits: a running
  // detached child answers from the run record + the last captured activity
  // line (sendDelta feeds it until finalize/stop/dispose).
  pi.registerTool({
    name: "task_result",
    label: "Read task result",
    description:
      "Read the current state and result of a delegated subtask run WITHOUT blocking. " +
      "A running async (detached) delegation reports elapsed time and the last captured child activity; " +
      "a done run reports the captured final child message; a failed run reports the error " +
      "(a run ended by the stop path reports it was stopped, plus any partial text captured). " +
      "Detached runs also deliver their result automatically as an injected continuation message; " +
      "use this tool any time a delegation's outcome is uncertain instead of waiting on it.",
    promptSnippet: "Read a delegated subtask's live state and result (non-blocking, never waits)",
    promptGuidelines: DELEGATION_GUIDELINES,
    parameters: Type.Object({
      taskId: Type.String({ description: "Task id of the delegated run to read." }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
      if (!taskId) return taskError("VALIDATION", "taskId must not be empty");
      const t = tasks.get(taskId);
      if (!t || t.deleted) return taskError("NOT_FOUND", "task not found: " + taskId);
      if (!t.run) {
        return textResult("no delegation run for " + t.id + " (status " + t.status + ") - delegate with task_delegate first");
      }
      const run = t.run;
      if (run.state === "running") {
        const elapsedMs = Date.now() - (run.startedAt || Date.now());
        const activity = runActivity.get(run.runId) || "(no child activity captured yet)";
        return textResult("running - " + formatElapsed(elapsedMs) + ", last activity: " + activity);
      }
      if (run.state === "done") {
        const oneLine = String(run.result || "(no result text captured)")
          .replace(/\s+/g, " ")
          .trim();
        const finishedAt = new Date(run.endedAt || Date.now()).toISOString();
        return textResult("done - " + head(oneLine, TASK_RESULT_SUMMARY_CAP) + " - finished " + finishedAt);
      }
      if (run.state === "failed") {
        if (run.error === "stopped") {
          const partial = run.result
            ? " (partial result: " + head(String(run.result).replace(/\s+/g, " ").trim(), SUBTASK_RESULT_LINE_CAP) + ")"
            : "";
          return textResult("failed - stopped by task_stop or the /task-stop command" + partial);
        }
        return textResult("failed - " + (run.error || "unknown error"));
      }
      return textResult("unknown run state: " + String(run.state));
    },
  });

  // task_stop (docs/tdd/async-subsessions.md 4.7.2-B): mid-turn LLM-facing
  // stop for ONE live delegation run (the /task-stop command is the user 
  // surface; stop-all rides it with "all"). The run is finalized as
  // failed("stopped"), its concurrency slot is freed (re-delegating the
  // stopped task is allowed), and the stopped result is injected so the main
  // session learns of the stop.
  pi.registerTool({
    name: "task_stop",
    label: "Stop delegated run",
    description:
      "Abort the LIVE delegated child session of one task (async detached or synchronous). " +
      "The run is finalized as failed with error stopped, its concurrency slot is freed so the task " +
      "can be re-delegated immediately, and a stopped result is injected so the main session keeps " +
      "working with that knowledge. Use it to abandon or re-plan a delegating subtask without a UI stop.",
    promptSnippet: "Stop a live delegated child session by task id (frees the run slot, injects the stopped result)",
    promptGuidelines: DELEGATION_GUIDELINES,
    parameters: Type.Object({
      taskId: Type.String({ description: "Task id whose live delegated run should be stopped." }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
      if (!taskId) return taskError("VALIDATION", "taskId must not be empty");
      const t = tasks.get(taskId);
      if (!t || t.deleted) return taskError("NOT_FOUND", "task not found: " + taskId);
      const liveEntry = findLiveRunByTask(t.id);
      if (!liveEntry) {
        return taskError("NOT_DELEGATABLE", "no live delegation run for task: " + t.id);
      }
      return textResult(stopLiveRun(ctx, liveEntry));
    },
  });

  // /task-stop command (docs/tdd/async-subsessions.md 4.7.2-B + F3, the
  // user/plugin stop surface): "task-stop <taskId>" stops that live run,
  // "task-stop all" stops EVERY live run (sync AND detached). The plugin
  // routes UI stops through this command prompt (pi intercepts extension
  // commands immediately, even during streaming; command-only prompts never
  // emit agent_settled - the plugin's documented synthetic settle applies).
  // The handler shares stopLiveRun with the task_stop tool: abort + dispose,
  // failed(stopped) records + persistNow, then the STOPPED injection - the
  // injected message is the user-visible feedback (a command handler return
  // is not rendered). Mid-turn user stops are queue-while-busy v1 (documented
  // caveat): they execute at the settle boundary.
  pi.registerCommand("task-stop", {
    description: "Stop live delegated child runs: /task-stop <taskId> or /task-stop all",
    handler: async (args, ctx) => {
      const wanted = typeof args === "string" ? args.trim() : "";
      if (!wanted) {
        console.warn("[sigil-tasks] /task-stop needs a task id or 'all' (live runs: " + liveRunCount() + ")");
        return;
      }
      let targets = Array.from(runs.values());
      if (wanted !== "all") {
        const t = tasks.get(wanted);
        const entry = t && !t.deleted ? findLiveRunByTask(t.id) : null;
        if (!entry) {
          console.warn("[sigil-tasks] /task-stop: no live delegation run for task: " + wanted);
          return;
        }
        targets = [entry];
      }
      for (const target of targets) {
        try {
          stopLiveRun(ctx, target);
        } catch (e) {
          console.warn("[sigil-tasks] /task-stop: stopping run " + target.runId + " failed: " + msg(e));
        }
      }
    },
  });
}