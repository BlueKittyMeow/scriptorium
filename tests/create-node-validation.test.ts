import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb } from './helpers.js';

/**
 * P2-5: POST /api/novels/:id/tree/nodes must reject a bogus or trashed
 * parent_id (same "invisible node" failure class as P1-3) before creating
 * anything.
 *
 * Only folder-type payloads are exercised here (or payloads that are
 * expected to be rejected before reaching the insert) so the test never
 * touches the real filesystem — the document branch calls writeContentFile,
 * which resolves paths via the real (non-injectable) DATA_ROOT.
 */

let db: Database.Database;
const novelId = 'novel-1';
const now = new Date().toISOString();
const locals = () => ({ user: { id: 'u1', role: 'writer' }, db });

function post(body: unknown) {
	return import('../src/routes/api/novels/[id]/tree/nodes/+server.ts').then(({ POST }) =>
		POST({
			params: { id: novelId },
			request: new Request('http://test/nodes', { method: 'POST', body: JSON.stringify(body) }),
			locals: locals()
		} as any)
	);
}

beforeEach(() => {
	db = createTestDb();
	db.prepare('INSERT INTO novels (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
		.run(novelId, 'Test Novel', 'draft', now, now);
});

describe('create-node parent validation (P2-5)', () => {
	it('rejects a bogus parent_id with 400', async () => {
		await expect(post({ type: 'folder', title: 'New Folder', parent_id: 'nonexistent' }))
			.rejects.toMatchObject({ status: 400 });
	});

	it('rejects a trashed (soft-deleted) parent folder with 400', async () => {
		db.prepare(
			`INSERT INTO folders (id, novel_id, parent_id, title, folder_type, sort_order, created_at, updated_at, deleted_at)
			 VALUES (?, ?, NULL, ?, NULL, 1.0, ?, ?, ?)`
		).run('trashed-folder', novelId, 'Trashed', now, now, now);

		await expect(post({ type: 'folder', title: 'New Folder', parent_id: 'trashed-folder' }))
			.rejects.toMatchObject({ status: 400 });
	});

	it('rejects a parent_id that points at a document instead of a folder', async () => {
		db.prepare(
			`INSERT INTO documents (id, novel_id, parent_id, title, sort_order, created_at, updated_at)
			 VALUES (?, ?, NULL, ?, 1.0, ?, ?)`
		).run('doc-1', novelId, 'Some Doc', now, now);

		await expect(post({ type: 'folder', title: 'New Folder', parent_id: 'doc-1' }))
			.rejects.toMatchObject({ status: 400 });
	});

	it('allows creation with no parent_id (root level)', async () => {
		const res = await post({ type: 'folder', title: 'Root Folder' });
		expect(res.status).toBe(201);
	});

	it('allows creation under a valid, non-deleted parent folder', async () => {
		db.prepare(
			`INSERT INTO folders (id, novel_id, parent_id, title, folder_type, sort_order, created_at, updated_at)
			 VALUES (?, ?, NULL, ?, NULL, 1.0, ?, ?)`
		).run('good-folder', novelId, 'Good Folder', now, now);

		const res = await post({ type: 'folder', title: 'Child Folder', parent_id: 'good-folder' });
		expect(res.status).toBe(201);
	});
});
