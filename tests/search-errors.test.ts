import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedNovelWithDocs, seedUser } from './helpers.js';
import { GET } from '../src/routes/api/search/+server.js';
import type Database from 'better-sqlite3';
let db: Database.Database;
beforeEach(() => { db = createTestDb(); });
afterEach(() => db.close());

describe('search distinguishes no matches from a broken index', () => {
	it('returns an empty result only when the search actually ran', async () => {
		const user = seedUser(db); seedNovelWithDocs(db);
		const response = await GET({ locals: { db, user }, url: new URL('http://test/api/search?q=unmatchedword') } as any);
		expect(await response.json()).toEqual([]);
	});
	it('propagates storage/index failures to the safe server error handler', async () => {
		const user = seedUser(db); seedNovelWithDocs(db);
		db.exec('DROP TABLE documents_fts');
		await expect(GET({ locals: { db, user }, url: new URL('http://test/api/search?q=chapter') } as any)).rejects.toThrow();
	});
});
