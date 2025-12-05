// src/data/db.ts
import Database from "better-sqlite3";
import path from "path";

// Always point to the same file from the project root,
// no matter if we run src/ or dist/
const dbPath = path.resolve(process.cwd(), "src/data/merlin.db");
console.log("[DB] Using database at:", dbPath);

const db = new Database(dbPath);

// --- TABLE CREATION ---
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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

// --- INSERT FUNCTIONS ---

export const insertMessage = db.prepare(`
  INSERT INTO messages (user_id, username, channel_id, content)
  VALUES (?, ?, ?, ?)
`);

export const insertUserFact = db.prepare(`
  INSERT INTO user_facts (user_id, key, value)
  VALUES (?, ?, ?)
`);

export const upsertUserProfile = db.prepare(`
  INSERT INTO user_profiles (user_id, username, summary)
  VALUES (@user_id, @username, @summary)
  ON CONFLICT(user_id)
  DO UPDATE SET summary = @summary, updated_at = CURRENT_TIMESTAMP
`);

// --- QUERY HELPERS ---

export const getRecentMessages = db.prepare(`
  SELECT username, content, created_at
  FROM messages
  WHERE channel_id = ?
  ORDER BY created_at DESC
  LIMIT ?
`);

export const getUserProfile = db.prepare(`
  SELECT * FROM user_profiles
  WHERE user_id = ?
`);
