
require("dotenv").config();
import path from "path";
import fs from "fs";
import {
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  Message,
} from "discord.js";
import { setupMessageLogger } from "./messageLoger";
import Groq from "groq-sdk";
import { buildMemoryBlock } from "./memory/buildMemoryBlock";
import { MERLIN_SYSTEM_PROMPT, MEMORY_USAGE_RULES } from "./system/system";
import { detectAndStoreTeaching } from "./utils/teachingDetector";

import {
  shouldSearchWeb,
  searchWebWithTavily,
  looksLikeCurrentEventQuestion,
  getSuggestedSearchMessage,
} from "./utils/webSearch";

// Utilidad para eliminar emojis de cualquier respuesta
function stripEmojis(text: string): string {
  return text.replace(
    /[\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu,
    ""
  );
}

// Load environment variables
const BOT_TOKEN = process.env.DISCORD_LLM_BOT_TOKEN;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY!,
});

// Create an instance of Client and set the intents to listen for messages.
const client = new Client({
  intents: [
    GatewayIntentBits.GuildMessageTyping,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.MessageContent,
  ],
});

// Track processed messages with timestamp to prevent duplicates
const processedMessages = new Map<string, number>();

// Clean up old message IDs every 30 minutes
// Only remove messages older than 1 hour
setInterval(() => {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [messageId, timestamp] of processedMessages.entries()) {
    if (timestamp < oneHourAgo) {
      processedMessages.delete(messageId);
    }
  }
  console.log(
    `Cleaned up old messages. Current cache size: ${processedMessages.size}`
  );
}, 30 * 60 * 1000);

// @ts-ignore – extensión custom
client.commands = new Collection();

const foldersPath = path.join(__dirname, "commands");
const commandFolders = fs.readdirSync(foldersPath);

for (const folder of commandFolders) {
  const commandsPath = path.join(foldersPath, folder);
  const commandFiles = fs
    .readdirSync(commandsPath)
    .filter((file) => file.endsWith(".js"));

  for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    if ("data" in command && "execute" in command) {
      // @ts-ignore
      client.commands.set(command.data.name, command);
    } else {
      console.log(
        `[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`
      );
    }
  }
}

//Choose model
function chooseModel(userMessage: string, memoryBlock: string): string {
    const lower = userMessage.toLowerCase();

    // 1) Simple or casual conversation → smaller model
    if (lower.length < 80 && !lower.includes("explain") && !lower.includes("why")) {
        return "llama-3.1-8b-instant";
    }

    // 2) Deep reasoning request
    if (
        lower.includes("explain") ||
        lower.includes("detailed") ||
        lower.includes("analysis") ||
        lower.includes("razona") ||
        lower.includes("profundo")||
        lower.includes("explica")||
        lower.includes("investiga")
        
    ) {
        return "llama-3.3-70b-versatile";
    }

    // 3) If memory is heavy → use a bigger model for coherence
    if (memoryBlock.length > 2000) {
        return "llama-3.3-70b-versatile";
    }

    // Default
    return "llama-3.1-8b-instant";
}


// Once the WebSocket is connected, log a message to the console.
client.once(Events.ClientReady, () => {
  console.log("Bot is online!");
  console.log(`Logged in as ${client.user?.tag}`);
});

