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
  confidence?: "high" | "medium" | "low";
}

/* ============================================================
 *  PRE-FILTERS (Performance optimization)
 * ============================================================ */

/**
 * Quick heuristic checks to skip obvious non-facts before calling LLM.
 * Saves tokens and latency.
 */
function shouldSkipLLMCall(content: string): boolean {
  const lower = content.toLowerCase().trim();

  // Skip if too short (likely not a fact)
  if (lower.length < 10) return true;

  // Skip if too long (likely conversation, not a fact statement)
  if (content.length > 400) return true;

  // Skip obvious questions
  if (
    lower.startsWith("¿") ||
    lower.startsWith("que ") ||
    lower.startsWith("qué ") ||
    lower.startsWith("como ") ||
    lower.startsWith("cómo ") ||
    lower.startsWith("cuando ") ||
    lower.startsWith("cuándo ") ||
    lower.startsWith("donde ") ||
    lower.startsWith("dónde ") ||
    lower.startsWith("por qué") ||
    lower.startsWith("why ") ||
    lower.startsWith("what ") ||
    lower.startsWith("how ") ||
    lower.startsWith("when ") ||
    lower.startsWith("where ") ||
    lower.endsWith("?")
  ) {
    return true;
  }

  // Skip obvious temporary states (common phrases)
  const temporaryPhrases = [
    "estoy cansado",
    "estoy aburrido",
    "tengo sueño",
    "tengo hambre",
    "estoy triste",
    "estoy feliz",
    "estoy enojado",
    "me duele",
    "estoy en clase",
    "voy a dormir",
    "buenos días",
    "buenas noches",
    "im tired",
    "im bored",
    "im sleepy",
    "im hungry",
    "im sad",
    "im happy",
    "good morning",
    "good night",
  ];

  if (temporaryPhrases.some((phrase) => lower.includes(phrase))) {
    return true;
  }

  // Skip obvious commands/requests to Merlin
  if (
    lower.startsWith("merlin") ||
    lower.startsWith("mer ") ||
    lower.startsWith("mer,") ||
    lower.startsWith("busca") ||
    lower.startsWith("dime") ||
    lower.startsWith("ayuda") ||
    lower.startsWith("explica") ||
    lower.startsWith("help") ||
    lower.startsWith("search") ||
    lower.startsWith("tell me")
  ) {
    return true;
  }

  return false;
}

/**
 * Heuristic check for fact-like patterns.
 * If present, increases likelihood this is worth checking.
 */
function hasFactIndicators(content: string): boolean {
  const lower = content.toLowerCase();

  const factPatterns = [
    // Spanish patterns
    /mi (juego|champion|main|campeón|skin|personaje) (favorito|preferido)/i,
    /soy main/i,
    /trabajo (en|de|como)/i,
    /estudio/i,
    /mi (novia|novio|pareja|esposa|esposo)/i,
    /tengo (una novia|un novio|pareja)/i,
    /vivo en/i,
    /mi cumpleaños/i,
    /nací en/i,
    /me gusta (jugar|ver|escuchar)/i,
    /mi .+ favorito/i,
    /mi .+ preferido/i,

    // English patterns
    /my (favorite|favourite|main|preferred)/i,
    /i (main|play|work|study)/i,
    /i'm a .+ main/i,
    /my (girlfriend|boyfriend|partner|wife|husband)/i,
    /i have a (girlfriend|boyfriend|partner)/i,
    /i live in/i,
    /my birthday/i,
    /i was born/i,
    /i like (playing|watching|listening)/i,
  ];

  return factPatterns.some((pattern) => pattern.test(lower));
}

/* ============================================================
 *  ENHANCED LLM CLASSIFIER
 * ============================================================ */

