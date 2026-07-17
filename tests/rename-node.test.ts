import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb, seedNovelWithDocs } from './helpers.js';

/**
 * PATCH /api/novels/:id/tree/nodes/:nodeId — rename hardening.
 *
 * The rename branch previously trusted `body.title` as-is (no trim, no
 * empty/whitespace rejection) and updated blind — a nonexistent or
 * soft-deleted nodeId still returned `{ success: true }` because the
 * UPDATE just touched zero rows. This hardens both: title is trimmed and
 * rejected with 400 if empty/whitespace-only, and the target row must
 * exist (and not be trashed) or the request 404s — mirroring the DELETE
 * branch's own lookup above it in this file.
 *
 * Written red-green: these fail against the pre-hardening handler.
 */

let db: Database.Database;
let novelId: string;
let folderId: string;
let doc1Id: string;

function patch(nodeId: string, body: unknown) {
	return import('../src/routes/api/novels/[id]/tree/nodes/[nodeId]/+server.ts').then(({ PATCH }) =>
		PATCH({
			params: { id: novelId, nodeId },
			request: new Request('http://test/nodes/x', { method: 'PATCH', body: JSON.stringify(body) }),
			locals: { user: { id: 'u1', role: 'writer' }, db }
		} as any)
	);
}

beforeEach(() => {
	db = createTestDb();
	({ novelId, folderId, doc1Id } = seedNovelWithDocs(db));
});

describe('rename: happy path', () => {
	it('renames a document and syncs documents_fts.title', async () => {
		const res = await patch(doc1Id, { title: 'New Chapter Title', type: 'document' });
		expect(res.status).toBe(200);

		const doc = db.prepare('SELECT title FROM documents WHERE id = ?').get(doc1Id) as any;
		expect(doc.title).toBe('New Chapter Title');

		const fts = db.prepare('SELECT title FROM documents_fts WHERE doc_id = ?').get(doc1Id) as any;
		expect(fts.title).toBe('New Chapter Title');
	});

	it('renames a folder', async () => {
		const res = await patch(folderId, { title: 'New Folder Title', type: 'folder' });
		expect(res.status).toBe(200);

		const folder = db.prepare('SELECT title FROM folders WHERE id = ?').get(folderId) as any;
		expect(folder.title).toBe('New Folder Title');
	});

	it('trims surrounding whitespace from the title', async () => {
		await patch(doc1Id, { title: '  Trimmed Title  ', type: 'document' });

		const doc = db.prepare('SELECT title FROM documents WHERE id = ?').get(doc1Id) as any;
		expect(doc.title).toBe('Trimmed Title');
	});
});

describe('rename: empty/whitespace title rejected', () => {
	it('rejects a whitespace-only title with 400', async () => {
		await expect(patch(doc1Id, { title: '   ', type: 'document' })).rejects.toMatchObject({ status: 400 });

		// And must not have mutated the row.
		const doc = db.prepare('SELECT title FROM documents WHERE id = ?').get(doc1Id) as any;
		expect(doc.title).toBe('Chapter One');
	});

	it('rejects an empty-string title with 400', async () => {
		await expect(patch(doc1Id, { title: '', type: 'document' })).rejects.toMatchObject({ status: 400 });
	});
});

describe('rename: 404 on missing/deleted target', () => {
	it('404s when the document id does not exist', async () => {
		await expect(patch('nonexistent-doc', { title: 'New Title', type: 'document' }))
			.rejects.toMatchObject({ status: 404 });
	});

	it('404s when the document is soft-deleted (trashed)', async () => {
		const now = new Date().toISOString();
		db.prepare('UPDATE documents SET deleted_at = ? WHERE id = ?').run(now, doc1Id);

		await expect(patch(doc1Id, { title: 'New Title', type: 'document' }))
			.rejects.toMatchObject({ status: 404 });
	});

	it('404s when the folder id does not exist', async () => {
		await expect(patch('nonexistent-folder', { title: 'New Title', type: 'folder' }))
			.rejects.toMatchObject({ status: 404 });
	});

	it('404s when the folder is soft-deleted (trashed)', async () => {
		const now = new Date().toISOString();
		db.prepare('UPDATE folders SET deleted_at = ? WHERE id = ?').run(now, folderId);

		await expect(patch(folderId, { title: 'New Title', type: 'folder' }))
			.rejects.toMatchObject({ status: 404 });
	});
});
