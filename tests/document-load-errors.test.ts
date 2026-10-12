import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedNovelWithDocs, seedUser } from './helpers.js';
import type Database from 'better-sqlite3';

vi.mock('$lib/server/files.js', () => ({
	readContentFile: vi.fn(), writeContentFile: vi.fn(), writeSnapshotFile: vi.fn(),
	stripHtml: (html: string) => html.replace(/<[^>]+>/g, '').trim(), countWords: vi.fn()
}));
import { readContentFile } from '$lib/server/files.js';
import { GET } from '../src/routes/api/documents/[id]/+server.js';
let db: Database.Database;
beforeEach(() => { db = createTestDb(); });
afterEach(() => db.close());

describe('missing writing is not presented as an empty editable chapter', () => {
	it.each([null, '', '<p></p>'])('reports unavailable content %s when metadata records existing writing', async (content) => {
		const user = seedUser(db), { doc1Id } = seedNovelWithDocs(db);
		vi.mocked(readContentFile).mockReturnValue(content);
		await expect(GET({ params: { id: doc1Id }, locals: { db, user } } as any)).rejects.toMatchObject({
			status: 503, body: { code: 'CONTENT_UNAVAILABLE' }
		});
	});
	it('still permits a newly created empty chapter with no file yet', async () => {
		const user = seedUser(db), { doc1Id } = seedNovelWithDocs(db);
		db.prepare('UPDATE documents SET word_count = 0 WHERE id = ?').run(doc1Id);
		vi.mocked(readContentFile).mockReturnValue(null);
		const response = await GET({ params: { id: doc1Id }, locals: { db, user } } as any);
		expect((await response.json()).content).toBe('');
	});
	it('returns saved text without rewriting or normalizing it', async () => {
		const user = seedUser(db), { doc1Id } = seedNovelWithDocs(db);
		vi.mocked(readContentFile).mockReturnValue('<p>Keep <em>every</em> word.</p>');
		const response = await GET({ params: { id: doc1Id }, locals: { db, user } } as any);
		expect((await response.json()).content).toBe('<p>Keep <em>every</em> word.</p>');
	});
});
