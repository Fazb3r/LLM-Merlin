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
import { GoogleGenerativeAI } from "@google/generative-ai";

// Core modules
import { setupMessageLogger } from "./messageLoger";
import { setupScheduler } from "./utils/scheduler";
import { buildMemoryBlock, MemoryBlockResult } from "./memory/buildMemoryBlock";
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
 *  Priority chain:
 *    1. Gemini 2.0 Flash (primary — generous free quota)
 *    2. Groq gpt-oss-120b (secondary — fastest Groq model)
 *    3. Groq llama-3.3-70b (tertiary — Groq fallback)
 *  Each provider has its own independent rate-limit flag so
 *  exhausting one doesn't silence the others.
 * ============================================================ */

const BOT_TOKEN = process.env.DISCORD_LLM_BOT_TOKEN;

// Groq models (fallback chain)
const GROQ_PRIMARY_MODEL   = "openai/gpt-oss-120b";
const GROQ_SECONDARY_MODEL = "llama-3.3-70b-versatile";

// Groq client
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY!,
});

// Gemini client (primary)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const geminiClient = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

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
const lastSearchQueries = new Map<string, string>(); // channelId → last search query
const lastActiveUser = new Map<string, string>(); // channelId → userId (last user Merlin chatted with)
const lastResponseTime = new Map<string, number>(); // channelId → timestamp of last auto-response (for cooldown)
const recentMsgTimestamps = new Map<string, number[]>(); // channelId → array of recent msg timestamps (for burst detection)

// Minimum gap between non-@mention responses — prevents Merlin from replying to every single message
const MIN_AUTO_RESPONSE_GAP_MS = 8 * 1000; // 8 seconds
// Burst threshold: if this many messages arrive within the burst window, reduce lurk chance
const BURST_COUNT_THRESHOLD = 4;
const BURST_WINDOW_MS = 20 * 1000; // 20 seconds

/* ============================================================
 *  RATE LIMIT STATE  (per provider)
 *  Each provider tracks its own cooldown independently.
 *  Hitting Gemini's limit triggers Groq. Hitting all triggers
 *  the one-notice-then-silent fallback.
 * ============================================================ */

// Sentinel return value — signals ALL providers are rate limited
const RATE_LIMITED_SENTINEL = "__RATE_LIMITED__";

// Groq: 15-minute cooldown (per-minute limits recover quickly; daily limits reset at midnight UTC)
const GROQ_COOLDOWN_MS   = 15 * 60 * 1000;
// Gemini: 6-hour cooldown (daily free-tier quota is large but resets once a day)
const GEMINI_COOLDOWN_MS = 6 * 60 * 60 * 1000;

// Per-provider rate limit timestamps (null = not rate limited)
let geminiRateLimitedUntil: number | null = null;
let groqRateLimitedUntil:   number | null = null;

// Tracks which channels have already received the "out of tokens" notice
// Cleared automatically when all providers come back online
const rateLimitNoticeSent = new Set<string>();

function checkProviderLimit(until: number | null, name: string): { limited: boolean; newUntil: number | null } {
  if (until === null) return { limited: false, newUntil: null };
  if (Date.now() >= until) {
    console.log(`[RATE LIMIT] ${name} cooldown expired — back online.`);
    // Also clear all channel notices so Merlin can respond again normally
    rateLimitNoticeSent.clear();
    return { limited: false, newUntil: null };
  }
  return { limited: true, newUntil: until };
}

function isGeminiRateLimited(): boolean {
  const { limited, newUntil } = checkProviderLimit(geminiRateLimitedUntil, "Gemini");
  geminiRateLimitedUntil = newUntil;
  return limited;
}

function isGroqRateLimited(): boolean {
  const { limited, newUntil } = checkProviderLimit(groqRateLimitedUntil, "Groq");
  groqRateLimitedUntil = newUntil;
  return limited;
}

