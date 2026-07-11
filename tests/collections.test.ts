import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import { createTestDb } from './helpers.js';

/**
 * Library Collections v2 (universes → eras → version stacks). Covers the
 * guarded migration, the /api/collections surface (title + one-level-nesting
 * rules, delete semantics), and novel assignment (collection_id + stack_label
 * with omitted/null/value distinction). Route handlers only touch locals.db,
 * so they're imported and called directly against an in-memory database.
 */

const now = new Date().toISOString();
const user = { id: 'u1', username: 'tester', role: 'archivist' };
const writer = { id: 'w1', username: 'scribbler', role: 'writer' };
const locals = (db: Database.Database) => ({ user, db }) as any;
const localsAs = (db: Database.Database, u: typeof user) => ({ user: u, db }) as any;

/** Seed the acting user with the fixed id 'u1' so audit_log's FK is satisfied. */
function seedActor(db: Database.Database) {
	db.prepare(
		`INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
		 VALUES ('u1', 'tester', 'x', 'archivist', ?, ?)`
	).run(now, now);
}

/** Seed the writer 'w1' (for owner-semantics tests). */
function seedWriter(db: Database.Database) {
	db.prepare(
		`INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
		 VALUES ('w1', 'scribbler', 'x', 'writer', ?, ?)`
	).run(now, now);
}

