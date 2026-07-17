// src/messageLoger.ts
import { Client, Message, Events } from "discord.js";
import { insertMessage } from "./data/db"; 

export function setupMessageLogger(client: Client) {
  // Channels excluded from logging — bot-command channels that would pollute the LLM context
  const BLOCKED_CHANNEL_IDS = new Set([
    "1525012423063502968", // Mudae bot channel
  ]);

  client.on(Events.MessageCreate, async (message: Message) => {
    // Ignore other bots, but allow our own bot's messages to be logged for context
    if (message.author.bot && message.author.id !== client.user?.id) return;

    // Skip blocked channels entirely
    if (BLOCKED_CHANNEL_IDS.has(message.channelId)) return;

    try {
      insertMessage.run(
        message.author.id,
        message.author.username,
        message.channelId,
        message.content
      );
      console.log("[LOGGER] Saved message from", message.author.username);
    } catch (err) {
      console.error("❌ Error inserting message:", err);
    }
  });


  console.log("📝 Message logger active");
}
