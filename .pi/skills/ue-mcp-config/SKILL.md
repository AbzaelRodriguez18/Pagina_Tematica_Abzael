---
name: ue-mcp-config
description: Use when configuring ue-mcp - the ue-mcp.yml keys, config layer precedence, bridge port pinning and lockfiles, multi-editor sessions, or investigating why a ue-mcp setting seems ignored or a connection targets the wrong editor.
---

# ue-mcp configuration

## The config file and its layers

Project config lives in `ue-mcp.yml` NEXT TO the `.uproject` (scaffold and
maintain it with `npx ue-mcp init`; keep it in git so collaborators share the
surface). It is one layer in a deep-merged stack:

```text
user-global (~/.ue-mcp/config.yml) -> project ue-mcp.yml
  -> ue-mcp.<env>.yml (when UE_MCP_ENV is set)
  -> ue-mcp.local.yml
  -> environment variables
```

Key groups: `version`, `contentRoots`, `disable` (exclude categories, e.g.
`[gas]`), `nativeTools` (Epic 5.8 toolset bridging; `enabled`/`exclude`),
`http` (HTTP run route), `context` (`strategy: full|lean|micro`),
`bridge.port`, and `plugins` (npm packages injecting extra actions; loaded
only at server boot - restart the MCP client after editing).

## Context strategy

- `full` (default): all 26 category tools with every action and parameter
  inline (~45k seed tokens); zero discovery calls.
- `lean`: the same tools with validated action enums but collapsed
  descriptions; a `catalog` tool plus per-category `describe` serve the
  details on demand (~23k). See the ue-mcp-lean-context skill.
- `micro`: one `tools` gateway fronts everything (~1k); most discovery
  traffic.

Set with `npx ue-mcp context <mode>` or `context.strategy` in `ue-mcp.yml`;
the per-session `UE_MCP_CONTEXT_STRATEGY` env var wins over the file. Restart
the MCP client after any change.

## Ports and the bridge lockfile

The bridge port is DERIVED from the project root path (stable, launch-order
independent), and the authoritative truth is the lockfile the C++ plugin
publishes: `[project]/Saved/UE_MCP_Bridge/port.json` (port, pid, status,
protocolVersion). When a connection fails, `bridge-error.json` distinguishes
"no editor" from "editor running but bridge could not bind".

Pin an explicit port with `bridge.port` in `ue-mcp.yml` - but a pin is a
request, not a guarantee: if the port is taken the bridge walks upward and
publishes where it actually landed; the client follows the lockfile.
Precedence for the port, highest first: an explicit `-MCPPort=`/client
argument, then `UE_MCP_PORT` (machine-wide - the wrong tool for pinning one
project), then `bridge.port`, then the derived value.

A stale lockfile (editor was killed) blocks lifecycle actions - delete
`[project]/Saved/UE_MCP_Bridge/port.json` to clear it.

## Several editors from one server

Pass more than one `.uproject` on the command line and each becomes an
addressable editor session (own bridge connection, own port). Sessions are
keyed by resolved project root. Manage with `project(action="list_editors" /
"add_editor" / "use_editor" / "drop_editor")`; once more than one session
exists, every category tool and the CLI accept `editor=<name-or-path>`.
Calls with no `editor` run in the active session. Each project needs its own
port (derived ports satisfy this out of the box; a shared `UE_MCP_PORT`
collapses sessions onto one address).

Lifecycle actions (`start_editor`/`stop_editor`/`restart_editor`) act ONLY on
the addressed editor: they resolve the port from the lockfile and verify the
recorded PID against the `.uproject` that process has open.