function seedCollection(
	db: Database.Database,
	id: string,
	title: string,
	parentId: string | null,
	sortOrder = 1,
	ownerId: string | null = null
) {
	db.prepare(
		`INSERT INTO collections (id, title, parent_id, sort_order, owner_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	).run(id, title, parentId, sortOrder, ownerId, now, now);
}

function seedNovel(
	db: Database.Database,
	id: string,
	collectionId: string | null = null,
	ownerId: string | null = null
) {
	db.prepare(
		`INSERT INTO novels (id, title, status, collection_id, owner_id, created_at, updated_at)
		 VALUES (?, ?, 'draft', ?, ?, ?, ?)`
	).run(id, `Novel ${id}`, collectionId, ownerId, now, now);
}

// ─── Route handler wrappers ──────────────────────────────────────────
function collectionsGET(db: Database.Database) {
	return import('../src/routes/api/collections/+server.ts').then(({ GET }) =>
		GET({ locals: locals(db) } as any)
	);
}
function collectionsPOST(db: Database.Database, body: unknown) {
	return import('../src/routes/api/collections/+server.ts').then(({ POST }) =>
		POST({
			request: new Request('http://test/collections', { method: 'POST', body: JSON.stringify(body) }),
			locals: locals(db)
		} as any)
	);
}
function collectionPUT(db: Database.Database, id: string, body: unknown) {
	return import('../src/routes/api/collections/[id]/+server.ts').then(({ PUT }) =>
		PUT({
			params: { id },
			request: new Request(`http://test/collections/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
			locals: locals(db)
		} as any)
	);
}
function collectionDELETE(db: Database.Database, id: string) {
	return import('../src/routes/api/collections/[id]/+server.ts').then(({ DELETE }) =>
		DELETE({ params: { id }, locals: locals(db) } as any)
	);
}
function novelPUT(db: Database.Database, id: string, body: unknown) {
	return import('../src/routes/api/novels/[id]/+server.ts').then(({ PUT }) =>
		PUT({
			params: { id },
			request: new Request(`http://test/novels/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
			locals: locals(db)
		} as any)
	);
}

// ─── Migration ───────────────────────────────────────────────────────
// Legacy shape A: no collections table at all. The users table is present —
// in production it predates the collections migration (base SCHEMA and the
// ownership migration both run first), and the new collections table's
// owner_id FK references it.
const LEGACY_SCHEMA = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'writer',
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

/** Replicates runCollectionsMigration() from src/lib/server/db.ts (v2.1 shape). */
function runCollectionsMigration(db: Database.Database): void {
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

/** Replicates backfillCollectionOwners() from src/lib/server/db.ts. */
function backfillCollectionOwners(db: Database.Database, novelCols: { name: string }[]): void {
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

describe('collections migration', () => {
	it('adds the collections table and both novel columns to a legacy DB', () => {
		const db = new Database(':memory:');
		db.exec(LEGACY_SCHEMA);

		const tablesBefore = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[];
		expect(tablesBefore.map((t) => t.name)).not.toContain('collections');
		const colsBefore = (db.prepare('PRAGMA table_info(novels)').all() as { name: string }[]).map((c) => c.name);
		expect(colsBefore).not.toContain('collection_id');
		expect(colsBefore).not.toContain('stack_label');

		runCollectionsMigration(db);

		const tablesAfter = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[];
		expect(tablesAfter.map((t) => t.name)).toContain('collections');
		const colsAfter = (db.prepare('PRAGMA table_info(novels)').all() as { name: string }[]).map((c) => c.name);
		expect(colsAfter).toContain('collection_id');
		expect(colsAfter).toContain('stack_label');
		// v2.1: the freshly-created table carries owner_id from the start.
		const collCols = (db.prepare('PRAGMA table_info(collections)').all() as { name: string }[]).map((c) => c.name);
		expect(collCols).toContain('owner_id');
	});

	it('is idempotent — a second run does not throw or clobber data', () => {
		const db = new Database(':memory:');
		db.exec(LEGACY_SCHEMA);
		runCollectionsMigration(db);
		db.prepare(`INSERT INTO collections (id, title, parent_id, sort_order, created_at, updated_at) VALUES ('c1','Universe',NULL,1,?,?)`).run(now, now);
		expect(() => runCollectionsMigration(db)).not.toThrow();
		expect((db.prepare('SELECT COUNT(*) AS n FROM collections').get() as { n: number }).n).toBe(1);
	});
});

// ─── Migration v2.1: collections.owner_id + backfill ─────────────────
// Legacy shape B: the v2 schema — collections table exists but has no
// owner_id; users and owner-tagged novels exist (ownership migration ran).
const LEGACY_V2_SCHEMA = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'writer',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE collections (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  parent_id TEXT REFERENCES collections(id),
  sort_order REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE novels (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  owner_id TEXT REFERENCES users(id),
  collection_id TEXT REFERENCES collections(id),
  stack_label TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
`;

describe('collections migration v2.1 — owner_id + backfill', () => {
	function legacyV2Db() {
		const db = new Database(':memory:');
		db.exec(LEGACY_V2_SCHEMA);
		const seedUser = db.prepare(
			`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, 'x', ?, ?, ?)`
		);
		// Archivist created first — she is the fallback target. A second, later
		// archivist proves "first archivist by created_at" is the one chosen.
		seedUser.run('arch', 'meredith', 'archivist', '2026-01-01T00:00:00Z', now);
		seedUser.run('arch2', 'late-archivist', 'archivist', '2026-06-01T00:00:00Z', now);
		seedUser.run('wr1', 'lara', 'writer', '2026-01-02T00:00:00Z', now);
		seedUser.run('wr2', 'other', 'writer', '2026-01-03T00:00:00Z', now);
		return db;
	}
	const legacyColl = (db: Database.Database, id: string, parentId: string | null) =>
		db
			.prepare(
				`INSERT INTO collections (id, title, parent_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`
			)
			.run(id, id, parentId, now, now);
	const legacyNovel = (
		db: Database.Database,
		id: string,
		collectionId: string | null,
		ownerId: string | null,
		deletedAt: string | null = null
	) =>
		db
			.prepare(
				`INSERT INTO novels (id, title, owner_id, collection_id, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
			)
			.run(id, id, ownerId, collectionId, now, now, deletedAt);
	const ownerOf = (db: Database.Database, id: string) =>
		(db.prepare('SELECT owner_id FROM collections WHERE id = ?').get(id) as any).owner_id;

	it('adds owner_id to a legacy v2 collections table', () => {
		const db = legacyV2Db();
		legacyColl(db, 'c1', null);
		const before = (db.prepare('PRAGMA table_info(collections)').all() as { name: string }[]).map((c) => c.name);
		expect(before).not.toContain('owner_id');
		runCollectionsMigration(db);
		const after = (db.prepare('PRAGMA table_info(collections)').all() as { name: string }[]).map((c) => c.name);
		expect(after).toContain('owner_id');
	});

	it('backfills a collection whose member novels all share one owner to that owner', () => {
		const db = legacyV2Db();
		legacyColl(db, 'c-writer', null);
		legacyNovel(db, 'n1', 'c-writer', 'wr1');
		legacyNovel(db, 'n2', 'c-writer', 'wr1');
		runCollectionsMigration(db);
		expect(ownerOf(db, 'c-writer')).toBe('wr1');
	});

	it('backfills memberless and mixed-owner collections to the first archivist', () => {
		const db = legacyV2Db();
		legacyColl(db, 'c-empty', null);
		legacyColl(db, 'c-mixed', null);
		legacyNovel(db, 'n1', 'c-mixed', 'wr1');
		legacyNovel(db, 'n2', 'c-mixed', 'wr2');
		runCollectionsMigration(db);
		expect(ownerOf(db, 'c-empty')).toBe('arch'); // first archivist by created_at, not 'arch2'
		expect(ownerOf(db, 'c-mixed')).toBe('arch');
	});

	it('ignores soft-deleted novels when deriving the member owner', () => {
		const db = legacyV2Db();
		legacyColl(db, 'c-del', null);
		legacyNovel(db, 'n-dead', 'c-del', 'wr2', now); // deleted — no signal
		runCollectionsMigration(db);
		expect(ownerOf(db, 'c-del')).toBe('arch');
	});

	it('resolves a parent universe from its eras’ members, and an empty era from its parent', () => {
		// Production shape: the universe top-level holds no novels directly —
		// its eras do. The whole subtree must land with the writer, including
		// an era that is itself empty (it inherits the resolved parent owner).
		const db = legacyV2Db();
		legacyColl(db, 'c-uni', null);
		legacyColl(db, 'c-era', 'c-uni');
		legacyColl(db, 'c-era-empty', 'c-uni');
		legacyNovel(db, 'n1', 'c-era', 'wr1');
		legacyNovel(db, 'n2', 'c-era', 'wr1');
		runCollectionsMigration(db);
		expect(ownerOf(db, 'c-uni')).toBe('wr1');
		expect(ownerOf(db, 'c-era')).toBe('wr1');
		expect(ownerOf(db, 'c-era-empty')).toBe('wr1');
	});

	it('never clobbers an already-set owner and is idempotent', () => {
		const db = legacyV2Db();
		legacyColl(db, 'c-writer', null);
		legacyNovel(db, 'n1', 'c-writer', 'wr1');
		runCollectionsMigration(db);
		// Simulate a later manual reassignment, then a new orphan appearing.
		db.prepare(`UPDATE collections SET owner_id = 'wr2' WHERE id = 'c-writer'`).run();
		legacyColl(db, 'c-new', null);
		expect(() => runCollectionsMigration(db)).not.toThrow();
		expect(ownerOf(db, 'c-writer')).toBe('wr2'); // untouched
		expect(ownerOf(db, 'c-new')).toBe('arch');
	});

	it('leaves owner_id NULL (without throwing) when no archivist exists', () => {
		const db = new Database(':memory:');
		db.exec(LEGACY_V2_SCHEMA);
		db.prepare(
			`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES ('wr1','lara','x','writer',?,?)`
		).run(now, now);
		legacyColl(db, 'c-empty', null);
		expect(() => runCollectionsMigration(db)).not.toThrow();
		expect(ownerOf(db, 'c-empty')).toBeNull();
	});
});

// ─── POST /api/collections ───────────────────────────────────────────
describe('POST /api/collections', () => {
	let db: Database.Database;
	beforeEach(() => {
		db = createTestDb();
		seedActor(db);
	});

	it('creates a top-level collection', async () => {
		const res = await collectionsPOST(db, { title: 'The Silvers Universe' });
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.title).toBe('The Silvers Universe');
		expect(body.parent_id).toBeNull();
	});

	it('400s on an empty title', async () => {
		await expect(collectionsPOST(db, { title: '   ' })).rejects.toMatchObject({ status: 400 });
	});

	it('creates a child under a top-level parent (same owner)', async () => {
		seedCollection(db, 'c-top', 'Universe', null, 1, 'u1');
		const res = await collectionsPOST(db, { title: 'Tigrenache Era', parent_id: 'c-top' });
		const body = await res.json();
		expect(body.parent_id).toBe('c-top');
		expect(body.owner_id).toBe('u1');
	});

	it('400s when parent_id does not exist', async () => {
		await expect(collectionsPOST(db, { title: 'Era', parent_id: 'nope' })).rejects.toMatchObject({ status: 400 });
	});

	it('400s when parent_id is itself a child (nesting > 1 level)', async () => {
		seedCollection(db, 'c-top', 'Universe', null);
		seedCollection(db, 'c-era', 'Era', 'c-top');
		await expect(collectionsPOST(db, { title: 'Sub-era', parent_id: 'c-era' })).rejects.toMatchObject({ status: 400 });
	});

	it('appends sort_order at the end of the sibling group', async () => {
		seedCollection(db, 'c-a', 'A', null, 1);
		seedCollection(db, 'c-b', 'B', null, 2);
		const res = await collectionsPOST(db, { title: 'C' });
		const body = await res.json();
		expect(body.sort_order).toBeGreaterThan(2);
	});
});

// ─── POST /api/collections — owner semantics (v2.1) ──────────────────
describe('POST /api/collections — owner semantics', () => {
	let db: Database.Database;
	beforeEach(() => {
		db = createTestDb();
		seedActor(db);
		seedWriter(db);
	});
	const postAs = (u: typeof user, body: unknown) =>
		import('../src/routes/api/collections/+server.ts').then(({ POST }) =>
			POST({
				request: new Request('http://test/collections', { method: 'POST', body: JSON.stringify(body) }),
				locals: localsAs(db, u)
			} as any)
		);

	it('a writer always owns her own shelf — a requested owner_id is ignored', async () => {
		const res = await postAs(writer, { title: 'My Shelf', owner_id: 'u1' });
		expect((await res.json()).owner_id).toBe('w1');
	});

	it('an archivist may assign a shelf to a named owner', async () => {
		const res = await postAs(user, { title: 'Her Universe', owner_id: 'w1' });
		expect((await res.json()).owner_id).toBe('w1');
	});

	it('an archivist without owner_id (or naming a ghost) gets herself', async () => {
		const res1 = await postAs(user, { title: 'Mine' });
		expect((await res1.json()).owner_id).toBe('u1');
		const res2 = await postAs(user, { title: 'Ghost-owned', owner_id: 'nobody' });
		expect((await res2.json()).owner_id).toBe('u1');
	});

	it('400s when a child would have a different owner than its parent', async () => {
		seedCollection(db, 'c-top', 'Her Universe', null, 1, 'w1');
		// Archivist creating for herself under the writer's universe: rejected.
		await expect(postAs(user, { title: 'Era', parent_id: 'c-top' })).rejects.toMatchObject({ status: 400 });
		// Writer creating under the archivist's shelf: rejected too.
		seedCollection(db, 'c-arch', 'Reference', null, 2, 'u1');
		await expect(postAs(writer, { title: 'Era', parent_id: 'c-arch' })).rejects.toMatchObject({ status: 400 });
	});

	it('creates a child when the archivist assigns the parent’s owner', async () => {
		seedCollection(db, 'c-top', 'Her Universe', null, 1, 'w1');
		const res = await postAs(user, { title: 'Era', parent_id: 'c-top', owner_id: 'w1' });
		const body = await res.json();
		expect(body.parent_id).toBe('c-top');
		expect(body.owner_id).toBe('w1');
	});
});

// ─── GET /api/collections — owner fields travel with rows ────────────
describe('GET /api/collections — owner fields', () => {
	it('returns owner_id and owner_username per collection', async () => {
		const db = createTestDb();
		seedActor(db);
		seedCollection(db, 'c1', 'Universe', null, 1, 'u1');
		const res = await collectionsGET(db);
		const rows = await res.json();
		expect(rows[0].owner_id).toBe('u1');
		expect(rows[0].owner_username).toBe('tester');
	});
});

// ─── PUT /api/collections/[id] ───────────────────────────────────────
describe('PUT /api/collections/[id]', () => {
	let db: Database.Database;
	beforeEach(() => {
		db = createTestDb();
		seedActor(db);
	});

	it('404s on an unknown id', async () => {
		await expect(collectionPUT(db, 'nope', { title: 'X' })).rejects.toMatchObject({ status: 404 });
	});

	it('renames via title', async () => {
		seedCollection(db, 'c1', 'Old', null);
		const res = await collectionPUT(db, 'c1', { title: 'New' });
		expect((await res.json()).title).toBe('New');
	});

	it('promotes to top-level via explicit parent_id: null', async () => {
		seedCollection(db, 'c-top', 'Universe', null);
		seedCollection(db, 'c-era', 'Era', 'c-top');
		const res = await collectionPUT(db, 'c-era', { parent_id: null });
		expect((await res.json()).parent_id).toBeNull();
	});

	it('leaves parent_id untouched when the key is omitted', async () => {
		seedCollection(db, 'c-top', 'Universe', null);
		seedCollection(db, 'c-era', 'Era', 'c-top');
		const res = await collectionPUT(db, 'c-era', { title: 'Renamed Era' });
		expect((await res.json()).parent_id).toBe('c-top');
	});

	it('400s when parenting a collection that itself has children', async () => {
		seedCollection(db, 'c-top', 'Universe', null);
		seedCollection(db, 'c-other', 'Other Universe', null);
		seedCollection(db, 'c-era', 'Era', 'c-top'); // c-top now has a child
		await expect(collectionPUT(db, 'c-top', { parent_id: 'c-other' })).rejects.toMatchObject({ status: 400 });
	});

	it('400s when the new parent is itself a child (nesting > 1 level)', async () => {
		seedCollection(db, 'c-top', 'Universe', null);
		seedCollection(db, 'c-era', 'Era', 'c-top');
		seedCollection(db, 'c-loose', 'Loose', null);
		await expect(collectionPUT(db, 'c-loose', { parent_id: 'c-era' })).rejects.toMatchObject({ status: 400 });
	});

	it('400s when a collection is set as its own parent', async () => {
		seedCollection(db, 'c1', 'Self', null);
		await expect(collectionPUT(db, 'c1', { parent_id: 'c1' })).rejects.toMatchObject({ status: 400 });
	});

	it('updates sort_order', async () => {
		seedCollection(db, 'c1', 'A', null, 1);
		const res = await collectionPUT(db, 'c1', { sort_order: 5 });
		expect((await res.json()).sort_order).toBe(5);
	});

	it('400s when re-parenting onto a shelf with a different owner (v2.1)', async () => {
		seedWriter(db);
		seedCollection(db, 'c-hers', 'Her Universe', null, 1, 'w1');
		seedCollection(db, 'c-mine', 'Reference', null, 2, 'u1');
		seedCollection(db, 'c-era', 'Era', 'c-hers', 1, 'w1');
		await expect(collectionPUT(db, 'c-era', { parent_id: 'c-mine' })).rejects.toMatchObject({ status: 400 });
		// Same-owner re-parenting still works.
		seedCollection(db, 'c-hers-2', 'Her Poetry', null, 3, 'w1');
		const res = await collectionPUT(db, 'c-era', { parent_id: 'c-hers-2' });
		expect((await res.json()).parent_id).toBe('c-hers-2');
	});
});

// ─── DELETE /api/collections/[id] ────────────────────────────────────
describe('DELETE /api/collections/[id]', () => {
	let db: Database.Database;
	beforeEach(() => {
		db = createTestDb();
		seedActor(db);
	});

	it('404s on an unknown id', async () => {
		await expect(collectionDELETE(db, 'nope')).rejects.toMatchObject({ status: 404 });
	});

	it('nulls member novels (fall to Unsorted) and promotes child collections', async () => {
		seedCollection(db, 'c-top', 'Universe', null);
		seedCollection(db, 'c-era', 'Era', 'c-top');
		seedNovel(db, 'n1', 'c-top');
		seedNovel(db, 'n2', 'c-top');

		await collectionDELETE(db, 'c-top');

		expect(db.prepare('SELECT id FROM collections WHERE id = ?').get('c-top')).toBeUndefined();
		expect((db.prepare('SELECT collection_id FROM novels WHERE id = ?').get('n1') as any).collection_id).toBeNull();
		expect((db.prepare('SELECT collection_id FROM novels WHERE id = ?').get('n2') as any).collection_id).toBeNull();
		expect((db.prepare('SELECT parent_id FROM collections WHERE id = ?').get('c-era') as any).parent_id).toBeNull();
		// The novels themselves survive.
		expect(db.prepare('SELECT COUNT(*) AS n FROM novels').get()).toMatchObject({ n: 2 });
	});
});

// ─── Novel assignment (collection_id + stack_label) ──────────────────
describe('PUT /api/novels/[id] — collection + stack assignment', () => {
	let db: Database.Database;
	beforeEach(() => {
		db = createTestDb();
		seedActor(db);
		seedCollection(db, 'c1', 'Universe', null);
		seedNovel(db, 'n1', null);
	});

	it('assigns collection_id to an existing collection', async () => {
		const res = await novelPUT(db, 'n1', { collection_id: 'c1' });
		expect((await res.json()).collection_id).toBe('c1');
	});

	it('400s on an unknown collection_id', async () => {
		await expect(novelPUT(db, 'n1', { collection_id: 'ghost' })).rejects.toMatchObject({ status: 400 });
	});

	it('clears collection_id on explicit null', async () => {
		db.prepare('UPDATE novels SET collection_id = ? WHERE id = ?').run('c1', 'n1');
		const res = await novelPUT(db, 'n1', { collection_id: null });
		expect((await res.json()).collection_id).toBeNull();
	});

	it('leaves collection_id untouched when the key is omitted', async () => {
		db.prepare('UPDATE novels SET collection_id = ? WHERE id = ?').run('c1', 'n1');
		const res = await novelPUT(db, 'n1', { title: 'Renamed' });
		expect((await res.json()).collection_id).toBe('c1');
	});

	it('sets a trimmed stack_label', async () => {
		const res = await novelPUT(db, 'n1', { stack_label: '  Away, Away  ' });
		expect((await res.json()).stack_label).toBe('Away, Away');
	});

	it('400s on an empty stack_label', async () => {
		await expect(novelPUT(db, 'n1', { stack_label: '   ' })).rejects.toMatchObject({ status: 400 });
	});

	it('clears stack_label on explicit null', async () => {
		db.prepare('UPDATE novels SET stack_label = ? WHERE id = ?').run('Old', 'n1');
		const res = await novelPUT(db, 'n1', { stack_label: null });
		expect((await res.json()).stack_label).toBeNull();
	});

	it('leaves stack_label untouched when the key is omitted', async () => {
		db.prepare('UPDATE novels SET stack_label = ? WHERE id = ?').run('Keep', 'n1');
		const res = await novelPUT(db, 'n1', { title: 'Renamed' });
		expect((await res.json()).stack_label).toBe('Keep');
	});
});

// ─── Novel assignment — cross-owner filing rejected (v2.1) ───────────
describe('PUT /api/novels/[id] — owner-scoped collection assignment', () => {
	let db: Database.Database;
	beforeEach(() => {
		db = createTestDb();
		seedActor(db);
		seedWriter(db);
		seedCollection(db, 'c-hers', 'Her Universe', null, 1, 'w1');
		seedCollection(db, 'c-mine', 'Reference', null, 2, 'u1');
		seedNovel(db, 'n-hers', null, 'w1');
	});

	it('files a novel onto its owner’s shelf', async () => {
		const res = await novelPUT(db, 'n-hers', { collection_id: 'c-hers' });
		expect((await res.json()).collection_id).toBe('c-hers');
	});

	it('400s when the target shelf belongs to a different owner', async () => {
		await expect(novelPUT(db, 'n-hers', { collection_id: 'c-mine' })).rejects.toMatchObject({ status: 400 });
	});

	it('clearing to Unsorted (null) is always allowed', async () => {
		db.prepare('UPDATE novels SET collection_id = ? WHERE id = ?').run('c-hers', 'n-hers');
		const res = await novelPUT(db, 'n-hers', { collection_id: null });
		expect((await res.json()).collection_id).toBeNull();
	});

	it('an unowned novel may only be filed onto an unowned shelf (legacy tolerance)', async () => {
		seedCollection(db, 'c-legacy', 'Orphan Shelf', null, 3, null);
		seedNovel(db, 'n-legacy', null, null);
		await expect(novelPUT(db, 'n-legacy', { collection_id: 'c-hers' })).rejects.toMatchObject({ status: 400 });
		const res = await novelPUT(db, 'n-legacy', { collection_id: 'c-legacy' });
		expect((await res.json()).collection_id).toBe('c-legacy');
	});
});

// ─── Source-grep: db.ts + server load wiring ─────────────────────────
describe('collections wiring (source-grep)', () => {
	it('db.ts declares the collections table + novel columns and exports the migration', () => {
		const source = fs.readFileSync('src/lib/server/db.ts', 'utf-8');
		expect(source).toContain('CREATE TABLE IF NOT EXISTS collections');
		expect(source).toContain('collection_id TEXT REFERENCES collections(id)');
		expect(source).toContain('stack_label TEXT');
		expect(source).toContain('runCollectionsMigration');
	});

	it('db.ts guards the v2.1 owner_id ALTER and backfills orphaned owners (replica pin)', () => {
		// The migration tests above exercise a replica; these markers pin the
		// real implementation so the two cannot silently drift.
		const source = fs.readFileSync('src/lib/server/db.ts', 'utf-8');
		expect(source).toContain('ALTER TABLE collections ADD COLUMN owner_id TEXT REFERENCES users(id)');
		expect(source).toContain('backfillCollectionOwners');
		expect(source).toMatch(/owner_id IS NULL/);
		expect(source).toMatch(/role = 'archivist' ORDER BY created_at LIMIT 1/);
	});

	it('+page.server.ts returns collections (with owner fields) alongside novels', () => {
		const source = fs.readFileSync('src/routes/+page.server.ts', 'utf-8');
		expect(source).toContain('FROM collections');
		expect(source).toContain('return { novels, collections }');
		expect(source).toMatch(/owner_username[\s\S]*FROM collections/);
	});
});
