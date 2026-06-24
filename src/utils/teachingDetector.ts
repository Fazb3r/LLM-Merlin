// src/utils/teachingDetector.ts
import type { Message } from "discord.js";
import { insertUserFact, upsertServerDefinition } from "../data/db";

/**
 * Types returned by the teaching detector.
 */
export type TeachingResult =
  | {
      kind: "user_fact";
      key: string;
      value: string;
      targetUserId: string;
    }
  | {
      kind: "server_term";
      term: string;
      definition: string;
    }
  | null;

/* ---------------------------------------------------------
 * TERM VALIDATION GUARDS
 * --------------------------------------------------------- */

/** Returns true if the term is clean enough to store. */
function isValidTerm(term: string): boolean {
  if (!term || term.length < 3 || term.length > 50) return false;

  // Reject if it contains a Discord mention
  if (/<@!?\d+>/.test(term)) return false;

  // Reject if it starts with a pronoun, article, or question word
  const badStarters =
    /^(el|la|los|las|un|una|mi|tu|su|sus|esto|eso|aqui|ahi|alla|que|como|quien|donde|cuando|por|para|con|sin|y|o|pero|mas|muy|si|no|merlin|mer|ya|hay|hoy|ser|estar|tiene|tengo|yo|me|te|le|nos|vos|usted)\b/i;
  if (badStarters.test(term.trim())) return false;

  // Reject if it looks like a sentence fragment (has punctuation or multiple clauses)
  if (/[,!?;:]/.test(term)) return false;

  return true;
}

/** Returns true if the definition has enough substance. */
function isValidDefinition(def: string): boolean {
  if (!def || def.trim().length < 5) return false;
  // Need at least 2 words
  if (def.trim().split(/\s+/).length < 2) return false;
  // Reject if it contains a Discord mention as the whole thing
  if (/^<@!?\d+>$/.test(def.trim())) return false;
  return true;
}

/**
 * Detects when the user is *teaching* Merlin a new fact.
 * If a teaching pattern is found, stores it into the SQLite DB.
 *
 * STRICT MODE: server_lexicon entries now require explicit teaching intent.
 * Generic "X es Y" sentences no longer trigger storage.
 */
export function detectAndStoreTeaching(message: Message): TeachingResult {
  const raw = message.content.trim();

  const authorId = message.author.id;
  const authorUsername = message.author.username;
  const guildId = message.guildId ?? "dm";

  /* ---------------------------------------------------------
   * 1) SELF FACTS — "mi juego favorito es X"
   * --------------------------------------------------------- */
  {
    const pattern = /mi\s+juego\s+favorito\s+es\s+(.+)/i;
    const match = raw.match(pattern);

    if (match) {
      const value = match[1].trim();
      const key = "favorite_game";

      insertUserFact.run(authorId, key, value);

      console.log(
        `[TEACHING] Stored user_fact for user ${authorId}: ${key} = "${value}"`
      );

      return {
        kind: "user_fact",
        key,
        value,
        targetUserId: authorId,
      };
    }
  }

  /* ---------------------------------------------------------
   * 2) THIRD-PERSON FACTS — "El juego favorito de @User es X"
   * --------------------------------------------------------- */
  {
    const mentionedUser = message.mentions.users.first();

    if (mentionedUser) {
      const pattern =
        /el\s+juego\s+favorito\s+de\s+.+?\s+es\s+(.+)/i;
      const match = raw.match(pattern);

      if (match) {
        const value = match[1].trim();
        const key = "favorite_game";

        insertUserFact.run(mentionedUser.id, key, value);

        console.log(
          `[TEACHING] Stored third-person user_fact for user ${mentionedUser.id}: ${key} = "${value}"`
        );

        return {
          kind: "user_fact",
          key,
          value,
          targetUserId: mentionedUser.id,
        };
      }
    }
  }

  /* ---------------------------------------------------------
   * 3) SERVER TERMS — STRICT detection only.
   *
   * OLD (broken): matched ANY "X es Y" sentence, causing garbage.
   * NEW: only triggers on EXPLICIT teaching keywords:
   *   - "X significa Y"
   *   - "X se define como Y"
   *   - "X quiere decir Y"
   *   - "merlin, X es Y"   ← must address Merlin
   *   - "mer X es Y"
   *
   * Additionally: term and definition are validated before storing.
   * --------------------------------------------------------- */
  {
    // Pattern A: Explicit teaching verb (works without addressing Merlin)
    const explicitPattern =
      /^[""]?([^<>\n,?!]{3,50})[""]?\s+(?:significa|se define como|quiere decir)\s+(.+)/i;

    // Pattern B: Addressed to Merlin + "es" (e.g. "merlin, puchaina es un jugador malo")
    const merlinPattern =
      /^mer(?:lin)?[,\s]+[""]?([^<>\n,?!]{3,50})[""]?\s+es\s+(.+)/i;

    const match = raw.match(explicitPattern) || raw.match(merlinPattern);

    if (match) {
      const term = match[1].trim();
      const definition = match[2].trim();

      // Validate both term and definition before storing
      if (!isValidTerm(term) || !isValidDefinition(definition)) {
        console.log(
          `[TEACHING] Rejected server_term: term="${term}" def="${definition}" (failed validation)`
        );
        return null;
      }

      upsertServerDefinition.run({
        guild_id: guildId,
        term,
        definition,
        taught_by: authorId,
        taught_by_username: authorUsername,
        source_msg_id: message.id,
        nsfw: 0,
      });

      console.log(
        `[TEACHING] Stored server_term "${term}" => "${definition}" (guild ${guildId}, by ${authorUsername})`
      );

      return {
        kind: "server_term",
        term,
        definition,
      };
    }
  }

  /* ---------------------------------------------------------
   * No teaching detected
   * --------------------------------------------------------- */
  return null;
}
