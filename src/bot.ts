// src/bot.ts
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
import Groq from "groq-sdk";

import { setupMessageLogger } from "./messageLoger";
import { buildMemoryBlock } from "./memory/buildMemoryBlock";
import { MERLIN_SYSTEM_PROMPT, MEMORY_USAGE_RULES } from "./system/system";
import { detectAndStoreTeaching } from "./utils/teachingDetector";

import {
  shouldSearchWeb,
  searchWebWithTavily,
} from "./utils/webSearch";

/* ------------------------------------------------------------------ */
/* Utility: strip ALL emojis except we later allow Merlin to send 💛   */
/* (but the model itself tends to inject emojis, so we sanitize here). */
/* ------------------------------------------------------------------ */
function stripEmojis(text: string): string {
  return text.replace(
    /[\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu,
    ""
  );
}

/* ------------------------------------------------------------------ */
/* Groq client + model selection                                      */
/* ------------------------------------------------------------------ */

const PRIMARY_MODEL = "llama-3.3-70b-versatile";
const FALLBACK_MODEL = "openai/gpt-oss-120b";

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY!,
});

/**
 * Heuristic: decide which model to *try first*.
 * - Use PRIMARY_MODEL for most things (fast & strong).
 * - Use FALLBACK_MODEL only when:
 *   - The question is long / multi-paragraph.
 *   - Or looks like “deep analysis / explanation” work.
 */
function chooseModel(rawText: string, memoryBlock: string): string {
  const text = rawText.toLowerCase();
  const lengthScore = rawText.length + memoryBlock.length;

  const deepKeywords = [
    "explica",
    "explícame",
    "explain",
    "analyze",
    "analiza",
    "dime en detalle",
    "detailed",
    "why",
    "por qué",
    "porque",
    "compar",
    "tradeoff",
    "matemática",
    "proof",
    "demostración",
  ];

  const isDeep =
    deepKeywords.some((k) => text.includes(k)) || lengthScore > 2500;

  // Most of the time we keep 70B; 120B is for “heavy” queries.
  if (isDeep) return FALLBACK_MODEL;
  return PRIMARY_MODEL;
}

/* ------------------------------------------------------------------ */
/* Discord client setup                                               */
/* ------------------------------------------------------------------ */

const BOT_TOKEN = process.env.DISCORD_LLM_BOT_TOKEN;

const client = new Client({
  intents: [
    GatewayIntentBits.GuildMessageTyping,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.MessageContent,
  ],
});

// @ts-ignore – extend client with commands
client.commands = new Collection();

/* Load slash commands (unchanged) */
const foldersPath = path.join(__dirname, "commands");
if (fs.existsSync(foldersPath)) {
  const commandFolders = fs.readdirSync(foldersPath);
  for (const folder of commandFolders) {
    const commandsPath = path.join(foldersPath, folder);
    if (!fs.existsSync(commandsPath)) continue;

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
          `[WARNING] The command at ${filePath} is missing "data" or "execute".`
        );
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* De-dupe messages (avoid double processing)                         */
/* ------------------------------------------------------------------ */

const processedMessages = new Map<string, number>();

setInterval(() => {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [id, ts] of processedMessages.entries()) {
    if (ts < oneHourAgo) processedMessages.delete(id);
  }
  console.log(
    `[CACHE] Cleaned old messages. Size: ${processedMessages.size}`
  );
}, 30 * 60 * 1000);

/* ------------------------------------------------------------------ */
/* Client events                                                      */
/* ------------------------------------------------------------------ */

