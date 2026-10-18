---
name: interview
description: Use the interview tool correctly to gather structured user input through an interactive form (radio, checkbox, text, image-upload questions with media, code blocks, and pre-selected recommendations). Use when choosing between approaches, gathering requirements before implementation, exploring design tradeoffs, or whenever decisions have multiple dimensions; covers the exact questions JSON schema, recommendation semantics, validation rules, and response handling.
---

# Interview Skill

The `interview` tool opens a rich form and **blocks until the user submits, cancels, or the form times out**, then returns the answers. In Sigil the form renders natively inside the IDE (no browser tab opens). A well-built form replaces several rounds of chat questions with one interaction — but only if the questions JSON is valid. This skill is the parameter reference; follow it to get the form right on the first try.

## When to interview (and when not to)

**Use it proactively when:**
- Choosing between 2+ approaches with real tradeoffs (architecture, libraries, storage, migration strategy)
- Gathering requirements before implementation (scope, constraints, priorities, consumers)
- Reviewing a plan or design before writing code
- Several related decisions can be captured in one pass (batch them — see Authoring guidance)

**Prefer plain chat when:**
- A single yes/no or trivial confirmation — just ask in one sentence
- The answer is discoverable from the codebase or docs — research first; never ask what you can look up
- The user is mid-thought and needs to brainstorm freeform, not fill a form

**If cancelled:** the tool result tells you what to do — partial answers → proceed with them; no answers → proceed with your best judgment using the recommended options; **do not immediately re-ask** unless a question is truly blocking.

## Invocation

Call the `interview` tool with:

| Param | Type | Notes |
| ------ | ------ | ------- |
| `questions` | string | **Inline JSON string (preferred)** — or a path to a `.json` questions file (relative paths resolve against cwd, `~` expands) or a saved-snapshot `.html` file |
| `timeout` | number | Seconds before auto-timeout. Default 600. The countdown resets on user activity |
| `verbose` | boolean | Debug logging |
| `theme` | object | `{ mode: "auto"\|"light"\|"dark", name?, lightPath?, darkPath?, toggleHotkey? }` — rarely needed |

Pass clean JSON. The tool auto-repairs minor LLM slips (code fences, trailing commas, `//` comments, smart quotes), but a structurally wrong payload (bare array root, missing `questions`) is rejected outright.

## Questions JSON — the shape

```json
{
  "title": "Optional form title",
  "description": "Optional guidance shown at the top — e.g. 'Review my suggestions and adjust as needed'",
  "questions": [ { ... } ]
}
```

**The root must be an object** containing a non-empty `questions` array. A bare array `[...]` is rejected. Every question needs a unique string `id` (used as the key in the structured response — make it meaningful, e.g. `storage_backend`, not `q1`).

## Question fields

| Field | Applies to | Description |
| ------ | ----------- | ------------- |
| `id` | all | Unique string identifier (required) |
| `type` | all | `single` (radio), `multi` (checkbox), `text` (textarea), `image` (file upload), `info` (non-interactive panel) |
| `question` | all | Question text (required — do not use `label` or `description` for this) |
| `options` | `single`, `multi` only | Non-empty array; strings or rich objects `{ label, content? }`. **Forbidden** on `text`/`image`/`info` |
| `recommended` | `single`, `multi` | Option label (single) or array of labels (multi). Must exactly match an existing option label |
| `conviction` | with `recommended` | `"strong"` (very confident) or `"slight"` (unsure — badge shown but **not** pre-selected) |
| `weight` | all | `"critical"` (prominent card) or `"minor"` (compact card) |
| `context` | all | Help text shown below the question — put your reasoning here |
| `content` | all | Code/markdown block shown above the options (see below) |
| `media` | all | Image, chart, mermaid, table, or html block (see below) |

`info` questions are context panels: no input, skipped during keyboard navigation, excluded from responses. Use them to give the user the background needed to answer the real questions.

## Recommendations — `recommended` / `conviction` / `weight`

**Always set `recommended` when you have a defensible preference, and explain it in `context`** — the badge plus your reasoning is what makes the form fast to answer ("Review my suggestions and adjust as needed" in the top-level `description` helps).

- Omit `conviction` → normal recommendation: "Recommended" badge + pre-selected
- `"strong"` → same, for decisions you are very confident about
- `"slight"` → badge shown but NOT pre-selected — use when unsure or when the choice is genuinely the user's taste

Use `weight: "critical"` for the 1-2 decisions that really matter, `weight: "minor"` for low-stakes preferences — don't mark everything critical.

**Option-level alternative** (cannot be mixed with question-level `recommended`): give rich options `recommended: true` and optional `conviction`:

```json
{
  "id": "api_style", "type": "single", "question": "API style?",
  "options": [
    { "label": "REST", "recommended": true, "conviction": "strong",
      "content": { "source": "GET /orders/123", "lang": "http" } },
    { "label": "gRPC", "content": { "source": "rpc GetOrder(OrderId)", "lang": "proto" } }
  ]
}
```

Rules the validator enforces here: single-select allows exactly **one** recommended option; all recommended options in a question must share the same `conviction`; `conviction` without `recommended` is an error.

## Content blocks (`content`)

Shown above the options (or below the question text for `text`/`info`). Fields: `source` (required), `lang`, `file`, `lines`, `highlights` (array of line numbers), `title`, `showSource`.

