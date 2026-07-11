import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb } from './helpers.js';
import { ROADMAP } from '../src/lib/roadmap-data.js';

/**
 * Roadmap hearts (roadmap_hearts table + /api/roadmap/hearts). Lets a signed
 * -in user toggle "I want this sooner" on a next/planned/someday item. Keyed
 * by the roadmap item's stable `key`, validated against the real ROADMAP
 * data so a typo'd key can't silently create an orphaned heart.
 */

const now = new Date().toISOString();
const archivist = { id: 'u1', username: 'tester', role: 'archivist' };
const writer = { id: 'w1', username: 'scribbler', role: 'writer' };
const locals = (db: Database.Database, u: typeof archivist | typeof writer = archivist) =>
	({ user: u, db }) as any;

function seedUsers(db: Database.Database) {
	db.prepare(
		`INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
		 VALUES ('u1', 'tester', 'x', 'archivist', ?, ?)`
	).run(now, now);
	db.prepare(
		`INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
		 VALUES ('w1', 'scribbler', 'x', 'writer', ?, ?)`
	).run(now, now);
}

function heartsGET(db: Database.Database, u = archivist) {
	return import('../src/routes/api/roadmap/hearts/+server.ts').then(({ GET }) =>
		GET({ locals: locals(db, u) } as any)
	);
}
function heartsPOST(db: Database.Database, body: unknown, u = archivist) {
	return import('../src/routes/api/roadmap/hearts/+server.ts').then(({ POST }) =>
		POST({
			request: new Request('http://test/roadmap/hearts', { method: 'POST', body: JSON.stringify(body) }),
			locals: locals(db, u)
		} as any)
	);
}

// ─── Migration ───────────────────────────────────────────────────────
const LEGACY_SCHEMA = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'writer',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/** Replicates runRoadmapHeartsMigration() from src/lib/server/db.ts. */
function runRoadmapHeartsMigration(db: Database.Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS roadmap_hearts (
		  item_key TEXT NOT NULL,
		  user_id TEXT NOT NULL REFERENCES users(id),
		  created_at TEXT NOT NULL,
		  PRIMARY KEY (item_key, user_id)
		);
	`);
}

describe('roadmap hearts migration', () => {
	it('adds the roadmap_hearts table to a legacy DB', () => {
		const db = new Database(':memory:');
		db.exec(LEGACY_SCHEMA);
		const before = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[];
		expect(before.map((t) => t.name)).not.toContain('roadmap_hearts');

		runRoadmapHeartsMigration(db);

		const after = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[];
		expect(after.map((t) => t.name)).toContain('roadmap_hearts');
	});

	it('is idempotent and never clobbers existing hearts', () => {
		const db = new Database(':memory:');
		db.exec(LEGACY_SCHEMA);
		runRoadmapHeartsMigration(db);
		db.prepare(`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES ('u1','tester','x','archivist',?,?)`).run(now, now);
		db.prepare(`INSERT INTO roadmap_hearts (item_key, user_id, created_at) VALUES ('spoiler-shield','u1',?)`).run(now);

		expect(() => runRoadmapHeartsMigration(db)).not.toThrow();
		expect((db.prepare('SELECT COUNT(*) AS n FROM roadmap_hearts').get() as { n: number }).n).toBe(1);
	});

	it('enforces one heart per (item_key, user_id) via the composite primary key', () => {
		const db = new Database(':memory:');
		db.exec(LEGACY_SCHEMA);
		runRoadmapHeartsMigration(db);
		db.prepare(`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES ('u1','tester','x','archivist',?,?)`).run(now, now);
		db.prepare(`INSERT INTO roadmap_hearts (item_key, user_id, created_at) VALUES ('spoiler-shield','u1',?)`).run(now);
		expect(() =>
			db.prepare(`INSERT INTO roadmap_hearts (item_key, user_id, created_at) VALUES ('spoiler-shield','u1',?)`).run(now)
		).toThrow();
	});
});

// ─── POST /api/roadmap/hearts — toggle ────────────────────────────────
describe('POST /api/roadmap/hearts', () => {
	let db: Database.Database;
	const realKey = ROADMAP.find((i) => i.status !== 'shipped')!.key;

	beforeEach(() => {
		db = createTestDb();
		seedUsers(db);
	});

	it('inserts a heart on first toggle', async () => {
		const res = await heartsPOST(db, { key: realKey }, writer);
		const body = await res.json();
		expect(body.hearted).toBe(true);
		const row = db.prepare('SELECT * FROM roadmap_hearts WHERE item_key = ? AND user_id = ?').get(realKey, 'w1');
		expect(row).toBeTruthy();
	});

	it('removes the heart on a second toggle (round trip)', async () => {
		await heartsPOST(db, { key: realKey }, writer);
		const res = await heartsPOST(db, { key: realKey }, writer);
		const body = await res.json();
		expect(body.hearted).toBe(false);
		const row = db.prepare('SELECT * FROM roadmap_hearts WHERE item_key = ? AND user_id = ?').get(realKey, 'w1');
		expect(row).toBeUndefined();
	});

	it('tracks hearts per-user independently', async () => {
		await heartsPOST(db, { key: realKey }, writer);
		await heartsPOST(db, { key: realKey }, archivist);
		const rows = db.prepare('SELECT user_id FROM roadmap_hearts WHERE item_key = ?').all(realKey) as { user_id: string }[];
		expect(rows.map((r) => r.user_id).sort()).toEqual(['u1', 'w1']);
	});

	it('400s on a key that is not a real roadmap item', async () => {
		await expect(heartsPOST(db, { key: 'totally-made-up-key' })).rejects.toMatchObject({ status: 400 });
	});

	it('400s when key is missing or not a string', async () => {
		await expect(heartsPOST(db, {})).rejects.toMatchObject({ status: 400 });
		await expect(heartsPOST(db, { key: 42 })).rejects.toMatchObject({ status: 400 });
	});
});

// ─── GET /api/roadmap/hearts ───────────────────────────────────────────
describe('GET /api/roadmap/hearts', () => {
	it('returns hearts with usernames joined in', async () => {
		const db = createTestDb();
		seedUsers(db);
		const key = ROADMAP.find((i) => i.status !== 'shipped')!.key;
		await heartsPOST(db, { key }, writer);

		const res = await heartsGET(db);
		const rows = await res.json();
		expect(rows.length).toBe(1);
		expect(rows[0].item_key).toBe(key);
		expect(rows[0].user_id).toBe('w1');
		expect(rows[0].username).toBe('scribbler');
	});
});

// ─── Source-grep: db.ts wiring ─────────────────────────────────────────
describe('roadmap hearts wiring (source-grep)', () => {
	it('db.ts declares the roadmap_hearts table and exports the guarded migration', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/lib/server/db.ts', 'utf-8');
		expect(source).toContain('CREATE TABLE IF NOT EXISTS roadmap_hearts');
		expect(source).toContain('PRIMARY KEY (item_key, user_id)');
		expect(source).toContain('runRoadmapHeartsMigration');
	});
});
