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
import { detectFactWithLLM } from "./memory/factDetector";
import { insertUserFact } from "./data/db";

import {
  shouldSearchWeb,
  searchWebWithTavily,
  looksLikeCurrentEventQuestion,
  getSuggestedSearchMessage,
} from "./utils/webSearch";

/* -------------------------------------------------------------------------- */
/*  Emoji handling                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Remove all emojis except the yellow heart 💛.
 */
function stripEmojisExceptYellowHeart(text: string): string {
  const placeholder = "__YELLOW_HEART__";

  // Temporarily protect 💛
  const protectedText = text.replace(/💛/g, placeholder);

  // Remove all other emojis
  const withoutEmoji = protectedText.replace(
    /[\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu,
    ""
  );

  // Restore 💛
  return withoutEmoji.replace(new RegExp(placeholder, "g"), "💛");
}

/* -------------------------------------------------------------------------- */
/*  Environment & Groq setup                                                  */
/* -------------------------------------------------------------------------- */

const BOT_TOKEN = process.env.DISCORD_LLM_BOT_TOKEN;

const MAIN_MODEL =
  process.env.GROQ_MODEL_MAIN ||
  process.env.GROQ_MODEL ||
  "llama-3.3-70b-versatile";

// Secondary model used for complex or deep queries.  While the primary model
// (llama‑3.3‑70b‑versatile) is generally faster, a larger model such as
// `openai/gpt‑oss‑120b` can produce more nuanced answers.  We reference an
// environment variable so deployments can override the default without
// changing code.  If unspecified, we fall back to the 120b model name
// explicitly.
const SECONDARY_MODEL =
  process.env.GROQ_MODEL_SECONDARY ||
  "openai/gpt-oss-120b";

const LIGHT_MODEL = process.env.GROQ_MODEL_LIGHT || "llama-3.1-8b-instant";

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY!,
});

/**
 * Detect whether the user's query requires a more in‑depth or nuanced
 * response.  Longer or more open‑ended questions benefit from the larger
 * model, whereas short factual queries can be handled by the default model.
 *
 * The heuristic looks for the presence of certain keywords (e.g. "why",
 * "explain", "impact", "significance", etc.) and considers the length of
 * the input.  These rules can be tuned over time as needed without
 * introducing additional dependencies.
 *
 * @param text The cleaned user message
 * @returns true if the query is considered deep/complex
 */
function isDeepQuery(text: string): boolean {
  const lower = text.toLowerCase();
  const deepKeywords = [
    "why",
    "explain",
    "impact",
    "consequence",
    "analysis",
    "philosophy",
    "significance",
    "meaning",
    "cause",
    "context",
    "background",
    "deep",
  ];

  // If any deep keyword appears in the message, consider it a deep query
  for (const kw of deepKeywords) {
    if (lower.includes(kw)) return true;
  }

  // Long messages are more likely to require nuanced responses
  if (text.length > 180) return true;
  if (text.split(/\s+/).length > 30) return true;

  return false;
}

/**
 * Detect whether the user's query is a direct factual question.  A factual
 * question usually begins with interrogative words (who, what, where, when,
 * how many, etc.) and tends to be relatively short.  This heuristic allows
 * us to route these queries to the primary model without invoking the
 * larger and slower secondary model.
 *
 * @param text The cleaned user message
 * @returns true if the query is considered factual
 */
function isFactQuery(text: string): boolean {
  const lower = text.toLowerCase().trim();

  // Simple patterns for factual queries
  const factPatterns = [
    /^who\b/,
    /^what\b/,
    /^where\b/,
    /^when\b/,
    /^which\b/,
    /^how many\b/,
    /^list\b/,
    /^define\b/,
  ];

  for (const pattern of factPatterns) {
    if (pattern.test(lower)) {
      // Ensure it's not too long – long questions are often open‑ended
      if (text.length < 160 && text.split(/\s+/).length < 25) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Choose which language model to use based on the incoming text.  For
 * straightforward factual questions, the main model (70b) will suffice and
 * respond quickly.  For deeper or more open‑ended queries, the secondary
 * model (120b) is preferred.  The heuristic leverages the helper
 * functions above; if both deep and fact indicators are present, deep takes
 * precedence.
 *
 * If neither model is deemed a better fit, the main model is returned.
 */
function chooseModel(rawText: string): string {
  try {
    const text = rawText || "";
    if (isDeepQuery(text)) {
      return SECONDARY_MODEL;
    }
    if (isFactQuery(text)) {
      return MAIN_MODEL;
    }
    // Default: use main model for brevity and speed
    return MAIN_MODEL;
  } catch {
    // On unexpected errors, fall back to the main model
    return MAIN_MODEL;
  }
}


/* -------------------------------------------------------------------------- */
/*  Discord client + command loader                                           */
/* -------------------------------------------------------------------------- */

const client = new Client({
  intents: [
    GatewayIntentBits.GuildMessageTyping,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.MessageContent,
  ],
});

// @ts-ignore – custom extension for commands
client.commands = new Collection();

// Load slash commands
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
        `[WARNING] The command at ${filePath} is missing "data" or "execute".`
      );
    }
  }
}

