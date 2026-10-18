---
name: ue-mcp-cli
description: Use when a ue-mcp task needs the npm CLI rather than an MCP tool call - redeploying the C++ bridge plugin (deploy), building the project (build), switching the context strategy (context), managing dialog or feedback modes, plugin install, auth, or targeting one of several editors with --editor. Pulls in when the user asks to deploy, build, reinstall, configure, or update ue-mcp itself.
---

# ue-mcp CLI subcommands

The `ue-mcp` MCP server exposes 26 category tools, but several operations exist
ONLY as CLI subcommands - no MCP tool call can do them. Run them from a shell:
`npx ue-mcp <subcommand>` resolves the local install (run in the project root;
Sigil's own Unreal Tools page runs `deploy`/`update` for you with the
`.uproject` argument).

## CLI-only operations (never reachable through MCP tools)

| Command | What it does |
|---|---|
| `npx ue-mcp deploy` | Copy the C++ bridge plugin sources into the project. Use after `update`, or to force a redeploy. |
| `npx ue-mcp build` | Build the project C++ with Unreal Build Tool. **Stop the editor first.** |
| `npx ue-mcp update` | Check npm for the latest version and install it. Pass `--deploy` to also redeploy plugin sources. |
| `npx ue-mcp context [full/lean/micro]` | Read or set the context strategy in `ue-mcp.yml` (no arg = show current). |
| `npx ue-mcp dialog mode [[mode]]` | Read/set how a modal dialog blocking the editor is handled (`interactive`, `auto`, `defer`). `default` clears it. |
| `npx ue-mcp feedback mode [[mode]]` | Read/set the personal feedback approval mode (`interactive`, `auto-approve`, `defer`). |
| `npx ue-mcp feedback list/show/approve/discard/review` | Manage submissions queued while feedback mode is `defer`. |
| `npx ue-mcp resolve [issue]` | Fetch a feedback issue, branch, hand it to an agent to implement, open a PR. |
| `npx ue-mcp plugin install/uninstall/create [name]` | Manage ue-mcp plugin packages (registered in `ue-mcp.yml`). |
| `npx ue-mcp auth` | Run the GitHub device flow so `feedback(submit)` authors issues as your user. |
| `npx ue-mcp uninstall-hooks` | Remove the feedback PostToolUse hook from every recorded Claude Code settings file. |

## Update → deploy → rebuild pipeline

After a package version change: `npx ue-mcp update --deploy`, then rebuild the
project's C++ with the editor STOPPED (`npx ue-mcp build`), then restart the
editor. A stale compiled bridge keeps old behavior until redeployed and
rebuilt - the Node side updates instantly, the editor side does not.

## Targeting one of several editors

Every one-shot subcommand accepts `--editor <name-or-path>` (session name first,
project path second):

```shell
npx ue-mcp deploy --editor Beta
npx ue-mcp build --editor Beta
npx ue-mcp context lean --editor Beta
```

The name is what `project(action="list_editors")` reports - the same name a
tool call's `editor` parameter takes.

## Machine-local state (never project policy)

`dialog mode` and `feedback mode` write `~/.ue-mcp/state.json` - they vary per
developer and per machine, deliberately NOT in `ue-mcp.yml`. Do not script them
into project config; set them per machine with the CLI.

## Context strategy is a restart requirement

Changing the strategy (CLI or `ue-mcp.yml`) changes the `tools/list` seed the
server advertises - restart the MCP client (or reconnect the session) after
changing it. The per-session `UE_MCP_CONTEXT_STRATEGY` env var wins over the
config value.