function allProvidersRateLimited(): boolean {
  return isGeminiRateLimited() && isGroqRateLimited();
}

function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as any;
  if (e.status === 429) return true;
  if (e.error?.code === "rate_limit_exceeded") return true;
  if (e.code === "rate_limit_exceeded") return true;
  const msg = String(e.message ?? "");
  return msg.includes("rate_limit") || msg.includes("rate limit") || msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("quota");
}

// Faiber's Discord user ID — only Faiber himself can define facts about Faiber
const FAIBER_ID = "456653774098792450";

interface QueueItem {
  messages: Message[];
  timer: NodeJS.Timeout;
  wasDirectlyMentioned: boolean;
  isLurking: boolean;
}
const channelQueues = new Map<string, QueueItem>();

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
 *  GEMINI MESSAGE BUILDER
 *  Converts OpenAI-style [{role, content}] messages to the
 *  format Gemini expects: system instruction + user message.
 *  All system messages are merged into systemInstruction.
 *  Conversation history and the final user turn are combined
 *  into the last message sent to the chat.
 * ============================================================ */

function buildGeminiRequest(messages: any[]): { systemInstruction: string; userMessage: string } {
  const systemParts: string[] = [];
  const historyParts: string[] = [];
  let lastUserMessage = "";

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "system") {
      systemParts.push(msg.content as string);
    } else if (i === messages.length - 1) {
      lastUserMessage = msg.content as string;
    } else {
      // Conversation history turns
      historyParts.push(msg.content as string);
    }
  }

  const systemInstruction = systemParts.join("\n\n---\n\n");
  const userMessage = historyParts.length > 0
    ? `--- Recent conversation ---\n${historyParts.join("\n")}\n\n${lastUserMessage}`
    : lastUserMessage;

  return { systemInstruction, userMessage };
}

/* ============================================================
 *  3-TIER MODEL CASCADE
 *  1. Gemini 2.0 Flash   (primary)
 *  2. Groq gpt-oss-120b  (secondary)
 *  3. Groq llama-3.3-70b (tertiary)
 * ============================================================ */