// Main message handler
const messageHandler = async (message: Message) => {
  try {
    // 1) Ignore bot messages (including Merlin herself)
    if (message.author.bot) return;

    // 2) Prevent processing the same message twice with timestamp check
    if (processedMessages.has(message.id)) {
      console.log(
        `[DUPLICATE BLOCKED] Message ${message.id} from ${message.author.tag}`
      );
      return;
    }

    // Mark as processed immediately with timestamp
    processedMessages.set(message.id, Date.now());
    console.log(
      `[PROCESSING] Message ${message.id} from ${
        message.author.tag
      }: "${message.content.substring(0, 50)}..."`
    );

    const isDM = !message.guild;
    const botUser = client.user;
    if (!botUser) return;

    const contentLower = message.content.toLowerCase();

    // 3) Decide if Merlin should answer
    let shouldAnswer = false;

    if (isDM) {
      shouldAnswer = true;
    } else {
      const mentionedMe = message.mentions.has(botUser);
      const saidMerlin = contentLower.includes("merlin");
      const saidMer =
        contentLower.startsWith("mer ") ||
        contentLower.startsWith("mer,") ||
        contentLower.startsWith("mer:") ||
        contentLower === "mer";
      const saidMerlina =
        contentLower.includes("merlina") || contentLower.startsWith("merlina");

      if (mentionedMe || saidMerlin || saidMer || saidMerlina) {
        shouldAnswer = true;
      }
    }

    if (!shouldAnswer) {
      console.log(`[SKIPPED] Not addressed to Merlin`);
      return;
    }

    // 4) Clean the user text (remove the mention tag if present)
    const rawText = message.content.replace(/<@!?\d+>/g, "").trim();
    if (!rawText) {
      await message.reply(`¿Sí, ${message.author.username}?`);
      return;
    }

    // 4.5) Teaching detector – user teaching Merlin facts or terms
    // This already writes to the DB (user_facts / server_lexicon).
    const teachingResult = detectAndStoreTeaching(message);
    if (teachingResult) {
      // Optional: you could send a subtle acknowledgement or log more here.
      // For now we only log in the detector and continue the normal reply.
      console.log(
        `[TEACHING] Detected ${teachingResult.kind} from ${message.author.id}`
      );
    }

    console.time(`[GROQ-${message.id}]`);

    // 5) Check if web search is needed
    let webContext = "";

    if (shouldSearchWeb(rawText)) {
      console.log(
        `[WEB SEARCH] Explicit search detected for message ${message.id}`
      );
      try {
        const web = await searchWebWithTavily(rawText, "general");
        if (web) {
          webContext = web;
          console.log(
            `[WEB SEARCH] Success - got ${web.length} chars of context`
          );
        } else {
          console.log(`[WEB SEARCH] No results found`);
          await message.reply(
            stripEmojis(
              "Intenté buscar eso pero no encontré resultados confiables. " +
                "Puede que la información no esté disponible o que necesite reformular la búsqueda."
            )
          );
          return;
        }
      } catch (searchErr) {
        console.error(`[WEB SEARCH ERROR]`, searchErr);
        await message.reply(
          "Tuve problemas conectando con la búsqueda web. Intenta de nuevo."
        );
        return;
      }
    }

    // 6) Build messages and MEMORY BLOCK for Groq (RAG)
    const memoryBlock = await buildMemoryBlock(message);

    const messages: { role: "system" | "user"; content: string }[] = [
      { role: "system", content: MERLIN_SYSTEM_PROMPT },
      { role: "system", content: MEMORY_USAGE_RULES },
      { role: "system", content: memoryBlock },
    ];

    if (webContext) {
      messages.push({
        role: "system",
        content:
          "Información reciente obtenida de la web. Úsala para responder con precisión, " +
          "pero mantén tu estilo y personalidad de Merlin. Si algo no está claro o falta info, dilo honestamente:\n\n" +
          webContext,
      });
    }

    messages.push({ role: "user", content: rawText });

    // 7) Call Groq
const chosenModel = chooseModel(rawText, memoryBlock);
let completion;

try {
  console.log(
    `[MODEL] Using ${chosenModel} for message ${message.id} from ${message.author.tag}`
  );

  completion = await groq.chat.completions.create({
    model: chosenModel,
    messages,
    max_tokens: 512,
    temperature: 0.7,
  });
} catch (groqErr: any) {
  console.error(`[GROQ ERROR]`, groqErr);

  // If rate-limited and we were using a heavier model, fallback to 8B instant
  if (groqErr?.status === 429 && chosenModel !== "llama-3.1-8b-instant") {
    console.warn(
      `[MODEL FALLBACK] Rate limit on ${chosenModel}. Retrying with llama-3.1-8b-instant for message ${message.id}`
    );

    try {
      completion = await groq.chat.completions.create({
        model: "llama-3.1-8b-instant",
        messages,
        max_tokens: 512,
        temperature: 0.7,
      });
    } catch (fallbackErr: any) {
      console.error(`[GROQ FALLBACK ERROR]`, fallbackErr);
      await message.reply(
        "Demasiadas peticiones para ahora mismo. Dame un ratito y luego lo intentamos de nuevo."
      );
      return;
    }
  } else if (groqErr?.status === 500) {
    await message.reply(
      "El servidor de Groq está teniendo problemas. Dame un momento e intenta de nuevo."
    );
    return;
  } else if (groqErr?.status === 429) {
    await message.reply(
      "Demasiadas peticiones. Espera un momento antes de intentar de nuevo."
    );
    return;
  } else {
    await message.reply(
      "Mi núcleo se bugueó un segundo. Intenta otra vez."
    );
    return;
  }
}

    console.timeEnd(`[GROQ-${message.id}]`);

    const replyText =
      completion.choices[0]?.message?.content?.trim() ??
      "Merlin tried to answer but something went wrong.";

    const cleanedReply = stripEmojis(replyText);

    // 8) Send the reply
    await message.reply(
      cleanedReply || "I am here, but I was unable to compose a response."
    );
    console.log(`[SUCCESS] Replied to message ${message.id}`);
  } catch (err) {
    console.error(`[UNEXPECTED ERROR] in message handler:`, err);
    try {
      if (!message.author.bot) {
        await message.reply(
          "Mi núcleo se bugueó un segundo. Intenta otra vez."
        );
      }
    } catch (replyErr) {
      console.error(`[REPLY ERROR] Could not send error message:`, replyErr);
    }
  }
};

// Register the event listener only once
client.on(Events.MessageCreate, messageHandler);

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("Shutting down gracefully...");
  client.destroy();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Shutting down gracefully...");
  client.destroy();
  process.exit(0);
});

// Start logger + bot
setupMessageLogger(client);

client.login(BOT_TOKEN).catch((err) => {
  console.error("Failed to login:", err);
  process.exit(1);
});
