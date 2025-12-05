// src/messageLogger.ts
import { Client, Message, Events } from "discord.js";
import { insertMessage } from "../src/data/db";

export function setupMessageLogger(client: Client) {
client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return; // Ignore bot messages

    try {
    insertMessage.run(
        message.author.id,
        message.author.username,
        message.channelId,
        message.content
    );
} catch (err) {
    console.error("Error inserting message:", err);
    }
});

console.log("Message logger active");
}