client.once(Events.ClientReady, () => {
  console.log("Bot is online!");
  console.log(`Logged in as ${client.user?.tag}`);
});

/* -------------------------------------------------------------------------- */
/*  Interaction handler (slash commands)                                      */
/* -------------------------------------------------------------------------- */

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // @ts-ignore
  const command = interaction.client.commands.get(interaction.commandName);
  if (!command) {
    console.error(`No command matching ${interaction.commandName} was found.`);
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

/* -------------------------------------------------------------------------- */
/*  Message handler                                                           */
/* -------------------------------------------------------------------------- */

// Track processed messages to avoid duplicates
const processedMessages = new Map<string, number>();

// Clean cache every 30 minutes (drop entries older than 1 hour)
setInterval(() => {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [id, ts] of processedMessages.entries()) {
    if (ts < oneHourAgo) processedMessages.delete(id);
  }
  console.log(
    `Cleaned up old messages. Cache size: ${processedMessages.size}`
  );
}, 30 * 60 * 1000);

const messageHandler = async (message: Message) => {
  try {
    // Ignore bots (including Merlin herself)
    if (message.author.bot) return;

    // Deduplicate
    if (processedMessages.has(message.id)) {
      console.log(
        `[DUPLICATE BLOCKED] Message ${message.id} from ${message.author.tag}`
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

    const botUser = client.user;
    if (!botUser) return;

    const isDM = !message.guild;
    const lower = message.content.toLowerCase();

    /* ------------------------ 1) Passive learning first ------------------------ */

    // 1a) Rule-based teaching detector (server lexicon + simple patterns)
    try {
      await detectAndStoreTeaching(message);
    } catch (err) {
      console.error("[TEACHING DETECTOR ERROR]", err);
    }

    // 1b) LLM-based personal fact detector (only for short messages)
    try {
      if (message.content.length <= 280) {
        const fact = await detectFactWithLLM(message);
        if (fact && fact.should_store && fact.key && fact.value) {
          let targetUserId = message.author.id;

          if (fact.target === "other" && fact.target_user_id) {
            const mentioned = message.mentions.users.get(fact.target_user_id);
            if (mentioned) {
              targetUserId = mentioned.id;
            }
          }

          insertUserFact.run(targetUserId, fact.key, fact.value);
          console.log(
            "[FACT][STORED]",
            "user:",
            targetUserId,
            "key:",
            fact.key,
            "value:",
            fact.value
          );
        }
      }
    } catch (err) {
      console.error("[FACT DETECTOR ERROR]", err);
    }

    /* ------------------------ 2) Decide if Merlin replies ---------------------- */

    let shouldAnswer = false;

    if (isDM) {
      shouldAnswer = true;
    } else {
      const mentionedMe = message.mentions.has(botUser);
      const saidMerlin = lower.includes("merlin");
      const saidMer =
        lower.startsWith("mer ") ||
        lower.startsWith("mer,") ||
        lower.startsWith("mer:") ||
        lower === "mer";
      const saidMerlina =
        lower.includes("merlina") || lower.startsWith("merlina");

      if (mentionedMe || saidMerlin || saidMer || saidMerlina) {
        shouldAnswer = true;
      }
    }

    if (!shouldAnswer) {
      console.log("[SKIPPED] Not addressed to Merlin");
      return;
    }

    /* ------------------------ 3) Clean raw text ------------------------------- */

    const rawText = message.content.replace(/<@!?\d+>/g, "").trim();
    if (!rawText) {
      await message.reply(`¿Sí, ${message.author.username}?`);
      return;
    }

    /* ------------------------ 4) Optional web search -------------------------- */

    let webContext = "";

    if (shouldSearchWeb(rawText) || looksLikeCurrentEventQuestion(rawText)) {
      console.log(
        `[WEB SEARCH] Triggered for message ${message.id} – "${rawText.slice(
          0,
          80
        )}..."`
      );
      try {
        const web = await searchWebWithTavily(rawText, "general");
        if (web) {
          webContext = web;
          console.log(
            `[WEB SEARCH] Success, context length: ${webContext.length} chars`
          );
        } else {
          console.log("[WEB SEARCH] No results");
          const msg = getSuggestedSearchMessage(rawText);
          await message.reply(stripEmojisExceptYellowHeart(msg));
          return;
        }
      } catch (err) {
        console.error("[WEB SEARCH ERROR]", err);
        await message.reply(
          "Tuve problemas conectando con la búsqueda web. Intenta de nuevo."
        );
        return;
      }
    }

    /* ------------------------ 5) Build MEMORY BLOCK --------------------------- */

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
          "Información reciente obtenida de la web. Úsala para responder con precisión " +
          "sin perder tu estilo y personalidad. Si algo no está claro, dilo honestamente.\n\n" +
          webContext,
      });
    }

    messages.push({ role: "user", content: rawText });

    /* ------------------------ 6) Groq completion ------------------------------ */

    // Determine which model to use for this query.  Deep or open‑ended
    // questions are routed to the secondary model; shorter factual ones go
    // through the primary model.  A fallback will be attempted if the
    // primary call fails.
    const primaryModel = chooseModel(rawText);
    // Decide the alternative model for fallback based on which one was chosen
    const fallbackModel =
      primaryModel === MAIN_MODEL ? SECONDARY_MODEL : MAIN_MODEL;

    let usedModel = primaryModel;
    console.log(
      `[MODEL] Attempting ${primaryModel} for message ${message.id} from ${message.author.tag}`
    );

    // Helper to perform the completion call
    async function callModel(modelName: string) {
      return await groq.chat.completions.create({
        model: modelName,
        messages,
        max_tokens: 512,
        temperature: 0.7,
      });
    }

    let completion;
    // Start a timer for the primary call
    console.time(`[GROQ-${message.id}-${primaryModel}]`);
    try {
      completion = await callModel(primaryModel);
      // If the primary call succeeds, stop the timer
      console.timeEnd(`[GROQ-${message.id}-${primaryModel}]`);
    } catch (groqErr: any) {
      // End timing for the failed primary attempt
      console.timeEnd(`[GROQ-${message.id}-${primaryModel}]`);
      console.error(`[GROQ ERROR][${primaryModel}]`, groqErr);
      // Attempt the fallback model only if it differs from the primary
      if (fallbackModel && fallbackModel !== primaryModel) {
        console.log(
          `[MODEL] Falling back to ${fallbackModel} for message ${message.id}`
        );
        usedModel = fallbackModel;
        // Start timing for the fallback call
        console.time(`[GROQ-${message.id}-${fallbackModel}]`);
        try {
          completion = await callModel(fallbackModel);
          console.timeEnd(`[GROQ-${message.id}-${fallbackModel}]`);
        } catch (fallbackErr: any) {
          // End timing for the fallback attempt
          console.timeEnd(`[GROQ-${message.id}-${fallbackModel}]`);
          console.error(`[GROQ ERROR][${fallbackModel}]`, fallbackErr);
          // Respond with an error message based on the fallback error status
          if (fallbackErr?.status === 500) {
            await message.reply(
              "El servidor de Groq está teniendo problemas. Dame un momento e intenta de nuevo."
            );
          } else if (fallbackErr?.status === 429) {
            await message.reply(
              "Demasiadas peticiones. Espera un momento antes de intentar de nuevo."
            );
          } else {
            await message.reply(
              "Mi núcleo se bugueó un segundo. Intenta otra vez."
            );
          }
          console.log(
            `[FAILURE] Both models failed for message ${message.id}`
          );
          return;
        }
      } else {
        // No fallback available or same as primary – reply with an error
        if (groqErr?.status === 500) {
          await message.reply(
            "El servidor de Groq está teniendo problemas. Dame un momento e intenta de nuevo."
          );
        } else if (groqErr?.status === 429) {
          await message.reply(
            "Demasiadas peticiones. Espera un momento antes de intentar de nuevo."
          );
        } else {
          await message.reply(
            "Mi núcleo se bugueó un segundo. Intenta otra vez."
          );
        }
        console.log(
          `[FAILURE] Model ${primaryModel} failed with no fallback for message ${message.id}`
        );
        return;
      }
    }

    // We should have a completion at this point
    const replyText =
      completion?.choices?.[0]?.message?.content?.trim() ??
      "Merlin tried to answer but something went wrong.";

    const cleanedReply = stripEmojisExceptYellowHeart(replyText).trim();

    await message.reply(
      cleanedReply || "Estoy aquí, pero no pude generar una respuesta."
    );
    console.log(
      `[SUCCESS] Replied using ${usedModel} to message ${message.id}`
    );
  } catch (err) {
    console.error("[UNEXPECTED ERROR] in message handler:", err);
    try {
      if (!message.author.bot) {
        await message.reply(
          "Mi núcleo se bugueó un segundo. Intenta otra vez."
        );
      }
    } catch (replyErr) {
      console.error("[REPLY ERROR] Could not send error message:", replyErr);
    }
  }
};

/* -------------------------------------------------------------------------- */
/*  Register handlers & start                                                 */
/* -------------------------------------------------------------------------- */

client.on(Events.MessageCreate, messageHandler);

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

setupMessageLogger(client);

client.login(BOT_TOKEN).catch((err) => {
  console.error("Failed to login:", err);
  process.exit(1);
});
