// src/bot.ts
require("dotenv").config();

import path from "path";
import fs from "fs";
import http from "http";
import {
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  Message,
} from "discord.js";
import Groq from "groq-sdk";

// Core modules
import { setupMessageLogger } from "./messageLoger";
import { setupScheduler } from "./utils/scheduler";
import { buildMemoryBlock } from "./memory/buildMemoryBlock";
import { MERLIN_SYSTEM_PROMPT, MEMORY_USAGE_RULES } from "./system/system";

// Web search utilities
import {
  shouldSearchWeb,
  searchWebWithTavily,
  looksLikeCurrentEventQuestion,
  getSuggestedSearchMessage,
} from "./utils/webSearch";

// DB & Teaching
import { detectAndStoreTeaching } from "./utils/teachingDetector";
import { insertUserFact } from "./data/db";

// LLM classifier
import { detectFactWithLLM } from "./memory/factDetector";

/* ============================================================
 *  MODEL CONFIG
 * ============================================================ */

const BOT_TOKEN = process.env.DISCORD_LLM_BOT_TOKEN;

// Main responder model
const PRIMARY_MODEL = "openai/gpt-oss-120b";

// Classifier / fallback
const SECONDARY_MODEL = "llama-3.3-70b-versatile";

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY!,
});

/* ============================================================
 *  UTILS
 * ============================================================ */

function stripEmojis(text: string): string {
  return text.replace(
    /[\u{1F000}-\u{1F9FF}\u{1FA70}-\u{1FAFF}]/gu,
    (m) => (m === "💛" ? m : "")
  );
}

/* ============================================================
 *  DISCORD CLIENT SETUP
 * ============================================================ */

const client = new Client({
  intents: [
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.MessageContent,
  ],
});

// @ts-ignore custom extension
client.commands = new Collection();

/* ============================================================
 *  COMMAND LOADER
 * ============================================================ */

const foldersPath = path.join(__dirname, "commands");
if (fs.existsSync(foldersPath)) {
  const commandFolders = fs.readdirSync(foldersPath);

  for (const folder of commandFolders) {
    const commandsPath = path.join(foldersPath, folder);

    const commandFiles = fs
      .readdirSync(commandsPath)
      .filter((f) => f.endsWith(".js"));

    for (const file of commandFiles) {
      const filePath = path.join(commandsPath, file);
      const command = require(filePath);

      if (command.data && command.execute) {
        // @ts-ignore
        client.commands.set(command.data.name, command);
      }
    }
  }
}

/* ============================================================
 *  MESSAGE DE-DUPE SYSTEM
 * ============================================================ */

const processedMessages = new Map<string, number>();

setInterval(() => {
  const cutoff = Date.now() - 3600 * 1000;
  for (const [msgId, ts] of processedMessages) {
    if (ts < cutoff) processedMessages.delete(msgId);
  }
}, 30 * 60 * 1000);

/* ============================================================
 *  JARDIN ACTIVE CONVERSATION STATE
 *  Tracks when Merlin last spoke in a channel.
 *  If < 5 minutes ago → "Active" state (90% reply probability)
 *  Otherwise → "Inactive" state (60% reply probability)
 * ============================================================ */

const lastMerlinReply = new Map<string, number>(); // channelId → timestamp
const ACTIVE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const ACTIVE_REPLY_CHANCE = 1.0;   // Always follow up if already in the conversation
const INACTIVE_REPLY_CHANCE = 0.60; // 60% chance to join a new conversation unprompted

// JARDIN channel: match by ID (most reliable) or by name as fallback
// Set JARDIN_CHANNEL_ID in .env for reliable detection
const JARDIN_CHANNEL_ID = process.env.JARDIN_CHANNEL_ID ?? "";
function isJardinChannel(message: Message): boolean {
  if (JARDIN_CHANNEL_ID && message.channelId === JARDIN_CHANNEL_ID) return true;
  const name = (message.channel as any)?.name?.toLowerCase() ?? "";
  console.log(`[LURK DEBUG] Channel name: "${name}" | Channel ID: ${message.channelId}`);
  return name.includes("jardin") || name.includes("jard");
}

