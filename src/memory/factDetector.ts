// src/memory/factDetector.ts
import type { Message } from "discord.js";
import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });

export interface DetectedFact {
  should_store: boolean;
  key: string | null;
  value: string | null;
  target: "self" | "other";
  target_user_id: string | null; // Discord ID if "other"
}

export async function detectFactWithLLM(
  message: Message
): Promise<DetectedFact | null> {
  const authorName = message.author.username;
  const content = message.content;

  // If message is too long or clearly a command, skip to save tokens
  if (content.length > 300) return null;

  // Build a compact classification prompt
  const systemPrompt = `
You are a classifier for a Discord AI assistant.
Your job: decide if ONE message contains a stable personal fact that should be saved to memory.

A "personal fact" is something that will likely still be true in weeks or months, for example:
- Got a girlfriend/boyfriend/partner.
- Favorite games, champs, skins, music, shows.
- Job, studies, city (without being too precise).
- Important relationships (X is my boyfriend, my sister, my best friend).
- Main characters/champs (soy main Jinx).

DO NOT save:
- Temporary states: I’m tired, hungry, angry, bored, drunk, in class.
- One-off feelings: today I hate everyone, tengo ganas de llorar.
- Pure jokes/insults: eres gay, rata, no tienes novia.
- Questions.
- Obvious trolling.

You MUST respond ONLY with a JSON object, no extra text.

Schema:
{
  "should_store": boolean,
  "key": string | null,
  "value": string | null,
  "target": "self" | "other",
  "target_user_id": string | null
}

Rules:
- If there is no useful fact, set should_store=false and the rest null.
- "self" means the author is talking about themselves.
- "other" means they talk about another user (e.g. tagged with <@id>).
- Key should be a short snake_case identifier in Spanish or English, like:
  "favorite_game", "favorite_skin", "relationship_status", "main_champion", "career", "city".
- Value should be a short human-readable phrase you could later reuse in a sentence.
`.trim();

  const userPrompt = `
Author: ${authorName}
Discord ID: ${message.author.id}
Content: "${content}"

Now analyse and output JSON according to the schema.
`.trim();

  const completion = await groq.chat.completions.create({
    model: "llama-3.1-8b-instant", // small, cheap classifier
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 150,
    temperature: 0.1,
  });

  const raw = completion.choices[0]?.message?.content ?? "";
  try {
    const parsed = JSON.parse(raw) as DetectedFact;
    if (!parsed.should_store) return null;
    return parsed;
  } catch (err) {
    console.error("[FACT DETECTOR] Failed to parse JSON:", raw);
    return null;
  }
}
