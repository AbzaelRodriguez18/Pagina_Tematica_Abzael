---
name: ue-mcp-lean-context
description: Use when the ue-mcp server runs with the lean or micro context strategy (seed collapsed to action enums or a single tools gateway) and you need to discover an action cheaply - covers the catalog tool (search/describe/list_categories), the micro tools gateway (search/describe/call), and when NOT to call discovery.
---

# ue-mcp lean and micro context strategies

The server's "context tax" is everything it injects at session start: the
`initialize` instructions plus the whole `tools/list` payload. Three
strategies trade that seed cost against discovery round-trips. Check which one
you are in with `npx ue-mcp context` (no argument prints it), or just observe:
in `full` you see complete action descriptions; in `lean`/`micro` the seed is
collapsed and you must look details up.

## lean: names visible, details on demand

`lean` advertises all 26 category tools with their validated `action` enums,
but descriptions collapsed to a summary. To learn a category or a single
action:

- `catalog(action="search", query="...")` - ranked intent search across every
  category (same ranking the full-mode descriptions use).
- `catalog(action="describe", category="level", method="place_actor")` - the
  full description and nested parameter schema. Omit `method` to describe a
  whole category.
- `catalog(action="list_categories")` - the surface map.

Action names stay enforced up front in lean: calling a category tool with an
unknown action is still rejected immediately, so you cannot silently mis-call.
Typical loop: `catalog(search)` when unsure -> `catalog(describe)` for the
exact call -> invoke the category tool directly.

## micro: one gateway fronts everything

`micro` collapses the surface to a single `tools` gateway:

- `tools(action="search", query="rotate clockwise")` - find where an intent
  lives.
- `tools(action="describe", category="level", method="nudge_component")` -
  omit `method` to list a whole category.
- `tools(action="call", category="level", method="nudge_component",
  args={ ... })` - execute.

Everything else disappears from `tools/list` in micro mode - do not call
`level(...)`/`blueprint(...)` directly; go through the gateway.

## Economics

A smaller seed is not automatically a cheaper session: count the discovery
round-trips the mode will cost you. `full` is right when the agent should see
the entire surface up front; `lean` is a solid middle ground (names visible,
direct calls usually possible); `micro` minimizes the seed at the cost of a
lookup for everything. Measure on your own project with `npm run context-tax`.

## What survives in every strategy

All three modes carry the same short spatial interpretation and verification
guidance, and the required order of operations from the ue-mcp-workflow skill
(status check first) is unchanged. Sigil's Unreal Tools page writes
`UE_MCP_CONTEXT_STRATEGY` from the Context strategy combo - the env var wins
over `ue-mcp.yml` per session; changing it requires reconnecting the session.