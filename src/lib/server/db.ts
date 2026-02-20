import Database from 'better-sqlite3';
import { env } from '$env/dynamic/private';
import fs from 'fs';
import path from 'path';

const DATA_ROOT = env.DATA_ROOT || './data';

let _db: Database.Database | null = null;

export function getDataRoot(): string {
	return DATA_ROOT;
}

export function getDb(): Database.Database {
	if (_db) return _db;

	fs.mkdirSync(DATA_ROOT, { recursive: true });

	const dbPath = path.join(DATA_ROOT, 'scriptorium.db');
	_db = new Database(dbPath);

	// Enable WAL mode for concurrent reads during writes
	_db.pragma('journal_mode = WAL');
	_db.pragma('foreign_keys = ON');

	// Run schema
	_db.exec(SCHEMA);

	return _db;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS novels (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  subtitle TEXT,
  status TEXT DEFAULT 'draft',
  word_count_target INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  novel_id TEXT NOT NULL REFERENCES novels(id),
  parent_id TEXT,
  title TEXT NOT NULL,
  folder_type TEXT,
  sort_order REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  novel_id TEXT NOT NULL REFERENCES novels(id),
  parent_id TEXT,
  title TEXT NOT NULL,
  synopsis TEXT,
  word_count INTEGER DEFAULT 0,
  compile_include INTEGER DEFAULT 1,
  sort_order REAL NOT NULL,
  last_snapshot_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  content_path TEXT NOT NULL,
  word_count INTEGER,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  doc_id UNINDEXED,
  title,
  content
);

CREATE INDEX IF NOT EXISTS idx_folders_novel ON folders(novel_id);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
CREATE INDEX IF NOT EXISTS idx_documents_novel ON documents(novel_id);
CREATE INDEX IF NOT EXISTS idx_documents_parent ON documents(parent_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_document ON snapshots(document_id);
`;
