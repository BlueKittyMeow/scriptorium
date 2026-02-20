import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Schema duplicated from src/lib/server/db.ts to avoid $env dependency
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
CREATE TABLE IF NOT EXISTS compile_configs (
  id TEXT PRIMARY KEY,
  novel_id TEXT NOT NULL REFERENCES novels(id),
  name TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'docx',
  include_ids TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snapshots_document ON snapshots(document_id);
CREATE INDEX IF NOT EXISTS idx_compile_configs_novel ON compile_configs(novel_id);
`;

/** Create a fresh in-memory database with full schema */
export function createTestDb(): Database.Database {
	const db = new Database(':memory:');
	db.pragma('journal_mode = WAL');
	db.pragma('foreign_keys = ON');
	db.exec(SCHEMA);
	return db;
}

/** Create a temp directory for test data (content files, snapshots) */
export function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-test-'));
}

/** Clean up a temp directory */
export function cleanupTempDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

const now = new Date().toISOString();

/** Seed a novel with a folder containing two documents, all with FTS entries */
export function seedNovelWithDocs(db: Database.Database): {
	novelId: string;
	folderId: string;
	doc1Id: string;
	doc2Id: string;
} {
	const novelId = 'novel-1';
	const folderId = 'folder-1';
	const doc1Id = 'doc-1';
	const doc2Id = 'doc-2';

	db.prepare(`INSERT INTO novels (id, title, status, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?)`).run(novelId, 'Test Novel', now, now);

	db.prepare(`INSERT INTO folders (id, novel_id, parent_id, title, folder_type, sort_order, created_at, updated_at) VALUES (?, ?, NULL, ?, 'manuscript', 1.0, ?, ?)`).run(folderId, novelId, 'Manuscript', now, now);

	db.prepare(`INSERT INTO documents (id, novel_id, parent_id, title, word_count, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(doc1Id, novelId, folderId, 'Chapter One', 100, 1.0, now, now);

	db.prepare(`INSERT INTO documents (id, novel_id, parent_id, title, word_count, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(doc2Id, novelId, folderId, 'Chapter Two', 200, 2.0, now, now);

	// FTS entries
	db.prepare('INSERT INTO documents_fts (doc_id, title, content) VALUES (?, ?, ?)').run(doc1Id, 'Chapter One', 'It was a dark and stormy night');
	db.prepare('INSERT INTO documents_fts (doc_id, title, content) VALUES (?, ?, ?)').run(doc2Id, 'Chapter Two', 'The sun rose over the mountains');

	return { novelId, folderId, doc1Id, doc2Id };
}
