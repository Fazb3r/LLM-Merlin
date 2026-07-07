// src/data/db.ts
import Database from "better-sqlite3";
import path from "path";

const dbPath = path.resolve(process.cwd(), "src/data/merlin.db");
console.log("[DB] Using database at:", dbPath);

const db = new Database(dbPath);

/* ---------- TABLES ---------- */

db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  summary TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS server_lexicon (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  term TEXT NOT NULL,
  definition TEXT NOT NULL,
  taught_by TEXT,
  source_msg_id TEXT,
  nsfw INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (guild_id, term)
);

CREATE TABLE IF NOT EXISTS server_lore (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  description TEXT NOT NULL,
  created_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

/* Ensure (user_id, key) is unique so we can UPSERT facts */
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_facts_user_key
ON user_facts (user_id, key);
`);

/* ---------- MIGRATIONS (SCHEMA UPDATES) ---------- */

try {
  const columns = db.pragma("table_info(user_facts)") as any[];
  if (!columns.some((col) => col.name === "updated_at")) {
    db.exec("ALTER TABLE user_facts ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP");
    console.log("[DB] Migration: Added updated_at to user_facts");
  }
} catch (e) {
  console.error("[DB] Failed to migrate user_facts:", e);
}

try {
  const columns = db.pragma("table_info(user_profiles)") as any[];
  if (!columns.some((col) => col.name === "updated_at")) {
    db.exec("ALTER TABLE user_profiles ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP");
    console.log("[DB] Migration: Added updated_at to user_profiles");
  }
} catch (e) {
  console.error("[DB] Failed to migrate user_profiles:", e);
}

try {
  const columns = db.pragma("table_info(server_lexicon)") as any[];
  if (!columns.some((col) => col.name === "nsfw")) {
    db.exec("ALTER TABLE server_lexicon ADD COLUMN nsfw INTEGER DEFAULT 0");
    console.log("[DB] Migration: Added nsfw to server_lexicon");
  }
  if (!columns.some((col) => col.name === "updated_at")) {
    db.exec("ALTER TABLE server_lexicon ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP");
    console.log("[DB] Migration: Added updated_at to server_lexicon");
  }
  if (!columns.some((col) => col.name === "taught_by_username")) {
    db.exec("ALTER TABLE server_lexicon ADD COLUMN taught_by_username TEXT");
    console.log("[DB] Migration: Added taught_by_username to server_lexicon");
  }
} catch (e) {
  console.error("[DB] Failed to migrate server_lexicon:", e);
}

/* ---------- TYPES ---------- */

export interface MessageRow {
  id: number;
  user_id: string;
  username: string;
  channel_id: string;
  content: string;
  created_at: string; // ISO string
}

export interface UserProfileRow {
  user_id: string;
  username: string;
  summary: string | null;
  updated_at: string;
}

export interface UserFactRow {
  id: number;
  user_id: string;
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
}

export interface ServerLexiconRow {
  id: number;
  guild_id: string;
  term: string;
  definition: string;
  taught_by: string | null;
  taught_by_username: string | null;
  source_msg_id: string | null;
  nsfw: number;
  created_at: string;
  updated_at: string;
}

/* ---------- WRITE STATEMENTS ---------- */

export const insertMessage = db.prepare(`
  INSERT INTO messages (user_id, username, channel_id, content)
  VALUES (?, ?, ?, ?)
`);

/**
 * Insert or update a fine-grained user fact.
 * - If (user_id, key) does not exist → insert new row
 * - If it exists → update value + updated_at
 */
export const insertUserFact = db.prepare(`
  INSERT INTO user_facts (user_id, key, value, created_at, updated_at)
  VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON CONFLICT(user_id, key)
  DO UPDATE SET
    value = excluded.value,
    updated_at = CURRENT_TIMESTAMP
`);

export const upsertUserProfile = db.prepare(`
  INSERT INTO user_profiles (user_id, username, summary)
  VALUES (@user_id, @username, @summary)
  ON CONFLICT(user_id)
  DO UPDATE SET
    username = excluded.username,
    summary = excluded.summary,
    updated_at = CURRENT_TIMESTAMP
`);

export const upsertServerDefinition = db.prepare(`
  INSERT INTO server_lexicon (guild_id, term, definition, taught_by, taught_by_username, source_msg_id, nsfw)
  VALUES (@guild_id, @term, @definition, @taught_by, @taught_by_username, @source_msg_id, @nsfw)
  ON CONFLICT(guild_id, term)
  DO UPDATE SET
    definition = excluded.definition,
    taught_by = excluded.taught_by,
    taught_by_username = excluded.taught_by_username,
    source_msg_id = excluded.source_msg_id,
    nsfw = excluded.nsfw,
    updated_at = CURRENT_TIMESTAMP
`);

/* ---------- READ HELPERS (RAG) ---------- */

// 1) Recent messages in a channel (for short-term context)
const getRecentMessagesStmt = db.prepare(`
  SELECT id, user_id, username, channel_id, content, created_at
  FROM messages
  WHERE channel_id = ?
  ORDER BY created_at DESC
  LIMIT ?
`);

export function getRecentMessages(
  channelId: string,
  limit: number
): MessageRow[] {
  return getRecentMessagesStmt.all(channelId, limit) as MessageRow[];
}

// 2) User profile summary (long-term identity)
const getUserProfileStmt = db.prepare(`
  SELECT user_id, username, summary, updated_at
  FROM user_profiles
  WHERE user_id = ?
`);

export function getUserProfile(userId: string): UserProfileRow | null {
  const row = getUserProfileStmt.get(userId);
  return (row as UserProfileRow) || null;
}

// 3) User facts (fine-grained memory)
const getUserFactsStmt = db.prepare(`
  SELECT id, user_id, key, value, created_at, updated_at
  FROM user_facts
  WHERE user_id = ?
  ORDER BY updated_at DESC
  LIMIT ?
`);

export function getUserFacts(
  userId: string,
  limit: number
): UserFactRow[] {
  return getUserFactsStmt.all(userId, limit) as UserFactRow[];
}

// 4) Server-specific definition (slang / inside jokes)
const getServerDefinitionStmt = db.prepare(`
  SELECT *
  FROM server_lexicon
  WHERE guild_id = ?
    AND LOWER(term) = LOWER(?)
  ORDER BY updated_at DESC
  LIMIT 1
`);



export function getServerDefinition(
  guildId: string,
  term: string
): ServerLexiconRow | null {
  const row = getServerDefinitionStmt.get(guildId, term);
  return (row as ServerLexiconRow) || null;
}

/* ---------- SERVER LORE (AUTO-LEARNED CULTURE) ---------- */

export interface ServerLoreRow {
  id: number;
  guild_id: string;
  description: string;
  created_by: string | null;
  created_at: string;
}

// Fetch the latest auto-learned culture summary for a guild
const getLatestServerLoreStmt = db.prepare(`
  SELECT id, guild_id, description, created_by, created_at
  FROM server_lore
  WHERE guild_id = ? AND created_by = 'style_learner_auto'
  ORDER BY created_at DESC
  LIMIT 1
`);
export function getLatestServerLore(guildId: string): ServerLoreRow | null {
  const row = getLatestServerLoreStmt.get(guildId);
  return (row as ServerLoreRow) || null;
}

// Delete old auto-learned entries then insert new one (keeps only 1 auto entry per guild)
const deleteOldServerLoreStmt = db.prepare(`
  DELETE FROM server_lore
  WHERE guild_id = ? AND created_by = 'style_learner_auto'
`);
const insertServerLoreStmt = db.prepare(`
  INSERT INTO server_lore (guild_id, description, created_by)
  VALUES (?, ?, 'style_learner_auto')
`);
export function replaceServerLore(guildId: string, description: string): void {
  const tx = db.transaction(() => {
    deleteOldServerLoreStmt.run(guildId);
    insertServerLoreStmt.run(guildId, description);
  });
  tx();
}

// Fetch recent messages across ALL channels (for cross-channel style analysis)
const getRecentMessagesAllStmt = db.prepare(`
  SELECT id, user_id, username, channel_id, content, created_at
  FROM messages
  ORDER BY created_at DESC
  LIMIT ?
`);
export function getRecentMessagesAll(limit: number): MessageRow[] {
  return getRecentMessagesAllStmt.all(limit) as MessageRow[];
}
