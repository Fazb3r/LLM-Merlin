// src/memory/buildMemoryBlock.ts
import { Message } from "discord.js";
import {
  getRecentMessages,
  getUserProfile,
  getUserFacts,
  getServerDefinition,
  
} from "../data/db";

/**
 * Build a MEMORY BLOCK string for the given Discord message.
 * This will be injected into the LLM prompt as a system message.
 */
export async function buildMemoryBlock(message: Message): Promise<string> {
  const userId = message.author.id;
  const username = message.author.username;
  const channelId = message.channelId;
  const guildId = message.guild?.id ?? "DM";

  // Try to get a human-readable channel name (fallback to id)
  let channelName = channelId;
  const channel: any = message.channel;
  if (channel && "name" in channel && typeof channel.name === "string") {
    channelName = channel.name;
  }

  // ----- Long-term memory -----
  const profile = getUserProfile(userId);
  const facts = getUserFacts(userId, 8); // last 8 facts, tune as you like

  // ----- Short-term context (recent messages in this channel) -----
  const recentMessages = getRecentMessages(channelId, 20); // tune 15–30

  // We fetched DESC; reverse to chronological for nicer reading
  recentMessages.reverse();

  // ----- Server-specific concept (if question looks like "what is X") -----
  let serverDefinitionText = "";
  let termCandidate: string | null = null;

  const contentLower = message.content.toLowerCase().trim();

  // VERY simple detection to start; we can improve later.
  // Examples:
  //  "que es una puchaina, merlin?"
  //  "qué es una puchaina?"
  //  "what is a puchaina?"
  const spanishMatch = contentLower.match(/^que es (.+?)\??$/i) ||
                       contentLower.match(/^qué es (.+?)\??$/i);
  const englishMatch = contentLower.match(/^what is (.+?)\??$/i);

  if (spanishMatch) {
    termCandidate = spanishMatch[1].trim();
  } else if (englishMatch) {
    termCandidate = englishMatch[1].trim();
  }

  if (guildId !== "DM" && termCandidate) {
    const defRow = getServerDefinition(guildId, termCandidate);
    if (defRow) {
      serverDefinitionText = `- "${defRow.term}": ${defRow.definition}`;
    }
  }

  // ----- Build sections -----
  const lines: string[] = [];

  lines.push("[MEMORY BLOCK START]");
  lines.push("");
  lines.push(`User: ${username} (${userId})`);
  lines.push("");

  // Profile
  lines.push("User profile:");
  if (profile?.summary) {
    lines.push(profile.summary.trim());
  } else {
    lines.push("No profile available yet.");
  }
  lines.push("");

  // Facts
  lines.push("Known user facts:");
  if (facts.length > 0) {
    for (const fact of facts) {
      lines.push(`- ${fact.key}: ${fact.value}`);
    }
  } else {
    lines.push("- No specific facts stored yet.");
  }
  lines.push("");

  // Recent conversation
  lines.push(`Recent conversation in #${channelName}:`);
  if (recentMessages.length > 0) {
    for (const msg of recentMessages) {
      // we only have ISO timestamp; keep it simple for now
      const time = msg.created_at ?? "";
      lines.push(`[${time}] ${msg.username}: ${msg.content}`);
    }
  } else {
    lines.push("(no previous messages logged for this channel).");
  }
  lines.push("");

  // Server lexicon (if any)
  if (serverDefinitionText) {
    lines.push("Server-specific concepts:");
    lines.push(serverDefinitionText);
    lines.push("");
  }

  lines.push("[MEMORY BLOCK END]");

  return lines.join("\n");
}
