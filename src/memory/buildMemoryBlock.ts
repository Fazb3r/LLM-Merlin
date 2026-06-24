// src/memory/buildMemoryBlock.ts
import { Message } from "discord.js";
import {
  getRecentMessages,
  getUserProfile,
  getUserFacts,
  getServerDefinition,
} from "../data/db";

/* ============================================================
 *  RETURN TYPE
 * ============================================================ */

export interface MemoryBlockResult {
  /** System-message text: profile summary + user facts + server lexicon.
   *  Does NOT include recent conversation (those become proper LLM turns). */
  systemText: string;

  /** Recent channel messages formatted as proper LLM conversation turns.
   *  Each entry is ready to push directly into the messages[] array. */
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;

  /** The user's preferred name if one has been stored, or null. */
  preferredName: string | null;
}

/* ============================================================
 *  MAIN BUILDER
 * ============================================================ */

/**
 * Build all memory context needed to generate a response.
 *
 * Changes from old version:
 * - Returns a structured object instead of a flat string.
 * - Recent messages are now returned as proper LLM turns (conversationHistory)
 *   instead of being embedded as raw text inside the system prompt.
 * - preferredName is surfaced separately so bot.ts can inject a mandatory
 *   name override system message that the LLM cannot ignore.
 */
export async function buildMemoryBlock(message: Message): Promise<MemoryBlockResult> {
  const userId = message.author.id;
  const username = message.author.username;
  const channelId = message.channelId;
  const guildId = message.guild?.id ?? "DM";

  // Human-readable channel name
  let channelName = channelId;
  const channel: any = message.channel;
  if (channel && "name" in channel && typeof channel.name === "string") {
    channelName = channel.name;
  }

  // ── Long-term memory ──────────────────────────────────────────
  const profile = getUserProfile(userId);
  const facts = getUserFacts(userId, 10);

  // ── Short-term context ────────────────────────────────────────
  // Fetch DESC then reverse → chronological order
  const recentMessages = getRecentMessages(channelId, 20);
  recentMessages.reverse();

  // ── Server lexicon (if question looks like "what is X") ───────
  let serverDefinitionText = "";
  let termCandidate: string | null = null;

  const contentLower = message.content.toLowerCase().trim();

  const spanishMatch =
    contentLower.match(/^que es (.+?)\??$/i) ||
    contentLower.match(/^qué es (.+?)\??$/i);
  const englishMatch = contentLower.match(/^what is (.+?)\??$/i);

  if (spanishMatch) termCandidate = spanishMatch[1].trim();
  else if (englishMatch) termCandidate = englishMatch[1].trim();

  if (guildId !== "DM" && termCandidate) {
    const defRow = getServerDefinition(guildId, termCandidate);
    if (defRow) {
      const taughtBy = defRow.taught_by_username ?? defRow.taught_by ?? "alguien";
      serverDefinitionText = `- "${defRow.term}": ${defRow.definition} (taught by ${taughtBy})`;
    }
  }

  // ── Extract preferred name ─────────────────────────────────────
  const preferredNameFact = facts.find((f) => f.key === "preferred_name");
  const preferredName = preferredNameFact?.value ?? null;

  // ── Build system text (profile + facts + lexicon) ─────────────
  const lines: string[] = [];

  lines.push("[MEMORY BLOCK START]");
  lines.push("");
  lines.push(`User: ${username} (${userId})`);

  if (preferredName) {
    lines.push(
      `Preferred name: ${preferredName} — ALWAYS use this name when addressing this user. NEVER use "${username}" or any other identifier.`
    );
  }

  lines.push("");

  // Profile summary
  lines.push("User profile:");
  lines.push(profile?.summary?.trim() ?? "No profile available yet.");
  lines.push("");

  // User facts (excluding preferred_name — already surfaced above)
  const otherFacts = facts.filter((f) => f.key !== "preferred_name");
  lines.push("Known user facts:");
  if (otherFacts.length > 0) {
    for (const fact of otherFacts) {
      lines.push(`- ${fact.key}: ${fact.value}`);
    }
  } else {
    lines.push("- No specific facts stored yet.");
  }
  lines.push("");

  // Server lexicon
  if (serverDefinitionText) {
    lines.push("Server-specific concepts:");
    lines.push(serverDefinitionText);
    lines.push("");
  }

  lines.push("[MEMORY BLOCK END]");
  const systemText = lines.join("\n");

  // ── Build conversation history as proper LLM turns ────────────
  // This replaces the old "Recent conversation in #channel:" flat text dump.
  // The LLM gets actual turn structure it can reason about.
  const conversationHistory: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const msg of recentMessages) {
    conversationHistory.push({
      role: "user",
      content: `[${msg.username}]: ${msg.content}`,
    });
  }

  return { systemText, conversationHistory, preferredName };
}
