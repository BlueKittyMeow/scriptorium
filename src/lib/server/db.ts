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

	try {
		fs.mkdirSync(DATA_ROOT, { recursive: true });

		const dbPath = path.join(DATA_ROOT, 'scriptorium.db');
		_db = new Database(dbPath);

		// Enable WAL mode for concurrent reads during writes
		_db.pragma('journal_mode = WAL');
		_db.pragma('foreign_keys = ON');
		_db.pragma('busy_timeout = 5000');

		// Run schema
		_db.exec(SCHEMA);

		// Ownership-lite mini-migration (idempotent, runs every boot).
		// Adds novels.owner_id for legacy databases created before the column
		// existed, then backfills any NULL owners to the first archivist.
		runOwnershipMigration(_db);

		// Import-source mini-migration (idempotent). Adds novels.import_source
		// for legacy databases so bundle/scriv re-imports become detectable.
		runImportSourceMigration(_db);

		// Collections mini-migration (idempotent). Adds the collections table
		// and novels.collection_id / novels.stack_label for legacy databases
		// so the library bookshelf (universes → eras → version stacks) works.
		runCollectionsMigration(_db);

		// Feedback mini-migration (idempotent). Adds the feedback table
		// (Requests & Questions tab, /help) for legacy databases.
		runFeedbackMigration(_db);

		// Roadmap hearts mini-migration (idempotent). Adds the roadmap_hearts
		// table (per-user "I want this sooner" toggle on the Roadmap tab).
		runRoadmapHeartsMigration(_db);
	} catch (err) {
		_db = null;
		throw new Error(`Database initialization failed (DATA_ROOT=${DATA_ROOT}): ${err instanceof Error ? err.message : err}`);
	}

	return _db;
}

/**
 * Ownership-lite migration. Exported so tests can exercise it against a
 * legacy database created without the owner_id column.
 *
 * 1. If novels.owner_id is missing, add it (nullable, references users).
 * 2. Backfill any NULL owner to the oldest archivist. No-op when no
 *    archivist exists yet (fresh setup) — the column simply stays NULL
 *    until an archivist is created and the next boot backfills.
 *
 * Note: this is ownership *tagging* only. No permission enforcement rides
 * on owner_id yet — any authenticated user may still edit any novel. The
 * per-novel access-level matrix (docs/ux-and-stats-ideas.md §C.1) lands later.
 */
export function runOwnershipMigration(db: Database.Database): void {
	const cols = db.prepare(`PRAGMA table_info(novels)`).all() as { name: string }[];
	const hasOwner = cols.some((c) => c.name === 'owner_id');
	if (!hasOwner) {
		db.exec(`ALTER TABLE novels ADD COLUMN owner_id TEXT REFERENCES users(id)`);
	}
	// Idempotent backfill — no-op when no archivist exists or all novels already owned.
	db.prepare(
		`UPDATE novels
		 SET owner_id = (SELECT id FROM users WHERE role = 'archivist' ORDER BY created_at LIMIT 1)
		 WHERE owner_id IS NULL`
	).run();
}

/**
 * Import-source migration. Exported so tests can exercise it against a
 * legacy database created without the import_source column.
 *
 * Adds novels.import_source (nullable) if missing. This is the idempotency
 * handle for bulk import: bundle imports tag novels `bundle:<work key>` and
 * batch .scriv imports tag them `scriv:<basename>`, so a re-run can detect
 * and skip work already ingested. No backfill — legacy novels simply stay
 * NULL (they were never imported through the tagged paths).
 */
export function runImportSourceMigration(db: Database.Database): void {
	const cols = db.prepare(`PRAGMA table_info(novels)`).all() as { name: string }[];
	if (!cols.some((c) => c.name === 'import_source')) {
		db.exec(`ALTER TABLE novels ADD COLUMN import_source TEXT`);
	}
}

/**
 * Collections migration (library bookshelf, W.4 first slice). Exported so
 * tests can exercise it against a legacy database created before collections
 * existed. Idempotent — safe to run every boot.
 *
 * 1. Create the collections table if missing (one level of nesting via a
 *    self-referential parent_id; null parent = top-level "universe", a set
 *    parent = child "era").
 * 2. Add novels.collection_id (nullable — null novels fall to Unsorted).
 * 3. Add novels.stack_label (nullable — novels sharing a label within the same
 *    collection render as one visual version-stack; no new table).
 * 4. (v2.1) Add collections.owner_id (nullable, references users) — each
 *    collection belongs to one user's shelf space — and backfill orphans
 *    (see backfillCollectionOwners below).
 *
 * Novels get no backfill: legacy novels simply stay Unsorted and unstacked
 * until the operator files them.
 */
