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
const locals = (db: Database.Database) => ({ user, db }) as any;

/** Seed the acting user with the fixed id 'u1' so audit_log's FK is satisfied. */
function seedActor(db: Database.Database) {
	db.prepare(
		`INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
		 VALUES ('u1', 'tester', 'x', 'archivist', ?, ?)`
	).run(now, now);
}

function seedCollection(
	db: Database.Database,
	id: string,
	title: string,
	parentId: string | null,
	sortOrder = 1
) {
	db.prepare(
		`INSERT INTO collections (id, title, parent_id, sort_order, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
	).run(id, title, parentId, sortOrder, now, now);
}

function seedNovel(db: Database.Database, id: string, collectionId: string | null = null) {
	db.prepare(
		`INSERT INTO novels (id, title, status, collection_id, created_at, updated_at)
		 VALUES (?, ?, 'draft', ?, ?, ?)`
	).run(id, `Novel ${id}`, collectionId, now, now);
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
const LEGACY_SCHEMA = `
CREATE TABLE novels (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
`;

/** Replicates runCollectionsMigration() from src/lib/server/db.ts. */
function runCollectionsMigration(db: Database.Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS collections (
		  id TEXT PRIMARY KEY,
		  title TEXT NOT NULL,
		  parent_id TEXT REFERENCES collections(id),
		  sort_order REAL NOT NULL,
		  created_at TEXT NOT NULL,
		  updated_at TEXT NOT NULL
		);
	`);
	const cols = db.prepare(`PRAGMA table_info(novels)`).all() as { name: string }[];
	if (!cols.some((c) => c.name === 'collection_id')) {
		db.exec(`ALTER TABLE novels ADD COLUMN collection_id TEXT REFERENCES collections(id)`);
	}
	if (!cols.some((c) => c.name === 'stack_label')) {
		db.exec(`ALTER TABLE novels ADD COLUMN stack_label TEXT`);
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

	it('creates a child under a top-level parent', async () => {
		seedCollection(db, 'c-top', 'Universe', null);
		const res = await collectionsPOST(db, { title: 'Tigrenache Era', parent_id: 'c-top' });
		const body = await res.json();
		expect(body.parent_id).toBe('c-top');
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

// ─── Source-grep: db.ts + server load wiring ─────────────────────────
describe('collections wiring (source-grep)', () => {
	it('db.ts declares the collections table + novel columns and exports the migration', () => {
		const source = fs.readFileSync('src/lib/server/db.ts', 'utf-8');
		expect(source).toContain('CREATE TABLE IF NOT EXISTS collections');
		expect(source).toContain('collection_id TEXT REFERENCES collections(id)');
		expect(source).toContain('stack_label TEXT');
		expect(source).toContain('runCollectionsMigration');
	});

	it('+page.server.ts returns collections alongside novels', () => {
		const source = fs.readFileSync('src/routes/+page.server.ts', 'utf-8');
		expect(source).toContain('FROM collections');
		expect(source).toContain('return { novels, collections }');
	});
});
