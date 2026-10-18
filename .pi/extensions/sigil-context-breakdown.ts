
// Sigil context breakdown - plugin-managed, overwritten on each Sigil connect.
// OBSERVE-ONLY extension: records a deterministic char-count breakdown of the
// assembled system prompt into the session JSONL via pi.appendEntry. It NEVER
// returns a systemPrompt override and NEVER reads the chained system prompt
// string from the event (that value is chain-order dependent because
// sigil-persona.ts appends the persona in its own before_agent_start handler).
//
// Sections (char counts, deterministic given event.systemPromptOptions):
// - systemPrompt: the static prompt skeleton (default guidelines + cwd line,
//   no tools/skills/context/append) - measured as a SUBSET-DIFFERENTIAL: base
//   = buildSystemPrompt with selectedTools/toolSnippets/skills/contextFiles
//   emptied and appendSystemPrompt dropped.
// - systemTools: chars the real tool selection adds to that skeleton (the
//   tools list plus tool-conditional guideline deltas) = full-options call
//   minus base.
// - skills: the exact chars of the skills section as buildSystemPrompt embeds
//   it, i.e. formatSkillsForPrompt(opts.skills).length. The subset-differential
//   form is NOT usable for skills: selectedTools: [] makes !selectedTools
//   false and [].includes("read") false, so the differential call skips the
//   skills block and would always report 0 (verified against pi 0.84.4).
//   Assumes the read tool is active (pi default) - pi only embeds skills when
//   read is available.
// - memoryFiles: sum of opts.contextFiles content lengths.
// - persona: trimmed length of .pi/sigil-persona.md (0 when absent) - mirrors
//   what sigil-persona.ts appends.
//
// buildSystemPrompt is NOT exported from the package index (only its options
// TYPE is), so it is loaded via a filesystem walk-up probe for the running
// package's dist/core/system-prompt.js plus a file-URL dynamic import. The
// absolute path bypasses the package exports map and works identically in the
// bundled (virtualModules) and unbundled (alias) jiti extension modes. If the
// probe or the import fails, the entry is skipped for that turn - never
// throws, never breaks the agent turn.
//
// A1 (pi 0.87.x context_with_system): an OBSERVE-ONLY listener measures the
// EXACT system side of each request - JSON.stringify(msg).length summed over
// EVERY role==="system" message in event.messages (the leading system message
// PLUS the mid-conversation prompt/tool patch messages; compaction
// checkpoints replace the head). It returns NOTHING - a returning handler
// would own the prompt and tool declarations for that request (the
// transforming-handler guard binds only returners). The sum rides module-level
// state and the entry payload gains measuredSystemPromptChars (+ measuredTs);
// null when no system message was seen this turn (never 0).
//
// A3 (pi 0.87.x agent_before_settle): the entry is re-emitted at the new
// actionable settle boundary - the hook recomputes the five differential
// counts from the module-level lastOpts cache (settle events carry no
// systemPromptOptions) + re-measures the persona file and appends on key
// change, so the panel's section data is end-of-turn fresh. Settle before any
// before_agent_start (no cache) is a no-op. Probe-failure degraded path: when
// the differentials are unavailable but a measurement exists, the emitted
// entry carries all-zero sections so the panel keeps extension-mode with a
// lumped measured system row instead of dying to estimate mode.
//
// Dedup: the SIX-field key (the five counts + the null-safe measured system
// chars - "none" until the listener first fires, so it can never collapse
// against a 0 value) joins into a stable key; the single pi.appendEntry call
// in the shared emit helper fires only when the key changes (per-process
// closure state), so idle turns append nothing. Every handler body is wrapped
// in try/catch - failures never throw into the agent loop (mirror
// sigil-persona.ts); probe failures additionally warn once per detail via
// console.warn (AGENTS.md Pi-portability rule); settle-hook failures warn
// once per detail the same way.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";

const CUSTOM_TYPE = "sigil_context_breakdown";
const PERSONA_RELATIVE_PATH = ".pi/sigil-persona.md";

