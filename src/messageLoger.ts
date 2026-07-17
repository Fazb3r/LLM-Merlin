// src/messageLoger.ts
import { Client, Message, Events } from "discord.js";
import { insertMessage } from "./data/db"; 

export function setupMessageLogger(client: Client) {
  client.on(Events.MessageCreate, async (message: Message) => {
    // Ignore other bots, but allow our own bot's messages to be logged for context
    if (message.author.bot && message.author.id !== client.user?.id) return;

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