export function runCollectionsMigration(db: Database.Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS collections (
		  id TEXT PRIMARY KEY,
		  title TEXT NOT NULL,
		  parent_id TEXT REFERENCES collections(id),
		  owner_id TEXT REFERENCES users(id),
		  sort_order REAL NOT NULL,
		  created_at TEXT NOT NULL,
		  updated_at TEXT NOT NULL
		);
	`);
	// Guarded ALTER for the v2 legacy shape: table exists, owner_id doesn't.
	const collCols = db.prepare(`PRAGMA table_info(collections)`).all() as { name: string }[];
	if (!collCols.some((c) => c.name === 'owner_id')) {
		db.exec(`ALTER TABLE collections ADD COLUMN owner_id TEXT REFERENCES users(id)`);
	}
	const cols = db.prepare(`PRAGMA table_info(novels)`).all() as { name: string }[];
	if (!cols.some((c) => c.name === 'collection_id')) {
		db.exec(`ALTER TABLE novels ADD COLUMN collection_id TEXT REFERENCES collections(id)`);
	}
	if (!cols.some((c) => c.name === 'stack_label')) {
		db.exec(`ALTER TABLE novels ADD COLUMN stack_label TEXT`);
	}
	backfillCollectionOwners(db, cols);
}

/**
 * v2.1 backfill: give every owner-less collection an owner. The truly right
 * target ("the writer who owns the imported corpus") is a production fact a
 * generic migration can't know, so it is derived from the members instead:
 *
 * - A collection whose (live) member novels all share one owner gets that
 *   owner. For a top-level "universe" the members of its child eras count
 *   too — the common shape is a universe with no directly-assigned novels
 *   whose eras hold one writer's books; falling back to the archivist there
 *   would hand the writer's universe to the wrong user AND violate the
 *   child-shares-parent-owner rule.
 * - A memberless or mixed-owner child era inherits its parent's (just
 *   resolved) owner, keeping subtrees single-owner.
 * - Anything else falls back to the first archivist (same idea as the
 *   ownership migration). No archivist yet → stays NULL until the next boot.
 *
 * Idempotent: only NULL owner_id rows are ever touched. Top-levels are
 * processed before children so parent inheritance sees resolved values.
 * Skips entirely when there is nothing to backfill, or when the database
 * predates the users table / novels.owner_id (fresh setups mid-schema).
 */
export function backfillCollectionOwners(
	db: Database.Database,
	novelCols: { name: string }[]
): void {
	const orphaned = db
		.prepare(
			`SELECT id, parent_id FROM collections WHERE owner_id IS NULL
			 ORDER BY (parent_id IS NOT NULL), created_at, id`
		)
		.all() as { id: string; parent_id: string | null }[];
	if (orphaned.length === 0) return;
	const hasUsersTable = !!db
		.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='users'`)
		.get();
	if (!hasUsersTable || !novelCols.some((c) => c.name === 'owner_id')) return;

	const archivist = db
		.prepare(`SELECT id FROM users WHERE role = 'archivist' ORDER BY created_at LIMIT 1`)
		.get() as { id: string } | undefined;
	const subtreeOwners = db.prepare(
		`SELECT DISTINCT n.owner_id AS oid FROM novels n
		 WHERE n.deleted_at IS NULL AND n.owner_id IS NOT NULL
		   AND (n.collection_id = @id
		        OR n.collection_id IN (SELECT c.id FROM collections c WHERE c.parent_id = @id))`
	);
	const directOwners = db.prepare(
		`SELECT DISTINCT n.owner_id AS oid FROM novels n
		 WHERE n.deleted_at IS NULL AND n.owner_id IS NOT NULL AND n.collection_id = ?`
	);
	const parentOwner = db.prepare(`SELECT owner_id FROM collections WHERE id = ?`);
	const setOwner = db.prepare(`UPDATE collections SET owner_id = ? WHERE id = ?`);

	for (const row of orphaned) {
		const owners = (
			row.parent_id === null ? subtreeOwners.all({ id: row.id }) : directOwners.all(row.id)
		).map((r: any) => r.oid as string);
		let owner: string | null = null;
		if (owners.length === 1) {
			owner = owners[0];
		} else if (row.parent_id !== null) {
			owner =
				((parentOwner.get(row.parent_id) as { owner_id: string | null } | undefined)?.owner_id ??
					archivist?.id) ??
				null;
		} else {
			owner = archivist?.id ?? null;
		}
		if (owner) setOwner.run(owner, row.id);
	}
}

/**
 * Feedback migration (Requests & Questions tab, /help). Exported so tests
 * can exercise it against a legacy database created before this feature
 * existed. Idempotent (CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT
 * EXISTS) — brand-new standalone table, so unlike the collections/ownership
 * migrations there's no existing-table ALTER to guard.
 */
export function runFeedbackMigration(db: Database.Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS feedback (
		  id TEXT PRIMARY KEY,
		  author_id TEXT NOT NULL REFERENCES users(id),
		  type TEXT NOT NULL CHECK(type IN ('feature','bug','question')),
		  title TEXT NOT NULL,
		  body TEXT,
		  status TEXT NOT NULL DEFAULT 'open',
		  response TEXT,
		  created_at TEXT NOT NULL,
		  updated_at TEXT NOT NULL
		);
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at)`);
}

/**
 * Roadmap hearts migration (Roadmap tab, /help). Exported so tests can
 * exercise it against a legacy database created before this feature
 * existed. One row per (item_key, user_id) — the composite primary key is
 * the toggle: insert to heart, delete to un-heart. Idempotent, standalone
 * new table, no ALTER needed.
 */
export function runRoadmapHeartsMigration(db: Database.Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS roadmap_hearts (
		  item_key TEXT NOT NULL,
		  user_id TEXT NOT NULL REFERENCES users(id),
		  created_at TEXT NOT NULL,
		  PRIMARY KEY (item_key, user_id)
		);
	`);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS novels (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  subtitle TEXT,
  status TEXT DEFAULT 'draft',
  word_count_target INTEGER,
  owner_id TEXT REFERENCES users(id),
  import_source TEXT,
  collection_id TEXT REFERENCES collections(id),
  stack_label TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  parent_id TEXT REFERENCES collections(id),
  owner_id TEXT REFERENCES users(id),
  sort_order REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
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

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'writer' CHECK(role IN ('writer', 'archivist')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

CREATE INDEX IF NOT EXISTS idx_snapshots_document ON snapshots(document_id);
CREATE INDEX IF NOT EXISTS idx_compile_configs_novel ON compile_configs(novel_id);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK(type IN ('feature','bug','question')),
  title TEXT NOT NULL,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  response TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);

CREATE TABLE IF NOT EXISTS roadmap_hearts (
  item_key TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (item_key, user_id)
);
`;