/* ============================================================
 *  FALLBACK GENERATOR
 * ============================================================ */

async function generateReply(messages: any[], maxTokens = 700) {
  try {
    const completion = await groq.chat.completions.create({
      model: PRIMARY_MODEL,
      messages,
      max_tokens: maxTokens,
      temperature: 0.7,
    });

    console.log(`[MODEL] Using ${PRIMARY_MODEL}`);
    return completion.choices[0]?.message?.content ?? "";
  } catch (e) {
    console.error("[PRIMARY MODEL FAILED]", e);
  }

  // fallback
  try {
    const backup = await groq.chat.completions.create({
      model: SECONDARY_MODEL,
      messages,
      max_tokens: Math.min(maxTokens, 500),
      temperature: 0.7,
    });

    console.log(`[MODEL] Fallback to ${SECONDARY_MODEL}`);
    return backup.choices[0]?.message?.content ?? "";
  } catch (e2) {
    console.error("[SECONDARY MODEL FAILED]", e2);
    return "Algo se bugueó fuerte 💛";
  }
}

/* ============================================================
 *  MAIN MESSAGE HANDLER
 * ============================================================ */

client.on(Events.MessageCreate, async (message: Message) => {
  try {
    if (message.author.bot) return;

    // De-dupe
    if (processedMessages.has(message.id)) return;
    processedMessages.set(message.id, Date.now());

    const rawText = message.content.replace(/<@!?\d+>/g, "").trim();
    const authorName =
      message.member?.displayName || message.author.username;

    /* ------------------------------------------------------------
     * 1. Should Merlin respond?
     * ------------------------------------------------------------ */

    let shouldAnswer = false;
    let wasDirectlyMentioned = false;
    let isLurking = false;

    if (!message.guild) {
      // DMs: always respond
      shouldAnswer = true;
      wasDirectlyMentioned = true;
    } else {
      const lower = rawText.toLowerCase();
      const bot = client.user!;
      const channelName = (message.channel as any)?.name?.toLowerCase() ?? "";

      // 1. Always respond if directly mentioned
      if (
        message.mentions.has(bot) ||
        lower.includes("merlin") ||
        lower.startsWith("mer ") ||
        lower.startsWith("mer,") ||
        lower.startsWith("mer:") ||
        lower.includes("merlina")
      ) {
        shouldAnswer = true;
        wasDirectlyMentioned = true;
      }

      // 2. JARDIN lurking logic — spontaneous replies
      if (!shouldAnswer && isJardinChannel(message)) {
        const lastReply = lastMerlinReply.get(message.channelId) ?? 0;
        const timeSinceLastReply = Date.now() - lastReply;
        const isActive = timeSinceLastReply < ACTIVE_WINDOW_MS;
        const chance = isActive ? ACTIVE_REPLY_CHANCE : INACTIVE_REPLY_CHANCE;

        // Cooldown: don’t lurk-respond more than once every 20 seconds
        const LURK_COOLDOWN_MS = 20 * 1000;
        const cooldownOk = timeSinceLastReply > LURK_COOLDOWN_MS || lastReply === 0;

        console.log(`[LURK] isActive=${isActive} | timeSince=${Math.round(timeSinceLastReply/1000)}s | chance=${chance} | cooldownOk=${cooldownOk}`);

        if (cooldownOk && Math.random() < chance) {
          shouldAnswer = true;
          isLurking = true;
          console.log(`[LURK] ✅ Joining conversation (${isActive ? "Active" : "Inactive"} state)`);
        }
      }
    }

    if (!shouldAnswer) return;

    /* ------------------------------------------------------------
     * 2. Teaching detector (structured patterns)
     * ------------------------------------------------------------ */

    detectAndStoreTeaching(message);

    /* ------------------------------------------------------------
     * 3. Personal fact detection (LLM classifier)
     * ------------------------------------------------------------ */

    const detectedFact = await detectFactWithLLM(message);

    if (detectedFact?.should_store && detectedFact.key && detectedFact.value) {
      const targetId =
        detectedFact.target === "self"
          ? message.author.id
          : detectedFact.target_user_id;

      if (targetId) {
        try {
          insertUserFact.run(targetId, detectedFact.key, detectedFact.value);
          console.log("[FACT SAVED]", detectedFact);
        } catch (err) {
          console.error("[FACT SAVE ERROR]", err);
        }
      }
    }

    /* ------------------------------------------------------------
     * 4. Optional Web Search
     * ------------------------------------------------------------ */

    let webContext = "";

    if (shouldSearchWeb(rawText)) {
      const result = await searchWebWithTavily(rawText, "general");
      if (result) webContext = result;
    } else if (looksLikeCurrentEventQuestion(rawText)) {
      const suggestion = getSuggestedSearchMessage(rawText);
      await message.reply(stripEmojis(suggestion));
      return;
    }

    /* ------------------------------------------------------------
     * 5. MEMORY BLOCK
     * ------------------------------------------------------------ */

    const memoryBlock = await buildMemoryBlock(message);

    /* ------------------------------------------------------------
     * 6. Compose final messages
     * ------------------------------------------------------------ */

    const messages: any[] = [
      { role: "system", content: MERLIN_SYSTEM_PROMPT },
      { role: "system", content: MEMORY_USAGE_RULES },
      { role: "system", content: memoryBlock },
    ];

    if (webContext) {
      messages.push({
        role: "system",
        content:
          "Información obtenida de la web:\n\n" +
          webContext +
          "\nÚsala si es útil.",
      });
    }

    // When lurking: inject a casual tone hint so Merlin reacts like a person, not a helper
    if (isLurking) {
      messages.push({
        role: "system",
        content:
          "CONTEXT: You are joining this conversation spontaneously — nobody called you. " +
          "React like a person who was reading the chat and felt like saying something. " +
          "Be SHORT (1-2 sentences MAX). " +
          "Do NOT ask a question unless it’s genuinely the only natural thing to say. " +
          "Do NOT offer help. Do NOT act like an assistant. " +
          "React, comment, tease, agree, or just drop a thought. " +
          "Sound like you’re actually there in the conversation, not monitoring it.",
      });
    }

    messages.push({
      role: "user",
      content: rawText,
    });

    /* ------------------------------------------------------------
     * 7. GENERATE RESPONSE
     * ------------------------------------------------------------ */

    const reply = await generateReply(messages);

    // Direct mentions → reply with quote (clear threading)
    // Lurking responses → send to channel naturally (no quote, feels human)
    if (wasDirectlyMentioned) {
      await message.reply(stripEmojis(reply));
    } else {
      await (message.channel as any).send(stripEmojis(reply));
    }

    // Update last reply timestamp for JARDIN active state tracking
    lastMerlinReply.set(message.channelId, Date.now());

  } catch (err) {
    console.error("[ERROR MESSAGE HANDLER]", err);
    try {
      await message.reply("Algo falló 💛, intenta otra vez.");
    } catch {}
  }
});

/* ============================================================
 *  STARTUP
 * ============================================================ */

client.once(Events.ClientReady, (readyClient) => {
  console.log("Merlin is online 💛");
  setupScheduler(readyClient);
});

setupMessageLogger(client);

// Servidor HTTP ligero para el health check de Fly.io (puerto 8080)
const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Merlin is alive! 💛");
}).listen(PORT, () => {
  console.log(`[HEALTH] Health check server listening on port ${PORT}`);
});

client.login(BOT_TOKEN);
