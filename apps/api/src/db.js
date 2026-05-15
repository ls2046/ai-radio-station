import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../../..");
const dataDir = path.join(rootDir, "data");
const dbPath = path.join(dataDir, "radio.sqlite");

let dbInstance = null;

export function getDatabase() {
  if (dbInstance) return dbInstance;
  fs.mkdirSync(dataDir, { recursive: true });
  dbInstance = new DatabaseSync(dbPath);
  initializeDatabase(dbInstance);
  return dbInstance;
}

function initializeDatabase(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS playlist_history (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      opening_source TEXT NOT NULL DEFAULT 'none',
      source TEXT NOT NULL,
      mood TEXT NOT NULL,
      prompt TEXT NOT NULL,
      summary TEXT,
      energy TEXT,
      theme_tags_json TEXT NOT NULL,
      music_direction_json TEXT NOT NULL,
      chat_excerpt_json TEXT NOT NULL,
      song_count INTEGER NOT NULL,
      total_duration INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS playlist_songs (
      id TEXT PRIMARY KEY,
      playlist_id TEXT NOT NULL,
      sort_index INTEGER NOT NULL,
      song_id TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      style TEXT NOT NULL,
      duration TEXT NOT NULL,
      mood TEXT NOT NULL,
      source TEXT NOT NULL,
      audio_url TEXT,
      tags_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS listener_events (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      event_type TEXT NOT NULL,
      playlist_id TEXT,
      song_id TEXT,
      mood TEXT,
      tags_json TEXT NOT NULL,
      message_excerpt TEXT,
      context_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS minimax_logs (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      entrypoint TEXT NOT NULL,
      trigger_source TEXT,
      model TEXT NOT NULL,
      request_messages_json TEXT NOT NULL,
      request_params_json TEXT NOT NULL,
      response_text TEXT,
      response_json TEXT,
      status TEXT NOT NULL,
      error_message TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_playlist_history_created_at
      ON playlist_history (created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_playlist_songs_playlist_id
      ON playlist_songs (playlist_id, sort_index);

    CREATE INDEX IF NOT EXISTS idx_listener_events_created_at
      ON listener_events (created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_listener_events_playlist_id
      ON listener_events (playlist_id);

    CREATE INDEX IF NOT EXISTS idx_minimax_logs_created_at
      ON minimax_logs (created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_minimax_logs_entrypoint
      ON minimax_logs (entrypoint, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_minimax_logs_trigger_source
      ON minimax_logs (trigger_source, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_minimax_logs_status
      ON minimax_logs (status, created_at DESC);
  `);
}
