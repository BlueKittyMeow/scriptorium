import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { seedUser } from './helpers.js';

/**
 * Ownership-lite (§C.1 first slice): novels carry an owner_id; archivists may
 * assign it; the library groups by owner. No permission enforcement rides on
 * owner_id yet.
 *
 * These tests exercise the migration + owner-resolution logic against in-memory
 * databases (the route handlers themselves depend on $env/SvelteKit and can't
 * be imported here), plus source-greps for the client-side wiring.
 */

// ─── Legacy schema WITHOUT owner_id (pre-migration) ──────────────────
const LEGACY_SCHEMA = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'writer' CHECK(role IN ('writer', 'archivist')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE novels (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
`;

/** Replicates runOwnershipMigration() from src/lib/server/db.ts. */
function runOwnershipMigration(db: Database.Database): void {
	const cols = db.prepare(`PRAGMA table_info(novels)`).all() as { name: string }[];
	if (!cols.some((c) => c.name === 'owner_id')) {
		db.exec(`ALTER TABLE novels ADD COLUMN owner_id TEXT REFERENCES users(id)`);
	}
	db.prepare(
		`UPDATE novels
		 SET owner_id = (SELECT id FROM users WHERE role = 'archivist' ORDER BY created_at LIMIT 1)
		 WHERE owner_id IS NULL`
	).run();
}

/** Replicates resolveOwnerId() shared by the create/import handlers. */
function resolveOwnerId(
	db: Database.Database,
	user: { id: string; role: string },
	requested: unknown
): string {
	const self = user.id;
	if (user.role !== 'archivist') return self;
	if (typeof requested !== 'string' || !requested) return self;
	const exists = db.prepare('SELECT id FROM users WHERE id = ?').get(requested);
	return exists ? requested : self;
}

function legacyDb(): Database.Database {
	const db = new Database(':memory:');
	db.exec(LEGACY_SCHEMA);
	return db;
}

describe('ownership migration', () => {
	it('adds owner_id to a legacy novels table that lacks it', () => {
		const db = legacyDb();
		const before = (db.prepare('PRAGMA table_info(novels)').all() as { name: string }[]).map(
			(c) => c.name
		);
		expect(before).not.toContain('owner_id');

		runOwnershipMigration(db);

		const after = (db.prepare('PRAGMA table_info(novels)').all() as { name: string }[]).map(
			(c) => c.name
		);
		expect(after).toContain('owner_id');
	});

	it('backfills NULL owners to the oldest archivist', () => {
		const db = legacyDb();
		const now = new Date().toISOString();
		// Archivist created first, a writer second.
		const archivist = seedUser(db, 'archivist', 'UponMidnight');
		seedUser(db, 'writer', 'Lunamaiye');
		db.prepare('INSERT INTO novels (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
			'nov-legacy',
			'Existing Prod Novel',
			now,
			now
		);

		runOwnershipMigration(db);

		const row = db.prepare('SELECT owner_id FROM novels WHERE id = ?').get('nov-legacy') as {
			owner_id: string;
		};
		expect(row.owner_id).toBe(archivist.id);
	});

	it('is a no-op (no throw, owner stays NULL) when no archivist exists yet', () => {
		const db = legacyDb();
		const now = new Date().toISOString();
		seedUser(db, 'writer', 'OnlyWriter');
		db.prepare('INSERT INTO novels (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
			'nov-x',
			'No Owner Yet',
			now,
			now
		);

		expect(() => runOwnershipMigration(db)).not.toThrow();
		const row = db.prepare('SELECT owner_id FROM novels WHERE id = ?').get('nov-x') as {
			owner_id: string | null;
		};
		expect(row.owner_id).toBeNull();
	});

	it('is idempotent — a second run does not clobber assigned owners', () => {
		const db = legacyDb();
		const now = new Date().toISOString();
		const archivist = seedUser(db, 'archivist', 'UponMidnight');
		const writer = seedUser(db, 'writer', 'Lunamaiye');
		runOwnershipMigration(db);
		// Reassign to the writer, then run again — backfill only touches NULLs.
		db.prepare('UPDATE novels SET owner_id = ? WHERE 1=0').run(writer.id); // no rows yet
		db.prepare('INSERT INTO novels (id, title, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
			'nov-owned',
			'Owned By Writer',
			writer.id,
			now,
			now
		);

		runOwnershipMigration(db);

		const row = db.prepare('SELECT owner_id FROM novels WHERE id = ?').get('nov-owned') as {
			owner_id: string;
		};
		expect(row.owner_id).toBe(writer.id);
		expect(row.owner_id).not.toBe(archivist.id);
	});
});

describe('owner resolution on create/import', () => {
	function seededDb() {
		const db = new Database(':memory:');
		db.exec(LEGACY_SCHEMA);
		const archivist = seedUser(db, 'archivist', 'UponMidnight');
		const writer = seedUser(db, 'writer', 'Lunamaiye');
		return { db, archivist, writer };
	}

	it('ignores a foreign owner_id from a writer — forces self', () => {
		const { db, archivist, writer } = seededDb();
		const result = resolveOwnerId(db, writer, archivist.id);
		expect(result).toBe(writer.id);
	});

	it('respects a valid owner_id from an archivist', () => {
		const { db, archivist, writer } = seededDb();
		const result = resolveOwnerId(db, archivist, writer.id);
		expect(result).toBe(writer.id);
	});

	it('falls back to self when an archivist sends a bogus owner_id', () => {
		const { db, archivist } = seededDb();
		const result = resolveOwnerId(db, archivist, 'no-such-user');
		expect(result).toBe(archivist.id);
	});

	it('falls back to self when an archivist omits owner_id', () => {
		const { db, archivist } = seededDb();
		expect(resolveOwnerId(db, archivist, undefined)).toBe(archivist.id);
		expect(resolveOwnerId(db, archivist, '')).toBe(archivist.id);
	});
});

describe('server-side load + library wiring (source-grep)', () => {
	it('db.ts declares owner_id in the base schema and exports the migration', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/lib/server/db.ts', 'utf-8');
		expect(source).toContain('owner_id TEXT REFERENCES users(id)');
		expect(source).toContain('runOwnershipMigration');
	});

	it('GET /api/novels joins the owner username', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/routes/api/novels/+server.ts', 'utf-8');
		expect(source).toContain('owner_username');
		expect(source).toContain('resolveOwnerId');
	});

	it('+page.server.ts exists and returns the novels list', async () => {
		const fs = await import('fs');
		expect(fs.existsSync('src/routes/+page.server.ts')).toBe(true);
		const source = fs.readFileSync('src/routes/+page.server.ts', 'utf-8');
		expect(source).toContain('owner_username');
		expect(source).toContain('return { novels }');
	});

	it('+page.svelte no longer fetches /api/novels in onMount', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/routes/+page.svelte', 'utf-8');
		// No onMount at all — initial data comes from the server load.
		expect(source).not.toContain('onMount');
		// But the client refresh still re-fetches after create/import.
		expect(source).toContain("fetch('/api/novels')");
		expect(source).toContain('data.novels');
	});

	it('renders the bookshelf shelf chips', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/routes/+page.svelte', 'utf-8');
		expect(source).toContain('shelf-toggle');
		expect(source).toContain('shelf-chip');
		expect(source).toContain('scriptorium-shelf');
	});
});
