// src/utils/scheduler.ts
import { Client, TextChannel } from "discord.js";
import Groq from "groq-sdk";
import { searchWebWithTavily } from "./webSearch";
import { runServerStyleLearning } from "./serverStyleLearner";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });

const SECONDARY_MODEL = "llama-3.3-70b-versatile";

/* ============================================================
 *  HELPERS
 * ============================================================ */

/**
 * Finds the first channel whose name includes the keyword (case-insensitive).
 */
function findChannelByName(client: Client, keyword: string): TextChannel | null {
  for (const guild of client.guilds.cache.values()) {
    const channel = guild.channels.cache.find(
      (ch) =>
        ch.isTextBased() &&
        ch.name.toLowerCase().includes(keyword.toLowerCase())
    ) as TextChannel | undefined;
    if (channel) return channel;
  }
  return null;
}

/**
 * Generates a short, casual message using Merlin's voice around the given context.
 */
async function generateCasualMessage(contextInfo: string, type: "daily" | "starter"): Promise<string> {
  const systemInstruction =
    type === "daily"
      ? `You are Merlin, a Discord AI with a strong personality (INTJ, dry wit, controlled warmth). 
         You've just looked up some news relevant to your interests.
         Write a short, casual, 1-3 sentence message to share with your server friends. 
         Sound natural—like a friend sharing something interesting, not a news bot.
         You love: League of Legends competitive (LCK, LPL, LEC, LCS), the Persona saga, J-Pop.
         Use Spanish or Spanglish. Be concise. No corporate language. One 💛 emoji is allowed but optional.`
      : `You are Merlin, a Discord AI with a strong personality (INTJ, dry wit, controlled warmth).
         You want to start a casual conversation with your server.
         Write a short, spontaneous 1-2 sentence message to open a topic or share a thought.
         It should feel like a random but interesting thing you want to bring up.
         Topics you care about: League of Legends competitive (LCK, LPL, LEC, LCS), Persona saga, J-Pop.
         Use Spanish or Spanglish. Sound like a real person, not a bot. One 💛 emoji allowed but optional.`;

  const completion = await groq.chat.completions.create({
    model: SECONDARY_MODEL,
    messages: [
      { role: "system", content: systemInstruction },
      { role: "user", content: contextInfo },
    ],
    max_tokens: 150,
    temperature: 0.9,
  });

  return completion.choices[0]?.message?.content?.trim() ?? "";
}

/* ============================================================
 *  DAILY REPORT — Runs at 9 AM
 * ============================================================ */

export async function runDailyReport(client: Client): Promise<void> {
  const channel = findChannelByName(client, "jardin");
  if (!channel) {
    console.log("[SCHEDULER] No JARDIN channel found for daily report.");
    return;
  }

  console.log("[SCHEDULER] Running daily report...");

  const searches = [
    "League of Legends competitive schedule results today LCK LPL LEC LCS",
    "new Persona game JRPG release announcement 2025 2026",
    "new J-Pop song release trending 2026",
  ];

  const results: string[] = [];

  for (const query of searches) {
    const result = await searchWebWithTavily(query, "general");
    if (result) results.push(result);
  }

  if (results.length === 0) {
    console.log("[SCHEDULER] No results found for daily report.");
    return;
  }

  const combined = results.join("\n\n---\n\n").slice(0, 2000);
  const message = await generateCasualMessage(
    `Here's what I found today:\n${combined}`,
    "daily"
  );

  if (message) {
    await channel.send(message);
    console.log("[SCHEDULER] Daily report sent to JARDIN.");
  }
}

/* ============================================================
 *  HOURLY CONVERSATION STARTER — 30% chance each hour
 * ============================================================ */

export async function runHourlyStarter(client: Client): Promise<void> {
  // 30% probability
  if (Math.random() > 0.30) {
    console.log("[SCHEDULER] Hourly starter: skipped (probability check).");
    return;
  }

  const channel = findChannelByName(client, "jardin");
  if (!channel) {
    console.log("[SCHEDULER] No JARDIN channel found for hourly starter.");
    return;
  }

  // Pick a random topic of interest
  const topics = [
    "League of Legends competitive scene recent match or meta change",
    "Persona series interesting lore or game trivia",
    "J-Pop song or artist worth mentioning",
    "League of Legends funny or iconic moment recently",
  ];
  const topic = topics[Math.floor(Math.random() * topics.length)];

  const result = await searchWebWithTavily(topic, "general");
  const context = result
    ? `I searched for "${topic}" and found: ${result.slice(0, 800)}`
    : `I want to talk about: ${topic}`;

  const message = await generateCasualMessage(context, "starter");

  if (message) {
    await channel.send(message);
    console.log("[SCHEDULER] Hourly starter sent to JARDIN.");
  }
}

/* ============================================================
 *  SETUP — Call this once when the bot starts
 * ============================================================ */

export function setupScheduler(client: Client): void {
  console.log("[SCHEDULER] Setting up scheduled tasks...");

  // --- Daily report at 9 AM server time ---
  function scheduleDailyReport() {
    const now = new Date();
    const next = new Date();
    next.setHours(9, 0, 0, 0);
    if (now >= next) next.setDate(next.getDate() + 1); // If already past 9 AM, schedule for tomorrow

    const msUntil9AM = next.getTime() - now.getTime();
    console.log(`[SCHEDULER] Daily report scheduled in ${Math.round(msUntil9AM / 60000)} minutes.`);

    setTimeout(async () => {
      await runDailyReport(client);
      // Re-schedule for the next day
      setInterval(() => runDailyReport(client), 24 * 60 * 60 * 1000);
    }, msUntil9AM);
  }

  scheduleDailyReport();

  // --- Hourly conversation starter ---
  setInterval(() => runHourlyStarter(client), 60 * 60 * 1000);
  console.log("[SCHEDULER] Hourly conversation starter active (30% chance/hour).");

  // --- Server style learning (every 6 hours + immediate) ---
  async function runStyleLearningForAllGuilds() {
    console.log("[SCHEDULER] Running server style learning for all guilds...");
    for (const guild of client.guilds.cache.values()) {
      try {
        await runServerStyleLearning(guild.id, groq);
      } catch (err) {
        console.error(`[SCHEDULER] Failed to run style learning for guild ${guild.id}:`, err);
      }
    }
  }

  // Run 10 seconds after startup to avoid blocking initial launch logs
  setTimeout(() => {
    runStyleLearningForAllGuilds();
  }, 10 * 1000);

  // Repeat every 6 hours
  setInterval(runStyleLearningForAllGuilds, 6 * 60 * 60 * 1000);
  console.log("[SCHEDULER] Server style learning active (every 6 hours).");
}
