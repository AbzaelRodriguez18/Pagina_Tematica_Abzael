
// Sigil persona bridge — plugin-managed, overwritten on each Sigil connect.
// Delivers the Sigil persona as a SYSTEM PROMPT via the before_agent_start
// hook (per-turn, cache-stable) instead of per-message text injection.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export default function (pi) {
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const personaPath = join(ctx.cwd, ".pi", "sigil-persona.md");
      const persona = readFileSync(personaPath, "utf8").trim();
      if (!persona) return;
      // Idempotent: skip if a previous handler (or our prior write) already
      // delivered this exact persona text into the chained system prompt.
      if (event.systemPrompt.includes(persona)) return;
      return { systemPrompt: event.systemPrompt + "\n\n" + persona };
    } catch (e) {
      // No persona file / unreadable -> deliver nothing, never break the turn.
      return;
    }
  });
}