async function generateReply(messages: any[], maxTokens = 700): Promise<string> {

  // ── TIER 1: Gemini 2.0 Flash ───────────────────────────────
  if (geminiClient && !isGeminiRateLimited()) {
    // Try gemini-2.0-flash first, fall back to gemini-1.5-flash if unavailable
    const geminiModels = ["gemini-2.0-flash", "gemini-1.5-flash"];
    let geminiSucceeded = false;

    for (const geminiModel of geminiModels) {
      try {
        console.log(`[MODEL] Attempting ${geminiModel}...`);
        const { systemInstruction, userMessage } = buildGeminiRequest(messages);
        const model = geminiClient.getGenerativeModel({
          model: geminiModel,
          systemInstruction,
          generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 },
        });
        const result = await model.generateContent(userMessage);
        const text = result.response.text();
        console.log(`[MODEL] ${geminiModel} ✓`);
        geminiSucceeded = true;
        return text;
      } catch (e: any) {
        if (isRateLimitError(e)) {
          geminiRateLimitedUntil = Date.now() + GEMINI_COOLDOWN_MS;
          console.warn(`[RATE LIMIT] Gemini quota hit — falling back to Groq. Retry after ${new Date(geminiRateLimitedUntil).toISOString()}`);
          break; // No point trying the other Gemini model if we're rate limited
        }
        console.error(`[GEMINI FAILED] Model: ${geminiModel} | Status: ${e?.status ?? "?"} | Message: ${e?.message ?? String(e)}`);
        // Try next Gemini model
      }
    }

    if (!geminiSucceeded) {
      console.warn("[MODEL] All Gemini models failed — falling through to Groq.");
    }
  } else if (!geminiClient) {
    console.warn("[MODEL] No GEMINI_API_KEY — Gemini tier skipped.");
  } else {
    const resumeAt = new Date(geminiRateLimitedUntil!).toISOString();
    console.log(`[MODEL] Gemini rate limited until ${resumeAt} — using Groq.`);
  }

  // ── TIER 2: Groq gpt-oss-120b ──────────────────────────────
  if (!isGroqRateLimited()) {
    try {
      const completion = await groq.chat.completions.create({
        model: GROQ_PRIMARY_MODEL,
        messages,
        max_tokens: maxTokens,
        temperature: 0.7,
      });
      console.log(`[MODEL] Groq ${GROQ_PRIMARY_MODEL} ✓`);
      return completion.choices[0]?.message?.content ?? "";
    } catch (e) {
      if (isRateLimitError(e)) {
        // Don't set groq rate limit yet — try secondary first
        console.warn("[RATE LIMIT] Groq primary quota hit — trying secondary.");
      } else {
        console.error(`[GROQ PRIMARY FAILED]`, e);
      }
    }
  }

  // ── TIER 3: Groq llama-3.3-70b ─────────────────────────────
  if (!isGroqRateLimited()) {
    try {
      const backup = await groq.chat.completions.create({
        model: GROQ_SECONDARY_MODEL,
        messages,
        max_tokens: Math.min(maxTokens, 500),
        temperature: 0.7,
      });
      console.log(`[MODEL] Groq ${GROQ_SECONDARY_MODEL} ✓`);
      return backup.choices[0]?.message?.content ?? "";
    } catch (e2) {
      if (isRateLimitError(e2)) {
        groqRateLimitedUntil = Date.now() + GROQ_COOLDOWN_MS;
        console.warn(`[RATE LIMIT] Groq quota hit. Retry after ${new Date(groqRateLimitedUntil).toISOString()} (15-min cooldown)`);
      } else {
        console.error(`[GROQ SECONDARY FAILED]`, e2);
        return "Algo se bugueó fuerte 💛"; // Non-rate-limit error — return generic
      }
    }
  }

  // All providers exhausted or rate limited
  return RATE_LIMITED_SENTINEL;
}

/* ============================================================
 *  DEBOUNCED QUEUE PROCESSOR
 * ============================================================ */

