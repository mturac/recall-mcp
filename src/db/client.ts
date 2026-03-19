import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize better-sqlite3
const dbPath = process.env.DB_PATH || join(__dirname, '../../../data/brain.db');
if (dbPath !== ':memory:') {
  mkdirSync(dirname(dbPath), { recursive: true });
}

export const db = new Database(dbPath);

// Apply PRAGMAs
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

// Load sqlite-vec extension
sqliteVec.load(db);

// Schema creation
db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    namespace TEXT DEFAULT 'global',
    session_id TEXT,
    content TEXT,
    summary TEXT,
    category TEXT CHECK(category IN ('fact', 'preference', 'project', 'episodic', 'instruction', 'general')),
    weight TEXT CHECK(weight IN ('STRONG', 'MEDIUM', 'WEAK')),
    source TEXT,
    tags TEXT,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    access_count INTEGER DEFAULT 0
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    summary,
    tags,
    namespace,
    content='memories',
    content_rowid='rowid'
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
    embedding float[384]
  );

  -- Triggers to auto-sync memories_fts
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content, summary, tags, namespace)
    VALUES (new.rowid, new.content, new.summary, new.tags, new.namespace);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, summary, tags, namespace)
    VALUES('delete', old.rowid, old.content, old.summary, old.tags, old.namespace);
    
    DELETE FROM memories_vec WHERE rowid = old.rowid;
  END;

  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, summary, tags, namespace)
    VALUES('delete', old.rowid, old.content, old.summary, old.tags, old.namespace);
    
    INSERT INTO memories_fts(rowid, content, summary, tags, namespace)
    VALUES (new.rowid, new.content, new.summary, new.tags, new.namespace);
  END;
`);
