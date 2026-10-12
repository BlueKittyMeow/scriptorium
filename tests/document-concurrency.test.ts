import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb, seedNovelWithDocs, seedUser } from './helpers.js';
vi.mock('$lib/server/files.js', () => ({
	readContentFile: vi.fn(), writeContentFile: vi.fn(), writeSnapshotFile: vi.fn(() => '/tmp/snapshot'),
	stripHtml: (s: string) => s.replace(/<[^>]*>/g, ''), countWords: () => 3
}));
import { readContentFile, writeContentFile } from '$lib/server/files.js';
import { GET, PUT } from '../src/routes/api/documents/[id]/+server.js';
let db: ReturnType<typeof createTestDb>, context: any;
beforeEach(() => {
	db = createTestDb(); const user = seedUser(db), { doc1Id } = seedNovelWithDocs(db);
	context = { params: { id: doc1Id }, locals: { db, user } }; vi.clearAllMocks();
	vi.mocked(readContentFile).mockReturnValue('<p>Original writing</p>');
});
afterEach(() => db.close());
const save = (body: unknown) => PUT({ ...context, request: new Request('http://test', { method: 'PUT', body: JSON.stringify(body) }) });
it('rejects a stale offline save before touching any content', async () => {
	const base = await (await GET(context)).json();
	vi.mocked(readContentFile).mockReturnValue('<p>Changed on another phone</p>');
	await expect(save({ content: '<p>Offline draft</p>', base_revision: base.content_revision })).rejects.toMatchObject({ status: 409 });
	expect(writeContentFile).not.toHaveBeenCalled();
});
it('accepts a matching base and returns the revision of the saved content', async () => {
	const base = await (await GET(context)).json();
	const result = await (await save({ content: '<p>My new draft</p>', base_revision: base.content_revision })).json();
	expect(result.content_revision).not.toBe(base.content_revision);
	expect(writeContentFile).toHaveBeenCalledWith('novel-1', 'doc-1', '<p>My new draft</p>');
});
it('recognizes an identical retry after a lost response without rewriting', async () => {
	const result = await save({ content: '<p>Original writing</p>', base_revision: 'old-revision' });
	expect(result.ok).toBe(true); expect(writeContentFile).not.toHaveBeenCalled();
});
it('keeps offline writing when server text is missing', async () => {
	vi.mocked(readContentFile).mockReturnValue(null);
	await expect(save({ content: 'local copy', base_revision: 'original' })).rejects.toMatchObject({ status: 503 });
	expect(writeContentFile).not.toHaveBeenCalled();
});
