import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb } from './helpers.js';

/**
 * P1-5: the tree reorder endpoint (PUT /api/novels/:id/tree) must validate
 * node_type/new_sort_order shape, that the node exists, that new_parent_id
 * (when set) is a real non-deleted folder in the same novel, and that the
 * move doesn't create a cycle.
 *
 * These call the real route handler directly (it only touches locals.db,
 * never the filesystem or the real $env-backed getDb(), so this is safe
 * to run against an in-memory test database).
 */

let db: Database.Database;
const novelId = 'novel-1';
const now = new Date().toISOString();
const locals = () => ({ user: { id: 'u1', role: 'writer' }, db });

function seedFolder(id: string, parentId: string | null) {
	db.prepare(
		`INSERT INTO folders (id, novel_id, parent_id, title, folder_type, sort_order, created_at, updated_at)
		 VALUES (?, ?, ?, ?, NULL, 1.0, ?, ?)`
	).run(id, novelId, parentId, `Folder ${id}`, now, now);
}

function seedDocument(id: string, parentId: string | null) {
	db.prepare(
		`INSERT INTO documents (id, novel_id, parent_id, title, sort_order, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 1.0, ?, ?)`
	).run(id, novelId, parentId, `Doc ${id}`, now, now);
}

function put(body: unknown) {
	return import('../src/routes/api/novels/[id]/tree/+server.ts').then(({ PUT }) =>
		PUT({
			params: { id: novelId },
			request: new Request('http://test/tree', { method: 'PUT', body: JSON.stringify(body) }),
			locals: locals()
		} as any)
	);
}

async function expectRejection(body: unknown, status: number) {
	await expect(put(body)).rejects.toMatchObject({ status });
}

beforeEach(() => {
	db = createTestDb();
	db.prepare('INSERT INTO novels (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
		.run(novelId, 'Test Novel', 'draft', now, now);
});

describe('tree reorder validation (P1-5)', () => {
	it('rejects an invalid node_type', async () => {
		seedDocument('d1', null);
		await expectRejection({ node_id: 'd1', node_type: 'bogus', new_sort_order: 2 }, 400);
	});

	it('rejects a non-numeric new_sort_order', async () => {
		seedDocument('d1', null);
		await expectRejection({ node_id: 'd1', node_type: 'document', new_sort_order: 'two' }, 400);
	});

	it('rejects a non-finite new_sort_order', async () => {
		seedDocument('d1', null);
		await expectRejection({ node_id: 'd1', node_type: 'document', new_sort_order: Infinity }, 400);
	});

	it('rejects a missing new_sort_order (would write NULL into a NOT NULL column)', async () => {
		seedDocument('d1', null);
		await expectRejection({ node_id: 'd1', node_type: 'document' }, 400);
	});

	it('returns 404 when the node does not exist in this novel', async () => {
		await expectRejection({ node_id: 'no-such-node', node_type: 'document', new_sort_order: 2 }, 404);
	});

	it('returns 404 when the node is soft-deleted', async () => {
		db.prepare(
			`INSERT INTO documents (id, novel_id, parent_id, title, sort_order, created_at, updated_at, deleted_at)
			 VALUES (?, ?, NULL, ?, 1.0, ?, ?, ?)`
		).run('d-trashed', novelId, 'Trashed', now, now, now);
		await expectRejection({ node_id: 'd-trashed', node_type: 'document', new_sort_order: 2 }, 404);
	});

	it('rejects new_parent_id that points at a document, not a folder', async () => {
		seedDocument('d1', null);
		seedDocument('d2', null);
		await expectRejection(
			{ node_id: 'd1', node_type: 'document', new_parent_id: 'd2', new_sort_order: 2 },
			400
		);
	});

	it('rejects new_parent_id that does not exist', async () => {
		seedDocument('d1', null);
		await expectRejection(
			{ node_id: 'd1', node_type: 'document', new_parent_id: 'bogus', new_sort_order: 2 },
			400
		);
	});

	it('rejects a cycle: A contains B, attempt to move A inside B', async () => {
		seedFolder('a', null);
		seedFolder('b', 'a'); // B nested inside A
		await expectRejection(
			{ node_id: 'a', node_type: 'folder', new_parent_id: 'b', new_sort_order: 1 },
			400
		);
	});

	it('rejects moving a folder into itself', async () => {
		seedFolder('a', null);
		await expectRejection(
			{ node_id: 'a', node_type: 'folder', new_parent_id: 'a', new_sort_order: 1 },
			400
		);
	});

	it('happy path: valid move updates parent_id and sort_order', async () => {
		seedFolder('a', null);
		seedFolder('b', null);
		seedDocument('d1', 'a');

		const res = await put({ node_id: 'd1', node_type: 'document', new_parent_id: 'b', new_sort_order: 5 });
		expect(res.status).toBe(200);

		const row = db.prepare('SELECT parent_id, sort_order FROM documents WHERE id = ?').get('d1') as any;
		expect(row.parent_id).toBe('b');
		expect(row.sort_order).toBe(5);
	});

	it('happy path: re-rooting to null parent (root level) is allowed', async () => {
		seedFolder('a', null);
		seedDocument('d1', 'a');

		const res = await put({ node_id: 'd1', node_type: 'document', new_parent_id: null, new_sort_order: 3 });
		expect(res.status).toBe(200);

		const row = db.prepare('SELECT parent_id FROM documents WHERE id = ?').get('d1') as any;
		expect(row.parent_id).toBeNull();
	});
});
