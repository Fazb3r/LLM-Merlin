// src/utils/serverStyleLearner.ts
//
// Server Style Learning — Markov-inspired cultural awareness.
//
// Periodically reads the last N messages from all channels and uses an LLM
// to extract:
//   - Server-native slang and what it means
//   - Recurring topics the community talks about
//   - Member dynamics (who teases who, notable pairs, etc.)
//   - Common reaction patterns (jhdjsk = flustered, XDDDD = laughing, etc.)
//   - Bilingual / code-switching patterns
//
// The result is stored in the `server_lore` table and injected into every
// LLM call via buildMemoryBlock — giving Merlin passive cultural awareness
// of the server without requiring explicit "teach" commands.

import Groq from "groq-sdk";
import { getRecentMessagesAll, getLatestServerLore, replaceServerLore } from "../data/db.js";

const ANALYSIS_MODEL = "llama-3.3-70b-versatile";

/* ============================================================
 *  IN-MEMORY CACHE
 * ============================================================ */

// Key: guildId, Value: the culture summary string
const cultureCache = new Map<string, string>();

/**
 * Returns the current server culture context for injection into the system prompt.
 * Falls back to empty string if not yet learned.
 */
export function getServerCultureContext(guildId: string): string {
  if (!cultureCache.has(guildId)) {
    loadCultureFromDb(guildId);
  }
  return cultureCache.get(guildId) ?? "";
}

/**
 * On bot startup, load the most recently saved culture from the DB into memory
 * so the first responses already have culture context before the first analysis run.
 */
export function loadCultureFromDb(guildId: string): void {
  const row = getLatestServerLore(guildId);
  if (row) {
    cultureCache.set(guildId, row.description);
    console.log(`[STYLE LEARNER] Loaded saved culture for guild ${guildId} from DB (${row.created_at}).`);
  } else {
    console.log(`[STYLE LEARNER] No saved culture found for guild ${guildId} — will learn after first run.`);
  }
}

/* ============================================================
 *  MAIN ANALYSIS
 * ============================================================ */

/**
 * Analyzes recent server messages and extracts a culture profile.
 * Saves to DB and updates in-memory cache.
 * Safe to call periodically (every 6 hours).
 */
export async function runServerStyleLearning(guildId: string, groq: Groq): Promise<void> {
  console.log("[STYLE LEARNER] Starting server style analysis...");

  try {
    // Fetch last 1500 messages across all channels (logged by messageLoger.ts)
    const messages = getRecentMessagesAll(1500);

    if (messages.length < 30) {
      console.log(`[STYLE LEARNER] Only ${messages.length} messages logged — skipping (need ≥ 30).`);
      return;
    }

    // Reverse DESC→ASC for chronological order
    messages.reverse();

    // Format as a readable conversation log
    // Truncate to roughly 8 000 chars (≈ 1 500–2 000 tokens) to stay within context
    const rawLog = messages.map(m => `[${m.username}]: ${m.content}`).join("\n");
    const truncatedLog = rawLog.length > 8000 ? rawLog.slice(rawLog.length - 8000) : rawLog;

    const systemPrompt = `Eres un analizador de cultura de servidores de Discord.
Tu tarea: leer los mensajes recientes y extraer la cultura ESPECÍFICA de ESTE servidor.

Extrae y devuelve exactamente estas 5 secciones en español, en formato de bullet points:

## Slang y términos propios
- [término]: [qué significa en este servidor]
(Solo términos no estándar o con significado especial aquí)

## Temas recurrentes
- [tema y contexto breve]
(¿De qué hablan con más frecuencia? Juegos, series, música, etc.)

## Dinámicas entre miembros
- [relación o dinámica notable]
(¿Quién molesta a quién? ¿Hay grupos? ¿Inside jokes entre personas específicas?)

## Patrones de reacción
- [patrón]: [qué significa]
(Cómo expresan emociones — "jhdjsk", "XDDD", "zungaa", etc.)

## Estilo de comunicación
- [observación sobre el tono, humor, idioma]

Máximo 250 palabras. Solo incluye lo que realmente aparece en los mensajes. No inventes nada.`;

    const response = await groq.chat.completions.create({
      model: ANALYSIS_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Analiza estos ${messages.length} mensajes del servidor:\n\n${truncatedLog}`,
        },
      ],
      max_tokens: 600,
      temperature: 0.2, // Low temperature — factual extraction, not creative
    });

    const cultureSummary = response.choices[0]?.message?.content?.trim();
    if (!cultureSummary) {
      console.warn("[STYLE LEARNER] LLM returned empty response — skipping save.");
      return;
    }

    // Persist to DB (replaces any previous auto-learned entry for this guild)
    replaceServerLore(guildId, cultureSummary);

    // Update in-memory cache
    cultureCache.set(guildId, cultureSummary);

    console.log(`[STYLE LEARNER] Culture updated for guild ${guildId}. Preview:\n${cultureSummary.slice(0, 200)}...`);

  } catch (err) {
    console.error("[STYLE LEARNER] Error during analysis:", err);
  }
}