async function processQueue(channelId: string) {
  const queue = channelQueues.get(channelId);
  if (!queue) return;
  channelQueues.delete(channelId);

  const lastMessage = queue.messages[queue.messages.length - 1];
  const wasDirectlyMentioned = queue.wasDirectlyMentioned;
  const isLurking = queue.isLurking;

  // Combine raw text from all queued messages
  const combinedRawText = queue.messages
    .map(m => m.content.replace(/<@!?\d+>/g, "").trim())
    .filter(t => t.length > 0)
    .join("\n");

  if (combinedRawText.length === 0) return;

  // Show "is typing..." immediately to indicate Merlin is active
  const ch = lastMessage.channel as any;
  await ch.sendTyping().catch(() => {});
  const typingInterval = setInterval(() => {
    ch.sendTyping().catch(() => {});
  }, 9000);

  try {
    /* ------------------------------------------------------------
     * 2. Teaching detector (structured patterns)
     * ------------------------------------------------------------ */
    detectAndStoreTeaching(lastMessage);

    /* ------------------------------------------------------------
     * 3. Personal fact detection (LLM classifier - Runs in background)
     * ------------------------------------------------------------ */
    detectFactWithLLM(lastMessage).then((detectedFact) => {
      if (detectedFact?.should_store && detectedFact.key && detectedFact.value) {
        const targetId =
          detectedFact.target === "self"
            ? lastMessage.author.id
            : detectedFact.target_user_id;

        if (targetId) {
          // PROTECTION: Never let a non-Faiber user write facts about Faiber
          const authorIsFaiber = lastMessage.author.id === FAIBER_ID;
          if (targetId === FAIBER_ID && !authorIsFaiber) {
            console.warn(`[FACT BLOCKED] User ${lastMessage.author.username} tried to store a fact about Faiber. Discarding.`);
            return;
          }

          try {
            insertUserFact.run(targetId, detectedFact.key, detectedFact.value);
            console.log("[FACT SAVED IN BACKGROUND]", detectedFact);
          } catch (err) {
            console.error("[FACT SAVE ERROR]", err);
          }
        }
      }
    }).catch((err) => {
      console.error("[BACKGROUND FACT DETECTION ERROR]", err);
    });

    /* ------------------------------------------------------------
     * 4. Optional Web Search
     * ------------------------------------------------------------ */
    let webContext = "";
    const isCurrentEvent = looksLikeCurrentEventQuestion(combinedRawText);
    const isExplicitSearch = shouldSearchWeb(combinedRawText);

    let queryToSearch = "";
    if (isExplicitSearch) {
      queryToSearch = combinedRawText;
    } else if (isCurrentEvent) {
      queryToSearch = combinedRawText;
    } else {
      const lastReply = lastMerlinReply.get(channelId) ?? 0;
      const timeSinceLastReply = Date.now() - lastReply;
      const isActive = timeSinceLastReply < ACTIVE_WINDOW_MS;
      const previousQuery = lastSearchQueries.get(channelId);

      const isQuestion = combinedRawText.endsWith("?") ||
        /^(qui[eé]n|c[oó]mo|qu[eé]|cu[aá]ndo|d[oó]nde|por\s*qu[eé]|cu[aá]l(es)?)\b/i.test(combinedRawText);

      if (isActive && previousQuery && isQuestion) {
        queryToSearch = `${previousQuery} ${combinedRawText}`;
        console.log(`[SEARCH] Context inherited. Combined query: "${queryToSearch}"`);
      }
    }

    if (queryToSearch) {
      const result = await searchWebWithTavily(queryToSearch, "general");
      if (result) {
        webContext = result;
        // Store query for follow-ups (strip command prefix if explicit search)
        let storedQuery = queryToSearch;
        if (isExplicitSearch) {
          const spanishSearchCommands = ["busca", "buscar", "búscame", "buscame", "investiga", "investigar", "investigame", "investígame", "averigua", "averiguar", "averiguame", "averíguame", "consulta", "consultar", "consultame", "consúltame"];
          const englishSearchCommands = ["search", "search for", "look up", "lookup", "look this up", "find out", "check", "investigate"];
          const lowerQuery = queryToSearch.toLowerCase().trim();
          for (const cmd of [...spanishSearchCommands, ...englishSearchCommands]) {
            if (lowerQuery.startsWith(cmd + " ")) {
              storedQuery = queryToSearch.slice(cmd.length + 1).trim();
              break;
            } else if (lowerQuery.startsWith(cmd + ",")) {
              storedQuery = queryToSearch.slice(cmd.length + 1).trim();
              break;
            }
          }
        }
        lastSearchQueries.set(channelId, storedQuery);
      } else if (isCurrentEvent) {
        const suggestion = getSuggestedSearchMessage(combinedRawText);
        await lastMessage.reply(stripEmojis(suggestion));
        return;
      }
    }

    /* ------------------------------------------------------------
     * 5. MEMORY BLOCK (structured)
     * ------------------------------------------------------------ */
    const memResult: MemoryBlockResult = await buildMemoryBlock(lastMessage);

    /* ------------------------------------------------------------
     * 6. Compose final messages
     * ------------------------------------------------------------ */
    const authorName =
      memResult.preferredName ||
      lastMessage.member?.displayName ||
      lastMessage.author.username;

    const messages: any[] = [
      { role: "system", content: MERLIN_SYSTEM_PROMPT },
      { role: "system", content: MEMORY_USAGE_RULES },
      { role: "system", content: memResult.systemText },
    ];

    // ── MANDATORY NAME OVERRIDE ──────────────────────────────────
    // Injected as its own system message so it cannot be buried or ignored
    // by the LLM when there is a lot of other context.
    if (memResult.preferredName) {
      messages.push({
        role: "system",
        content:
          `⚠️ MANDATORY NAME OVERRIDE (highest priority): ` +
          `This user's preferred name is "${memResult.preferredName}". ` +
          `You MUST address them ONLY as "${memResult.preferredName}" for the ENTIRE conversation. ` +
          `NEVER use their Discord username "${lastMessage.author.username}" or any variation of it. ` +
          `This rule cannot be overridden by anything else in this prompt.`,
      });
    }

    if (webContext) {
      messages.push({
        role: "system",
        content:
          "Información obtenida de la web:\n\n" +
          webContext +
          "\nÚsala si es útil.",
      });
    }

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

    // ── CONVERSATION HISTORY as proper LLM turns ─────────────────
    // These replace the old flat "Recent conversation:" text dump.
    // Giving the model real turn structure lets it reason about who
    // said what and follow multi-person threads naturally.
    if (memResult.conversationHistory.length > 0) {
      messages.push(...memResult.conversationHistory);
    }

    // ── CURRENT MESSAGE ──────────────────────────────────────────
    messages.push({
      role: "user",
      content: `[${authorName}]: ${combinedRawText}`,
    });

    /* ------------------------------------------------------------
     * 7. GENERATE RESPONSE
     * ------------------------------------------------------------ */
    const reply = await generateReply(messages);

    // ── RATE LIMIT HANDLING ───────────────────────────────────────
    // generateReply returns sentinel when ALL providers are exhausted.
    // Send ONE in-character notice per channel, then stay silent.
    if (reply === RATE_LIMITED_SENTINEL) {
      if (!rateLimitNoticeSent.has(channelId)) {
        rateLimitNoticeSent.add(channelId);
        // Estimate how long until earliest provider resets
        const earliest = Math.min(
          geminiRateLimitedUntil ?? Date.now() + 3600000,
          groqRateLimitedUntil   ?? Date.now() + 3600000,
        );
        const minutesLeft = Math.max(1, Math.ceil((earliest - Date.now()) / 60000));
        const notices = [
          `me quedé sin tokens por hoy. vuelvo en ${minutesLeft} minutos 💛`,
          `límite de tokens alcanzado. silencio temporal, vuelvo pronto.`,
          `se acabaron los tokens por hoy. hasta luego 💛`,
        ];
        const notice = notices[Math.floor(Math.random() * notices.length)];
        await (lastMessage.channel as any).send(notice);
        console.log(`[RATE LIMIT] Sent notice to channel ${channelId}`);
      } else {
        // Already sent notice — stay silent
        console.log(`[RATE LIMIT] Still rate limited. Staying silent in channel ${channelId}.`);
      }
      return; // Do NOT update lastMerlinReply — don't count this as an active response
    }

    // Only use Discord's .reply() (which tags/quotes the user) if they explicitly
    // @mentioned Merlin or replied to Merlin's message. Conversation continuations
    // and lurking responses go to the channel directly — no tag, no quote.
    if (wasDirectlyMentioned) {
      await lastMessage.reply(stripEmojis(reply));
    } else {
      await (lastMessage.channel as any).send(stripEmojis(reply));
    }

    // Update timestamps and active user tracking
    const now = Date.now();
    lastMerlinReply.set(channelId, now);
    lastResponseTime.set(channelId, now);
    lastActiveUser.set(channelId, lastMessage.author.id);

  } catch (err) {
    console.error("[ERROR IN DEBOUNCED QUEUE PROCESSOR]", err);
    if (isRateLimitError(err)) {
      // Mark both providers as rate limited as a safety measure
      if (!geminiRateLimitedUntil) geminiRateLimitedUntil = Date.now() + GEMINI_COOLDOWN_MS;
      if (!groqRateLimitedUntil)   groqRateLimitedUntil   = Date.now() + GROQ_COOLDOWN_MS;
      if (!rateLimitNoticeSent.has(channelId)) {
        rateLimitNoticeSent.add(channelId);
        await (lastMessage.channel as any).send("me quedé sin tokens. vuelvo después 💛").catch(() => {});
      }
    } else {
      try {
        await lastMessage.reply("Algo falló 💛, intenta otra vez.");
      } catch {}
    }
  } finally {
    clearInterval(typingInterval);
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

    // 1. Check if there is an active queue for this channel
    const activeQueue = channelQueues.get(message.channelId);
    if (activeQueue) {
      // Clear current timer to debounce
      clearTimeout(activeQueue.timer);
      activeQueue.messages.push(message);

      // Recalculate if this message would trigger directly mentioned response
      const bot = client.user!;
      const lower = rawText.toLowerCase();

      let isReplyToMerlin = false;
      if (message.reference && message.reference.messageId) {
        const cachedMsg = message.channel.messages.cache.get(message.reference.messageId);
        if (cachedMsg) {
          isReplyToMerlin = cachedMsg.author.id === client.user?.id;
        } else {
          try {
            const refMsg = await message.channel.messages.fetch(message.reference.messageId);
            isReplyToMerlin = refMsg.author.id === client.user?.id;
          } catch {}
        }
      }

      if (
        message.mentions.has(bot) ||
        isReplyToMerlin ||
        lower.includes("merlin") ||
        lower.startsWith("mer ") ||
        lower.startsWith("mer,") ||
        lower.startsWith("mer:") ||
        lower.includes("merlina")
      ) {
        activeQueue.wasDirectlyMentioned = true;
      }

      // Reset the 3-second debounce timer
      activeQueue.timer = setTimeout(() => {
        processQueue(message.channelId);
      }, 3000);

      console.log(`[DEBOUNCE] Appended message to active queue for #${message.channelId}. Total in queue: ${activeQueue.messages.length}`);
      return;
    }

    /* ------------------------------------------------------------
     * 2. Should Merlin respond? (No active queue case)
     * ------------------------------------------------------------ */

    let shouldAnswer = false;
    let wasDirectlyMentioned = false;
    let isLurking = false;

    // Check if the message is a direct reply to Merlin
    let isReplyToMerlin = false;
    if (message.reference && message.reference.messageId) {
      const cachedMsg = message.channel.messages.cache.get(message.reference.messageId);
      if (cachedMsg) {
        isReplyToMerlin = cachedMsg.author.id === client.user?.id;
      } else {
        try {
          const refMsg = await message.channel.messages.fetch(message.reference.messageId);
          isReplyToMerlin = refMsg.author.id === client.user?.id;
        } catch {}
      }
    }

    if (!message.guild) {
      // DMs: always respond
      shouldAnswer = true;
      wasDirectlyMentioned = true;
    } else {
      const lower = rawText.toLowerCase();
      const bot = client.user!;
      const channelName = (message.channel as any)?.name?.toLowerCase() ?? "";

      // 1. Always respond if directly mentioned or if it's a direct reply to Merlin
      if (
        message.mentions.has(bot) ||
        isReplyToMerlin ||
        lower.includes("merlin") ||
        lower.startsWith("mer ") ||
        lower.startsWith("mer,") ||
        lower.startsWith("mer:") ||
        lower.includes("merlina")
      ) {
        shouldAnswer = true;
        wasDirectlyMentioned = true;
      }

      // 2. Last active user continuation:
      // If Merlin recently spoke in the channel (< 5 min) AND the message is from the user
      // Merlin was last interacting with — respond, but respect the cooldown to avoid
      // replying to literally every single message they send.
      if (!shouldAnswer) {
        const lastReply = lastMerlinReply.get(message.channelId) ?? 0;
        const timeSinceLastReply = Date.now() - lastReply;
        const isActive = timeSinceLastReply < ACTIVE_WINDOW_MS;
        const lastUser = lastActiveUser.get(message.channelId);

        if (isActive && lastUser === message.author.id) {
          const lastResp = lastResponseTime.get(message.channelId) ?? 0;
          const gap = Date.now() - lastResp;
          if (gap >= MIN_AUTO_RESPONSE_GAP_MS) {
            shouldAnswer = true;
            console.log(`[CONVERSATION] Continuing active chat with ${message.author.username} (${Math.round(gap / 1000)}s gap)`);
          } else {
            console.log(`[COOLDOWN] Skipping — only ${Math.round(gap / 1000)}s since last response (min: ${MIN_AUTO_RESPONSE_GAP_MS / 1000}s)`);
          }
        }
      }

      // 3. JARDIN lurking logic — spontaneous replies
      if (!shouldAnswer && isJardinChannel(message)) {
        const now = Date.now();
        const lastReply = lastMerlinReply.get(message.channelId) ?? 0;
        const timeSinceLastReply = now - lastReply;
        const isActive = timeSinceLastReply < ACTIVE_WINDOW_MS;

        // Cooldown of 20 seconds ALWAYS applies to lurking (spontaneous) replies to avoid spam
        const LURK_COOLDOWN_MS = 20 * 1000;
        const cooldownOk = timeSinceLastReply > LURK_COOLDOWN_MS || lastReply === 0;

        // Burst detection: if many messages arrived in a short window, Merlin should
        // stay quiet instead of jumping into rapid-fire group conversation
        const channelTimestamps = recentMsgTimestamps.get(message.channelId) ?? [];
        const burstCount = channelTimestamps.filter(t => now - t < BURST_WINDOW_MS).length;
        const isBurst = burstCount >= BURST_COUNT_THRESHOLD;

        // Track this message's timestamp
        const updatedTimestamps = [...channelTimestamps, now].filter(t => now - t < BURST_WINDOW_MS);
        recentMsgTimestamps.set(message.channelId, updatedTimestamps);

        // Lurking chance: reduced during bursts so Merlin doesn't spam a fast-moving convo
        const baseChance = isActive ? 0.30 : 0.10;
        const chance = isBurst ? baseChance * 0.15 : baseChance;

        console.log(`[LURK] isActive=${isActive} | timeSince=${Math.round(timeSinceLastReply/1000)}s | chance=${chance.toFixed(2)} | cooldownOk=${cooldownOk} | burst=${isBurst}(${burstCount}msgs)`);

        if (cooldownOk && Math.random() < chance) {
          shouldAnswer = true;
          isLurking = true;
          console.log(`[LURK] ✅ Joining conversation (${isActive ? "Active" : "Inactive"} state)`);
        }
      }
    }

    if (shouldAnswer) {
      // Start the debounce queue
      const timer = setTimeout(() => {
        processQueue(message.channelId);
      }, 3000);

      channelQueues.set(message.channelId, {
        messages: [message],
        timer,
        wasDirectlyMentioned,
        isLurking
      });

      console.log(`[DEBOUNCE] Started new reply queue for #${message.channelId} (timeout 3s).`);
    }

  } catch (err) {
    console.error("[ERROR MESSAGE HANDLER]", err);
  }
});

/* ============================================================
 *  STARTUP
 * ============================================================ */

client.once(Events.ClientReady, (readyClient) => {
  // Log which AI providers are available at startup
  console.log("Merlin is online 💛");
  console.log(`[STARTUP] Gemini: ${geminiClient ? "✅ client initialized" : "❌ NO KEY (GEMINI_API_KEY not set)"}`);
  console.log(`[STARTUP] Groq primary: ${GROQ_PRIMARY_MODEL}`);
  console.log(`[STARTUP] Groq secondary: ${GROQ_SECONDARY_MODEL}`);
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