client.once(Events.ClientReady, () => {
  console.log("Bot is online!");
  console.log(`Logged in as ${client.user?.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // @ts-ignore
  const command = interaction.client.commands.get(interaction.commandName);
  if (!command) {
    console.error(
      `No command matching ${interaction.commandName} was found.`
    );
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(error);
    const payload = {
      content: "There was an error while executing this command!",
      ephemeral: true,
    };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
  }
});

/* ------------------------------------------------------------------ */
/* Main message handler                                               */
/* ------------------------------------------------------------------ */

const messageHandler = async (message: Message) => {
  try {
    /* 1) ignore bots */
    if (message.author.bot) return;

    /* 2) dedupe */
    if (processedMessages.has(message.id)) {
      console.log(
        `[DUPLICATE] Skipping message ${message.id} from ${message.author.tag}`
      );
      return;
    }
    processedMessages.set(message.id, Date.now());

    console.log(
      `[PROCESSING] Message ${message.id} from ${message.author.tag}: "${message.content.slice(
        0,
        80
      )}..."`
    );

    const isDM = !message.guild;
    const botUser = client.user;
    if (!botUser) return;

    const contentLower = message.content.toLowerCase();

    /* 3) decide if Merlin should reply */
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
        contentLower.includes("merlina") ||
        contentLower.startsWith("merlina");

      if (mentionedMe || saidMerlin || saidMer || saidMerlina) {
        shouldAnswer = true;
      }
    }

    if (!shouldAnswer) {
      console.log("[SKIPPED] Not addressed to Merlin.");
      // Still log messages for memory logger via setupMessageLogger
      return;
    }

    /* 4) clean text (remove @mention) */
    const rawText = message.content.replace(/<@!?\d+>/g, "").trim();
    if (!rawText) {
      await message.reply(`¿Sí, ${message.author.username}?`);
      return;
    }

    /* 5) run teaching detector (facts + server lexicon) */
    const teachingResult = detectAndStoreTeaching(message);
    if (teachingResult) {
      if (teachingResult.kind === "user_fact") {
        console.log(
          `[FACT][STORED] user: ${teachingResult.targetUserId} key: ${teachingResult.key} value: ${teachingResult.value}`
        );
      } else if (teachingResult.kind === "server_term") {
        console.log(
          `[TEACHING] Stored server_term "${teachingResult.term}" for guild ${message.guildId}`
        );
      }
    }

    /* 6) optional web search */
    let webContext = "";

    if (shouldSearchWeb(rawText)) {
      console.log(
        `[WEB] Search triggered for message ${message.id}`
      );
      try {
        const web = await searchWebWithTavily(rawText, "general");
        if (web) {
          webContext = web;
          console.log(
            `[WEB] Got ${web.length} chars of context`
          );
        } else {
          console.log("[WEB] No useful results");
          await message.reply(
            stripEmojis(
              "Intenté buscar eso pero no encontré resultados confiables. " +
                "Puede que la info no esté disponible o que haya que reformular la pregunta."
            )
          );
          return;
        }
      } catch (err) {
        console.error("[WEB ERROR]", err);
        await message.reply(
          "Tuve problemas conectando con la búsqueda web. Intenta de nuevo más tarde."
        );
        return;
      }
    }

    /* 7) Build MEMORY BLOCK (RAG: messages, user_facts, profiles, server_lexicon) */
    const memoryBlock = await buildMemoryBlock(message);
    console.log("[MEMORY BLOCK] built.");

    /* 8) Compose messages for Groq */
    const messagesForGroq: { role: "system" | "user"; content: string }[] = [
      { role: "system", content: MERLIN_SYSTEM_PROMPT },
      { role: "system", content: MEMORY_USAGE_RULES },
      { role: "system", content: memoryBlock },
    ];

    if (webContext) {
      messagesForGroq.push({
        role: "system",
        content:
          "Información reciente obtenida de la web. Úsala para responder con precisión, " +
          "pero mantén tu estilo y personalidad de Merlin. Si algo no está claro, dilo honestamente:\n\n" +
          webContext,
      });
    }

    messagesForGroq.push({ role: "user", content: rawText });

    /* 9) Call Groq with model selection + fallback */
    console.time(`[GROQ-${message.id}]`);

    let modelToUse = chooseModel(rawText, memoryBlock);
    let completion;

    try {
      completion = await groq.chat.completions.create({
        model: modelToUse,
        messages: messagesForGroq,
        max_tokens: 512,
        temperature: 0.7,
      });
      console.log(
        `[MODEL] Using ${modelToUse} for message ${message.id}`
      );
    } catch (err: any) {
      console.error("[GROQ ERROR - first attempt]", err);

      // Try once with the other model, if available
      const alternateModel =
        modelToUse === PRIMARY_MODEL ? FALLBACK_MODEL : PRIMARY_MODEL;

      try {
        completion = await groq.chat.completions.create({
          model: alternateModel,
          messages: messagesForGroq,
          max_tokens: 512,
          temperature: 0.7,
        });
        console.log(
          `[MODEL] Fallback to ${alternateModel} for message ${message.id}`
        );
      } catch (err2: any) {
        console.error("[GROQ ERROR - fallback]", err2);

        if (err2?.status === 500) {
          await message.reply(
            "El servidor de Groq está teniendo problemas. Intenta de nuevo en un momento."
          );
        } else if (err2?.status === 429) {
          await message.reply(
            "Estamos al límite de peticiones por ahora. Prueba de nuevo en un rato."
          );
        } else {
          await message.reply(
            "Mi núcleo se bugueó un momento. Intenta otra vez."
          );
        }
        return;
      }
    }

    console.timeEnd(`[GROQ-${message.id}]`);

    const replyText =
      completion?.choices[0]?.message?.content?.trim() ??
      "Merlin intentó responder, pero algo salió mal.";

    const cleanedReply = stripEmojis(replyText);

    await message.reply(
      cleanedReply || "Estoy aquí, pero no pude generar una respuesta."
    );
    console.log(`[SUCCESS] Replied to message ${message.id}`);
  } catch (err) {
    console.error("[UNEXPECTED ERROR] in message handler:", err);
    try {
      if (!message.author.bot) {
        await message.reply(
          "Algo raro pasó con mi núcleo. Intenta de nuevo, por favor."
        );
      }
    } catch (replyErr) {
      console.error("[REPLY ERROR] Could not send error message:", replyErr);
    }
  }
};

/* Register message listener */
client.on(Events.MessageCreate, messageHandler);

/* Graceful shutdown */
process.on("SIGINT", () => {
  console.log("Shutting down gracefully (SIGINT)...");
  client.destroy();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Shutting down gracefully (SIGTERM)...");
  client.destroy();
  process.exit(0);
});

/* Setup logger + login */
setupMessageLogger(client);

client.login(BOT_TOKEN).catch((err) => {
  console.error("Failed to login:", err);
  process.exit(1);
});
