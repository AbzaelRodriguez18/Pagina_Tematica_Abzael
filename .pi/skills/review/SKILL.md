---
name: review
description: Read, interpret, and resolve adversarial-review findings stored in the project's .review/ store (written by the reviewer agent). Use when the user asks to fix, address, or resolve review comments/findings, or when working with .review/ JSON files - covers sigil_get_review_findings discovery, the JSON schema, etag-safe write-back, and the resolution workflow.
---

# Review Findings Skill

This skill teaches you how to read, interpret, and resolve adversarial-review findings stored in
the project's `.review/` store. The reviewer agent writes one JSON file per source file, mirroring
the project source tree:

```
.review/
  src/main/kotlin/
    Service.kt.json
    Config.kt.json
```

## Discovery: find the findings

**Primary path — `sigil_get_review_findings`.** A first-party bridge tool (allow-permission, no
parameters) that reads the entire `.review/` store in one call. It returns file paths, 1-based line
numbers, severities, statuses (`open` / `resolved` / `deleted`), and messages — including open,
resolved, and deleted findings. Check the `status` per finding and work the `open` ones.

**Fallback — glob the store yourself.** Only for environments where the bridge tools are
unavailable (e.g. running outside the Sigil-managed IDE): locate the JSON files with a
`.review/**/*.json` glob (`sigil_search_file` or a plain filesystem glob) and read each one.

## The JSON schema

Each store file holds a `formatVersion 1` document with an `etag` and the comment list:

```json
{
  "formatVersion": 1,
  "etag": "a1b2c3d4",
  "comments": [
    {
      "id": "cmt_a3f1c2d4",
      "startLine": 42,
      "endLine": 45,
      "comment": "N+1 query in loop — use JOIN FETCH or batch loading",
      "severity": "warning",
      "status": "open",
      "author": "ai-review",
      "createdAt": "2026-06-16T10:30:00Z",
      "revision": "abc123def456",
      "revisionLabel": "HEAD~3",
      "resolvedAt": null,
      "resolution": null
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `formatVersion` | int | Schema version (currently 1) |
| `etag` | string | Opaque version token for optimistic concurrency |
| `comments[].id` | string | Unique ID (`cmt_` + 12 hex chars) |
| `comments[].startLine` | int | 1-based start line |
| `comments[].endLine` | int | 1-based end line (≥ startLine) |
| `comments[].comment` | string | The review comment body |
| `comments[].severity` | string | `"info"`, `"warning"`, or `"error"` |
| `comments[].status` | string | `"open"`, `"resolved"`, or `"deleted"` |
| `comments[].author` | string | Who wrote it |
| `comments[].createdAt` | string | ISO 8601 timestamp (UTC) |
| `comments[].revision` | string | Git commit hash when comment was made |
| `comments[].resolvedAt` | string | ISO 8601 timestamp when resolved (null if open) |
| `comments[].resolution` | string | Description of how it was fixed (null if open) |

## Resolution workflow

1. **Navigate**: open the source file at `startLine` and read the flagged lines.
2. **Fix**: apply the necessary code change.
3. **Write back**: edit the JSON file by hand — there is NO bridge write-tool for `.review/`
   files, so this step is always manual JSON editing. Set `"status": "resolved"`, set `resolvedAt`
   (ISO 8601 UTC), and write a `resolution` description. Leave every other comment and field
   untouched.

Example resolution, before:

```json
{
  "status": "open",
  "resolvedAt": null,
  "resolution": null
}
```

After:

```json
{
  "status": "resolved",
  "resolvedAt": "2026-06-17T14:30:00Z",
  "resolution": "Fixed by adding JOIN FETCH to the query"
}
```

### Etag handling

When writing back a `.review/` JSON file, preserve the existing `etag` field exactly. Do NOT
modify or drop `etag` — the plugin manages this field for optimistic concurrency and detects
stale writes. Only update `status`, `resolvedAt`, and `resolution`.

## Tips

- Whether `.review/` is git-tracked depends on the project; the IDE change tracker excludes
  plugin-managed `.review/` files. Commit resolution changes only if your project tracks the
  directory.
- Comments with `"status": "deleted"` are soft-deleted — leave them alone.
- The plugin watches `.review/` and updates editor highlights automatically. Keep your writes
  valid JSON (no trailing commas, no comments) so the panel re-parses cleanly.
- If nearby fixes shifted the flagged lines (you fixed something else nearby), update
  `startLine`/`endLine` to the correct current values in the JSON file.