// One-shot probe diagnostics (AGENTS.md Pi-portability rule: degrade with a
// log line, never silently - the 2026-09-21 macOS layout incident was found
// only via a live repro because the probe failure left no machine-local
// evidence). console.warn writes to stderr, so the RPC mode's stdout JSONL
// framing is never touched; the per-detail map dedups the warning so the
// every-turn probe retry (the failed-load cache reset) cannot spam the host
// log.
const probeWarnedDetails = {};
function warnProbeFailure(detail) {
  if (probeWarnedDetails[detail]) return;
  probeWarnedDetails[detail] = true;
  console.warn("[sigil-context-breakdown] " + detail);
}

// Locate the RUNNING pi package's system-prompt module on disk. Anchored at
// process.argv[1] (pi's own entry script, SYMLINK-RESOLVED - see below) and at
// this extension file; four candidate shapes per level cover every known
// install layout:
// - <dir>/dist/core/system-prompt.js              (in-package - the common hit
//                                                  once the anchor is resolved)
// - <dir>/node_modules/@earendil-works/...        (Windows npm-global: the
//                                                  cmd shim execs the real
//                                                  dist path, node_modules is
//                                                  a sibling of the shim)
// - <dir>/lib/node_modules/@earendil-works/...    (Unix global installs:
//                                                  Homebrew /opt/homebrew/bin
//                                                  -> ../lib/node_modules,
//                                                  nvm versions, Debian)
// - <dir>/@earendil-works/...                     (scoped-dir layouts)
// PORTABILITY (2026-09-21 macOS incident): process.argv[1] is NOT realpath-
// resolved by Node. On macOS/Homebrew the launcher /opt/homebrew/bin/pi is a
// SYMLINK into ../lib/node_modules/@earendil-works/pi-coding-agent/dist/, so
// the raw dirname anchor (/opt/homebrew/bin) can never reach the package - the
// walk-up checks <dir>/node_modules at /opt/homebrew while the package lives
// under lib/node_modules. realpathSync on the anchor lands inside the real
// dist dir and the in-package shape hits immediately; the lib/node_modules
// shape covers layouts where even the realpath does not (nvm shims). Returns
// null when nothing matches - callers degrade to skipping the entry.
function findSystemPromptJs() {
  const anchors = [];
  if (process.argv && process.argv[1]) {
    anchors.push(dirname(process.argv[1]));
    try {
      anchors.push(dirname(realpathSync(process.argv[1])));
    } catch (e) {
      // argv[1] vanished or is unreadable - the raw anchor above still stands.
      warnProbeFailure("realpathSync failed for argv[1]=" + process.argv[1] + " (" + (e && e.message ? e.message : String(e)) + ") - the raw anchor above still stands.");
    }
  }
  try {
    anchors.push(dirname(fileURLToPath(import.meta.url)));
  } catch (e) {
    // import.meta.url unavailable in this runtime - skip the anchor.
  }
  for (const anchor of anchors) {
    let dir = anchor;
    for (let level = 0; level < 16; level++) {
      const inPackage = join(dir, "dist", "core", "system-prompt.js");
      if (existsSync(inPackage)) return inPackage;
      const viaNodeModules = join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "system-prompt.js");
      if (existsSync(viaNodeModules)) return viaNodeModules;
      const viaLibNodeModules = join(dir, "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "system-prompt.js");
      if (existsSync(viaLibNodeModules)) return viaLibNodeModules;
      const viaScopedDir = join(dir, "@earendil-works", "pi-coding-agent", "dist", "core", "system-prompt.js");
      if (existsSync(viaScopedDir)) return viaScopedDir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

// One dynamic import per process; a failed load resets the cache so a later
// turn can retry (a rejection is never cached permanently).
let promptBuilderPromise = null;
function loadBuildSystemPrompt() {
  if (promptBuilderPromise === null) {
    promptBuilderPromise = (async () => {
      const found = findSystemPromptJs();
      if (!found) {
        warnProbeFailure(
          "no dist/core/system-prompt.js found from any anchor (argv[1], realpath(argv[1]), extension dir; shapes: dist, node_modules, lib/node_modules, scoped-dir) - context breakdown entries will not be written on this machine"
        );
        return null;
      }
      const mod = await import(pathToFileURL(found).href);
      return mod && typeof mod.buildSystemPrompt === "function" ? mod.buildSystemPrompt : null;
    })();
    promptBuilderPromise.catch(() => {
      promptBuilderPromise = null;
    });
  }
  return promptBuilderPromise;
}

// A1/A3 module-level state (pi 0.87.x context_with_system + agent_before_settle):
// - lastOpts: the structured BuildSystemPromptOptions pi used for the LAST
//   before_agent_start - settle events carry no systemPromptOptions, so the
//   A3 hook recomputes the differentials from this cache. Null until the
//   first before_agent_start of the process; the settle hook is a no-op then.
// - measuredSystemPromptChars: the EXACT system-side chars of the last
//   observed request (context_with_system). Null when no request has been
//   observed yet or when the observed request carried no system message -
//   never 0 (an absent system side is null, not zero).
// - measuredTs: wall-clock (Date.now()) of the last context_with_system
//   observation (0 before the first observation).
let lastOpts = null;
let measuredSystemPromptChars = null;
let measuredTs = 0;
const settleErrorWarned = {};

export default function (pi) {
  let lastKey = null;

  function countMemoryFiles(opts) {
    const files = Array.isArray(opts.contextFiles) ? opts.contextFiles : [];
    let total = 0;
    for (const file of files) {
      if (file && typeof file.content === "string") total += file.content.length;
    }
    return total;
  }

  function countPersonaChars(ctx) {
    try {
      return readFileSync(join(ctx.cwd, PERSONA_RELATIVE_PATH), "utf8").trim().length;
    } catch (e) {
      return 0; // no persona file this turn - count as zero
    }
  }

  // Shared append path for BOTH entry points (before_agent_start + the A3
  // settle hook): one differential-math body, one extended dedup key, and the
  // single pi.appendEntry call - the two handlers cannot drift.
  function emitBreakdown(systemPromptChars, systemToolsChars, skillsChars, memoryFilesChars, personaChars) {
    // Dedup key EXTENDED (A1) with the measured system side, null-safe: a turn
    // whose context_with_system listener has not fired keeps "none" so the key
    // can never collapse against a numeric measurement (0 included).
    const measuredKey = measuredSystemPromptChars === null ? "none" : String(measuredSystemPromptChars);
    const key = [systemPromptChars, systemToolsChars, skillsChars, memoryFilesChars, personaChars, measuredKey].join("|");
    if (key === lastKey) return;
    lastKey = key;
    pi.appendEntry(CUSTOM_TYPE, {
      version: 2,
      sections: {
        systemPrompt: systemPromptChars,
        systemTools: systemToolsChars,
        skills: skillsChars,
        memoryFiles: memoryFilesChars,
        persona: personaChars,
      },
      totalPromptChars: systemPromptChars + systemToolsChars + skillsChars + memoryFilesChars + personaChars,
      measuredSystemPromptChars: measuredSystemPromptChars,
      measuredTs: measuredTs,
      ts: Date.now(),
    });
  }

  async function recordBreakdown(opts, ctx) {
    const buildSystemPrompt = await loadBuildSystemPrompt();

    if (!buildSystemPrompt) {
      // A1 probe-failure degraded path: the walk-up probe or the dynamic
      // import failed, so the differential sections are unusable - but an
      // exact measurement still anchors the system side. Emit an entry with
      // all-zero sections so the panel stays extension-mode with the lumped
      // measured row instead of collapsing to estimate mode. Without a
      // measurement there is nothing to record - skip (estimate mode, as
      // before this feature).
      if (measuredSystemPromptChars === null) return;
      emitBreakdown(0, 0, 0, 0, 0);
      return;
    }

    const cwd = typeof opts.cwd === "string" && opts.cwd ? opts.cwd : ctx.cwd;
    const promptGuidelines = Array.isArray(opts.promptGuidelines) ? opts.promptGuidelines : [];
    const selectedTools = Array.isArray(opts.selectedTools) ? opts.selectedTools : [];
    const toolSnippets = opts.toolSnippets && typeof opts.toolSnippets === "object" ? opts.toolSnippets : {};

    // Base: the static skeleton with every per-section input emptied.
    const base = buildSystemPrompt({
      customPrompt: opts.customPrompt,
      selectedTools: [],
      toolSnippets: {},
      promptGuidelines: promptGuidelines,
      appendSystemPrompt: undefined,
      cwd: cwd,
      contextFiles: [],
      skills: [],
    }).length;

    // Tools differential: same call but the REAL tool selection - the delta
    // is the tools list plus tool-conditional guideline changes only.
    const withTools = buildSystemPrompt({
      customPrompt: opts.customPrompt,
      selectedTools: selectedTools,
      toolSnippets: toolSnippets,
      promptGuidelines: promptGuidelines,
      appendSystemPrompt: undefined,
      cwd: cwd,
      contextFiles: [],
      skills: [],
    }).length;

    const systemPromptChars = base;
    const systemToolsChars = withTools > base ? withTools - base : 0;
    const skillsChars = formatSkillsForPrompt(Array.isArray(opts.skills) ? opts.skills : []).length;
    const memoryFilesChars = countMemoryFiles(opts);
    const personaChars = countPersonaChars(ctx);

    emitBreakdown(systemPromptChars, systemToolsChars, skillsChars, memoryFilesChars, personaChars);
  }

  // session_start reset (cross-session isolation, review fix): pi does NOT
  // respawn per session (switch_session is in-process; the extension factory
  // is called once per process), so the closure-scoped lastKey and the
  // module-level A1/A3 state (measuredSystemPromptChars, measuredTs, lastOpts)
  // would otherwise carry over from the previous session - dedup-skipping the
  // new session's first breakdown write on an identical-setup reopen (the
  // panel falls back to estimate mode until the prompt composition changes)
  // and emitting a stale measurement until context_with_system refreshes it.
  // Mirrors SigilTasksExtension's session_start reset pattern. Observe-only:
  // a reset failure never breaks the session start.
  pi.on("session_start", async (_event, _ctx) => {
    try {
      lastKey = null;
      measuredSystemPromptChars = null;
      measuredTs = 0;
      lastOpts = null;
    } catch (e) {
      return; // observe-only: never break the session start
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const opts = event && event.systemPromptOptions ? event.systemPromptOptions : null;
      if (!opts) return;
      lastOpts = opts;
      await recordBreakdown(opts, ctx);
    } catch (e) {
      const detail = e && e.message ? e.message : String(e);
      warnProbeFailure("before_agent_start handler failed: " + detail);
      return; // observe-only: never break the turn, never throw
    }
  });

  // A1 (pi 0.87.x context_with_system): OBSERVE-ONLY system-side measurement.
  // Returns NOTHING - a returning handler would own the prompt and tool
  // declarations for the request (sent verbatim); the transforming-handler
  // guard binds only returners. Fired before EACH LLM call, so every round of
  // a multi-round turn refreshes the measurement (the last one wins - it is
  // the request the model actually answers).
  pi.on("context_with_system", async (event, ctx) => {
    try {
      const messages = event && Array.isArray(event.messages) ? event.messages : null;
      if (!messages) return;
      let total = 0;
      let seen = false;
      for (const msg of messages) {
        if (msg && msg.role === "system") {
          seen = true;
          total += JSON.stringify(msg).length;
        }
      }
      measuredSystemPromptChars = seen ? total : null;
      measuredTs = Date.now();
    } catch (e) {
      return; // observe-only: never throw into the request path
    }
  });

  // A3 (pi 0.87.x agent_before_settle): final actionable boundary before
  // agent_settled - recompute the differentials from the cached options,
  // re-measure the persona file, and append on key change so the panel's
  // section data is end-of-turn fresh. Guard: settles before any
  // before_agent_start (no cache) are a no-op. Errors are logged (once per
  // detail) and never thrown into the settle path.
  pi.on("agent_before_settle", async (event, ctx) => {
    try {
      if (!lastOpts) return;
      await recordBreakdown(lastOpts, ctx);
    } catch (e) {
      const detail = e && e.message ? e.message : String(e);
      if (!settleErrorWarned[detail]) {
        settleErrorWarned[detail] = true;
        console.warn("[sigil-context-breakdown] agent_before_settle handler failed: " + detail);
      }
      return; // observe-only: never throw into the settle path
    }
  });
}
