import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb } from './helpers.js';

/**
 * Requests & Questions (feedback table + /api/feedback). Covers the guarded
 * migration against two legacy shapes, and the API's validation battery:
 * type/status vocab, title length, 404s, and author stamping (the caller is
 * always the author — no impersonation, unlike novel/collection ownership).
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

// ─── Route handler wrappers ──────────────────────────────────────────
function feedbackGET(db: Database.Database, u = archivist) {
	return import('../src/routes/api/feedback/+server.ts').then(({ GET }) =>
		GET({ locals: locals(db, u) } as any)
	);
}
function feedbackPOST(db: Database.Database, body: unknown, u = archivist) {
	return import('../src/routes/api/feedback/+server.ts').then(({ POST }) =>
		POST({
			request: new Request('http://test/feedback', { method: 'POST', body: JSON.stringify(body) }),
			locals: locals(db, u)
		} as any)
	);
}
function feedbackPUT(db: Database.Database, id: string, body: unknown, u = archivist) {
	return import('../src/routes/api/feedback/[id]/+server.ts').then(({ PUT }) =>
		PUT({
			params: { id },
			request: new Request(`http://test/feedback/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
			locals: locals(db, u)
		} as any)
	);
}

// ─── Migration ───────────────────────────────────────────────────────
// Legacy shape A: users table exists (feedback.author_id references it) but
// the feedback table itself predates this feature entirely.
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

/** Replicates runFeedbackMigration() from src/lib/server/db.ts. */
function runFeedbackMigration(db: Database.Database): void {
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

describe('feedback migration', () => {
	it('adds the feedback table to a legacy DB (shape A: no feedback table at all)', () => {
		const db = new Database(':memory:');
		db.exec(LEGACY_SCHEMA);

		const tablesBefore = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[];
		expect(tablesBefore.map((t) => t.name)).not.toContain('feedback');

		runFeedbackMigration(db);

		const tablesAfter = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[];
		expect(tablesAfter.map((t) => t.name)).toContain('feedback');
		const cols = (db.prepare('PRAGMA table_info(feedback)').all() as { name: string }[]).map((c) => c.name);
		expect(cols).toEqual(
			expect.arrayContaining(['id', 'author_id', 'type', 'title', 'body', 'status', 'response', 'created_at', 'updated_at'])
		);
	});

	it('is idempotent and never clobbers existing rows (shape B: feedback table already present)', () => {
		const db = new Database(':memory:');
		db.exec(LEGACY_SCHEMA);
		runFeedbackMigration(db);
		db.prepare(
			`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES ('u1','tester','x','archivist',?,?)`
		).run(now, now);
		db.prepare(
			`INSERT INTO feedback (id, author_id, type, title, status, created_at, updated_at) VALUES ('f1','u1','bug','Broke','open',?,?)`
		).run(now, now);

		expect(() => runFeedbackMigration(db)).not.toThrow();
		expect((db.prepare('SELECT COUNT(*) AS n FROM feedback').get() as { n: number }).n).toBe(1);
	});

	it('rejects a type outside the CHECK vocabulary at the DB layer', () => {
		const db = new Database(':memory:');
		db.exec(LEGACY_SCHEMA);
		runFeedbackMigration(db);
		db.prepare(
			`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES ('u1','tester','x','archivist',?,?)`
		).run(now, now);
		expect(() =>
			db
				.prepare(
					`INSERT INTO feedback (id, author_id, type, title, status, created_at, updated_at) VALUES ('f1','u1','not-a-type','X','open',?,?)`
				)
				.run(now, now)
		).toThrow();
	});
});

// ─── POST /api/feedback ───────────────────────────────────────────────
describe('POST /api/feedback', () => {
	let db: Database.Database;
	beforeEach(() => {
		db = createTestDb();
		seedUsers(db);
	});

	it('creates a feature request, stamping the caller as author', async () => {
		const res = await feedbackPOST(db, { type: 'feature', title: 'Dark mode for print' }, writer);
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.type).toBe('feature');
		expect(body.title).toBe('Dark mode for print');
		expect(body.author_id).toBe('w1');
		expect(body.author_username).toBe('scribbler');
		expect(body.status).toBe('open');
	});

	it('ignores any author_id sent in the payload — the caller is always the author', async () => {
		const res = await feedbackPOST(db, { type: 'bug', title: 'Crashes on import', author_id: 'u1' }, writer);
		const body = await res.json();
		expect(body.author_id).toBe('w1');
	});

	it('accepts an optional body/details field', async () => {
		const res = await feedbackPOST(db, { type: 'question', title: 'How do eras work?', body: 'Confused about nesting.' });
		const body = await res.json();
		expect(body.body).toBe('Confused about nesting.');
	});

	it('400s on an invalid type', async () => {
		await expect(feedbackPOST(db, { type: 'nonsense', title: 'X' })).rejects.toMatchObject({ status: 400 });
	});

	it('400s on a missing type', async () => {
		await expect(feedbackPOST(db, { title: 'X' })).rejects.toMatchObject({ status: 400 });
	});

	it('400s on an empty title', async () => {
		await expect(feedbackPOST(db, { type: 'bug', title: '   ' })).rejects.toMatchObject({ status: 400 });
	});

	it('400s on a title over 200 characters', async () => {
		await expect(feedbackPOST(db, { type: 'bug', title: 'x'.repeat(201) })).rejects.toMatchObject({ status: 400 });
	});

	it('accepts a title of exactly 200 characters', async () => {
		const res = await feedbackPOST(db, { type: 'bug', title: 'x'.repeat(200) });
		expect(res.status).toBe(201);
	});

	it('400s when body is present but not a string', async () => {
		await expect(feedbackPOST(db, { type: 'bug', title: 'X', body: 12345 })).rejects.toMatchObject({ status: 400 });
	});
});