export async function detectFactWithLLM(
  message: Message
): Promise<DetectedFact | null> {
  const content = message.content.trim();

  // Quick pre-filter
  if (shouldSkipLLMCall(content)) {
    return null;
  }

  // Check for fact indicators (optional optimization)
  const hasIndicators = hasFactIndicators(content);

  // If no indicators and message is medium-long, probably not a fact
  if (!hasIndicators && content.length > 150) {
    return null;
  }

  const authorName = message.author.username;
  const authorId = message.author.id;

  // Extract mentioned users if any
  const mentions = Array.from(message.mentions.users.values())
    .map((u) => `<@${u.id}> (${u.username})`)
    .join(", ");

  const systemPrompt = `
You are a fact classifier for Merlin, a Discord AI assistant with memory.

Your job: Identify if a message contains ONE stable personal fact worth saving long-term.

═══════════════════════════════════════════════════════════════════
### WHAT TO SAVE (Personal Facts):

✓ Preferred name (HIGHEST PRIORITY):
  - "llámame X", "me llamo X", "puedes llamarme X", "call me X", "my name is X"
  - Key: "preferred_name", value: the name they want to be called
  - This overrides how Merlin addresses the user going forward

✓ Stable preferences/favorites:
  - Favorite games, champions, characters, skins, music, shows, movies
  - Main champions/characters (soy main Jinx, I main Yasuo)
  - Preferred genres, styles, aesthetics

✓ Relationships:
  - Romantic: got girlfriend/boyfriend/partner, broke up, married
  - Important people: X is my sister, best friend, cousin
  - Note: Save who they are, not temporary feelings about them

✓ Life status (stable changes):
  - Job/career: trabajo en X, soy programador, work as designer
  - Studies: estudio medicina, studying computer science
  - Location: vivo en Bogotá, moved to Madrid (city level, no addresses)
  - Relationship status change: single → in relationship, etc.

✓ Personal identity:
  - Hobbies: me gusta dibujar, I like photography
  - Skills: sé tocar guitarra, I speak 3 languages
  - Birthday/age (month is enough, not exact dates for privacy)

═══════════════════════════════════════════════════════════════════
### WHAT NOT TO SAVE:

✗ Temporary states (will change in hours/days):
  - Emotions: tired, hungry, sad, happy, angry, drunk, bored
  - Activities: in class, watching a movie, playing right now, studying
  - Physical states: sick, sleepy, hurt, cold, hot

✗ Opinions on current events:
  - "This game sucks today", "that update is bad"
  - Unless it's a stable preference: "I hate battle royales" → could be saved

✗ Jokes, insults, trolling:
  - "eres gay", "no tienes novia", "rata"
  - Obvious sarcasm or banter

✗ Questions, commands, greetings:
  - Any message ending with "?"
  - Commands to Merlin: "Merlin, búscame X"
  - Greetings: buenos días, good morning, etc.

✗ Plans or intentions (future, not fact):
  - "Voy a estudiar medicina" → intention, not fact
  - "Quiero jugar más" → desire, not fact
  - Exception: "Empecé a estudiar medicina" → this IS a fact

✗ Context-dependent statements:
  - "Mi hermana es molesta" → opinion, not fact
  - "Mi hermana se llama Ana" → fact worth saving

✗ CRITICAL — Third-party unverified claims:
  - If someone says something about ANOTHER PERSON who is NOT explicitly @mentioned
    with a Discord @mention tag in the message, DO NOT store it.
  - Example: "a Faiber le gustan los hombres" — Faiber is not @mentioned, DISCARD.
  - Example: "Joseph nació en 2005" — Joseph is not @mentioned, DISCARD.
  - Only store third-party facts when there is an explicit <@USER_ID> mention in the message.
  - Even with a mention, be skeptical of sensitive personal attributes (sexuality,
    health, relationships) stated by someone other than the person themselves.

═══════════════════════════════════════════════════════════════════
### OUTPUT FORMAT:

Respond ONLY with valid JSON. No markdown, no explanation, just JSON:

{
  "should_store": boolean,
  "key": string | null,
  "value": string | null,
  "target": "self" | "other",
  "target_user_id": string | null,
  "confidence": "high" | "medium" | "low"
}

### FIELD RULES:

**should_store**: 
- true only if this is clearly a stable personal fact
- false for everything else

**key**: 
- Short identifier in snake_case
- Prefer Spanish for Spanish messages, English for English messages
- Examples: "preferred_name", "favorite_game", "main_champion", "job",
  "relationship_status", "birthday_month", "lives_in", "favorite_skin", "hobby", "skill"
- Be specific when possible: "favorite_game" not just "favorite"
- null if should_store is false

**value**: 
- Natural, reusable phrase that Merlin can insert in conversation
- Keep it concise but human-readable
- Examples: 
  - "Persona 5" (not "mi juego favorito es Persona 5")
  - "Jinx" (not "soy main Jinx")
  - "trabaja en marketing" or "works in marketing"
  - "Ana" (for sister's name)
  - "Ganzabio" (for preferred_name)
- null if should_store is false

**target**:
- "self" if the author talks about themselves
- "other" ONLY if they explicitly @mention another user with <@ID> in the message

**target_user_id**:
- null if target is "self"
- Discord user ID (numbers only) if target is "other"
- Extract from <@123456> format in mentions
- If no explicit @mention is present, target must be "self" and target_user_id must be null

**confidence**:
- "high": Very clear fact statement ("mi juego favorito es X", "soy main X")
- "medium": Probable fact but could be context-dependent
- "low": Uncertain, might be temporary or joke

═══════════════════════════════════════════════════════════════════
### EXAMPLES:

Input: "llámame Ganzabio"
Output: {
  "should_store": true,
  "key": "preferred_name",
  "value": "Ganzabio",
  "target": "self",
  "target_user_id": null,
  "confidence": "high"
}

Input: "call me José"
Output: {
  "should_store": true,
  "key": "preferred_name",
  "value": "José",
  "target": "self",
  "target_user_id": null,
  "confidence": "high"
}

Input: "mi juego favorito es Persona 5"
Output: {
  "should_store": true,
  "key": "favorite_game",
  "value": "Persona 5",
  "target": "self",
  "target_user_id": null,
  "confidence": "high"
}

Input: "soy main Jinx"
Output: {
  "should_store": true,
  "key": "main_champion",
  "value": "Jinx",
  "target": "self",
  "target_user_id": null,
  "confidence": "high"
}

Input: "trabajo en marketing"
Output: {
  "should_store": true,
  "key": "job",
  "value": "marketing",
  "target": "self",
  "target_user_id": null,
  "confidence": "high"
}

Input: "estoy cansado"
Output: {
  "should_store": false,
  "key": null,
  "value": null,
  "target": "self",
  "target_user_id": null,
  "confidence": "high"
}

Input: "mi hermana se llama Ana"
Output: {
  "should_store": true,
  "key": "sister_name",
  "value": "Ana",
  "target": "self",
  "target_user_id": null,
  "confidence": "high"
}

Input: "<@123456> es mi mejor amigo"
Output: {
  "should_store": true,
  "key": "best_friend",
  "value": "best friend relationship",
  "target": "other",
  "target_user_id": "123456",
  "confidence": "high"
}

Input: "a Faiber le gustan los hombres" (no @mention present)
Output: {
  "should_store": false,
  "key": null,
  "value": null,
  "target": "self",
  "target_user_id": null,
  "confidence": "high"
}

Input: "tambien recuerda que a Faiber le gustan los hombres" (no @mention present)
Output: {
  "should_store": false,
  "key": null,
  "value": null,
  "target": "self",
  "target_user_id": null,
  "confidence": "high"
}

Input: "me gusta dibujar"
Output: {
  "should_store": true,
  "key": "hobby",
  "value": "dibujar",
  "target": "self",
  "target_user_id": null,
  "confidence": "medium"
}

Input: "¿cuál es tu juego favorito?"
Output: {
  "should_store": false,
  "key": null,
  "value": null,
  "target": "self",
  "target_user_id": null,
  "confidence": "high"
}

═══════════════════════════════════════════════════════════════════

Remember: When in doubt, DON'T store. Only save facts that will be useful 
weeks or months from now. Temporary states and opinions are not facts.
NEVER store third-party claims about someone who is not explicitly @mentioned.
`.trim();

  const userPrompt = `
Author: ${authorName}
Discord ID: ${authorId}
${mentions ? `Mentioned users: ${mentions}` : ""}
Message: "${content}"

Analyze and output JSON only.
`.trim();

  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 200,
      temperature: 0.0, // Deterministic for classification
      response_format: { type: "json_object" }, // Enforce JSON output if supported
    });

    const raw = completion.choices[0]?.message?.content ?? "";

    // Try to parse JSON
    let parsed: DetectedFact;

    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      // Try to extract JSON from markdown if LLM wrapped it
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        console.error("[FACT DETECTOR] Failed to parse JSON:", raw);
        return null;
      }
    }

    // Validate the response
    if (!parsed.should_store) {
      return null;
    }

    // Sanity checks
    if (!parsed.key || !parsed.value) {
      console.warn("[FACT DETECTOR] Missing key or value despite should_store=true");
      return null;
    }

    // Validate target_user_id format if present
    if (parsed.target === "other" && parsed.target_user_id) {
      // Should be numeric Discord ID
      if (!/^\d+$/.test(parsed.target_user_id)) {
        console.warn("[FACT DETECTOR] Invalid target_user_id format:", parsed.target_user_id);
        parsed.target_user_id = null;
      }
    }

    // Log successful detection
    console.log("[FACT DETECTED]", {
      author: authorName,
      key: parsed.key,
      value: parsed.value,
      confidence: parsed.confidence || "unknown",
    });

    return parsed;

  } catch (err) {
    console.error("[FACT DETECTOR] LLM call failed:", err);
    return null;
  }
}

/* ============================================================
 *  BATCH DETECTION (Optional: for analyzing multiple messages)
 * ============================================================ */

/**
 * Detects facts from multiple messages in one go.
 * Useful for analyzing conversation history or backfilling.
 */
export async function detectFactsBatch(
  messages: Message[]
): Promise<Array<{ message: Message; fact: DetectedFact }>> {
  const results: Array<{ message: Message; fact: DetectedFact }> = [];

  // Process in small batches to avoid rate limits
  const batchSize = 5;
  for (let i = 0; i < messages.length; i += batchSize) {
    const batch = messages.slice(i, i + batchSize);
    const promises = batch.map((msg) => detectFactWithLLM(msg));
    const facts = await Promise.all(promises);

    facts.forEach((fact, idx) => {
      if (fact) {
        results.push({ message: batch[idx], fact });
      }
    });

    // Small delay to avoid rate limits
    if (i + batchSize < messages.length) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return results;
}