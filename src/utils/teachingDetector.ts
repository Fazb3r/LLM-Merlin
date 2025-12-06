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

/**
 * Detects when the user is *teaching* Merlin a new fact.
 * If a teaching pattern is found, stores it into the SQLite DB.
 */
export function detectAndStoreTeaching(message: Message): TeachingResult {
  const raw = message.content.trim();
  const lower = raw.toLowerCase();

  const authorId = message.author.id;
  const guildId = message.guildId ?? "dm";

  /* ---------------------------------------------------------
   * 1) SELF FACTS
   * e.g., "Merlin, mi juego favorito es League of Legends"
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
   * 2) THIRD-PERSON FACTS
   * e.g., "El juego favorito de @Josefufu es League of Legends"
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
   * 3) GENERIC SERVER TERMS
   * e.g., "puchaina significa X" or "puchaina es X"
   * --------------------------------------------------------- */
  {
    const pattern =
      /["“]?(.+?)["”]?\s+(?:es|significa)\s+(.+)/i;
    const match = raw.match(pattern);

    if (match) {
      const term = match[1].trim();
      const definition = match[2].trim();

      upsertServerDefinition.run({
        guild_id: guildId,
        term,
        definition,
        taught_by: authorId,
        source_msg_id: message.id,
        nsfw: 0,
      });

      console.log(
        `[TEACHING] Stored server_term "${term}" => "${definition}" (guild ${guildId})`
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