// ─── GET /api/feedback ─────────────────────────────────────────────────
describe('GET /api/feedback', () => {
	it('returns rows newest-first with author_username joined in', async () => {
		const db = createTestDb();
		seedUsers(db);
		await feedbackPOST(db, { type: 'bug', title: 'First' }, writer);
		await new Promise((r) => setTimeout(r, 2));
		await feedbackPOST(db, { type: 'feature', title: 'Second' }, archivist);

		const res = await feedbackGET(db);
		const rows = await res.json();
		expect(rows.length).toBe(2);
		expect(rows[0].title).toBe('Second');
		expect(rows[0].author_username).toBe('tester');
		expect(rows[1].title).toBe('First');
		expect(rows[1].author_username).toBe('scribbler');
	});
});

// ─── PUT /api/feedback/[id] ────────────────────────────────────────────
describe('PUT /api/feedback/[id]', () => {
	let db: Database.Database;
	let itemId: string;
	beforeEach(async () => {
		db = createTestDb();
		seedUsers(db);
		const res = await feedbackPOST(db, { type: 'question', title: 'How do shelves work?' }, writer);
		itemId = (await res.json()).id;
	});

	it('404s on an unknown id', async () => {
		await expect(feedbackPUT(db, 'nope', { status: 'planned' })).rejects.toMatchObject({ status: 404 });
	});

	it('updates status', async () => {
		const res = await feedbackPUT(db, itemId, { status: 'planned' });
		expect((await res.json()).status).toBe('planned');
	});

	it('400s on an invalid status', async () => {
		await expect(feedbackPUT(db, itemId, { status: 'bogus' })).rejects.toMatchObject({ status: 400 });
	});

	it('sets a response (writer reply flow) and status together', async () => {
		const res = await feedbackPUT(db, itemId, { status: 'answered', response: 'Shelves nest one level deep.' });
		const body = await res.json();
		expect(body.status).toBe('answered');
		expect(body.response).toBe('Shelves nest one level deep.');
	});

	it('leaves status untouched when omitted', async () => {
		await feedbackPUT(db, itemId, { status: 'in-progress' });
		const res = await feedbackPUT(db, itemId, { response: 'Working on it.' });
		expect((await res.json()).status).toBe('in-progress');
	});

	it('leaves response untouched when omitted', async () => {
		await feedbackPUT(db, itemId, { response: 'Keep this.' });
		const res = await feedbackPUT(db, itemId, { status: 'done' });
		expect((await res.json()).response).toBe('Keep this.');
	});

	it('clears response on explicit null', async () => {
		await feedbackPUT(db, itemId, { response: 'Oops wrong item.' });
		const res = await feedbackPUT(db, itemId, { response: null });
		expect((await res.json()).response).toBeNull();
	});

	it('400s when response is present but not a string or null', async () => {
		await expect(feedbackPUT(db, itemId, { response: 42 })).rejects.toMatchObject({ status: 400 });
	});
});

// ─── Source-grep: db.ts wiring ─────────────────────────────────────────
describe('feedback wiring (source-grep)', () => {
	it('db.ts declares the feedback table and exports the guarded migration', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/lib/server/db.ts', 'utf-8');
		expect(source).toContain('CREATE TABLE IF NOT EXISTS feedback');
		expect(source).toContain("CHECK(type IN ('feature','bug','question'))");
		expect(source).toContain('runFeedbackMigration');
	});
});