- `lang: "md"` or `"markdown"` → rendered as a **Markdown preview** by default; `showSource: true` shows raw Markdown instead
- Any other `lang` → rendered as raw code; `lines`/`highlights` annotate code only
- `showSource` is only valid with `md`/`markdown`

Use content blocks to show the actual code/diff/design being decided on — a choice between two implementations is far easier with both snippets inline. `lang: "diff"` renders diffs.

## Media blocks (`media`)

Single object or array. All types accept `caption` and `position` (`"above"` default, `"below"`, `"side"`).

| Type | Required fields |
| ------ | ----------------- |
| `image` | `src` (local path, URL, or data URI), optional `alt`, `maxHeight` |
| `chart` | `chart: { type, data, options? }` (Chart.js — bar, line, pie, …) |
| `mermaid` | `mermaid: "graph LR\n..."` |
| `table` | `table: { headers: [...], rows: [[...]], highlights?: [rowIndex] }` |
| `html` | `html: "<div>...</div>"` |

Tables are great for side-by-side option comparisons (benchmarks, pricing matrices) with `highlights` marking the recommended row.

## Validation rules — checklist before calling

The tool validates and rejects the whole payload on any violation. Common failures:

1. Root is an **array** instead of `{ "questions": [...] }` — most common mistake
2. Missing `questions` array, or empty
3. `type: "select"` — use `"single"`
4. Using `label`/`description` instead of `question` for the question text
5. `options` on a `text`/`image`/`info` question, or missing on `single`/`multi`
6. `recommended` not exactly matching an option label (single-select takes one label; multi takes an array)
7. `conviction` without `recommended`; mixing question-level and option-level recommendations
8. Duplicate `id`s
9. Legacy `code`/`codeBlock` fields — use `content`
10. `content.source` missing; `lines`/`highlights` on markdown content; `showSource` on non-markdown content
11. `media` type present but its required payload missing (`src` / `chart.data` / `mermaid` / `table.headers`+`rows` / `html`)

**Image limits:** max 12 images per submission, 5 MB and 4096×4096 each, PNG/JPG/GIF/WebP.

## Reading the response

The tool result status tells you what happened:

- **completed** — bulleted `- <question>: <answer> [attachments: <paths>]` plus a structured JSON array `[{ id, question, type, value, attachments? }]`. Use the structured `id`-keyed data in your work. Single/multi answers may carry a user note (`{ option, note }`) from the optional clarification field.
- **cancelled with partial answers** — proceed with the answered items; use best judgment for the rest. Do not re-ask immediately.
- **cancelled with no answers** — proceed with your best judgment; use recommended options where specified. Do not ask for clarification unless truly necessary.
- **timeout** — same as cancelled-partial, plus the questions were saved to `~/.pi/interview-recovery/` (path is in the result). Mention the recovery path if the user wants to retry.
- **aborted** — the session was aborted; stop the flow that needed the answers.

Image answers arrive as file paths — display them by reading the file directly.

## Authoring guidance

- **Batch 3–8 related questions** per form. One giant 15-question form is worse than two focused ones. Split follow-ups into a second form after processing the first round.
- **Order:** context (`info` panels) first → critical decisions → low-stakes preferences last.
- **One decision per question.** Split "stack + hosting + timeline" into three questions.
- `single` = exactly one choice; `multi` = any subset (state "select all that apply" in `context`).
- For `text` questions, `context` should say what a good answer looks like.
- Include an `info` panel when the user needs background (current architecture, constraints found in the codebase) to answer well.
- Set `timeout` deliberately: default 600s is fine for most; longer (e.g. 1200) for big design reviews the user may step away from.
- If other agents are running interviews concurrently, later forms queue and are offered as a link instead of stealing focus — normal behavior, not an error.

## Worked example

```json
{
  "title": "Design review: report exports",
  "description": "Review my suggestions and adjust as needed.",
  "questions": [
    {
      "id": "context", "type": "info", "question": "Current state",
      "context": "Exports run in-process today; reports over ~50MB time out. No queue exists yet.",
      "media": { "type": "mermaid", "mermaid": "graph LR\n  UI[Web UI] --> API[API server] --> DB[(Postgres)]" }
    },
    {
      "id": "execution", "type": "single", "weight": "critical",
      "conviction": "strong", "recommended": "Background worker queue",
      "question": "How should export execution run?",
      "context": "Recommend the queue: it fixes the timeout for large reports and the codebase already has Redis. Sync would keep the stack simple but does not fix the timeout.",
      "options": ["Background worker queue", "Keep synchronous in-process", "Serverless functions"]
    },
    {
      "id": "formats", "type": "multi",
      "question": "Which export formats ship in v1?",
      "context": "Select all that apply",
      "options": ["CSV", "XLSX", "PDF", "JSON"],
      "recommended": ["CSV", "XLSX"]
    },
    {
      "id": "retention", "type": "single", "weight": "minor",
      "question": "How long are generated files kept?",
      "options": ["24 hours", "7 days", "30 days"],
      "recommended": "7 days"
    },
    {
      "id": "constraints", "type": "text",
      "question": "Any constraints I should know about?",
      "context": "Compliance limits, budget caps, deadlines, or integrations the design must respect"
    }
  ]
}
```

## In this environment (Sigil)

The interview form renders natively inside the IDE as an interactive card — no browser window opens and no URL handling is needed. The tool call returns when the user submits (or cancels/times out). Related but separate tools: `web_search`'s curator and `session_ask`-style prompts are different flows — this skill covers only the `interview` tool.